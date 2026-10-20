import { query, withTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { addDays, weekStartOf, today } from '../lib/time.js';
import { notify } from '../notifications/service.js';

/**
 * תוכנית הכשרה אישית — גאנט.
 *
 * כל מטמיע מקבל שלבים (user_training_items) עם תאריך התחלה ויעד, שנוצרים
 * מתבנית (training_tracks) או ידנית. ההתקדמות מדווחת פעם בשבוע באחוזים
 * (training_progress_updates), ונכנסת לשלב רק אחרי שמנהל ההטמעה אישר —
 * כך האחוז בגאנט הוא תמיד אחוז מאושר. דיווח של מנהל מאושר מיד.
 */

const isManager = (p) => p.baseRole === 'manager';

const ITEM_SELECT = `
  select uti.id, uti.user_id, coalesce(uti.title, tti.title) as title,
         uti.start_on, uti.due_on, uti.completed_on, uti.progress_pct, uti.display_order,
         uti.note, uti.track_item_id, uti.row_version,
         pend.id as pending_id, pend.progress_pct as pending_pct, pend.week_start as pending_week,
         pend.note as pending_note, submitter.full_name as pending_by,
         last_ok.week_start as last_approved_week
    from user_training_items uti
    left join training_track_items tti on tti.id = uti.track_item_id
    left join lateral (
      select * from training_progress_updates t
       where t.user_training_item_id = uti.id and t.status = 'pending' and t.deleted_at is null
       order by t.created_at desc limit 1) pend on true
    left join profiles submitter on submitter.id = pend.submitted_by
    left join lateral (
      select week_start from training_progress_updates t
       where t.user_training_item_id = uti.id and t.status = 'approved' and t.deleted_at is null
       order by t.week_start desc limit 1) last_ok on true
   where uti.deleted_at is null`;

/** מי בטווח של הקורא: מנהל — כולם, מדריך — המשויכים אליו, מטמיע — עצמו */
function scopeIds(principal) {
  if (isManager(principal)) return null;
  return [principal.userId, ...(principal.scopes.assignedUserIds ?? [])];
}

export async function plans(principal, { siteId, domainId, userId }) {
  const ids = scopeIds(principal);
  const people = await query(
    `select distinct p.id, p.full_name, ts.name_he as training_status,
            (select string_agg(d.name, ', ' order by d.name) from user_domains ud
               join domains d on d.id = ud.domain_id
              where ud.user_id = p.id and ud.deleted_at is null) as domains,
            (select mp.full_name from mentor_assignments ma join profiles mp on mp.id = ma.mentor_user_id
              where ma.implementer_user_id = p.id and ma.is_primary and ma.deleted_at is null
                and ma.span @> current_date limit 1) as mentor_name
       from profiles p
       left join training_statuses ts on ts.id = p.training_status_id
      where p.deleted_at is null and p.status = 'active'
        and p.base_role in ('implementer', 'lead')
        and ($1::uuid[] is null or p.id = any($1::uuid[]))
        and ($2::uuid is null or exists (select 1 from site_assignments sa
              where sa.user_id = p.id and sa.site_id = $2 and sa.deleted_at is null and sa.span @> current_date))
        and ($3::uuid is null or exists (select 1 from user_domains ud
              where ud.user_id = p.id and ud.domain_id = $3 and ud.deleted_at is null))
        and ($4::uuid is null or p.id = $4)
      order by p.full_name`,
    [ids, siteId ?? null, domainId ?? null, userId ?? null],
  );
  if (!people.length) return [];

  const items = await query(
    `${ITEM_SELECT} and uti.user_id = any($1::uuid[])
     order by uti.display_order, uti.start_on nulls last`,
    [people.map((p) => p.id)],
  );
  return people.map((p) => {
    const own = items.filter((i) => i.user_id === p.id);
    const overall = own.length ? Math.round(own.reduce((s, i) => s + i.progress_pct, 0) / own.length) : null;
    return { ...p, overall_pct: overall, items: own };
  });
}

async function statusId(tx) {
  const [row] = await tx.query(
    `select id from training_statuses where code = 'in_training' and deleted_at is null
     union all select id from training_statuses where deleted_at is null
     limit 1`,
  );
  return row.id;
}

export async function addItem(actor, userId, { title, startOn, dueOn }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [{ next }] = await tx.query(
      `select coalesce(max(display_order), 0) + 10 as next from user_training_items
        where user_id = $1 and deleted_at is null`,
      [userId],
    );
    const [row] = await tx.query(
      `insert into user_training_items (user_id, title, start_on, due_on, status_id, display_order)
       values ($1, $2, $3, $4, $5, $6) returning id`,
      [userId, title, startOn, dueOn, await statusId(tx), next],
    );
    return row;
  });
}

/** יצירת שלבים מתבנית: כל שלב מתחיל כשהקודם מסתיים */
export async function applyTrack(actor, userId, { trackId, startOn }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const steps = await tx.query(
      `select id, title, duration_days, offset_days from training_track_items
        where track_id = $1 and deleted_at is null order by display_order`,
      [trackId],
    );
    if (!steps.length) throw new AppError('E_VALIDATION', 'בתבנית אין שלבים');
    const [{ base }] = await tx.query(
      `select coalesce(max(display_order), 0) as base from user_training_items
        where user_id = $1 and deleted_at is null`,
      [userId],
    );
    const status = await statusId(tx);
    let cursor = startOn;
    let order = base;
    let created = 0;
    for (const step of steps) {
      // שלב עם היסט (מגאנט שנטען מקובץ) מתחיל בתאריך קבוע ביחס להתחלה; אחר — אחרי הקודם
      const begin = step.offset_days != null ? addDays(startOn, step.offset_days) : cursor;
      const due = addDays(begin, Math.max(1, step.duration_days) - 1);
      order += 10;
      const rows = await tx.query(
        `insert into user_training_items
           (user_id, track_item_id, title, start_on, due_on, status_id, display_order)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (user_id, track_item_id) where track_item_id is not null and deleted_at is null
         do nothing returning id`,
        [userId, step.id, step.title, begin, due, status, order],
      );
      created += rows.length;
      if (addDays(due, 1) > cursor) cursor = addDays(due, 1);
    }
    return { created };
  });
}

export async function updateItem(actor, itemId, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update user_training_items
          set title = coalesce($2, title), start_on = coalesce($3, start_on),
              due_on = coalesce($4, due_on), display_order = coalesce($5, display_order),
              note = coalesce($6, note)
        where id = $1 and deleted_at is null returning id`,
      [itemId, input.title ?? null, input.startOn ?? null, input.dueOn ?? null,
       input.displayOrder ?? null, input.note ?? null],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'השלב לא נמצא');
    return row;
  });
}

export async function removeItem(actor, itemId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await tx.query(
      'update user_training_items set deleted_at = now(), deleted_by = $2 where id = $1',
      [itemId, actor.userId],
    );
    return { id: itemId };
  });
}

/** האחוז המאושר נכנס לשלב; 100% מסמן את השלב כהושלם */
async function applyApproved(tx, itemId, pct) {
  await tx.query(
    `update user_training_items
        set progress_pct = $2::smallint,
            completed_on = case when $2::smallint >= 100 then coalesce(completed_on, current_date) else null end
      where id = $1`,
    [itemId, pct],
  );
}

export async function reportProgress(actor, itemId, { progressPct, note, weekStart }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const item = await tx.lock('user_training_items', itemId);
    if (!item || item.deleted_at) throw new AppError('E_NOT_FOUND', 'השלב לא נמצא');
    const row = await reportIn(tx, actor, item, { progressPct, note, weekStart });
    if (row.status === 'pending') {
      const [who] = await tx.query('select full_name from profiles where id = $1', [item.user_id]);
      await notifyManagers(tx, row.id, `${who?.full_name ?? ''} — ${item.title ?? 'שלב'}: ${progressPct}%`);
    }
    return row;
  });
}

async function notifyManagers(tx, entityId, body) {
  const managers = await tx.query(
    `select id from profiles where base_role = 'manager' and status = 'active' and deleted_at is null`,
  );
  await notify(tx, {
    typeCode: 'training_progress_submitted',
    recipientIds: managers.map((m) => m.id),
    title: 'דיווח התקדמות הכשרה ממתין לאישור',
    body,
    entityType: 'training_progress_updates',
    entityId,
    payload: { url: '/training' },
  });
}

/**
 * סימון סטטוס לכמה שלבים יחד (מטבלת ההכשרה). אצל מדריך כל שלב נכנס לתור
 * האישור כרגיל; אצל מנהל ההטמעה הוא מאושר מיד. התראה אחת למנהלים על הכול.
 */
export async function reportBulk(actor, { itemIds, progressPct, note }) {
  const ids = scopeIds(actor);
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const items = await tx.query(
      `select * from user_training_items where id = any($1::uuid[]) and deleted_at is null for update`,
      [itemIds],
    );
    if (items.length !== new Set(itemIds).size) throw new AppError('E_NOT_FOUND', 'חלק מהשלבים לא נמצאו');
    if (ids && items.some((i) => !ids.includes(i.user_id))) {
      throw new AppError('E_FORBIDDEN', 'חלק מהשלבים שייכים למטמיעים שאינם באחריותך');
    }
    let pending = null;
    for (const item of items) {
      const row = await reportIn(tx, actor, item, { progressPct, note });
      if (row.status === 'pending') pending = row;
    }
    if (pending) {
      const people = new Set(items.map((i) => i.user_id)).size;
      await notifyManagers(tx, pending.id, `${items.length} שלבים של ${people} מטמיעים: ${progressPct}%`);
    }
    return { updated: items.length, status: pending ? 'pending' : 'approved' };
  });
}

async function reportIn(tx, actor, item, { progressPct, note, weekStart }) {
  const itemId = item.id;
  const week = weekStart ?? weekStartOf(today());
  const auto = isManager(actor);

  // דיווח חדש מחליף דיווח שעוד ממתין על אותו שלב
  await tx.query(
    `update training_progress_updates set deleted_at = now(), deleted_by = $2
      where user_training_item_id = $1 and status = 'pending' and deleted_at is null`,
    [itemId, actor.userId],
  );
  const [row] = await tx.query(
    `insert into training_progress_updates
       (user_training_item_id, user_id, week_start, progress_pct, note, submitted_by,
        status, decided_by, decided_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id, status`,
    [itemId, item.user_id, week, progressPct, note ?? null, actor.userId,
     auto ? 'approved' : 'pending', auto ? actor.userId : null, auto ? new Date() : null],
  );

  if (auto) await applyApproved(tx, itemId, progressPct);
  return row;
}

export async function pendingQueue(principal) {
  const ids = scopeIds(principal);
  return query(
    `select t.id, t.user_id, t.week_start, t.progress_pct, t.note, t.created_at,
            p.full_name, coalesce(uti.title, tti.title) as item_title, uti.progress_pct as current_pct,
            s.full_name as submitted_by_name
       from training_progress_updates t
       join user_training_items uti on uti.id = t.user_training_item_id and uti.deleted_at is null
       left join training_track_items tti on tti.id = uti.track_item_id
       join profiles p on p.id = t.user_id
       left join profiles s on s.id = t.submitted_by
      where t.status = 'pending' and t.deleted_at is null
        and ($1::uuid[] is null or t.user_id = any($1::uuid[]))
      order by t.created_at`,
    [ids],
  );
}

export async function decide(actor, updateId, { decision, comment }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const row = await tx.lock('training_progress_updates', updateId);
    if (!row || row.deleted_at) throw new AppError('E_NOT_FOUND', 'הדיווח לא נמצא');
    if (row.status !== 'pending') return { id: updateId, status: row.status, alreadyDecided: true };

    const approved = decision === 'approve';
    await tx.query(
      `update training_progress_updates
          set status = $2, decided_by = $3, decided_at = now(), decision_note = $4
        where id = $1`,
      [updateId, approved ? 'approved' : 'rejected', actor.userId, comment ?? null],
    );
    if (approved) await applyApproved(tx, row.user_training_item_id, row.progress_pct);

    await notify(tx, {
      typeCode: 'training_progress_decided',
      recipientIds: [row.submitted_by, row.user_id].filter((id) => id && id !== actor.userId),
      title: approved ? 'התקדמות ההכשרה אושרה' : 'דיווח התקדמות ההכשרה נדחה',
      body: comment || `${row.progress_pct}%`,
      entityType: 'training_progress_updates',
      entityId: updateId,
      payload: { url: '/training' },
    });
    return { id: updateId, status: approved ? 'approved' : 'rejected' };
  });
}

export async function history(itemId) {
  return query(
    `select t.id, t.week_start, t.progress_pct, t.note, t.status, t.decision_note, t.created_at,
            s.full_name as submitted_by_name, d.full_name as decided_by_name
       from training_progress_updates t
       left join profiles s on s.id = t.submitted_by
       left join profiles d on d.id = t.decided_by
      where t.user_training_item_id = $1 and t.deleted_at is null
      order by t.created_at desc`,
    [itemId],
  );
}

/* ───────────────────────── תבניות ───────────────────────── */

export async function tracks() {
  const [list, items] = await Promise.all([
    query(
      `select id, name, description, is_active, start_on from training_tracks
        where deleted_at is null order by name`,
    ),
    query(
      `select id, track_id, title, duration_days, offset_days, display_order from training_track_items
        where deleted_at is null order by display_order`,
    ),
  ]);
  return list.map((t) => ({ ...t, items: items.filter((i) => i.track_id === t.id) }));
}

/** שמירת תבנית ושלביה: השלבים שנשלחו מחליפים את הקיימים לפי הסדר */
export async function saveTrack(actor, { id, name, description, isActive, items }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let trackId = id;
    if (id) {
      const [row] = await tx.query(
        `update training_tracks set name = $2, description = $3, is_active = coalesce($4, is_active)
          where id = $1 and deleted_at is null returning id`,
        [id, name, description ?? null, isActive ?? null],
      );
      if (!row) throw new AppError('E_NOT_FOUND', 'התבנית לא נמצאה');
    } else {
      const [row] = await tx.query(
        'insert into training_tracks (name, description) values ($1, $2) returning id',
        [name, description ?? null],
      );
      trackId = row.id;
    }

    const keep = items.filter((i) => i.id).map((i) => i.id);
    await tx.query(
      `update training_track_items set deleted_at = now(), deleted_by = $3
        where track_id = $1 and deleted_at is null and not (id = any($2::uuid[]))`,
      [trackId, keep, actor.userId],
    );
    for (const [index, item] of items.entries()) {
      if (item.id) {
        await tx.query(
          `update training_track_items set title = $2, duration_days = $3, display_order = $4
            where id = $1 and track_id = $5`,
          [item.id, item.title, item.durationDays, (index + 1) * 10, trackId],
        );
      } else {
        await tx.query(
          `insert into training_track_items (track_id, title, duration_days, display_order)
           values ($1, $2, $3, $4)`,
          [trackId, item.title, item.durationDays, (index + 1) * 10],
        );
      }
    }
    return { id: trackId };
  });
}

export async function removeTrack(actor, id) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await tx.query('update training_tracks set deleted_at = now(), deleted_by = $2 where id = $1', [id, actor.userId]);
    return { id };
  });
}

/** דוח התקדמות: לכל מטמיע ושלב — האחוז המאושר, יעד, ופיגור */
export async function progressReport(principal, filters) {
  const people = await plans(principal, filters);
  const now = today();
  return people.flatMap((p) => p.items.map((i) => {
    // האחוז הצפוי לפי חלוף הזמן בין תחילת השלב ליעד
    let expected = null;
    if (i.start_on && i.due_on) {
      const total = (Date.parse(i.due_on) - Date.parse(i.start_on)) / 86_400_000 + 1;
      const passed = (Date.parse(now) - Date.parse(i.start_on)) / 86_400_000 + 1;
      expected = Math.max(0, Math.min(100, Math.round((passed / total) * 100)));
    }
    return {
      user_id: p.id, full_name: p.full_name, mentor_name: p.mentor_name, domains: p.domains,
      overall_pct: p.overall_pct, item_title: i.title, start_on: i.start_on, due_on: i.due_on,
      progress_pct: i.progress_pct, expected_pct: expected,
      behind: expected != null && i.progress_pct < 100 && expected - i.progress_pct >= 20,
      completed_on: i.completed_on, last_approved_week: i.last_approved_week,
    };
  }));
}

/* ───────────────────────── גאנט כללי מקובץ ───────────────────────── */

const HEADERS = {
  title: ['שלב', 'משימה', 'פעילות', 'נושא', 'שם', 'תיאור', 'task', 'name', 'activity', 'stage', 'title'],
  start: ['התחלה', 'מתאריך', 'start', 'begin', 'from'],
  due: ['סיום', 'יעד', 'עד תאריך', 'end', 'due', 'finish', 'to'],
  days: ['משך', 'ימים', 'duration', 'days'],
};

const cellText = (v) => {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') return String(v.text ?? v.result ?? v.richText?.map((r) => r.text).join('') ?? '');
  return String(v);
};

/** תאריך מתא: Date של אקסל, מספר סידורי, dd/mm/yyyy או yyyy-mm-dd */
function parseDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  if (typeof v === 'object' && v.result != null) return parseDate(v.result);
  if (typeof v === 'number' && v > 20000 && v < 80000) {
    return new Date(Date.UTC(1899, 11, 30) + v * 86_400_000).toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
  if (m) {
    const year = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

/** CSV פשוט, עם תמיכה במרכאות */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') quoted = false; else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (c !== '\r') cur += c;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/**
 * קריאת קובץ גאנט (xlsx או csv) לרשימת שלבים עם תאריכים. מזהה את עמודות
 * השם, ההתחלה, הסיום והמשך לפי הכותרות; בלי כותרות — שם, התחלה, סיום לפי הסדר.
 */
export async function parseGanttFile({ fileName, data }) {
  const buffer = Buffer.from(data, 'base64');
  let table;
  if (/\.csv$/i.test(fileName)) {
    table = parseCsv(buffer.toString('utf8').replace(/^﻿/, ''));
  } else {
    const { default: ExcelJS } = await import('exceljs');
    const wb = new ExcelJS.Workbook();
    try {
      await wb.xlsx.load(buffer);
    } catch {
      throw new AppError('E_VALIDATION', 'לא הצלחנו לקרוא את הקובץ — יש לשמור אותו כ-xlsx או csv');
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new AppError('E_VALIDATION', 'בקובץ אין גיליונות');
    table = [];
    ws.eachRow({ includeEmpty: false }, (r) => {
      const values = [];
      r.eachCell({ includeEmpty: true }, (cell, col) => { values[col - 1] = cell.value; });
      table.push(values);
    });
  }

  // שורת הכותרות: הראשונה (מבין העשר הראשונות) שיש בה עמודת שם
  const norm = (v) => cellText(v).trim().toLowerCase();
  const find = (row, keys) => row.findIndex((v) => {
    const t = norm(v);
    // מילה קצרה (שם, עד, to) — רק כמילה שלמה, כדי ש"עד" לא יתפוס את "עדכון"
    const words = t.split(/[\s/_-]+/);
    return t && keys.some((k) => (k.length <= 3 ? words.includes(k) : t.includes(k)));
  });
  let headerAt = -1;
  let cols = { title: 0, start: 1, due: 2, days: -1 };
  for (let i = 0; i < Math.min(10, table.length); i++) {
    const row = table[i] ?? [];
    const title = find(row, HEADERS.title);
    const start = find(row, HEADERS.start);
    if (title >= 0 && (start >= 0 || find(row, HEADERS.days) >= 0)) {
      headerAt = i;
      cols = { title, start, due: find(row, HEADERS.due), days: find(row, HEADERS.days) };
      break;
    }
  }

  const rows = [];
  const warnings = [];
  let cursor = null;
  for (const [i, raw] of table.slice(headerAt + 1).entries()) {
    const row = raw ?? [];
    const title = cellText(row[cols.title]).trim();
    if (!title) continue;
    let startOn = cols.start >= 0 ? parseDate(row[cols.start]) : null;
    let dueOn = cols.due >= 0 ? parseDate(row[cols.due]) : null;
    const days = cols.days >= 0 ? Number.parseInt(cellText(row[cols.days]), 10) : NaN;
    if (!startOn && cursor) startOn = cursor;
    if (startOn && !dueOn && Number.isFinite(days) && days > 0) dueOn = addDays(startOn, days - 1);
    if (startOn && !dueOn) dueOn = startOn;
    if (!startOn) {
      warnings.push(`שורה ${headerAt + i + 2}: "${title}" — אין תאריך התחלה`);
      continue;
    }
    if (dueOn < startOn) [startOn, dueOn] = [dueOn, startOn];
    rows.push({ title: title.slice(0, 200), startOn, dueOn });
    cursor = addDays(dueOn, 1);
    if (rows.length >= 60) {
      warnings.push('נטענו 60 השלבים הראשונים בלבד');
      break;
    }
  }
  if (!rows.length) throw new AppError('E_VALIDATION', 'לא נמצאו בקובץ שלבים עם תאריכים');
  return { rows, warnings };
}

/**
 * שמירת הגאנט הכללי כתבנית עם תאריכים, ושיוך עובדים אליו: כל עובד מקבל את
 * השלבים בדיוק בתאריכים שבגאנט. עובד שכבר שויך לתבנית לא יקבל שלבים כפולים.
 */
export async function importGantt(actor, { name, rows, userIds, trackId }) {
  const ids = scopeIds(actor);
  if (ids && userIds.some((u) => !ids.includes(u))) {
    throw new AppError('E_FORBIDDEN', 'חלק מהעובדים אינם באחריותך');
  }
  const created = await withTransaction({ actorId: actor.userId }, async (tx) => {
    if (trackId) return trackId;
    const startOn = rows.reduce((m, r) => (r.startOn < m ? r.startOn : m), rows[0].startOn);
    const [track] = await tx.query(
      `insert into training_tracks (name, description, start_on) values ($1, $2, $3) returning id`,
      [name, 'גאנט כללי שנטען מקובץ', startOn],
    );
    const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);
    for (const [index, r] of rows.entries()) {
      await tx.query(
        `insert into training_track_items (track_id, title, duration_days, offset_days, display_order)
         values ($1, $2, $3, $4, $5)`,
        [track.id, r.title, days(r.startOn, r.dueOn) + 1, days(startOn, r.startOn), (index + 1) * 10],
      );
    }
    return track.id;
  });

  const [track] = await query('select start_on from training_tracks where id = $1', [created]);
  let items = 0;
  for (const userId of userIds) {
    const out = await applyTrack(actor, userId, { trackId: created, startOn: track?.start_on ?? today() });
    items += out.created;
  }
  return { trackId: created, people: userIds.length, created: items };
}
