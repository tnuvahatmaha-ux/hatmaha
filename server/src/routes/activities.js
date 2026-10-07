import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { setETag } from '../lib/etag.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';
import { uuid, dateStr, timeStr, optionalText, idParam } from '../schemas/common.schema.js';
import * as svc from '../services/activities.service.js';
import { query } from '../lib/db.js';

export const activitiesRouter = Router();
activitiesRouter.use(requireAuth);

const activityScope = async (req) => {
  const id = req.params.id;
  if (!id) return { siteId: req.body?.siteId ?? req.query?.siteId };
  const [row] = await query('select site_id, owner_user_id from activities where id = $1', [id]);
  return { siteId: row?.site_id, ownerId: row?.owner_user_id };
};

const activityBody = z
  .object({
    id: uuid.optional(),
    siteId: uuid,
    locationId: uuid.nullish(),
    activityTypeId: uuid,
    title: z.string().trim().max(200).nullish(),
    description: optionalText,
    activityDate: dateStr,
    startTime: timeStr,
    endTime: timeStr,
    audience: z.enum(['all', 'site', 'domain', 'sub_category', 'users']).default('site'),
    targetIds: z.array(uuid).max(200).default([]),
    visibility: z.enum(['participants', 'managers_only', 'draft']).default('participants'),
    ownerUserId: uuid.nullish(),
    domainId: uuid.nullish(),
    subCategoryId: uuid.nullish(),
    notes: optionalText,
  })
  .refine((v) => v.audience === 'all' || v.targetIds.length > 0, {
    message: 'יש לבחור לפחות יעד אחד לקהל שנבחר',
    path: ['targetIds'],
  });

activitiesRouter.get(
  '/',
  requirePermission('activities', 'view'),
  validate({
    query: z.object({
      siteId: uuid.optional(),
      from: dateStr.optional(),
      to: dateStr.optional(),
      typeId: uuid.optional(),
      status: z.enum(['draft', 'pending_approval', 'scheduled', 'completed', 'cancelled']).optional(),
      limit: z.coerce.number().int().min(1).max(500).default(200),
    }),
  }),
  async (req, res) => res.json({ activities: await svc.list(req.user, req.validQuery) }),
);

activitiesRouter.get(
  '/my-tasks',
  requirePermission('activities', 'view'),
  async (req, res) => res.json({ tasks: await svc.mentorTasks(req.user.userId) }),
);

activitiesRouter.get(
  '/:id',
  requirePermission('activities', 'view', activityScope),
  validate({ params: idParam }),
  async (req, res) => {
    const result = await svc.get(req.params.id);
    setETag(res, result.activity);
    res.json(result);
  },
);

activitiesRouter.post(
  '/',
  requirePermission('activities', 'create', (req) => ({ siteId: req.body?.siteId })),
  validate({ body: activityBody }),
  async (req, res) => {
    const result = await withIdempotency(req, 'activities.save', async () => {
      const out = await svc.save(req.user, req.body, { traceId: req.traceId });
      return { status: out.status === 'approval_required' ? 202 : 201, body: out };
    });
    res.status(result.status).json(result.body);
  },
);

activitiesRouter.patch(
  '/:id',
  requirePermission('activities', 'edit', activityScope),
  validate({ params: idParam, body: activityBody }),
  async (req, res) => {
    const out = await svc.save(req.user, { ...req.body, id: req.params.id }, { req, traceId: req.traceId });
    res.status(out.status === 'approval_required' ? 202 : 200).json(out);
  },
);

activitiesRouter.post(
  '/:id/status',
  requirePermission('activities', 'edit', activityScope),
  validate({
    params: idParam,
    body: z.object({ status: z.enum(['scheduled', 'completed', 'cancelled']) }),
  }),
  async (req, res) => res.json({ activity: await svc.setStatus(req.user, req.params.id, req.body.status) }),
);

activitiesRouter.post(
  '/:id/prep',
  requirePermission('activities', 'edit', activityScope),
  validate({ params: idParam, body: z.object({ prepDone: z.boolean() }) }),
  async (req, res) => res.json({ activity: await svc.setPrep(req.user, req.params.id, req.body.prepDone) }),
);

activitiesRouter.post(
  '/:id/attendance',
  requirePermission('activities', 'edit', activityScope),
  validate({
    params: idParam,
    body: z.object({
      entries: z.array(
        z.object({
          userId: uuid,
          attendance: z.enum(['invited', 'confirmed', 'attended', 'absent', 'excused']),
        }),
      ).max(500),
    }),
  }),
  async (req, res) => res.json(await svc.setAttendance(req.user, req.params.id, req.body.entries)),
);

activitiesRouter.delete(
  '/:id',
  requirePermission('activities', 'delete', activityScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.remove(req.user, req.params.id)),
);

activitiesRouter.get(
  '/export/csv',
  requirePermission('activities', 'export'),
  validate({ query: z.object({ siteId: uuid.optional(), from: dateStr.optional(), to: dateStr.optional() }) }),
  async (req, res) => {
    const rows = (await svc.list(req.user, { ...req.validQuery, limit: 500 })).map((a) => ({
      תאריך: a.activity_date,
      אתר: a.site_name,
      'סוג פעילות': a.type_name,
      כותרת: a.title ?? '',
      מיקום: a.location_name ?? '',
      התחלה: a.start_time.slice(0, 5),
      סיום: a.end_time.slice(0, 5),
      משתתפים: a.participant_count,
      סטטוס: a.status,
    }));
    await recordExport(req, { entityType: 'activities', filters: req.validQuery, rowCount: rows.length });
    sendCsv(res, 'דוח-פעילויות.csv', rows);
  },
);
