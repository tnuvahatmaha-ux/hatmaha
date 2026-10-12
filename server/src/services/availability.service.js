import { query, withTransaction } from '../lib/db.js';
import { weekStartOf, weekDays, nextWeekStart, today, toInstants, deadlineForWeek } from '../lib/time.js';
import { AppError } from '../lib/errors.js';
import { evaluate, selectRules } from '../rules/engine.js';
import { hhmm, windowKey, siteWindows, sitePhases, countAvailable } from './availabilityWindows.js';
import { evaluateAndExecute } from '../rules/exceptions.js';
import { registerAction } from '../rules/actions.js';
import { notify } from '../notifications/service.js';
import { userRotation, CATEGORY_NAMES } from './rotation.js';

/**
 * הצהרת זמינות שבועית — מטריצת יום × חלון שעות.
 *
 * לכל מיקום משמרות משלו, ולכן הזמינות אינה מוצהרת על משמרת מסוימת אלא על
 * חלון שעות: עמודה לכל צירוף (התחלה, סיום) שקיים באחד המיקומים באתר.
 * מיקומים עם אותן שעות חולקים עמודה, כך שהמטמיע אינו ממלא את אותו דבר פעמיים.
 *
 * הצהרה שהוכרעה היא immutable. הגשה חוזרת יוצרת revision חדשה ומסמנת את
 * הקודמת כמוחלפת, ולכן החלטת מנהל אינה נדרסת בשקט — הבאג שהיה בפרוטוטייפ.
 */

export { windowKey, siteWindows, countAvailable };

/** התחום הראשי של המשתמש — לחוקים שהוגדרו ברמת תחום */
async function primaryDomain(run, userId) {
  const [row] = await run(
    `select domain_id from user_domains where user_id = $1 and deleted_at is null
      order by is_primary desc limit 1`,
    [userId],
  );
  return row?.domain_id ?? null;
}

/**
 * המינימום שחל על המשתמש בכל סוג משמרת, מכל חוקי minShiftsPerCategory
 * הפעילים. כמה חוקים חלים יחד — המחמיר מנצח. null כשאין חוק כזה.
 */
async function minimumsFor(userId, siteId) {
  const rules = await selectRules({ query }, {
    trigger: 'submit',
    subjectType: 'availability',
    siteId,
    domainId: await primaryDomain(query, userId),
    targetUserId: userId,
  });
  const relevant = rules.filter((r) => r.condition_type_code === 'minShiftsPerCategory');
  if (relevant.length === 0) return null;
  const out = { morning: 0, afternoon: 0, night: 0, weekend: 0 };
  for (const r of relevant) {
    for (const k of Object.keys(out)) out[k] = Math.max(out[k], Number(r.condition_params?.[k]) || 0);
  }
  return out;
}

/** חלון ההגשה הנוכחי: איזה שבוע מוצהר, ועד מתי אפשר */
export async function window(principal, siteId) {
  const site = siteId ?? principal.scopes.siteIds[0] ?? null;

  const [row] = site
    ? await query(
        `select id, name, timezone, availability_max_cannot, availability_max_prefer_not,
                availability_deadline_weekday, availability_deadline_hour
           from sites where id = $1 and deleted_at is null`,
        [site],
      )
    : [];

  const weekStart = nextWeekStart(row?.timezone);
  const deadline =
    row?.availability_deadline_weekday != null
      ? deadlineForWeek(
          weekStart,
          row.availability_deadline_weekday,
          row.availability_deadline_hour ?? 12,
          row.timezone,
        )
      : null;

  const [windows, phases, rotation] = site
    ? await Promise.all([
        siteWindows(query, site, weekStart),
        sitePhases(query, site, weekStart),
        userRotation(query, principal.userId, site, weekStart),
      ])
    : [[], {}, null];

  return {
    siteId: site,
    siteName: row?.name ?? null,
    weekStart,
    days: weekDays(weekStart),
    windows,
    phases,
    rotation: rotation && { ...rotation, exempt: rotationExempt(rotation) },
    minimums: site ? await minimumsFor(principal.userId, site) : null,
    limits: {
      maxCannot: row?.availability_max_cannot ?? 3,
      maxPreferNot: row?.availability_max_prefer_not ?? 4,
    },
    deadline: deadline?.toISOString() ?? null,
    isOpen: !deadline || deadline.getTime() > Date.now(),
  };
}

/** סוגי המשמרות שמטמיע בסבב אינו נדרש להיות זמין בהם השבוע */
export function rotationExempt(rotation) {
  if (!rotation) return [];
  const inCycles = new Set(rotation.locations.flatMap((l) => l.cycle));
  return [...inCycles].filter((c) => !rotation.categories.includes(c));
}

/**
 * מטמיע בסבב חייב להיות זמין בכל המשמרות של הסוג שלו השבוע, ואינו נדרש
 * בסוגים האחרים שבסבב — תאים שסומנו בהם אינם נשמרים.
 */
function applyRotation(cells, windows, rotation) {
  if (!rotation) return cells;
  const exempt = new Set(rotationExempt(rotation));
  const byKey = new Map(windows.map((w) => [w.key, w]));
  const kept = [];
  for (const cell of cells) {
    const win = byKey.get(windowKey(cell.startTime, cell.endTime));
    if (!win || cell.value === 'can') { kept.push(cell); continue; }
    if (exempt.has(win.category)) continue;
    if (rotation.categories.includes(win.category)) {
      throw new AppError(
        'E_VALIDATION',
        `השבוע את/ה בסבב ${CATEGORY_NAMES[win.category]} — יש להיות זמין/ה בכל משמרות ה${CATEGORY_NAMES[win.category]}. ` +
          'להיעדרות מלאה יש להגיש בקשת אילוץ.',
      );
    }
    kept.push(cell);
  }
  return kept;
}

/** הצהרות של משתמש, החדשה ראשונה, כולל גרסאות קודמות */
export async function listForUser(userId, { siteId, weekStart, includeSuperseded = false } = {}) {
  const declarations = await query(
    `select d.id, d.user_id, d.site_id, d.week_start, d.revision, d.supersedes_id,
            d.superseded_at, d.status::text as status, d.note, d.submitted_at,
            d.decided_at, d.decision_note, d.max_cannot_snapshot, d.max_prefer_not_snapshot,
            d.row_version, s.name as site_name,
            decider.full_name as decided_by_name
       from availability_declarations d
       join sites s on s.id = d.site_id
       left join profiles decider on decider.id = d.decided_by
      where d.user_id = $1 and d.deleted_at is null
        and ($2::uuid is null or d.site_id = $2)
        and ($3::date is null or d.week_start = $3)
        and ($4 or d.superseded_at is null)
      order by d.week_start desc, d.revision desc`,
    [userId, siteId ?? null, weekStart ?? null, includeSuperseded],
  );
  if (declarations.length === 0) return [];

  const ids = declarations.map((d) => d.id);
  const [cells, violations] = await Promise.all([
    query(
      `select declaration_id, cell_date, start_time, end_time, value::text as value, note
         from availability_cells where declaration_id = any($1::uuid[])`,
      [ids],
    ),
    query(
      `select declaration_id, kind, cell_date, start_time, end_time, detail
         from availability_violations
        where declaration_id = any($1::uuid[])`,
      [ids],
    ),
  ]);

  const byId = new Map(declarations.map((d) => [d.id, { ...d, cells: [], violations: [] }]));
  cells.forEach((c) => byId.get(c.declaration_id).cells.push(c));
  violations.forEach((v) => byId.get(v.declaration_id).violations.push(v));
  return [...byId.values()];
}

/**
 * שמירת טיוטה. אידמפוטנטית לפי (משתמש, אתר, שבוע): קריאה חוזרת מעדכנת
 * את אותה ההצהרה במקום ליצור חדשה.
 */
export async function saveDraft(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const userId = input.userId ?? actor.userId;
    const weekStart = weekStartOf(input.weekStart);

    const site = await tx.required(
      'select id, timezone from sites where id = $1 and deleted_at is null',
      [input.siteId],
      'האתר המבוקש לא נמצא',
    );

    const [current] = await tx.query(
      `select * from availability_declarations
        where user_id = $1 and site_id = $2 and week_start = $3
          and superseded_at is null and deleted_at is null
        for update`,
      [userId, site.id, weekStart],
    );

    // הצהרה שהוכרעה אינה נערכת. ההגשה הבאה תיצור revision חדשה.
    if (current && ['approved', 'rejected'].includes(current.status)) {
      throw new AppError(
        'E_READ_ONLY',
        'ההצהרה לשבוע הזה כבר הוכרעה. שליחה חדשה תיצור גרסה חדשה במקום לערוך אותה.',
      );
    }

    let declarationId = current?.id;
    if (!declarationId) {
      const [row] = await tx.query(
        `insert into availability_declarations
           (user_id, site_id, week_start, status, note,
            max_cannot_snapshot, max_prefer_not_snapshot)
         select $1, $2, $3, 'draft', $4, s.availability_max_cannot, s.availability_max_prefer_not
           from sites s where s.id = $2
         returning id`,
        [userId, site.id, weekStart, input.note ?? null],
      );
      declarationId = row.id;
    } else {
      await tx.query(
        'update availability_declarations set note = coalesce($2, note) where id = $1',
        [declarationId, input.note ?? null],
      );
    }

    const rotation = await userRotation(tx.query, userId, site.id, weekStart);
    const cells = rotation
      ? applyRotation(input.cells ?? [], await siteWindows(tx.query, site.id, weekStart), rotation)
      : (input.cells ?? []);

    // המטריצה נערכת כיחידה אחת, ולכן התאים מוחלפים במלואם
    await tx.query('delete from availability_cells where declaration_id = $1', [declarationId]);

    for (const cell of cells) {
      if (cell.value === 'can') continue; // "יכול" הוא ברירת המחדל — לא נשמר
      await tx.query(
        `insert into availability_cells (declaration_id, cell_date, start_time, end_time, value, note)
         values ($1, $2, $3, $4, $5::avail_value, $6)`,
        [declarationId, cell.date, cell.startTime, cell.endTime, cell.value, cell.note ?? null],
      );
    }

    return declarationId;
  });
}

/**
 * חישוב החריגות מהמכסות.
 *
 * המכסות נלקחות מהצילום שנעשה בהגשה, ולא מהאתר ברגע זה: הידוק מכסה
 * בדיעבד אינו הופך הצהרות שכבר הוגשו לחריגות.
 */
export function computeViolations({ cells, windows, limits }) {
  const violations = [];
  const byKey = new Map(windows.map((w) => [w.key, w]));

  const cannot = cells.filter((c) => c.value === 'cannot');
  const preferNot = cells.filter((c) => c.value === 'prefer_not');

  // חריגה אחת לכל תא פוגע, ולא אחת מסכמת — כדי שהמנהל יראה בדיוק איפה
  for (const cell of cannot) {
    const startTime = hhmm(cell.start_time ?? cell.startTime);
    const endTime = hhmm(cell.end_time ?? cell.endTime);
    const win = byKey.get(windowKey(startTime, endTime));
    if (win?.isMandatory) {
      violations.push({
        kind: 'mandatory_cannot',
        cellDate: cell.cell_date ?? cell.date,
        startTime,
        endTime,
        detail: {
          shiftName: win.label,
          message: `סומן "לא יכול" במשמרת חובה ${win.label} ${startTime}–${endTime}`,
        },
      });
    }
  }

  if (cannot.length > limits.maxCannot) {
    violations.push({
      kind: 'over_max_cannot',
      detail: { count: cannot.length, max: limits.maxCannot,
                message: `סומנו ${cannot.length} תאי "לא יכול", מעל המכסה של ${limits.maxCannot}` },
    });
  }
  if (preferNot.length > limits.maxPreferNot) {
    violations.push({
      kind: 'over_max_prefer_not',
      detail: { count: preferNot.length, max: limits.maxPreferNot,
                message: `סומנו ${preferNot.length} תאי "מעדיף שלא", מעל המכסה של ${limits.maxPreferNot}` },
    });
  }

  return violations;
}

async function loadForEvaluation(tx, declarationId) {
  const decl = await tx.required(
    `select d.*, s.timezone, s.availability_max_cannot, s.availability_max_prefer_not
       from availability_declarations d join sites s on s.id = d.site_id
      where d.id = $1 and d.deleted_at is null`,
    [declarationId],
    'ההצהרה המבוקשת לא נמצאה',
  );

  const [cells, windows] = await Promise.all([
    tx.query(
      `select cell_date, start_time, end_time, value::text as value
         from availability_cells where declaration_id = $1`,
      [declarationId],
    ),
    siteWindows(tx.query, decl.site_id, decl.week_start),
  ]);

  return { decl, cells, windows };
}

/** בדיקה מקדימה — חריגות מהמכסות וחוקי המערכת, בלי לשמור דבר */
export async function preview(actor, declarationId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const { decl, cells, windows } = await loadForEvaluation(tx, declarationId);

    const violations = computeViolations({
      cells,
      windows,
      limits: {
        maxCannot: decl.availability_max_cannot,
        maxPreferNot: decl.availability_max_prefer_not,
      },
    });

    const result = await evaluate(tx, {
      trigger: 'submit',
      subjectType: 'availability',
      subjectId: decl.id,
      targetUserId: decl.user_id,
      siteId: decl.site_id,
      domainId: await primaryDomain(tx.query, decl.user_id),
      weekStart: decl.week_start,
      timeZone: decl.timezone,
    });

    const needsApproval = violations.length > 0 || result.outcome === 'approval_required';

    return {
      declarationId,
      violations,
      findings: result.failed.map((f) => ({
        ruleName: f.name, severity: f.severity, message: f.message,
      })),
      willBe: result.outcome === 'blocked' ? 'blocked' : needsApproval ? 'pending_approval' : 'ok',
      counts: {
        cannot: cells.filter((c) => c.value === 'cannot').length,
        preferNot: cells.filter((c) => c.value === 'prefer_not').length,
      },
      available: countAvailable({ cells, windows }),
      limits: {
        maxCannot: decl.availability_max_cannot,
        maxPreferNot: decl.availability_max_prefer_not,
      },
    };
  });
}

/** הגשה */
export async function submit(actor, declarationId, meta) {
  return withTransaction({ actorId: actor.userId, traceId: meta?.traceId }, async (tx) => {
    let { decl, cells, windows } = await loadForEvaluation(tx, declarationId);

    if (decl.superseded_at) {
      throw new AppError('E_READ_ONLY', 'ההצהרה הוחלפה בגרסה חדשה');
    }

    // הצהרה שהוכרעה: נפתחת גרסה חדשה במקום לדרוס את ההחלטה
    if (['approved', 'rejected'].includes(decl.status)) {
      declarationId = await createRevision(tx, decl);
      ({ decl, cells, windows } = await loadForEvaluation(tx, declarationId));
    }

    const violations = computeViolations({
      cells,
      windows,
      limits: {
        maxCannot: decl.max_cannot_snapshot,
        maxPreferNot: decl.max_prefer_not_snapshot,
      },
    });

    await tx.query('delete from availability_violations where declaration_id = $1', [declarationId]);
    for (const v of violations) {
      await tx.query(
        `insert into availability_violations (declaration_id, kind, cell_date, start_time, end_time, detail)
         values ($1, $2, $3, $4, $5, $6::jsonb)`,
        [declarationId, v.kind, v.cellDate ?? null, v.startTime ?? null, v.endTime ?? null,
         JSON.stringify(v.detail ?? {})],
      );
    }

    const outcome = await evaluateAndExecute(
      tx,
      {
        trigger: 'submit',
        subjectType: 'availability',
        subjectId: declarationId,
        targetUserId: decl.user_id,
        siteId: decl.site_id,
        domainId: await primaryDomain(tx.query, decl.user_id),
        weekStart: decl.week_start,
        timeZone: decl.timezone,
        hasQuotaViolations: violations.length > 0,
      },
      {
        meta: { actorId: actor.userId, traceId: meta?.traceId },
        summary: `הצהרת זמינות לשבוע ${decl.week_start}`,
        action: { type: 'availability.finalize', payload: { declarationId } },
      },
    );

    // חריגה ממכסות האתר מחייבת אישור מיוחד, גם אם אף חוק במנוע לא נדלק
    if (outcome.status !== 'approval_required' && violations.length > 0) {
      await tx.query(
        `update availability_declarations
            set status = 'pending_approval', submitted_at = now(), rule_evaluation_id = $2
          where id = $1`,
        [declarationId, outcome.evaluationId],
      );
      await notifyApprovers(tx, decl, violations);
      return { declarationId, status: 'pending_approval', violations, warnings: outcome.warnings };
    }

    if (outcome.status === 'approval_required') {
      await tx.query(
        `update availability_declarations
            set status = 'pending_approval', submitted_at = now(), rule_evaluation_id = $2
          where id = $1`,
        [declarationId, outcome.evaluationId],
      );
    }

    return {
      declarationId,
      status: outcome.status === 'approval_required' ? 'pending_approval' : 'ok',
      violations,
      warnings: outcome.warnings,
      exceptions: outcome.exceptions,
    };
  });
}

/** הפעולה שמסמנת הצהרה כתקינה — ישירות, או אחרי אישור חריגה */
registerAction('availability.finalize', async (tx, { declarationId }, meta) => {
  const [row] = await tx.query(
    `update availability_declarations
        set status = 'ok', submitted_at = coalesce(submitted_at, now()),
            rule_evaluation_id = coalesce($2, rule_evaluation_id)
      where id = $1 returning id, status::text as status, user_id`,
    [declarationId, meta?.evaluationId ?? null],
  );
  return row;
});

async function createRevision(tx, decl) {
  const [next] = await tx.query(
    `insert into availability_declarations
       (user_id, site_id, week_start, revision, supersedes_id, status, note,
        max_cannot_snapshot, max_prefer_not_snapshot)
     select user_id, site_id, week_start, revision + 1, id, 'draft', note,
            max_cannot_snapshot, max_prefer_not_snapshot
       from availability_declarations where id = $1
     returning id`,
    [decl.id],
  );

  await tx.query(
    `insert into availability_cells (declaration_id, cell_date, start_time, end_time, value, note)
     select $2, cell_date, start_time, end_time, value, note
       from availability_cells where declaration_id = $1`,
    [decl.id, next.id],
  );

  return next.id;
}

async function notifyApprovers(tx, decl, violations) {
  const managers = await tx.query(
    `select id from profiles where base_role = 'manager' and status = 'active' and deleted_at is null`,
  );
  await notify(tx, {
    typeCode: 'request_submitted',
    recipientIds: managers.map((m) => m.id),
    title: 'הגשת זמינות שחורגת מהכללים',
    body: violations[0]?.detail?.message ?? 'ההגשה חורגת מהמכסות שהוגדרו',
    entityType: 'availability_declarations',
    entityId: decl.id,
    dedupeKey: `availability_violation:${decl.id}`,
  });
}

/** החלטת מנהל על הגשה שחרגה */
export async function decide(actor, declarationId, { decision, comment, traceId }) {
  return withTransaction({ actorId: actor.userId, traceId }, async (tx) => {
    const decl = await tx.lock('availability_declarations', declarationId);
    if (!decl || decl.deleted_at) throw new AppError('E_NOT_FOUND', 'ההצהרה המבוקשת לא נמצאה');

    if (decl.status !== 'pending_approval') {
      return { declarationId, status: decl.status, alreadyDecided: true };
    }
    if (!comment?.trim()) throw new AppError('E_VALIDATION', 'החלטה מחייבת נימוק');

    const status = decision === 'approve' ? 'approved' : 'rejected';
    await tx.query(
      `update availability_declarations
          set status = $2::avail_status, decided_by = $3, decided_at = now(), decision_note = $4
        where id = $1`,
      [declarationId, status, actor.userId, comment.trim()],
    );

    await notify(tx, {
      typeCode: 'availability_decided',
      recipientIds: [decl.user_id],
      title: decision === 'approve' ? 'הצהרת הזמינות אושרה' : 'הצהרת הזמינות נדחתה',
      body: comment.trim(),
      entityType: 'availability_declarations',
      entityId: declarationId,
    });

    return { declarationId, status, alreadyDecided: false };
  });
}

/** תור ההגשות שחורגות — מסך "בקשות ואישורים" של המנהל */
export async function pending(principal) {
  const isManager = principal.baseRole === 'manager';
  return query(
    `select d.id, d.user_id, d.site_id, d.week_start, d.revision, d.submitted_at,
            p.full_name as user_name, s.name as site_name,
            d.max_cannot_snapshot, d.max_prefer_not_snapshot,
            (select count(*)::int from availability_cells c
              where c.declaration_id = d.id and c.value = 'cannot') as cannot_count,
            (select count(*)::int from availability_cells c
              where c.declaration_id = d.id and c.value = 'prefer_not') as prefer_not_count,
            coalesce((select json_agg(json_build_object(
                'kind', v.kind, 'cellDate', v.cell_date,
                'startTime', v.start_time, 'endTime', v.end_time, 'detail', v.detail))
              from availability_violations v
             where v.declaration_id = d.id), '[]') as violations
       from availability_declarations d
       join profiles p on p.id = d.user_id
       join sites s on s.id = d.site_id
      where d.status = 'pending_approval' and d.deleted_at is null and d.superseded_at is null
        and ($1 or d.site_id = any($2::uuid[]) or d.user_id = any($3::uuid[]))
      order by d.submitted_at`,
    [isManager, principal.scopes.siteIds, principal.scopes.assignedUserIds],
  );
}
