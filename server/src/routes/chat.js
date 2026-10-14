import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { uuid, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/chat.service.js';

/**
 * צ׳אט קבוצתי. החברות בקבוצה נבדקת ב-service בכל נתיב של קבוצה מסוימת:
 * מי שאינו חבר מקבל 404, כדי שלא יוכל אפילו לדעת שהקבוצה קיימת.
 */
export const chatRouter = Router();
chatRouter.use(requireAuth);

chatRouter.get(
  '/groups',
  requirePermission('chat', 'view'),
  async (req, res) => res.json({ groups: await svc.listGroups(req.user) }),
);

chatRouter.post(
  '/groups',
  requirePermission('updates', 'create'), // פתיחת קבוצה — מדריכים ומנהלים
  validate({
    body: z
      .object({
        name: z.string().trim().min(1, 'חסר שם לקבוצה').max(120),
        kind: z.enum(['custom', 'domain', 'sub_category', 'site']).default('custom'),
        siteId: uuid.nullish(),
        domainId: uuid.nullish(),
        subCategoryId: uuid.nullish(),
        memberIds: z.array(uuid).max(300).default([]),
      })
      .refine(
        (v) => v.kind === 'custom' || ({ domain: v.domainId, sub_category: v.subCategoryId, site: v.siteId })[v.kind],
        { message: 'יש לבחור תחום, תת-תחום או אתר', path: ['kind'] },
      ),
  }),
  async (req, res) => res.status(201).json({ group: await svc.createGroup(req.user, req.body) }),
);

chatRouter.patch(
  '/groups/:id',
  requirePermission('chat', 'view'),
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().min(1).max(120).optional(),
      isArchived: z.boolean().optional(),
      addMemberIds: z.array(uuid).max(300).default([]),
      removeMemberIds: z.array(uuid).max(300).default([]),
    }),
  }),
  async (req, res) => res.json(await svc.updateGroup(req.user, req.params.id, req.body)),
);

chatRouter.get(
  '/groups/:id/members',
  requirePermission('chat', 'view'),
  validate({ params: idParam }),
  async (req, res) => res.json({ members: await svc.members(req.user, req.params.id) }),
);

chatRouter.get(
  '/groups/:id/messages',
  requirePermission('chat', 'view'),
  validate({
    params: idParam,
    query: z.object({
      after: z.coerce.number().int().min(0).optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  async (req, res) => res.json(await svc.messages(req.user, req.params.id, req.validQuery)),
);

chatRouter.post(
  '/groups/:id/messages',
  requirePermission('chat', 'create'),
  validate({
    params: idParam,
    body: z.object({ body: z.string().trim().min(1).max(4000), requiresAck: z.boolean().default(false) }),
  }),
  async (req, res) =>
    res.status(201).json({
      message: await svc.send(req.user, req.params.id, req.body.body, { requiresAck: req.body.requiresAck }),
    }),
);

const messageParams = z.object({ id: uuid, messageId: z.coerce.number().int().positive() });

chatRouter.post(
  '/groups/:id/messages/:messageId/ack',
  requirePermission('chat', 'view'),
  validate({ params: messageParams }),
  async (req, res) =>
    res.json({ message: await svc.acknowledge(req.user, req.params.id, req.params.messageId) }),
);

chatRouter.get(
  '/groups/:id/messages/:messageId/acks',
  requirePermission('chat', 'view'),
  validate({ params: messageParams }),
  async (req, res) =>
    res.json({ members: await svc.acks(req.user, req.params.id, req.params.messageId) }),
);

chatRouter.post(
  '/groups/:id/read',
  requirePermission('chat', 'view'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.markRead(req.user, req.params.id)),
);
