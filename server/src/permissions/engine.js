/**
 * מנוע ההרשאות. פונקציות טהורות: מקבל Principal טעון ומחזיר החלטה.
 *
 * הכללים, ישירות מ-§3.1 של האפיון:
 *   • Deny מפורש גובר על Allow.
 *   • אין הרשאה משתמעת — היעדר זכות מתאימה משמעו סירוב.
 *   • הרשאה פרטנית יכולה להרחיב או לצמצם את תפקיד הבסיס.
 *   • הרשאה שפג תוקפה בטלה — מסונן כבר בשאילתה, ולכן מיידי.
 *
 * שתי דקויות שנשמרו ממנוע הרפרנס:
 *   1. ללא הקשר, רק Deny ברמת Global חוסם. פריט ניווט או כפתור "הוספה"
 *      שואלים "האם אי־פעם מותר לי?", ו-Deny ברמת אתר בודד לא אמור
 *      להעלים אותם בכל המערכת.
 *   2. Manage מספק כל פעולה — אבל רק בתוך ה-Scope של עצמו. לכן
 *      Manage על אתר מסוים אינו מקנה Delete גלובלי.
 */

export const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'manage'];

export const RESOURCES = [
  'users', 'implementers', 'mentors', 'sites', 'domains', 'activities',
  'availability', 'requests', 'rules', 'roster', 'teamSchedule', 'materials',
  'updates', 'chat', 'reports', 'audit', 'permissions', 'settings', 'skills',
];

/** סיבות סירוב — מוחזרות ללקוח כדי שמסך "אין הרשאה" יוכל להסביר */
export const DENY_REASONS = {
  NOT_AUTHENTICATED: 'לא מחובר',
  INACTIVE: 'המשתמש אינו פעיל',
  NO_IMPLICIT: 'אין הרשאה משתמעת',
  EXPLICIT_DENY: 'ההרשאה נשללה במפורש',
  OUT_OF_SCOPE: 'הפריט נמצא מחוץ לתחום האחריות שלך',
};

const isEmptyCtx = (ctx) =>
  !ctx ||
  Object.values(ctx).every(
    (v) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0),
  );

/**
 * האם זכות מסוימת חלה על ההקשר שנשאל.
 * @param {object} entry זכות מ-role_permissions או מ-permission_grants
 * @param {object} principal
 * @param {object} ctx  { siteId, domainId, subCategoryId, subCategoryIds, ownerId, targetUserId }
 */
export function scopeMatches(entry, principal, ctx) {
  const { scopes, userId } = principal;

  switch (entry.scope_type) {
    case 'global':
      return true;

    case 'own_data':
      return [ctx.targetUserId, ctx.ownerId, ctx.userId].some((id) => !!id && id === userId);

    case 'assigned_users': {
      const target = ctx.targetUserId ?? ctx.userId ?? ctx.ownerId;
      if (!target) return false;
      return target === userId || scopes.assignedUserIds.includes(target);
    }

    case 'site': {
      if (!ctx.siteId) return false;
      // scope_id מפורש בהרשאה פרטנית מצמצם לאתר אחד;
      // בהיעדרו, ה-Scope הוא האתרים של המשתמש ואלה שהוא אחראי עליהם כמדריך
      return entry.scope_id ? ctx.siteId === entry.scope_id : scopes.siteIds.includes(ctx.siteId);
    }

    case 'domain': {
      if (!ctx.domainId) return false;
      return entry.scope_id
        ? ctx.domainId === entry.scope_id
        : scopes.domainIds.includes(ctx.domainId);
    }

    case 'sub_category': {
      const wanted = ctx.subCategoryIds ?? (ctx.subCategoryId ? [ctx.subCategoryId] : []);
      if (wanted.length === 0) return false;
      const allowed = entry.scope_id ? [entry.scope_id] : scopes.subCategoryIds;
      return wanted.some((id) => allowed.includes(id));
    }

    default:
      return false;
  }
}

/** הזכויות שמדברות על משאב ופעולה מסוימים */
function relevantEntries(principal, resource, action) {
  return principal.entries.filter(
    (e) => e.resource === resource && (e.action === action || e.action === 'manage'),
  );
}

/**
 * ההחלטה המלאה, עם הנמקה.
 * @returns {{ allowed: boolean, reason: string, via?: object, scopes?: string[] }}
 */
export function decide(principal, resource, action, ctx = {}) {
  if (!principal) return { allowed: false, reason: DENY_REASONS.NOT_AUTHENTICATED };
  if (principal.status !== 'active') return { allowed: false, reason: DENY_REASONS.INACTIVE };

  const entries = relevantEntries(principal, resource, action);
  if (entries.length === 0) return { allowed: false, reason: DENY_REASONS.NO_IMPLICIT };

  const noCtx = isEmptyCtx(ctx);
  const denies = entries.filter((e) => e.effect === 'deny');
  const allows = entries.filter((e) => e.effect === 'allow');

  // Deny מפורש גובר — אך רק Deny שה-Scope שלו באמת מכסה את ההקשר
  for (const d of denies) {
    if (noCtx ? d.scope_type === 'global' : scopeMatches(d, principal, ctx)) {
      return { allowed: false, reason: DENY_REASONS.EXPLICIT_DENY, via: d };
    }
  }

  for (const a of allows) {
    if (noCtx || scopeMatches(a, principal, ctx)) {
      return { allowed: true, reason: 'allowed', via: a };
    }
  }

  return { allowed: false, reason: DENY_REASONS.OUT_OF_SCOPE };
}

/** תשובה בוליאנית פשוטה */
export function can(principal, resource, action, ctx = {}) {
  return decide(principal, resource, action, ctx).allowed;
}

/**
 * הצירופים שה-Scope שלהם מאפשר לעשות משהו — בלי להתייחס לפריט מסוים.
 * זה מה שמזין את הסתרת פריטי הניווט בלקוח.
 */
export function capabilities(principal) {
  const out = {};
  if (!principal || principal.status !== 'active') return out;

  for (const resource of RESOURCES) {
    for (const action of ACTIONS) {
      if (decide(principal, resource, action).allowed) {
        (out[resource] ??= []).push(action);
      }
    }
  }
  return out;
}

const SCOPE_LABELS = {
  global: 'מערכת',
  site: 'אתר',
  domain: 'תחום',
  sub_category: 'תת-קטגוריה',
  assigned_users: 'משויכים אליי',
  own_data: 'מידע אישי',
};

/**
 * מטריצת ההרשאות האפקטיביות: משאב × פעולה, ולכל תא ה-Scopes שמתירים אותו.
 *
 * זה בדיוק מה ש-§3.2 דורש כ"תצוגה מקדימה — הצגת הרשאות אפקטיביות לפני
 * שמירה": מעבירים draftEntries של הרשאה שטרם נשמרה, ומקבלים את המטריצה
 * שתהיה, עם סימון מה השתנה.
 *
 * @param {Principal} principal
 * @param {Array}  [draftEntries] זכויות נוספות שטרם נשמרו
 */
export function effectiveMatrix(principal, draftEntries = []) {
  const base = draftEntries.length ? buildMatrix(principal) : null;
  const withDraft = draftEntries.length
    ? buildMatrix({ ...principal, entries: [...principal.entries, ...draftEntries] })
    : null;

  const matrix = withDraft ?? buildMatrix(principal);

  if (base) {
    for (const resource of RESOURCES) {
      for (const action of ACTIONS) {
        matrix[resource][action].changed =
          base[resource][action].summary !== matrix[resource][action].summary;
      }
    }
  }
  return matrix;
}

function buildMatrix(principal) {
  const matrix = {};

  for (const resource of RESOURCES) {
    matrix[resource] = {};

    for (const action of ACTIONS) {
      const entries = relevantEntries(principal, resource, action);
      const denies = entries.filter((e) => e.effect === 'deny');
      const globalDeny = denies.some((e) => e.scope_type === 'global');

      // Allow נופל אם יש Deny באותו Scope בדיוק
      const allows = globalDeny
        ? []
        : entries.filter(
            (e) =>
              e.effect === 'allow' &&
              !denies.some(
                (d) => d.scope_type === e.scope_type && (d.scope_id ?? null) === (e.scope_id ?? null),
              ),
          );

      const scopes = [...new Set(allows.map((e) => SCOPE_LABELS[e.scope_type] ?? e.scope_type))];
      const expiries = allows.map((e) => e.valid_to).filter(Boolean).sort();

      matrix[resource][action] = {
        allowed: allows.length > 0,
        blocked: globalDeny,
        scopes,
        summary: globalDeny ? 'חסום' : scopes.join(', '),
        fromGrant: allows.some((e) => e.source === 'grant'),
        expiresAt: expiries[0] ?? null,
        changed: false,
      };
    }
  }
  return matrix;
}
