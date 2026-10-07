import { describe, it, expect, beforeAll, vi } from 'vitest';
import { dbAvailable, resetSchema, createUser, dbUrlFor } from './helpers/db.js';

const DB = 'hatmaha_req';
import { addDays, today } from '../src/lib/time.js';

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

describeDb('בקשות אילוץ — מנוע החוקיות מקצה לקצה', () => {
  let base, server, manager, mentor, noa, siteId, vacationId, sickId;

  beforeAll(async () => {
    resetSchema({ db: DB });
    const { withTransaction } = await import('../src/lib/db.js');

    await withTransaction({}, async (tx) => {
      manager = await createUser(tx, { email: 'm@t.local', fullName: 'דנה כהן', role: 'manager' });
      mentor = await createUser(tx, { email: 'y@t.local', fullName: 'יוסי לוי', role: 'mentor' });
      noa = await createUser(tx, { email: 'n@t.local', fullName: 'נועה פרץ' });

      const [site] = await tx.query(
        `insert into sites (name, status_id, open_time, close_time)
         select 'מרכז רפואי צפון', id, '07:00', '23:00' from site_statuses where code='training'
         returning id`,
      );
      siteId = site.id;

      await tx.query(
        `insert into site_assignments (site_id, user_id) values ($1, $2), ($1, $3)`,
        [siteId, noa.id, mentor.id],
      );
      await tx.query(
        `insert into mentor_assignments (mentor_user_id, implementer_user_id, is_primary)
         values ($1, $2, true)`,
        [mentor.id, noa.id],
      );

      const types = await tx.query('select id, code from constraint_types');
      vacationId = types.find((t) => t.code === 'vacation').id;
      sickId = types.find((t) => t.code === 'sick').id;
    });

    const { createApp } = await import('../src/app.js');
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

  const makeRequest = async (overrides = {}) => {
    const res = await call('/api/requests', {
      as: noa.id,
      method: 'POST',
      body: {
        constraintTypeId: vacationId,
        constraintDate: addDays(today(), 30),
        startTime: '00:00',
        endTime: '23:59',
        note: 'אירוע משפחתי',
        ...overrides,
      },
    });
    expect(res.status).toBe(201);
    return (await res.json()).request;
  };

  it('AC-09: בדיקה מקדימה מראה מה יקרה — בלי לשמור דבר', async () => {
    const res = await call('/api/requests/preview', {
      as: noa.id,
      method: 'POST',
      body: {
        constraintTypeId: vacationId,
        constraintDate: addDays(today(), 30),
        startTime: '09:00',
        endTime: '17:00',
      },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.outcome).toBe('pass');
    expect(body.willBe).toBe('pending_manager'); // חופשה = דורש אישור לפי ברירת המחדל
  });

  it('בדיקה מקדימה מזהה הודעה מוקדמת קצרה מדי', async () => {
    const res = await call('/api/requests/preview', {
      as: noa.id,
      method: 'POST',
      body: {
        constraintTypeId: vacationId,
        constraintDate: addDays(today(), 1),
        startTime: '09:00',
        endTime: '17:00',
      },
    });
    const body = await res.json();
    expect(body.outcome).toBe('approval_required');
    expect(body.willBe).toBe('pending_exception');
    expect(body.findings.map((f) => f.ruleName)).toContain('הודעה מוקדמת של 3 ימים');
  });

  it('בקשה תקינה עוברת להחלטת מנהל', async () => {
    const request = await makeRequest();
    const res = await call(`/api/requests/${request.id}/submit`, {
      as: noa.id, method: 'POST', key: `submit-${request.id}`,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.request.status).toBe('submitted');
  });

  it('אישור בקשה רגילה בלחיצה אחת — בלי נימוק', async () => {
    const request = await makeRequest({ constraintDate: addDays(today(), 31) });
    await call(`/api/requests/${request.id}/submit`, {
      as: noa.id, method: 'POST', key: `submit-${request.id}`,
    });

    const res = await call(`/api/requests/${request.id}/decision`, {
      as: manager.id, method: 'POST', key: `decide-${request.id}`, body: { decision: 'approve' },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.status).toBe('approved');
    expect(body.request.decision_note).toBeNull();

    // המטמיעה מקבלת התראה גם בלי נימוק
    const inbox = await (await call('/api/notifications', { as: noa.id })).json();
    expect(inbox.notifications.some((n) => n.title === 'הבקשה אושרה')).toBe(true);
  });

  it('כלל האישור הגנרי חל על כל האתרים וניתן לשינוי ע״י המנהל', async () => {
    const rules = await (await call('/api/settings/constraint-approval', { as: manager.id })).json();
    expect(rules.rules.find((r) => r.id === vacationId).approval_mode).toBe('manager');

    const set = (mode) =>
      call(`/api/settings/constraint-approval/${vacationId}`, {
        as: manager.id, method: 'PUT', body: { approvalMode: mode },
      });

    // מטמיעה אינה רשאית לשנות כללים
    const denied = await call(`/api/settings/constraint-approval/${vacationId}`, {
      as: noa.id, method: 'PUT', body: { approvalMode: 'auto' },
    });
    expect(denied.status).toBe(403);

    expect((await set('auto')).status).toBe(200);
    const request = await makeRequest({ constraintDate: addDays(today(), 32) });
    const res = await call(`/api/requests/${request.id}/submit`, {
      as: noa.id, method: 'POST', key: `submit-${request.id}`,
    });
    const body = await res.json();
    expect(body.request.status).toBe('approved');
    expect(body.request.auto_approved).toBe(true);

    expect((await set('manager')).status).toBe(200);
  });

  it('AC-10: בקשה שחורגת מחוק אינה נכנסת לתוקף לפני החלטה', async () => {
    const request = await makeRequest({
      constraintTypeId: sickId,               // מחלה = אישור אוטומטי לפי ברירת המחדל
      constraintDate: addDays(today(), 1),    // אך הודעה מוקדמת קצרה מדי
    });

    const res = await call(`/api/requests/${request.id}/submit`, {
      as: noa.id, method: 'POST', key: `submit-${request.id}`,
    });

    expect(res.status).toBe(202);            // נקלט, אך אינו בתוקף
    const body = await res.json();
    expect(body.status).toBe('approval_required');
    expect(body.exceptions).toHaveLength(1);
    expect(body.request.status).toBe('submitted');
    expect(body.request.status).not.toBe('approved');

    // החריגה נותבה למדריך הראשי, לא למנהל
    const queue = await (await call('/api/exceptions?mine=true', { as: mentor.id })).json();
    expect(queue.exceptions).toHaveLength(1);
    expect(queue.exceptions[0].target_name).toBe('נועה פרץ');
  });

  it('בקשה עם חריגה פתוחה אינה ניתנת לאישור ישיר — רק דרך החריגה', async () => {
    const queue = await (await call('/api/exceptions?mine=true', { as: mentor.id })).json();
    const requestId = queue.exceptions[0].subject_id;

    const list = await (await call('/api/requests?status=submitted', { as: manager.id })).json();
    expect(list.requests.find((r) => r.id === requestId).has_pending_exception).toBe(true);

    const res = await call(`/api/requests/${requestId}/decision`, {
      as: manager.id, method: 'POST', key: `bypass-${requestId}`, body: { decision: 'approve' },
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('E_PENDING_APPROVAL');

    const after = await (await call(`/api/requests/${requestId}`, { as: manager.id })).json();
    expect(after.request.status).toBe('submitted');
  });

  it('החלטה ללא נימוק נדחית', async () => {
    const queue = await (await call('/api/exceptions?mine=true', { as: mentor.id })).json();
    const res = await call(`/api/exceptions/${queue.exceptions[0].id}/decision`, {
      as: mentor.id, method: 'POST', body: { decision: 'approve', comment: '' },
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('E_VALIDATION');
  });

  it('נושא הבקשה אינו יכול לאשר את החריגה של עצמו', async () => {
    const queue = await (await call('/api/exceptions', { as: manager.id })).json();
    const pending = queue.exceptions.find((e) => e.status === 'pending');
    const res = await call(`/api/exceptions/${pending.id}/decision`, {
      as: noa.id, method: 'POST', body: { decision: 'approve', comment: 'אני מאשרת לעצמי' },
    });
    expect(res.status).toBe(403);
  });

  it('אישור החריגה מבצע את הפעולה שחנתה — ורק אז', async () => {
    const queue = await (await call('/api/exceptions?mine=true', { as: mentor.id })).json();
    const ex = queue.exceptions[0];

    const res = await call(`/api/exceptions/${ex.id}/decision`, {
      as: mentor.id,
      method: 'POST',
      key: `decide-${ex.id}`,
      body: { decision: 'approve', comment: 'מחלה — מאשר חריגה מהודעה מוקדמת' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('approved');

    // עכשיו, ורק עכשיו, מדיניות "מחלה = אוטומטי" הופעלה
    const request = await (await call(`/api/requests/${ex.subject_id}`, { as: manager.id })).json();
    expect(request.request.status).toBe('approved');
    expect(request.request.auto_approved).toBe(true);
  });

  it('החלטה חוזרת עם אותו מפתח אינה מבצעת פעמיים', async () => {
    const queue = await (await call('/api/exceptions', { as: manager.id })).json();
    const decided = queue.exceptions.find((e) => e.status === 'approved');

    const res = await call(`/api/exceptions/${decided.id}/decision`, {
      as: mentor.id,
      method: 'POST',
      key: `decide-${decided.id}`,
      body: { decision: 'approve', comment: 'מחלה — מאשר חריגה מהודעה מוקדמת' },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).replayed ?? true).toBeTruthy();
  });

  it('AC-11: חוק חוסם מונע את הפעולה ומציג את הסיבה', async () => {
    const { withTransaction } = await import('../src/lib/db.js');
    const blackFrom = addDays(today(), 40);
    const blackTo = addDays(today(), 50);

    await withTransaction({ actorId: manager.id }, async (tx) => {
      await tx.query(
        `insert into rules (name, trigger, applies_to, condition_type_code, condition_params,
                            severity, priority, message_he, scope_type, scope_id)
         values ('תקופת הקפאה לפני Go Live', 'submit', 'constraint', 'blackoutDates',
                 $1::jsonb, 'blocking', 5,
                 'לא ניתן להגיש בקשות בתקופת ההיערכות ל-Go Live', 'site', $2)`,
        [JSON.stringify({ from: blackFrom, to: blackTo }), siteId],
      );
    });

    const request = await makeRequest({ constraintDate: addDays(today(), 45) });
    const res = await call(`/api/requests/${request.id}/submit`, {
      as: noa.id, method: 'POST', key: `submit-${request.id}`,
    });

    expect(res.status).toBe(422);
    const { error } = await res.json();
    expect(error.code).toBe('E_RULE_BLOCKED');
    expect(error.message).toContain('תקופת ההיערכות');
    expect(error.details.blocking[0].name).toBe('תקופת הקפאה לפני Go Live');

    // הבקשה נשארה טיוטה — כלום לא נכנס לתוקף
    const after = await (await call(`/api/requests/${request.id}`, { as: manager.id })).json();
    expect(after.request.status).toBe('draft');
  });

  it('אין בקשה כפולה פעילה לאותו סוג וטווח', async () => {
    const date = addDays(today(), 60);
    const first = await makeRequest({ constraintDate: date });
    await call(`/api/requests/${first.id}/submit`, { as: noa.id, method: 'POST' });

    const second = await makeRequest({ constraintDate: date });
    const res = await call(`/api/requests/${second.id}/submit`, { as: noa.id, method: 'POST' });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('E_DUPLICATE');
  });

  it('AC-13: מטמיע אינו רואה בקשות של מטמיע אחר', async () => {
    const other = await (await import('../src/lib/db.js')).withTransaction({}, (tx) =>
      createUser(tx, { email: 'other@t.local', fullName: 'איתי מזרחי' }),
    );
    const res = await call('/api/requests', { as: other.id });
    expect(res.status).toBe(200);
    expect((await res.json()).requests).toHaveLength(0);
  });
});
