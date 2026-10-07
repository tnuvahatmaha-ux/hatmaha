import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';
import { weekStartOf, addDays, today } from '../src/lib/time.js';

const DB = 'hatmaha_roster';
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

describeDb('סידור עבודה — שיבוץ, בדיקה ופרסום', () => {
  let base, server, manager, noa, itay, siteId, locationId, erId;
  let morningId, eveningId, nightId, erDayId;
  let weekStart, draftId;

  beforeAll(async () => {
    resetSchema({ db: DB });
    const { withTransaction } = await import('../src/lib/db.js');

    weekStart = addDays(weekStartOf(today()), 14); // שבוע עתידי, מחוץ לחלון ההודעה המוקדמת

    await withTransaction({}, async (tx) => {
      manager = await createUser(tx, { email: 'm@t.local', fullName: 'דנה כהן', role: 'manager' });
      noa = await createUser(tx, { email: 'n@t.local', fullName: 'נועה פרץ' });
      itay = await createUser(tx, { email: 'i@t.local', fullName: 'איתי מזרחי' });

      const [site] = await tx.query(
        `insert into sites (name, status_id, open_time, close_time)
         select 'מרכז רפואי צפון', id, '00:00', '23:59' from site_statuses where code='golive'
         returning id`,
      );
      siteId = site.id;

      const [loc] = await tx.query(
        `insert into locations (site_id, name) values ($1, 'מחלקה פנימית') returning id`,
        [siteId],
      );
      locationId = loc.id;

      const [er] = await tx.query(
        `insert into locations (site_id, name) values ($1, 'חדר מיון') returning id`,
        [siteId],
      );
      erId = er.id;

      // site_id אינו נשלח: הטריגר גוזר אותו מהמיקום
      const shifts = await tx.query(
        `insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, display_order)
         values ($1,'בוקר','06:00','14:00', true, 1, 10),
                ($1,'ערב','14:00','22:00', true, 1, 20),
                ($1,'לילה','22:00','06:00', false, 1, 30),
                ($2,'יום','07:00','19:00', false, 1, 10)
         returning id, name, site_id`,
        [locationId, erId],
      );
      expect(shifts.every((s) => s.site_id === siteId)).toBe(true);
      morningId = shifts.find((s) => s.name === 'בוקר').id;
      eveningId = shifts.find((s) => s.name === 'ערב').id;
      nightId = shifts.find((s) => s.name === 'לילה').id;
      erDayId = shifts.find((s) => s.name === 'יום').id;

      await tx.query(
        `insert into site_assignments (site_id, user_id) values ($1,$2), ($1,$3)`,
        [siteId, noa.id, itay.id],
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

  const assign = (payload, key) =>
    call(`/api/roster/versions/${draftId}/assignments`, {
      as: manager.id, method: 'POST', body: payload, key,
    });

  it('טיוטה נוצרת עצלנית לשבוע המבוקש', async () => {
    const res = await call(`/api/roster/draft?siteId=${siteId}&weekStart=${weekStart}`, { as: manager.id });
    expect(res.status).toBe(200);
    const { version } = await res.json();
    expect(version.status).toBe('draft');
    expect(version.version_number).toBe(1);
    draftId = version.id;
  });

  it('רק טיוטה אחת לכל אתר ושבוע, גם בקריאות מקבילות', async () => {
    const [a, b] = await Promise.all([
      call(`/api/roster/draft?siteId=${siteId}&weekStart=${weekStart}`, { as: manager.id }),
      call(`/api/roster/draft?siteId=${siteId}&weekStart=${weekStart}`, { as: manager.id }),
    ]);
    const ids = [(await a.json()).version.id, (await b.json()).version.id];
    expect(new Set(ids).size).toBe(1);
  });

  it('שיבוץ תקין נשמר', async () => {
    const res = await assign(
      { userId: noa.id, date: weekStart, locationId, shiftTypeId: morningId },
      'a1',
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    // 'warning' ולא 'ok': החוק "שיבוץ רק בזמינות שהוצהרה" נדלק, כי נועה
    // עדיין לא הגישה זמינות. אזהרה נשמרת ומוצגת, ואינה מונעת שיבוץ.
    expect(body.status).toBe('warning');
    expect(body.warnings.map((w) => w.name)).toContain('שיבוץ רק בזמינות שהוצהרה');
    expect(body.data.user_id).toBe(noa.id);
  });

  it('הלוח אינו נשמר במטמון — שיבוץ חדש מופיע מיד', async () => {
    // ה-ETag של הלוח הוא row_version של הגרסה, שאינו משתנה כשמוסיפים שיבוץ.
    // בלי no-store הדפדפן היה מאמת מול המטמון, מקבל 304, ומציג לוח ישן.
    const res = await call(`/api/roster/versions/${draftId}/board`, { as: manager.id });
    expect(res.headers.get('cache-control')).toBe('no-store');
    const board = await res.json();
    expect(board.assignments.some((a) => a.user_id === noa.id)).toBe(true);

    // גם דפדפן ששמר תשובה ישנה ושולח If-None-Match מקבל את הלוח המלא
    const conditional = await fetch(`${base}/api/roster/versions/${draftId}/board`, {
      headers: { 'x-test-user': manager.id, 'if-none-match': res.headers.get('etag') },
    });
    expect(conditional.status).toBe(200);
  });

  it('משמרת של מיקום אחר נדחית', async () => {
    const res = await assign(
      { userId: noa.id, date: addDays(weekStart, 3), locationId, shiftTypeId: erDayId },
      'a-wrong-location',
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toContain('אינה שייכת למיקום');
  });

  it('⭐ חפיפה נחסמת — משמרת לילה נמשכת אל תוך היום שאחריה', async () => {
    // לילה 22:00–06:00 ביום הראשון: מסתיים ב-06:00 של היום שאחריו
    const night = await assign(
      { userId: itay.id, date: weekStart, locationId, shiftTypeId: nightId },
      'a2',
    );
    expect(night.status).toBe(201);

    // 05:00–13:00 למחרת חופף לשעה האחרונה של הלילה.
    // בפרוטוטייפ ההשוואה הייתה על דקות מחצות, 1320 < 360 היה false,
    // וכל החפיפה הזו התפספסה.
    const clash = await assign(
      { userId: itay.id, date: addDays(weekStart, 1), locationId, startTime: '05:00', endTime: '13:00' },
      'a3',
    );
    expect(clash.status).toBe(422);
    const { error } = await clash.json();
    expect(error.code).toBe('E_RULE_BLOCKED');
    expect(error.message).toContain('חפיפה');

    // 06:00–14:00 למחרת צמוד ללילה ואינו חופף — טווח חצי פתוח
    const adjacent = await assign(
      { userId: itay.id, date: addDays(weekStart, 1), locationId, shiftTypeId: morningId },
      'a4',
    );
    // מותר מבחינת חפיפה, אך 6 שעות לילה + 8 בוקר באותו יום מקומי
    // חורגות מ-10 שעות ליום, ולכן נדרש אישור — וזו בדיוק ההתנהגות הרצויה
    expect(adjacent.status).toBe(202);
    const body = await adjacent.json();
    expect(body.status).toBe('approval_required');
    expect(body.exceptions[0].ruleName).toBe('מקסימום 10 שעות ביום');
  });

  it('חריגה פתוחה חוסמת פרסום עד שמכריעים בה', async () => {
    const check = await (await call(`/api/roster/versions/${draftId}/validate`, {
      as: manager.id, method: 'POST',
    })).json();
    expect(check.openExceptions.length).toBeGreaterThan(0);
    expect(check.canPublish).toBe(false);

    const res = await call(`/api/roster/versions/${draftId}/publish`, {
      as: manager.id, method: 'POST', key: 'pub-blocked',
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('E_PENDING_APPROVAL');
  });

  it('דחיית החריגה משחררת את הפרסום — והפעולה שחנתה לא בוצעה', async () => {
    const queue = await (await call('/api/exceptions?status=pending', { as: manager.id })).json();
    for (const ex of queue.exceptions) {
      const res = await call(`/api/exceptions/${ex.id}/decision`, {
        as: manager.id, method: 'POST',
        body: { decision: 'reject', comment: 'עומס יתר — לא מאשרת משמרת כפולה' },
      });
      expect(res.status).toBe(200);
    }

    // השיבוץ שדרש אישור מעולם לא נוצר
    const board = await (await call(`/api/roster/versions/${draftId}/board`, { as: manager.id })).json();
    const doubleShift = board.assignments.filter(
      (a) => a.user_id === itay.id && a.assignment_date === addDays(weekStart, 1),
    );
    expect(doubleShift).toHaveLength(0);
  });

  it('בדיקת תקינות מדווחת על חוסר כיסוי משמרות', async () => {
    const res = await call(`/api/roster/versions/${draftId}/validate`, { as: manager.id, method: 'POST' });
    expect(res.status).toBe(200);
    const body = await res.json();
    const coverage = body.issues.find((i) => i.ruleName === 'כיסוי משמרות מלא');
    expect(coverage).toBeDefined();
    expect(coverage.severity).toBe('warning'); // אזהרה, ולכן אינה מונעת פרסום
    expect(body.canPublish).toBe(true);
  });

  it('AC-12: פרסום יוצר גרסה חדשה ושומר היסטוריה', async () => {
    const res = await call(`/api/roster/versions/${draftId}/publish`, {
      as: manager.id, method: 'POST', key: 'pub-1', body: { note: 'גרסה ראשונה' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.versionNumber).toBe(1);
    expect(body.nextDraftId).toBeTruthy();
    expect(body.notified).toBeGreaterThan(0);

    const versions = await (await call(`/api/roster/versions?siteId=${siteId}`, { as: manager.id })).json();
    expect(versions.versions.find((v) => v.id === draftId).status).toBe('published');
    expect(versions.versions.find((v) => v.id === body.nextDraftId).status).toBe('draft');
  });

  it('פרסום חוזר עם אותו מפתח אינו יוצר גרסה נוספת', async () => {
    const before = (await (await call(`/api/roster/versions?siteId=${siteId}`, { as: manager.id })).json()).versions.length;
    const res = await call(`/api/roster/versions/${draftId}/publish`, {
      as: manager.id, method: 'POST', key: 'pub-1', body: { note: 'גרסה ראשונה' },
    });
    expect(res.status).toBe(200);
    const after = (await (await call(`/api/roster/versions?siteId=${siteId}`, { as: manager.id })).json()).versions.length;
    expect(after).toBe(before);
  });

  it('גרסה שפורסמה אינה ניתנת לשינוי — נאכף במסד, לא בראוטר', async () => {
    const { query } = await import('../src/lib/db.js');
    const [row] = await query(
      `select id from roster_assignments where version_id = $1 limit 1`,
      [draftId],
    );

    const res = await call(`/api/roster/assignments/${row.id}`, { as: manager.id, method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('E_READ_ONLY');

    // גם ניסיון ישיר במסד, בעקיפת השרת, נחסם
    // הטריגר ב-DB זורק, וה-mapping הופך אותו להודעה בעברית
    await expect(
      query(`delete from roster_assignments where id = $1`, [row.id]),
    ).rejects.toThrow(/אינה ניתנת לשינוי/);
  });

  it('הסידור שלי מציג רק גרסאות שפורסמו', async () => {
    const res = await call(`/api/roster/my?from=${weekStart}&to=${addDays(weekStart, 6)}`, { as: noa.id });
    expect(res.status).toBe(200);
    const { assignments } = await res.json();
    expect(assignments.length).toBeGreaterThan(0);
    expect(assignments.every((a) => a.version_number === 1)).toBe(true);
  });

  it('שכפול שבוע עם רוטציה מעביר כל שיבוץ למשמרת הבאה', async () => {
    const versions = await (await call(`/api/roster/versions?siteId=${siteId}`, { as: manager.id })).json();
    const nextDraft = versions.versions.find((v) => v.status === 'draft');

    const res = await call(`/api/roster/versions/${nextDraft.id}/duplicate-week`, {
      as: manager.id, method: 'POST', key: 'dup-1',
      body: { targetWeekStart: addDays(weekStart, 7), mode: 'rotate' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.mode).toBe('rotate');
    expect(body.created).toBeGreaterThan(0);

    const board = await (await call(`/api/roster/versions/${body.targetVersionId}/board`, { as: manager.id })).json();
    // נועה הייתה בבוקר; אחרי רוטציה היא בערב — של אותו מיקום
    const noaShift = board.assignments.find((a) => a.user_id === noa.id);
    expect(noaShift.shift_type_id).toBe(eveningId);
    expect(noaShift.location_id).toBe(locationId);
    // הלוח מחזיר לכל משמרת את המיקום שלה
    expect(board.shiftTypes.find((s) => s.id === erDayId).location_id).toBe(erId);
  });

  it('ייצוא CSV מכיל BOM כדי ש-Excel בעברית יפתח נכון', async () => {
    const res = await call(`/api/roster/versions/${draftId}/export.csv`, { as: manager.id });
    expect(res.status).toBe(200);
    // fetch().text() מסיר BOM לפי התקן, ולכן בודקים את הבתים עצמם
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await res.text();
    expect(text).toContain('מטמיע');
    expect(text).toContain('נועה פרץ');
  });

  it('AC-13: מטמיע אינו רשאי לשבץ', async () => {
    const res = await call(`/api/roster/versions/${draftId}/assignments`, {
      as: noa.id, method: 'POST',
      body: { userId: noa.id, date: weekStart, locationId, shiftTypeId: morningId },
    });
    expect(res.status).toBe(403);
  });
});
