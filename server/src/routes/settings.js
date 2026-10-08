import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { setETag } from '../lib/etag.js';
import { uuid, name, optionalText, timeStr } from '../schemas/common.schema.js';
import * as svc from '../services/settings.service.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

/* ── תחומים ותתי-קטגוריות ──────────────────────────────────── */

const domainBody = z.object({
  id: uuid.optional(),
  name,
  description: optionalText,
  displayOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

const subCategoryBody = domainBody.extend({ domainId: uuid });

// קטלוגים לקריאה בלבד פתוחים לכל משתמש מחובר: הם ממלאים טפסים (סוג אילוץ,
// תחום, מיקום) של כל התפקידים. בלי זה, "בקשת חופשה או אילוץ" של מטמיע
// נכשלה ב"אין לך הרשאה" עוד לפני שנפתחה. הכתיבה נשארת תחת הרשאות ניהול.

settingsRouter.get(
  '/domains',
  validate({ query: z.object({ includeInactive: z.coerce.boolean().default(false) }) }),
  async (req, res) => res.json({ domains: await svc.domainTree(req.validQuery) }),
);

settingsRouter.post(
  '/domains',
  requirePermission('domains', 'create'),
  validate({ body: domainBody }),
  async (req, res) => {
    const domain = await svc.saveDomain(req.user, req.body, req);
    setETag(res, domain);
    res.status(req.body.id ? 200 : 201).json({ domain });
  },
);

settingsRouter.post(
  '/sub-categories',
  requirePermission('domains', 'create'),
  validate({ body: subCategoryBody }),
  async (req, res) => {
    const subCategory = await svc.saveSubCategory(req.user, req.body, req);
    setETag(res, subCategory);
    res.status(req.body.id ? 200 : 201).json({ subCategory });
  },
);

/* ── קטלוגים (סוגי פעילות, סוגי אילוץ, סטטוסים) ───────────── */

const lookupKind = z.enum(svc.lookupKinds);

const lookupBody = z.object({
  id: uuid.optional(),
  code: z.string().regex(/^[a-z0-9_]+$/, 'קוד חייב להיות באנגלית קטנה, ספרות וקו תחתון').optional(),
  nameHe: name,
  displayOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

settingsRouter.get(
  '/lookups/:kind',
  validate({
    params: z.object({ kind: lookupKind }),
    query: z.object({ includeInactive: z.coerce.boolean().default(false) }),
  }),
  async (req, res) => res.json({ items: await svc.listLookup(req.params.kind, req.validQuery) }),
);

settingsRouter.post(
  '/lookups/:kind',
  requirePermission('settings', 'manage'),
  validate({ params: z.object({ kind: lookupKind }), body: lookupBody }),
  async (req, res) => {
    const item = await svc.saveLookup(req.user, req.params.kind, req.body, req);
    setETag(res, item);
    res.status(req.body.id ? 200 : 201).json({ item });
  },
);

/* ── כללי אישור אילוצים — גנריים, לכל האתרים ──────────────── */

settingsRouter.get(
  '/constraint-approval',
  requirePermission('settings', 'view'),
  async (_req, res) => res.json({ rules: await svc.constraintApprovalRules() }),
);

settingsRouter.put(
  '/constraint-approval/:constraintTypeId',
  requirePermission('settings', 'manage'),
  validate({
    params: z.object({ constraintTypeId: uuid }),
    body: z.object({ approvalMode: z.enum(['auto', 'manager']) }),
  }),
  async (req, res) =>
    res.json({
      rule: await svc.setConstraintApprovalMode(req.user, req.params.constraintTypeId, req.body.approvalMode),
    }),
);

/* ── סוגי מיקום ופרופילים לפי תקופה ───────────────────────── */

settingsRouter.get(
  '/location-types',
  async (_req, res) => res.json({ locationTypes: await svc.locationTypes() }),
);

settingsRouter.post(
  '/location-types',
  requirePermission('settings', 'manage'),
  validate({ body: z.object({ id: uuid.optional(), name, isActive: z.boolean().optional() }) }),
  async (req, res) => {
    const id = await svc.saveLocationType(req.user, req.body, req);
    res.status(req.body.id ? 200 : 201).json({ id });
  },
);

settingsRouter.put(
  '/location-types/:id/profiles/:period',
  requirePermission('settings', 'manage'),
  validate({
    params: z.object({ id: uuid, period: z.enum(['training', 'golive', 'support']) }),
    body: z.object({
      activeDays: z.array(z.coerce.number().int().min(0).max(6)).max(7).default([0, 1, 2, 3, 4]),
      openTime: timeStr.default('08:00'),
      closeTime: timeStr.default('17:00'),
      shiftTemplates: z
        .array(z.object({ name, startTime: timeStr, endTime: timeStr }))
        .max(12)
        .default([]),
    }),
  }),
  async (req, res) => {
    const profileId = await svc.saveProfile(req.user, req.params.id, req.params.period, req.body);
    res.json({ profileId });
  },
);

/* ── הגדרות כלליות ────────────────────────────────────────── */

settingsRouter.get(
  '/app',
  requirePermission('settings', 'view'),
  async (_req, res) => res.json({ settings: await svc.appSettings() }),
);

settingsRouter.put(
  '/app/:key',
  requirePermission('settings', 'manage'),
  validate({
    params: z.object({ key: z.string().regex(/^[a-z_]+$/) }),
    body: z.object({ value: z.unknown() }),
  }),
  async (req, res) => res.json(await svc.setAppSetting(req.user, req.params.key, req.body.value)),
);
