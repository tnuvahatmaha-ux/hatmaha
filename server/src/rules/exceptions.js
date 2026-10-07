import { evaluate, evaluateBlockingOnly, snapshotRules } from './engine.js';
import { routeApprover } from './approvalRouting.js';
import { runAction } from './actions.js';
import { notify } from '../notifications/service.js';
import { record } from '../audit/service.js';
import { AppError } from '../lib/errors.js';
import { queryOne } from '../lib/db.js';

/**
 * המסלול המלא: הערכה → שמירת הערכה עם Snapshot → חריגה → אישור → ביצוע.
 *
 * זהו המקום היחיד שכותב הערכות וחריגות, ולכן אי אפשר לעקוף את המסלול
 * מ-service אחר.
 */

/** שומר RuleEvaluation. תמיד — גם כשהתוצאה תקינה (§10 שלב 18). */
async function persistEvaluation(tx, ctx, result, meta) {
  const [row] = await tx.query(
    `insert into rule_evaluations
       (trigger, subject_type, subject_id, actor_user_id, target_user_id,
        site_id, domain_id, context, rules_snapshot, results, outcome, trace_id)
     values ($1::rule_trigger, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::rule_outcome, $12)
     returning id`,
    [
      ctx.trigger,
      ctx.subjectType ?? 'any',
      ctx.subjectId ?? null,
      meta.actorId ?? null,
      ctx.targetUserId ?? null,
      ctx.siteId ?? null,
      ctx.domainId ?? null,
      JSON.stringify(serializeContext(ctx)),
      JSON.stringify(snapshotRules(result.rules, result.outcome)),
      JSON.stringify(result.results),
      result.outcome,
      meta.traceId ?? null,
    ],
  );
  return row.id;
}

/** ההקשר נשמר כ-JSON; Date ו-Set אינם עוברים ישירות */
function serializeContext(ctx) {
  const out = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (v instanceof Date) out[k] = v.toISOString();
    else if (v instanceof Set) out[k] = [...v];
    else if (typeof v !== 'function') out[k] = v;
  }
  return out;
}

/**
 * מעריך, ואז מבצע או עוצר.
 *
 * @param {object} tx
 * @param {object} ctx      הקשר ההערכה
 * @param {object} opts
 * @param {object} opts.action    { type, payload } — מה לבצע אם מותר
 * @param {object} opts.meta      { actorId, traceId }
 * @param {string} opts.summary   תיאור קצר לתור האישורים
 * @returns {Promise<{status, evaluationId, data?, warnings?, exceptions?}>}
 */
export async function evaluateAndExecute(tx, ctx, { action, meta, summary }) {
  const result = await evaluate(tx, ctx);
  const evaluationId = await persistEvaluation(tx, ctx, result, meta);

  // ── חסום: הפעולה נעצרת, והסיבה מוצגת (AC-11) ──────────────────
  if (result.outcome === 'blocked') {
    await record({
      actorId: meta.actorId,
      entityType: ctx.subjectType,
      entityId: ctx.subjectId,
      action: 'rule_blocked',
      reason: result.blocking[0]?.message,
      after: { evaluationId, rules: result.blocking.map((b) => b.ruleId) },
      traceId: meta.traceId,
    });

    throw new AppError('E_RULE_BLOCKED', result.blocking[0].message, {
      details: {
        evaluationId,
        blocking: result.blocking.map((b) => ({ ruleId: b.ruleId, name: b.name, message: b.message })),
      },
    });
  }

  // ── דורש אישור: הפעולה *אינה* מבוצעת. היא חונה כדאטה (AC-10) ──
  if (result.outcome === 'approval_required') {
    const created = [];

    for (const hit of result.needsApproval) {
      const rule = result.rules.find((r) => r.id === hit.ruleId);
      const approver = await routeApprover(tx, rule, ctx);

      const [row] = await tx.query(
        `insert into exception_requests
           (rule_evaluation_id, rule_id, subject_type, subject_id, requested_by,
            target_user_id, site_id, domain_id, severity, summary, reason,
            pending_action, status, approver_user_id, approver_role, expires_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'approval_required', $9, $10,
                 $11, 'pending', $12, $13::base_role,
                 now() + ($14 || ' days')::interval)
         returning id, summary, approver_user_id`,
        [
          evaluationId,
          hit.ruleId,
          ctx.subjectType,
          ctx.subjectId ?? null,
          meta.actorId,
          ctx.targetUserId ?? null,
          ctx.siteId ?? null,
          ctx.domainId ?? null,
          summary ?? hit.message,
          hit.message,
          JSON.stringify(action ? { ...action, ctx: serializeContext(ctx) } : {}),
          approver.userId,
          approver.role,
          String(await exceptionTtlDays(tx)),
        ],
      );
      created.push({ ...row, ruleName: hit.name, message: hit.message });

      await notify(tx, {
        typeCode: 'exception_raised',
        recipientIds: [approver.userId],
        title: 'חריגה ממתינה לאישורך',
        body: hit.message,
        entityType: 'exception_requests',
        entityId: row.id,
        dedupeKey: `exception_raised:${row.id}:${approver.userId}`,
      });
    }

    await record({
      actorId: meta.actorId,
      entityType: ctx.subjectType,
      entityId: ctx.subjectId,
      action: 'exception_created',
      after: { evaluationId, exceptionIds: created.map((c) => c.id) },
      traceId: meta.traceId,
    });

    return {
      status: 'approval_required',
      evaluationId,
      exceptions: created,
      warnings: result.warnings,
    };
  }

  // ── תקין או אזהרה: מבצעים כאן ועכשיו, באותה טרנזקציה ──────────
  const data = action ? await runAction(tx, action, { ...meta, evaluationId }) : null;

  return {
    status: result.outcome === 'warning' ? 'warning' : 'ok',
    evaluationId,
    data,
    warnings: result.warnings,
  };
}

async function exceptionTtlDays(tx) {
  const [row] = await tx.query(`select value from app_settings where key = 'exception_ttl_days'`);
  return Number(row?.value ?? 14);
}

/**
 * הכרעה בחריגה.
 *
 * אידמפוטנטית: שידור חוזר מחזיר את התוצאה השמורה במקום לבצע שוב.
 * נימוק הוא חובה — נאכף גם כאן וגם ב-CHECK על הטבלה.
 */
export async function decideException(tx, { exceptionId, approverId, decision, comment, traceId }) {
  const ex = await tx.lock('exception_requests', exceptionId);
  if (!ex) throw new AppError('E_NOT_FOUND', 'החריגה המבוקשת לא נמצאה');

  // אידמפוטנטיות: אותה החלטה שוב מחזירה את מה שכבר נקבע
  if (ex.status !== 'pending') {
    return {
      status: ex.status,
      idempotentReplay: true,
      decidedAt: ex.decided_at,
      comment: ex.decision_comment,
      data: ex.applied_result,
    };
  }

  if (!comment || comment.trim().length < 3) {
    throw new AppError('E_VALIDATION', 'החלטה מחייבת נימוק');
  }

  // ── דחייה: הפעולה נעצרת ולא מבוצעת לעולם ──────────────────────
  if (decision === 'reject') {
    await tx.query(
      `update exception_requests
          set status = 'rejected', approver_user_id = $2,
              decided_at = now(), decision_comment = $3
        where id = $1`,
      [exceptionId, approverId, comment.trim()],
    );

    await notify(tx, {
      typeCode: 'exception_decided',
      recipientIds: [ex.requested_by, ex.target_user_id],
      title: 'הבקשה נדחתה',
      body: `${ex.summary} — ${comment.trim()}`,
      entityType: 'exception_requests',
      entityId: exceptionId,
    });

    await record({
      actorId: approverId,
      entityType: 'exception_requests',
      entityId: exceptionId,
      action: 'reject',
      reason: comment.trim(),
      traceId,
    });

    return { status: 'rejected', comment: comment.trim() };
  }

  // ── אישור: בדיקה חוזרת של חוקים חוסמים לפני השחזור ────────────
  //
  // חריגה יכולה לשבת בתור ימים. בינתיים המטמיע עשוי לצאת לחופשה מאושרת
  // או להישלח למשמרת אחרת. אישור לא אמור להחיות שיבוץ שכבר אינו חוקי.
  const pending = ex.pending_action ?? {};
  const replayCtx = deserializeContext(pending.ctx ?? {});

  if (replayCtx.trigger) {
    const recheck = await evaluateBlockingOnly(tx, { ...replayCtx, excludeId: ex.subject_id });
    if (recheck.blocked) {
      await tx.query(
        `update exception_requests
            set status = 'expired', approver_user_id = $2, decided_at = now(),
                decision_comment = $3, applied_result = $4
          where id = $1`,
        [
          exceptionId,
          approverId,
          comment.trim(),
          JSON.stringify({ reason: 'stale', message: recheck.message }),
        ],
      );

      await notify(tx, {
        typeCode: 'exception_stale',
        recipientIds: [ex.requested_by, approverId],
        title: 'החריגה אושרה אך אינה ישימה עוד',
        body: recheck.message,
        entityType: 'exception_requests',
        entityId: exceptionId,
      });

      throw new AppError('E_RULE_BLOCKED', `לא ניתן לבצע: ${recheck.message}`, {
        details: { reason: 'stale_exception' },
      });
    }
  }

  await tx.query(
    `update exception_requests
        set status = 'approved', approver_user_id = $2,
            decided_at = now(), decision_comment = $3
      where id = $1`,
    [exceptionId, approverId, comment.trim()],
  );

  let applied = null;
  if (pending.type) {
    applied = await runAction(tx, pending, { actorId: approverId, traceId, fromException: exceptionId });
    await tx.query(
      `update exception_requests set applied_at = now(), applied_result = $2 where id = $1`,
      [exceptionId, JSON.stringify(applied ?? {})],
    );
  }

  await notify(tx, {
    typeCode: 'exception_decided',
    recipientIds: [ex.requested_by, ex.target_user_id],
    title: 'הבקשה אושרה',
    body: `${ex.summary} — ${comment.trim()}`,
    entityType: 'exception_requests',
    entityId: exceptionId,
  });

  await record({
    actorId: approverId,
    entityType: 'exception_requests',
    entityId: exceptionId,
    action: 'approve',
    reason: comment.trim(),
    after: applied,
    traceId,
  });

  return { status: 'approved', comment: comment.trim(), data: applied };
}

function deserializeContext(raw) {
  const out = { ...raw };
  for (const key of ['startsAt', 'endsAt']) {
    if (typeof out[key] === 'string') out[key] = new Date(out[key]);
  }
  return out;
}

/** האם משתמש רשאי להכריע בחריגה מסוימת */
export async function canDecide(principal, exceptionRow) {
  if (!exceptionRow || exceptionRow.status !== 'pending') return false;
  // אדם אינו מאשר חריגה של עצמו, אלא אם הוא מנהל הטמעה
  if (exceptionRow.target_user_id === principal.userId && principal.baseRole !== 'manager') {
    return false;
  }
  if (exceptionRow.approver_user_id === principal.userId) return true;
  return principal.baseRole === 'manager';
}

export { evaluate };
