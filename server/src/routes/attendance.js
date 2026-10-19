import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { query } from '../lib/db.js';
import { uuid, dateStr, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/attendance.service.js';

/**
 * נוכחות. כניסה ויציאה — לעצמי; צפייה — לפי ה-Scope של הלו״ז (מטמיע: עצמו,
 * מדריך: המשויכים אליו, מנהל: כולם); תיקון ידני — מי שרשאי לערוך מטמיעים.
 */
export const attendanceRouter = Router();
attendanceRouter.use(requireAuth);

const self = (req) => ({ targetUserId: req.user.userId });
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/, 'מועד אינו תקין');
const noteBody = z.object({ note: z.string().trim().max(500).nullish() });

attendanceRouter.get(
  '/me/today',
  requirePermission('roster', 'view', self),
  async (req, res) => res.json(await svc.myToday(req.user)),
);

attendanceRouter.post(
  '/clock-in',
  requirePermission('roster', 'view', self),
  validate({ body: noteBody }),
  async (req, res) => res.status(201).json({ record: await svc.clockIn(req.user, req.body) }),
);

attendanceRouter.post(
  '/clock-out',
  requirePermission('roster', 'view', self),
  validate({ body: noteBody }),
  async (req, res) => res.json({ record: await svc.clockOut(req.user, req.body) }),
);

attendanceRouter.get(
  '/',
  requirePermission('roster', 'view', (req) => ({ targetUserId: req.query.userId ?? req.user.userId })),
  validate({ query: z.object({ userId: uuid.optional(), from: dateStr, to: dateStr }) }),
  async (req, res) => res.json({
    records: await svc.list({ ...req.validQuery, userId: req.validQuery.userId ?? req.user.userId }),
  }),
);

attendanceRouter.post(
  '/',
  requirePermission('implementers', 'edit', (req) => ({ targetUserId: req.body?.userId })),
  validate({
    body: z.object({
      userId: uuid,
      clockIn: localDateTime,
      clockOut: localDateTime.nullish(),
      note: z.string().trim().max(500).nullish(),
    }),
  }),
  async (req, res) => res.status(201).json({ record: await svc.upsertByManager(req.user, req.body) }),
);

const recordScope = async (req) => {
  const [row] = await query('select user_id from attendance_records where id = $1', [req.params.id]);
  return { targetUserId: row?.user_id };
};

attendanceRouter.patch(
  '/:id',
  requirePermission('implementers', 'edit', recordScope),
  validate({
    params: idParam,
    body: z.object({
      clockIn: localDateTime,
      clockOut: localDateTime.nullish(),
      note: z.string().trim().max(500).nullish(),
    }),
  }),
  async (req, res) => res.json({ record: await svc.upsertByManager(req.user, { ...req.body, id: req.params.id }) }),
);

attendanceRouter.delete(
  '/:id',
  requirePermission('implementers', 'edit', recordScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.remove(req.user, req.params.id)),
);
