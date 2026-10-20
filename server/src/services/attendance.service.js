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


/* ───────────────────────── דוחות נוכחות ───────────────────────── */

/** כמה דקות איחור / יציאה מוקדמת נחשבות "בזמן" */
const GRACE_MIN = 5;
const r2 = (n) => Math.round(n * 100) / 100;
const minutesBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

/** מי בטווח של הקורא: מנהל — כולם, מדריך — הוא והמשויכים אליו, מטמיע — עצמו */
function scopeIds(principal) {
  if (principal.baseRole === 'manager') return null;
  if (['implementer', 'lead'].includes(principal.baseRole)) return [principal.userId];
  return [principal.userId, ...(principal.scopes.assignedUserIds ?? [])];
}

/** האנשים בדוח: מי שמשובץ / מדווח נוכחות, בטווח של הקורא */
export async function peopleInScope(principal, { siteId, userId } = {}) {
  return query(
    `select p.id, p.full_name, p.base_role::text as base_role,
            (select string_agg(s.name, ', ') from site_assignments sa join sites s on s.id = sa.site_id
              where sa.user_id = p.id and sa.deleted_at is null and sa.span @> current_date) as sites
       from profiles p
      where p.deleted_at is null and p.status = 'active'
        and p.base_role in ('implementer', 'lead', 'mentor')
        and ($1::uuid[] is null or p.id = any($1::uuid[]))
        and ($2::uuid is null or exists (select 1 from site_assignments sa
              where sa.user_id = p.id and sa.site_id = $2 and sa.deleted_at is null))
        and ($3::uuid is null or p.id = $3)
      order by p.full_name`,
    [scopeIds(principal), siteId ?? null, userId ?? null],
  );
}

/**
 * לכל אדם ויום בטווח: מה תוכנן (משמרות שפורסמו ופעילויות), מתי הגיע ויצא,
 * וההתאמה ביניהם — איחור, יציאה מוקדמת, שעות מתוכננות מול בפועל.
 */
async function computeDays(userIds, from, to) {
  if (!userIds.length) return [];
  const [work, att, abs] = await Promise.all([
    query(
      `select ra.user_id, ra.assignment_date::text as date, ra.starts_at, ra.ends_at,
              coalesce(st.name, 'משמרת') || ' · ' || l.name as title
         from roster_assignments ra
         join roster_versions v on v.id = ra.version_id
         join locations l on l.id = ra.location_id
         left join shift_types st on st.id = ra.shift_type_id
        where ra.user_id = any($1::uuid[]) and ra.deleted_at is null
          and v.status = 'published' and v.deleted_at is null
          and ra.assignment_date between $2 and $3
       union all
       select ap.user_id, a.activity_date::text, a.starts_at, a.ends_at,
              coalesce(nullif(btrim(a.title), ''), at.name_he)
         from activities a
         join activity_participants ap on ap.activity_id = a.id
         join activity_types at on at.id = a.activity_type_id
        where ap.user_id = any($1::uuid[]) and a.deleted_at is null
          and a.status in ('scheduled', 'completed') and a.activity_date between $2 and $3
       order by 3`,
      [userIds, from, to],
    ),
    query(
      `select ar.id, ar.user_id, ar.work_date::text as date, ar.clock_in_at, ar.clock_out_at, ar.note, ar.source
         from attendance_records ar
        where ar.user_id = any($1::uuid[]) and ar.deleted_at is null and ar.work_date between $2 and $3
        order by ar.clock_in_at`,
      [userIds, from, to],
    ),
    query(
      `select cr.user_id, cr.constraint_date::text as date, ct.name_he as type_name
         from constraint_requests cr
         join constraint_types ct on ct.id = cr.constraint_type_id
        where cr.user_id = any($1::uuid[]) and cr.deleted_at is null and cr.status = 'approved'
          and cr.constraint_date between $2 and $3`,
      [userIds, from, to],
    ),
  ]);

  const key = (u, d) => `${u}|${d}`;
  const days = new Map();
  const at = (u, d) => {
    if (!days.has(key(u, d))) days.set(key(u, d), { user_id: u, date: d, planned: [], records: [], absences: [] });
    return days.get(key(u, d));
  };
  for (const w of work) at(w.user_id, w.date).planned.push(w);
  for (const a of att) at(a.user_id, a.date).records.push(a);
  for (const a of abs) at(a.user_id, a.date).absences.push(a.type_name);

  const now = today();
  return [...days.values()].map((d) => {
    const plannedStart = d.planned.length ? d.planned.reduce((m, p) => (p.starts_at < m ? p.starts_at : m), d.planned[0].starts_at) : null;
    const plannedEnd = d.planned.length ? d.planned.reduce((m, p) => (p.ends_at > m ? p.ends_at : m), d.planned[0].ends_at) : null;
    const plannedHours = d.planned.reduce((s, p) => s + (new Date(p.ends_at) - new Date(p.starts_at)) / 3_600_000, 0);
    const firstIn = d.records.length ? d.records[0].clock_in_at : null;
    const closed = d.records.filter((r) => r.clock_out_at);
    const lastOut = closed.length ? closed.reduce((m, r) => (r.clock_out_at > m ? r.clock_out_at : m), closed[0].clock_out_at) : null;
    const actualHours = closed.reduce((s, r) => s + (new Date(r.clock_out_at) - new Date(r.clock_in_at)) / 3_600_000, 0);
    const lateMin = plannedStart && firstIn ? minutesBetween(plannedStart, firstIn) : null;
    const earlyMin = plannedEnd && lastOut ? minutesBetween(lastOut, plannedEnd) : null;

    let status;
    if (d.absences.length && !d.records.length) status = 'absence';
    else if (d.planned.length && !d.records.length) status = d.date < now ? 'missing' : 'upcoming';
    else if (!d.planned.length) status = 'unplanned';
    else if (d.records.some((r) => !r.clock_out_at)) status = lateMin > GRACE_MIN ? 'late' : 'open';
    else if (lateMin > GRACE_MIN) status = 'late';
    else if (earlyMin > GRACE_MIN) status = 'early';
    else status = 'ok';

    return {
      user_id: d.user_id, date: d.date, status,
      planned: d.planned.map((p) => ({ title: p.title, starts_at: p.starts_at, ends_at: p.ends_at })),
      records: d.records,
      absences: d.absences,
      planned_start: plannedStart, planned_end: plannedEnd,
      first_in: firstIn, last_out: lastOut,
      late_min: lateMin, early_min: earlyMin,
      planned_hours: r2(plannedHours), actual_hours: r2(actualHours),
      diff_hours: r2(actualHours - plannedHours),
    };
  }).sort((a, b) => a.date.localeCompare(b.date));
}

const totalsOf = (rows) => ({
  planned_hours: r2(rows.reduce((s, r) => s + r.planned_hours, 0)),
  actual_hours: r2(rows.reduce((s, r) => s + r.actual_hours, 0)),
  diff_hours: r2(rows.reduce((s, r) => s + r.diff_hours, 0)),
  work_days: rows.filter((r) => r.records.length).length,
  planned_days: rows.filter((r) => r.planned.length).length,
  late_days: rows.filter((r) => r.status === 'late').length,
  missing_days: rows.filter((r) => r.status === 'missing').length,
  absence_days: rows.filter((r) => r.status === 'absence').length,
});

/** דוח יומי: כל האנשים בטווח, ליום אחד */
export async function daily(principal, { date, siteId }) {
  const people = await peopleInScope(principal, { siteId });
  const rows = await computeDays(people.map((p) => p.id), date, date);
  const byUser = new Map(rows.map((r) => [r.user_id, r]));
  return {
    date,
    rows: people
      .map((p) => ({ ...p, ...(byUser.get(p.id) ?? { status: 'none', planned: [], records: [], absences: [], planned_hours: 0, actual_hours: 0, diff_hours: 0 }), user_id: p.id }))
      // מי שלא תוכנן לו כלום ולא הגיע — לא מעניין בדוח היומי
      .filter((r) => r.status !== 'none'),
  };
}

/** דוח חודשי לאדם אחד: פירוט יומי וסיכום השעות */
export async function monthly(principal, { userId, from, to }) {
  const [person] = await peopleInScope(principal, { userId });
  if (!person) throw new AppError('E_NOT_FOUND', 'האדם לא נמצא או שאינו באחריותך');
  const rows = await computeDays([userId], from, to);
  return { person, from, to, rows, totals: totalsOf(rows) };
}

/** סיכום חודשי לכל האנשים בטווח — שורה לאדם */
export async function summary(principal, { from, to, siteId }) {
  const people = await peopleInScope(principal, { siteId });
  const rows = await computeDays(people.map((p) => p.id), from, to);
  return {
    from, to,
    people: people
      .map((p) => ({ ...p, ...totalsOf(rows.filter((r) => r.user_id === p.id)) }))
      .filter((p) => p.planned_days || p.work_days),
  };
}
