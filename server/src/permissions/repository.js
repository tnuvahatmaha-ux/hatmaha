import { query } from '../lib/db.js';

/**
 * טעינת כל מה שמנוע ההרשאות צריך על משתמש, בשאילתה אחת, עם קאש קצר.
 *
 * הקאש הוא 60 שניות ומתבטל סינכרונית בכל כתיבה להרשאות, כדי שההבטחה
 * "שינוי הרשאה נכנס לתוקף ללא שינוי קוד" (§3.1) תישאר כנה.
 */

const TTL_MS = 60_000;
const cache = new Map(); // userId -> { at, value }

/**
 * @typedef {object} Principal
 * @property {string} userId
 * @property {string} baseRole
 * @property {string} status
 * @property {string} fullName
 * @property {Array}  entries      זכויות מתפקיד הבסיס ומהרשאות פרטניות חיות
 * @property {object} scopes       האתרים, התחומים והמשויכים של המשתמש
 */

const SQL = `
  with me as (
    select id, full_name, email, base_role, status
      from profiles
     where id = $1 and deleted_at is null
  ),
  role_entries as (
    select p.resource, p.action::text as action, rp.effect::text as effect,
           rp.scope_type::text as scope_type, null::uuid as scope_id,
           'role' as source, null::timestamptz as valid_to, null::uuid as grant_id
      from role_permissions rp
      join permissions p on p.id = rp.permission_id
      join me on me.base_role = rp.role
     where rp.deleted_at is null and p.is_active
  ),
  grant_entries as (
    select g.resource, g.action::text, g.effect::text,
           g.scope_type::text, g.scope_id,
           'grant' as source, g.valid_to, g.id as grant_id
      from v_live_permission_grants g
     where g.user_id = $1
  )
  select
    (select row_to_json(me) from me) as profile,
    coalesce((select json_agg(e) from (
        select * from role_entries union all select * from grant_entries
    ) e), '[]'::json) as entries,
    app.user_site_ids($1)          as site_ids,
    app.user_domain_ids($1)        as domain_ids,
    app.user_sub_category_ids($1)  as sub_category_ids,
    app.assigned_user_ids($1)      as assigned_user_ids
`;

/** @returns {Promise<Principal|null>} */
export async function loadPrincipal(userId, { fresh = false } = {}) {
  if (!userId) return null;

  if (!fresh) {
    const hit = cache.get(userId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  }

  const rows = await query(SQL, [userId]);
  const row = rows[0];
  if (!row?.profile) {
    cache.delete(userId);
    return null;
  }

  const principal = Object.freeze({
    userId: row.profile.id,
    fullName: row.profile.full_name,
    email: row.profile.email,
    baseRole: row.profile.base_role,
    status: row.profile.status,
    entries: row.entries,
    scopes: Object.freeze({
      siteIds: row.site_ids ?? [],
      domainIds: row.domain_ids ?? [],
      subCategoryIds: row.sub_category_ids ?? [],
      assignedUserIds: row.assigned_user_ids ?? [],
    }),
  });

  cache.set(userId, { at: Date.now(), value: principal });
  return principal;
}

/** מבטל את הקאש למשתמש אחד, או לכולם. נקרא בכל כתיבה להרשאות או לשיוכים. */
export function invalidatePrincipal(userId) {
  if (userId) cache.delete(userId);
  else cache.clear();
}

export function cacheSize() {
  return cache.size;
}
