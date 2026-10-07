import { describe, it, expect } from 'vitest';
import {
  decide, can, capabilities, effectiveMatrix, scopeMatches, DENY_REASONS,
} from '../src/permissions/engine.js';

const SITE_A = '11111111-1111-1111-1111-111111111111';
const SITE_B = '22222222-2222-2222-2222-222222222222';
const DOM_A  = '33333333-3333-3333-3333-333333333333';
const SUB_A  = '44444444-4444-4444-4444-444444444444';
const ME     = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const MINE   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; // מטמיע שמשויך אליי
const OTHER  = 'cccccccc-cccc-cccc-cccc-cccccccccccc'; // מטמיע של מישהו אחר

const entry = (resource, action, effect, scope_type, scope_id = null, source = 'role') =>
  ({ resource, action, effect, scope_type, scope_id, source, valid_to: null });

const principal = (entries, overrides = {}) => ({
  userId: ME,
  baseRole: 'mentor',
  status: 'active',
  entries,
  scopes: {
    siteIds: [SITE_A],
    domainIds: [DOM_A],
    subCategoryIds: [SUB_A],
    assignedUserIds: [MINE],
    ...(overrides.scopes ?? {}),
  },
  ...overrides,
});

describe('אין הרשאה משתמעת', () => {
  it('משתמש ללא זכות מתאימה מסורב', () => {
    const p = principal([entry('roster', 'view', 'allow', 'global')]);
    const d = decide(p, 'roster', 'publish', {});
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DENY_REASONS.NO_IMPLICIT);
  });

  it('משתמש לא פעיל מסורב תמיד', () => {
    const p = principal([entry('roster', 'manage', 'allow', 'global')], { status: 'suspended' });
    expect(can(p, 'roster', 'publish')).toBe(false);
  });

  it('ללא principal — מסורב', () => {
    expect(decide(null, 'roster', 'view').reason).toBe(DENY_REASONS.NOT_AUTHENTICATED);
  });
});

describe('Deny מפורש גובר על Allow', () => {
  it('Deny גלובלי חוסם Allow גלובלי', () => {
    const p = principal([
      entry('roster', 'edit', 'allow', 'global'),
      entry('roster', 'edit', 'deny', 'global', null, 'grant'),
    ]);
    expect(decide(p, 'roster', 'edit', { siteId: SITE_A }).reason).toBe(DENY_REASONS.EXPLICIT_DENY);
  });

  it('Deny ממוקד לאתר חוסם רק באותו אתר', () => {
    const p = principal([
      entry('roster', 'edit', 'allow', 'global'),
      entry('roster', 'edit', 'deny', 'site', SITE_B, 'grant'),
    ]);
    expect(can(p, 'roster', 'edit', { siteId: SITE_B })).toBe(false);
    expect(can(p, 'roster', 'edit', { siteId: SITE_A })).toBe(true);
  });

  it('ללא הקשר — רק Deny גלובלי חוסם, כדי שפריט ניווט לא ייעלם בכל המערכת', () => {
    const scoped = principal([
      entry('roster', 'edit', 'allow', 'global'),
      entry('roster', 'edit', 'deny', 'site', SITE_B, 'grant'),
    ]);
    expect(can(scoped, 'roster', 'edit')).toBe(true);

    const globalDeny = principal([
      entry('roster', 'edit', 'allow', 'global'),
      entry('roster', 'edit', 'deny', 'global', null, 'grant'),
    ]);
    expect(can(globalDeny, 'roster', 'edit')).toBe(false);
  });
});

describe('Manage מספק כל פעולה — אך רק בתוך ה-Scope שלו', () => {
  it('Manage גלובלי מתיר כל פעולה', () => {
    const p = principal([entry('sites', 'manage', 'allow', 'global')], { baseRole: 'manager' });
    for (const a of ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export']) {
      expect(can(p, 'sites', a, { siteId: SITE_A })).toBe(true);
    }
  });

  it('Manage על אתר אחד אינו מקנה הרשאה באתר אחר', () => {
    const p = principal([entry('roster', 'manage', 'allow', 'site', SITE_A, 'grant')]);
    expect(can(p, 'roster', 'delete', { siteId: SITE_A })).toBe(true);
    expect(can(p, 'roster', 'delete', { siteId: SITE_B })).toBe(false);
  });
});

describe('התאמת Scope', () => {
  const p = principal([]);

  it('own_data — רק המשתמש עצמו', () => {
    const e = entry('users', 'edit', 'allow', 'own_data');
    expect(scopeMatches(e, p, { targetUserId: ME })).toBe(true);
    expect(scopeMatches(e, p, { targetUserId: MINE })).toBe(false);
    expect(scopeMatches(e, p, { ownerId: ME })).toBe(true);
  });

  it('assigned_users — אני והמטמיעים שמשויכים אליי', () => {
    const e = entry('implementers', 'edit', 'allow', 'assigned_users');
    expect(scopeMatches(e, p, { targetUserId: ME })).toBe(true);
    expect(scopeMatches(e, p, { targetUserId: MINE })).toBe(true);
    expect(scopeMatches(e, p, { targetUserId: OTHER })).toBe(false);
  });

  it('site — ללא scope_id, האתרים שלי; עם scope_id, רק הוא', () => {
    expect(scopeMatches(entry('roster', 'view', 'allow', 'site'), p, { siteId: SITE_A })).toBe(true);
    expect(scopeMatches(entry('roster', 'view', 'allow', 'site'), p, { siteId: SITE_B })).toBe(false);
    const pinned = entry('roster', 'view', 'allow', 'site', SITE_B, 'grant');
    expect(scopeMatches(pinned, p, { siteId: SITE_B })).toBe(true);
    expect(scopeMatches(pinned, p, { siteId: SITE_A })).toBe(false);
  });

  it('sub_category — חיתוך, גם כשמועברת רשימה', () => {
    const e = entry('activities', 'view', 'allow', 'sub_category');
    expect(scopeMatches(e, p, { subCategoryIds: [SUB_A, 'zzz'] })).toBe(true);
    expect(scopeMatches(e, p, { subCategoryIds: ['zzz'] })).toBe(false);
    expect(scopeMatches(e, p, { subCategoryId: SUB_A })).toBe(true);
  });

  it('Scope שדורש הקשר מסורב כשההקשר חסר', () => {
    expect(scopeMatches(entry('roster', 'view', 'allow', 'site'), p, {})).toBe(false);
  });
});

describe('מחוץ ל-Scope — AC-13', () => {
  it('מדריך אינו רואה מטמיע שאינו משויך אליו', () => {
    const p = principal([entry('implementers', 'view', 'allow', 'assigned_users')]);
    expect(can(p, 'implementers', 'view', { targetUserId: MINE })).toBe(true);
    const d = decide(p, 'implementers', 'view', { targetUserId: OTHER });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe(DENY_REASONS.OUT_OF_SCOPE);
  });
});

describe('capabilities — מזין את הסתרת הניווט בלקוח', () => {
  it('מחזיר רק את מה שאפשרי', () => {
    const p = principal([
      entry('roster', 'view', 'allow', 'site'),
      entry('requests', 'create', 'allow', 'own_data'),
    ]);
    const caps = capabilities(p);
    expect(caps.roster).toEqual(['view']);
    expect(caps.requests).toEqual(['create']);
    expect(caps.permissions).toBeUndefined();
  });
});

describe('מטריצת הרשאות אפקטיביות — התצוגה המקדימה של §3.2', () => {
  it('מסמנת את ה-Scopes המתירים', () => {
    const p = principal([entry('roster', 'view', 'allow', 'site')]);
    const m = effectiveMatrix(p);
    expect(m.roster.view.allowed).toBe(true);
    expect(m.roster.view.scopes).toEqual(['אתר']);
    expect(m.roster.publish.allowed).toBe(false);
  });

  it('Deny גלובלי מסומן כחסום ולא כ"מותר בתנאים"', () => {
    const p = principal([
      entry('roster', 'view', 'allow', 'site'),
      entry('roster', 'view', 'deny', 'global', null, 'grant'),
    ]);
    const m = effectiveMatrix(p);
    expect(m.roster.view.blocked).toBe(true);
    expect(m.roster.view.summary).toBe('חסום');
  });

  it('הרשאה טיוטה מסומנת כשינוי — זה מה שהמנהל רואה לפני שהוא שומר', () => {
    const p = principal([entry('roster', 'view', 'allow', 'site')]);
    const draft = [entry('roster', 'publish', 'allow', 'site', SITE_A, 'grant')];
    const m = effectiveMatrix(p, draft);

    expect(m.roster.publish.allowed).toBe(true);
    expect(m.roster.publish.changed).toBe(true);
    expect(m.roster.publish.fromGrant).toBe(true);
    // תא שלא הושפע אינו מסומן כשינוי
    expect(m.roster.view.changed).toBe(false);
  });
});

describe('ארבעת תפקידי הבסיס — טבלת אמת כתובה ביד', () => {
  const implementer = principal(
    [
      entry('requests', 'create', 'allow', 'own_data'),
      entry('availability', 'create', 'allow', 'own_data'),
      entry('teamSchedule', 'view', 'allow', 'site'),
      entry('roster', 'view', 'allow', 'own_data'),
    ],
    { baseRole: 'implementer', scopes: { siteIds: [SITE_A], domainIds: [], subCategoryIds: [], assignedUserIds: [] } },
  );

  const cases = [
    ['מגיש בקשה לעצמו',            'requests', 'create', { targetUserId: ME },    true],
    ['אינו מגיש בקשה עבור אחר',    'requests', 'create', { targetUserId: OTHER }, false],
    ['רואה לו״ז צוותי באתר שלו',   'teamSchedule', 'view', { siteId: SITE_A },    true],
    ['אינו רואה לו״ז באתר אחר',    'teamSchedule', 'view', { siteId: SITE_B },    false],
    ['אינו מפרסם סידור',           'roster', 'publish', { siteId: SITE_A },       false],
    ['אינו מנהל הרשאות',           'permissions', 'manage', {},                   false],
  ];

  it.each(cases)('מטמיע %s', (_name, resource, action, ctx, expected) => {
    expect(can(implementer, resource, action, ctx)).toBe(expected);
  });
});
