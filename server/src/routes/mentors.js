import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { uuid, dateStr, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/users.service.js';

/**
 * ניהול מדריכים.
 * AC-08 קובע שהוא יושב בהגדרות ולא כמודול ניווט עצמאי, ולכן הנתיב
 * מותקן תחת /api/settings/mentors.
 */
export const mentorsRouter = Router();
mentorsRouter.use(requireAuth);

mentorsRouter.get(
  '/',
  requirePermission('mentors', 'view'),
  validate({
    query: z.object({
      q: z.string().trim().max(120).optional(),
      status: z.enum(['invited', 'active', 'suspended', 'archived']).optional(),
    }),
  }),
  async (req, res) => res.json({ mentors: await svc.mentors(req.validQuery) }),
);

/** §9: "התרעה על מטמיע ללא מדריך" */
mentorsRouter.get(
  '/unassigned-implementers',
  requirePermission('mentors', 'view'),
  async (_req, res) => res.json({ implementers: await svc.unassigned() }),
);

mentorsRouter.get(
  '/my-team',
  requirePermission('implementers', 'view'),
  async (req, res) => res.json({ team: await svc.myTeam(req.user.userId) }),
);

mentorsRouter.post(
  '/:id/responsibilities',
  requirePermission('mentors', 'manage'),
  validate({
    params: idParam,
    body: z.object({
      siteId: uuid.nullish(),
      domainId: uuid.nullish(),
      subCategoryId: uuid.nullish(),
      fromDate: dateStr.optional(),
      toDate: dateStr.nullish(),
    }).refine((v) => !v.subCategoryId || v.domainId, {
      message: 'תת-קטגוריה מחייבת בחירת תחום',
      path: ['domainId'],
    }),
  }),
  async (req, res) =>
    res.status(201).json({ responsibility: await svc.addResponsibility(req.user, req.params.id, req.body) }),
);

mentorsRouter.delete(
  '/responsibilities/:id',
  requirePermission('mentors', 'manage'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.endResponsibility(req.user, req.params.id)),
);

/** בדיקה יבשה לפני שיוך — מחזירה את הסיבות בלי לכתוב */
mentorsRouter.post(
  '/assignments/validate',
  requirePermission('mentors', 'view'),
  validate({ body: z.object({ mentorUserId: uuid, implementerUserId: uuid }) }),
  async (req, res) =>
    res.json(await svc.validateMentorAssignment(req.body.mentorUserId, req.body.implementerUserId)),
);

mentorsRouter.post(
  '/assignments',
  requirePermission('mentors', 'manage'),
  validate({
    body: z.object({
      mentorUserId: uuid,
      implementerUserId: uuid,
      isPrimary: z.boolean().default(false),
    }),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'mentors.assign', async () => {
      const out = await svc.assignMentor(req.user, { ...req.body, traceId: req.traceId });
      return { status: out.status === 'approval_required' ? 202 : 201, body: out };
    });
    res.status(result.status).json(result.body);
  },
);

mentorsRouter.delete(
  '/assignments/:id',
  requirePermission('mentors', 'manage'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.endMentorAssignment(req.user, req.params.id)),
);
