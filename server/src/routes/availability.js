import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { uuid, dateStr, timeStr, sundayDate, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/availability.service.js';
import { query } from '../lib/db.js';

export const availabilityRouter = Router();
availabilityRouter.use(requireAuth);

const declarationScope = async (req) => {
  const id = req.params.id;
  if (!id) return { targetUserId: req.body?.userId ?? req.user.userId, siteId: req.body?.siteId };
  const [row] = await query(
    'select user_id, site_id from availability_declarations where id = $1',
    [id],
  );
  return { targetUserId: row?.user_id, siteId: row?.site_id };
};

/** חלון ההגשה: איזה שבוע, אילו משמרות, אילו מכסות ועד מתי */
availabilityRouter.get(
  '/window',
  requirePermission('availability', 'view'),
  validate({ query: z.object({ siteId: uuid.optional() }) }),
  async (req, res) => res.json(await svc.window(req.user, req.validQuery.siteId)),
);

availabilityRouter.get(
  '/declarations',
  requirePermission('availability', 'view'),
  validate({
    query: z.object({
      userId: uuid.optional(),
      siteId: uuid.optional(),
      weekStart: dateStr.optional(),
      includeSuperseded: z.coerce.boolean().default(false),
    }),
  }),
  async (req, res) => {
    const { userId, ...rest } = req.validQuery;
    const target = userId ?? req.user.userId;

    // צפייה בהצהרה של אדם אחר נבדקת שוב, עם ה-Scope הנכון
    if (target !== req.user.userId) {
      const { decide } = await import('../permissions/engine.js');
      const allowed = decide(req.user, 'availability', 'view', { targetUserId: target }).allowed;
      if (!allowed) {
        const { AppError } = await import('../lib/errors.js');
        throw new AppError('E_FORBIDDEN', 'אין לך הרשאה לצפות בזמינות של משתמש זה');
      }
    }

    res.json({ declarations: await svc.listForUser(target, rest) });
  },
);

const draftBody = z.object({
  userId: uuid.optional(),
  siteId: uuid,
  weekStart: sundayDate,
  note: z.string().trim().max(1000).nullish(),
  cells: z
    .array(
      z.object({
        date: dateStr,
        startTime: timeStr,
        endTime: timeStr,
        value: z.enum(['can', 'prefer_not', 'cannot']),
        note: z.string().trim().max(300).nullish(),
      }),
    )
    .max(200)
    .default([]),
});

/** שמירת טיוטה. אידמפוטנטית לפי (משתמש, אתר, שבוע). */
availabilityRouter.put(
  '/declarations',
  requirePermission('availability', 'create', (req) => ({
    targetUserId: req.body?.userId ?? req.user.userId,
    siteId: req.body?.siteId,
  })),
  validate({ body: draftBody }),
  async (req, res) => {
    const declarationId = await svc.saveDraft(req.user, req.body);
    res.json({ declarationId });
  },
);

/** §7: להציג לפני השליחה אם ההגשה תקינה או דורשת אישור מיוחד */
availabilityRouter.post(
  '/declarations/:id/preview',
  requirePermission('availability', 'view', declarationScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.preview(req.user, req.params.id)),
);

availabilityRouter.post(
  '/declarations/:id/submit',
  requirePermission('availability', 'create', declarationScope),
  validate({ params: idParam }),
  async (req, res) => {
    const result = await withIdempotency(req, 'availability.submit', async () => {
      const out = await svc.submit(req.user, req.params.id, { traceId: req.traceId });
      return { status: out.status === 'pending_approval' ? 202 : 200, body: out };
    });
    res.status(result.status).json(result.body);
  },
);

availabilityRouter.post(
  '/declarations/:id/decision',
  requirePermission('availability', 'approve', declarationScope),
  validate({
    params: idParam,
    body: z.object({
      decision: z.enum(['approve', 'reject']),
      comment: z.string().trim().min(3, 'החלטה מחייבת נימוק של 3 תווים לפחות').max(1000),
    }),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'availability.decision', async () => ({
      status: 200,
      body: await svc.decide(req.user, req.params.id, { ...req.body, traceId: req.traceId }),
    }));
    res.status(result.status).json(result.body);
  },
);

/** תור ההגשות שחורגות מהכללים */
availabilityRouter.get(
  '/pending',
  requirePermission('availability', 'approve'),
  async (req, res) => res.json({ declarations: await svc.pending(req.user) }),
);
