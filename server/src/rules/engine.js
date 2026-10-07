import { conditionRegistry } from './registry.js';
import { loadFacts, factsNeededFor } from './facts.js';
import { logger } from '../lib/logger.js';
import { DEFAULT_TIMEZONE } from '../lib/time.js';

/**
 * מנוע החוקיות.
 *
 * evaluate() הוא קריאה בלבד ואינו כותב דבר: הוא משמש גם את מסכי
 * "בדיקה לפני שליחה" וגם את הסימולטור. השמירה של ההערכה, יצירת החריגות
 * וביצוע הפעולה נעשים ב-exceptions.js, כדי שהמנוע יישאר בר-בדיקה.
 */

const SEVERITY_RANK = { warning: 1, approval_required: 2, blocking: 3 };
const SCOPE_SPECIFICITY = { global: 0, site: 1, domain: 2, sub_category: 3, user: 4 };

/**
 * @typedef {object} EvalContext
 * @property {string} trigger        submit | assign | change | publish
 * @property {string} subjectType    constraint | availability | activity | roster | mentor_assignment
 * @property {string} [subjectId]
 * @property {string} [targetUserId] מי נושא הבדיקה
 * @property {string} [siteId]
 * @property {string} [domainId]
 * @property {string[]} [subCategoryIds]
 * @property {Date}   [startsAt]
 * @property {Date}   [endsAt]
 * @property {string} [weekStart]
 * @property {string} [mentorUserId]
 * @property {string} [excludeId]        רשומה להתעלם ממנה (עריכה של עצמה)
 * @property {string} [rosterVersionId]
 * @property {string} [timeZone]
 */

/** שולף את החוקים שחלים על ההקשר, מהספציפי לכללי */
export async function selectRules(tx, ctx) {
  return tx.query(
    `select r.id, r.name, r.trigger::text, r.applies_to, r.scope_type::text, r.scope_id,
            r.condition_type_code, r.condition_params, r.severity::text,
            r.approver_role::text, r.approver_user_id, r.priority, r.message_he,
            r.valid_from, r.valid_to
       from rules r
      where r.is_active
        and r.deleted_at is null
        and r.trigger = $1::rule_trigger
        and (r.applies_to = 'any' or r.applies_to = $2)
        and r.valid_from <= now()
        and (r.valid_to is null or r.valid_to > now())
        and (
             r.scope_type = 'global'
          or (r.scope_type = 'site'         and r.scope_id = $3::uuid)
          or (r.scope_type = 'domain'       and r.scope_id = $4::uuid)
          or (r.scope_type = 'sub_category' and r.scope_id = any($5::uuid[]))
          or (r.scope_type = 'user'         and r.scope_id = $6::uuid)
        )
      order by r.priority asc, r.name asc`,
    [
      ctx.trigger,
      ctx.subjectType ?? 'any',
      ctx.siteId ?? null,
      ctx.domainId ?? null,
      ctx.subCategoryIds ?? [],
      ctx.targetUserId ?? null,
    ],
  );
}

/**
 * מעריך את כל החוקים הרלוונטיים. אינו כותב דבר.
 *
 * @returns {Promise<{ outcome, results, failed, blocking, needsApproval, warnings, rules }>}
 */
export async function evaluate(tx, ctx) {
  const rules = await selectRules(tx, ctx);

  if (rules.length === 0) {
    return { outcome: 'pass', results: [], failed: [], blocking: [], needsApproval: [], warnings: [], rules };
  }

  const timeZone = ctx.timeZone ?? DEFAULT_TIMEZONE;
  const enriched = { ...ctx, timeZone };

  const needed = factsNeededFor(rules.map((r) => r.condition_type_code));
  const facts = await loadFacts(tx, enriched, needed);

  const results = rules.map((rule) => {
    const handler = conditionRegistry.get(rule.condition_type_code);

    if (!handler) {
      // סוג תנאי שקיים בדאטה אך לא בקוד. נכשל בבטחה: מדווח ואינו חוסם.
      logger.error('סוג תנאי לא מוכר', { code: rule.condition_type_code, ruleId: rule.id });
      return { ruleId: rule.id, name: rule.name, severity: rule.severity, passed: true, skipped: true };
    }

    let outcome;
    try {
      outcome = handler.evaluate(enriched, rule.condition_params ?? {}, facts);
    } catch (err) {
      logger.error('הערכת חוק נכשלה', { ruleId: rule.id, code: rule.condition_type_code, message: err.message });
      return { ruleId: rule.id, name: rule.name, severity: rule.severity, passed: true, skipped: true };
    }

    return {
      ruleId: rule.id,
      name: rule.name,
      conditionCode: rule.condition_type_code,
      severity: rule.severity,
      scopeType: rule.scope_type,
      passed: outcome.passed !== false,
      // ההודעה שהמנהל ניסח, ואחריה הפירוט הקונקרטי שהמנוע חישב
      message: outcome.passed === false
        ? [rule.message_he, outcome.detail].filter(Boolean).join(' — ')
        : null,
      detail: outcome.detail ?? null,
      facts: outcome.facts ?? null,
      approverRole: rule.approver_role,
      approverUserId: rule.approver_user_id,
    };
  });

  const failed = results.filter((r) => !r.passed);
  const blocking = failed.filter((r) => r.severity === 'blocking');
  const needsApproval = failed.filter((r) => r.severity === 'approval_required');
  const warnings = failed.filter((r) => r.severity === 'warning');

  const outcome = blocking.length
    ? 'blocked'
    : needsApproval.length
      ? 'approval_required'
      : warnings.length
        ? 'warning'
        : 'pass';

  return { outcome, results, failed, blocking, needsApproval, warnings, rules };
}

/** מעריך רק חוקים חוסמים — לבדיקה חוזרת לפני שחזור פעולה שאושרה */
export async function evaluateBlockingOnly(tx, ctx) {
  const full = await evaluate(tx, ctx);
  return {
    blocked: full.blocking.length > 0,
    blocking: full.blocking,
    message: full.blocking[0]?.message ?? null,
  };
}

/** צילום החוקים כפי שהיו ברגע הבדיקה (§12) */
export function snapshotRules(rules, outcome) {
  // ב-pass נשמרים מזהים בלבד. שמירת JSON מלא בכל הערכה מוצלחת הייתה
  // בולעת את מכסת ה-500MB של Supabase בחבילה החינמית.
  if (outcome === 'pass') {
    return rules.map((r) => ({ id: r.id, name: r.name, priority: r.priority }));
  }
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    scope_type: r.scope_type,
    scope_id: r.scope_id,
    trigger: r.trigger,
    applies_to: r.applies_to,
    condition_type_code: r.condition_type_code,
    condition_params: r.condition_params,
    severity: r.severity,
    approver_role: r.approver_role,
    approver_user_id: r.approver_user_id,
    priority: r.priority,
    message_he: r.message_he,
  }));
}

export { SEVERITY_RANK, SCOPE_SPECIFICITY };
