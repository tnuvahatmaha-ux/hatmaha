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
 * בהגשה רצים חוקי ה-trigger 'submit', ואז כלל האישור הגנרי של סוג הבקשה קובע
 * אם היא מאושרת אוטומטית או ממתינה להחלטת מנהל.
 */

const BASE_SELECT = `
  select cr.id, cr.user_id, cr.site_id, cr.constraint_type_id,
         cr.constraint_date, cr.start_time, cr.end_time, cr.starts_at, cr.ends_at,
         cr.note, cr.status::text as status, cr.submitted_at, cr.decided_at,
         cr.decision_note, cr.auto_approved, cr.approver_user_id, cr.row_version,
         cr.created_at, cr.rule_evaluation_id,
         cr.returned_at, cr.return_note, returner.full_name as returned_by_name,
         cr.cancelled_at, canceller.full_name as cancelled_by_name,
         ct.name_he as type_name, ct.code as type_code,
         p.full_name as user_name,
         approver.full_name as approver_name,
         s.name as site_name,
         exists (select 1 from exception_requests er
                  where er.subject_type = 'constraint' and er.subject_id = cr.id
                    and er.status = 'pending') as has_pending_exception
    from constraint_requests cr
    join constraint_types ct on ct.id = cr.constraint_type_id
    join profiles p on p.id = cr.user_id
    left join profiles approver on approver.id = cr.approver_user_id
    left join profiles returner on returner.id = cr.returned_by
    left join profiles canceller on canceller.id = cr.cancelled_by
    left join sites s on s.id = cr.site_id
   where cr.deleted_at is null`;

/** רשימה, מסוננת ל-Scope האפקטיבי של הקורא (AC-13) */
export async function list(principal, filters = {}) {
  const isManager = principal.baseRole === 'manager';
  // מטמיע ומוביל רואים רק את הבקשות של עצמם — לא של מי שעובד איתם באותו אתר
  const selfOnly = ['implementer', 'lead'].includes(principal.baseRole);
  return query(
    `${BASE_SELECT}
       and ($1 or cr.user_id = $2 or cr.user_id = any($3::uuid[]) or cr.site_id = any($4::uuid[]))
       and ($5::text[] is null or cr.status::text = any($5::text[]))
       and ($6::uuid is null or cr.user_id = $6)
       and ($7::uuid is null or cr.site_id = $7)
       and ($8::date is null or cr.constraint_date >= $8)
       and ($9::date is null or cr.constraint_date <= $9)
     order by cr.constraint_date desc, cr.created_at desc
     limit $10`,
    [
      isManager,
      principal.userId,
      selfOnly ? [] : principal.scopes.assignedUserIds,
      selfOnly ? [] : principal.scopes.siteIds,
      filters.status ? String(filters.status).split(',') : null,
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

    // בקשה שחרגה מחוק ממתינה להחלטה על החריגה, שמחייבת נימוק (§10).
    // אישור ישיר כאן היה עוקף את החוק בלחיצה אחת.
    const [pending] = await tx.query(
      `select id from exception_requests
        where subject_type = 'constraint' and subject_id = $1 and status = 'pending'
        limit 1`,
      [requestId],
    );
    if (pending) {
      throw new AppError(
        'E_PENDING_APPROVAL',
        'לבקשה יש חריגה מחוק שממתינה להחלטה. יש להכריע בה בלשונית החריגות.',
        { status: 409, details: { exceptionId: pending.id } },
      );
    }

    // אישור או דחייה בלחיצה אחת: הנימוק רשות
    const approved = decision === 'approve';
    const note = comment?.trim() || null;

    await tx.query(
      `update constraint_requests
          set status = $2::request_status, approver_user_id = $3,
              decided_at = now(), decision_note = $4
        where id = $1`,
      [requestId, approved ? 'approved' : 'rejected', actor.userId, note],
    );

    await notify(tx, {
      typeCode: 'request_decided',
      recipientIds: [row.user_id],
      title: approved ? 'הבקשה אושרה' : 'הבקשה נדחתה',
      body: note ?? (approved ? 'הבקשה שלך אושרה על ידי המנהל' : 'הבקשה שלך נדחתה על ידי המנהל'),
      entityType: 'constraint_requests',
      entityId: requestId,
    });

    return { request: await getIn(tx, requestId), alreadyDecided: false };
  });
}

/**
 * עריכת בקשה.
 * המגיש — רק בטיוטה (כולל בקשה שהוחזרה אליו לתיקון), ואז מגיש מחדש.
 * מאשר (מנהל / מדריך) — גם בקשה שהוגשה או אושרה; הסטטוס נשמר והמטמיע מקבל התראה.
 */
export async function update(actor, requestId, input, { canApprove }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const row = await tx.lock('constraint_requests', requestId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');

    const isOwner = row.user_id === actor.userId;
    if (!(canApprove && ['draft', 'submitted', 'approved'].includes(row.status))
        && !(isOwner && row.status === 'draft')) {
      throw new AppError('E_STATE', 'אפשר לערוך רק טיוטה או בקשה שהוחזרה לתיקון');
    }

    const date = input.constraintDate ?? row.constraint_date;
    const start = input.startTime ?? row.start_time;
    const end = input.endTime ?? row.end_time;
    if (start.slice(0, 5) === end.slice(0, 5)) throw new AppError('E_VALIDATION', 'שעת הסיום זהה לשעת ההתחלה');
    const [site] = row.site_id ? await tx.query('select timezone from sites where id = $1', [row.site_id]) : [];
    const { startsAt, endsAt } = toInstants(date, start, end, site?.timezone);

    await tx.query(
      `update constraint_requests
          set constraint_type_id = coalesce($2, constraint_type_id), constraint_date = $3,
              start_time = $4, end_time = $5, starts_at = $6, ends_at = $7,
              note = case when $8::boolean then $9 else note end
        where id = $1`,
      [requestId, input.constraintTypeId ?? null, date, start, end, startsAt, endsAt,
       input.note !== undefined, input.note ?? null],
    );

    if (!isOwner && row.status !== 'draft') {
      await notify(tx, {
        typeCode: 'request_changed',
        recipientIds: [row.user_id],
        title: 'הבקשה שלך עודכנה',
        body: `${actor.fullName ?? 'המנהל'} עדכן/ה את הבקשה: ${await summaryOf(tx, requestId)}`,
        entityType: 'constraint_requests',
        entityId: requestId,
      });
    }
    return getIn(tx, requestId);
  });
}

/** החזרה למטמיע לתיקון: הבקשה חוזרת לטיוטה, עם הערה, והוא מתקן ומגיש שוב */
export async function returnForFix(actor, requestId, { note }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const row = await tx.lock('constraint_requests', requestId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');
    if (!['submitted', 'approved'].includes(row.status)) {
      throw new AppError('E_STATE', 'אפשר להחזיר לתיקון רק בקשה שהוגשה או אושרה');
    }

    await tx.query(
      `update constraint_requests
          set status = 'draft', returned_at = now(), returned_by = $2, return_note = $3,
              decided_at = null, approver_user_id = null, auto_approved = false, decision_note = null
        where id = $1`,
      [requestId, actor.userId, note],
    );
    await tx.query(
      `update exception_requests
          set status = 'cancelled', decided_at = now(), decision_comment = 'הבקשה הוחזרה לתיקון'
        where subject_type = 'constraint' and subject_id = $1 and status = 'pending'`,
      [requestId],
    );
    await notify(tx, {
      typeCode: 'request_returned',
      recipientIds: [row.user_id],
      title: 'בקשה הוחזרה אליך לתיקון',
      body: note,
      entityType: 'constraint_requests',
      entityId: requestId,
    });
    return getIn(tx, requestId);
  });
}

/** ביטול בקשה שאושרה (או שממתינה) ע״י מאשר — עם נימוק, והמטמיע מקבל התראה */
export async function revoke(actor, requestId, { note }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const row = await tx.lock('constraint_requests', requestId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הבקשה המבוקשת לא נמצאה');
    if (row.status === 'cancelled') return { request: await getIn(tx, requestId), alreadyCancelled: true };

    await tx.query(
      `update constraint_requests
          set status = 'cancelled', cancelled_at = now(), cancelled_by = $2,
              decision_note = coalesce($3, decision_note)
        where id = $1`,
      [requestId, actor.userId, note ?? null],
    );
    await tx.query(
      `update exception_requests
          set status = 'cancelled', decided_at = now(), decision_comment = 'הבקשה בוטלה'
        where subject_type = 'constraint' and subject_id = $1 and status = 'pending'`,
      [requestId],
    );
    await notify(tx, {
      typeCode: 'request_changed',
      recipientIds: [row.user_id],
      title: 'האילוץ שלך בוטל',
      body: note ? `${await summaryOf(tx, requestId)} — ${note}` : await summaryOf(tx, requestId),
      entityType: 'constraint_requests',
      entityId: requestId,
    });
    return { request: await getIn(tx, requestId), alreadyCancelled: false };
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
