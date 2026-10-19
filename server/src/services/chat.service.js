import { query, withTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { randomUUID } from 'node:crypto';
import { notify } from '../notifications/service.js';
import { signUpload, signDownload, storageEnabled, MAX_FILE_BYTES } from '../lib/storage.js';

/**
 * צ׳אט קבוצתי.
 *
 * קבוצה לפי תחום / תת-תחום / אתר מקבלת את חבריה מהשיוכים (app.sync_group_members),
 * וקבוצה חופשית — מהבחירה של מי שיצר אותה. הלקוח מרענן כל כמה שניות עם
 * `after` = מזהה ההודעה האחרונה שראה, ולכן כל רענון מחזיר רק את מה שחדש.
 *
 * התראה על הודעה חדשה נשלחת פעם אחת לכל נמען לכל קבוצה עד שיקרא (dedupe),
 * כדי שצ׳אט פעיל לא יציף את מסך ההתראות. הודעה שדורשת אישור קריאה שולחת
 * התראה משלה תמיד.
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
            (select count(*)::int from chat_messages cm
              where cm.group_id = g.id and cm.deleted_at is null and cm.requires_ack
                and cm.author_user_id <> $1
                and not exists (select 1 from chat_message_acks a
                                 where a.message_id = cm.id and a.user_id = $1)) as pending_ack,
            coalesce(nullif(last.body, ''), '📎 ' || last.file_name) as last_body, last.created_at as last_at, last.author_name as last_author
       from chat_groups g
       join chat_group_members m on m.group_id = g.id and m.user_id = $1
       left join lateral (
         select cm.body, cm.file_name, cm.created_at, p.full_name as author_name
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

/** מצב האישור של הודעה: כמה אישרו, מתוך כמה חברים (בלי השולח), והאם אני אישרתי */
const ACK_COLUMNS = `
  (select count(*)::int from chat_message_acks a where a.message_id = cm.id) as ack_count,
  (select count(*)::int from chat_group_members x
    where x.group_id = cm.group_id and x.user_id <> cm.author_user_id) as ack_total,
  exists (select 1 from chat_message_acks a
           where a.message_id = cm.id and a.user_id = $USER) as acked_by_me`;

export async function messages(principal, groupId, { after, limit = 100 }) {
  const group = await requireMember(query, groupId, principal.userId);
  const rows = await query(
    `select * from (
       select cm.id, cm.body, cm.created_at, cm.author_user_id, p.full_name as author_name,
              cm.requires_ack, cm.file_name, cm.mime_type, cm.size_bytes, ${ACK_COLUMNS.replaceAll('$USER', '$4')}
         from chat_messages cm join profiles p on p.id = cm.author_user_id
        where cm.group_id = $1 and cm.deleted_at is null and ($2::bigint is null or cm.id > $2)
        order by cm.id desc limit $3) t
      order by id`,
    [groupId, after ?? null, limit, principal.userId],
  );
  // הרענון מביא רק הודעות חדשות, ולכן מצב האישורים של הודעות קודמות נשלח בנפרד
  const acks = after
    ? await query(
        `select cm.id, ${ACK_COLUMNS.replaceAll('$USER', '$2')}
           from chat_messages cm
          where cm.group_id = $1 and cm.deleted_at is null and cm.requires_ack
          order by cm.id desc limit 100`,
        [groupId, principal.userId],
      )
    : [];
  return {
    group: { id: group.id, name: group.name, kind: group.kind, myRole: group.my_role, storageEnabled },
    messages: rows,
    acks,
  };
}

const safeName = (name) => name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || 'file';

/** קישור העלאה חתום לקובץ שיצורף להודעה. הקובץ עולה ישירות ל-Storage. */
export async function signFile(actor, groupId, { fileName, sizeBytes }) {
  if (sizeBytes > MAX_FILE_BYTES) throw new AppError('E_VALIDATION', 'הקובץ גדול מ-10MB');
  const group = await requireMember(query, groupId, actor.userId);
  if (group.is_archived) throw new AppError('E_STATE', 'הקבוצה בארכיון');
  const storagePath = `chat/${groupId}/${randomUUID()}-${safeName(fileName)}`;
  return { storagePath, ...(await signUpload(storagePath)) };
}

/** קישור הורדה זמני — לחברי הקבוצה בלבד */
export async function fileUrl(principal, groupId, messageId) {
  await requireMember(query, groupId, principal.userId);
  const [msg] = await query(
    `select storage_path, file_name from chat_messages
      where id = $1 and group_id = $2 and deleted_at is null and storage_path is not null`,
    [messageId, groupId],
  );
  if (!msg) throw new AppError('E_NOT_FOUND', 'הקובץ המבוקש לא נמצא');
  return { url: await signDownload(msg.storage_path, { fileName: msg.file_name }) };
}

export async function send(actor, groupId, body, { requiresAck = false, attachment = null } = {}) {
  if (attachment && !attachment.storagePath.startsWith(`chat/${groupId}/`)) {
    throw new AppError('E_VALIDATION', 'נתיב הקובץ אינו שייך לקבוצה הזו');
  }
  if (!body && !attachment) throw new AppError('E_VALIDATION', 'ההודעה ריקה');
  const preview = body ? body.slice(0, 120) : `📎 ${attachment.fileName}`;
  if (requiresAck && actor.baseRole === 'implementer') {
    throw new AppError('E_FORBIDDEN', 'מטמיע אינו יכול לבקש אישור קריאה');
  }
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const group = await requireMember(tx.query, groupId, actor.userId);
    if (group.is_archived) throw new AppError('E_STATE', 'הקבוצה בארכיון');

    const [row] = await tx.query(
      `insert into chat_messages
         (group_id, author_user_id, body, requires_ack, file_name, mime_type, size_bytes, storage_path)
       values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id, body, created_at, author_user_id, requires_ack, file_name, mime_type, size_bytes`,
      [groupId, actor.userId, body ?? '', requiresAck, attachment?.fileName ?? null,
       attachment?.mimeType ?? null, attachment?.sizeBytes ?? null, attachment?.storagePath ?? null],
    );

    if (requiresAck) {
      const members = await tx.query(
        'select user_id from chat_group_members where group_id = $1 and user_id <> $2',
        [groupId, actor.userId],
      );
      await notify(tx, {
        typeCode: 'chat_ack_required',
        recipientIds: members.map((m) => m.user_id),
        title: `נדרש אישור קריאה בקבוצה ${group.name}`,
        body: `${actor.fullName}: ${preview}`,
        entityType: 'chat_groups',
        entityId: groupId,
      });
      await tx.query(
        'update chat_group_members set last_read_at = now() where group_id = $1 and user_id = $2',
        [groupId, actor.userId],
      );
      return {
        ...row, author_name: actor.fullName,
        ack_count: 0, ack_total: members.length, acked_by_me: false,
      };
    }
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
      body: `${actor.fullName}: ${preview}`,
      entityType: 'chat_groups',
      entityId: groupId,
    });

    return { ...row, author_name: actor.fullName };
  });
}

export async function acknowledge(principal, groupId, messageId) {
  await requireMember(query, groupId, principal.userId);
  const [msg] = await query(
    `select id, author_user_id, requires_ack from chat_messages
      where id = $1 and group_id = $2 and deleted_at is null`,
    [messageId, groupId],
  );
  if (!msg) throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');
  if (!msg.requires_ack) throw new AppError('E_STATE', 'בהודעה הזו לא התבקש אישור קריאה');
  if (msg.author_user_id === principal.userId) throw new AppError('E_STATE', 'זו הודעה ששלחת');

  await query(
    `insert into chat_message_acks (message_id, user_id) values ($1, $2)
     on conflict do nothing`,
    [messageId, principal.userId],
  );
  // כשאין עוד הודעות שממתינות לאישורי, התראת האישור נסגרת
  await query(
    `update notifications set read_at = now()
      where recipient_user_id = $1 and type_code = 'chat_ack_required' and entity_id = $2
        and read_at is null
        and not exists (select 1 from chat_messages cm
                         where cm.group_id = $2 and cm.requires_ack and cm.deleted_at is null
                           and cm.author_user_id <> $1
                           and not exists (select 1 from chat_message_acks a
                                            where a.message_id = cm.id and a.user_id = $1))`,
    [principal.userId, groupId],
  );
  const [row] = await query(
    `select cm.id, ${ACK_COLUMNS.replaceAll('$USER', '$2')} from chat_messages cm where cm.id = $1`,
    [messageId, principal.userId],
  );
  return row;
}

/** מי אישר ומי עוד לא — לשולח ההודעה ולמנהלים */
export async function acks(principal, groupId, messageId) {
  await requireMember(query, groupId, principal.userId);
  const [msg] = await query(
    'select author_user_id from chat_messages where id = $1 and group_id = $2 and deleted_at is null',
    [messageId, groupId],
  );
  if (!msg) throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');
  if (msg.author_user_id !== principal.userId && !isManager(principal)) {
    throw new AppError('E_FORBIDDEN', 'רק מי ששלח את ההודעה רואה מי אישר אותה');
  }
  return query(
    `select p.id, p.full_name, a.acknowledged_at
       from chat_group_members m
       join profiles p on p.id = m.user_id
       left join chat_message_acks a on a.message_id = $1 and a.user_id = m.user_id
      where m.group_id = $2 and m.user_id <> $3
      order by a.acknowledged_at nulls first, p.full_name`,
    [messageId, groupId, msg.author_user_id],
  );
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
