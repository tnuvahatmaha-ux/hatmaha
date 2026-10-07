import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';
import { query } from '../lib/db.js';
import { uuid, dateStr } from '../schemas/common.schema.js';

export const auditRouter = Router();
auditRouter.use(requireAuth);

const filters = z.object({
  entityType: z.string().max(64).optional(),
  entityId: uuid.optional(),
  actorId: uuid.optional(),
  action: z.string().max(40).optional(),
  from: dateStr.optional(),
  to: dateStr.optional(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

const SQL = `
  select a.id, a.occurred_at, a.entity_type, a.entity_id, a.action,
         a.before_data, a.after_data, a.reason, a.trace_id,
         a.actor_role::text as actor_role, actor.full_name as actor_name
    from audit_log a
    left join profiles actor on actor.id = a.actor_user_id
   where ($1::text is null or a.entity_type = $1)
     and ($2::uuid is null or a.entity_id = $2)
     and ($3::uuid is null or a.actor_user_id = $3)
     and ($4::text is null or a.action = $4)
     and ($5::date is null or a.occurred_at >= $5::date)
     and ($6::date is null or a.occurred_at < $6::date + 1)
     and ($7::text is null or a.entity_type ilike '%' || $7 || '%'
                           or a.action ilike '%' || $7 || '%'
                           or actor.full_name ilike '%' || $7 || '%'
                           or a.reason ilike '%' || $7 || '%')
   order by a.occurred_at desc
   limit $8`;

const params = (f) => [
  f.entityType ?? null, f.entityId ?? null, f.actorId ?? null, f.action ?? null,
  f.from ?? null, f.to ?? null, f.q ?? null, f.limit,
];

auditRouter.get(
  '/',
  requirePermission('audit', 'view'),
  validate({ query: filters }),
  async (req, res) => {
    const [entries, entityTypes] = await Promise.all([
      query(SQL, params(req.validQuery)),
      query('select distinct entity_type from audit_log order by entity_type'),
    ]);
    res.json({ entries, entityTypes: entityTypes.map((e) => e.entity_type) });
  },
);

auditRouter.get(
  '/export.csv',
  requirePermission('audit', 'export'),
  validate({ query: filters }),
  async (req, res) => {
    const rows = (await query(SQL, params(req.validQuery))).map((e) => ({
      מועד: new Date(e.occurred_at).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' }),
      מבצע: e.actor_name ?? 'מערכת',
      תפקיד: e.actor_role ?? '',
      ישות: e.entity_type,
      מזהה: e.entity_id ?? '',
      פעולה: e.action,
      נימוק: e.reason ?? '',
      לפני: JSON.stringify(e.before_data ?? ''),
      אחרי: JSON.stringify(e.after_data ?? ''),
      'מזהה מעקב': e.trace_id ?? '',
    }));
    await recordExport(req, { entityType: 'audit_log', filters: req.validQuery, rowCount: rows.length });
    sendCsv(res, 'יומן-ביקורת.csv', rows);
  },
);
