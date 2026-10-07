import { toInstants, weekStartOf, addDays, overlaps } from '../lib/time.js';

/**
 * טעינת העובדות שהחוקים נבדקים מולן — בסבב אחד, לפני הערכת החוקים.
 *
 * כל התנאים הם פונקציות טהורות שמקבלות את אוסף העובדות הזה, ולכן ניתן
 * לבדוק אותם ביחידה בלי מסד נתונים, ואין סכנה ש-14 תנאים יריצו 14 שאילתות.
 *
 * נטענות רק העובדות שהחוקים הפעילים באמת צריכים.
 */

const NEEDS = {
  noOverlap: ['commitments'],
  maxHoursPerDay: ['commitments'],
  minRestHours: ['commitments'],
  maxConsecutiveHours: [],
  withinSiteHours: ['site'],
  minNoticeDays: [],
  maxConstraintsPerWeek: ['constraintsThisWeek'],
  requiresQualification: ['qualifications'],
  mentorRatio: ['mentorLoad'],
  mandatoryTraining: ['completedTraining'],
  availabilityRequired: ['availability'],
  deadline: [],
  blackoutDates: [],
  minStaffCoverage: ['coverage'],
};

export function factsNeededFor(conditionCodes) {
  return new Set(conditionCodes.flatMap((c) => NEEDS[c] ?? []));
}

/**
 * @param {object} tx   טרנזקציה פתוחה (או מודול db)
 * @param {object} ctx  הקשר ההערכה
 * @param {Set<string>} needed
 */
export async function loadFacts(tx, ctx, needed) {
  const facts = {};
  const jobs = [];

  if (needed.has('commitments') && ctx.targetUserId) {
    jobs.push(
      loadCommitments(tx, ctx).then((v) => {
        facts.commitments = v;
      }),
    );
  }

  if (needed.has('site') && ctx.siteId) {
    jobs.push(
      tx
        .query(
          `select id, name, open_time, close_time, timezone,
                  availability_max_cannot, availability_max_prefer_not
             from sites where id = $1 and deleted_at is null`,
          [ctx.siteId],
        )
        .then(([row]) => {
          facts.site = row ?? null;
        }),
    );
  }

  if (needed.has('constraintsThisWeek') && ctx.targetUserId && ctx.startsAt) {
    const week = weekStartOf(ctx.startsAt.toISOString().slice(0, 10));
    jobs.push(
      tx
        .query(
          `select count(*)::int as n
             from constraint_requests
            where user_id = $1
              and deleted_at is null
              and status in ('submitted','approved')
              and ($3::uuid is null or id <> $3)
              and constraint_date >= $2::date
              and constraint_date <  $2::date + 7`,
          [ctx.targetUserId, week, ctx.excludeId ?? null],
        )
        .then(([row]) => {
          facts.constraintsThisWeek = row?.n ?? 0;
        }),
    );
  }

  if (needed.has('qualifications') && ctx.targetUserId) {
    jobs.push(
      tx
        .query(
          `select q.sub_category_id, sc.name
             from qualifications q
             join sub_categories sc on sc.id = q.sub_category_id
            where q.user_id = $1 and q.deleted_at is null
              and (q.valid_to is null or q.valid_to >= current_date)`,
          [ctx.targetUserId],
        )
        .then((rows) => {
          facts.qualifications = rows;
        }),
    );
  }

  if (needed.has('mentorLoad') && ctx.mentorUserId) {
    jobs.push(
      tx
        .query(
          `select count(*)::int as n
             from mentor_assignments
            where mentor_user_id = $1 and deleted_at is null
              and span @> current_date`,
          [ctx.mentorUserId],
        )
        .then(([row]) => {
          facts.mentorLoad = row?.n ?? 0;
        }),
    );
  }

  if (needed.has('completedTraining') && ctx.targetUserId) {
    jobs.push(
      tx
        .query(
          `select distinct a.activity_type_id
             from activity_participants ap
             join activities a on a.id = ap.activity_id
            where ap.user_id = $1
              and a.status = 'completed'
              and a.deleted_at is null
              and ap.attendance in ('attended','confirmed')`,
          [ctx.targetUserId],
        )
        .then((rows) => {
          facts.completedTraining = rows.map((r) => r.activity_type_id);
        }),
    );
  }

  if (needed.has('availability') && ctx.targetUserId && ctx.startsAt) {
    jobs.push(loadAvailability(tx, ctx).then((v) => { facts.availability = v; }));
  }

  if (needed.has('coverage') && ctx.rosterVersionId) {
    jobs.push(loadCoverage(tx, ctx).then((v) => { facts.coverage = v; }));
  }

  await Promise.all(jobs);
  return facts;
}

/**
 * כל מה שתופס לאדם זמן בטווח הנבדק: שיבוצים, פעילויות ואילוצים.
 *
 * שיבוצים נלקחים מגרסאות שפורסמו ומהגרסה שנערכת כרגע — ורק מהן. זהו
 * התיקון לבאג שבו סריקת ההתנגשויות התעלמה מ-version_id, ולכן טיוטה
 * "התנגשה" עם העותק שלה שכבר פורסם.
 */
async function loadCommitments(tx, ctx) {
  const rows = await tx.query(
    `
    -- שיבוצים בסידור
    select 'shift' as kind, ra.id, ra.starts_at, ra.ends_at, true as counts_as_work,
           coalesce(st.name, 'משמרת') as label, s.name as site_name
      from roster_assignments ra
      join roster_versions rv on rv.id = ra.version_id
      join sites s on s.id = ra.site_id
      left join shift_types st on st.id = ra.shift_type_id
     where ra.user_id = $1
       and ra.deleted_at is null
       and rv.deleted_at is null
       and (rv.status = 'published' or rv.id = $3::uuid)
       and ($2::uuid is null or ra.id <> $2)

    union all

    -- פעילויות: כמשתתף או כמדריך אחראי
    select 'activity', a.id, a.starts_at, a.ends_at, true,
           coalesce(nullif(btrim(a.title), ''), at.name_he), s.name
      from activities a
      join activity_types at on at.id = a.activity_type_id
      join sites s on s.id = a.site_id
     where a.deleted_at is null
       and a.status in ('scheduled','pending_approval','completed')
       and ($2::uuid is null or a.id <> $2)
       and (a.owner_user_id = $1
            or exists (select 1 from activity_participants ap
                        where ap.activity_id = a.id and ap.user_id = $1))

    union all

    -- אילוצים מאושרים או ממתינים: תופסים זמן, אך אינם שעות עבודה
    select 'constraint', cr.id, cr.starts_at, cr.ends_at, false,
           ct.name_he, null
      from constraint_requests cr
      join constraint_types ct on ct.id = cr.constraint_type_id
     where cr.user_id = $1
       and cr.deleted_at is null
       and cr.status in ('submitted','approved')
       and ($2::uuid is null or cr.id <> $2)
    `,
    [ctx.targetUserId, ctx.excludeId ?? null, ctx.rosterVersionId ?? null],
  );

  return rows.map((r) => ({
    kind: r.kind,
    id: r.id,
    startsAt: new Date(r.starts_at),
    endsAt: new Date(r.ends_at),
    countsAsWork: r.counts_as_work,
    label: r.label,
    siteName: r.site_name,
  }));
}

const AVAIL_RANK = { can: 0, prefer_not: 1, cannot: 2 };

/**
 * הזמינות של האדם לחלון השיבוץ.
 *
 * מחזיר { declared, worst, status }:
 *   declared — האם הוגשה הצהרה לשבוע הזה בכלל
 *   worst    — הערך המחמיר מבין התאים שחופפים לשיבוץ; בלי תא חופף = "יכול"
 *
 * תאי "יכול" אינם נשמרים (זו ברירת המחדל), ולכן היעדר תא אינו "לא הוצהר".
 * הבלבול בין השניים גרם בעבר לאזהרת זמינות אצל מי שהצהיר שהוא זמין לגמרי.
 *
 * ההשוואה היא חפיפה של רגעים ולא התאמה מדויקת של שעות: כך גם שיבוץ בשעות
 * מותאמות אישית נבדק, ותא של לילה שהתחיל אתמול נתפס כשהוא נמשך אל הבוקר.
 */
async function loadAvailability(tx, ctx) {
  const date = ctx.localDate ?? ctx.startsAt.toISOString().slice(0, 10);
  const week = weekStartOf(date);

  const [declaration] = await tx.query(
    `select d.id, d.status::text as status, s.timezone
       from availability_declarations d
       join sites s on s.id = d.site_id
      where d.user_id = $1 and d.week_start = $2
        and ($3::uuid is null or d.site_id = $3)
        and d.superseded_at is null and d.deleted_at is null
      order by d.revision desc limit 1`,
    [ctx.targetUserId, week, ctx.siteId ?? null],
  );
  if (!declaration) return { declared: false, worst: null, status: null };

  // גם היום הקודם: תא לילה שלו עשוי להימשך אל תוך השיבוץ
  const cells = await tx.query(
    `select cell_date, start_time, end_time, value::text as value
       from availability_cells
      where declaration_id = $1 and cell_date between $2::date and $3::date`,
    [declaration.id, addDays(date, -1), date],
  );

  let worst = 'can';
  for (const cell of cells) {
    const range = toInstants(cell.cell_date, cell.start_time, cell.end_time, declaration.timezone);
    if (!overlaps(range.startsAt, range.endsAt, ctx.startsAt, ctx.endsAt)) continue;
    if (AVAIL_RANK[cell.value] > AVAIL_RANK[worst]) worst = cell.value;
  }

  return { declared: true, worst, status: declaration.status };
}

/** כיסוי כוח אדם לכל משמרת בסידור — מזין את minStaffCoverage */
async function loadCoverage(tx, ctx) {
  const rows = await tx.query(
    `
    with version as (
      select id, site_id, week_start from roster_versions where id = $1
    ),
    days as (
      select (v.week_start + offs)::date as d, v.site_id, v.id as version_id
        from version v, generate_series(0, 6) as offs
    )
    select days.d                       as assignment_date,
           st.id                        as shift_type_id,
           st.name                      as shift_name,
           l.name                       as location_name,
           st.required_staff,
           count(ra.id)::int            as assigned
      from days
      join shift_types st
        on st.site_id = days.site_id and st.deleted_at is null and st.is_active
      join locations l
        on l.id = st.location_id and l.deleted_at is null and l.is_active
      left join roster_assignments ra
        on ra.version_id = days.version_id
       and ra.assignment_date = days.d
       and ra.shift_type_id = st.id
       and ra.deleted_at is null
     group by days.d, st.id, st.name, l.name, st.required_staff, st.display_order
     order by days.d, l.name, st.display_order
    `,
    [ctx.rosterVersionId],
  );
  return rows;
}

/** עזר לתנאים: הופך תאריך+שעות לרגעים, עם טיפול בחציית חצות */
export { toInstants };
