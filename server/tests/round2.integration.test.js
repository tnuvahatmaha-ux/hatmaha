import { describe, it, expect, beforeAll, vi } from 'vitest';
import ExcelJS from 'exceljs';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';
import { weekStartOf, today } from '../src/lib/time.js';

/**
 * משוב סבב 2: הערות בשיבוץ, הודעות לקבוצה, צ׳אט קבוצתי, וסקילומטר.
 */

const DB = 'hatmaha_round2';
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

describeDb('משוב סבב 2 — מקצה לקצה', () => {
  let base, server, manager, mentor, noa, avi, siteId, nursingId, pharmaId, assignmentId;

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
      nursingId = (await tx.query(`insert into domains (name) values ('סיעוד') returning id`))[0].id;
      pharmaId = (await tx.query(`insert into domains (name) values ('רוקחות') returning id`))[0].id;

      await tx.query('insert into site_assignments (site_id, user_id) values ($1, $2), ($1, $3)', [siteId, noa.id, avi.id]);
      await tx.query('insert into user_domains (user_id, domain_id, is_primary) values ($1, $2, true), ($3, $4, true)',
        [noa.id, nursingId, avi.id, pharmaId]);
      await tx.query(
        `insert into mentor_responsibilities (mentor_user_id, site_id, domain_id) values ($1, $2, $3)`,
        [mentor.id, siteId, nursingId],
      );
      await tx.query(
        `insert into mentor_assignments (mentor_user_id, implementer_user_id, is_primary) values ($1, $2, true)`,
        [mentor.id, noa.id],
      );

      // שיבוץ בגרסה שפורסמה
      const [loc] = await tx.query(`insert into locations (site_id, name) values ($1, 'מחלקה') returning id`, [siteId]);
      const [shift] = await tx.query(
        `insert into shift_types (location_id, name, start_time, end_time) values ($1, 'בוקר', '07:00', '15:00') returning id`,
        [loc.id],
      );
      const week = weekStartOf(today());
      const [v] = await tx.query(
        `insert into roster_versions (site_id, week_start, status, version_number) values ($1, $2, 'draft', 1) returning id`,
        [siteId, week],
      );
      const [ra] = await tx.query(
        `insert into roster_assignments (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
                                         start_time, end_time, starts_at, ends_at)
         values ($1, $2, $3, $4, $5, $6, '07:00', '15:00', ($3::date + time '07:00') at time zone 'Asia/Jerusalem',
                 ($3::date + time '15:00') at time zone 'Asia/Jerusalem') returning id`,
        [v.id, siteId, today(), loc.id, noa.id, shift.id],
      );
      assignmentId = ra.id;
      await tx.query(`update roster_versions set status = 'published', published_at = now(), published_by = $2 where id = $1`, [v.id, manager.id]);
    });

    server = (await import('../src/app.js')).createApp().listen(0);
    await new Promise((r) => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }, 60_000);

  const call = async (path, { as, method = 'GET', body, raw } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'x-test-user': as, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (raw) return res;
    return { status: res.status, body: await res.json().catch(() => null) };
  };

  /* ── הערות בשיבוץ ── */

  it('הערה על שיבוץ בסידור שפורסם נשמרת, והמטמיעה רואה אותה בלו״ז', async () => {
    const res = await call(`/api/roster/assignments/${assignmentId}/note`, {
      as: manager.id, method: 'PATCH', body: { note: 'להגיע 10 דקות קודם' },
    });
    expect(res.status).toBe(200);

    const me = await call(`/api/schedule/me?from=${today()}&to=${today()}`, { as: noa.id });
    const shift = me.body.items.find((i) => i.kind === 'shift');
    expect(shift.note).toBe('להגיע 10 דקות קודם');
  });

  it('שינוי אחר בשיבוץ שפורסם עדיין חסום', async () => {
    const { query } = await import('../src/lib/db.js');
    await expect(query(`update roster_assignments set start_time = '08:00' where id = $1`, [assignmentId]))
      .rejects.toThrow();
  });

  /* ── הודעה לקבוצה ── */

  it('הודעה לתחום מגיעה רק לחברי התחום', async () => {
    const preview = await call(`/api/updates/audience?audience=domain&targetId=${nursingId}`, { as: mentor.id });
    expect(preview.body.count).toBe(1);

    const created = await call('/api/updates', {
      as: mentor.id, method: 'POST',
      body: { title: 'נוהל סיעוד', body: 'לקרוא', audience: 'domain', targetId: nursingId, requiresAck: true },
    });
    expect(created.status).toBe(201);
    await call(`/api/updates/${created.body.id}/publish`, { as: mentor.id, method: 'POST' });

    expect((await call('/api/updates/inbox', { as: noa.id })).body.updates).toHaveLength(1);
    expect((await call('/api/updates/inbox', { as: avi.id })).body.updates).toHaveLength(0);
  });

  it('מדריך אינו שולח לתחום שאינו באחריותו', async () => {
    const res = await call('/api/updates', {
      as: mentor.id, method: 'POST',
      body: { title: 'x', body: 'y', audience: 'domain', targetId: pharmaId },
    });
    expect(res.status).toBe(403);
  });

  /* ── צ׳אט ── */

  let groupId;
  it('קבוצת תחום מקבלת את חבריה מהשיוכים, ומי שאינו חבר אינו רואה אותה', async () => {
    const res = await call('/api/chat/groups', {
      as: mentor.id, method: 'POST', body: { name: 'צוות סיעוד', kind: 'domain', domainId: nursingId },
    });
    expect(res.status).toBe(201);
    groupId = res.body.group.id;

    const members = await call(`/api/chat/groups/${groupId}/members`, { as: mentor.id });
    expect(members.body.members.map((m) => m.id).sort()).toEqual([mentor.id, noa.id].sort());

    expect((await call(`/api/chat/groups/${groupId}/messages`, { as: avi.id })).status).toBe(404);
  });

  it('הודעות נשלחות ומתקבלות, ורענון after מחזיר רק את החדשות', async () => {
    const first = await call(`/api/chat/groups/${groupId}/messages`, {
      as: mentor.id, method: 'POST', body: { body: 'בוקר טוב' },
    });
    expect(first.status).toBe(201);

    const groups = await call('/api/chat/groups', { as: noa.id });
    expect(groups.body.groups.find((g) => g.id === groupId).unread).toBe(1);

    await call(`/api/chat/groups/${groupId}/messages`, { as: noa.id, method: 'POST', body: { body: 'בוקר אור' } });
    const after = await call(`/api/chat/groups/${groupId}/messages?after=${first.body.message.id}`, { as: mentor.id });
    expect(after.body.messages.map((m) => m.body)).toEqual(['בוקר אור']);
  });

  /* ── סקילומטר ── */

  let roundId, topicNursing, topicPharma, euNursing, euPharma;
  it('מנהל בונה סקילומטר: נושאים, משתמשי קצה וסבב', async () => {
    topicNursing = (await call('/api/skills/topics', {
      as: manager.id, method: 'POST', body: { domainId: nursingId, name: 'קבלת חולה' },
    })).body.topic.id;
    topicPharma = (await call('/api/skills/topics', {
      as: manager.id, method: 'POST', body: { domainId: pharmaId, name: 'הזמנת תרופות' },
    })).body.topic.id;

    const dry = await call('/api/skills/end-users/import', {
      as: manager.id, method: 'POST',
      body: {
        siteId, dryRun: true,
        rows: [
          { fullName: 'רונית אחות', employeeNo: '101', domainName: 'סיעוד' },
          { fullName: 'דני רוקח', employeeNo: '102', domainName: 'רוקחות' },
          { fullName: 'שגוי', domainName: 'לא קיים' },
        ],
      },
    });
    expect(dry.body).toMatchObject({ valid: 2, invalid: 1 });

    const real = await call('/api/skills/end-users/import', {
      as: manager.id, method: 'POST',
      body: { siteId, dryRun: false, rows: [
        { fullName: 'רונית אחות', employeeNo: '101', domainName: 'סיעוד' },
        { fullName: 'דני רוקח', employeeNo: '102', domainName: 'רוקחות' },
      ] },
    });
    expect(real.body.created).toBe(2);

    const users = (await call(`/api/skills/end-users?siteId=${siteId}`, { as: manager.id })).body.endUsers;
    euNursing = users.find((u) => u.employee_no === '101').id;
    euPharma = users.find((u) => u.employee_no === '102').id;

    const round = await call('/api/skills/rounds', {
      as: manager.id, method: 'POST',
      body: { siteId, name: 'סבב 1', status: 'open', topicIds: [topicNursing, topicPharma] },
    });
    expect(round.status).toBe(201);
    roundId = round.body.round.id;
  });

  it('מטמיעה רואה ומדרגת רק את התחום שלה', async () => {
    const sheet = await call(`/api/skills/rounds/${roundId}/sheet`, { as: noa.id });
    expect(sheet.body.users.map((u) => u.id)).toEqual([euNursing]);
    expect(sheet.body.topics.map((t) => t.id)).toEqual([topicNursing]);

    const ok = await call(`/api/skills/rounds/${roundId}/scores`, {
      as: noa.id, method: 'PUT', body: { scores: [{ endUserId: euNursing, topicId: topicNursing, score: 1 }] },
    });
    expect(ok.status).toBe(200);

    const outside = await call(`/api/skills/rounds/${roundId}/scores`, {
      as: noa.id, method: 'PUT', body: { scores: [{ endUserId: euPharma, topicId: topicPharma, score: 3 }] },
    });
    expect(outside.status).toBe(403);

    const bad = await call(`/api/skills/rounds/${roundId}/scores`, {
      as: noa.id, method: 'PUT', body: { scores: [{ endUserId: euNursing, topicId: topicNursing, score: 5 }] },
    });
    expect(bad.status).toBe(400);

    const note = await call(`/api/skills/rounds/${roundId}/notes/${euNursing}`, {
      as: noa.id, method: 'PUT', body: { note: 'עדיין לא מכירה את מסך הקבלה' },
    });
    expect(note.status).toBe(200);
  });

  it('הסיכום מציג את מי שזקוק לחיזוק, והייצוא מחזיר אקסל עם גיליון לכל תחום', async () => {
    await call(`/api/skills/rounds/${roundId}/scores`, {
      as: avi.id, method: 'PUT', body: { scores: [{ endUserId: euPharma, topicId: topicPharma, score: 4 }] },
    });

    const summary = await call(`/api/skills/summary?siteId=${siteId}`, { as: manager.id });
    expect(summary.body.completion).toBe(100);
    expect(summary.body.top[0].full_name).toBe('דני רוקח');
    expect(summary.body.struggling.map((p) => p.full_name)).toEqual(['רונית אחות']);

    const res = await call(`/api/skills/rounds/${roundId}/export.xlsx`, { as: manager.id, raw: true });
    expect(res.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await res.arrayBuffer()));
    expect(wb.worksheets.map((w) => w.name)).toEqual(['סיכום', 'סיעוד', 'רוקחות']);
    const sheet = wb.getWorksheet('סיעוד');
    expect(sheet.getRow(2).getCell(4).value).toBe(1);
  });

  it('בסבב סגור אי אפשר לעדכן', async () => {
    await call('/api/skills/rounds', {
      as: manager.id, method: 'POST', body: { id: roundId, siteId, name: 'סבב 1', status: 'closed' },
    });
    const res = await call(`/api/skills/rounds/${roundId}/scores`, {
      as: noa.id, method: 'PUT', body: { scores: [{ endUserId: euNursing, topicId: topicNursing, score: 2 }] },
    });
    expect(res.status).toBe(409);
  });
});
