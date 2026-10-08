import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { setETag } from '../lib/etag.js';
import { uuid, dateStr, timeStr, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/requests.service.js';
import { query } from '../lib/db.js';
import { rejectManagerSelfSubmission } from '../middleware/rejectManagerSelfSubmission.js';

export const requestsRouter = Router();
requestsRouter.use(requireAuth);

const requestBody = z
  .object({
    userId: uuid.optional(),
    siteId: uuid.nullish(),
    constraintTypeId: uuid,
    constraintDate: dateStr,
    startTime: timeStr.default('00:00'),
    endTime: timeStr.default('23:59'),
    note: z.string().trim().max(1000).nullish(),
  })
  .refine((v) => v.endTime !== v.startTime, {
    message: 'שעת הסיום זהה לשעת ההתחלה',
    path: ['endTime'],
  });

/** ההקשר לבדיקת ה-Scope: על מי הבקשה */
const targetScope = async (req) => {
  const id = req.params.id;
  if (!id) return { targetUserId: req.body?.userId ?? req.user.userId };
  const [row] = await query('select user_id, site_id from constraint_requests where id = $1', [id]);
  return { targetUserId: row?.user_id, siteId: row?.site_id };
};

requestsRouter.get(
  '/',
  requirePermission('requests', 'view'),
  validate({
    query: z.object({
      status: z.enum(['draft', 'submitted', 'approved', 'rejected', 'cancelled']).optional(),
      userId: uuid.optional(),
      siteId: uuid.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  async (req, res) => res.json({ requests: await svc.list(req.user, req.validQuery) }),
);

requestsRouter.get(
  '/:id',
  requirePermission('requests', 'view', targetScope),
  validate({ params: idParam }),
  async (req, res) => {
    const request = await svc.get(req.params.id);
    setETag(res, request);
    res.json({ request });
  },
);

/** §7: להציג לפני השליחה אם הבקשה תקינה, דורשת אישור או חסומה */
requestsRouter.post(
  '/preview',
  requirePermission('requests', 'create', (req) => ({
    targetUserId: req.body?.userId ?? req.user.userId,
  })),
  validate({ body: requestBody }),
  rejectManagerSelfSubmission,
  async (req, res) => res.json(await svc.preview(req.user, req.body)),
);

requestsRouter.post(
  '/',
  requirePermission('requests', 'create', (req) => ({
    targetUserId: req.body?.userId ?? req.user.userId,
  })),
  validate({ body: requestBody }),
  rejectManagerSelfSubmission,
  async (req, res) => {
    const request = await svc.create(req.user, req.body);
    setETag(res, request);
    res.status(201).json({ request });
  },
);

requestsRouter.post(
  '/:id/submit',
  requirePermission('requests', 'create', targetScope),
  validate({ params: idParam }),
  async (req, res) => {
    const result = await withIdempotency(req, 'requests.submit', async () => {
      const out = await svc.submit(req.user, req.params.id, { traceId: req.traceId });
      // 202 מסמן ללקוח שהבקשה נקלטה אך אינה בתוקף עד להחלטה (AC-10)
      return { status: out.status === 'approval_required' ? 202 : 200, body: out };
    });
    res.status(result.status).json(result.body);
  },
);

requestsRouter.post(
  '/:id/decision',
  requirePermission('requests', 'approve', targetScope),
  validate({
    params: idParam,
    body: z.object({
      decision: z.enum(['approve', 'reject']),
      comment: z.string().trim().max(1000).optional(),
    }),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'requests.decision', async () => ({
      status: 200,
      body: await svc.decide(req.user, req.params.id, { ...req.body, traceId: req.traceId }),
    }));
    res.status(result.status).json(result.body);
  },
);

requestsRouter.post(
  '/:id/cancel',
  requirePermission('requests', 'delete', targetScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.cancel(req.user, req.params.id)),
);

/** היסטוריית הבקשה מתוך יומן הביקורת */
requestsRouter.get(
  '/:id/history',
  requirePermission('requests', 'view', targetScope),
  validate({ params: idParam }),
  async (req, res) => {
    const entries = await query(
      `select a.occurred_at, a.action, a.reason, a.before_data, a.after_data,
              actor.full_name as actor_name
         from audit_log a
         left join profiles actor on actor.id = a.actor_user_id
        where a.entity_type = 'constraint_requests' and a.entity_id = $1
        order by a.occurred_at`,
      [req.params.id],
    );
    res.json({ entries });
  },
);
