import { query } from '../lib/db.js';
import { logger } from '../lib/logger.js';

/**
 * רישום ל-Audit Log.
 *
 * רוב הרישום קורה אוטומטית בטריגר app.tg_audit על כל טבלה ניהולית, ולכן
 * המודול הזה נועד לאירועים שאין להם שורה בטבלה: סירוב הרשאה, ייצוא,
 * חסימה ע״י חוק, והחלטות שנרשמות עם נימוק.
 */

/** רישום כללי. נכשל בשקט — כישלון תיעוד לא אמור להפיל בקשה של משתמש. */
export async function record({
  actorId,
  actorRole,
  entityType,
  entityId = null,
  action,
  before = null,
  after = null,
  reason = null,
  traceId = null,
  ip = null,
  userAgent = null,
}) {
  try {
    await query(
      `insert into audit_log
         (actor_user_id, actor_role, entity_type, entity_id, action,
          before_data, after_data, reason, trace_id, ip_address, user_agent)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        actorId ?? null,
        actorRole ?? null,
        entityType,
        entityId,
        action,
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        reason,
        traceId,
        ip,
        userAgent,
      ],
    );
  } catch (err) {
    logger.error('רישום Audit נכשל', { message: err.message, entityType, action });
  }
}

/** גרסה שמשתמשת בבקשה כדי למלא את שדות ההקשר */
export function recordFromRequest(req, fields) {
  return record({
    actorId: req.user?.userId,
    actorRole: req.user?.baseRole,
    traceId: req.traceId,
    ip: req.ip,
    userAgent: req.get('user-agent')?.slice(0, 200),
    ...fields,
  });
}

/**
 * סירוב הרשאה. §16 דורש כיסוי בדיקות ל"גישה ישירה ל-API" ול-IDOR —
 * בלי התיעוד הזה אי אפשר לזהות ניסיון כזה בדיעבד.
 */
export function recordDenial(req, { resource, action, ctx, reason }) {
  return recordFromRequest(req, {
    entityType: 'permission_check',
    action: 'denied',
    reason,
    after: { resource, action, ctx, path: req.originalUrl, method: req.method },
  });
}

/** ייצוא נתונים — כל ייצוא נרשם (§16) */
export function recordExport(req, { entityType, filters, rowCount }) {
  return recordFromRequest(req, {
    entityType,
    action: 'export',
    after: { filters, rowCount },
  });
}
