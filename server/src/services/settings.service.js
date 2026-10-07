import { query, withTransaction } from '../lib/db.js';
import { assertIfMatch } from '../lib/etag.js';
import { AppError } from '../lib/errors.js';

/* ───────────────────────── תחומים ותתי-קטגוריות ───────────────────────── */

export async function domainTree({ includeInactive = false } = {}) {
  const [domains, subs] = await Promise.all([
    query(
      `select id, code, name, description, display_order, is_active, row_version
         from domains where deleted_at is null and ($1 or is_active)
        order by display_order, name`,
      [includeInactive],
    ),
    query(
      `select id, domain_id, code, name, description, display_order, is_active, row_version
         from sub_categories where deleted_at is null and ($1 or is_active)
        order by display_order, name`,
      [includeInactive],
    ),
  ]);

  const byDomain = new Map(domains.map((d) => [d.id, { ...d, subCategories: [] }]));
  for (const s of subs) byDomain.get(s.domain_id)?.subCategories.push(s);
  return [...byDomain.values()];
}

export async function saveDomain(actor, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    if (input.id) {
      const current = await tx.lock('domains', input.id);
      if (!current || current.deleted_at) throw new AppError('E_NOT_FOUND', 'התחום המבוקש לא נמצא');
      assertIfMatch(req, current);
      const [row] = await tx.query(
        `update domains set name = coalesce($2, name), description = coalesce($3, description),
                            display_order = coalesce($4, display_order),
                            is_active = coalesce($5, is_active)
          where id = $1 returning *`,
        [input.id, input.name ?? null, input.description ?? null,
         input.displayOrder ?? null, input.isActive ?? null],
      );
      return row;
    }
    const [row] = await tx.query(
      `insert into domains (name, description, display_order)
       values ($1, $2, coalesce($3, (select coalesce(max(display_order), 0) + 10 from domains)))
       returning *`,
      [input.name, input.description ?? null, input.displayOrder ?? null],
    );
    return row;
  });
}

export async function saveSubCategory(actor, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    if (input.id) {
      const current = await tx.lock('sub_categories', input.id);
      if (!current || current.deleted_at) {
        throw new AppError('E_NOT_FOUND', 'תת-הקטגוריה המבוקשת לא נמצאה');
      }
      assertIfMatch(req, current);
      const [row] = await tx.query(
        `update sub_categories set name = coalesce($2, name),
                                   description = coalesce($3, description),
                                   display_order = coalesce($4, display_order),
                                   is_active = coalesce($5, is_active)
          where id = $1 returning *`,
        [input.id, input.name ?? null, input.description ?? null,
         input.displayOrder ?? null, input.isActive ?? null],
      );
      return row;
    }
    const [row] = await tx.query(
      `insert into sub_categories (domain_id, name, description, display_order)
       values ($1, $2, $3, coalesce($4, (select coalesce(max(display_order), 0) + 10
                                           from sub_categories where domain_id = $1)))
       returning *`,
      [input.domainId, input.name, input.description ?? null, input.displayOrder ?? null],
    );
    return row;
  });
}

/* ───────────────────────── קטלוגים ───────────────────────── */

/**
 * רק הטבלאות שברשימה הזו נגישות דרך הנתיב הגנרי.
 * בלי רשימה לבנה, פרמטר בכתובת היה הופך לשם טבלה — והופך את הנתיב
 * לחור הזרקה.
 */
const LOOKUPS = {
  activityTypes: { table: 'activity_types', extra: ['requires_location', 'counts_as_training'] },
  constraintTypes: { table: 'constraint_types', extra: ['requires_note', 'approval_mode'] },
  trainingStatuses: { table: 'training_statuses', extra: ['is_terminal'] },
  siteStatuses: { table: 'site_statuses', extra: ['is_terminal'] },
  qualificationLevels: { table: 'qualification_levels', extra: ['rank'] },
};

export const lookupKinds = Object.keys(LOOKUPS);

function lookup(kind) {
  const def = LOOKUPS[kind];
  if (!def) throw new AppError('E_NOT_FOUND', `קטלוג לא מוכר: ${kind}`);
  return def;
}

export async function listLookup(kind, { includeInactive = false } = {}) {
  const { table, extra } = lookup(kind);
  const cols = ['id', 'code', 'name_he', 'display_order', 'is_active', 'row_version', ...extra];
  return query(
    `select ${cols.join(', ')} from ${table}
      where deleted_at is null and ($1 or is_active)
      order by display_order, name_he`,
    [includeInactive],
  );
}

export async function saveLookup(actor, kind, input, req) {
  const { table } = lookup(kind);

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    if (input.id) {
      const current = await tx.lock(table, input.id);
      if (!current || current.deleted_at) throw new AppError('E_NOT_FOUND', 'הפריט המבוקש לא נמצא');
      assertIfMatch(req, current);
      const [row] = await tx.query(
        `update ${table} set name_he = coalesce($2, name_he),
                             display_order = coalesce($3, display_order),
                             is_active = coalesce($4, is_active)
          where id = $1 returning *`,
        [input.id, input.nameHe ?? null, input.displayOrder ?? null, input.isActive ?? null],
      );
      return row;
    }

    // code נגזר מהשם רק אם לא נשלח; הוא ASCII כי המנועים נשענים עליו
    const code = input.code ?? `custom_${Date.now().toString(36)}`;
    const [row] = await tx.query(
      `insert into ${table} (code, name_he, display_order)
       values ($1, $2, coalesce($3, (select coalesce(max(display_order), 0) + 10 from ${table})))
       returning *`,
      [code, input.nameHe, input.displayOrder ?? null],
    );
    return row;
  });
}

/* ───────────────────────── כללי אישור אילוצים ───────────────────────── */

/**
 * כלל אחד לכל סוג אילוץ, שחל על כל האתרים:
 * auto — הבקשה מאושרת מיד בהגשה; manager — ממתינה להחלטה.
 * חוק במנוע החוקיות (למשל הודעה מוקדמת) גובר על שניהם ומעביר לחריגה.
 */
export async function constraintApprovalRules() {
  return query(
    `select id, code, name_he, approval_mode::text as approval_mode, is_active, row_version
       from constraint_types
      where deleted_at is null
      order by display_order, name_he`,
  );
}

export async function setConstraintApprovalMode(actor, constraintTypeId, approvalMode) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update constraint_types set approval_mode = $2::approval_mode
        where id = $1 and deleted_at is null
        returning id, code, name_he, approval_mode::text as approval_mode, row_version`,
      [constraintTypeId, approvalMode],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'סוג האילוץ המבוקש לא נמצא');
    return row;
  });
}

/* ───────────────────────── סוגי מיקום ופרופילים ───────────────────────── */

export async function locationTypes() {
  const types = await query(
    `select id, code, name, is_active, row_version from location_types
      where deleted_at is null order by name`,
  );
  if (types.length === 0) return [];

  const profiles = await query(
    `select p.id, p.location_type_id, p.period::text as period, p.active_days,
            p.open_time, p.close_time, p.row_version,
            coalesce(json_agg(json_build_object(
              'id', t.id, 'name', t.name, 'startTime', t.start_time, 'endTime', t.end_time
            ) order by t.display_order) filter (where t.id is not null), '[]') as shift_templates
       from location_type_profiles p
       left join location_type_shift_templates t
              on t.profile_id = p.id and t.deleted_at is null
      where p.deleted_at is null
      group by p.id`,
  );

  const byType = new Map(types.map((t) => [t.id, { ...t, profiles: {} }]));
  for (const p of profiles) byType.get(p.location_type_id).profiles[p.period] = p;
  return [...byType.values()];
}

export async function saveLocationType(actor, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let typeId = input.id;

    if (typeId) {
      const current = await tx.lock('location_types', typeId);
      if (!current || current.deleted_at) {
        throw new AppError('E_NOT_FOUND', 'סוג המיקום המבוקש לא נמצא');
      }
      assertIfMatch(req, current);
      await tx.query(
        `update location_types set name = coalesce($2, name), is_active = coalesce($3, is_active)
          where id = $1`,
        [typeId, input.name ?? null, input.isActive ?? null],
      );
    } else {
      const [row] = await tx.query(
        'insert into location_types (name) values ($1) returning id',
        [input.name],
      );
      typeId = row.id;
      // כל סוג מיקום נולד עם פרופיל לכל תקופה, כדי שהמסך לא יציג ריק
      for (const period of ['training', 'golive']) {
        await tx.query(
          'insert into location_type_profiles (location_type_id, period) values ($1, $2::period_code)',
          [typeId, period],
        );
      }
    }
    return typeId;
  });
}

export async function saveProfile(actor, locationTypeId, period, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [profile] = await tx.query(
      `insert into location_type_profiles
         (location_type_id, period, active_days, open_time, close_time)
       values ($1, $2::period_code, $3, $4, $5)
       on conflict (location_type_id, period) do update set
         active_days = excluded.active_days,
         open_time = excluded.open_time,
         close_time = excluded.close_time,
         updated_at = now()
       returning id`,
      [locationTypeId, period, input.activeDays, input.openTime, input.closeTime],
    );

    // תבניות המשמרת מוחלפות במלואן — המסך עורך אותן כרשימה אחת
    await tx.query('delete from location_type_shift_templates where profile_id = $1', [profile.id]);
    let order = 0;
    for (const t of input.shiftTemplates ?? []) {
      await tx.query(
        `insert into location_type_shift_templates (profile_id, name, start_time, end_time, display_order)
         values ($1, $2, $3, $4, $5)`,
        [profile.id, t.name, t.startTime, t.endTime, (order += 10)],
      );
    }
    return profile.id;
  });
}

/* ───────────────────────── הגדרות כלליות ───────────────────────── */

export async function appSettings() {
  const rows = await query('select key, value, name_he, description_he from app_settings order by key');
  return Object.fromEntries(rows.map((r) => [r.key, r]));
}

export async function setAppSetting(actor, key, value) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update app_settings set value = $2, updated_at = now(), updated_by = $3
        where key = $1 returning key, value`,
      [key, JSON.stringify(value), actor.userId],
    );
    if (!row) throw new AppError('E_NOT_FOUND', `הגדרה לא מוכרת: ${key}`);
    return row;
  });
}
