import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { uuid, idParam } from '../schemas/common.schema.js';
import { storageEnabled, MAX_FILE_BYTES } from '../lib/storage.js';
import * as svc from '../services/updates.service.js';

/**
 * הודעות לצוות.
 *
 * נתיבי הנמען (תיבה, קריאה, אישור) פועלים על המשתמש המחובר בלבד.
 * נתיבי השולח דורשים updates.create, וה-service מוודא שהשולח הוא הכותב
 * ושהנמענים בתחום שלו.
 */
export const updatesRouter = Router();
updatesRouter.use(requireAuth);

updatesRouter.get('/inbox', async (req, res) =>
  res.json({ updates: await svc.inbox(req.user.userId) }),
);

updatesRouter.get(
  '/sent',
  requirePermission('updates', 'create'),
  async (req, res) => res.json({ updates: await svc.sent(req.user.userId), storageEnabled }),
);

updatesRouter.get(
  '/recipients',
  requirePermission('updates', 'create'),
  async (req, res) => res.json({ recipients: await svc.allowedRecipients(req.user), storageEnabled }),
);

updatesRouter.post(
  '/',
  requirePermission('updates', 'create'),
  validate({
    body: z.object({
      title: z.string().trim().min(1, 'חסרה כותרת').max(200),
      body: z.string().trim().min(1, 'חסר תוכן').max(10000),
      recipientIds: z.array(uuid).max(500).default([]),
      toWholeTeam: z.boolean().default(false),
      requiresAck: z.boolean().default(false),
    }),
  }),
  async (req, res) => res.status(201).json(await svc.create(req.user, req.body)),
);

updatesRouter.get(
  '/:id',
  validate({ params: idParam }),
  async (req, res) => res.json({ update: await svc.get(req.user, req.params.id) }),
);

updatesRouter.post(
  '/:id/publish',
  requirePermission('updates', 'create'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.publish(req.user, req.params.id)),
);

updatesRouter.delete(
  '/:id',
  requirePermission('updates', 'create'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.discard(req.user, req.params.id)),
);

updatesRouter.post(
  '/:id/remind',
  requirePermission('updates', 'create'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.remind(req.user, req.params.id)),
);

updatesRouter.post('/:id/read', validate({ params: idParam }), async (req, res) =>
  res.json(await svc.markRead(req.user.userId, req.params.id)),
);

updatesRouter.post('/:id/ack', validate({ params: idParam }), async (req, res) =>
  res.json(await svc.acknowledge(req.user.userId, req.params.id)),
);

/* ── קבצים: הדפדפן מעלה ישירות ל-Storage עם קישור חתום ── */

const fileMeta = z.object({
  fileName: z.string().trim().min(1).max(200),
  sizeBytes: z.coerce.number().int().min(1).max(MAX_FILE_BYTES, 'הקובץ גדול מ-10MB'),
  mimeType: z.string().max(120).nullish(),
});

updatesRouter.post(
  '/:id/attachments/sign',
  requirePermission('updates', 'create'),
  validate({ params: idParam, body: fileMeta }),
  async (req, res) => res.json(await svc.signAttachmentUpload(req.user, req.params.id, req.body)),
);

updatesRouter.post(
  '/:id/attachments',
  requirePermission('updates', 'create'),
  validate({ params: idParam, body: fileMeta.extend({ storagePath: z.string().min(1).max(400) }) }),
  async (req, res) => res.status(201).json({ attachment: await svc.registerAttachment(req.user, req.params.id, req.body) }),
);

updatesRouter.get(
  '/:id/attachments/:attId/url',
  validate({ params: z.object({ id: uuid, attId: uuid }) }),
  async (req, res) => res.json(await svc.attachmentUrl(req.user, req.params.id, req.params.attId)),
);
