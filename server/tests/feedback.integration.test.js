import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';
import { addDays, today, weekStartOf, nextWeekStart } from '../src/lib/time.js';

/**
 * משוב המשתמשים (אוקטובר 2026): הגדרת מדריך, הודעות לצוות, מנהל בלי זמינות,
 * מינימום משמרות לפי סוג, העתקת שעות בין תחומים, ומיקומים לפי שלב האתר.
 */

const DB = 'hatmaha_feedback';
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

describeDb('משוב משתמשים — מקצה לקצה', () => {
  let base, server, manager, dana, noa, avi, outsider, siteId, nursingId, medicineId, wardId, vacationId;

  beforeAll(async () => {
    resetSchema({ db: DB });
    const { withTransaction } = await import('../src/lib/db.js');

    await withTransaction({}, async (tx) => {
      manager = await createUser(tx, { email: 'm@t.local', fullName: 'מנהלת', role: 'manager' });
      dana = await createUser(tx, { email: 'd@t.local', fullName: 'דנה מדריכה' }); // תהפוך למדריכה
      noa = await createUser(tx, { email: 'n@t.local', fullName: 'נועה' });
      avi = await createUser(tx, { email: 'a@t.local', fullName: 'אבי' });
      outsider = await createUser(tx, { email: 'o@t.local', fullName: 'זר' });

      const [site] = await tx.query(
        `insert into sites (name, status_id, open_time, close_time, go_live_date)
         select 'מרכז', id, '00:00', '23:59', $1::date from site_statuses where code='training'
         returning id`,
        [addDays(nextWeekStart(), 3)], // העלייה לאוויר באמצע השבוע הבא
      );
      siteId = site.id;

      const [d1] = await tx.query(`insert into domains (name) values ('סיעוד') returning id`);
      const [d2] = await tx.query(`insert into domains (name) values ('רפואה') returning id`);
      nursingId = d1.id;
      medicineId = d2.id;

      for (const u of [noa, avi, outsider]) {
        await tx.query('insert into site_assignments (site_id, user_id) values ($1, $2)', [siteId, u.id]);
        await tx.query('insert into user_domains (user_id, domain_id, is_primary) values ($1, $2, true)', [u.id, nursingId]);
      }

      const [ward] = await tx.query(
        `insert into locations (site_id, name) values ($1, 'מחלקה') returning id`, [siteId],
      );
      wardId = ward.id;
      // כיתה שקיימת רק בתקופת ההכשרה
      const [cls] = await tx.query(
        `insert into locations (site_id, name, periods) values ($1, 'כיתה', '{training}') returning id`, [siteId],
      );
      await tx.query(
        `insert into shift_types (location_id, name, start_time, end_time, domain_id) values
           ($1, 'בוקר', '07:00', '15:00', $3),
           ($1, 'ערב', '15:00', '23:00', $3),
           ($2, 'הדרכה', '09:00', '13:00', null)`,
        [wardId, cls.id, nursingId],
      );

      vacationId = (await tx.query(`select id from constraint_types where code = 'vacation'`))[0].id;
    });

    server = (await import('../src/app.js')).createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  const call = async (path, { as, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-test-user': as, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ── 1. הגדרת מדריך ── */

  it('מנהל הופך משתמש קיים למדריך, ואז אפשר לשייך אותו כמדריך ראשי', async () => {
    const patch = await call(`/api/users/${dana.id}`, { as: manager.id, method: 'PATCH', body: { baseRole: 'mentor' } });
    expect(patch.status).toBe(200);
    expect(patch.body.user.base_role).toBe('mentor');

    const mentors = await call('/api/settings/mentors?status=active', { as: manager.id });
    expect(mentors.body.mentors.map((m) => m.id)).toContain(dana.id);

    const resp = await call(`/api/settings/mentors/${dana.id}/responsibilities`, {
      as: manager.id, method: 'POST', body: { siteId, domainId: nursingId },
    });
    expect(resp.status).toBe(201);

    for (const u of [noa, avi]) {
      const assign = await call('/api/settings/mentors/assignments', {
        as: manager.id, method: 'POST', body: { mentorUserId: dana.id, implementerUserId: u.id, isPrimary: true },
      });
      expect([200, 201]).toContain(assign.status);
    }
  });

  it('משתמש שאינו מנהל אינו יכול לשנות תפקיד', async () => {
    const res = await call(`/api/users/${noa.id}`, { as: dana.id, method: 'PATCH', body: { baseRole: 'manager' } });
    expect(res.status).toBe(403);
  });

  it('אי אפשר להוריד את מנהל ההטמעה האחרון', async () => {
    const res = await call(`/api/users/${manager.id}`, { as: manager.id, method: 'PATCH', body: { baseRole: 'mentor' } });
    expect(res.status).toBe(400);
  });

  /* ── שגיאת ההרשאה בטופס האילוץ ── */

  it('מטמיע קורא את קטלוג סוגי האילוץ (הטופס נטען)', async () => {
    const res = await call('/api/settings/lookups/constraintTypes', { as: noa.id });
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
  });

  it('מדריך מגיש בקשת אילוץ לעצמו בלי "אין לך הרשאה"', async () => {
    const res = await call('/api/requests/preview', {
      as: dana.id, method: 'POST',
      body: { constraintTypeId: vacationId, constraintDate: addDays(today(), 30), startTime: '09:00', endTime: '17:00' },
    });
    expect(res.status).toBe(200);
  });

  /* ── 4. מנהל בלי זמינות ── */

  it('מנהל אינו מגיש זמינות או אילוצים לעצמו', async () => {
    const me = await call('/api/auth/me', { as: manager.id });
    expect(me.body.submitsAvailability).toBe(false);

    const res = await call('/api/requests/preview', {
      as: manager.id, method: 'POST',
      body: { constraintTypeId: vacationId, constraintDate: addDays(today(), 30), startTime: '09:00', endTime: '17:00' },
    });
    expect(res.status).toBe(400);
  });

  /* ── 2. הודעות לצוות ── */

  let updateId;
  it('מדריך שולח הודעה לצוות שלו עם בקשת אישור קריאה', async () => {
    const created = await call('/api/updates', {
      as: dana.id, method: 'POST',
      body: { title: 'נוהל חדש', body: 'נא לקרוא', toWholeTeam: true, requiresAck: true },
    });
    expect(created.status).toBe(201);
    expect(created.body.recipients).toBe(2);
    updateId = created.body.id;

    // טיוטה אינה מופיעה אצל הנמען
    expect((await call('/api/updates/inbox', { as: noa.id })).body.updates).toHaveLength(0);

    const pub = await call(`/api/updates/${updateId}/publish`, { as: dana.id, method: 'POST' });
    expect(pub.status).toBe(200);

    const inbox = await call('/api/updates/inbox', { as: noa.id });
    expect(inbox.body.updates[0].title).toBe('נוהל חדש');
    expect(inbox.body.updates[0].acknowledged_at).toBeNull();
  });

  it('נמען מאשר קריאה, והשולח רואה את ההתקדמות ושולח תזכורת', async () => {
    expect((await call(`/api/updates/${updateId}/ack`, { as: noa.id, method: 'POST' })).status).toBe(200);

    const detail = await call(`/api/updates/${updateId}`, { as: dana.id });
    const byId = Object.fromEntries(detail.body.update.recipients.map((r) => [r.id, r]));
    expect(byId[noa.id].acknowledged_at).not.toBeNull();
    expect(byId[avi.id].acknowledged_at).toBeNull();

    const remind = await call(`/api/updates/${updateId}/remind`, { as: dana.id, method: 'POST' });
    expect(remind.body.reminded).toBe(1);
  });

  it('מי שאינו נמען אינו רואה את ההודעה', async () => {
    expect((await call(`/api/updates/${updateId}`, { as: outsider.id })).status).toBe(404);
  });

  it('מדריך אינו שולח למי שאינו משויך אליו', async () => {
    const res = await call('/api/updates', {
      as: dana.id, method: 'POST',
      body: { title: 'x', body: 'y', recipientIds: [outsider.id] },
    });
    expect(res.status).toBe(403);
  });

  it('מטמיע אינו שולח הודעות', async () => {
    const res = await call('/api/updates', {
      as: noa.id, method: 'POST', body: { title: 'x', body: 'y', recipientIds: [avi.id] },
    });
    expect(res.status).toBe(403);
  });

  /* ── 3. לו״ז צוות: המטמיעים שלי ── */

  it('לו״ז צוות מקבל טווח ומסנן למטמיעים של המדריך', async () => {
    const res = await call(
      `/api/schedule/team?siteId=${siteId}&from=${today()}&to=${addDays(today(), 6)}&mine=1`,
      { as: dana.id },
    );
    expect(res.status).toBe(200);
    expect(res.body.entries).toEqual([]);
  });

  /* ── שלבים: הכשרה ← עלייה לאוויר באמצע השבוע ── */

  it('חלונות הזמינות מתחלפים בתאריך העלייה לאוויר', async () => {
    const res = await call(`/api/availability/window?siteId=${siteId}`, { as: noa.id });
    expect(res.status).toBe(200);
    const week = res.body.weekStart;
    const golive = addDays(week, 3);
    expect(res.body.phases[week]).toBe('training');
    expect(res.body.phases[golive]).toBe('golive');

    const training = res.body.windows.find((w) => w.startTime === '09:00');
    expect(training.days).toEqual([week, addDays(week, 1), addDays(week, 2)]);
    const morning = res.body.windows.find((w) => w.startTime === '07:00');
    expect(morning.days).toHaveLength(7);
    expect(morning.category).toBe('morning');
  });

  /* ── 5. מינימום משמרות לפי סוג ── */

  it('הגשה מתחת למינימום משמרות בוקר נחסמת, ובמינימום עוברת', async () => {
    const { withTransaction } = await import('../src/lib/db.js');
    await withTransaction({}, (tx) =>
      tx.query(
        `insert into rules (name, trigger, applies_to, condition_type_code, condition_params,
                            severity, priority, message_he, scope_type)
         values ('מינימום משמרות', 'submit', 'availability', 'minShiftsPerCategory',
                 '{"morning": 9, "weekend": 2}', 'blocking', 5, 'לא הוגש מספיק', 'global')`,
      ),
    );

    const window = (await call(`/api/availability/window?siteId=${siteId}`, { as: noa.id })).body;
    expect(window.minimums).toMatchObject({ morning: 9, weekend: 2 });
    const week = window.weekStart;

    // בוקר: 07:00 בכל 7 הימים + הדרכה 09:00 בשלושת ימי ההכשרה = 10.
    // שתי משמרות "לא יכול" — נשארות 8, מתחת למינימום 9
    const draft = await call('/api/availability/declarations', {
      as: noa.id, method: 'PUT',
      body: {
        siteId, weekStart: week,
        cells: [0, 1].map((i) => ({ date: addDays(week, i), startTime: '07:00', endTime: '15:00', value: 'cannot' })),
      },
    });
    expect(draft.status).toBe(200);
    const id = draft.body.declarationId;

    const preview = await call(`/api/availability/declarations/${id}/preview`, { as: noa.id, method: 'POST' });
    expect(preview.body.available.morning).toBe(8);
    expect(preview.body.willBe).toBe('blocked');

    // רק אחת "לא יכול" — 9 בוקר, ובסוף השבוע 2 בוקר + 2 ערב
    await call('/api/availability/declarations', {
      as: noa.id, method: 'PUT',
      body: { siteId, weekStart: week, cells: [{ date: week, startTime: '07:00', endTime: '15:00', value: 'cannot' }] },
    });
    const ok = await call(`/api/availability/declarations/${id}/preview`, { as: noa.id, method: 'POST' });
    expect(ok.body.available).toMatchObject({ morning: 9, weekend: 4 });
    expect(ok.body.willBe).not.toBe('blocked');
  });

  /* ── 6. העתקת שעות מתחום לתחום ── */

  it('מעתיק משמרות מתחום לתחום, ובהרצה חוזרת אינו משכפל', async () => {
    const url = `/api/sites/${siteId}/shift-types/copy-domain`;
    const body = { fromDomainId: nursingId, toDomainId: medicineId };
    const first = await call(url, { as: manager.id, method: 'POST', body });
    expect(first.body).toMatchObject({ created: 2, skipped: 0 });

    const again = await call(url, { as: manager.id, method: 'POST', body });
    expect(again.body).toMatchObject({ created: 0, skipped: 2 });

    const replace = await call(url, { as: manager.id, method: 'POST', body: { ...body, mode: 'replace' } });
    expect(replace.body).toMatchObject({ created: 2, replaced: 2 });

    const site = await call(`/api/sites/${siteId}`, { as: manager.id });
    const ward = site.body.locations.find((l) => l.id === wardId);
    expect(ward.shiftTypes.filter((s) => s.domain_id === medicineId)).toHaveLength(2);
  });

  /* ── מאגר המיקומים ── */

  it('מיקום חדש נשמר במאגר, ובאתר הבא נולד עם המשמרות שהוגדרו לו', async () => {
    const res = await call(`/api/sites/${siteId}/locations`, {
      as: manager.id, method: 'POST', body: { name: 'מיון', periods: ['golive'] },
    });
    expect(res.status).toBe(201);
    const shift = await call(`/api/sites/${siteId}/locations/${res.body.location.id}/shift-types`, {
      as: manager.id, method: 'POST', body: { name: 'לילה', startTime: '23:00', endTime: '07:00', period: 'golive' },
    });
    expect(shift.status).toBe(201);
    expect(shift.body.shiftType.category).toBe('night');

    const types = await call('/api/settings/location-types', { as: noa.id });
    const er = types.body.locationTypes.find((t) => t.name === 'מיון');
    expect(er).toBeTruthy();

    const { withTransaction } = await import('../src/lib/db.js');
    const [site2] = await withTransaction({}, (tx) => tx.query(
      `insert into sites (name, status_id) select 'אתר ב', id from site_statuses where code='training' returning id`,
    ));
    const copy = await call(`/api/sites/${site2.id}/locations`, {
      as: manager.id, method: 'POST', body: { name: 'מיון', locationTypeId: er.id },
    });
    expect(copy.status).toBe(201);
    expect(copy.body.location.copiedShifts).toBe(1);
  });
});
