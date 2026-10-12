import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { uuid, dateStr, idParam } from '../schemas/common.schema.js';
import { recordExport } from '../audit/service.js';
import { query } from '../lib/db.js';
import * as svc from '../services/skills.service.js';

/**
 * סקילומטר. ה-Scope של כל נתיב נגזר מהאתר — של הסבב, או מ-siteId בבקשה.
 * הצמצום לתחומים של המטמיע נעשה ב-service.
 */
export const skillsRouter = Router();
skillsRouter.use(requireAuth);

const roundScope = async (req) => {
  const [row] = await query('select site_id from skill_rounds where id = $1', [req.params.id]);
  return { siteId: row?.site_id };
};
const endUserScope = async (req) => {
  const [row] = await query('select site_id from end_users where id = $1', [req.params.id]);
  return { siteId: row?.site_id };
};
const querySite = (req) => ({ siteId: req.query.siteId });
const bodySite = (req) => ({ siteId: req.body?.siteId });

/* ── נושאים ── */
skillsRouter.get(
  '/topics',
  requirePermission('skills', 'view'),
  validate({ query: z.object({ domainId: uuid.optional() }) }),
  async (req, res) => res.json({ topics: await svc.listTopics(req.validQuery) }),
);

skillsRouter.post(
  '/topics',
  requirePermission('skills', 'manage'),
  validate({
    body: z.object({
      id: uuid.optional(),
      domainId: uuid,
      subCategoryId: uuid.nullish(),
      name: z.string().trim().min(1, 'חסר שם לנושא').max(200),
      description: z.string().trim().max(1000).nullish(),
      displayOrder: z.coerce.number().int().optional(),
      isActive: z.boolean().optional(),
    }),
  }),
  async (req, res) => res.status(req.body.id ? 200 : 201).json({ topic: await svc.saveTopic(req.user, req.body) }),
);

skillsRouter.post(
  '/topics/import',
  requirePermission('skills', 'manage'),
  validate({
    body: z.object({
      domainId: uuid,
      subCategoryId: uuid.nullish(),
      names: z.array(z.string().max(200)).min(1).max(300),
    }),
  }),
  async (req, res) => res.json(await svc.importTopics(req.user, req.body)),
);

skillsRouter.delete(
  '/topics/:id',
  requirePermission('skills', 'manage'),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.deleteTopic(req.user, req.params.id)),
);

/* ── משתמשי קצה ── */
skillsRouter.get(
  '/end-users',
  requirePermission('skills', 'view', querySite),
  validate({ query: z.object({ siteId: uuid, domainId: uuid.optional() }) }),
  async (req, res) => res.json({ endUsers: await svc.listEndUsers(req.validQuery) }),
);

skillsRouter.post(
  '/end-users',
  requirePermission('skills', 'manage', bodySite),
  validate({
    body: z.object({
      siteId: uuid,
      id: uuid.optional(),
      fullName: z.string().trim().min(1, 'חסר שם').max(200),
      employeeNo: z.string().trim().max(40).nullish(),
      department: z.string().trim().max(120).nullish(),
      roleTitle: z.string().trim().max(120).nullish(),
      domainId: uuid.nullish(),
      subCategoryId: uuid.nullish(),
      isActive: z.boolean().optional(),
    }),
  }),
  async (req, res) =>
    res.status(req.body.id ? 200 : 201).json({ endUser: await svc.saveEndUser(req.user, req.body.siteId, req.body) }),
);

skillsRouter.delete(
  '/end-users/:id',
  requirePermission('skills', 'manage', endUserScope),
  validate({ params: idParam }),
  async (req, res) => res.json(await svc.deleteEndUser(req.user, req.params.id)),
);

skillsRouter.post(
  '/end-users/import',
  requirePermission('skills', 'manage', bodySite),
  validate({
    body: z.object({
      siteId: uuid,
      dryRun: z.boolean().default(true),
      rows: z
        .array(
          z.object({
            fullName: z.string().max(200).nullish(),
            employeeNo: z.string().max(40).nullish(),
            department: z.string().max(120).nullish(),
            roleTitle: z.string().max(120).nullish(),
            domainName: z.string().max(120).nullish(),
            subCategoryName: z.string().max(120).nullish(),
          }),
        )
        .min(1)
        .max(2000),
    }),
  }),
  async (req, res) =>
    res.json(await svc.importEndUsers(req.user, req.body.siteId, req.body.rows, { dryRun: req.body.dryRun })),
);

/* ── סבבים ── */
skillsRouter.get(
  '/rounds',
  requirePermission('skills', 'view', querySite),
  validate({ query: z.object({ siteId: uuid }) }),
  async (req, res) => res.json({ rounds: await svc.listRounds(req.validQuery) }),
);

skillsRouter.post(
  '/rounds',
  requirePermission('skills', 'manage', bodySite),
  validate({
    body: z.object({
      id: uuid.optional(),
      siteId: uuid,
      name: z.string().trim().min(1, 'חסר שם לסבב').max(120),
      opensOn: dateStr.nullish(),
      closesOn: dateStr.nullish(),
      status: z.enum(['draft', 'open', 'closed']).optional(),
      topicIds: z.array(uuid).max(500).optional(),
    }),
  }),
  async (req, res) => res.status(req.body.id ? 200 : 201).json({ round: await svc.saveRound(req.user, req.body) }),
);

skillsRouter.post(
  '/rounds/:id/duplicate',
  requirePermission('skills', 'manage', roundScope),
  validate({ params: idParam, body: z.object({ name: z.string().trim().max(120).nullish() }) }),
  async (req, res) => res.status(201).json({ round: await svc.duplicateRound(req.user, req.params.id, req.body) }),
);

skillsRouter.get(
  '/rounds/:id/sheet',
  requirePermission('skills', 'view', roundScope),
  validate({ params: idParam, query: z.object({ domainId: uuid.optional() }) }),
  async (req, res) => res.json(await svc.sheet(req.user, req.params.id, req.validQuery)),
);

skillsRouter.put(
  '/rounds/:id/scores',
  requirePermission('skills', 'edit', roundScope),
  validate({
    params: idParam,
    body: z.object({
      scores: z
        .array(z.object({ endUserId: uuid, topicId: uuid, score: z.number().int().min(1, 'ציון בין 1 ל-4').max(4, 'ציון בין 1 ל-4').nullable() }))
        .min(1)
        .max(500),
    }),
  }),
  async (req, res) => res.json(await svc.saveScores(req.user, req.params.id, req.body.scores)),
);

skillsRouter.put(
  '/rounds/:id/notes/:endUserId',
  requirePermission('skills', 'edit', roundScope),
  validate({
    params: z.object({ id: uuid, endUserId: uuid }),
    body: z.object({ note: z.string().max(2000).nullish() }),
  }),
  async (req, res) => res.json(await svc.saveNote(req.user, req.params.id, req.params.endUserId, req.body.note)),
);

skillsRouter.get(
  '/rounds/:id/export.xlsx',
  requirePermission('skills', 'export', roundScope),
  validate({ params: idParam, query: z.object({ domainId: uuid.optional() }) }),
  async (req, res) => {
    const { buffer, filename } = await svc.exportWorkbook(req.params.id, req.validQuery);
    await recordExport(req, { entityType: 'skill_rounds', filters: { roundId: req.params.id, ...req.validQuery }, rowCount: null });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="skillometer.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(Buffer.from(buffer));
  },
);

/* ── התקדמות לאורך הסבבים ── */
const progressQuery = z.object({ siteId: uuid, domainId: uuid.optional() });

skillsRouter.get(
  '/progress',
  requirePermission('skills', 'view', querySite),
  validate({ query: progressQuery }),
  async (req, res) => res.json(await svc.progress(req.user, req.validQuery)),
);

skillsRouter.get(
  '/progress.xlsx',
  requirePermission('skills', 'export', querySite),
  validate({ query: progressQuery }),
  async (req, res) => {
    const { buffer, filename } = await svc.exportProgress(req.user, req.validQuery);
    await recordExport(req, { entityType: 'skill_rounds', filters: req.validQuery, rowCount: null });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="skillometer-progress.xlsx"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
    res.send(Buffer.from(buffer));
  },
);

/* ── לדשבורד ── */
skillsRouter.get(
  '/summary',
  requirePermission('skills', 'view', querySite),
  validate({ query: z.object({ siteId: uuid, roundId: uuid.optional() }) }),
  async (req, res) => res.json(await svc.summary(req.validQuery)),
);
