import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { query } from '../lib/db.js';
import { uuid, dateStr } from '../schemas/common.schema.js';
import { sendCsv } from '../lib/csv.js';
import { recordExport } from '../audit/service.js';

export const scheduleRouter = Router();
scheduleRouter.use(requireAuth);

/**
 * הלו״ז האישי: שיבוצים מגרסאות שפורסמו, פעילויות שאני משתתף בהן,
 * ואילוצים שלי. חפיפות מסומנות כדי שהמשתמש יראה בעיה לפני שהיא קורית.
 */
scheduleRouter.get(
  '/me',
  requirePermission('roster', 'view', (req) => ({ targetUserId: req.user.userId })),
  validate({ query: z.object({ from: dateStr, to: dateStr, userId: uuid.optional() }) }),
  async (req, res) => {
    const { from, to } = req.validQuery;
    const target = req.validQuery.userId ?? req.user.userId;

    if (target !== req.user.userId) {
      const { decide } = await import('../permissions/engine.js');
      if (!decide(req.user, 'roster', 'view', { targetUserId: target }).allowed) {
        const { AppError } = await import('../lib/errors.js');
        throw new AppError('E_FORBIDDEN', 'אין לך הרשאה לצפות בלו״ז של משתמש זה');
      }
    }

    const items = await query(
      `
      select 'shift' as kind, ra.id, ra.assignment_date as entry_date,
             ra.starts_at, ra.ends_at,
             coalesce(st.name, 'משמרת') as title,
             s.name as site_name, l.name as location_name, 'published' as status,
             ra.note, false as as_instructor
        from roster_assignments ra
        join roster_versions v on v.id = ra.version_id
        join sites s on s.id = ra.site_id
        join locations l on l.id = ra.location_id
        left join shift_types st on st.id = ra.shift_type_id
       where ra.user_id = $1 and ra.deleted_at is null
         and v.status = 'published' and v.deleted_at is null
         and ra.assignment_date between $2 and $3

      union all

      -- פעילויות שהמשתמש משתתף בהן, ופעילויות שהוא המדריך שמעביר אותן
      select 'activity', a.id, a.activity_date, a.starts_at, a.ends_at,
             coalesce(nullif(btrim(a.title), ''), at.name_he),
             s.name, l.name, a.status, null, coalesce(a.owner_user_id = $1, false)
        from activities a
        left join activity_participants ap on ap.activity_id = a.id and ap.user_id = $1
        join activity_types at on at.id = a.activity_type_id
        join sites s on s.id = a.site_id
        left join locations l on l.id = a.location_id
       where a.deleted_at is null
         and ((ap.user_id is not null and a.visibility = 'participants') or a.owner_user_id = $1)
         and a.status in ('scheduled','completed')
         and a.activity_date between $2 and $3

      union all

      select 'constraint', cr.id, cr.constraint_date, cr.starts_at, cr.ends_at,
             ct.name_he, null, null, cr.status::text, null, false
        from constraint_requests cr
        join constraint_types ct on ct.id = cr.constraint_type_id
       where cr.user_id = $1 and cr.deleted_at is null
         and cr.status in ('submitted','approved')
         and cr.constraint_date between $2 and $3

      order by starts_at
      `,
      [target, from, to],
    );

    // סימון חפיפות. שני אילוצים חופפים אינם בעיה, ולכן מוחרגים.
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i];
        const b = items[j];
        if (a.kind === 'constraint' && b.kind === 'constraint') continue;
        if (new Date(a.starts_at) < new Date(b.ends_at) && new Date(b.starts_at) < new Date(a.ends_at)) {
          a.overlap = true;
          b.overlap = true;
        }
      }
    }

    res.json({ items });
  },
);

/**
 * פירוט פעילות מהלו״ז האישי: מה, איפה, מי מעביר, מי המלווים ומי עוד משובץ.
 * פתוח למי שמשתתף בפעילות או מעביר אותה, ולמי שרשאי לראות את הפעילויות באתר.
 */
scheduleRouter.get(
  '/me/activity/:id',
  requirePermission('roster', 'view', (req) => ({ targetUserId: req.user.userId })),
  validate({ params: z.object({ id: uuid }) }),
  async (req, res) => {
    const { AppError } = await import('../lib/errors.js');
    const [activity] = await query(
      `select a.id, a.site_id, a.title, a.description, a.notes, a.activity_date, a.starts_at, a.ends_at,
              a.status, a.visibility::text as visibility, a.owner_user_id,
              at.name_he as type_name, s.name as site_name, l.name as location_name,
              d.name as domain_name, sc.name as sub_category_name,
              owner.full_name as owner_name, owner.phone as owner_phone,
              exists (select 1 from activity_participants ap
                       where ap.activity_id = a.id and ap.user_id = $2) as is_participant
         from activities a
         join activity_types at on at.id = a.activity_type_id
         join sites s on s.id = a.site_id
         left join locations l on l.id = a.location_id
         left join domains d on d.id = a.domain_id
         left join sub_categories sc on sc.id = a.sub_category_id
         left join profiles owner on owner.id = a.owner_user_id
        where a.id = $1 and a.deleted_at is null`,
      [req.params.id, req.user.userId],
    );
    if (!activity) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');

    const mine = activity.is_participant || activity.owner_user_id === req.user.userId;
    if (!mine) {
      const { decide } = await import('../permissions/engine.js');
      if (!decide(req.user, 'activities', 'view', { siteId: activity.site_id }).allowed
          || (activity.visibility === 'managers_only' && req.user.baseRole !== 'manager')) {
        throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');
      }
    }

    const participants = await query(
      `select p.id, p.full_name, p.base_role::text as base_role, ap.attendance
         from activity_participants ap join profiles p on p.id = ap.user_id
        where ap.activity_id = $1 and p.deleted_at is null
        order by p.base_role in ('mentor', 'manager') desc, p.full_name`,
      [req.params.id],
    );
    // מלווים: מדריכים שמשתתפים בפעילות, והמדריכים (ראשי ותומכים) של המשתתפים
    const mentors = await query(
      `select distinct p.id, p.full_name, bool_or(ma.is_primary) as is_primary
         from mentor_assignments ma join profiles p on p.id = ma.mentor_user_id
        where ma.implementer_user_id = any($1::uuid[]) and ma.deleted_at is null
          and ma.span @> current_date and p.deleted_at is null and p.id <> coalesce($2, '00000000-0000-0000-0000-000000000000'::uuid)
        group by p.id, p.full_name
        order by p.full_name`,
      [participants.filter((p) => !['mentor', 'manager'].includes(p.base_role)).map((p) => p.id), activity.owner_user_id],
    );
    const leadingMentors = participants.filter((p) => p.base_role === 'mentor' && p.id !== activity.owner_user_id);
    const team = participants.filter((p) => !['mentor', 'manager'].includes(p.base_role));
    const materials = await query(
      'select id, title, url, note from activity_materials where activity_id = $1', [req.params.id],
    );

    res.json({
      activity,
      team,
      mentors: [
        ...leadingMentors.map((m) => ({ id: m.id, full_name: m.full_name, role: 'משתתף כמלווה' })),
        ...mentors.filter((m) => !leadingMentors.some((l) => l.id === m.id))
          .map((m) => ({ id: m.id, full_name: m.full_name, role: m.is_primary ? 'מדריך ראשי' : 'מדריך תומך' })),
      ],
      materials,
    });
  },
);

/**
 * לו״ז צוותי.
 *
 * קורא מ-v_team_schedule, שבו מזעור המידע נאכף במקום אחד: אין סיבות
 * אילוץ, אין הערות פרטיות ואין טיוטות סידור (§7, §14).
 * השדות המוצגים נקבעים בהגדרות ולא בקוד.
 */
const teamQuery = z
  .object({
    siteId: uuid,
    date: dateStr.optional(),
    from: dateStr.optional(),
    to: dateStr.optional(),
    domainId: uuid.optional(),
    // מדריך: רק המטמיעים שמשויכים אליו
    mine: z.enum(['1', '0', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true'),
  })
  .refine((v) => v.date || (v.from && v.to), { message: 'יש לבחור תאריך או טווח', path: ['date'] });

/** הרשומות של הלו״ז הצוותי — רק השדות שהותרו בהגדרות יוצאים מכאן */
async function loadTeam(req, q) {
  const { siteId, domainId, mine } = q;
  const from = q.from ?? q.date;
  const to = q.to ?? q.date;

  const [setting] = await query(
    `select value from app_settings where key = 'team_schedule_fields'`,
  );
  const allowed = new Set(setting?.value ?? ['name', 'activity', 'site', 'status']);

  // מדריכים ומנהלים אינם חלק מהצוות שמשובץ — הם מלווים, ומוצגים בנפרד (leads)
  const rows = await query(
    `select v.entry_date::text as entry_date, v.user_id, v.person_name, v.activity_name, v.location_name,
            v.site_id, v.domain_name, v.starts_at, v.ends_at, v.status_he, v.kind
       from v_team_schedule v
       join profiles p on p.id = v.user_id
      where v.site_id = $1 and v.entry_date between $2::date and $3::date
        and $3::date - $2::date <= 31
        and ($4::uuid is null or v.domain_id = $4)
        and (not $5 or v.user_id = any($6::uuid[]))
        and p.base_role in ('implementer', 'lead')
      order by v.entry_date, v.starts_at, v.person_name`,
    [siteId, from, to, domainId ?? null, mine, req.user.scopes.assignedUserIds],
  );

  // מלווים לפי יום ותחום: מי שמעביר פעילויות באתר באותו יום, ומדריכים שמשתתפים בהן
  const leadRows = !allowed.has('name') ? [] : await query(
    `select distinct a.activity_date::text as date, p.id as person_id, p.full_name as name,
            coalesce(d.name, 'כללי') as domain
       from activities a
       join profiles p on p.id = a.owner_user_id
       left join domains d on d.id = a.domain_id
      where a.site_id = $1 and a.activity_date between $2::date and $3::date
        and a.deleted_at is null and a.status in ('scheduled', 'completed')
        and a.visibility = 'participants'
        and ($4::uuid is null or a.domain_id = $4)
     union
     select a.activity_date::text, p.id, p.full_name, coalesce(d.name, 'כללי')
       from activities a
       join activity_participants ap on ap.activity_id = a.id
       join profiles p on p.id = ap.user_id and p.base_role in ('mentor', 'manager')
       left join domains d on d.id = a.domain_id
      where a.site_id = $1 and a.activity_date between $2::date and $3::date
        and a.deleted_at is null and a.status in ('scheduled', 'completed')
        and a.visibility = 'participants'
        and ($4::uuid is null or a.domain_id = $4)
     order by 1, 4, 3`,
    [siteId, from, to, domainId ?? null],
  );

  // רק השדות שהותרו יוצאים מהשרת — הסתרה בלקוח אינה מזעור מידע.
  // מזהה האדם יוצא רק כשהשם מותר: הוא מה שמאפשר תצוגת מטריצה.
  const entries = rows.map((r) => ({
    date: r.entry_date,
    ...(allowed.has('name') ? { personId: r.user_id, name: r.person_name } : {}),
    ...(allowed.has('activity') ? { activity: r.activity_name } : {}),
    ...(allowed.has('site') ? { location: r.location_name } : {}),
    ...(allowed.has('status') ? { status: r.status_he } : {}),
    ...(allowed.has('time')
      ? { time: `${fmt(r.starts_at)}–${fmt(r.ends_at)}` }
      : {}),
    ...(allowed.has('domain') ? { domain: r.domain_name } : {}),
    kind: r.kind,
  }));

  const leads = leadRows.map((r) => ({ date: r.date, personId: r.person_id, name: r.name, domain: r.domain }));
  return { from, to, fields: [...allowed], entries, leads };
}

/**
 * לו״ז צוותי.
 *
 * קורא מ-v_team_schedule, שבו מזעור המידע נאכף במקום אחד: אין סיבות
 * אילוץ, אין הערות פרטיות ואין טיוטות סידור (§7, §14).
 * השדות המוצגים נקבעים בהגדרות ולא בקוד.
 */
scheduleRouter.get(
  '/team',
  requirePermission('teamSchedule', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: teamQuery }),
  async (req, res) => {
    const team = await loadTeam(req, req.validQuery);
    res.json({ date: team.from, ...team });
  },
);

const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
const LIST_LABELS = { name: 'שם', activity: 'פעילות', location: 'מיקום', time: 'שעות', domain: 'תחום', status: 'סטטוס' };

/** פריט אחד בתא של המטריצה: "08:00–14:00 הדרכה · מיון" */
const cellText = (e) =>
  [e.time, [e.activity, e.location].filter(Boolean).join(' · ') || e.status].filter(Boolean).join(' ');

/**
 * ייצוא הלו״ז הצוותי ל-CSV — כרשימה, או כמטריצה של אנשים × ימים.
 * אותם שדות בדיוק כמו במסך.
 */
scheduleRouter.get(
  '/team/export',
  requirePermission('teamSchedule', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({ query: teamQuery.and(z.object({ layout: z.enum(['matrix', 'list']).default('list') })) }),
  async (req, res) => {
    const { from, to, fields, entries, leads } = await loadTeam(req, req.validQuery);
    const layout = fields.includes('name') ? req.validQuery.layout : 'list';

    let rows;
    if (layout === 'matrix') {
      const days = [];
      for (let d = new Date(`${from}T12:00:00Z`); d <= new Date(`${to}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1)) {
        days.push(d.toISOString().slice(0, 10));
      }
      const dayLabel = (iso) => `${DAY_NAMES[new Date(`${iso}T12:00:00Z`).getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}`;
      const people = new Map();
      for (const e of entries) if (!people.has(e.personId)) people.set(e.personId, e.name);
      const leadRow = leads.length ? [{
        שם: 'מלווים',
        ...Object.fromEntries(days.map((d) => [
          dayLabel(d),
          leads.filter((l) => l.date === d).map((l) => `${l.domain}: ${l.name}`).join('\n'),
        ])),
      }] : [];
      rows = [...leadRow, ...[...people.entries()]
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]), 'he'))
        .map(([personId, name]) => ({
          שם: name,
          ...Object.fromEntries(days.map((d) => [
            dayLabel(d),
            entries.filter((e) => e.personId === personId && e.date === d).map(cellText).join('\n'),
          ])),
        }))];
    } else {
      const keys = Object.keys(LIST_LABELS).filter(
        (k) => fields.includes(k) || (k === 'location' && fields.includes('site')),
      );
      rows = entries.map((e) => ({
        תאריך: e.date,
        ...Object.fromEntries(keys.map((k) => [LIST_LABELS[k], e[k] ?? ''])),
      }));
    }

    await recordExport(req, { entityType: 'team_schedule', filters: req.validQuery, rowCount: rows.length });
    sendCsv(res, `לוז-צוות-${from}${to !== from ? `-${to}` : ''}.csv`, rows);
  },
);

/** האתרים שאפשר לראות בהם לו״ז צוות — כולל אתרים שבאחריות המדריך */
scheduleRouter.get(
  '/team/sites',
  requirePermission('teamSchedule', 'view'),
  async (req, res) => {
    const isManager = req.user.baseRole === 'manager';
    const sites = await query(
      `select s.id, s.name from sites s
        where s.deleted_at is null and not s.is_archived
          and ($1 or s.id = any($2::uuid[]))
        order by s.name`,
      [isManager, req.user.scopes.siteIds],
    );
    res.json({ sites });
  },
);

const fmt = (iso) =>
  new Intl.DateTimeFormat('he-IL', {
    timeZone: 'Asia/Jerusalem',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
