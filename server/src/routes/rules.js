import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { setETag } from '../lib/etag.js';
import { withTransaction, query } from '../lib/db.js';
import { evaluate } from '../rules/engine.js';
import { conditionCodes } from '../rules/registry.js';
import { toInstants } from '../lib/time.js';
import { AppError } from '../lib/errors.js';
import { uuid, dateStr, timeStr, name, idParam } from '../schemas/common.schema.js';

export const rulesRouter = Router();
rulesRouter.use(requireAuth);

/** סוגי התנאים + סכמת הפרמטרים שלהם — ה-UI בונה מהם את הטופס */
rulesRouter.get(
  '/condition-types',
  requirePermission('rules', 'view'),
  async (_req, res) => {
    const rows = await query(
      `select code, name_he, description_he, params_schema,
              allowed_triggers::text[] as allowed_triggers,
              allowed_scopes::text[] as allowed_scopes, display_order
         from rule_condition_types where is_active order by display_order`,
    );
    // סוג שקיים בדאטה אך לא במרשם הקוד לא יוצג — אחרת אפשר היה להגדיר
    // חוק שלעולם לא ייבדק
    res.json({ conditionTypes: rows.filter((r) => conditionCodes.includes(r.code)) });
  },
);

rulesRouter.get(
  '/',
  requirePermission('rules', 'view'),
  validate({
    query: z.object({
      scopeType: z.enum(['global', 'site', 'domain', 'sub_category', 'user']).optional(),
      scopeId: uuid.optional(),
      trigger: z.enum(['submit', 'assign', 'change', 'publish']).optional(),
      isActive: z.coerce.boolean().optional(),
    }),
  }),
  async (req, res) => {
    const { scopeType, scopeId, trigger, isActive } = req.validQuery;
    const rules = await query(
      `select r.id, r.name, r.description, r.scope_type::text as scope_type, r.scope_id,
              r.trigger::text as trigger, r.applies_to, r.condition_type_code,
              r.condition_params, r.severity::text as severity,
              r.approver_role::text as approver_role, r.approver_user_id,
              r.priority, r.valid_from, r.valid_to, r.message_he, r.is_active, r.row_version,
              ct.name_he as condition_name,
              coalesce(s.name, d.name, sc.name, p.full_name) as scope_name
         from rules r
         join rule_condition_types ct on ct.code = r.condition_type_code
         left join sites s on s.id = r.scope_id and r.scope_type = 'site'
         left join domains d on d.id = r.scope_id and r.scope_type = 'domain'
         left join sub_categories sc on sc.id = r.scope_id and r.scope_type = 'sub_category'
         left join profiles p on p.id = r.scope_id and r.scope_type = 'user'
        where r.deleted_at is null
          and ($1::text is null or r.scope_type::text = $1)
          and ($2::uuid is null or r.scope_id = $2)
          and ($3::text is null or r.trigger::text = $3)
          and ($4::boolean is null or r.is_active = $4)
        order by r.priority, r.name`,
      [scopeType ?? null, scopeId ?? null, trigger ?? null, isActive ?? null],
    );
    res.json({ rules });
  },
);

const ruleBody = z
  .object({
    name,
    description: z.string().trim().max(2000).nullish(),
    scopeType: z.enum(['global', 'site', 'domain', 'sub_category', 'user']).default('global'),
    scopeId: uuid.nullish(),
    trigger: z.enum(['submit', 'assign', 'change', 'publish']),
    appliesTo: z
      .enum(['any', 'constraint', 'availability', 'activity', 'roster', 'mentor_assignment'])
      .default('any'),
    conditionTypeCode: z.enum(conditionCodes),
    conditionParams: z.record(z.string(), z.unknown()).default({}),
    severity: z.enum(['warning', 'approval_required', 'blocking']),
    approverRole: z.enum(['manager', 'mentor', 'lead', 'implementer']).nullish(),
    approverUserId: uuid.nullish(),
    priority: z.coerce.number().int().min(0).max(9999).default(100),
    validFrom: z.string().datetime().optional(),
    validTo: z.string().datetime().nullish(),
    messageHe: z.string().trim().min(3, 'יש לנסח הודעה שתוצג למשתמש').max(500),
    isActive: z.boolean().default(true),
  })
  .refine((v) => v.scopeType === 'global' || !!v.scopeId, {
    message: 'רמת החוק שנבחרה מחייבת בחירת ישות',
    path: ['scopeId'],
  })
  .refine((v) => v.severity !== 'approval_required' || v.approverRole || v.approverUserId, {
    message: 'חוק שדורש אישור חייב מאשר מוגדר',
    path: ['approverRole'],
  });

const saveRule = async (req, res) => {
  const b = req.body;
  const row = await withTransaction({ actorId: req.user.userId }, async (tx) => {
    // הפרמטרים נבדקים מול הסכמה שמוגדרת לסוג התנאי
    const ct = await tx.required(
      'select params_schema, allowed_triggers::text[] as triggers from rule_condition_types where code = $1',
      [b.conditionTypeCode],
      'סוג התנאי אינו מוכר',
    );
    if (!ct.triggers.includes(b.trigger)) {
      throw new AppError('E_VALIDATION', `סוג התנאי אינו נתמך עבור אירוע ${b.trigger}`);
    }
    for (const key of ct.params_schema?.required ?? []) {
      if (b.conditionParams[key] === undefined || b.conditionParams[key] === null) {
        throw new AppError('E_VALIDATION', `חסר פרמטר חובה לתנאי: ${key}`, {
          details: { fields: [{ field: `conditionParams.${key}`, message: 'שדה חובה' }] },
        });
      }
    }

    const values = [
      b.name, b.description ?? null, b.scopeType, b.scopeId ?? null, b.trigger, b.appliesTo,
      b.conditionTypeCode, JSON.stringify(b.conditionParams), b.severity,
      b.approverRole ?? null, b.approverUserId ?? null, b.priority,
      b.validFrom ?? null, b.validTo ?? null, b.messageHe, b.isActive,
    ];

    if (req.params.id) {
      const current = await tx.lock('rules', req.params.id);
      if (!current || current.deleted_at) throw new AppError('E_NOT_FOUND', 'החוק המבוקש לא נמצא');
      const { assertIfMatch } = await import('../lib/etag.js');
      assertIfMatch(req, current);

      const [updated] = await tx.query(
        `update rules set name=$1, description=$2, scope_type=$3::rule_scope_type, scope_id=$4,
                          trigger=$5::rule_trigger, applies_to=$6, condition_type_code=$7,
                          condition_params=$8::jsonb, severity=$9::rule_severity,
                          approver_role=$10::base_role, approver_user_id=$11, priority=$12,
                          valid_from=coalesce($13::timestamptz, valid_from), valid_to=$14,
                          message_he=$15, is_active=$16
          where id=$17 returning *`,
        [...values, req.params.id],
      );
      return updated;
    }

    const [created] = await tx.query(
      `insert into rules (name, description, scope_type, scope_id, trigger, applies_to,
                          condition_type_code, condition_params, severity, approver_role,
                          approver_user_id, priority, valid_from, valid_to, message_he, is_active)
       values ($1,$2,$3::rule_scope_type,$4,$5::rule_trigger,$6,$7,$8::jsonb,$9::rule_severity,
               $10::base_role,$11,$12,coalesce($13::timestamptz, now()),$14,$15,$16)
       returning *`,
      values,
    );
    return created;
  });

  setETag(res, row);
  res.status(req.params.id ? 200 : 201).json({ rule: row });
};

rulesRouter.post('/', requirePermission('rules', 'create'), validate({ body: ruleBody }), saveRule);
rulesRouter.patch(
  '/:id',
  requirePermission('rules', 'edit'),
  validate({ params: idParam, body: ruleBody }),
  saveRule,
);

rulesRouter.post(
  '/:id/toggle',
  requirePermission('rules', 'edit'),
  validate({ params: idParam, body: z.object({ isActive: z.boolean() }) }),
  async (req, res) => {
    const [rule] = await query(
      'update rules set is_active = $2 where id = $1 and deleted_at is null returning *',
      [req.params.id, req.body.isActive],
    );
    if (!rule) throw new AppError('E_NOT_FOUND', 'החוק המבוקש לא נמצא');
    res.json({ rule });
  },
);

rulesRouter.delete(
  '/:id',
  requirePermission('rules', 'delete'),
  validate({ params: idParam }),
  async (req, res) => {
    // מחיקה לוגית: הערכות ישנות מפנות לחוק, וההיסטוריה חייבת להישאר מוסברת
    const [rule] = await query(
      `update rules set deleted_at = now(), deleted_by = $2, is_active = false
        where id = $1 and deleted_at is null returning id`,
      [req.params.id, req.user.userId],
    );
    if (!rule) throw new AppError('E_NOT_FOUND', 'החוק המבוקש לא נמצא');
    res.json({ removed: rule.id });
  },
);

/**
 * סימולטור — "מה היה קורה אם".
 * אינו שומר הערכה ואינו יוצר חריגה, ולכן מנהל יכול לבדוק חוק חדש
 * על תרחיש אמיתי לפני שהוא מפעיל אותו.
 */
rulesRouter.post(
  '/simulate',
  requirePermission('rules', 'view'),
  validate({
    body: z.object({
      trigger: z.enum(['submit', 'assign', 'change', 'publish']),
      subjectType: z
        .enum(['any', 'constraint', 'availability', 'activity', 'roster', 'mentor_assignment'])
        .default('any'),
      userId: uuid.nullish(),
      siteId: uuid.nullish(),
      date: dateStr.nullish(),
      startTime: timeStr.nullish(),
      endTime: timeStr.nullish(),
      shiftTypeId: uuid.nullish(),
      weekStart: dateStr.nullish(),
    }),
  }),
  async (req, res) => {
    const b = req.body;

    const result = await withTransaction({ actorId: req.user.userId }, async (tx) => {
      const [site] = b.siteId
        ? await tx.query('select timezone from sites where id = $1', [b.siteId])
        : [];

      const range =
        b.date && b.startTime && b.endTime
          ? toInstants(b.date, b.startTime, b.endTime, site?.timezone)
          : {};

      const [user] = b.userId
        ? await tx.query(
            `select array(select domain_id from user_domains
                           where user_id = $1 and deleted_at is null) as domain_ids,
                    array(select sub_category_id from user_sub_categories
                           where user_id = $1 and deleted_at is null) as sub_ids`,
            [b.userId],
          )
        : [];

      return evaluate(tx, {
        trigger: b.trigger,
        subjectType: b.subjectType,
        targetUserId: b.userId ?? null,
        siteId: b.siteId ?? null,
        domainId: user?.domain_ids?.[0] ?? null,
        subCategoryIds: user?.sub_ids ?? [],
        startsAt: range.startsAt,
        endsAt: range.endsAt,
        localDate: b.date ?? undefined,
        shiftTypeId: b.shiftTypeId ?? null,
        weekStart: b.weekStart ?? null,
        timeZone: site?.timezone,
      });
    });

    res.json({
      outcome: result.outcome,
      evaluated: result.rules.length,
      findings: result.results.map((r) => ({
        ruleId: r.ruleId,
        ruleName: r.name,
        severity: r.severity,
        passed: r.passed,
        message: r.message,
        detail: r.detail,
      })),
    });
  },
);

rulesRouter.get(
  '/evaluations/:id',
  requirePermission('rules', 'view'),
  validate({ params: idParam }),
  async (req, res) => {
    const [row] = await query(
      `select id, trigger::text as trigger, subject_type, subject_id, outcome::text as outcome,
              context, rules_snapshot, results, created_at
         from rule_evaluations where id = $1`,
      [req.params.id],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'ההערכה המבוקשת לא נמצאה');
    res.json({ evaluation: row });
  },
);
