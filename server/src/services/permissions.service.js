import { query, withTransaction } from '../lib/db.js';
import { loadPrincipal, invalidatePrincipal } from '../permissions/repository.js';
import { effectiveMatrix } from '../permissions/engine.js';
import { notify } from '../notifications/service.js';
import { AppError } from '../lib/errors.js';

/** קטלוג ההרשאות, מקובץ לפי משאב — מזין את מסך ההרשאות */
export async function catalog() {
  const rows = await query(
    `select id, code, resource, action::text as action, name_he, is_active, display_order
       from permissions
      order by display_order`,
  );

  const byResource = new Map();
  for (const row of rows) {
    if (!byResource.has(row.resource)) {
      byResource.set(row.resource, {
        resource: row.resource,
        nameHe: row.name_he.split(' / ')[0],
        actions: [],
      });
    }
    byResource.get(row.resource).actions.push({
      id: row.id,
      code: row.code,
      action: row.action,
      nameHe: row.name_he.split(' / ')[1] ?? row.action,
      isActive: row.is_active,
    });
  }
  return [...byResource.values()];
}

export async function roleDefaults(role) {
  return query(
    `select rp.id, p.code, p.resource, p.action::text as action, p.name_he,
            rp.effect::text as effect, rp.scope_type::text as scope_type
       from role_permissions rp
       join permissions p on p.id = rp.permission_id
      where rp.role = $1::base_role and rp.deleted_at is null
      order by p.display_order`,
    [role],
  );
}

export async function grantsForUser(userId) {
  return query(
    `select g.id, g.permission_id, p.code as permission_code, p.name_he,
            g.effect::text as effect, g.scope_type::text as scope_type, g.scope_id,
            g.valid_from, g.valid_to, g.reason, g.granted_by,
            granter.full_name as granted_by_name,
            g.revoked_at, g.revoke_reason, g.created_at, g.row_version,
            case
              when g.revoked_at is not null then 'revoked'
              when g.valid_to is not null and g.valid_to <= now() then 'expired'
              when g.valid_from > now() then 'scheduled'
              else 'active'
            end as state,
            coalesce(s.name, d.name, sc.name) as scope_name
       from permission_grants g
       join permissions p on p.id = g.permission_id
       left join profiles granter on granter.id = g.granted_by
       left join sites s on s.id = g.scope_id and g.scope_type = 'site'
       left join domains d on d.id = g.scope_id and g.scope_type = 'domain'
       left join sub_categories sc on sc.id = g.scope_id and g.scope_type = 'sub_category'
      where g.user_id = $1 and g.deleted_at is null
      order by g.created_at desc`,
    [userId],
  );
}

/**
 * תצוגה מקדימה: מה יהיו ההרשאות האפקטיביות אם נשמור את ההרשאות שבטיוטה.
 *
 * §3.2 דורש "הצגת הרשאות אפקטיביות לפני שמירה". זה קורא בלבד ואינו כותב,
 * ולכן המנהל יכול לשחק עם ההגדרה עד שהמטריצה נראית כמו שהוא מתכוון.
 */
export async function preview(userId, draftGrants = []) {
  const principal = await loadPrincipal(userId, { fresh: true });
  if (!principal) throw new AppError('E_NOT_FOUND', 'המשתמש המבוקש לא נמצא');

  const codes = draftGrants.map((g) => g.permissionCode);
  const rows = codes.length
    ? await query(
        `select code, resource, action::text as action from permissions where code = any($1)`,
        [codes],
      )
    : [];
  const byCode = new Map(rows.map((r) => [r.code, r]));

  const draftEntries = draftGrants
    .map((g) => {
      const perm = byCode.get(g.permissionCode);
      if (!perm) return null;
      return {
        resource: perm.resource,
        action: perm.action,
        effect: g.effect,
        scope_type: g.scopeType,
        scope_id: g.scopeId ?? null,
        source: 'grant',
        valid_to: g.validTo ?? null,
      };
    })
    .filter(Boolean);

  return {
    userId,
    baseRole: principal.baseRole,
    matrix: effectiveMatrix(principal, draftEntries),
    isExtension: await isExtension(principal, draftEntries),
  };
}

/**
 * האם ההרשאה מרחיבה מעבר לתפקיד הבסיס.
 * זה מה שמפעיל את "סיבה — שדה חובה בהרחבה חריגה".
 */
async function isExtension(principal, draftEntries) {
  return draftEntries.some((draft) => {
    if (draft.effect !== 'allow') return false;
    return !principal.entries.some(
      (e) =>
        e.source === 'role' &&
        e.resource === draft.resource &&
        (e.action === draft.action || e.action === 'manage') &&
        (e.scope_type === 'global' || e.scope_type === draft.scope_type),
    );
  });
}

/** הענקת הרשאה. אידמפוטנטית לפי המפתח הטבעי. */
export async function grant(actor, input) {
  return withTransaction({ actorId: actor.userId, traceId: input.traceId }, async (tx) => {
    const target = await tx.required(
      'select id, full_name, base_role from profiles where id = $1 and deleted_at is null',
      [input.userId],
      'המשתמש המבוקש לא נמצא',
    );

    const permission = await tx.required(
      'select id, code, resource, action::text as action, name_he from permissions where code = $1 and is_active',
      [input.permissionCode],
      'ההרשאה המבוקשת אינה קיימת בקטלוג',
    );

    // הרשאה זהה שכבר קיימת — מחזירים אותה במקום ליצור כפילות
    const [dup] = await tx.query(
      `select * from permission_grants
        where user_id = $1 and permission_id = $2 and effect = $3::perm_effect
          and scope_type = $4::scope_type
          and coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
              = coalesce($5::uuid, '00000000-0000-0000-0000-000000000000'::uuid)
          and revoked_at is null and deleted_at is null`,
      [input.userId, permission.id, input.effect, input.scopeType, input.scopeId ?? null],
    );
    if (dup) return { grant: dup, created: false };

    const [row] = await tx.query(
      `insert into permission_grants
         (user_id, permission_id, effect, scope_type, scope_id,
          valid_from, valid_to, reason, granted_by)
       values ($1, $2, $3::perm_effect, $4::scope_type, $5,
               coalesce($6::timestamptz, now()), $7, $8, $9)
       returning *`,
      [
        input.userId,
        permission.id,
        input.effect,
        input.scopeType,
        input.scopeId ?? null,
        input.validFrom ?? null,
        input.validTo ?? null,
        input.reason ?? null,
        actor.userId,
      ],
    );

    await notify(tx, {
      typeCode: 'permission_changed',
      recipientIds: [input.userId],
      title: 'ההרשאות שלך עודכנו',
      body: `${permission.name_he} — ${input.effect === 'allow' ? 'הורחבה' : 'צומצמה'}`,
      entityType: 'permission_grants',
      entityId: row.id,
    });

    invalidatePrincipal(input.userId);
    return { grant: row, created: true, target };
  });
}

export async function revoke(actor, grantId, reason) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const existing = await tx.lock('permission_grants', grantId);
    if (!existing) throw new AppError('E_NOT_FOUND', 'ההרשאה המבוקשת לא נמצאה');

    // ביטול חוזר אינו שגיאה — זו פעולה אידמפוטנטית
    if (existing.revoked_at) {
      return { grant: existing, alreadyRevoked: true };
    }

    const [row] = await tx.query(
      `update permission_grants
          set revoked_at = now(), revoked_by = $2, revoke_reason = $3
        where id = $1 returning *`,
      [grantId, actor.userId, reason ?? null],
    );

    const [perm] = await tx.query('select name_he from permissions where id = $1', [
      existing.permission_id,
    ]);

    await notify(tx, {
      typeCode: 'permission_changed',
      recipientIds: [existing.user_id],
      title: 'הרשאה הוסרה',
      body: perm?.name_he ?? '',
      entityType: 'permission_grants',
      entityId: grantId,
    });

    invalidatePrincipal(existing.user_id);
    return { grant: row, alreadyRevoked: false };
  });
}

/** ההרשאות האפקטיביות של משתמש אחר — למסך ההרשאות ולתמיכה */
export async function effectiveFor(userId) {
  const principal = await loadPrincipal(userId, { fresh: true });
  if (!principal) throw new AppError('E_NOT_FOUND', 'המשתמש המבוקש לא נמצא');
  return {
    userId,
    fullName: principal.fullName,
    baseRole: principal.baseRole,
    status: principal.status,
    scopes: principal.scopes,
    matrix: effectiveMatrix(principal),
  };
}

/** מסמן הרשאות שפג תוקפן — /internal/cron/expire-grants */
export async function expireGrants() {
  const rows = await query(
    `update permission_grants
        set revoked_at = now(), revoke_reason = 'פג תוקף'
      where revoked_at is null and deleted_at is null
        and valid_to is not null and valid_to <= now()
      returning id, user_id`,
  );
  rows.forEach((r) => invalidatePrincipal(r.user_id));
  return rows.length;
}
