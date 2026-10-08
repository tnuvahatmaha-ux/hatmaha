import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { setETag } from '../lib/etag.js';
import { uuid, idParam } from '../schemas/common.schema.js';
import * as schema from '../schemas/sites.schema.js';
import * as svc from '../services/sites.service.js';
import { decide } from '../permissions/engine.js';
import { AppError } from '../lib/errors.js';

export const sitesRouter = Router();
sitesRouter.use(requireAuth);

/** ה-Scope של הנתיב נגזר מהאתר שבכתובת */
const siteScope = (req) => ({ siteId: req.params.siteId ?? req.params.id });

sitesRouter.get(
  '/',
  requirePermission('sites', 'view'),
  validate({ query: z.object({ includeArchived: z.coerce.boolean().default(false) }) }),
  async (req, res) => {
    // הרשימה מסוננת ל-Scope של המשתמש בתוך השירות עצמו (AC-13)
    res.json({ sites: await svc.list(req.user, req.validQuery) });
  },
);

sitesRouter.get(
  '/:id',
  requirePermission('sites', 'view', siteScope),
  validate({ params: idParam }),
  async (req, res) => {
    const result = await svc.get(req.params.id);
    setETag(res, result.site);
    res.json(result);
  },
);

sitesRouter.post(
  '/',
  requirePermission('sites', 'create'),
  validate({ body: schema.siteBody }),
  async (req, res) => {
    const site = await svc.create(req.user, req.body);
    setETag(res, site);
    res.status(201).json({ site });
  },
);

sitesRouter.patch(
  '/:id',
  requirePermission('sites', 'edit', siteScope),
  validate({ params: idParam, body: schema.siteUpdateBody }),
  async (req, res) => {
    const site = await svc.update(req.user, req.params.id, req.body, req);
    setETag(res, site);
    res.json({ site });
  },
);

sitesRouter.post(
  '/:id/archive',
  requirePermission('sites', 'delete', siteScope),
  validate({ params: idParam, body: z.object({ archived: z.boolean().default(true) }) }),
  async (req, res) => res.json({ site: await svc.archive(req.user, req.params.id, req.body.archived) }),
);

/* ── משמרות — שייכות למיקום, לכל מיקום השעות שלו ── */
const locationParams = z.object({ siteId: uuid, locationId: uuid });

sitesRouter.post(
  '/:siteId/locations/:locationId/shift-types',
  requirePermission('sites', 'edit', siteScope),
  validate({ params: locationParams, body: schema.shiftTypeRefined }),
  async (req, res) => {
    const shiftType = await svc.saveShiftType(
      req.user, req.params.siteId, req.params.locationId, req.body, req,
    );
    setETag(res, shiftType);
    res.status(req.body.id ? 200 : 201).json({ shiftType });
  },
);

sitesRouter.delete(
  '/:siteId/locations/:locationId/shift-types/:id',
  requirePermission('sites', 'edit', siteScope),
  validate({ params: locationParams.extend({ id: uuid }) }),
  async (req, res) =>
    res.json(await svc.deleteShiftType(req.user, req.params.siteId, req.params.locationId, req.params.id)),
);

/** מוסיף למיקום את תבניות המשמרת של סוג המיקום. בטוח להרצה חוזרת. */
sitesRouter.post(
  '/:siteId/locations/:locationId/shift-types/from-template',
  requirePermission('sites', 'edit', siteScope),
  validate({
    params: locationParams,
    body: z.object({ period: z.enum(['training', 'golive', 'support']).optional() }).default({}),
  }),
  async (req, res) =>
    res.json(
      await svc.copyShiftsFromTemplate(req.user, req.params.siteId, req.params.locationId, req.body?.period),
    ),
);

/** העתקת שעות משמרת מתחום לתחום — באותו אתר או לאתר אחר */
sitesRouter.post(
  '/:siteId/shift-types/copy-domain',
  requirePermission('sites', 'edit', siteScope),
  validate({ params: z.object({ siteId: uuid }), body: schema.copyDomainBody }),
  async (req, res) => {
    const target = req.body.targetSiteId;
    if (target && target !== req.params.siteId
        && !decide(req.user, 'sites', 'edit', { siteId: target }).allowed) {
      throw new AppError('E_FORBIDDEN', 'אין לך הרשאה לערוך את אתר היעד');
    }
    res.json(await svc.copyDomainShifts(req.user, req.params.siteId, req.body));
  },
);

/* ── מיקומים ── */
sitesRouter.post(
  '/:siteId/locations',
  requirePermission('sites', 'edit', siteScope),
  validate({ params: z.object({ siteId: uuid }), body: schema.locationBody }),
  async (req, res) => {
    const location = await svc.saveLocation(req.user, req.params.siteId, req.body, req);
    setETag(res, location);
    res.status(req.body.id ? 200 : 201).json({ location });
  },
);

/* ── תקופות ── */
sitesRouter.put(
  '/:siteId/periods',
  requirePermission('sites', 'edit', siteScope),
  validate({ params: z.object({ siteId: uuid }), body: schema.periodsBody }),
  async (req, res) => res.json({ periods: await svc.replacePeriods(req.user, req.params.siteId, req.body.periods) }),
);
