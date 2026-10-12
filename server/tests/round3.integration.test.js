import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';
import { weekStartOf, today, addDays, nextWeekStart } from '../src/lib/time.js';

/**
 * משוב סבב 3: עריכה ושכפול בסקילומטר ודוח התקדמות, שעות משמרת נקודתיות,
 * סבב שבועי, ושיוך שמי של מטמיעים ומדריך לפעילויות.
 */

const DB = 'hatmaha_round3';
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

describeDb('משוב סבב 3 — מקצה לקצה', () => {
  let base, server, manager, mentor, noa, avi, siteId, domainId, locId, morningId, eveningId, nightId;
  const nextWeek = nextWeekStart();
  const thisWeek = weekStartOf(today());

  beforeAll(async () => {
    resetSchema({ db: DB });
    const { withTransaction } = await import('../src/lib/db.js');

    await withTransaction({}, async (tx) => {
      manager = await createUser(tx, { email: 'm@t.local', fullName: 'מנהלת', role: 'manager' });
      mentor = await createUser(tx, { email: 'y@t.local', fullName: 'יוסי מדריך', role: 'mentor' });
      noa = await createUser(tx, { email: 'n@t.local', fullName: 'נועה' });
      avi = await createUser(tx, { email: 'a@t.local', fullName: 'אבי' });

      const [site] = await tx.query(
        `insert into sites (name, status_id, open_time, close_time)
         select 'מרכז', id, '00:00', '23:59' from site_statuses where code='golive' returning id`,
      );
      siteId = site.id;
      domainId = (await tx.query(`insert into domains (name) values ('סיעוד') returning id`))[0].id;
      await tx.query('insert into site_assignments (site_id, user_id) values ($1, $2), ($1, $3)', [siteId, noa.id, avi.id]);

      const [loc] = await tx.query(`insert into locations (site_id, name) values ($1, 'מיון') returning id`, [siteId]);
      locId = loc.id;
      const shift = async (name, from, to) =>
        (await tx.query(
          `insert into shift_types (location_id, name, start_time, end_time) values ($1, $2, $3, $4) returning id`,
          [locId, name, from, to],
        ))[0].id;
      morningId = await shift('בוקר', '07:00', '15:00');
      eveningId = await shift('ערב', '15:00', '23:00');
      nightId = await shift('לילה', '23:00', '07:00');
    });

    server = (await import('../src/app.js')).createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  const call = async (path, { as, method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        'x-test-user': as,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...(method === 'POST' ? { 'idempotency-key': crypto.randomUUID() } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ── סקילומטר ── */

  describe('סקילומטר', () => {
    let endUserId, topicId, roundId;

    beforeAll(async () => {
      const topic = await call('/api/skills/topics', { as: manager.id, method: 'POST', body: { domainId, name: 'קבלת מטופל' } });
      topicId = topic.body.topic.id;
      const eu = await call('/api/skills/end-users', {
        as: manager.id, method: 'POST', body: { siteId, fullName: 'רונית', domainId },
      });
      endUserId = eu.body.endUser.id;
      const round = await call('/api/skills/rounds', {
        as: manager.id, method: 'POST', body: { siteId, name: 'סבב 1', status: 'open', topicIds: [topicId] },
      });
      roundId = round.body.round.id;
      await call(`/api/skills/rounds/${roundId}/scores`, {
        as: manager.id, method: 'PUT', body: { scores: [{ endUserId, topicId, score: 2 }] },
      });
      await call('/api/skills/rounds', { as: manager.id, method: 'POST', body: { id: roundId, siteId, name: 'סבב 1', status: 'closed' } });
    });

    it('משתמש קצה ונושא ניתנים לעריכה אחרי שהועלו', async () => {
      const eu = await call('/api/skills/end-users', {
        as: manager.id, method: 'POST', body: { siteId, id: endUserId, fullName: 'רונית כהן', department: 'מיון', domainId },
      });
      expect(eu.status).toBe(200);
      expect(eu.body.endUser.full_name).toBe('רונית כהן');

      const topic = await call('/api/skills/topics', {
        as: manager.id, method: 'POST', body: { id: topicId, domainId, name: 'קבלת מטופל במיון' },
      });
      expect(topic.body.topic.name).toBe('קבלת מטופל במיון');
    });

    it('שכפול סבב מעתיק את הנושאים בלי הציונים', async () => {
      const copy = await call(`/api/skills/rounds/${roundId}/duplicate`, { as: manager.id, method: 'POST', body: {} });
      expect(copy.status).toBe(201);
      expect(copy.body.round.status).toBe('draft');
      expect(copy.body.round.round_no).toBe(2);

      const rounds = await call(`/api/skills/rounds?siteId=${siteId}`, { as: manager.id });
      const dup = rounds.body.rounds.find((r) => r.id === copy.body.round.id);
      expect(dup.topic_ids).toEqual([topicId]);
      expect(dup.score_count).toBe(0);
    });

    it('דוח ההתקדמות כולל סבבים שנסגרו', async () => {
      const r2 = await call('/api/skills/rounds', {
        as: manager.id, method: 'POST', body: { siteId, name: 'סבב 3', status: 'open', topicIds: [topicId] },
      });
      await call(`/api/skills/rounds/${r2.body.round.id}/scores`, {
        as: manager.id, method: 'PUT', body: { scores: [{ endUserId, topicId, score: 4 }] },
      });

      const res = await call(`/api/skills/progress?siteId=${siteId}`, { as: manager.id });
      expect(res.status).toBe(200);
      // טיוטה (העותק) אינה בדוח; הסגור והפתוח כן
      expect(res.body.rounds.map((r) => r.status)).toEqual(['closed', 'open']);
      const user = res.body.users.find((u) => u.id === endUserId);
      expect(user.rounds.map((r) => r?.avg)).toEqual([2, 4]);
      expect(user.delta).toBe(2);
      expect(user.topics[0].scores[roundId]).toBe(2);
    });

    it('הסרת משתמש קצה מוציאה אותו מהדוח', async () => {
      const res = await call(`/api/skills/end-users/${endUserId}`, { as: manager.id, method: 'DELETE' });
      expect(res.status).toBe(200);
      const progress = await call(`/api/skills/progress?siteId=${siteId}`, { as: manager.id });
      expect(progress.body.users.find((u) => u.id === endUserId)).toBeUndefined();
    });
  });

  /* ── שעות משמרת נקודתיות ── */

  describe('שעות משמרת נקודתיות', () => {
    let versionId, assignmentId;
    const day = addDays(nextWeek, 1);

    beforeAll(async () => {
      const draft = await call(`/api/roster/draft?siteId=${siteId}&weekStart=${nextWeek}`, { as: manager.id });
      versionId = draft.body.version.id;
      const a = await call(`/api/roster/versions/${versionId}/assignments`, {
        as: manager.id, method: 'POST', body: { userId: avi.id, date: day, locationId: locId, shiftTypeId: morningId },
      });
      assignmentId = a.body.data.id;
    });

    const hoursOf = async (userId) => {
      const board = await call(`/api/roster/versions/${versionId}/board`, { as: manager.id });
      const a = board.body.assignments.find((x) => x.user_id === userId && x.assignment_date === day);
      return a && `${a.start_time.slice(0, 5)}-${a.end_time.slice(0, 5)}`;
    };

    it('שינוי שעות למשמרת ביום מעביר את המשובצים לשעות החדשות', async () => {
      const res = await call(`/api/roster/versions/${versionId}/shift-overrides`, {
        as: manager.id, method: 'PUT', body: { shiftTypeId: morningId, date: day, startTime: '06:30', endTime: '15:00' },
      });
      expect(res.status).toBe(200);
      expect(res.body.updated).toBe(1);
      expect(await hoursOf(avi.id)).toBe('06:30-15:00');
    });

    it('שיבוץ חדש לאותו תא מקבל את השעות של אותו יום', async () => {
      await call(`/api/roster/versions/${versionId}/assignments`, {
        as: manager.id, method: 'POST', body: { userId: noa.id, date: day, locationId: locId, shiftTypeId: morningId },
      });
      expect(await hoursOf(noa.id)).toBe('06:30-15:00');
    });

    it('שעות אישיות למטמיע אחד, וחזרה לשעות התא', async () => {
      const res = await call(`/api/roster/assignments/${assignmentId}/hours`, {
        as: manager.id, method: 'PATCH', body: { startTime: '06:00', endTime: '17:00' },
      });
      expect(res.status).toBe(200);
      expect(await hoursOf(avi.id)).toBe('06:00-17:00');

      await call(`/api/roster/assignments/${assignmentId}/hours`, {
        as: manager.id, method: 'PATCH', body: { startTime: null, endTime: null },
      });
      expect(await hoursOf(avi.id)).toBe('06:30-15:00');
    });

    it('ביטול השינוי מחזיר את השעות הרגילות', async () => {
      const board = await call(`/api/roster/versions/${versionId}/board`, { as: manager.id });
      const [override] = board.body.overrides;
      const res = await call(`/api/roster/versions/${versionId}/shift-overrides/${override.id}`, { as: manager.id, method: 'DELETE' });
      expect(res.body.updated).toBe(2);
      expect(await hoursOf(avi.id)).toBe('07:00-15:00');
    });
  });

  /* ── סבב שבועי ── */

  describe('סבב שבועי', () => {
    beforeAll(async () => {
      await call(`/api/sites/${siteId}/locations`, {
        as: manager.id, method: 'POST', body: { id: locId, name: 'מיון', rotationCycle: ['morning', 'afternoon', 'night'] },
      });
      // השבוע נועה בבוקר — ולכן בשבוע הבא בצהריים
      await call(`/api/sites/${siteId}/rotations`, {
        as: manager.id, method: 'PUT',
        body: { rotations: [{ userId: noa.id, locationId: locId, anchorWeek: thisWeek, anchorCategory: 'morning' }] },
      });
    });

    it('הסוג של כל שבוע נגזר מהעוגן', async () => {
      const res = await call(`/api/sites/${siteId}/rotations`, { as: manager.id });
      expect(res.body.rotations[0].thisWeek.category).toBe('morning');
      expect(res.body.rotations[0].nextWeek.category).toBe('afternoon');
    });

    it('בהגשת זמינות: הצהריים חובה, הבוקר והלילה לא נדרשים', async () => {
      const win = await call(`/api/availability/window?siteId=${siteId}`, { as: noa.id });
      expect(win.body.rotation.categories).toEqual(['afternoon']);
      expect(win.body.rotation.exempt.sort()).toEqual(['morning', 'night']);

      const blocked = await call('/api/availability/declarations', {
        as: noa.id, method: 'PUT',
        body: { siteId, weekStart: nextWeek, cells: [{ date: nextWeek, startTime: '15:00', endTime: '23:00', value: 'cannot' }] },
      });
      expect(blocked.status).toBe(400);

      const ok = await call('/api/availability/declarations', {
        as: noa.id, method: 'PUT',
        body: { siteId, weekStart: nextWeek, cells: [{ date: nextWeek, startTime: '07:00', endTime: '15:00', value: 'cannot' }] },
      });
      expect(ok.status).toBe(200);
      const { query } = await import('../src/lib/db.js');
      const cells = await query('select * from availability_cells where declaration_id = $1', [ok.body.declarationId]);
      expect(cells).toHaveLength(0); // תא בסוג שאינו נדרש אינו נשמר
    });

    it('מה שעבדה בפועל בסידור שפורסם גובר על העוגן', async () => {
      // בשבוע הנוכחי נועה עבדה בלילה, ולכן בשבוע הבא — בוקר
      const { withTransaction } = await import('../src/lib/db.js');
      await withTransaction({}, async (tx) => {
        const [v] = await tx.query(
          `insert into roster_versions (site_id, week_start, status, version_number) values ($1, $2, 'draft', 1) returning id`,
          [siteId, thisWeek],
        );
        await tx.query(
          `insert into roster_assignments (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
                                           start_time, end_time, starts_at, ends_at)
           values ($1, $2, $3, $4, $5, $6, '23:00', '07:00', ($3::date + time '23:00') at time zone 'Asia/Jerusalem',
                   ($3::date + 1 + time '07:00') at time zone 'Asia/Jerusalem')`,
          [v.id, siteId, thisWeek, locId, noa.id, nightId],
        );
        await tx.query(`update roster_versions set status = 'published', published_at = now(), published_by = $2 where id = $1`,
          [v.id, manager.id]);
      });

      const res = await call(`/api/sites/${siteId}/rotations`, { as: manager.id });
      expect(res.body.rotations[0].nextWeek.category).toBe('morning');
      expect(res.body.rotations[0].nextWeek.source.kind).toBe('roster');
    });

    it('שיבוץ בסוג שאינו של השבוע מופיע בבדיקת התקינות', async () => {
      const draft = await call(`/api/roster/draft?siteId=${siteId}&weekStart=${nextWeek}`, { as: manager.id });
      await call(`/api/roster/versions/${draft.body.version.id}/assignments`, {
        as: manager.id, method: 'POST',
        body: { userId: noa.id, date: addDays(nextWeek, 3), locationId: locId, shiftTypeId: eveningId },
      });
      const res = await call(`/api/roster/versions/${draft.body.version.id}/validate`, { as: manager.id, method: 'POST' });
      const rotationIssues = res.body.issues.filter((i) => i.ruleName === 'סבב שבועי');
      expect(rotationIssues).toHaveLength(1);
      expect(rotationIssues[0].severity).toBe('warning');
    });

    it('מיקום בלי סדר סבב אינו מתקבל לשיוך', async () => {
      const { query } = await import('../src/lib/db.js');
      const [other] = await query(`insert into locations (site_id, name) values ($1, 'מחלקה') returning id`, [siteId]);
      const res = await call(`/api/sites/${siteId}/rotations`, {
        as: manager.id, method: 'PUT',
        body: { rotations: [{ userId: avi.id, locationId: other.id, anchorWeek: thisWeek, anchorCategory: 'morning' }] },
      });
      expect(res.status).toBe(400);
    });
  });

  /* ── פעילויות: מדריך ושיוך שמי ── */

  describe('פעילויות', () => {
    let activityId;
    const day = addDays(nextWeek, 2);

    beforeAll(async () => {
      const { query } = await import('../src/lib/db.js');
      const [type] = await query('select id from activity_types where is_active order by display_order limit 1');
      const res = await call('/api/activities', {
        as: manager.id, method: 'POST',
        body: {
          siteId, activityTypeId: type.id, title: 'הדרכת עמדה', activityDate: day,
          startTime: '10:00', endTime: '12:00', audience: 'users', targetIds: [avi.id], ownerUserId: mentor.id,
        },
      });
      activityId = res.body.data.id;
    });

    it('שיוך מטמיע מהלו״ז השבועי, והפעילות מופיעה בלו״ז שלו', async () => {
      const add = await call(`/api/activities/${activityId}/participants`, {
        as: manager.id, method: 'POST', body: { userId: noa.id, present: true },
      });
      expect(add.body.participantCount).toBe(2);

      const board = await call(`/api/activities/board?siteId=${siteId}&weekStart=${nextWeek}`, { as: manager.id });
      const activity = board.body.activities.find((a) => a.id === activityId);
      expect(activity.participant_ids.sort()).toEqual([avi.id, noa.id].sort());
      expect(activity.owner_name).toBe('יוסי מדריך');

      const mine = await call(`/api/schedule/me?from=${day}&to=${day}`, { as: noa.id });
      expect(mine.body.items.some((i) => i.kind === 'activity' && i.id === activityId)).toBe(true);
    });

    it('השיוך נשמר גם אחרי עריכה של הפעילות בטופס', async () => {
      const detail = await call(`/api/activities/${activityId}`, { as: manager.id });
      expect(detail.body.audience.map((a) => a.target_id).sort()).toEqual([avi.id, noa.id].sort());
    });

    it('המדריך שמעביר רואה את הפעילות בלו״ז שלו', async () => {
      const mine = await call(`/api/schedule/me?from=${day}&to=${day}`, { as: mentor.id });
      const item = mine.body.items.find((i) => i.id === activityId);
      expect(item.as_instructor).toBe(true);
    });

    it('הסרה מהפעילות מוציאה אותה מהלו״ז', async () => {
      await call(`/api/activities/${activityId}/participants`, {
        as: manager.id, method: 'POST', body: { userId: noa.id, present: false },
      });
      const mine = await call(`/api/schedule/me?from=${day}&to=${day}`, { as: noa.id });
      expect(mine.body.items.some((i) => i.id === activityId)).toBe(false);
    });
  });
});
