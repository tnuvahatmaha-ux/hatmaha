import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { query } from '../lib/db.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';
import { uuid, dateStr, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/training.service.js';

/**
 * תוכנית הכשרה (גאנט) והתקדמות שבועית.
 * צפייה — לפי Scope המשתמשים (מטמיע: עצמו, מדריך: המשויכים אליו).
 * עריכת שלבים — מי שרשאי לערוך מטמיעים. אישור התקדמות — implementers.approve (מנהל).
 */
export const trainingRouter = Router();
trainingRouter.use(requireAuth);

const itemScope = async (req) => {
  const [row] = await query('select user_id from user_training_items where id = $1', [req.params.id]);
  return { targetUserId: row?.user_id };
};
const userParam = z.object({ userId: uuid });
const filters = z.object({ siteId: uuid.optional(), domainId: uuid.optional(), userId: uuid.optional() });

trainingRouter.get(
  '/plans',
  requirePermission('users', 'view'),
  validate({ query: filters }),
  async (req, res) => res.json({ people: await svc.plans(req.user, req.validQuery) }),
);

trainingRouter.post(
  '/plans/:userId/items',
  requirePermission('implementers', 'edit', (req) => ({ targetUserId: req.params.userId })),
  validate({
    params: userParam,
    body: z.object({ title: z.string().trim().min(1).max(200), startOn: dateStr, dueOn: dateStr })
      .refine((v) => v.dueOn >= v.startOn, { message: 'תאריך היעד לפני תאריך ההתחלה', path: ['dueOn'] }),
  }),
  async (req, res) => res.status(201).json(await svc.addItem(req.user, req.params.userId, req.body)),
);

trainingRouter.post(
  '/plans/:userId/apply-track',
  requirePermission('implementers', 'edit', (req) => ({ targetUserId: req.params.userId })),
  validate({ params: userParam, body: z.object({ trackId: uuid, startOn: dateStr }) }),
  async (req, res) => res.json(await svc.applyTrack(req.user, req.params.userId, req.body)),
);

trainingRouter.patch(
  '/items/:id',
  requirePermission('implementers', 'edit', itemScope),
  validate({
    params: idParam,
    body: z.object({
      title: z.string().trim().min(1).max(200).optional(),
      startOn: dateStr.optional(),
      dueOn: dateStr.optional(),
      displayOrder: z.number().int().optional(),
      note: z.string().trim().max(1000).optional(),
    }),
  }),
  async (req, res) => res.json(await svc.updateItem(req.user, req.params.id, req.body)),
);

trainingRouter.delete(
  '/items/:id',
  requirePermission('implementers', 'edit', itemScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.removeItem(req.user, req.params.id)),
);

trainingRouter.get(
  '/items/:id/history',
  requirePermission('users', 'view', itemScope),
  validate({ params: idParam }),
  async (req, res) => res.json({ history: await svc.history(req.params.id) }),
);

/** דיווח התקדמות שבועי — המטמיע על עצמו, המדריך על המשויכים אליו, או מנהל */
trainingRouter.post(
  '/items/:id/progress',
  requirePermission('users', 'view', itemScope),
  validate({
    params: idParam,
    body: z.object({
      progressPct: z.number().int().min(0).max(100),
      note: z.string().trim().max(1000).nullish(),
      weekStart: dateStr.optional(),
    }),
  }),
  async (req, res) => res.status(201).json(await svc.reportProgress(req.user, req.params.id, req.body)),
);

/** סימון סטטוס לכמה שלבים יחד — ה-Scope של כל שלב נבדק ב-service */
trainingRouter.post(
  '/progress/bulk',
  requirePermission('implementers', 'view'),
  validate({
    body: z.object({
      itemIds: z.array(uuid).min(1).max(500),
      progressPct: z.number().int().min(0).max(100),
      note: z.string().trim().max(1000).nullish(),
    }),
  }),
  async (req, res) => res.json(await svc.reportBulk(req.user, req.body)),
);

/** גאנט כללי מקובץ: קריאה ותצוגה מקדימה, ואז שמירה ושיוך עובדים */
trainingRouter.post(
  '/import/parse',
  requirePermission('implementers', 'edit'),
  validate({
    body: z.object({
      fileName: z.string().trim().min(1).max(255),
      data: z.string().min(1).max(7_000_000),
    }),
  }),
  async (req, res) => res.json(await svc.parseGanttFile(req.body)),
);

trainingRouter.post(
  '/import/apply',
  requirePermission('implementers', 'edit'),
  validate({
    body: z.object({
      name: z.string().trim().min(1).max(200),
      trackId: uuid.optional(),
      userIds: z.array(uuid).max(500).default([]),
      rows: z.array(z.object({
        title: z.string().trim().min(1).max(200),
        startOn: dateStr,
        dueOn: dateStr,
      }).refine((r) => r.dueOn >= r.startOn, { message: 'תאריך הסיום לפני ההתחלה' })).min(1).max(60),
    }),
  }),
  async (req, res) => res.status(201).json(await svc.importGantt(req.user, req.body)),
);

trainingRouter.get(
  '/progress/pending',
  requirePermission('users', 'view'),
  async (req, res) => res.json({ updates: await svc.pendingQueue(req.user) }),
);

trainingRouter.post(
  '/progress/:id/decision',
  requirePermission('implementers', 'approve'),
  validate({
    params: idParam,
    body: z.object({ decision: z.enum(['approve', 'reject']), comment: z.string().trim().max(1000).optional() }),
  }),
  async (req, res) => res.json(await svc.decide(req.user, req.params.id, req.body)),
);

trainingRouter.get(
  '/tracks',
  requirePermission('implementers', 'view'),
  async (_req, res) => res.json({ tracks: await svc.tracks() }),
);

const trackBody = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullish(),
  isActive: z.boolean().optional(),
  items: z.array(z.object({
    id: uuid.optional(),
    title: z.string().trim().min(1).max(200),
    durationDays: z.number().int().min(1).max(365),
  })).max(60).default([]),
});

trainingRouter.post(
  '/tracks',
  requirePermission('settings', 'edit'),
  validate({ body: trackBody }),
  async (req, res) => res.status(201).json(await svc.saveTrack(req.user, req.body)),
);

trainingRouter.put(
  '/tracks/:id',
  requirePermission('settings', 'edit'),
  validate({ params: idParam, body: trackBody }),
  async (req, res) => res.json(await svc.saveTrack(req.user, { ...req.body, id: req.params.id })),
);

trainingRouter.delete(
  '/tracks/:id',
  requirePermission('settings', 'edit'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.removeTrack(req.user, req.params.id)),
);

trainingRouter.get(
  '/report',
  requirePermission('reports', 'view'),
  validate({ query: filters }),
  async (req, res) => res.json({ rows: await svc.progressReport(req.user, req.validQuery) }),
);

trainingRouter.get(
  '/report/export.csv',
  requirePermission('reports', 'export'),
  validate({ query: filters }),
  async (req, res) => {
    const rows = await svc.progressReport(req.user, req.validQuery);
    await recordExport(req, { entityType: 'training_progress', filters: req.validQuery, rowCount: rows.length });
    sendCsv(res, 'התקדמות-הכשרה.csv', rows.map((r) => ({
      מטמיע: r.full_name,
      מדריך: r.mentor_name ?? '',
      תחום: r.domains ?? '',
      שלב: r.item_title,
      התחלה: r.start_on ?? '',
      יעד: r.due_on ?? '',
      'התקדמות מאושרת %': r.progress_pct,
      'צפוי לפי לו״ז %': r.expected_pct ?? '',
      'סה״כ תוכנית %': r.overall_pct ?? '',
      'בפיגור': r.behind ? 'כן' : '',
      'הושלם בתאריך': r.completed_on ?? '',
    })));
  },
);
