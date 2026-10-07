import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission, requireManager } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import * as svc from '../services/permissions.service.js';
import { grantBody, previewBody, revokeBody, uuid } from '../schemas/permissions.schema.js';
import { query } from '../lib/db.js';

export const permissionsRouter = Router();

// §3.1: "רק מנהל הטמעה רשאי לנהל הרשאות" — נאכף פעמיים, בתפקיד ובהרשאה
permissionsRouter.use(requireAuth, requireManager);

permissionsRouter.get(
  '/catalog',
  requirePermission('permissions', 'view'),
  async (_req, res) => res.json({ resources: await svc.catalog() }),
);

permissionsRouter.get(
  '/roles/:role',
  requirePermission('permissions', 'view'),
  validate({ params: z.object({ role: z.enum(['manager', 'mentor', 'lead', 'implementer']) }) }),
  async (req, res) => res.json({ role: req.params.role, permissions: await svc.roleDefaults(req.params.role) }),
);

permissionsRouter.get(
  '/grants',
  requirePermission('permissions', 'view'),
  validate({ query: z.object({ userId: uuid }) }),
  async (req, res) => res.json({ grants: await svc.grantsForUser(req.validQuery.userId) }),
);

/** תצוגה מקדימה — קריאה בלבד, שום דבר אינו נשמר (§3.2) */
permissionsRouter.post(
  '/preview',
  requirePermission('permissions', 'view'),
  validate({ body: previewBody }),
  async (req, res) => res.json(await svc.preview(req.body.userId, req.body.draftGrants)),
);

permissionsRouter.post(
  '/grants',
  requirePermission('permissions', 'manage'),
  validate({ body: grantBody }),
  async (req, res) => {
    const result = await withIdempotency(req, 'permissions.grant', async () => {
      const { grant, created } = await svc.grant(req.user, { ...req.body, traceId: req.traceId });
      return { status: created ? 201 : 200, body: { grant, created } };
    });
    res.status(result.status).json(result.body);
  },
);

permissionsRouter.delete(
  '/grants/:id',
  requirePermission('permissions', 'manage'),
  validate({ params: z.object({ id: uuid }), body: revokeBody }),
  async (req, res) => {
    const { grant, alreadyRevoked } = await svc.revoke(req.user, req.params.id, req.body?.reason);
    res.json({ grant, alreadyRevoked });
  },
);

permissionsRouter.get(
  '/effective/:userId',
  requirePermission('permissions', 'view'),
  validate({ params: z.object({ userId: uuid }) }),
  async (req, res) => res.json(await svc.effectiveFor(req.params.userId)),
);

/** פעולות על הרשאות ביומן הביקורת — מי שינה למי מה, ומתי */
permissionsRouter.get(
  '/audit',
  requirePermission('audit', 'view'),
  validate({
    query: z.object({
      userId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  async (req, res) => {
    const { userId, limit } = req.validQuery;
    const rows = await query(
      `select a.id, a.occurred_at, a.action, a.before_data, a.after_data, a.reason,
              actor.full_name as actor_name
         from audit_log a
         left join profiles actor on actor.id = a.actor_user_id
        where a.entity_type in ('permission_grants', 'role_permissions')
          and ($1::uuid is null or (a.after_data ->> 'user_id')::uuid = $1
                                or (a.before_data ->> 'user_id')::uuid = $1)
        order by a.occurred_at desc
        limit $2`,
      [userId ?? null, limit],
    );
    res.json({ entries: rows });
  },
);
