import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db.js';
import { toInstants, weekDays, addDays } from '../lib/time.js';
import { AppError } from '../lib/errors.js';
import { evaluateAndExecute } from '../rules/exceptions.js';
import { registerAction } from '../rules/actions.js';
import { notify } from '../notifications/service.js';
import { assertIfMatch } from '../lib/etag.js';

/**
 * פעילויות: הדרכות, תצפיות ותרגולים.
 *
 * קהל היעד נפתר לרשימת משתתפים ברגע השמירה, ולא בכל קריאה. זה מה שהופך
 * את "הלו״ז שלי", את פיזור ההתראות ואת חוק mandatoryTraining ל-join אחד
 * מאונדקס במקום סריקה של קהלי יעד בזמן אמת.
 */

const SELECT = `
  select a.id, a.site_id, a.location_id, a.activity_type_id, a.title, a.description,
         a.activity_date, a.start_time, a.end_time, a.starts_at, a.ends_at,
         a.audience::text as audience, a.visibility::text as visibility, a.status,
         a.owner_user_id, a.domain_id, a.sub_category_id, a.prep_done, a.notes,
         a.row_version, a.series_id,
         case when a.series_id is not null then
           (select count(*)::int from activities s2
             where s2.series_id = a.series_id and s2.deleted_at is null) end as series_count,
         case when a.series_id is not null then
           (select count(*)::int from activities s2
             where s2.series_id = a.series_id and s2.deleted_at is null
               and s2.activity_date <= a.activity_date) end as series_index,
         at.name_he as type_name, at.code as type_code,
         s.name as site_name, l.name as location_name, d.name as domain_name,
         owner.full_name as owner_name,
         (select count(*)::int from activity_participants ap
           where ap.activity_id = a.id) as participant_count
    from activities a
    join activity_types at on at.id = a.activity_type_id
    join sites s on s.id = a.site_id
    left join locations l on l.id = a.location_id
    left join domains d on d.id = a.domain_id
    left join profiles owner on owner.id = a.owner_user_id
   where a.deleted_at is null`;

export async function list(principal, filters = {}) {
  const isManager = principal.baseRole === 'manager';
  return query(
    `${SELECT}
       and ($1 or a.site_id = any($2::uuid[]) or a.owner_user_id = $3
            or exists (select 1 from activity_participants ap
                        where ap.activity_id = a.id
                          and (ap.user_id = $3 or ap.user_id = any($4::uuid[]))))
       -- פעילות "למנהלים בלבד" או טיוטה אינה נחשפת למשתתפים (§7)
       and ($1 or a.visibility <> 'managers_only')
       and ($5::uuid is null or a.site_id = $5)
       and ($6::date is null or a.activity_date >= $6)
       and ($7::date is null or a.activity_date <= $7)
       and ($8::uuid is null or a.activity_type_id = $8)
       and ($9::text is null or a.status = $9)
     order by a.activity_date, a.start_time
     limit $10`,
    [
      isManager, principal.scopes.siteIds, principal.userId, principal.scopes.assignedUserIds,
      filters.siteId ?? null, filters.from ?? null, filters.to ?? null,
      filters.typeId ?? null, filters.status ?? null, filters.limit ?? 200,
    ],
  );
}

export async function get(id) {
  const [activity] = await query(`${SELECT} and a.id = $1`, [id]);
  if (!activity) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');

  const [participants, audience, materials] = await Promise.all([
    query(
      `select ap.user_id, ap.source, ap.attendance, p.full_name
         from activity_participants ap join profiles p on p.id = ap.user_id
        where ap.activity_id = $1 order by p.full_name`,
      [id],
    ),
    query(
      `select audience::text as audience, target_id from activity_audience where activity_id = $1`,
      [id],
    ),
    query('select id, title, url, note from activity_materials where activity_id = $1', [id]),
  ]);

  return { activity, participants, audience, materials };
}

/**
 * פותר קהל יעד לרשימת משתמשים קונקרטית.
 * מוגבל למטמיעים ולמובילים הפעילים באתר.
 */
async function resolveAudience(tx, { siteId, audience, targetIds }) {
  switch (audience) {
    case 'all':
      return tx.query(
        `select p.id from profiles p
           join site_assignments sa on sa.user_id = p.id
          where sa.site_id = $1 and sa.deleted_at is null and sa.span @> current_date
            and p.status = 'active' and p.deleted_at is null
            and p.base_role in ('implementer','lead')`,
        [siteId],
      );

    case 'site':
      return tx.query(
        `select p.id from profiles p
           join site_assignments sa on sa.user_id = p.id
          where sa.site_id = any($1::uuid[]) and sa.deleted_at is null
            and sa.span @> current_date
            and p.status = 'active' and p.deleted_at is null
            and p.base_role in ('implementer','lead')`,
        [targetIds],
      );

    case 'domain':
      return tx.query(
        `select distinct p.id from profiles p
           join user_domains ud on ud.user_id = p.id and ud.deleted_at is null
           join site_assignments sa on sa.user_id = p.id and sa.site_id = $2
                and sa.deleted_at is null and sa.span @> current_date
          where ud.domain_id = any($1::uuid[])
            and p.status = 'active' and p.deleted_at is null`,
        [targetIds, siteId],
      );

    case 'sub_category':
      return tx.query(
        `select distinct p.id from profiles p
           join user_sub_categories usc on usc.user_id = p.id and usc.deleted_at is null
           join site_assignments sa on sa.user_id = p.id and sa.site_id = $2
                and sa.deleted_at is null and sa.span @> current_date
          where usc.sub_category_id = any($1::uuid[])
            and p.status = 'active' and p.deleted_at is null`,
        [targetIds, siteId],
      );

    case 'users':
    default:
      return tx.query(
        `select id from profiles
          where id = any($1::uuid[]) and status = 'active' and deleted_at is null`,
        [targetIds],
      );
  }
}

/** הימים שבטווח, לפי ימי השבוע שנבחרו (0 = ראשון) */
export function seriesDates(fromDate, untilDate, weekdays) {
  const dates = [];
  for (let d = fromDate; d <= untilDate; d = addDays(d, 1)) {
    const [y, m, day] = d.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, day)).getUTCDay();
    if (!weekdays?.length || weekdays.includes(weekday)) dates.push(d);
  }
  return dates;
}

/**
 * יצירה או עדכון של פעילות. עם untilDate (ביצירה בלבד) נוצרת פעילות לכל יום
 * בטווח, באותה טרנזקציה: אם יום אחד נחסם — שום יום לא נשמר.
 */
export async function save(actor, input, { req, traceId } = {}) {
  if (input.id || !input.untilDate || input.untilDate === input.activityDate) {
    return withTransaction({ actorId: actor.userId, traceId }, (tx) =>
      saveOne(tx, actor, input, { req, traceId }));
  }

  const dates = seriesDates(input.activityDate, input.untilDate, input.weekdays);
  if (dates.length === 0) throw new AppError('E_VALIDATION', 'אין בטווח שנבחר אף יום מימי השבוע שסומנו');
  if (dates.length === 1) {
    return withTransaction({ actorId: actor.userId, traceId }, (tx) =>
      saveOne(tx, actor, { ...input, activityDate: dates[0] }, { traceId }));
  }

  const seriesId = randomUUID();
  return withTransaction({ actorId: actor.userId, traceId }, async (tx) => {
    const results = [];
    for (const date of dates) {
      try {
        results.push(await saveOne(tx, actor, { ...input, activityDate: date, seriesId }, { traceId }));
      } catch (err) {
        if (err instanceof AppError) err.message = `${fmtDate(date)}: ${err.message}`;
        throw err;
      }
    }
    const pending = results.filter((r) => r.status === 'approval_required');
    return {
      status: pending.length ? 'approval_required' : results.some((r) => r.status === 'warning') ? 'warning' : 'ok',
      seriesId,
      count: results.length,
      created: results.filter((r) => r.data).length,
      exceptions: pending.flatMap((r) => r.exceptions),
      warnings: results.flatMap((r) => r.warnings ?? []),
      data: results[0].data,
    };
  });
}

const fmtDate = (d) => d.split('-').reverse().slice(0, 2).join('.');

async function saveOne(tx, actor, input, { req, traceId } = {}) {
  const site = await tx.required(
    'select id, timezone from sites where id = $1 and deleted_at is null',
    [input.siteId],
    'האתר המבוקש לא נמצא',
  );

  const { startsAt, endsAt } = toInstants(
    input.activityDate, input.startTime, input.endTime, site.timezone,
  );

  const payload = {
    ...input,
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    ownerId: input.ownerUserId ?? actor.userId,
  };

  if (input.id) {
    const current = await tx.lock('activities', input.id);
    if (!current || current.deleted_at) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');
    if (req) assertIfMatch(req, current);
  }

  // החוקים נבדקים מול כל משתתף — חפיפה של אדם אחד היא בעיה של הפעילות
  const audience = await resolveAudience(tx, {
    siteId: input.siteId,
    audience: input.audience,
    targetIds: input.targetIds ?? [],
  });

  if (audience.length === 0) {
    throw new AppError('E_VALIDATION', 'קהל היעד שנבחר אינו כולל אף משתתף');
  }

  return evaluateAndExecute(
    tx,
    {
      trigger: input.id ? 'change' : 'assign',
      subjectType: 'activity',
      subjectId: input.id ?? null,
      targetUserId: audience[0].id,
      siteId: input.siteId,
      domainId: input.domainId ?? null,
      startsAt,
      endsAt,
      localDate: input.activityDate,
      excludeId: input.id ?? null,
      timeZone: site.timezone,
    },
    {
      meta: { actorId: actor.userId, traceId },
      summary: `פעילות "${input.title ?? ''}" ב-${input.activityDate}`,
      action: {
        type: 'activities.save',
        payload: { ...payload, participantIds: audience.map((a) => a.id) },
      },
    },
  );
}

registerAction('activities.save', async (tx, payload, meta) => {
  const values = [
    payload.siteId, payload.locationId ?? null, payload.activityTypeId,
    payload.title ?? null, payload.description ?? null,
    payload.activityDate, payload.startTime, payload.endTime,
    payload.startsAt, payload.endsAt,
    payload.audience, payload.visibility ?? 'participants',
    payload.ownerId, payload.domainId ?? null, payload.subCategoryId ?? null,
    payload.notes ?? null, meta?.evaluationId ?? null,
  ];

  const [activity] = payload.id
    ? await tx.query(
        `update activities set
           site_id=$1, location_id=$2, activity_type_id=$3, title=$4, description=$5,
           activity_date=$6, start_time=$7, end_time=$8, starts_at=$9, ends_at=$10,
           audience=$11::audience_type, visibility=$12::visibility_type,
           owner_user_id=$13, domain_id=$14, sub_category_id=$15, notes=$16,
           rule_evaluation_id=coalesce($17, rule_evaluation_id)
         where id=$18 returning *`,
        [...values, payload.id],
      )
    : await tx.query(
        `insert into activities
           (site_id, location_id, activity_type_id, title, description,
            activity_date, start_time, end_time, starts_at, ends_at,
            audience, visibility, owner_user_id, domain_id, sub_category_id,
            notes, rule_evaluation_id, series_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::audience_type,$12::visibility_type,
                 $13,$14,$15,$16,$17,$18)
         returning *`,
        [...values, payload.seriesId ?? null],
      );

  // קהל היעד והמשתתפים נשמרים מחדש בכל שמירה
  await tx.query('delete from activity_audience where activity_id = $1', [activity.id]);
  if (payload.audience === 'all') {
    await tx.query(
      `insert into activity_audience (activity_id, audience) values ($1, 'all')`,
      [activity.id],
    );
  } else {
    for (const target of payload.targetIds ?? []) {
      await tx.query(
        `insert into activity_audience (activity_id, audience, target_id)
         values ($1, $2::audience_type, $3) on conflict do nothing`,
        [activity.id, payload.audience, target],
      );
    }
  }

  // משתתפים שנוספו ידנית נשמרים; רק המשתתפים שנגזרו מקהל היעד מוחלפים
  await tx.query(
    `delete from activity_participants where activity_id = $1 and source = 'audience'`,
    [activity.id],
  );
  for (const userId of payload.participantIds ?? []) {
    await tx.query(
      `insert into activity_participants (activity_id, user_id, source)
       values ($1, $2, 'audience') on conflict (activity_id, user_id) do nothing`,
      [activity.id, userId],
    );
  }

  if (activity.visibility === 'participants' && activity.status === 'scheduled') {
    await notify(tx, {
      typeCode: 'activity_changed',
      recipientIds: [...(payload.participantIds ?? []), activity.owner_user_id],
      title: payload.id ? 'פעילות עודכנה' : 'נקבעה פעילות חדשה',
      body: `${activity.title ?? ''} · ${activity.activity_date} ${activity.start_time.slice(0, 5)}`,
      entityType: 'activities',
      entityId: activity.id,
      dedupeKey: `activity:${activity.id}:${activity.updated_at ?? activity.created_at}`,
    });
  }

  return activity;
});

export async function setStatus(actor, id, status) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update activities set status = $2 where id = $1 and deleted_at is null returning *`,
      [id, status],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');

    // השלמת פעילות מסמנת את המשתתפים כמי שנכחו — זה מה שמזין את
    // חוק "הדרכת חובה הושלמה"
    if (status === 'completed') {
      await tx.query(
        `update activity_participants set attendance = 'attended', marked_by = $2, marked_at = now()
          where activity_id = $1 and attendance in ('invited','confirmed')`,
        [id, actor.userId],
      );
    }
    return row;
  });
}

export async function setPrep(actor, id, prepDone) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      'update activities set prep_done = $2 where id = $1 and deleted_at is null returning *',
      [id, prepDone],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');
    return row;
  });
}

export async function setAttendance(actor, id, entries) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    for (const e of entries) {
      await tx.query(
        `update activity_participants
            set attendance = $3, marked_by = $4, marked_at = now()
          where activity_id = $1 and user_id = $2`,
        [id, e.userId, e.attendance, actor.userId],
      );
    }
    return { updated: entries.length };
  });
}

/**
 * מחיקה לוגית: פעילות שהתקיימה היא חלק מההיסטוריה (§12).
 * עם series — כל הימים בסדרה שעוד לא הושלמו נמחקים יחד.
 */
export async function remove(actor, id, { series = false } = {}) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [target] = await tx.query(
      'select id, series_id from activities where id = $1 and deleted_at is null',
      [id],
    );
    if (!target) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');

    const rows = series && target.series_id
      ? await tx.query(
          `update activities set deleted_at = now(), deleted_by = $2, status = 'cancelled'
            where series_id = $1 and deleted_at is null
              and (id = $3 or status <> 'completed')
            returning id, title, activity_date`,
          [target.series_id, actor.userId, id],
        )
      : await tx.query(
          `update activities set deleted_at = now(), deleted_by = $2, status = 'cancelled'
            where id = $1 returning id, title, activity_date`,
          [id, actor.userId],
        );

    const participants = await tx.query(
      'select distinct user_id from activity_participants where activity_id = any($1::uuid[])',
      [rows.map((r) => r.id)],
    );
    await notify(tx, {
      typeCode: 'activity_changed',
      recipientIds: participants.map((p) => p.user_id),
      title: rows.length > 1 ? `פעילות בוטלה (${rows.length} ימים)` : 'פעילות בוטלה',
      body: rows[0].title ?? '',
      entityType: 'activities',
      entityId: id,
    });

    return { removed: id, count: rows.length };
  });
}

/* ───────────────────────── לו״ז הכשרה: מטמיעים × ימים ───────────────────────── */

/**
 * לפני העלייה לאוויר הלו״ז דינמי ונבנה מפעילויות: לכל מטמיע, בכל יום, מה הוא
 * עושה. מחזיר את המטמיעים של האתר, את הפעילויות של השבוע עם המשתתפים שלהן,
 * ואת השיבוצים מהגרסה האחרונה של הסידור לאותו שבוע — כדי שאפשר יהיה לראות
 * התנגשויות לפני ששומרים.
 */
export async function board({ siteId, weekStart }) {
  const days = weekDays(weekStart);
  const to = addDays(weekStart, 6);

  const [people, activities, participants, shifts, phaseRows] = await Promise.all([
    query(
      `select p.id, p.full_name, p.base_role::text as base_role,
              (select string_agg(d.name, ', ' order by d.name) from user_domains ud
                 join domains d on d.id = ud.domain_id
                where ud.user_id = p.id and ud.deleted_at is null) as domains
         from profiles p
         join site_assignments sa on sa.user_id = p.id
        where sa.site_id = $1 and sa.deleted_at is null
          and sa.span && daterange($2::date, $3::date, '[]')
          and p.status = 'active' and p.deleted_at is null
          and p.base_role in ('implementer', 'lead')
        order by p.full_name`,
      [siteId, weekStart, to],
    ),
    query(
      `${SELECT}
         and a.site_id = $1 and a.activity_date between $2 and $3
         and a.status not in ('cancelled', 'rejected')
       order by a.activity_date, a.start_time`,
      [siteId, weekStart, to],
    ),
    query(
      `select ap.activity_id, ap.user_id, ap.attendance, p.full_name, p.base_role::text as base_role
         from activity_participants ap
         join activities a on a.id = ap.activity_id
         join profiles p on p.id = ap.user_id
        where a.site_id = $1 and a.activity_date between $2 and $3 and a.deleted_at is null`,
      [siteId, weekStart, to],
    ),
    query(
      `select ra.id, ra.user_id, ra.assignment_date, ra.start_time, ra.end_time,
              l.name as location_name, st.name as shift_name, v.status::text as version_status
         from roster_assignments ra
         join roster_versions v on v.id = ra.version_id
         join locations l on l.id = ra.location_id
         left join shift_types st on st.id = ra.shift_type_id
        where v.site_id = $1 and v.week_start = $2 and v.deleted_at is null and ra.deleted_at is null
          and v.version_number = (select max(version_number) from roster_versions
                                   where site_id = $1 and week_start = $2 and deleted_at is null)
        order by ra.assignment_date, ra.start_time`,
      [siteId, weekStart],
    ),
    query(
      `select d::date::text as day, app.site_period_on($1, d::date)::text as period
         from generate_series($2::date, $2::date + 6, interval '1 day') d`,
      [siteId, weekStart],
    ),
  ]);

  // אילוצים של המטמיעים בשבוע: בקשות אילוץ שאושרו או ממתינות, ו"לא יכול"
  // מהצהרת הזמינות. רק סוג האילוץ והשעות — בלי הסיבה (§7).
  const ids = people.map((p) => p.id);
  const constraints = ids.length === 0 ? [] : await query(
    `select cr.user_id, cr.constraint_date::text as date, cr.start_time, cr.end_time,
            cr.status::text as status, ct.name_he as type_name
       from constraint_requests cr
       join constraint_types ct on ct.id = cr.constraint_type_id
      where cr.deleted_at is null and cr.status in ('submitted', 'approved')
        and cr.constraint_date between $1::date and $2::date
        and cr.user_id = any($3::uuid[])
     union all
     select d.user_id, c.cell_date::text, c.start_time, c.end_time,
            case when d.status::text = 'pending_approval' then 'submitted' else 'approved' end,
            'לא יכול'
       from availability_cells c
       join availability_declarations d on d.id = c.declaration_id
      where d.site_id = $4 and d.week_start = $1::date and c.value = 'cannot'
        and d.status in ('ok', 'pending_approval', 'approved')
        and d.superseded_at is null and d.deleted_at is null
        and d.user_id = any($3::uuid[])
      order by 2, 3`,
    [weekStart, to, ids, siteId],
  );

  const byActivity = new Map();
  const namesByActivity = new Map();
  for (const p of participants) {
    if (!byActivity.has(p.activity_id)) byActivity.set(p.activity_id, []);
    byActivity.get(p.activity_id).push(p.user_id);
    if (!namesByActivity.has(p.activity_id)) namesByActivity.set(p.activity_id, []);
    namesByActivity.get(p.activity_id).push({ id: p.user_id, name: p.full_name, role: p.base_role });
  }

  return {
    weekStart,
    days,
    phases: Object.fromEntries(phaseRows.map((r) => [r.day, r.period])),
    people,
    activities: activities.map((a) => ({
      ...a,
      participant_ids: byActivity.get(a.id) ?? [],
      participants: (namesByActivity.get(a.id) ?? []).sort((x, y) => x.name.localeCompare(y.name, 'he')),
    })),
    shifts,
    constraints,
  };
}

/**
 * שיוך שמי של מטמיע לפעילות, או הסרה ממנה — מהלו״ז.
 * בפעילות שקהל היעד שלה הוא "משתתפים נבחרים", השיוך נשמר גם בקהל היעד, כך
 * שעריכה של הפעילות בטופס לא תמחק אותו.
 */
export async function setParticipant(actor, activityId, { userId, present }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const activity = await tx.lock('activities', activityId);
    if (!activity || activity.deleted_at) throw new AppError('E_NOT_FOUND', 'הפעילות המבוקשת לא נמצאה');
    if (['completed', 'cancelled'].includes(activity.status)) {
      throw new AppError('E_STATE', 'הפעילות כבר הסתיימה או בוטלה');
    }

    if (present) {
      if (activity.audience === 'users') {
        await tx.query(
          `insert into activity_audience (activity_id, audience, target_id) values ($1, 'users', $2)
           on conflict do nothing`,
          [activityId, userId],
        );
      }
      const [added] = await tx.query(
        `insert into activity_participants (activity_id, user_id, source)
         values ($1, $2, $3) on conflict (activity_id, user_id) do nothing returning id`,
        [activityId, userId, activity.audience === 'users' ? 'audience' : 'manual'],
      );
      if (added && activity.visibility === 'participants' && activity.status === 'scheduled') {
        await notify(tx, {
          typeCode: 'activity_changed',
          recipientIds: [userId],
          title: 'שובצת לפעילות',
          body: `${activity.title ?? ''} · ${activity.activity_date} ${activity.start_time.slice(0, 5)}`,
          entityType: 'activities',
          entityId: activityId,
        });
      }
    } else {
      await tx.query(
        `delete from activity_audience where activity_id = $1 and audience = 'users' and target_id = $2`,
        [activityId, userId],
      );
      await tx.query('delete from activity_participants where activity_id = $1 and user_id = $2', [activityId, userId]);
    }

    const [{ count }] = await tx.query(
      'select count(*)::int as count from activity_participants where activity_id = $1',
      [activityId],
    );
    return { activityId, userId, present, participantCount: count };
  });
}

/** מטלות המדריך — §8: פעילויות שדורשות הכנה או השלמה */
export async function mentorTasks(mentorId) {
  return query(
    `${SELECT}
       and a.owner_user_id = $1
       and a.status = 'scheduled'
       and (
            (a.ends_at < now())                                    -- הסתיימה וטרם עודכנה
         or (a.starts_at - now() < interval '48 hours' and not a.prep_done)
       )
     order by a.starts_at`,
    [mentorId],
  );
}
