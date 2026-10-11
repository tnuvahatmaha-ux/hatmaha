import { query, withTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { notify } from '../notifications/service.js';

/**
 * צ׳אט קבוצתי.
 *
 * קבוצה לפי תחום / תת-תחום / אתר מקבלת את חבריה מהשיוכים (app.sync_group_members),
 * וקבוצה חופשית — מהבחירה של מי שיצר אותה. הלקוח מרענן כל כמה שניות עם
 * `after` = מזהה ההודעה האחרונה שראה, ולכן כל רענון מחזיר רק את מה שחדש.
 *
 * התראה על הודעה חדשה נשלחת פעם אחת לכל נמען לכל קבוצה עד שיקרא (dedupe),
 * כדי שצ׳אט פעיל לא יציף את מסך ההתראות.
 */

const isManager = (p) => p.baseRole === 'manager';

async function requireMember(run, groupId, userId) {
  const [row] = await run(
    `select g.*, m.role as my_role, m.last_read_at
       from chat_groups g
       join chat_group_members m on m.group_id = g.id and m.user_id = $2
      where g.id = $1 and g.deleted_at is null`,
    [groupId, userId],
  );
  if (!row) throw new AppError('E_NOT_FOUND', 'הקבוצה המבוקשת לא נמצאה');
  return row;
}

export async function listGroups(principal) {
  // סנכרון קל: קבוצות נגזרות שהמשתמש אמור להיות בהן ועוד לא נוסף אליהן
  await withTransaction({ actorId: principal.userId }, async (tx) => {
    const derived = await tx.query(
      `select id from chat_groups where kind <> 'custom' and deleted_at is null and not is_archived`,
    );
    for (const g of derived) await tx.query('select app.sync_group_members($1)', [g.id]);
  });

  return query(
    `select g.id, g.name, g.kind, g.site_id, g.domain_id, g.sub_category_id, g.is_archived,
            m.role as my_role,
            (select count(*)::int from chat_group_members x where x.group_id = g.id) as member_count,
            (select count(*)::int from chat_messages cm
              where cm.group_id = g.id and cm.deleted_at is null and cm.author_user_id <> $1
                and cm.created_at > coalesce(m.last_read_at, '-infinity')) as unread,
            last.body as last_body, last.created_at as last_at, last.author_name as last_author
       from chat_groups g
       join chat_group_members m on m.group_id = g.id and m.user_id = $1
       left join lateral (
         select cm.body, cm.created_at, p.full_name as author_name
           from chat_messages cm join profiles p on p.id = cm.author_user_id
          where cm.group_id = g.id and cm.deleted_at is null
          order by cm.id desc limit 1) last on true
      where g.deleted_at is null and not g.is_archived
      order by coalesce(last.created_at, g.created_at) desc`,
    [principal.userId],
  );
}

export async function createGroup(actor, input) {
  if (input.kind !== 'custom' && !isManager(actor)) {
    const column = { domain: 'domain_id', sub_category: 'sub_category_id', site: 'site_id' }[input.kind];
    const target = { domain: input.domainId, sub_category: input.subCategoryId, site: input.siteId }[input.kind];
    const [cover] = await query(
      `select count(*)::int as n from mentor_responsibilities
        where mentor_user_id = $1 and deleted_at is null and span @> current_date
          and (${column} = $2 or ${column} is null)`,
      [actor.userId, target],
    );
    if (!cover.n) throw new AppError('E_FORBIDDEN', 'אפשר לפתוח קבוצה רק לתחום או לאתר שבאחריותך');
  }

  if (input.kind === 'custom' && !isManager(actor)) {
    const allowed = new Set(actor.scopes.assignedUserIds);
    const outside = (input.memberIds ?? []).filter((id) => !allowed.has(id));
    if (outside.length) throw new AppError('E_FORBIDDEN', 'אפשר להוסיף לקבוצה רק מטמיעים שמשויכים אליך');
  }

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [g] = await tx.query(
      `insert into chat_groups (name, kind, site_id, domain_id, sub_category_id, created_by)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [input.name, input.kind, input.kind === 'site' ? input.siteId : null,
       input.kind === 'domain' ? input.domainId : null,
       input.kind === 'sub_category' ? input.subCategoryId : null, actor.userId],
    );
    await tx.query(
      `insert into chat_group_members (group_id, user_id, role) values ($1, $2, 'owner')`,
      [g.id, actor.userId],
    );
    if (input.kind === 'custom') {
      for (const id of new Set(input.memberIds ?? [])) {
        if (id === actor.userId) continue;
        await tx.query(
          'insert into chat_group_members (group_id, user_id) values ($1, $2) on conflict do nothing',
          [g.id, id],
        );
      }
    } else {
      await tx.query('select app.sync_group_members($1)', [g.id]);
    }
    return g;
  });
}

export async function updateGroup(actor, groupId, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const g = await requireMember(tx.query, groupId, actor.userId);
    if (g.my_role !== 'owner' && !isManager(actor)) {
      throw new AppError('E_FORBIDDEN', 'רק מי שפתח את הקבוצה יכול לערוך אותה');
    }
    await tx.query(
      `update chat_groups set name = coalesce($2, name), is_archived = coalesce($3, is_archived)
        where id = $1`,
      [groupId, input.name ?? null, input.isArchived ?? null],
    );
    if (g.kind === 'custom') {
      for (const id of input.addMemberIds ?? []) {
        await tx.query(
          'insert into chat_group_members (group_id, user_id) values ($1, $2) on conflict do nothing',
          [groupId, id],
        );
      }
      for (const id of input.removeMemberIds ?? []) {
        if (id === g.created_by) continue;
        await tx.query('delete from chat_group_members where group_id = $1 and user_id = $2', [groupId, id]);
      }
    }
    return { id: groupId };
  });
}

export async function members(principal, groupId) {
  await requireMember(query, groupId, principal.userId);
  return query(
    `select p.id, p.full_name, p.base_role::text as base_role, m.role
       from chat_group_members m join profiles p on p.id = m.user_id
      where m.group_id = $1 order by m.role = 'owner' desc, p.full_name`,
    [groupId],
  );
}

export async function messages(principal, groupId, { after, limit = 100 }) {
  const group = await requireMember(query, groupId, principal.userId);
  const rows = await query(
    `select * from (
       select cm.id, cm.body, cm.created_at, cm.author_user_id, p.full_name as author_name
         from chat_messages cm join profiles p on p.id = cm.author_user_id
        where cm.group_id = $1 and cm.deleted_at is null and ($2::bigint is null or cm.id > $2)
        order by cm.id desc limit $3) t
      order by id`,
    [groupId, after ?? null, limit],
  );
  return { group: { id: group.id, name: group.name, kind: group.kind, myRole: group.my_role }, messages: rows };
}

export async function send(actor, groupId, body) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const group = await requireMember(tx.query, groupId, actor.userId);
    if (group.is_archived) throw new AppError('E_STATE', 'הקבוצה בארכיון');

    const [row] = await tx.query(
      `insert into chat_messages (group_id, author_user_id, body) values ($1, $2, $3)
       returning id, body, created_at, author_user_id`,
      [groupId, actor.userId, body],
    );
    await tx.query(
      'update chat_group_members set last_read_at = now() where group_id = $1 and user_id = $2',
      [groupId, actor.userId],
    );

    // התראה אחת לקבוצה למי שעוד לא קרא — לא אחת לכל הודעה
    const others = await tx.query(
      `select m.user_id from chat_group_members m
        where m.group_id = $1 and m.user_id <> $2
          and not exists (select 1 from notifications n
                           where n.recipient_user_id = m.user_id and n.type_code = 'chat_message'
                             and n.entity_id = $1 and n.read_at is null)`,
      [groupId, actor.userId],
    );
    await notify(tx, {
      typeCode: 'chat_message',
      recipientIds: others.map((o) => o.user_id),
      title: `הודעה חדשה בקבוצה ${group.name}`,
      body: `${actor.fullName}: ${body.slice(0, 120)}`,
      entityType: 'chat_groups',
      entityId: groupId,
    });

    return { ...row, author_name: actor.fullName };
  });
}

export async function markRead(principal, groupId) {
  await requireMember(query, groupId, principal.userId);
  await query(
    'update chat_group_members set last_read_at = now() where group_id = $1 and user_id = $2',
    [groupId, principal.userId],
  );
  await query(
    `update notifications set read_at = now()
      where recipient_user_id = $1 and type_code = 'chat_message' and entity_id = $2 and read_at is null`,
    [principal.userId, groupId],
  );
  return { ok: true };
}
