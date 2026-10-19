import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';
import { query } from '../lib/db.js';
import { uuid, dateStr } from '../schemas/common.schema.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

const range = z.object({
  from: dateStr,
  to: dateStr,
  siteId: uuid.optional(),
  domainId: uuid.optional(),
});

/** שעות לפי מטמיע: משמרות שפורסמו + פעילויות */
async function workload({ from, to, siteId, domainId }) {
  return query(
    `
    with people as (
      select distinct p.id, p.full_name
        from profiles p
        join site_assignments sa on sa.user_id = p.id
             and sa.deleted_at is null and sa.span @> current_date
       where p.deleted_at is null and p.base_role in ('implementer','lead')
         and ($3::uuid is null or sa.site_id = $3)
         and ($4::uuid is null or exists (select 1 from user_domains ud
                                           where ud.user_id = p.id and ud.domain_id = $4
                                             and ud.deleted_at is null))
    ),
    shifts as (
      select ra.user_id,
             sum(extract(epoch from (ra.ends_at - ra.starts_at)) / 3600.0) as hours
        from roster_assignments ra
        join roster_versions v on v.id = ra.version_id
       where v.status = 'published' and v.deleted_at is null and ra.deleted_at is null
         and ra.assignment_date between $1 and $2
         and ($3::uuid is null or ra.site_id = $3)
       group by ra.user_id
    ),
    acts as (
      select ap.user_id,
             sum(extract(epoch from (a.ends_at - a.starts_at)) / 3600.0) as hours
        from activity_participants ap
        join activities a on a.id = ap.activity_id
       where a.deleted_at is null and a.status in ('scheduled','completed')
         and a.activity_date between $1 and $2
         and ($3::uuid is null or a.site_id = $3)
       group by ap.user_id
    )
    select people.id as user_id, people.full_name,
           round(coalesce(shifts.hours, 0)::numeric, 1) as shift_hours,
           round(coalesce(acts.hours, 0)::numeric, 1) as activity_hours,
           round((coalesce(shifts.hours, 0) + coalesce(acts.hours, 0))::numeric, 1) as total_hours
      from people
      left join shifts on shifts.user_id = people.id
      left join acts on acts.user_id = people.id
     order by total_hours desc, people.full_name
    `,
    [from, to, siteId ?? null, domainId ?? null],
  );
}

reportsRouter.get(
  '/workload',
  requirePermission('reports', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: range }),
  async (req, res) => res.json({ rows: await workload(req.validQuery) }),
);

/** כיסוי משמרות: תקן מול בפועל, לכל יום, מיקום ומשמרת */
reportsRouter.get(
  '/coverage',
  requirePermission('reports', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: range.extend({ siteId: uuid }) }),
  async (req, res) => {
    const { from, to, siteId } = req.validQuery;
    const rows = await query(
      `
      with days as (select generate_series($2::date, $3::date, '1 day')::date as d)
      select days.d as date, l.id as location_id, l.name as location_name,
             st.id as shift_type_id, st.name as shift_name,
             st.required_staff,
             count(ra.id)::int as assigned,
             greatest(st.required_staff - count(ra.id), 0)::int as gap
        from days
        join shift_types st on st.site_id = $1 and st.deleted_at is null and st.is_active
        join locations l on l.id = st.location_id and l.deleted_at is null and l.is_active
        left join roster_assignments ra
               on ra.assignment_date = days.d and ra.shift_type_id = st.id
              and ra.deleted_at is null
              and ra.version_id in (select id from roster_versions
                                     where site_id = $1 and status = 'published' and deleted_at is null)
       group by days.d, l.id, l.name, st.id, st.name, st.required_staff,
                st.display_order, st.start_time
       order by days.d, l.name, st.display_order, st.start_time
      `,
      [siteId, from, to],
    );
    res.json({ rows });
  },
);

/** סטטוס הכשרה של הצוות */
reportsRouter.get(
  '/training',
  requirePermission('reports', 'view'),
  validate({ query: z.object({ siteId: uuid.optional(), domainId: uuid.optional() }) }),
  async (req, res) => {
    const { siteId, domainId } = req.validQuery;
    const rows = await query(
      `select p.id as user_id, p.full_name,
              ts.name_he as training_status,
              count(uti.id)::int as total_items,
              count(uti.completed_on)::int as completed_items,
              -- ממוצע ההתקדמות המאושרת של השלבים (גאנט ההכשרה)
              coalesce(round(avg(uti.progress_pct)), 0)::int as percent
         from profiles p
         left join training_statuses ts on ts.id = p.training_status_id
         left join user_training_items uti on uti.user_id = p.id and uti.deleted_at is null
        where p.deleted_at is null and p.base_role in ('implementer','lead')
          and ($1::uuid is null or exists (select 1 from site_assignments sa
                                            where sa.user_id = p.id and sa.site_id = $1
                                              and sa.deleted_at is null and sa.span @> current_date))
          and ($2::uuid is null or exists (select 1 from user_domains ud
                                            where ud.user_id = p.id and ud.domain_id = $2
                                              and ud.deleted_at is null))
        group by p.id, p.full_name, ts.name_he
        order by percent, p.full_name`,
      [siteId ?? null, domainId ?? null],
    );
    res.json({ rows });
  },
);

/* ───────────────────────── דוח מטמיע ───────────────────────── */

const personQuery = z.object({ userId: uuid, from: dateStr, to: dateStr })
  .refine((v) => v.to >= v.from, { message: 'טווח תאריכים לא תקין', path: ['to'] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 400,
    { message: 'אפשר להציג עד שנה', path: ['to'] });

const sunday = (iso) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return d.toISOString().slice(0, 10);
};
const r1 = (n) => Math.round(n * 10) / 10;

/**
 * כל מה שעבר על מטמיע בטווח: משמרות שפורסמו, פעילויות, נוכחות בפועל וחופשים /
 * אילוצים שאושרו — ומסוכם לפי שבוע ולפי חודש.
 */
export async function personReport({ userId, from, to }) {
  const [[person], work, attendance, absences] = await Promise.all([
    query(
      `select p.id, p.full_name, p.base_role::text as base_role,
              (select string_agg(s.name, ', ') from site_assignments sa join sites s on s.id = sa.site_id
                where sa.user_id = p.id and sa.deleted_at is null and sa.span @> current_date) as sites,
              (select string_agg(d.name, ', ') from user_domains ud join domains d on d.id = ud.domain_id
                where ud.user_id = p.id and ud.deleted_at is null) as domains,
              (select mp.full_name from mentor_assignments ma join profiles mp on mp.id = ma.mentor_user_id
                where ma.implementer_user_id = p.id and ma.is_primary and ma.deleted_at is null
                  and ma.span @> current_date limit 1) as mentor_name
         from profiles p where p.id = $1`,
      [userId],
    ),
    query(
      `select 'shift' as kind, ra.assignment_date::text as date, ra.starts_at, ra.ends_at,
              coalesce(st.name, 'משמרת') as title, l.name as location_name, s.name as site_name,
              round((extract(epoch from (ra.ends_at - ra.starts_at)) / 3600.0)::numeric, 2) as hours
         from roster_assignments ra
         join roster_versions v on v.id = ra.version_id
         join sites s on s.id = ra.site_id
         join locations l on l.id = ra.location_id
         left join shift_types st on st.id = ra.shift_type_id
        where ra.user_id = $1 and ra.deleted_at is null and v.status = 'published' and v.deleted_at is null
          and ra.assignment_date between $2 and $3
       union all
       select 'activity', a.activity_date::text, a.starts_at, a.ends_at,
              coalesce(nullif(btrim(a.title), ''), at.name_he), l.name, s.name,
              round((extract(epoch from (a.ends_at - a.starts_at)) / 3600.0)::numeric, 2)
         from activities a
         join activity_participants ap on ap.activity_id = a.id and ap.user_id = $1
         join activity_types at on at.id = a.activity_type_id
         join sites s on s.id = a.site_id
         left join locations l on l.id = a.location_id
        where a.deleted_at is null and a.status in ('scheduled', 'completed')
          and a.activity_date between $2 and $3
       order by 3`,
      [userId, from, to],
    ),
    query(
      `select ar.id, ar.work_date::text as date, ar.clock_in_at, ar.clock_out_at, ar.note, ar.source,
              round((extract(epoch from (ar.clock_out_at - ar.clock_in_at)) / 3600.0)::numeric, 2) as hours
         from attendance_records ar
        where ar.user_id = $1 and ar.deleted_at is null and ar.work_date between $2 and $3
        order by ar.clock_in_at`,
      [userId, from, to],
    ),
    query(
      `select cr.id, cr.constraint_date::text as date, cr.start_time, cr.end_time,
              ct.name_he as type_name, ct.code as type_code,
              (cr.start_time = '00:00' and cr.end_time >= '23:59') as full_day
         from constraint_requests cr
         join constraint_types ct on ct.id = cr.constraint_type_id
        where cr.user_id = $1 and cr.deleted_at is null and cr.status = 'approved'
          and cr.constraint_date between $2 and $3
        order by cr.constraint_date`,
      [userId, from, to],
    ),
  ]);

  const bucket = () => ({
    shifts: 0, shift_hours: 0, activity_hours: 0, planned_hours: 0,
    actual_hours: 0, work_days: 0, absence_days: 0, absences: {},
  });
  const weeks = new Map();
  const months = new Map();
  const add = (date, fn) => {
    for (const [map, key] of [[weeks, sunday(date)], [months, date.slice(0, 7)]]) {
      if (!map.has(key)) map.set(key, bucket());
      fn(map.get(key));
    }
  };

  for (const w of work) {
    add(w.date, (b) => {
      if (w.kind === 'shift') { b.shifts += 1; b.shift_hours += w.hours; } else b.activity_hours += w.hours;
      b.planned_hours += w.hours;
    });
  }
  for (const a of attendance) add(a.date, (b) => { b.actual_hours += a.hours ?? 0; });
  const workDays = new Set([...work.map((w) => w.date), ...attendance.map((a) => a.date)]);
  for (const d of workDays) add(d, (b) => { b.work_days += 1; });
  for (const c of absences) {
    add(c.date, (b) => {
      if (c.full_day) b.absence_days += 1;
      b.absences[c.type_name] = (b.absences[c.type_name] ?? 0) + 1;
    });
  }

  const flatten = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, b]) => ({
    key, ...b,
    shift_hours: r1(b.shift_hours), activity_hours: r1(b.activity_hours),
    planned_hours: r1(b.planned_hours), actual_hours: r1(b.actual_hours),
  }));
  const weekRows = flatten(weeks);
  const totals = weekRows.reduce((t, w) => ({
    shifts: t.shifts + w.shifts,
    planned_hours: r1(t.planned_hours + w.planned_hours),
    actual_hours: r1(t.actual_hours + w.actual_hours),
    work_days: t.work_days + w.work_days,
    absence_days: t.absence_days + w.absence_days,
  }), { shifts: 0, planned_hours: 0, actual_hours: 0, work_days: 0, absence_days: 0 });

  return { person, from, to, work, attendance, absences, weeks: weekRows, months: flatten(months), totals };
}

reportsRouter.get(
  '/person',
  requirePermission('roster', 'view', (req) => ({ targetUserId: req.query.userId })),
  validate({ query: personQuery }),
  async (req, res) => res.json(await personReport(req.validQuery)),
);

const fmtHm = (iso) => (iso
  ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  : '');

reportsRouter.get(
  '/person/export.csv',
  requirePermission('roster', 'view', (req) => ({ targetUserId: req.query.userId })),
  validate({ query: personQuery }),
  async (req, res) => {
    const report = await personReport(req.validQuery);
    const days = new Set([
      ...report.work.map((w) => w.date), ...report.attendance.map((a) => a.date), ...report.absences.map((a) => a.date),
    ]);
    const rows = [...days].sort().map((d) => {
      const work = report.work.filter((w) => w.date === d);
      const att = report.attendance.filter((a) => a.date === d);
      const abs = report.absences.filter((a) => a.date === d);
      return {
        תאריך: d,
        'מתוכנן': work.map((w) => `${fmtHm(w.starts_at)}–${fmtHm(w.ends_at)} ${w.title}${w.location_name ? ` · ${w.location_name}` : ''}`).join(' | '),
        'שעות מתוכננות': r1(work.reduce((s, w) => s + w.hours, 0)),
        'נוכחות': att.map((a) => `${fmtHm(a.clock_in_at)}–${fmtHm(a.clock_out_at)}`).join(' | '),
        'שעות בפועל': r1(att.reduce((s, a) => s + (a.hours ?? 0), 0)),
        'חופש / אילוץ': abs.map((a) => a.type_name).join(', '),
      };
    });
    await recordExport(req, { entityType: 'reports.person', filters: req.validQuery, rowCount: rows.length });
    sendCsv(res, `דוח-${report.person?.full_name ?? 'מטמיע'}-${req.validQuery.from}.csv`, rows);
  },
);

/** סטטוס בקשות וחריגות */
reportsRouter.get(
  '/requests',
  requirePermission('reports', 'view'),
  validate({ query: range }),
  async (req, res) => {
    const { from, to, siteId } = req.validQuery;
    const [requests, exceptions] = await Promise.all([
      query(
        `select ct.name_he as type_name, cr.status::text as status, count(*)::int as count
           from constraint_requests cr
           join constraint_types ct on ct.id = cr.constraint_type_id
          where cr.deleted_at is null and cr.constraint_date between $1 and $2
            and ($3::uuid is null or cr.site_id = $3)
          group by ct.name_he, cr.status order by ct.name_he`,
        [from, to, siteId ?? null],
      ),
      query(
        `select e.status::text as status, count(*)::int as count,
                round(avg(extract(epoch from (e.decided_at - e.created_at)) / 3600.0)::numeric, 1)
                  as avg_hours_to_decision
           from exception_requests e
          where e.deleted_at is null and e.created_at::date between $1 and $2
            and ($3::uuid is null or e.site_id = $3)
          group by e.status`,
        [from, to, siteId ?? null],
      ),
    ]);
    res.json({ requests, exceptions });
  },
);

reportsRouter.get(
  '/workload/export.csv',
  requirePermission('reports', 'export', (req) => ({ siteId: req.query.siteId })),
  validate({ query: range }),
  async (req, res) => {
    const rows = (await workload(req.validQuery)).map((r) => ({
      שם: r.full_name,
      'שעות משמרות': r.shift_hours,
      'שעות פעילויות': r.activity_hours,
      'סה״כ שעות': r.total_hours,
    }));
    await recordExport(req, { entityType: 'reports.workload', filters: req.validQuery, rowCount: rows.length });
    sendCsv(res, `דוח-שעות-${req.validQuery.from}.csv`, rows);
  },
);
