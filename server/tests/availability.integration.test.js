import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';
import { addDays } from '../src/lib/time.js';

const DB = 'hatmaha_availability';
const hasDb = await dbAvailable();
const describeDb = hasDb ? describe : describe.skip;

if (hasDb) {
  process.env.DATABASE_URL = dbUrlFor(DB);
  process.env.DB_SSL = 'false';
}

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

/**
 * זמינות לפי חלונות שעות.
 *
 * לכל מיקום משמרות משלו, ולכן הזמינות מוצהרת על חלונות שעות. הבדיקות כאן
 * מכסות את החלונות עצמם ואת הקשר שלהם לשיבוץ — כולל הבאג שבו מי שהצהיר
 * "יכול" בכל השבוע קיבל אזהרת "לא הוצהרה זמינות" על כל שיבוץ.
 */
describeDb('זמינות לפי חלונות שעות', () => {
  let base, server, manager, noa, itay, omer, siteId, wardId, erId;
  let morningId, erDayId, weekStart, draftId;

  beforeAll(async () => {
    resetSchema({ db: DB });
    const { withTransaction } = await import('../src/lib/db.js');

    await withTransaction({}, async (tx) => {
      manager = await createUser(tx, { email: 'm@t.local', fullName: 'דנה כהן', role: 'manager' });
      noa = await createUser(tx, { email: 'n@t.local', fullName: 'נועה פרץ' });
      itay = await createUser(tx, { email: 'i@t.local', fullName: 'איתי מזרחי' });
      omer = await createUser(tx, { email: 'o@t.local', fullName: 'עומר דהן' });

      // ללא מועד הגשה, כדי שהבדיקה לא תלויה ביום בשבוע שבו היא רצה
      const [site] = await tx.query(
        `insert into sites (name, status_id, open_time, close_time, availability_deadline_weekday)
         select 'מרכז רפואי צפון', id, '00:00', '23:59', null from site_statuses where code='golive'
         returning id`,
      );
      siteId = site.id;

      const locs = await tx.query(
        `insert into locations (site_id, name) values ($1, 'מחלקה'), ($1, 'מיון') returning id, name`,
        [siteId],
      );
      wardId = locs.find((l) => l.name === 'מחלקה').id;
      erId = locs.find((l) => l.name === 'מיון').id;

      // "בוקר" במחלקה ו"בוקר מיון" חולקים את אותן שעות — חלון אחד
      const shifts = await tx.query(
        `insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff)
         values ($1, 'בוקר', '07:00', '15:00', true, 1),
                ($1, 'ערב', '15:00', '23:00', false, 1),
                ($2, 'בוקר מיון', '07:00', '15:00', false, 1),
                ($2, 'יום', '07:00', '16:00', false, 1)
         returning id, name`,
        [wardId, erId],
      );
      morningId = shifts.find((s) => s.name === 'בוקר').id;
      erDayId = shifts.find((s) => s.name === 'יום').id;

      await tx.query(
        `insert into site_assignments (site_id, user_id) values ($1,$2), ($1,$3), ($1,$4)`,
        [siteId, noa.id, itay.id, omer.id],
      );
    });

    server = (await import('../src/app.js')).createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  const call = (path, { as, method = 'GET', body, key } = {}) =>
    fetch(base + path, {
      method,
      headers: {
        'x-test-user': as,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(key ? { 'idempotency-key': key } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  const declare = async (user, cells) => {
    const save = await call('/api/availability/declarations', {
      as: user.id, method: 'PUT', body: { siteId, weekStart, cells },
    });
    expect(save.status).toBe(200);
    const { declarationId } = await save.json();
    const submit = await call(`/api/availability/declarations/${declarationId}/submit`, {
      as: user.id, method: 'POST', key: `submit-${declarationId}`,
    });
    return { declarationId, res: submit, body: await submit.json() };
  };

  const assign = (user, payload, key) =>
    call(`/api/roster/versions/${draftId}/assignments`, {
      as: manager.id, method: 'POST', key,
      body: { userId: user.id, date: addDays(weekStart, 1), ...payload },
    });

  const availabilityWarning = (body) =>
    [...(body.warnings ?? []), ...(body.exceptions ?? [])]
      .find((w) => (w.name ?? w.ruleName) === 'שיבוץ רק בזמינות שהוצהרה');

  it('חלון ההגשה מחזיר חלונות שעות ייחודיים ולא משמרות', async () => {
    const res = await call(`/api/availability/window?siteId=${siteId}`, { as: noa.id });
    expect(res.status).toBe(200);
    const win = await res.json();
    weekStart = win.weekStart;

    expect(win.windows.map((w) => w.key)).toEqual(['07:00-15:00', '07:00-16:00', '15:00-23:00']);
    const morning = win.windows.find((w) => w.key === '07:00-15:00');
    expect(morning.label).toContain('בוקר');
    expect(morning.label).toContain('בוקר מיון');
    // חובה אם אחת המשמרות בחלון היא חובה
    expect(morning.isMandatory).toBe(true);
    expect(win.windows.find((w) => w.key === '07:00-16:00').isMandatory).toBe(false);

    const draft = await (await call(`/api/roster/draft?siteId=${siteId}&weekStart=${weekStart}`, {
      as: manager.id,
    })).json();
    draftId = draft.version.id;
  });

  it('"לא יכול" על חלון חובה נרשם כחריגה', async () => {
    const { body } = await declare(itay, [
      { date: addDays(weekStart, 1), startTime: '07:00', endTime: '15:00', value: 'cannot' },
    ]);
    const declarations = await (await call(`/api/availability/declarations?weekStart=${weekStart}`, {
      as: itay.id,
    })).json();
    const violations = declarations.declarations[0].violations;
    expect(violations.map((v) => v.kind)).toContain('mandatory_cannot');
    const v = violations.find((x) => x.kind === 'mandatory_cannot');
    expect(v.start_time.slice(0, 5)).toBe('07:00');
    expect(body.declaration ?? body).toBeTruthy();
  });

  it('⭐ מי שהצהיר "יכול" בכל השבוע אינו מקבל אזהרת זמינות', async () => {
    // הצהרה בלי אף תא: הכול "יכול", שאינו נשמר
    const { res } = await declare(noa, []);
    expect(res.status).toBe(200);

    const r = await assign(noa, { locationId: wardId, shiftTypeId: morningId }, 'noa-1');
    expect(r.status).toBe(201);
    const body = await r.json();
    expect(availabilityWarning(body)).toBeUndefined();
  });

  it('מי שלא הגיש הצהרה מקבל אזהרה', async () => {
    const r = await assign(omer, { locationId: erId, shiftTypeId: erDayId }, 'omer-1');
    const body = await r.json();
    const warning = availabilityWarning(body);
    expect(warning).toBeDefined();
    expect(warning.detail ?? warning.message).toContain('לא הוגשה');
  });

  it('שיבוץ שחופף לחלון "לא יכול" מזוהה גם במשמרת של מיקום אחר', async () => {
    // איתי סימן "לא יכול" ל-07–15. משמרת "יום" במיון (07–16) חופפת לחלון.
    const r = await assign(itay, { locationId: erId, shiftTypeId: erDayId }, 'itay-1');
    const body = await r.json();
    const warning = availabilityWarning(body);
    expect(warning).toBeDefined();
    expect(JSON.stringify(warning)).toContain('לא יכול');
  });
});
