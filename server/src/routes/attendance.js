import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { query } from '../lib/db.js';
import { uuid, dateStr, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/attendance.service.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';

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

/* ── דוחות נוכחות: יומי, חודשי לאדם, וסיכום חודשי. כל אחד רואה את ה-Scope שלו ── */

const STATUS_LABELS = {
  ok: 'בזמן', late: 'איחור', early: 'יציאה מוקדמת', open: 'במשמרת', missing: 'לא דווחה נוכחות',
  unplanned: 'ללא שיבוץ', absence: 'חופש / אילוץ', upcoming: 'מתוכנן',
};
const hm = (iso) => (iso
  ? new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }).format(new Date(iso))
  : '');
const range = z.object({ from: dateStr, to: dateStr })
  .refine((v) => v.to >= v.from && (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62,
    { message: 'טווח של עד חודשיים', path: ['to'] });
const dayRow = (r) => ({
  'מתוכנן': r.planned.map((p) => `${hm(p.starts_at)}–${hm(p.ends_at)} ${p.title}`).join(' | '),
  'התחלה מתוכננת': hm(r.planned_start),
  'הגעה': hm(r.first_in),
  'יציאה': hm(r.last_out),
  'איחור (דק׳)': r.late_min > 0 ? r.late_min : '',
  'יציאה מוקדמת (דק׳)': r.early_min > 0 ? r.early_min : '',
  'שעות מתוכננות': r.planned_hours,
  'שעות בפועל': r.actual_hours,
  'הפרש': r.diff_hours,
  'סטטוס': [STATUS_LABELS[r.status] ?? '', ...(r.absences ?? [])].filter(Boolean).join(' · '),
});

const dailyQuery = z.object({ date: dateStr, siteId: uuid.optional() });

attendanceRouter.get(
  '/report/daily',
  requirePermission('roster', 'view'),
  validate({ query: dailyQuery }),
  async (req, res) => res.json(await svc.daily(req.user, req.validQuery)),
);

attendanceRouter.get(
  '/report/daily/export.csv',
  requirePermission('roster', 'view'),
  validate({ query: dailyQuery }),
  async (req, res) => {
    const { rows } = await svc.daily(req.user, req.validQuery);
    const out = rows.map((r) => ({ 'שם': r.full_name, 'אתר': r.sites ?? '', ...dayRow(r) }));
    await recordExport(req, { entityType: 'attendance.daily', filters: req.validQuery, rowCount: out.length });
    sendCsv(res, `נוכחות-${req.validQuery.date}.csv`, out);
  },
);

const monthlyQuery = range.and(z.object({ userId: uuid.optional() }));
const monthlyScope = (req) => ({ targetUserId: req.query.userId ?? req.user.userId });

attendanceRouter.get(
  '/report/monthly',
  requirePermission('roster', 'view', monthlyScope),
  validate({ query: monthlyQuery }),
  async (req, res) => res.json(await svc.monthly(req.user, {
    ...req.validQuery, userId: req.validQuery.userId ?? req.user.userId,
  })),
);

attendanceRouter.get(
  '/report/monthly/export.csv',
  requirePermission('roster', 'view', monthlyScope),
  validate({ query: monthlyQuery }),
  async (req, res) => {
    const report = await svc.monthly(req.user, { ...req.validQuery, userId: req.validQuery.userId ?? req.user.userId });
    const out = report.rows.map((r) => ({ 'תאריך': r.date, ...dayRow(r) }));
    const t = report.totals;
    out.push({
      'תאריך': 'סה״כ', 'מתוכנן': `${t.planned_days} ימים מתוכננים · ${t.work_days} ימי נוכחות`,
      'התחלה מתוכננת': '', 'הגעה': '', 'יציאה': '',
      'איחור (דק׳)': `${t.late_days} ימי איחור`, 'יציאה מוקדמת (דק׳)': '',
      'שעות מתוכננות': t.planned_hours, 'שעות בפועל': t.actual_hours, 'הפרש': t.diff_hours,
      'סטטוס': t.missing_days ? `${t.missing_days} ימים בלי דיווח` : '',
    });
    await recordExport(req, { entityType: 'attendance.monthly', filters: req.validQuery, rowCount: out.length });
    sendCsv(res, `נוכחות-${report.person.full_name}-${req.validQuery.from.slice(0, 7)}.csv`, out);
  },
);

const summaryQuery = range.and(z.object({ siteId: uuid.optional() }));

attendanceRouter.get(
  '/report/summary',
  requirePermission('roster', 'view'),
  validate({ query: summaryQuery }),
  async (req, res) => res.json(await svc.summary(req.user, req.validQuery)),
);

attendanceRouter.get(
  '/report/summary/export.csv',
  requirePermission('roster', 'view'),
  validate({ query: summaryQuery }),
  async (req, res) => {
    const { people } = await svc.summary(req.user, req.validQuery);
    const out = people.map((p) => ({
      'שם': p.full_name, 'אתר': p.sites ?? '',
      'ימים מתוכננים': p.planned_days, 'ימי נוכחות': p.work_days,
      'שעות מתוכננות': p.planned_hours, 'שעות בפועל': p.actual_hours, 'הפרש': p.diff_hours,
      'ימי איחור': p.late_days, 'ימים בלי דיווח': p.missing_days, 'ימי חופש / אילוץ': p.absence_days,
    }));
    await recordExport(req, { entityType: 'attendance.summary', filters: req.validQuery, rowCount: out.length });
    sendCsv(res, `נוכחות-סיכום-${req.validQuery.from.slice(0, 7)}.csv`, out);
  },
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
