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

/** כיסוי משמרות: תקן מול בפועל, לכל יום ומשמרת */
reportsRouter.get(
  '/coverage',
  requirePermission('reports', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: range.extend({ siteId: uuid }) }),
  async (req, res) => {
    const { from, to, siteId } = req.validQuery;
    const rows = await query(
      `
      with days as (select generate_series($2::date, $3::date, '1 day')::date as d)
      select days.d as date, st.id as shift_type_id, st.name as shift_name,
             st.required_staff,
             count(ra.id)::int as assigned,
             greatest(st.required_staff - count(ra.id), 0)::int as gap
        from days
        join site_shift_types st on st.site_id = $1 and st.deleted_at is null and st.is_active
        left join roster_assignments ra
               on ra.assignment_date = days.d and ra.shift_type_id = st.id
              and ra.deleted_at is null
              and ra.version_id in (select id from roster_versions
                                     where site_id = $1 and status = 'published' and deleted_at is null)
       group by days.d, st.id, st.name, st.required_staff, st.display_order
       order by days.d, st.display_order
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
              case when count(uti.id) = 0 then 0
                   else round(100.0 * count(uti.completed_on) / count(uti.id))
              end as percent
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
