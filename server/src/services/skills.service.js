import ExcelJS from 'exceljs';
import { query, withTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { notify } from '../notifications/service.js';

/**
 * סקילומטר.
 *
 * מנהל ההטמעה בונה: נושאי ידע לכל תחום, רשימת משתמשי הקצה של האתר, וסבבים —
 * כל סבב עם הנושאים שנכללים בו. בזמן שסבב פתוח, כל מטמיע מדרג את משתמשי
 * הקצה שבתחומים שלו, 1–4, ומוסיף הערה לכל משתמש.
 *
 * מטמיע רואה ועורך רק את התחומים (ותתי-התחומים) שלו. מנהל רואה הכול.
 */

const isManager = (p) => p.baseRole === 'manager';
const NO_SUB = '00000000-0000-0000-0000-000000000000';

/** התחומים שהמשתמש רשאי לדרג בהם. null = כולם */
function domainFilter(principal) {
  if (isManager(principal)) return null;
  const ids = principal.scopes.domainIds ?? [];
  if (ids.length === 0 && principal.baseRole === 'mentor') return null;
  return ids;
}

/** תתי-התחומים של המשתמש בתחום — ריק פירושו "כל התחום" */
function subFilter(principal) {
  if (isManager(principal)) return null;
  return principal.scopes.subCategoryIds ?? [];
}

/* ───────────────────────── נושאים ───────────────────────── */

export async function listTopics({ domainId } = {}) {
  return query(
    `select t.id, t.domain_id, d.name as domain_name, t.sub_category_id, sc.name as sub_category_name,
            t.name, t.description, t.display_order, t.is_active, t.row_version
       from skill_topics t
       join domains d on d.id = t.domain_id
       left join sub_categories sc on sc.id = t.sub_category_id
      where t.deleted_at is null and ($1::uuid is null or t.domain_id = $1)
      order by d.display_order, d.name, sc.name nulls first, t.display_order, t.name`,
    [domainId ?? null],
  );
}

export async function saveTopic(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    if (input.id) {
      const [row] = await tx.query(
        `update skill_topics set name = coalesce($2, name), description = $3,
                sub_category_id = $4, is_active = coalesce($5, is_active),
                display_order = coalesce($6, display_order)
          where id = $1 and deleted_at is null returning *`,
        [input.id, input.name ?? null, input.description ?? null, input.subCategoryId ?? null,
         input.isActive ?? null, input.displayOrder ?? null],
      );
      if (!row) throw new AppError('E_NOT_FOUND', 'הנושא המבוקש לא נמצא');
      return row;
    }
    const [row] = await tx.query(
      `insert into skill_topics (domain_id, sub_category_id, name, description, display_order)
       values ($1, $2, $3, $4,
               coalesce($5, (select coalesce(max(display_order), 0) + 10 from skill_topics where domain_id = $1)))
       returning *`,
      [input.domainId, input.subCategoryId ?? null, input.name, input.description ?? null, input.displayOrder ?? null],
    );
    return row;
  });
}

/** ייבוא רשימת נושאים מודבקת (שורה לכל נושא). נושא שקיים מדולג. */
export async function importTopics(actor, { domainId, subCategoryId, names }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let added = 0;
    for (const raw of names) {
      const name = raw.trim();
      if (!name) continue;
      const [row] = await tx.query(
        `insert into skill_topics (domain_id, sub_category_id, name, display_order)
         select $1, $2, $3, (select coalesce(max(display_order), 0) + 10 from skill_topics where domain_id = $1)
          where not exists (select 1 from skill_topics where domain_id = $1 and deleted_at is null
                              and coalesce(sub_category_id, $4::uuid) = coalesce($2::uuid, $4::uuid) and name = $3)
         returning id`,
        [domainId, subCategoryId ?? null, name, NO_SUB],
      );
      if (row) added += 1;
    }
    return { added, skipped: names.filter((n) => n.trim()).length - added };
  });
}

export async function deleteTopic(actor, topicId) {
  await query('update skill_topics set deleted_at = now(), deleted_by = $2 where id = $1', [topicId, actor.userId]);
  return { removed: topicId };
}

/* ───────────────────────── משתמשי קצה ───────────────────────── */

export async function listEndUsers({ siteId, domainId }) {
  return query(
    `select eu.id, eu.site_id, eu.full_name, eu.employee_no, eu.department, eu.role_title,
            eu.domain_id, d.name as domain_name, eu.sub_category_id, sc.name as sub_category_name,
            eu.is_active, eu.row_version
       from end_users eu
       left join domains d on d.id = eu.domain_id
       left join sub_categories sc on sc.id = eu.sub_category_id
      where eu.deleted_at is null and eu.site_id = $1 and ($2::uuid is null or eu.domain_id = $2)
      order by d.name nulls last, eu.full_name`,
    [siteId, domainId ?? null],
  );
}

/**
 * ייבוא משתמשי קצה מהדבקה מאקסל. התחום ותת-התחום מזוהים לפי שם.
 * dryRun מחזיר תצוגה מקדימה עם שגיאה לכל שורה, בלי לשמור.
 * משתמש עם מספר עובד שכבר קיים באתר — מתעדכן, לא משוכפל.
 */
export async function importEndUsers(actor, siteId, rows, { dryRun = false } = {}) {
  const domains = await query(
    `select d.id, d.name, coalesce(json_agg(json_build_object('id', sc.id, 'name', sc.name))
              filter (where sc.id is not null), '[]') as subs
       from domains d left join sub_categories sc on sc.domain_id = d.id and sc.deleted_at is null
      where d.deleted_at is null group by d.id`,
  );
  const byName = new Map(domains.map((d) => [d.name.trim(), d]));

  const preview = rows.map((r, i) => {
    const errors = [];
    const fullName = (r.fullName ?? '').trim();
    if (!fullName) errors.push('חסר שם');
    const domain = r.domainName ? byName.get(r.domainName.trim()) : null;
    if (r.domainName && !domain) errors.push(`התחום "${r.domainName}" לא קיים`);
    const sub = domain && r.subCategoryName
      ? domain.subs.find((s) => s.name.trim() === r.subCategoryName.trim())
      : null;
    if (domain && r.subCategoryName && !sub) errors.push(`תת-התחום "${r.subCategoryName}" לא קיים ב${domain.name}`);
    return {
      line: i + 1,
      fullName,
      employeeNo: r.employeeNo?.trim() || null,
      department: r.department?.trim() || null,
      roleTitle: r.roleTitle?.trim() || null,
      domainId: domain?.id ?? null,
      domainName: domain?.name ?? r.domainName ?? null,
      subCategoryId: sub?.id ?? null,
      subCategoryName: sub?.name ?? r.subCategoryName ?? null,
      errors,
    };
  });

  const valid = preview.filter((p) => p.errors.length === 0);
  if (dryRun) return { preview, valid: valid.length, invalid: preview.length - valid.length };

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let created = 0;
    let updated = 0;
    for (const p of valid) {
      const [existing] = p.employeeNo
        ? await tx.query(
            'select id from end_users where site_id = $1 and employee_no = $2 and deleted_at is null',
            [siteId, p.employeeNo],
          )
        : [];
      if (existing) {
        await tx.query(
          `update end_users set full_name = $2, department = $3, role_title = $4,
                  domain_id = $5, sub_category_id = $6, is_active = true where id = $1`,
          [existing.id, p.fullName, p.department, p.roleTitle, p.domainId, p.subCategoryId],
        );
        updated += 1;
      } else {
        await tx.query(
          `insert into end_users (site_id, full_name, employee_no, department, role_title, domain_id, sub_category_id)
           values ($1, $2, $3, $4, $5, $6, $7)`,
          [siteId, p.fullName, p.employeeNo, p.department, p.roleTitle, p.domainId, p.subCategoryId],
        );
        created += 1;
      }
    }
    return { created, updated, skipped: preview.length - valid.length };
  });
}

export async function saveEndUser(actor, siteId, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    if (input.id) {
      const [row] = await tx.query(
        `update end_users set full_name = coalesce($3, full_name), employee_no = $4, department = $5,
                role_title = $6, domain_id = $7, sub_category_id = $8, is_active = coalesce($9, is_active)
          where id = $1 and site_id = $2 and deleted_at is null returning *`,
        [input.id, siteId, input.fullName ?? null, input.employeeNo ?? null, input.department ?? null,
         input.roleTitle ?? null, input.domainId ?? null, input.subCategoryId ?? null, input.isActive ?? null],
      );
      if (!row) throw new AppError('E_NOT_FOUND', 'משתמש הקצה המבוקש לא נמצא');
      return row;
    }
    const [row] = await tx.query(
      `insert into end_users (site_id, full_name, employee_no, department, role_title, domain_id, sub_category_id)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [siteId, input.fullName, input.employeeNo ?? null, input.department ?? null, input.roleTitle ?? null,
       input.domainId ?? null, input.subCategoryId ?? null],
    );
    return row;
  });
}

/* ───────────────────────── סבבים ───────────────────────── */

export async function listRounds({ siteId }) {
  return query(
    `select r.id, r.site_id, r.name, r.round_no, r.opens_on, r.closes_on, r.status, r.row_version,
            array(select topic_id from skill_round_topics where round_id = r.id) as topic_ids,
            (select count(*)::int from skill_scores s where s.round_id = r.id) as score_count
       from skill_rounds r
      where r.deleted_at is null and r.site_id = $1
      order by r.round_no desc, r.created_at desc`,
    [siteId],
  );
}

export async function getRound(roundId) {
  const [row] = await query('select * from skill_rounds where id = $1 and deleted_at is null', [roundId]);
  if (!row) throw new AppError('E_NOT_FOUND', 'הסבב המבוקש לא נמצא');
  return row;
}

export async function saveRound(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let round;
    let wasOpen = false;
    if (input.id) {
      const [before] = await tx.query('select status from skill_rounds where id = $1', [input.id]);
      wasOpen = before?.status === 'open';
      [round] = await tx.query(
        `update skill_rounds set name = coalesce($2, name), opens_on = $3, closes_on = $4,
                status = coalesce($5, status)
          where id = $1 and deleted_at is null returning *`,
        [input.id, input.name ?? null, input.opensOn ?? null, input.closesOn ?? null, input.status ?? null],
      );
      if (!round) throw new AppError('E_NOT_FOUND', 'הסבב המבוקש לא נמצא');
    } else {
      [round] = await tx.query(
        `insert into skill_rounds (site_id, name, round_no, opens_on, closes_on, status)
         values ($1, $2,
                 (select coalesce(max(round_no), 0) + 1 from skill_rounds where site_id = $1 and deleted_at is null),
                 $3, $4, coalesce($5, 'draft'))
         returning *`,
        [input.siteId, input.name, input.opensOn ?? null, input.closesOn ?? null, input.status ?? null],
      );
    }

    if (input.topicIds) {
      await tx.query('delete from skill_round_topics where round_id = $1', [round.id]);
      for (const topicId of new Set(input.topicIds)) {
        await tx.query('insert into skill_round_topics (round_id, topic_id) values ($1, $2)', [round.id, topicId]);
      }
    }

    // פתיחת סבב — המטמיעים באתר מקבלים התראה
    if (round.status === 'open' && !wasOpen) {
      const people = await tx.query(
        `select sa.user_id from site_assignments sa
           join profiles p on p.id = sa.user_id and p.status = 'active'
          where sa.site_id = $1 and sa.deleted_at is null and sa.span @> current_date`,
        [round.site_id],
      );
      await notify(tx, {
        typeCode: 'skill_round_opened',
        recipientIds: people.map((p) => p.user_id),
        title: `נפתח סבב סקילומטר: ${round.name}`,
        body: 'אפשר להתחיל לדרג את משתמשי הקצה בתחומים שלך',
        entityType: 'skill_rounds',
        entityId: round.id,
      });
    }
    return round;
  });
}

/* ───────────────────────── הטבלה: משתמשים × נושאים ───────────────────────── */

export async function sheet(principal, roundId, { domainId } = {}) {
  const round = await getRound(roundId);
  const domains = domainFilter(principal);
  const subs = subFilter(principal);

  const [topics, users, scores, notes, availableDomains] = await Promise.all([
    query(
      `select t.id, t.domain_id, t.sub_category_id, t.name, t.description
         from skill_round_topics rt join skill_topics t on t.id = rt.topic_id and t.deleted_at is null
        where rt.round_id = $1
          and ($2::uuid is null or t.domain_id = $2)
          and ($3::uuid[] is null or t.domain_id = any($3))
          and ($4::uuid[] is null or t.sub_category_id is null or cardinality($4) = 0 or t.sub_category_id = any($4)
               or not exists (select 1 from sub_categories sc where sc.id = any($4) and sc.domain_id = t.domain_id))
        order by t.display_order, t.name`,
      [roundId, domainId ?? null, domains, subs],
    ),
    query(
      `select eu.id, eu.full_name, eu.employee_no, eu.department, eu.role_title,
              eu.domain_id, d.name as domain_name, eu.sub_category_id, sc.name as sub_category_name
         from end_users eu
         left join domains d on d.id = eu.domain_id
         left join sub_categories sc on sc.id = eu.sub_category_id
        where eu.site_id = $1 and eu.deleted_at is null and eu.is_active
          and ($2::uuid is null or eu.domain_id = $2)
          and ($3::uuid[] is null or eu.domain_id = any($3))
          and ($4::uuid[] is null or eu.sub_category_id is null or cardinality($4) = 0 or eu.sub_category_id = any($4)
               or not exists (select 1 from sub_categories x where x.id = any($4) and x.domain_id = eu.domain_id))
        order by eu.full_name`,
      [round.site_id, domainId ?? null, domains, subs],
    ),
    query(
      `select s.end_user_id, s.topic_id, s.score, s.rated_at, p.full_name as rated_by_name
         from skill_scores s left join profiles p on p.id = s.rated_by where s.round_id = $1`,
      [roundId],
    ),
    query(
      `select n.end_user_id, n.note, n.updated_at, p.full_name as updated_by_name
         from skill_user_notes n left join profiles p on p.id = n.updated_by where n.round_id = $1`,
      [roundId],
    ),
    query(
      `select distinct d.id, d.name, d.display_order
         from skill_round_topics rt
         join skill_topics t on t.id = rt.topic_id and t.deleted_at is null
         join domains d on d.id = t.domain_id
        where rt.round_id = $1 and ($2::uuid[] is null or d.id = any($2))
        order by d.display_order, d.name`,
      [roundId, domains],
    ),
  ]);

  const userIds = new Set(users.map((u) => u.id));
  const topicIds = new Set(topics.map((t) => t.id));
  const visibleScores = scores.filter((s) => userIds.has(s.end_user_id) && topicIds.has(s.topic_id));

  // תא רלוונטי = נושא באותו תחום של המשתמש (ובתת-התחום שלו, אם לנושא יש תת-תחום)
  const relevant = (u, t) => t.domain_id === u.domain_id && (!t.sub_category_id || t.sub_category_id === u.sub_category_id);
  let total = 0;
  for (const u of users) for (const t of topics) if (relevant(u, t)) total += 1;

  return {
    round,
    domains: availableDomains,
    topics,
    users,
    scores: visibleScores,
    notes: notes.filter((n) => userIds.has(n.end_user_id)),
    progress: { filled: visibleScores.length, total },
    canEdit: round.status === 'open',
  };
}

/** שמירת ציונים. score = null מוחק את הציון. */
export async function saveScores(actor, roundId, items) {
  const round = await getRound(roundId);
  if (round.status !== 'open') throw new AppError('E_STATE', 'הסבב אינו פתוח לעדכון');

  const domains = domainFilter(actor);
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    let saved = 0;
    for (const item of items) {
      const [ok] = await tx.query(
        `select eu.id from end_users eu
           join skill_round_topics rt on rt.round_id = $3 and rt.topic_id = $2
           join skill_topics t on t.id = rt.topic_id and t.domain_id = eu.domain_id
          where eu.id = $1 and eu.site_id = $4 and eu.deleted_at is null
            and ($5::uuid[] is null or eu.domain_id = any($5))`,
        [item.endUserId, item.topicId, roundId, round.site_id, domains],
      );
      if (!ok) throw new AppError('E_FORBIDDEN', 'אפשר לדרג רק משתמשים ונושאים בתחומים שלך');

      if (item.score == null) {
        await tx.query(
          'delete from skill_scores where round_id = $1 and end_user_id = $2 and topic_id = $3',
          [roundId, item.endUserId, item.topicId],
        );
      } else {
        await tx.query(
          `insert into skill_scores (round_id, end_user_id, topic_id, score, rated_by)
           values ($1, $2, $3, $4, $5)
           on conflict (round_id, end_user_id, topic_id)
           do update set score = excluded.score, rated_by = excluded.rated_by, rated_at = now()`,
          [roundId, item.endUserId, item.topicId, item.score, actor.userId],
        );
      }
      saved += 1;
    }
    return { saved };
  });
}

export async function saveNote(actor, roundId, endUserId, note) {
  const round = await getRound(roundId);
  if (round.status !== 'open') throw new AppError('E_STATE', 'הסבב אינו פתוח לעדכון');
  const domains = domainFilter(actor);
  const [eu] = await query(
    `select id from end_users where id = $1 and site_id = $2 and deleted_at is null
        and ($3::uuid[] is null or domain_id = any($3))`,
    [endUserId, round.site_id, domains],
  );
  if (!eu) throw new AppError('E_FORBIDDEN', 'אפשר להעיר רק על משתמשים בתחומים שלך');

  if (!note?.trim()) {
    await query('delete from skill_user_notes where round_id = $1 and end_user_id = $2', [roundId, endUserId]);
    return { note: null };
  }
  const [row] = await query(
    `insert into skill_user_notes (round_id, end_user_id, note, updated_by) values ($1, $2, $3, $4)
     on conflict (round_id, end_user_id)
     do update set note = excluded.note, updated_by = excluded.updated_by, updated_at = now()
     returning note, updated_at`,
    [roundId, endUserId, note.trim(), actor.userId],
  );
  return row;
}

/* ───────────────────────── סיכום לדשבורד ───────────────────────── */

export async function summary({ siteId, roundId }) {
  const rounds = await query(
    `select id, name, round_no, status from skill_rounds
      where site_id = $1 and deleted_at is null order by round_no desc`,
    [siteId],
  );
  const round = roundId ? rounds.find((r) => r.id === roundId) : (rounds.find((r) => r.status === 'open') ?? rounds[0]);
  if (!round) return { round: null, rounds };
  const previous = rounds.find((r) => r.round_no < round.round_no);

  const managerView = { baseRole: 'manager', scopes: {} };
  const s = await sheet(managerView, round.id);

  const people = await query(
    `select v.end_user_id, v.full_name, v.domain_name, v.department, v.avg_score, v.rated_count, v.min_score,
            prev.avg_score as prev_avg,
            (select t.name from skill_scores sc join skill_topics t on t.id = sc.topic_id
              where sc.round_id = v.round_id and sc.end_user_id = v.end_user_id
              order by sc.score, t.display_order limit 1) as weakest_topic
       from v_skill_summary v
       left join v_skill_summary prev on prev.round_id = $2 and prev.end_user_id = v.end_user_id
      where v.round_id = $1`,
    [round.id, previous?.id ?? null],
  );

  const byDomain = new Map();
  for (const p of people) {
    const key = p.domain_name ?? 'ללא תחום';
    const d = byDomain.get(key) ?? { domain: key, sum: 0, n: 0 };
    d.sum += Number(p.avg_score);
    d.n += 1;
    byDomain.set(key, d);
  }

  const sorted = [...people].sort((a, b) => b.avg_score - a.avg_score);
  return {
    round,
    previousRound: previous ?? null,
    rounds,
    completion: s.progress.total ? Math.round((s.progress.filled / s.progress.total) * 100) : 0,
    progress: s.progress,
    domains: [...byDomain.values()].map((d) => ({ domain: d.domain, avg: Math.round((d.sum / d.n) * 100) / 100, users: d.n })),
    // מובילים: ממוצע 3 ומעלה
    top: sorted.filter((p) => Number(p.avg_score) >= 3).slice(0, 10),
    // זקוקים לחיזוק: ממוצע 2 ומטה, או ציון 1 בנושא כלשהו
    struggling: [...people]
      .filter((p) => Number(p.avg_score) <= 2 || p.min_score === 1)
      .sort((a, b) => a.avg_score - b.avg_score)
      .slice(0, 10),
  };
}

/* ───────────────────────── ייצוא לאקסל ───────────────────────── */

const SCORE_FILL = { 1: 'FFFFD6D6', 2: 'FFFFE5C2', 3: 'FFFFF6C2', 4: 'FFD7F5DD' };

function addDomainSheet(wb, name, topics, users, scoreMap, noteMap) {
  const ws = wb.addWorksheet(name.slice(0, 31).replace(/[\\/?*[\]:]/g, ' '), {
    views: [{ rightToLeft: true, state: 'frozen', xSplit: 3, ySplit: 1 }],
  });
  ws.columns = [
    { header: 'שם', key: 'name', width: 24 },
    { header: 'מספר עובד', key: 'no', width: 12 },
    { header: 'מחלקה', key: 'dept', width: 16 },
    ...topics.map((t) => ({ header: t.name, key: t.id, width: Math.max(10, Math.min(28, t.name.length + 2)) })),
    { header: 'ממוצע', key: 'avg', width: 9 },
    { header: 'הערות', key: 'note', width: 40 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.getRow(1).alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' };

  for (const u of users) {
    const values = { name: u.full_name, no: u.employee_no ?? '', dept: u.department ?? '' };
    const scored = [];
    for (const t of topics) {
      const v = scoreMap.get(`${u.id}|${t.id}`);
      values[t.id] = v ?? '';
      if (v) scored.push(v);
    }
    values.avg = scored.length ? Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 100) / 100 : '';
    values.note = noteMap.get(u.id) ?? '';
    const row = ws.addRow(values);
    topics.forEach((t, i) => {
      const v = scoreMap.get(`${u.id}|${t.id}`);
      const cell = row.getCell(4 + i);
      cell.alignment = { horizontal: 'center' };
      if (v) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SCORE_FILL[v] } };
    });
    row.getCell(ws.columns.length).alignment = { wrapText: true };
  }
  return ws;
}

/** קובץ לתחום אחד, או קובץ מלא — גיליון סיכום וגיליון לכל תחום */
export async function exportWorkbook(roundId, { domainId } = {}) {
  const managerView = { baseRole: 'manager', scopes: {} };
  const s = await sheet(managerView, roundId, { domainId });
  const scoreMap = new Map(s.scores.map((x) => [`${x.end_user_id}|${x.topic_id}`, x.score]));
  const noteMap = new Map(s.notes.map((n) => [n.end_user_id, n.note]));

  const wb = new ExcelJS.Workbook();
  wb.creator = 'המטמיעון';
  wb.created = new Date();

  const domains = domainId ? s.domains.filter((d) => d.id === domainId) : s.domains;

  if (!domainId) {
    const ws = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true }] });
    ws.columns = [
      { header: 'תחום', key: 'domain', width: 24 },
      { header: 'משתמשים', key: 'users', width: 12 },
      { header: 'תאים שמולאו', key: 'filled', width: 14 },
      { header: 'ממוצע', key: 'avg', width: 10 },
    ];
    ws.getRow(1).font = { bold: true };
    for (const d of domains) {
      const users = s.users.filter((u) => u.domain_id === d.id);
      const ids = new Set(users.map((u) => u.id));
      const sc = s.scores.filter((x) => ids.has(x.end_user_id));
      ws.addRow({
        domain: d.name,
        users: users.length,
        filled: sc.length,
        avg: sc.length ? Math.round((sc.reduce((a, b) => a + b.score, 0) / sc.length) * 100) / 100 : '',
      });
    }
  }

  for (const d of domains) {
    const topics = s.topics.filter((t) => t.domain_id === d.id);
    const users = s.users.filter((u) => u.domain_id === d.id);
    addDomainSheet(wb, d.name, topics, users, scoreMap, noteMap);
  }

  const name = `סקילומטר - ${s.round.name}${domainId ? ` - ${domains[0]?.name ?? ''}` : ''}.xlsx`;
  return { buffer: await wb.xlsx.writeBuffer(), filename: name };
}
