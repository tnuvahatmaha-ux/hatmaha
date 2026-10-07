import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { setETag } from '../lib/etag.js';
import { uuid, dateStr, name, optionalText, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/users.service.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

const userScope = (req) => ({ targetUserId: req.params.id ?? req.params.userId });

usersRouter.get(
  '/',
  requirePermission('users', 'view'),
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      role: z.enum(['manager', 'mentor', 'lead', 'implementer']).optional(),
      status: z.enum(['invited', 'active', 'suspended', 'archived']).optional(),
      siteId: uuid.optional(),
      domainId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  }),
  async (req, res) => res.json({ users: await svc.list(req.user, req.validQuery) }),
);

usersRouter.get(
  '/:id',
  requirePermission('users', 'view', userScope),
  validate({ params: idParam }),
  async (req, res) => {
    const user = await svc.get(req.params.id);
    setETag(res, user);
    res.json({ user });
  },
);

usersRouter.patch(
  '/:id',
  requirePermission('users', 'edit', userScope),
  validate({
    params: idParam,
    body: z.object({
      fullName: name.optional(),
      phone: z.string().trim().max(40).nullish(),
      bio: optionalText,
      notes: optionalText,
      intakeDate: dateStr.nullish(),
      baseRole: z.enum(['manager', 'mentor', 'lead', 'implementer']).optional(),
      status: z.enum(['invited', 'active', 'suspended', 'archived']).optional(),
      trainingStatusId: uuid.nullish(),
    }),
  }),
  async (req, res) => {
    const user = await svc.updateProfile(req.user, req.params.id, req.body, req);
    setETag(res, user);
    res.json({ user });
  },
);

usersRouter.put(
  '/:id/domains',
  requirePermission('users', 'edit', userScope),
  validate({
    params: idParam,
    body: z.object({ domainIds: z.array(uuid).max(20), primaryId: uuid.nullish() }),
  }),
  async (req, res) =>
    res.json({ count: await svc.setDomains(req.user, req.params.id, req.body.domainIds, req.body.primaryId) }),
);

usersRouter.put(
  '/:id/sub-categories',
  requirePermission('users', 'edit', userScope),
  validate({ params: idParam, body: z.object({ subCategoryIds: z.array(uuid).max(50) }) }),
  async (req, res) =>
    res.json({ count: await svc.setSubCategories(req.user, req.params.id, req.body.subCategoryIds) }),
);

usersRouter.post(
  '/:id/site-assignment',
  requirePermission('users', 'edit', userScope),
  validate({
    params: idParam,
    body: z.object({ siteId: uuid, assignmentRole: z.enum(['implementer', 'lead']).default('implementer') }),
  }),
  async (req, res) =>
    res.status(201).json({ assignmentId: await svc.setSiteAssignment(req.user, req.params.id, req.body) }),
);

usersRouter.delete(
  '/site-assignments/:id',
  requirePermission('users', 'edit'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.endSiteAssignment(req.user, req.params.id)),
);

usersRouter.post(
  '/:id/deactivate',
  requirePermission('users', 'delete', userScope),
  validate({ params: idParam }),
  async (req, res) => res.json({ user: await svc.deactivate(req.user, req.params.id) }),
);

/* ── קליטה: הזמנה במקום יצירת משתמש ── */

usersRouter.get(
  '/invites/all',
  requirePermission('users', 'view'),
  async (_req, res) => res.json({ invites: await svc.listInvites() }),
);

usersRouter.post(
  '/invites',
  requirePermission('users', 'create'),
  validate({
    body: z.object({
      email: z.string().email('כתובת דוא״ל אינה תקינה'),
      fullName: name,
      phone: z.string().trim().max(40).nullish(),
      baseRole: z.enum(['manager', 'mentor', 'lead', 'implementer']).default('implementer'),
      siteId: uuid.nullish(),
      domainIds: z.array(uuid).max(20).default([]),
      subCategoryIds: z.array(uuid).max(50).default([]),
      mentorUserId: uuid.nullish(),
    }),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'users.invite', async () => ({
      status: 201,
      body: { invite: await svc.invite(req.user, req.body) },
    }));
    res.status(result.status).json(result.body);
  },
);
