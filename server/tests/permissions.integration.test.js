import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';

const DB = 'hatmaha_perm';

const hasDb = await dbAvailable();
const describeDb = hasDb ? describe : describe.skip;

if (hasDb) {
  process.env.DATABASE_URL = dbUrlFor(DB);
  process.env.DB_SSL = 'false';
}

// requireAuth מדומה: הוא טוען Principal אמיתי מהמסד לפי כותרת בדיקה.
// כך מנוע ההרשאות והשאילתות נבדקים באמת, ורק קריאת הרשת ל-Supabase מוחלפת.
vi.mock('../src/middleware/requireAuth.js', () => ({
  requireAuth: async (req, _res, next) => {
    const { loadPrincipal } = await import('../src/permissions/repository.js');
    const principal = await loadPrincipal(req.get('x-test-user'), { fresh: true });
    if (!principal) return next(new Error('no principal'));
    req.user = principal;
    next();
  },
  forgetToken: () => {},
}));

describeDb('הרשאות — מקצה לקצה מול מסד אמיתי', () => {
  let app, base, server, manager, implementer, siteId;

  beforeAll(async () => {
    resetSchema({ db: DB });

    const { withTransaction, query } = await import('../src/lib/db.js');
    await withTransaction({}, async (tx) => {
      manager = await createUser(tx, { email: 'mgr@test.local', fullName: 'דנה כהן', role: 'manager' });
      implementer = await createUser(tx, { email: 'imp@test.local', fullName: 'נועה פרץ' });
      const [site] = await tx.query(
        `insert into sites (name, status_id)
         select 'מרכז רפואי צפון', id from site_statuses where code = 'training'
         returning id`,
      );
      siteId = site.id;
    });

    const { createApp } = await import('../src/app.js');
    app = createApp();
    server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  const call = (path, { as, method = 'GET', body } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        'x-test-user': as,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  it('AC-01: קיימים בדיוק ארבעה תפקידי בסיס', async () => {
    const { query } = await import('../src/lib/db.js');
    const rows = await query('select unnest(enum_range(null::base_role))::text as role');
    expect(rows.map((r) => r.role).sort()).toEqual(['implementer', 'lead', 'manager', 'mentor']);
  });

  it('המשתמש הראשון נהיה מנהל אוטומטית, השני לא', () => {
    expect(manager.base_role).toBe('manager');
    expect(implementer.base_role).toBe('implementer');
  });

  it('מטמיע אינו רשאי לגשת למסך ההרשאות', async () => {
    const res = await call('/api/permissions/catalog', { as: implementer.id });
    expect(res.status).toBe(403);
    const { error } = await res.json();
    expect(error.code).toBe('E_FORBIDDEN');
  });

  it('מנהל מקבל את קטלוג ההרשאות', async () => {
    const res = await call('/api/permissions/catalog', { as: manager.id });
    expect(res.status).toBe(200);
    const { resources } = await res.json();
    expect(resources).toHaveLength(18);
    expect(resources.map((r) => r.resource)).toContain('roster');
  });

  it('AC-03: תצוגה מקדימה מראה מה ישתנה — בלי לשמור דבר', async () => {
    const res = await call('/api/permissions/preview', {
      as: manager.id,
      method: 'POST',
      body: {
        userId: implementer.id,
        draftGrants: [
          { permissionCode: 'roster.edit', effect: 'allow', scopeType: 'site', scopeId: siteId },
        ],
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.matrix.roster.edit.allowed).toBe(true);
    expect(body.matrix.roster.edit.changed).toBe(true);
    expect(body.isExtension).toBe(true);

    // התצוגה המקדימה לא שמרה דבר
    const grants = await (await call(`/api/permissions/grants?userId=${implementer.id}`, { as: manager.id })).json();
    expect(grants.grants).toHaveLength(0);
  });

  it('הרחבה ללא סיבה נדחית עם שם השדה', async () => {
    const res = await call('/api/permissions/grants', {
      as: manager.id,
      method: 'POST',
      body: { userId: implementer.id, permissionCode: 'roster.edit', effect: 'allow', scopeType: 'site', scopeId: siteId },
    });
    expect(res.status).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('E_VALIDATION');
    expect(error.details.fields[0].field).toBe('reason');
  });

  it('AC-02: מנהל מעניק הרשאה פרטנית, והיא נכנסת לתוקף מיד', async () => {
    // לפני: אין הרשאה
    const before = await call('/api/permissions/effective/' + implementer.id, { as: manager.id });
    expect((await before.json()).matrix.roster.edit.allowed).toBe(false);

    const res = await call('/api/permissions/grants', {
      as: manager.id,
      method: 'POST',
      body: {
        userId: implementer.id, permissionCode: 'roster.edit', effect: 'allow',
        scopeType: 'site', scopeId: siteId, reason: 'החלפת רכזת שיצאה לחופשת לידה',
      },
    });
    expect(res.status).toBe(201);

    // אחרי: ההרשאה קיימת, בלי deploy ובלי restart
    const after = await call('/api/permissions/effective/' + implementer.id, { as: manager.id });
    const m = (await after.json()).matrix;
    expect(m.roster.edit.allowed).toBe(true);
    expect(m.roster.edit.scopes).toContain('אתר');
    expect(m.roster.edit.fromGrant).toBe(true);
  });

  it('הענקה חוזרת של אותה הרשאה אינה יוצרת כפילות', async () => {
    const body = {
      userId: implementer.id, permissionCode: 'roster.edit', effect: 'allow',
      scopeType: 'site', scopeId: siteId, reason: 'החלפת רכזת שיצאה לחופשת לידה',
    };
    const res = await call('/api/permissions/grants', { as: manager.id, method: 'POST', body });
    expect(res.status).toBe(200);
    expect((await res.json()).created).toBe(false);

    const grants = await (await call(`/api/permissions/grants?userId=${implementer.id}`, { as: manager.id })).json();
    expect(grants.grants.filter((g) => g.state === 'active')).toHaveLength(1);
  });

  it('ביטול מסיר את ההרשאה מיד', async () => {
    const list = await (await call(`/api/permissions/grants?userId=${implementer.id}`, { as: manager.id })).json();
    const grantId = list.grants[0].id;

    const res = await call(`/api/permissions/grants/${grantId}`, {
      as: manager.id, method: 'DELETE', body: { reason: 'הרכזת חזרה' },
    });
    expect(res.status).toBe(200);

    const after = await call('/api/permissions/effective/' + implementer.id, { as: manager.id });
    expect((await after.json()).matrix.roster.edit.allowed).toBe(false);
  });

  it('לא ניתן לשלול ניהול הרשאות — המערכת חייבת להישאר ניתנת לניהול', async () => {
    const res = await call('/api/permissions/grants', {
      as: manager.id,
      method: 'POST',
      body: { userId: manager.id, permissionCode: 'permissions.manage', effect: 'deny', scopeType: 'global' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('בלתי ניתנת לניהול');
  });

  it('AC-04: כל סירוב נרשם ביומן הביקורת', async () => {
    const { query } = await import('../src/lib/db.js');
    const rows = await query(
      `select after_data from audit_log where action = 'denied' order by occurred_at desc limit 5`,
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].after_data).toHaveProperty('resource');
  });
});
