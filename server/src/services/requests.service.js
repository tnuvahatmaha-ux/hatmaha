import { query, withTransaction } from '../lib/db.js';
import { toInstants } from '../lib/time.js';
import { AppError } from '../lib/errors.js';
import { evaluate } from '../rules/engine.js';
import { evaluateAndExecute } from '../rules/exceptions.js';
import { registerAction } from '../rules/actions.js';
import { notify } from '../notifications/service.js';
import { assertIfMatch } from '../lib/etag.js';

/**
 * בקשות אילוץ — חופשה, אילוץ שעות, מחלה.
 *
 * המסלול: יצירה כטיוטה → בדיקה מקדימה (אופציונלית) → הגשה.
 * בהגשה רצים חוקי ה-trigger 'submit', ואז מדיניות האתר לסוג הבקשה קובעת
 * אם היא מאושרת אוטומטית או ממתינה להחלטת מנהל.
 */

const BASE_SELECT = `
  select cr.id, cr.user_id, cr.site_id, cr.constraint_type_id,
         cr.constraint_date, cr.start_time, cr.end_time, cr.starts_at, cr.ends_at,
         cr.note, cr.status::text as status, cr.submitted_at, cr.decided_at,
         cr.decision_note, cr.auto_approved, cr.approver_user_id, cr.row_version,
         cr.created_at, cr.rule_evaluation_id,
         ct.name_he as type_name, ct.code as type_code,
         p.full_name as user_name,
         approver.full_name as approver_name,
         s.name as site_name
    from constraint_requests cr
    join constraint_types ct on ct.id = cr.constraint_type_id
    join profiles p on p.id = cr.user_id
    left join profiles approver on approver.id = cr.approver_user_id
    left join sites s on s.id = cr.site_id
   where cr.deleted_at is null`;

/** רשימה, מסוננת ל-Scope האפקטיבי של הקורא (AC-13) */
export async function list(principal, filters = {}) {
  const isManager = principal.baseRole === 'manager';
  return query(
    `${BASE_SELECT}
       and ($1 or cr.user_id = $2 or cr.user_id = any($3::uuid[]) or cr.site_id = any($4::uuid[]))
       and ($5::text is null or cr.status::text = $5)
       and ($6::uuid is null or cr.user_id = $6)
       and ($7::uuid is null or cr.site_id = $7)
       and ($8::date is null or cr.constraint_date >= $8)
       and ($9::date is null or cr.constraint_date <= $9)
     order by cr.constraint_date desc, cr.created_at desc
     limit $10`,
    [
      isManager,
      principal.userId,
      principal.scopes.assignedUserIds,
      principal.scopes.siteIds,
      filters.status ?? null,
      filters.userId ?? null,
      filters.siteId ?? null,
      filters.from ?? null,
      filters.to ?? null,
      filters.limit ?? 100,
    ],
  );
}

export async function get(id) {
  const [row] = await query(`${BASE_SELECT} and cr.id = $1`, [id]);
  if (!row) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');
  return row;
}

/** אותה קריאה, אך בתוך טרנזקציה פתוחה */
async function getIn(tx, id) {
  const [row] = await tx.query(`${BASE_SELECT} and cr.id = $1`, [id]);
  if (!row) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');
  return row;
}

/** ההקשר שהחוקים נבדקים מולו */
async function buildContext(tx, row) {
  const [site] = row.site_id
    ? await tx.query('select timezone from sites where id = $1', [row.site_id])
    : [];
  const [user] = await tx.query(
    `select array(select domain_id from user_domains
                   where user_id = $1 and deleted_at is null) as domain_ids,
            array(select sub_category_id from user_sub_categories
                   where user_id = $1 and deleted_at is null) as sub_ids`,
    [row.user_id],
  );

  return {
    trigger: 'submit',
    subjectType: 'constraint',
    subjectId: row.id,
    targetUserId: row.user_id,
    siteId: row.site_id,
    domainId: user?.domain_ids?.[0] ?? null,
    subCategoryIds: user?.sub_ids ?? [],
    constraintTypeId: row.constraint_type_id,
    startsAt: new Date(row.starts_at),
    endsAt: new Date(row.ends_at),
    excludeId: row.id,
    timeZone: site?.timezone,
  };
}

/** האתר הרלוונטי למשתמש. אם יש כמה, נדרשת בחירה מפורשת. */
async function resolveSite(tx, userId, requestedSiteId) {
  const sites = await tx.query(
    `select site_id from site_assignments
      where user_id = $1 and deleted_at is null and span @> current_date`,
    [userId],
  );

  if (requestedSiteId) {
    if (sites.length && !sites.some((s) => s.site_id === requestedSiteId)) {
      throw new AppError('E_VALIDATION', 'המשתמש אינו משויך לאתר שנבחר');
    }
    return requestedSiteId;
  }
  if (sites.length === 1) return sites[0].site_id;
  if (sites.length === 0) return null;

  // ריבוי אתרים אינו נחתך בשקט ל-[0] כמו בפרוטוטייפ: מדיניות האישור
  // ומכסות הזמינות שונות בין אתרים, ולכן הבחירה חייבת להיות מפורשת.
  throw new AppError('E_VALIDATION', 'המשתמש משויך לכמה אתרים — יש לבחור אתר לבקשה');
}

export async function create(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const userId = input.userId ?? actor.userId;
    const siteId = await resolveSite(tx, userId, input.siteId);

    const [site] = siteId
      ? await tx.query('select timezone from sites where id = $1', [siteId])
      : [];
    const { startsAt, endsAt } = toInstants(
      input.constraintDate, input.startTime, input.endTime, site?.timezone,
    );

    const [row] = await tx.query(
      `insert into constraint_requests
         (user_id, site_id, constraint_type_id, constraint_date,
          start_time, end_time, starts_at, ends_at, note, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'draft')
       returning id`,
      [
        userId, siteId, input.constraintTypeId, input.constraintDate,
        input.startTime, input.endTime, startsAt, endsAt, input.note ?? null,
      ],
    );
    // נקרא בתוך אותה טרנזקציה: חיבור אחר לא יראה שורה שטרם נעשה לה commit
    return getIn(tx, row.id);
  });
}

/**
 * בדיקה מקדימה — §7: "לפני שליחה יוצג אם הבקשה תקינה, דורשת אישור או חסומה".
 * קוראת בלבד, אינה שומרת הערכה ואינה יוצרת חריגה.
 */
export async function preview(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const userId = input.userId ?? actor.userId;
    const siteId = await resolveSite(tx, userId, input.siteId);
    const [site] = siteId
      ? await tx.query('select timezone from sites where id = $1', [siteId])
      : [];
    const { startsAt, endsAt } = toInstants(
      input.constraintDate, input.startTime, input.endTime, site?.timezone,
    );

    const ctx = await buildContext(tx, {
      id: input.id ?? null,
      user_id: userId,
      site_id: siteId,
      constraint_type_id: input.constraintTypeId,
      starts_at: startsAt,
      ends_at: endsAt,
    });

    const result = await evaluate(tx, ctx);
    const policy = await approvalPolicy(tx, siteId, input.constraintTypeId);

    return {
      outcome: result.outcome,
      willBe:
        result.outcome === 'blocked' ? 'blocked'
        : result.outcome === 'approval_required' ? 'pending_exception'
        : policy === 'auto' ? 'approved'
        : 'pending_manager',
      approvalMode: policy,
      findings: result.failed.map((f) => ({
        ruleName: f.name, severity: f.severity, message: f.message,
      })),
    };
  });
}

/** כלל האישור של סוג האילוץ — גנרי, זהה בכל האתרים (הגדרות ← כללי אישור אילוצים) */
async function approvalPolicy(tx, _siteId, constraintTypeId) {
  const [row] = await tx.query(
    'select approval_mode::text as mode from constraint_types where id = $1',
    [constraintTypeId],
  );
  return row?.mode ?? 'manager';
}

/**
 * הגשה. כאן נפגשים מנוע החוקיות ומדיניות האתר.
 */
export async function submit(actor, requestId, meta) {
  return withTransaction({ actorId: actor.userId, traceId: meta?.traceId }, async (tx) => {
    const row = await tx.lock('constraint_requests', requestId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');

    // הגשה חוזרת של בקשה שכבר הוגשה היא no-op, לא שגיאה
    if (row.status !== 'draft') {
      return { request: await getIn(tx, requestId), status: 'already_submitted' };
    }

    const ctx = await buildContext(tx, row);
    const policy = await approvalPolicy(tx, row.site_id, row.constraint_type_id);

    const outcome = await evaluateAndExecute(tx, ctx, {
      meta: { actorId: actor.userId, traceId: meta?.traceId },
      summary: `בקשת ${await typeName(tx, row.constraint_type_id)} של ${await userName(tx, row.user_id)}`,
      action: {
        type: 'requests.finalize',
        payload: { requestId, policy },
      },
    });

    if (outcome.status === 'approval_required') {
      // הבקשה נשארת "הוגשה", והחריגה ממתינה. הפעולה שתקבע את הסטטוס
      // הסופי חונה ב-pending_action ותרוץ רק אחרי ההחלטה (AC-10).
      await tx.query(
        `update constraint_requests
            set status = 'submitted', submitted_at = now(), rule_evaluation_id = $2
          where id = $1`,
        [requestId, outcome.evaluationId],
      );
    }

    return {
      request: await getIn(tx, requestId),
      status: outcome.status,
      warnings: outcome.warnings,
      exceptions: outcome.exceptions,
    };
  });
}

/**
 * הפעולה שנקבעת אחרי שהחוקים עברו — או אחרי שחריגה אושרה.
 * רשומה במרשם, ולכן קיים נתיב ביצוע אחד לשני המקרים.
 */
registerAction('requests.finalize', async (tx, payload, meta) => {
  const { requestId, policy } = payload;
  const row = await tx.lock('constraint_requests', requestId);
  if (!row) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');

  const approved = policy === 'auto';

  const [updated] = await tx.query(
    `update constraint_requests
        set status = $2::request_status,
            submitted_at = coalesce(submitted_at, now()),
            decided_at = case when $2 = 'approved' then now() else decided_at end,
            auto_approved = $3,
            rule_evaluation_id = coalesce($4, rule_evaluation_id)
      where id = $1
      returning *`,
    [requestId, approved ? 'approved' : 'submitted', approved, meta?.evaluationId ?? null],
  );

  if (approved) {
    await notify(tx, {
      typeCode: 'request_decided',
      recipientIds: [row.user_id],
      title: 'הבקשה אושרה',
      body: 'הבקשה עומדת בכללי האתר ואושרה אוטומטית',
      entityType: 'constraint_requests',
      entityId: requestId,
    });
  } else {
    const approvers = await tx.query(
      `select id from profiles where base_role = 'manager' and status = 'active' and deleted_at is null`,
    );
    const mentor = await tx.query('select app.primary_mentor_of($1) as id', [row.user_id]);
    await notify(tx, {
      typeCode: 'request_submitted',
      recipientIds: [...approvers.map((a) => a.id), mentor[0]?.id],
      title: 'בקשה חדשה ממתינה לאישור',
      body: await summaryOf(tx, requestId),
      entityType: 'constraint_requests',
      entityId: requestId,
      dedupeKey: `request_submitted:${requestId}`,
    });
  }

  return { requestId, status: updated.status };
});

/** החלטת מנהל או מדריך על בקשה שהוגשה */
export async function decide(actor, requestId, { decision, comment, traceId }) {
  return withTransaction({ actorId: actor.userId, traceId }, async (tx) => {
    const row = await tx.lock('constraint_requests', requestId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');

    if (row.status !== 'submitted') {
      // אידמפוטנטי: החלטה חוזרת מחזירה את מה שכבר נקבע
      return { request: await getIn(tx, requestId), alreadyDecided: true };
    }
    if (!comment?.trim()) {
      throw new AppError('E_VALIDATION', 'החלטה מחייבת נימוק');
    }

    await tx.query(
      `update constraint_requests
          set status = $2::request_status, approver_user_id = $3,
              decided_at = now(), decision_note = $4
        where id = $1`,
      [requestId, decision === 'approve' ? 'approved' : 'rejected', actor.userId, comment.trim()],
    );

    await notify(tx, {
      typeCode: 'request_decided',
      recipientIds: [row.user_id],
      title: decision === 'approve' ? 'הבקשה אושרה' : 'הבקשה נדחתה',
      body: comment.trim(),
      entityType: 'constraint_requests',
      entityId: requestId,
    });

    return { request: await getIn(tx, requestId), alreadyDecided: false };
  });
}

/** ביטול בקשה על ידי מגישה */
export async function cancel(actor, requestId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const row = await tx.lock('constraint_requests', requestId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');
    if (row.status === 'cancelled') return { request: await getIn(tx, requestId), alreadyCancelled: true };

    if (new Date(row.starts_at) < new Date()) {
      throw new AppError('E_VALIDATION', 'לא ניתן לבטל בקשה שמועדה כבר חלף');
    }

    await tx.query(
      `update constraint_requests
          set status = 'cancelled', cancelled_at = now(), cancelled_by = $2
        where id = $1`,
      [requestId, actor.userId],
    );

    // חריגות פתוחות על בקשה שבוטלה אינן רלוונטיות עוד
    await tx.query(
      `update exception_requests
          set status = 'cancelled', decided_at = now(),
              decision_comment = 'הבקשה בוטלה על ידי המגיש'
        where subject_type = 'constraint' and subject_id = $1 and status = 'pending'`,
      [requestId],
    );

    return { request: await getIn(tx, requestId), alreadyCancelled: false };
  });
}

/** מעדכן חריגות שפג תוקפן — /internal/cron/expire-exceptions */
export async function expireExceptions() {
  const rows = await query(
    `update exception_requests
        set status = 'expired', decided_at = now(),
            decision_comment = 'פג תוקף ללא החלטה'
      where status = 'pending' and expires_at is not null and expires_at < now()
      returning id, requested_by`,
  );
  return rows.length;
}

const typeName = async (tx, id) =>
  (await tx.query('select name_he from constraint_types where id = $1', [id]))[0]?.name_he ?? 'אילוץ';
const userName = async (tx, id) =>
  (await tx.query('select full_name from profiles where id = $1', [id]))[0]?.full_name ?? '';
const summaryOf = async (tx, id) => {
  const [row] = await tx.query(
    `select p.full_name, ct.name_he, cr.constraint_date
       from constraint_requests cr
       join profiles p on p.id = cr.user_id
       join constraint_types ct on ct.id = cr.constraint_type_id
      where cr.id = $1`,
    [id],
  );
  return row ? `${row.full_name} — ${row.name_he} בתאריך ${row.constraint_date}` : '';
};
