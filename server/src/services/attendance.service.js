import { query, withTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { today, zonedLocalToUtc } from '../lib/time.js';

/**
 * נוכחות: כניסה ויציאה בלחיצה.
 *
 * הרשומה משויכת לשיבוץ של אותו יום מהסידור שפורסם (הקרוב ביותר לשעת הכניסה),
 * כך שדוח השעות יכול להציג מתוכנן מול בפועל. אין שיבוץ — הרשומה נשמרת בלעדיו.
 * רשומה פתוחה אחת לכל אדם נאכפת במסד (attendance_one_open_idx).
 */

const SELECT = `
  select ar.id, ar.user_id, ar.site_id, ar.work_date, ar.clock_in_at, ar.clock_out_at,
         ar.roster_assignment_id, ar.note, ar.source, ar.row_version,
         round((extract(epoch from (coalesce(ar.clock_out_at, now()) - ar.clock_in_at)) / 3600.0)::numeric, 2) as hours,
         s.name as site_name,
         ra.starts_at as planned_start, ra.ends_at as planned_end
    from attendance_records ar
    left join sites s on s.id = ar.site_id
    left join roster_assignments ra on ra.id = ar.roster_assignment_id
   where ar.deleted_at is null`;

/** השיבוצים של היום (מסידור שפורסם) והפעילויות של היום */
async function plannedToday(run, userId, date) {
  return run(
    `select 'shift' as kind, ra.id, ra.site_id, ra.starts_at, ra.ends_at,
            coalesce(st.name, 'משמרת') as title, l.name as location_name
       from roster_assignments ra
       join roster_versions v on v.id = ra.version_id
       join locations l on l.id = ra.location_id
       left join shift_types st on st.id = ra.shift_type_id
      where ra.user_id = $1 and ra.assignment_date = $2 and ra.deleted_at is null
        and v.status = 'published' and v.deleted_at is null
     union all
     select 'activity', a.id, a.site_id, a.starts_at, a.ends_at,
            coalesce(nullif(btrim(a.title), ''), at.name_he), l.name
       from activities a
       join activity_participants ap on ap.activity_id = a.id and ap.user_id = $1
       join activity_types at on at.id = a.activity_type_id
       left join locations l on l.id = a.location_id
      where a.activity_date = $2 and a.deleted_at is null and a.status in ('scheduled', 'completed')
     order by 4`,
    [userId, date],
  );
}

export async function myToday(principal) {
  const date = today();
  const [planned, open, records] = await Promise.all([
    plannedToday(query, principal.userId, date),
    query(`${SELECT} and ar.user_id = $1 and ar.clock_out_at is null`, [principal.userId]),
    query(`${SELECT} and ar.user_id = $1 and ar.work_date = $2 order by ar.clock_in_at`, [principal.userId, date]),
  ]);
  return { date, planned, open: open[0] ?? null, records };
}

export async function clockIn(actor, { note } = {}) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [open] = await tx.query(
      'select id from attendance_records where user_id = $1 and clock_out_at is null and deleted_at is null',
      [actor.userId],
    );
    if (open) throw new AppError('E_STATE', 'כבר רשומה כניסה פתוחה — יש לסמן יציאה קודם');

    const date = today();
    const planned = await plannedToday(tx.query, actor.userId, date);
    const now = Date.now();
    // השיבוץ הקרוב ביותר לרגע הכניסה
    const shift = planned
      .filter((p) => p.kind === 'shift')
      .sort((a, b) => Math.abs(new Date(a.starts_at) - now) - Math.abs(new Date(b.starts_at) - now))[0];

    let siteId = shift?.site_id ?? planned[0]?.site_id ?? null;
    if (!siteId) {
      const sites = await tx.query(
        `select site_id from site_assignments
          where user_id = $1 and deleted_at is null and span @> current_date`,
        [actor.userId],
      );
      if (sites.length === 1) siteId = sites[0].site_id;
    }

    const [row] = await tx.query(
      `insert into attendance_records (user_id, site_id, work_date, clock_in_at, roster_assignment_id, note, source)
       values ($1, $2, $3, now(), $4, $5, 'self') returning id`,
      [actor.userId, siteId, date, shift?.id ?? null, note ?? null],
    );
    const [out] = await tx.query(`${SELECT} and ar.id = $1`, [row.id]);
    return out;
  });
}

export async function clockOut(actor, { note } = {}) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [open] = await tx.query(
      `select id from attendance_records
        where user_id = $1 and clock_out_at is null and deleted_at is null for update`,
      [actor.userId],
    );
    if (!open) throw new AppError('E_STATE', 'אין כניסה פתוחה — יש לסמן כניסה קודם');
    await tx.query(
      `update attendance_records
          set clock_out_at = greatest(now(), clock_in_at + interval '1 minute'),
              note = coalesce($2, note)
        where id = $1`,
      [open.id, note ?? null],
    );
    const [out] = await tx.query(`${SELECT} and ar.id = $1`, [open.id]);
    return out;
  });
}

export async function list({ userId, from, to }) {
  return query(
    `${SELECT} and ar.user_id = $1 and ar.work_date between $2 and $3 order by ar.clock_in_at`,
    [userId, from, to],
  );
}

/** 'YYYY-MM-DDTHH:MM' בשעון ישראל → רגע מוחלט */
const localToInstant = (v) => (v ? zonedLocalToUtc(v.slice(0, 10), v.slice(11, 16)) : null);

/** הוספה או תיקון ידני ע״י מנהל או מדריך */
export async function upsertByManager(actor, { id, userId, clockIn, clockOut, note }) {
  const inAt = localToInstant(clockIn);
  const outAt = localToInstant(clockOut);
  if (outAt && inAt && outAt <= inAt) throw new AppError('E_VALIDATION', 'שעת היציאה חייבת להיות אחרי שעת הכניסה');

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let recordId = id;
    if (id) {
      const [row] = await tx.query(
        `update attendance_records
            set clock_in_at = $2, clock_out_at = $3, note = $4, source = 'manager',
                work_date = $5
          where id = $1 and deleted_at is null returning id`,
        [id, inAt, outAt, note ?? null, clockIn.slice(0, 10)],
      );
      if (!row) throw new AppError('E_NOT_FOUND', 'רשומת הנוכחות לא נמצאה');
    } else {
      const [row] = await tx.query(
        `insert into attendance_records (user_id, site_id, work_date, clock_in_at, clock_out_at, note, source)
         values ($1,
                 (select site_id from site_assignments where user_id = $1 and deleted_at is null
                   and span @> $2::date limit 1),
                 $2, $3, $4, $5, 'manager')
         returning id`,
        [userId, clockIn.slice(0, 10), inAt, outAt, note ?? null],
      );
      recordId = row.id;
    }
    const [out] = await tx.query(`${SELECT} and ar.id = $1`, [recordId]);
    return out;
  });
}

export async function remove(actor, id) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await tx.query(
      'update attendance_records set deleted_at = now(), deleted_by = $2 where id = $1',
      [id, actor.userId],
    );
    return { id };
  });
}

