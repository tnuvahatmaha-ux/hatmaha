import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { setETag } from '../lib/etag.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';
import { uuid, dateStr, timeStr, sundayDate, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/roster.service.js';
import { query } from '../lib/db.js';

export const rosterRouter = Router();
rosterRouter.use(requireAuth);

/** ה-Scope נגזר מהאתר של הגרסה */
const versionScope = async (req) => {
  const id = req.params.versionId ?? req.params.id;
  if (!id) return { siteId: req.validQuery?.siteId ?? req.body?.siteId };
  const [row] = await query('select site_id from roster_versions where id = $1', [id]);
  return { siteId: row?.site_id };
};

const assignmentScope = async (req) => {
  const [row] = await query(
    'select site_id, user_id from roster_assignments where id = $1',
    [req.params.id],
  );
  return { siteId: row?.site_id, targetUserId: row?.user_id };
};

rosterRouter.get(
  '/versions',
  requirePermission('roster', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: z.object({ siteId: uuid, weekStart: dateStr.optional() }) }),
  async (req, res) =>
    res.json({ versions: await svc.versions(req.validQuery.siteId, req.validQuery.weekStart) }),
);

/** הטיוטה הפתוחה לשבוע. נוצרת עצלנית אם אין. */
rosterRouter.get(
  '/draft',
  requirePermission('roster', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: z.object({ siteId: uuid, weekStart: dateStr }) }),
  async (req, res) => {
    const draft = await svc.getOrCreateDraft(req.user, req.validQuery.siteId, req.validQuery.weekStart);
    setETag(res, draft);
    res.json({ version: draft });
  },
);

/** כל מה שמסך המטריצה צריך, בקריאה אחת */
rosterRouter.get(
  '/versions/:versionId/board',
  requirePermission('roster', 'view', versionScope),
  validate({ params: z.object({ versionId: uuid }) }),
  async (req, res) => {
    const board = await svc.board(req.params.versionId);
    setETag(res, board.version);
    res.json(board);
  },
);

const assignBody = z.object({
  userId: uuid,
  date: dateStr,
  locationId: uuid,
  shiftTypeId: uuid.nullish(),
  startTime: timeStr.optional(),
  endTime: timeStr.optional(),
  note: z.string().trim().max(500).nullish(),
});

rosterRouter.post(
  '/versions/:versionId/assignments',
  requirePermission('roster', 'create', versionScope),
  validate({ params: z.object({ versionId: uuid }), body: assignBody }),
  async (req, res) => {
    const result = await withIdempotency(req, 'roster.assign', async () => {
      const out = await svc.assign(req.user, req.params.versionId, req.body, { traceId: req.traceId });
      return { status: out.status === 'approval_required' ? 202 : 201, body: out };
    });
    res.status(result.status).json(result.body);
  },
);

rosterRouter.delete(
  '/assignments/:id',
  requirePermission('roster', 'delete', assignmentScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.unassign(req.user, req.params.id, req)),
);

rosterRouter.post(
  '/versions/:versionId/duplicate-week',
  requirePermission('roster', 'create', versionScope),
  validate({
    params: z.object({ versionId: uuid }),
    body: z.object({
      targetWeekStart: sundayDate.optional(),
      mode: z.enum(['copy', 'rotate']).default('copy'),
    }),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'roster.duplicate', async () => ({
      status: 200,
      body: await svc.duplicateWeek(req.user, req.params.versionId, req.body),
    }));
    res.status(result.status).json(result.body);
  },
);

/** בדיקת תקינות לפני פרסום */
rosterRouter.post(
  '/versions/:versionId/validate',
  requirePermission('roster', 'view', versionScope),
  validate({ params: z.object({ versionId: uuid }) }),
  async (req, res) => res.json(await svc.validateVersion(req.user, req.params.versionId)),
);

/** פרסום — יוצר גרסה חדשה לקריאה בלבד ושומר היסטוריה (AC-12) */
rosterRouter.post(
  '/versions/:versionId/publish',
  requirePermission('roster', 'publish', versionScope),
  validate({
    params: z.object({ versionId: uuid }),
    body: z.object({ note: z.string().trim().max(500).nullish() }).default({}),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'roster.publish', async () => ({
      status: 200,
      body: await svc.publish(req.user, req.params.versionId, {
        note: req.body?.note,
        req,
        traceId: req.traceId,
      }),
    }));
    res.status(result.status).json(result.body);
  },
);

rosterRouter.get(
  '/versions/:versionId/export.csv',
  requirePermission('roster', 'export', versionScope),
  validate({ params: z.object({ versionId: uuid }) }),
  async (req, res) => {
    const rows = await svc.exportRows(req.params.versionId);
    await recordExport(req, {
      entityType: 'roster_versions',
      filters: { versionId: req.params.versionId },
      rowCount: rows.length,
    });
    sendCsv(res, `סידור-עבודה-${req.params.versionId.slice(0, 8)}.csv`, rows);
  },
);

/** הסידור שלי — מגרסאות שפורסמו בלבד */
rosterRouter.get(
  '/my',
  requirePermission('roster', 'view', (req) => ({ targetUserId: req.user.userId })),
  validate({ query: z.object({ from: dateStr.optional(), to: dateStr.optional() }) }),
  async (req, res) => res.json({ assignments: await svc.mine(req.user.userId, req.validQuery) }),
);
