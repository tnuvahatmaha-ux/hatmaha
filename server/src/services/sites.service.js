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
              lt.name as location_type_name, l.row_version
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

  return { site, periods, locations: [...byLocation.values()] };
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
           display_order = coalesce($9, display_order), is_active = coalesce($10, is_active)
         where id = $1 returning *`,
        [
          input.id, input.name ?? null, input.startTime ?? null, input.endTime ?? null,
          input.isMandatory ?? null, input.requiredStaff ?? null,
          input.domainId ?? null, input.subCategoryId ?? null,
          input.displayOrder ?? null, input.isActive ?? null,
        ],
      );
      return row;
    }

    // site_id נגזר מהמיקום בטריגר shift_types_site_sync
    const [row] = await tx.query(
      `insert into shift_types
         (location_id, name, start_time, end_time, is_mandatory, required_staff,
          domain_id, sub_category_id, display_order)
       values ($1, $2, $3, $4, coalesce($5, false), coalesce($6, 1), $7, $8,
               coalesce($9, (select coalesce(max(display_order), 0) + 10
                               from shift_types where location_id = $1)))
       returning *`,
      [
        locationId, input.name, input.startTime, input.endTime,
        input.isMandatory, input.requiredStaff,
        input.domainId ?? null, input.subCategoryId ?? null, input.displayOrder ?? null,
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

/** התקופה הנוכחית של האתר — קובעת מאיזה פרופיל של סוג המיקום מעתיקים */
async function currentPeriod(tx, siteId) {
  const [row] = await tx.query(
    `select period::text as period from site_periods
      where site_id = $1 and deleted_at is null
        and current_date between starts_on and ends_on
      limit 1`,
    [siteId],
  );
  return row?.period ?? 'training';
}

/**
 * מוסיף למיקום את תבניות המשמרת של סוג המיקום, בתקופה הנתונה.
 * משמרת שכבר קיימת במיקום באותו שם מדולגת — כך ההעתקה בטוחה להרצה חוזרת.
 * שינוי תבנית אחר כך אינו משפיע על המיקום: אלה עותקים, לא קישור.
 */
async function copyTemplates(tx, location, period) {
  if (!location.location_type_id) return { added: 0, skipped: 0, period };

  const templates = await tx.query(
    `select t.name, t.start_time, t.end_time, t.display_order
       from location_type_profiles p
       join location_type_shift_templates t on t.profile_id = p.id and t.deleted_at is null
      where p.location_type_id = $1 and p.period = $2::period_code and p.deleted_at is null
      order by t.display_order`,
    [location.location_type_id, period],
  );

  let added = 0;
  for (const t of templates) {
    const [row] = await tx.query(
      `insert into shift_types (location_id, name, start_time, end_time, display_order)
       select $1, $2, $3, $4, $5
        where not exists (select 1 from shift_types
                           where location_id = $1 and name = $2 and deleted_at is null)
       returning id`,
      [location.id, t.name, t.start_time, t.end_time, t.display_order],
    );
    if (row) added += 1;
  }
  return { added, skipped: templates.length - added, period };
}

export async function copyShiftsFromTemplate(actor, siteId, locationId, period) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const location = await requireLocation(tx, siteId, locationId);
    if (!location.location_type_id) {
      throw new AppError('E_VALIDATION', 'למיקום אין סוג מוגדר, ולכן אין ממה להעתיק');
    }
    return copyTemplates(tx, location, period ?? (await currentPeriod(tx, siteId)));
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
           location_type_id = $4, capacity = $5, is_active = coalesce($6, is_active)
         where id = $1 returning *`,
        [input.id, input.name ?? null, input.description ?? null,
         input.locationTypeId ?? null, input.capacity ?? null, input.isActive ?? null],
      );
      return row;
    }

    const [row] = await tx.query(
      `insert into locations (site_id, name, description, location_type_id, capacity)
       values ($1, $2, $3, $4, $5) returning *`,
      [siteId, input.name, input.description ?? null, input.locationTypeId ?? null, input.capacity ?? null],
    );

    // מיקום מסוג מוגדר נולד עם המשמרות של הסוג, כדי שלא יתחיל ריק
    const copied = await copyTemplates(tx, row, await currentPeriod(tx, siteId));
    return { ...row, copiedShifts: copied.added };
  });
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
