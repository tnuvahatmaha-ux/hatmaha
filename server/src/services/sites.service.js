import { query, withTransaction } from '../lib/db.js';
import { assertIfMatch } from '../lib/etag.js';
import { AppError } from '../lib/errors.js';

/** רשימת אתרים, מסוננת ל-Scope של המשתמש */
export async function list(principal, { includeArchived = false } = {}) {
  const isManager = principal.baseRole === 'manager';
  return query(
    `select s.id, s.code, s.name, s.description, s.timezone, s.go_live_date,
            s.open_time, s.close_time, s.is_archived, s.row_version,
            s.availability_max_cannot, s.availability_max_prefer_not,
            s.availability_deadline_weekday, s.availability_deadline_hour,
            st.code as status_code, st.name_he as status_name,
            (select count(*)::int from locations l
              where l.site_id = s.id and l.deleted_at is null and l.is_active) as location_count,
            (select count(*)::int from site_assignments sa
              where sa.site_id = s.id and sa.deleted_at is null
                and sa.span @> current_date) as people_count
       from sites s
       join site_statuses st on st.id = s.status_id
      where s.deleted_at is null
        and ($1 or not s.is_archived)
        and ($2 or s.id = any($3::uuid[]))
      order by s.is_archived, s.go_live_date nulls last, s.name`,
    [includeArchived, isManager, principal.scopes.siteIds],
  );
}

/** אתר מלא: תקופות, מיקומים, משמרות ומדיניות אילוצים */
export async function get(siteId) {
  const [site] = await query(
    `select s.*, st.code as status_code, st.name_he as status_name
       from sites s join site_statuses st on st.id = s.status_id
      where s.id = $1 and s.deleted_at is null`,
    [siteId],
  );
  if (!site) throw new AppError('E_NOT_FOUND', 'האתר המבוקש לא נמצא');

  const [periods, locations, shiftTypes] = await Promise.all([
    query(
      `select id, period::text as period, name, starts_on, ends_on, row_version
         from site_periods where site_id = $1 and deleted_at is null order by starts_on`,
      [siteId],
    ),
    query(
      `select l.id, l.name, l.description, l.capacity, l.is_active, l.location_type_id,
              lt.name as location_type_name, l.periods::text[] as periods, l.row_version
         from locations l
         left join location_types lt on lt.id = l.location_type_id
        where l.site_id = $1 and l.deleted_at is null
        order by l.is_active desc, l.name`,
      [siteId],
    ),
    query(
      `select st.id, st.location_id, st.name, st.start_time, st.end_time, st.crosses_midnight,
              st.is_mandatory, st.required_staff, st.domain_id, st.sub_category_id,
              st.display_order, st.is_active, st.row_version,
              st.category::text as category, st.period::text as period,
              d.name as domain_name
         from shift_types st
         left join domains d on d.id = st.domain_id
        where st.site_id = $1 and st.deleted_at is null
        order by st.display_order, st.start_time`,
      [siteId],
    ),
  ]);

  // לכל מיקום המשמרות שלו — אין עוד משמרות משותפות לכל האתר
  const byLocation = new Map(locations.map((l) => [l.id, { ...l, shiftTypes: [] }]));
  for (const shift of shiftTypes) byLocation.get(shift.location_id)?.shiftTypes.push(shift);

  const [{ period: phaseToday }] = await query(
    'select app.site_period_on($1, current_date)::text as period',
    [siteId],
  );

  return { site, periods, phaseToday, locations: [...byLocation.values()] };
}

export async function create(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const status = await tx.required(
      'select id from site_statuses where code = $1 and is_active',
      [input.statusCode ?? 'training'],
      'סטטוס האתר אינו מוכר',
    );

    const [site] = await tx.query(
      `insert into sites (name, description, status_id, timezone, go_live_date,
                          open_time, close_time,
                          availability_max_cannot, availability_max_prefer_not,
                          availability_deadline_weekday, availability_deadline_hour)
       values ($1, $2, $3, coalesce($4, 'Asia/Jerusalem'), $5, $6, $7,
               coalesce($8, 3), coalesce($9, 4), $10, $11)
       returning *`,
      [
        input.name, input.description ?? null, status.id, input.timezone ?? null,
        input.goLiveDate ?? null, input.openTime ?? '07:00', input.closeTime ?? '23:00',
        input.maxCannot, input.maxPreferNot,
        input.deadlineWeekday ?? null, input.deadlineHour ?? null,
      ],
    );
    return site;
  });
}

export async function update(actor, siteId, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const current = await tx.lock('sites', siteId);
    if (!current || current.deleted_at) throw new AppError('E_NOT_FOUND', 'האתר המבוקש לא נמצא');
    assertIfMatch(req, current);

    const statusId = input.statusCode
      ? (await tx.required('select id from site_statuses where code = $1', [input.statusCode],
          'סטטוס האתר אינו מוכר')).id
      : current.status_id;

    const [site] = await tx.query(
      `update sites set
         name = coalesce($2, name),
         description = coalesce($3, description),
         status_id = $4,
         go_live_date = coalesce($5, go_live_date),
         open_time = coalesce($6, open_time),
         close_time = coalesce($7, close_time),
         availability_max_cannot = coalesce($8, availability_max_cannot),
         availability_max_prefer_not = coalesce($9, availability_max_prefer_not),
         availability_deadline_weekday = coalesce($10, availability_deadline_weekday),
         availability_deadline_hour = coalesce($11, availability_deadline_hour),
         is_archived = coalesce($12, is_archived)
       where id = $1 returning *`,
      [
        siteId, input.name ?? null, input.description ?? null, statusId,
        input.goLiveDate ?? null, input.openTime ?? null, input.closeTime ?? null,
        input.maxCannot ?? null, input.maxPreferNot ?? null,
        input.deadlineWeekday ?? null, input.deadlineHour ?? null,
        input.isArchived ?? null,
      ],
    );
    return site;
  });
}

/** ארכוב הוא מחיקה לוגית: אתר שהיה בשימוש אינו נמחק (§12) */
export async function archive(actor, siteId, archived = true) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [site] = await tx.query(
      'update sites set is_archived = $2 where id = $1 and deleted_at is null returning *',
      [siteId, archived],
    );
    if (!site) throw new AppError('E_NOT_FOUND', 'האתר המבוקש לא נמצא');
    return site;
  });
}

/* ───────────────────────── משמרות (לפי מיקום) ───────────────────────── */

/** מוודא שהמיקום שייך לאתר שבכתובת — אחרת אפשר היה לערוך מיקום של אתר אחר */
async function requireLocation(tx, siteId, locationId) {
  return tx.required(
    'select id, site_id, location_type_id from locations where id = $1 and site_id = $2 and deleted_at is null',
    [locationId, siteId],
    'המיקום המבוקש לא נמצא באתר הזה',
  );
}

export async function saveShiftType(actor, siteId, locationId, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await requireLocation(tx, siteId, locationId);

    if (input.id) {
      const current = await tx.lock('shift_types', input.id);
      if (!current || current.location_id !== locationId || current.deleted_at) {
        throw new AppError('E_NOT_FOUND', 'המשמרת המבוקשת לא נמצאה במיקום הזה');
      }
      assertIfMatch(req, current);
      const [row] = await tx.query(
        `update shift_types set
           name = coalesce($2, name), start_time = coalesce($3, start_time),
           end_time = coalesce($4, end_time), is_mandatory = coalesce($5, is_mandatory),
           required_staff = coalesce($6, required_staff),
           domain_id = $7, sub_category_id = $8,
           display_order = coalesce($9, display_order), is_active = coalesce($10, is_active),
           category = coalesce($11::shift_category, category),
           period = $12::period_code
         where id = $1 returning *`,
        [
          input.id, input.name ?? null, input.startTime ?? null, input.endTime ?? null,
          input.isMandatory ?? null, input.requiredStaff ?? null,
          input.domainId ?? null, input.subCategoryId ?? null,
          input.displayOrder ?? null, input.isActive ?? null,
          input.category ?? null, input.period ?? null,
        ],
      );
      return row;
    }

    // site_id נגזר מהמיקום בטריגר shift_types_site_sync
    const [row] = await tx.query(
      `insert into shift_types
         (location_id, name, start_time, end_time, is_mandatory, required_staff,
          domain_id, sub_category_id, display_order, category, period)
       values ($1, $2, $3, $4, coalesce($5, false), coalesce($6, 1), $7, $8,
               coalesce($9, (select coalesce(max(display_order), 0) + 10
                               from shift_types where location_id = $1)),
               $10::shift_category, $11::period_code)
       returning *`,
      [
        locationId, input.name, input.startTime, input.endTime,
        input.isMandatory, input.requiredStaff,
        input.domainId ?? null, input.subCategoryId ?? null, input.displayOrder ?? null,
        input.category ?? null, input.period ?? null,
      ],
    );
    return row;
  });
}

/**
 * מחיקת משמרת: לוגית אם היא כבר בשימוש בסידור, פיזית אם לא.
 * בלי זה, מחיקת משמרת הייתה מוחקת שיבוצים שכבר קרו.
 */
export async function deleteShiftType(actor, siteId, locationId, shiftTypeId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await requireLocation(tx, siteId, locationId);

    const [usage] = await tx.query(
      'select count(*)::int as assignments from roster_assignments where shift_type_id = $1',
      [shiftTypeId],
    );

    if (usage.assignments > 0) {
      await tx.query(
        `update shift_types set deleted_at = now(), deleted_by = $3, is_active = false
          where id = $1 and location_id = $2`,
        [shiftTypeId, locationId, actor.userId],
      );
      return { removed: 'soft', usage };
    }

    await tx.query('delete from shift_types where id = $1 and location_id = $2', [shiftTypeId, locationId]);
    return { removed: 'hard', usage };
  });
}

const PERIODS = ['training', 'golive', 'support'];

/**
 * מעתיק למיקום את המשמרות של סוג המיקום (מאגר המיקומים), לכל שלב בנפרד:
 * כל משמרת מתויגת בשלב שממנו הגיעה, ולכן שעות ההכשרה ושעות העלייה לאוויר
 * מתחלפות לבד בתאריך העלייה.
 *
 * אם לסוג המיקום אין תבניות, מועתקות המשמרות של המיקום האחרון מאותו סוג
 * שהוקם באתר אחר — כך מיקום שהוגדר פעם אחת "נשמר" עם השעות שלו.
 *
 * משמרת שכבר קיימת (אותו שם, אותו שלב) מדולגת, ולכן ההעתקה בטוחה להרצה
 * חוזרת. אלה עותקים, לא קישור.
 */
async function copyTemplates(tx, location, periods = PERIODS) {
  if (!location.location_type_id) return { added: 0, skipped: 0, periods };

  let source = await tx.query(
    `select t.name, t.start_time, t.end_time, t.display_order, p.period::text as period
       from location_type_profiles p
       join location_type_shift_templates t on t.profile_id = p.id and t.deleted_at is null
      where p.location_type_id = $1 and p.period = any($2::period_code[]) and p.deleted_at is null
      order by p.period, t.display_order`,
    [location.location_type_id, periods],
  );

  if (source.length === 0) {
    source = await tx.query(
      `select st.name, st.start_time, st.end_time, st.display_order, st.period::text as period,
              st.category::text as category, st.is_mandatory, st.required_staff
         from shift_types st
        where st.deleted_at is null and st.is_active and st.domain_id is null
          and (st.period is null or st.period = any($3::period_code[]))
          and st.location_id = (
            select l.id from locations l
             where l.location_type_id = $1 and l.id <> $2 and l.deleted_at is null
               and exists (select 1 from shift_types x
                            where x.location_id = l.id and x.deleted_at is null)
             order by l.updated_at desc limit 1)
        order by st.display_order`,
      [location.location_type_id, location.id, periods],
    );
  }

  let added = 0;
  for (const t of source) {
    const [row] = await tx.query(
      `insert into shift_types
         (location_id, name, start_time, end_time, display_order, period, category,
          is_mandatory, required_staff)
       select $1, $2, $3, $4, $5, $6::period_code, $7::shift_category,
              coalesce($8, false), coalesce($9, 1)
        where not exists (select 1 from shift_types
                           where location_id = $1 and name = $2 and deleted_at is null
                             and domain_id is null
                             and period is not distinct from $6::period_code)
       returning id`,
      [location.id, t.name, t.start_time, t.end_time, t.display_order, t.period ?? null,
       t.category ?? null, t.is_mandatory ?? null, t.required_staff ?? null],
    );
    if (row) added += 1;
  }
  return { added, skipped: source.length - added, periods };
}

export async function copyShiftsFromTemplate(actor, siteId, locationId, period) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const location = await requireLocation(tx, siteId, locationId);
    if (!location.location_type_id) {
      throw new AppError('E_VALIDATION', 'למיקום אין סוג מוגדר, ולכן אין ממה להעתיק');
    }
    return copyTemplates(tx, location, period ? [period] : PERIODS);
  });
}

/**
 * העתקת שעות משמרת מתחום לתחום (למשל מ"סיעוד" ל"רפואה").
 *
 * המשמרות שתויגו בתחום המקור מועתקות לתחום היעד, באותו מיקום — או, כשנבחר
 * אתר יעד אחר, למיקום באותו שם באתר היעד. merge מוסיף רק מה שחסר;
 * replace מוחק קודם את המשמרות של תחום היעד (לוגית, אם כבר שובצו בהן).
 */
export async function copyDomainShifts(actor, siteId, input) {
  const { fromDomainId, toDomainId, locationIds, period, mode = 'merge' } = input;
  const targetSiteId = input.targetSiteId ?? siteId;
  if (fromDomainId === toDomainId && targetSiteId === siteId) {
    throw new AppError('E_VALIDATION', 'תחום המקור ותחום היעד זהים');
  }

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const source = await tx.query(
      `select st.*, l.name as location_name
         from shift_types st join locations l on l.id = st.location_id and l.deleted_at is null
        where st.site_id = $1 and st.domain_id = $2 and st.deleted_at is null
          and ($3::uuid[] is null or st.location_id = any($3::uuid[]))
          and ($4::period_code is null or st.period is not distinct from $4::period_code)
        order by st.display_order`,
      [siteId, fromDomainId, locationIds?.length ? locationIds : null, period ?? null],
    );
    if (source.length === 0) {
      throw new AppError('E_VALIDATION', 'לא נמצאו משמרות בתחום המקור לפי הבחירה');
    }

    // מיקום היעד: אותו מיקום באותו אתר, או מיקום באותו שם באתר אחר
    const targets = await tx.query(
      'select id, name from locations where site_id = $1 and deleted_at is null',
      [targetSiteId],
    );
    const byName = new Map(targets.map((l) => [l.name, l.id]));
    const targetOf = (st) => (targetSiteId === siteId ? st.location_id : byName.get(st.location_name));

    let created = 0;
    let skipped = 0;
    let replaced = 0;
    const missingLocations = new Set();

    if (mode === 'replace') {
      const targetLocations = [...new Set(source.map(targetOf).filter(Boolean))];
      const old = await tx.query(
        `select st.id,
                exists (select 1 from roster_assignments ra where ra.shift_type_id = st.id) as used
           from shift_types st
          where st.location_id = any($1::uuid[]) and st.domain_id = $2 and st.deleted_at is null
            and ($3::period_code is null or st.period is not distinct from $3::period_code)`,
        [targetLocations, toDomainId, period ?? null],
      );
      for (const o of old) {
        if (o.used) {
          await tx.query(
            'update shift_types set deleted_at = now(), deleted_by = $2, is_active = false where id = $1',
            [o.id, actor.userId],
          );
        } else {
          await tx.query('delete from shift_types where id = $1', [o.id]);
        }
        replaced += 1;
      }
    }

    for (const st of source) {
      const locationId = targetOf(st);
      if (!locationId) {
        missingLocations.add(st.location_name);
        skipped += 1;
        continue;
      }
      const [row] = await tx.query(
        `insert into shift_types
           (location_id, name, start_time, end_time, is_mandatory, required_staff,
            domain_id, sub_category_id, display_order, category, period, is_active)
         select $1, $2, $3, $4, $5, $6, $7, null, $8, $9::shift_category, $10::period_code, $11
          where not exists (select 1 from shift_types
                             where location_id = $1 and name = $2 and deleted_at is null
                               and domain_id = $7
                               and period is not distinct from $10::period_code)
         returning id`,
        [locationId, st.name, st.start_time, st.end_time, st.is_mandatory, st.required_staff,
         toDomainId, st.display_order, st.category, st.period, st.is_active],
      );
      if (row) created += 1;
      else skipped += 1;
    }

    return { created, skipped, replaced, missingLocations: [...missingLocations] };
  });
}

/* ───────────────────────── מיקומים ───────────────────────── */

export async function saveLocation(actor, siteId, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    if (input.id) {
      const current = await tx.lock('locations', input.id);
      if (!current || current.site_id !== siteId) {
        throw new AppError('E_NOT_FOUND', 'המיקום המבוקש לא נמצא באתר הזה');
      }
      assertIfMatch(req, current);
      const [row] = await tx.query(
        `update locations set
           name = coalesce($2, name), description = coalesce($3, description),
           location_type_id = coalesce($4, location_type_id), capacity = $5,
           is_active = coalesce($6, is_active),
           periods = coalesce($7::period_code[], periods)
         where id = $1 returning *`,
        [input.id, input.name ?? null, input.description ?? null,
         input.locationTypeId ?? null, input.capacity ?? null, input.isActive ?? null,
         input.periods ?? null],
      );
      return row;
    }

    // כל מיקום נשמר במאגר המיקומים, כדי שיופיע ברשימה בפעם הבאה שמקימים אתר
    const locationTypeId = input.locationTypeId ?? (await catalogEntryFor(tx, input.name));

    const [row] = await tx.query(
      `insert into locations (site_id, name, description, location_type_id, capacity, periods)
       values ($1, $2, $3, $4, $5, coalesce($6::period_code[], '{training,golive,support}'))
       returning *`,
      [siteId, input.name, input.description ?? null, locationTypeId, input.capacity ?? null,
       input.periods ?? null],
    );

    // מיקום מהמאגר נולד עם המשמרות שלו לכל שלב, כדי שלא יתחיל ריק
    const copied = await copyTemplates(tx, row, row.periods ?? PERIODS);
    return { ...row, copiedShifts: copied.added };
  });
}

/** הרשומה במאגר המיקומים לשם הזה — קיימת, או חדשה עם פרופיל לכל שלב */
async function catalogEntryFor(tx, name) {
  const [existing] = await tx.query(
    'select id from location_types where lower(name) = lower(btrim($1)) and deleted_at is null limit 1',
    [name],
  );
  if (existing) return existing.id;

  const [created] = await tx.query('insert into location_types (name) values ($1) returning id', [name]);
  for (const period of ['training', 'golive']) {
    await tx.query(
      `insert into location_type_profiles (location_type_id, period) values ($1, $2::period_code)
       on conflict do nothing`,
      [created.id, period],
    );
  }
  return created.id;
}

/* ───────────────────────── תקופות ───────────────────────── */

export async function replacePeriods(actor, siteId, periods) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await tx.query('delete from site_periods where site_id = $1', [siteId]);
    for (const p of periods) {
      await tx.query(
        `insert into site_periods (site_id, period, name, starts_on, ends_on)
         values ($1, $2::period_code, $3, $4, $5)`,
        [siteId, p.period, p.name ?? null, p.startsOn, p.endsOn],
      );
    }
    return query(
      `select id, period::text as period, name, starts_on, ends_on
         from site_periods where site_id = $1 and deleted_at is null order by starts_on`,
      [siteId],
    );
  });
}
