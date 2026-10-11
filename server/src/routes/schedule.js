import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { query } from '../lib/db.js';
import { uuid, dateStr } from '../schemas/common.schema.js';

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
             ra.note
        from roster_assignments ra
        join roster_versions v on v.id = ra.version_id
        join sites s on s.id = ra.site_id
        join locations l on l.id = ra.location_id
        left join shift_types st on st.id = ra.shift_type_id
       where ra.user_id = $1 and ra.deleted_at is null
         and v.status = 'published' and v.deleted_at is null
         and ra.assignment_date between $2 and $3

      union all

      select 'activity', a.id, a.activity_date, a.starts_at, a.ends_at,
             coalesce(nullif(btrim(a.title), ''), at.name_he),
             s.name, l.name, a.status, null
        from activities a
        join activity_participants ap on ap.activity_id = a.id and ap.user_id = $1
        join activity_types at on at.id = a.activity_type_id
        join sites s on s.id = a.site_id
        left join locations l on l.id = a.location_id
       where a.deleted_at is null
         and a.visibility = 'participants'
         and a.status in ('scheduled','completed')
         and a.activity_date between $2 and $3

      union all

      select 'constraint', cr.id, cr.constraint_date, cr.starts_at, cr.ends_at,
             ct.name_he, null, null, cr.status::text, null
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
 * לו״ז צוותי.
 *
 * קורא מ-v_team_schedule, שבו מזעור המידע נאכף במקום אחד: אין סיבות
 * אילוץ, אין הערות פרטיות ואין טיוטות סידור (§7, §14).
 * השדות המוצגים נקבעים בהגדרות ולא בקוד.
 */
scheduleRouter.get(
  '/team',
  requirePermission('teamSchedule', 'view', (req) => ({ siteId: req.query.siteId })),
  validate({
    query: z
      .object({
        siteId: uuid,
        date: dateStr.optional(),
        from: dateStr.optional(),
        to: dateStr.optional(),
        domainId: uuid.optional(),
        // מדריך: רק המטמיעים שמשויכים אליו
        mine: z.enum(['1', '0', 'true', 'false']).optional().transform((v) => v === '1' || v === 'true'),
      })
      .refine((v) => v.date || (v.from && v.to), { message: 'יש לבחור תאריך או טווח', path: ['date'] }),
  }),
  async (req, res) => {
    const { siteId, domainId, mine } = req.validQuery;
    const from = req.validQuery.from ?? req.validQuery.date;
    const to = req.validQuery.to ?? req.validQuery.date;

    const [setting] = await query(
      `select value from app_settings where key = 'team_schedule_fields'`,
    );
    const allowed = new Set(setting?.value ?? ['name', 'activity', 'site', 'status']);

    const rows = await query(
      `select entry_date::text as entry_date, person_name, activity_name, location_name,
              site_id, domain_name, starts_at, ends_at, status_he, kind
         from v_team_schedule
        where site_id = $1 and entry_date between $2::date and $3::date
          and $3::date - $2::date <= 31
          and ($4::uuid is null or domain_id = $4)
          and (not $5 or user_id = any($6::uuid[]))
        order by entry_date, starts_at, person_name`,
      [siteId, from, to, domainId ?? null, mine, req.user.scopes.assignedUserIds],
    );

    // רק השדות שהותרו יוצאים מהשרת — הסתרה בלקוח אינה מזעור מידע
    const entries = rows.map((r) => ({
      date: r.entry_date,
      ...(allowed.has('name') ? { name: r.person_name } : {}),
      ...(allowed.has('activity') ? { activity: r.activity_name } : {}),
      ...(allowed.has('site') ? { location: r.location_name } : {}),
      ...(allowed.has('status') ? { status: r.status_he } : {}),
      ...(allowed.has('time')
        ? { time: `${fmt(r.starts_at)}–${fmt(r.ends_at)}` }
        : {}),
      ...(allowed.has('domain') ? { domain: r.domain_name } : {}),
      kind: r.kind,
    }));

    res.json({ date: from, from, to, fields: [...allowed], entries });
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
