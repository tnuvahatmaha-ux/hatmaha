import { query, withTransaction } from '../lib/db.js';
import { toInstants, weekStartOf, weekDays, addDays } from '../lib/time.js';
import { AppError } from '../lib/errors.js';
import { evaluate } from '../rules/engine.js';
import { evaluateAndExecute } from '../rules/exceptions.js';
import { registerAction } from '../rules/actions.js';
import { notify } from '../notifications/service.js';
import { assertIfMatch } from '../lib/etag.js';

/**
 * סידור עבודה.
 *
 * גרסה שפורסמה היא לקריאה בלבד — נאכף בטריגר ב-DB ולא כאן, ולכן אי אפשר
 * לעקוף את זה מאף נתיב. פרסום מקפיא את הגרסה עם Snapshot ופותח עותק
 * כטיוטה הבאה (AC-12).
 */

/* ───────────────────────── גרסאות ───────────────────────── */

export async function versions(siteId, weekStart) {
  return query(
    `select v.id, v.site_id, v.week_start, v.version_number, v.status::text as status,
            v.published_at, v.published_by, v.publish_note, v.row_version,
            publisher.full_name as published_by_name,
            (select count(*)::int from roster_assignments ra
              where ra.version_id = v.id and ra.deleted_at is null) as assignment_count
       from roster_versions v
       left join profiles publisher on publisher.id = v.published_by
      where v.site_id = $1 and v.deleted_at is null
        and ($2::date is null or v.week_start = $2)
      order by v.week_start desc, v.version_number desc`,
    [siteId, weekStart ?? null],
  );
}

/** מחזיר את הטיוטה הפתוחה, ויוצר אותה אם אין. */
export async function getOrCreateDraft(actor, siteId, weekStartInput) {
  const weekStart = weekStartOf(weekStartInput);

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [existing] = await tx.query(
      `select * from roster_versions
        where site_id = $1 and week_start = $2 and status = 'draft' and deleted_at is null`,
      [siteId, weekStart],
    );
    if (existing) return existing;

    // טיוטה חדשה יורשת את השיבוצים של הגרסה האחרונה שפורסמה לאותו שבוע,
    // כך שתיקון אחרי פרסום אינו מתחיל מדף ריק.
    const [published] = await tx.query(
      `select * from roster_versions
        where site_id = $1 and week_start = $2 and status = 'published' and deleted_at is null
        order by version_number desc limit 1`,
      [siteId, weekStart],
    );

    const nextNumber = await nextVersionNumber(tx, siteId, weekStart);

    const [draft] = await tx.query(
      `insert into roster_versions (site_id, week_start, version_number, status, source_version_id)
       values ($1, $2, $3, 'draft', $4) returning *`,
      [siteId, weekStart, nextNumber, published?.id ?? null],
    );

    if (published) await copyAssignments(tx, published.id, draft.id);
    return draft;
  });
}

async function nextVersionNumber(tx, siteId, weekStart) {
  const [row] = await tx.query(
    `select coalesce(max(version_number), 0) + 1 as n from roster_versions
      where site_id = $1 and week_start = $2`,
    [siteId, weekStart],
  );
  return row.n;
}

async function copyAssignments(tx, fromVersionId, toVersionId) {
  await tx.query(
    `insert into roster_assignments
       (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
        start_time, end_time, starts_at, ends_at, domain_id, sub_category_id, note)
     select $2, site_id, assignment_date, location_id, user_id, shift_type_id,
            start_time, end_time, starts_at, ends_at, domain_id, sub_category_id, note
       from roster_assignments
      where version_id = $1 and deleted_at is null`,
    [fromVersionId, toVersionId],
  );
}

/* ───────────────────────── המטריצה ───────────────────────── */

/**
 * כל מה שמסך בונה הסידור צריך: מיקומים, משמרות, שיבוצים, והמועמדים
 * לכל תא — כל אחד עם סימון הזמינות שלו.
 */
export async function board(versionId) {
  const [version] = await query(
    `select v.*, s.name as site_name, s.timezone
       from roster_versions v join sites s on s.id = v.site_id
      where v.id = $1 and v.deleted_at is null`,
    [versionId],
  );
  if (!version) throw new AppError('E_NOT_FOUND', 'גרסת הסידור המבוקשת לא נמצאה');

  const days = weekDays(version.week_start);

  const [locations, shiftTypes, assignments, people, availability, constraints, declarations, phaseRows] = await Promise.all([
    query(
      `select id, name, capacity, periods::text[] as periods from locations
        where site_id = $1 and deleted_at is null and is_active order by name`,
      [version.site_id],
    ),
    query(
      `select id, location_id, name, start_time, end_time, is_mandatory, crosses_midnight,
              required_staff, domain_id, sub_category_id, display_order,
              category::text as category, period::text as period
         from shift_types
        where site_id = $1 and deleted_at is null and is_active
        order by display_order, start_time`,
      [version.site_id],
    ),
    query(
      `select ra.id, ra.assignment_date, ra.location_id, ra.user_id, ra.shift_type_id,
              ra.start_time, ra.end_time, ra.starts_at, ra.ends_at,
              ra.domain_id, ra.sub_category_id, ra.note, ra.warning_text, ra.row_version,
              p.full_name as user_name
         from roster_assignments ra join profiles p on p.id = ra.user_id
        where ra.version_id = $1 and ra.deleted_at is null
        order by ra.assignment_date, ra.start_time`,
      [versionId],
    ),
    query(
      `select p.id, p.full_name, p.base_role::text as base_role,
              array(select domain_id from user_domains ud
                     where ud.user_id = p.id and ud.deleted_at is null) as domain_ids,
              array(select sub_category_id from user_sub_categories usc
                     where usc.user_id = p.id and usc.deleted_at is null) as sub_category_ids
         from profiles p
         join site_assignments sa on sa.user_id = p.id
        where sa.site_id = $1 and sa.deleted_at is null and sa.span @> current_date
          and p.status = 'active' and p.deleted_at is null
          and p.base_role in ('implementer', 'lead')
        order by p.full_name`,
      [version.site_id],
    ),
    query(
      `select c.cell_date, c.start_time, c.end_time, c.value::text as value,
              d.user_id, d.status::text as status
         from availability_cells c
         join availability_declarations d on d.id = c.declaration_id
        where d.site_id = $1 and d.week_start = $2
          and d.superseded_at is null and d.deleted_at is null`,
      [version.site_id, version.week_start],
    ),
    query(
      `select cr.user_id, cr.starts_at, cr.ends_at, cr.status::text as status,
              ct.name_he as type_name
         from constraint_requests cr
         join constraint_types ct on ct.id = cr.constraint_type_id
        where cr.deleted_at is null
          and cr.status in ('submitted', 'approved')
          and cr.constraint_date between $1::date and $1::date + 6`,
      [version.week_start],
    ),
    // מי הגיש הצהרה לשבוע. הצהרה בלי תא חופף פירושה "יכול" — תאי "יכול"
    // אינם נשמרים, כי זו ברירת המחדל.
    query(
      `select user_id, status::text as status
         from availability_declarations
        where site_id = $1 and week_start = $2 and status <> 'draft'
          and superseded_at is null and deleted_at is null`,
      [version.site_id, version.week_start],
    ),
    // שלב האתר בכל יום: המיקומים והמשמרות שמוצגים ביום תלויים בו
    query(
      `select d::date::text as day, app.site_period_on($1, d::date)::text as period
         from generate_series($2::date, $2::date + 6, interval '1 day') d`,
      [version.site_id, version.week_start],
    ),
  ]);

  return {
    version,
    days,
    phases: Object.fromEntries(phaseRows.map((r) => [r.day, r.period])),
    locations,
    shiftTypes,
    assignments,
    people,
    availability,
    constraints,
    declarations,
  };
}

/* ───────────────────────── שיבוץ ───────────────────────── */

async function assignmentContext(tx, { versionId, userId, date, shiftTypeId, startTime, endTime, locationId, excludeId }) {
  const version = await tx.required(
    `select v.*, s.timezone from roster_versions v join sites s on s.id = v.site_id where v.id = $1`,
    [versionId],
    'גרסת הסידור המבוקשת לא נמצאה',
  );

  const shift = shiftTypeId
    ? await tx.required(
        'select * from shift_types where id = $1 and site_id = $2',
        [shiftTypeId, version.site_id],
        'המשמרת המבוקשת לא נמצאה באתר הזה',
      )
    : null;

  // לכל מיקום המשמרות שלו: משמרת של חדר המיון אינה ניתנת לשיבוץ במחלקה
  if (shift && locationId && shift.location_id !== locationId) {
    throw new AppError('E_VALIDATION', 'המשמרת שנבחרה אינה שייכת למיקום הזה');
  }

  const from = startTime ?? shift?.start_time;
  const to = endTime ?? shift?.end_time;
  if (!from || !to) {
    throw new AppError('E_VALIDATION', 'יש לבחור משמרת או לציין שעות התחלה וסיום');
  }

  const { startsAt, endsAt } = toInstants(date, from, to, version.timezone);

  const [user] = await tx.query(
    `select array(select domain_id from user_domains
                   where user_id = $1 and deleted_at is null) as domain_ids,
            array(select sub_category_id from user_sub_categories
                   where user_id = $1 and deleted_at is null) as sub_ids`,
    [userId],
  );

  const domainId = shift?.domain_id ?? user?.domain_ids?.[0] ?? null;
  const subCategoryIds = shift?.sub_category_id ? [shift.sub_category_id] : (user?.sub_ids ?? []);

  return {
    version,
    shift,
    startTime: from,
    endTime: to,
    domainId,
    ctx: {
      trigger: 'assign',
      subjectType: 'roster',
      targetUserId: userId,
      siteId: version.site_id,
      domainId,
      subCategoryIds,
      startsAt,
      endsAt,
      localDate: date,
      shiftTypeId: shiftTypeId ?? null,
      rosterVersionId: versionId,
      excludeId: excludeId ?? null,
      timeZone: version.timezone,
      locationId,
    },
  };
}

export async function assign(actor, versionId, input, meta) {
  return withTransaction({ actorId: actor.userId, traceId: meta?.traceId }, async (tx) => {
    const built = await assignmentContext(tx, { versionId, ...input });

    if (built.version.status !== 'draft') {
      throw new AppError('E_READ_ONLY', 'גרסת הסידור פורסמה ואינה ניתנת לשינוי');
    }

    const [person] = await tx.query('select full_name from profiles where id = $1', [input.userId]);

    return evaluateAndExecute(tx, built.ctx, {
      meta: { actorId: actor.userId, traceId: meta?.traceId },
      summary: `שיבוץ ${person?.full_name ?? ''} ב-${input.date}`,
      action: {
        type: 'roster.assign',
        payload: {
          versionId,
          userId: input.userId,
          date: input.date,
          locationId: input.locationId,
          shiftTypeId: input.shiftTypeId ?? null,
          startTime: built.startTime,
          endTime: built.endTime,
          note: input.note ?? null,
        },
      },
    });
  });
}

/** הפעולה עצמה — רצה בשיבוץ רגיל, וגם כשחריגה אושרה */
registerAction('roster.assign', async (tx, payload, meta) => {
  const built = await assignmentContext(tx, { versionId: payload.versionId, ...payload });

  if (built.version.status !== 'draft') {
    throw new AppError('E_READ_ONLY', 'גרסת הסידור פורסמה ואינה ניתנת לשינוי');
  }

  const [row] = await tx.query(
    `insert into roster_assignments
       (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
        start_time, end_time, starts_at, ends_at, domain_id, sub_category_id, note,
        rule_evaluation_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     returning *`,
    [
      payload.versionId,
      built.version.site_id,
      payload.date,
      payload.locationId,
      payload.userId,
      payload.shiftTypeId ?? null,
      built.startTime,
      built.endTime,
      built.ctx.startsAt,
      built.ctx.endsAt,
      built.domainId,
      built.shift?.sub_category_id ?? null,
      payload.note ?? null,
      meta?.evaluationId ?? null,
    ],
  );
  return row;
});

export async function unassign(actor, assignmentId, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const row = await tx.lock('roster_assignments', assignmentId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'השיבוץ המבוקש לא נמצא');
    if (req) assertIfMatch(req, row);

    // הטריגר ב-DB חוסם מחיקה מגרסה שפורסמה; כאן רק מחזירים הודעה ברורה
    await tx.query('delete from roster_assignments where id = $1', [assignmentId]);
    return { removed: assignmentId };
  });
}

/* ───────────────────────── שכפול שבוע ───────────────────────── */

/**
 * שכפול השבוע קדימה.
 *
 * ההזזה היא על התאריך המקומי ואז גזירה מחדש של הרגעים — הוספת 7×24 שעות
 * לרגע UTC נשברת במעבר שעון קיץ, שבישראל נופל בסוף מרץ ובסוף אוקטובר,
 * שניהם בתוך חלון Go-Live טיפוסי.
 *
 * mode='rotate' מעביר כל שיבוץ למשמרת הבאה בתור שהוגדר באתר.
 */
export async function duplicateWeek(actor, versionId, { targetWeekStart, mode = 'copy' }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const source = await tx.required(
      `select v.*, s.timezone from roster_versions v join sites s on s.id = v.site_id where v.id = $1`,
      [versionId],
      'גרסת הסידור המבוקשת לא נמצאה',
    );

    const target = weekStartOf(targetWeekStart ?? addDays(source.week_start, 7));
    if (target === source.week_start) {
      throw new AppError('E_VALIDATION', 'שבוע היעד זהה לשבוע המקור');
    }

    const assignments = await tx.query(
      `select * from roster_assignments where version_id = $1 and deleted_at is null`,
      [versionId],
    );
    if (assignments.length === 0) {
      throw new AppError('E_VALIDATION', 'אין שיבוצים בשבוע הנוכחי לשכפול');
    }

    const shiftTypes = await tx.query(
      `select id, location_id, name, start_time, end_time, display_order from shift_types
        where site_id = $1 and deleted_at is null and is_active
        order by display_order, start_time`,
      [source.site_id],
    );
    // הרוטציה מסתובבת בין המשמרות של אותו מיקום — למיקום אחר יש שעות אחרות
    const shiftsByLocation = new Map();
    for (const shift of shiftTypes) {
      if (!shiftsByLocation.has(shift.location_id)) shiftsByLocation.set(shift.location_id, []);
      shiftsByLocation.get(shift.location_id).push(shift);
    }

    // טיוטת היעד
    const [existing] = await tx.query(
      `select * from roster_versions
        where site_id = $1 and week_start = $2 and status = 'draft' and deleted_at is null`,
      [source.site_id, target],
    );
    let draft = existing;
    if (!draft) {
      const n = await nextVersionNumber(tx, source.site_id, target);
      [draft] = await tx.query(
        `insert into roster_versions (site_id, week_start, version_number, status, source_version_id)
         values ($1, $2, $3, 'draft', $4) returning *`,
        [source.site_id, target, n, versionId],
      );
    }

    const offset = daysBetween(source.week_start, target);
    let created = 0;
    let skipped = 0;

    for (const a of assignments) {
      const date = addDays(a.assignment_date, offset);

      let shiftTypeId = a.shift_type_id;
      let startTime = a.start_time;
      let endTime = a.end_time;

      const cycle = shiftsByLocation.get(a.location_id) ?? [];
      if (mode === 'rotate' && a.shift_type_id && cycle.length > 1) {
        const idx = cycle.findIndex((s) => s.id === a.shift_type_id);
        const next = cycle[(idx + 1) % cycle.length];
        shiftTypeId = next.id;
        startTime = next.start_time;
        endTime = next.end_time;
      }

      const { startsAt, endsAt } = toInstants(date, startTime, endTime, source.timezone);

      try {
        await tx.query(
          `insert into roster_assignments
             (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
              start_time, end_time, starts_at, ends_at, domain_id, sub_category_id, note)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            draft.id, a.site_id, date, a.location_id, a.user_id, shiftTypeId,
            startTime, endTime, startsAt, endsAt, a.domain_id, a.sub_category_id, a.note,
          ],
        );
        created += 1;
      } catch (err) {
        // חפיפה שנוצרה בעקבות הרוטציה, או שורה שכבר הועתקה — מדלגים
        // ומדווחים, במקום להפיל את כל השכפול
        if (['E_CONFLICT', 'E_DUPLICATE', 'E_RULE_BLOCKED'].includes(err.code)) {
          skipped += 1;
          continue;
        }
        throw err;
      }
    }

    return { targetVersionId: draft.id, targetWeekStart: target, created, skipped, mode };
  });
}

const daysBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/* ───────────────────────── בדיקת תקינות ───────────────────────── */

/**
 * סריקה מלאה של הגרסה מול כל החוקים, כולל חוקי הפרסום.
 * זה מה שמסך בונה הסידור מציג ב"בדיקת תקינות" לפני שמנסים לפרסם.
 */
export async function validateVersion(actor, versionId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const version = await tx.required(
      `select v.*, s.timezone from roster_versions v join sites s on s.id = v.site_id where v.id = $1`,
      [versionId],
      'גרסת הסידור המבוקשת לא נמצאה',
    );

    const assignments = await tx.query(
      `select ra.*, p.full_name, st.name as shift_name
         from roster_assignments ra
         join profiles p on p.id = ra.user_id
         left join shift_types st on st.id = ra.shift_type_id
        where ra.version_id = $1 and ra.deleted_at is null
        order by ra.assignment_date, ra.start_time`,
      [versionId],
    );

    const issues = [];

    for (const a of assignments) {
      const { ctx } = await assignmentContext(tx, {
        versionId,
        userId: a.user_id,
        date: a.assignment_date,
        shiftTypeId: a.shift_type_id,
        startTime: a.start_time,
        endTime: a.end_time,
        locationId: a.location_id,
        excludeId: a.id,
      });

      const result = await evaluate(tx, ctx);
      for (const f of result.failed) {
        issues.push({
          severity: f.severity,
          assignmentId: a.id,
          userId: a.user_id,
          who: `${a.full_name} · ${a.assignment_date}${a.shift_name ? ` ${a.shift_name}` : ''}`,
          ruleName: f.name,
          message: f.message,
        });
      }
    }

    // חוקי הפרסום — כיסוי משמרות וכל חוק אחר על trigger='publish'
    const publishResult = await evaluate(tx, {
      trigger: 'publish',
      subjectType: 'roster',
      subjectId: versionId,
      siteId: version.site_id,
      rosterVersionId: versionId,
      timeZone: version.timezone,
    });

    for (const f of publishResult.failed) {
      issues.push({
        severity: f.severity,
        scope: 'publish',
        who: 'פרסום',
        ruleName: f.name,
        message: f.message,
      });
    }

    // חריגות פתוחות על הגרסה חוסמות פרסום עד שיוכרעו
    const openExceptions = await tx.query(
      `select e.id, e.summary, e.status::text as status, target.full_name as target_name
         from exception_requests e
         left join profiles target on target.id = e.target_user_id
        where e.subject_type = 'roster' and e.status = 'pending' and e.deleted_at is null
          and e.site_id = $1`,
      [version.site_id],
    );

    const rank = { warning: 1, approval_required: 2, blocking: 3 };
    issues.sort((a, b) => (rank[b.severity] ?? 0) - (rank[a.severity] ?? 0));

    return {
      versionId,
      assignmentCount: assignments.length,
      issues,
      openExceptions,
      canPublish:
        assignments.length > 0 &&
        !issues.some((i) => i.severity === 'blocking') &&
        openExceptions.length === 0,
    };
  });
}

/* ───────────────────────── פרסום ───────────────────────── */

/**
 * פרסום גרסה (AC-12).
 *
 * אידמפוטנטי: פרסום חוזר של גרסה שכבר פורסמה מחזיר את אותה התוצאה.
 * הגרסה מוקפאת עם Snapshot, ונפתח עותק שלה כטיוטה הבאה.
 */
export async function publish(actor, versionId, { note, req, traceId } = {}) {
  return withTransaction({ actorId: actor.userId, traceId }, async (tx) => {
    const version = await tx.lock('roster_versions', versionId);
    if (!version || version.deleted_at) {
      throw new AppError('E_NOT_FOUND', 'גרסת הסידור המבוקשת לא נמצאה');
    }

    if (version.status === 'published') {
      const [nextDraft] = await tx.query(
        `select id from roster_versions
          where site_id = $1 and week_start = $2 and status = 'draft' and deleted_at is null`,
        [version.site_id, version.week_start],
      );
      return {
        versionId: version.id,
        versionNumber: version.version_number,
        publishedAt: version.published_at,
        nextDraftId: nextDraft?.id ?? null,
        idempotentReplay: true,
      };
    }

    if (version.status !== 'draft') {
      throw new AppError('E_STATE', 'רק טיוטה ניתנת לפרסום');
    }
    if (req) assertIfMatch(req, version);

    const check = await validateVersionIn(tx, versionId, version);

    if (check.assignmentCount === 0) {
      throw new AppError('E_VALIDATION', 'אין שיבוצים בטיוטה לפרסום');
    }
    if (check.issues.some((i) => i.severity === 'blocking')) {
      throw new AppError('E_RULE_BLOCKED', 'לא ניתן לפרסם — קיימות חריגות חוסמות', {
        details: { issues: check.issues.filter((i) => i.severity === 'blocking') },
      });
    }
    if (check.openExceptions.length > 0) {
      throw new AppError('E_PENDING_APPROVAL', 'לא ניתן לפרסם — קיימות חריגות הממתינות לאישור', {
        status: 409,
        details: { openExceptions: check.openExceptions },
      });
    }

    const snapshot = await buildSnapshot(tx, version);

    await tx.query(
      `update roster_versions
          set status = 'published', published_at = now(), published_by = $2,
              published_snapshot = $3, publish_note = $4
        where id = $1`,
      [versionId, actor.userId, JSON.stringify(snapshot), note ?? null],
    );

    // הגרסה הקודמת שפורסמה לאותו שבוע יורדת לארכיון
    await tx.query(
      `update roster_versions set status = 'archived'
        where site_id = $1 and week_start = $2 and status = 'published' and id <> $3`,
      [version.site_id, version.week_start, versionId],
    );

    // עותק כטיוטה הבאה — כך תיקון קטן אינו מתחיל מאפס
    const nextNumber = await nextVersionNumber(tx, version.site_id, version.week_start);
    const [nextDraft] = await tx.query(
      `insert into roster_versions (site_id, week_start, version_number, status, source_version_id)
       values ($1, $2, $3, 'draft', $4) returning id`,
      [version.site_id, version.week_start, nextNumber, versionId],
    );
    await copyAssignments(tx, versionId, nextDraft.id);

    // §11: מטמיעים שהושפעו ובעלי הרשאה
    const affected = await tx.query(
      `select distinct user_id from roster_assignments
        where version_id = $1 and deleted_at is null`,
      [versionId],
    );
    const viewers = await tx.query(
      `select id from profiles
        where status = 'active' and deleted_at is null
          and (base_role = 'manager'
               or id in (select user_id from site_assignments
                          where site_id = $1 and deleted_at is null and span @> current_date
                            and assignment_role = 'lead'))`,
      [version.site_id],
    );

    await notify(tx, {
      typeCode: 'roster_published',
      recipientIds: [...affected.map((a) => a.user_id), ...viewers.map((v) => v.id)],
      title: 'פורסם סידור עבודה',
      body: `${snapshot.site.name} · שבוע ${version.week_start} · גרסה ${version.version_number}`,
      entityType: 'roster_versions',
      entityId: versionId,
      dedupeKey: `roster_published:${versionId}`,
    });

    return {
      versionId,
      versionNumber: version.version_number,
      publishedAt: new Date().toISOString(),
      nextDraftId: nextDraft.id,
      notified: affected.length,
      warnings: check.issues.filter((i) => i.severity !== 'blocking'),
    };
  });
}

/** אותה בדיקה, בתוך טרנזקציה קיימת */
async function validateVersionIn(tx, versionId, version) {
  const assignments = await tx.query(
    `select ra.*, p.full_name, st.name as shift_name
       from roster_assignments ra
       join profiles p on p.id = ra.user_id
       left join shift_types st on st.id = ra.shift_type_id
      where ra.version_id = $1 and ra.deleted_at is null`,
    [versionId],
  );

  const issues = [];
  for (const a of assignments) {
    const { ctx } = await assignmentContext(tx, {
      versionId,
      userId: a.user_id,
      date: a.assignment_date,
      shiftTypeId: a.shift_type_id,
      startTime: a.start_time,
      endTime: a.end_time,
      locationId: a.location_id,
      excludeId: a.id,
    });
    const result = await evaluate(tx, ctx);
    for (const f of result.failed) {
      issues.push({
        severity: f.severity,
        assignmentId: a.id,
        who: `${a.full_name} · ${a.assignment_date}`,
        ruleName: f.name,
        message: f.message,
      });
    }
  }

  const publishResult = await evaluate(tx, {
    trigger: 'publish',
    subjectType: 'roster',
    subjectId: versionId,
    siteId: version.site_id,
    rosterVersionId: versionId,
    timeZone: version.timezone,
  });
  for (const f of publishResult.failed) {
    issues.push({ severity: f.severity, scope: 'publish', who: 'פרסום', ruleName: f.name, message: f.message });
  }

  const openExceptions = await tx.query(
    `select id, summary from exception_requests
      where subject_type = 'roster' and status = 'pending' and deleted_at is null and site_id = $1`,
    [version.site_id],
  );

  return { assignmentCount: assignments.length, issues, openExceptions };
}

/** צילום הגרסה: שמות ומבנה כפי שהיו ברגע הפרסום (§12) */
async function buildSnapshot(tx, version) {
  const [site] = await tx.query('select id, name, timezone, open_time, close_time from sites where id = $1', [
    version.site_id,
  ]);
  const [shiftTypes, locations, assignments] = await Promise.all([
    tx.query(
      `select id, location_id, name, start_time, end_time, is_mandatory, required_staff
         from shift_types where site_id = $1 and deleted_at is null`,
      [version.site_id],
    ),
    tx.query('select id, name from locations where site_id = $1 and deleted_at is null', [version.site_id]),
    tx.query(
      `select ra.id, ra.assignment_date, ra.start_time, ra.end_time, ra.starts_at, ra.ends_at,
              ra.location_id, ra.shift_type_id, ra.user_id, ra.domain_id, ra.note,
              p.full_name as user_name
         from roster_assignments ra join profiles p on p.id = ra.user_id
        where ra.version_id = $1 and ra.deleted_at is null`,
      [version.id],
    ),
  ]);

  return {
    version: version.version_number,
    weekStart: version.week_start,
    publishedAt: new Date().toISOString(),
    site,
    shiftTypes,
    locations,
    assignments,
  };
}

/* ───────────────────────── תצוגות נגזרות ───────────────────────── */

/** הסידור שלי — מגרסאות שפורסמו בלבד */
export async function mine(userId, { from, to }) {
  return query(
    `select ra.id, ra.assignment_date, ra.start_time, ra.end_time, ra.starts_at, ra.ends_at,
            l.name as location_name, s.name as site_name, st.name as shift_name,
            d.name as domain_name, v.version_number
       from roster_assignments ra
       join roster_versions v on v.id = ra.version_id
       join sites s on s.id = ra.site_id
       join locations l on l.id = ra.location_id
       left join shift_types st on st.id = ra.shift_type_id
       left join domains d on d.id = ra.domain_id
      where ra.user_id = $1 and ra.deleted_at is null
        and v.status = 'published' and v.deleted_at is null
        and ($2::date is null or ra.assignment_date >= $2)
        and ($3::date is null or ra.assignment_date <= $3)
      order by ra.assignment_date, ra.start_time`,
    [userId, from ?? null, to ?? null],
  );
}

/** שורות לייצוא CSV */
export async function exportRows(versionId) {
  const rows = await query(
    `select ra.assignment_date, l.name as location_name, st.name as shift_name,
            ra.start_time, ra.end_time, p.full_name, d.name as domain_name,
            sc.name as sub_category_name
       from roster_assignments ra
       join profiles p on p.id = ra.user_id
       join locations l on l.id = ra.location_id
       left join shift_types st on st.id = ra.shift_type_id
       left join domains d on d.id = ra.domain_id
       left join sub_categories sc on sc.id = ra.sub_category_id
      where ra.version_id = $1 and ra.deleted_at is null
      order by ra.assignment_date, l.name, ra.start_time`,
    [versionId],
  );

  const DAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  return rows.map((r) => ({
    תאריך: r.assignment_date,
    יום: DAYS[new Date(`${r.assignment_date}T12:00:00Z`).getUTCDay()],
    מיקום: r.location_name,
    משמרת: r.shift_name ?? 'שעות מותאמות',
    שעות: `${r.start_time.slice(0, 5)}–${r.end_time.slice(0, 5)}`,
    מטמיע: r.full_name,
    תחום: r.domain_name ?? '',
    'תת-קטגוריה': r.sub_category_name ?? '',
  }));
}
