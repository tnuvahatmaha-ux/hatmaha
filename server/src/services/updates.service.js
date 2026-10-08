import { randomUUID } from 'node:crypto';
import { query, withTransaction } from '../lib/db.js';
import { AppError } from '../lib/errors.js';
import { notify } from '../notifications/service.js';
import { signUpload, signDownload, storageEnabled, MAX_FILE_BYTES } from '../lib/storage.js';

/**
 * הודעות לצוות: מדריך (או מנהל) שולח הודעה, עם קבצים ובקשת אישור קריאה.
 *
 * מדריך שולח רק למטמיעים שמשויכים אליו. מנהל שולח לכל משתמש פעיל.
 * ההודעה נוצרת כטיוטה, הקבצים מועלים אליה, ורק אז היא נשלחת — כך נמען
 * לא מקבל הודעה שהקובץ שלה עוד לא עלה.
 */

const isManager = (p) => p.baseRole === 'manager';

/** הנמענים שהשולח רשאי לשלוח אליהם */
export async function allowedRecipients(principal) {
  return query(
    `select p.id, p.full_name, p.base_role::text as base_role
       from profiles p
      where p.deleted_at is null and p.status = 'active' and p.id <> $1
        and ($2 or p.id = any($3::uuid[]))
      order by p.full_name`,
    [principal.userId, isManager(principal), principal.scopes.assignedUserIds],
  );
}

export async function create(actor, input) {
  const allowed = await allowedRecipients(actor);
  const allowedIds = new Set(allowed.map((r) => r.id));

  const recipientIds = input.toWholeTeam
    ? allowed.filter((r) => isManager(actor) ? r.base_role !== 'manager' : true).map((r) => r.id)
    : [...new Set(input.recipientIds ?? [])];

  if (recipientIds.length === 0) {
    throw new AppError('E_VALIDATION', 'יש לבחור לפחות נמען אחד');
  }
  const outside = recipientIds.filter((id) => !allowedIds.has(id));
  if (outside.length) {
    throw new AppError('E_FORBIDDEN', 'אפשר לשלוח הודעה רק למטמיעים שמשויכים אליך', {
      details: { outside },
    });
  }

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `insert into updates (title, body, author_user_id, audience, requires_ack, status)
       values ($1, $2, $3, 'users', $4, 'draft') returning id`,
      [input.title, input.body, actor.userId, input.requiresAck ?? false],
    );
    for (const userId of recipientIds) {
      await tx.query('insert into update_recipients (update_id, user_id) values ($1, $2)', [row.id, userId]);
    }
    return { id: row.id, recipients: recipientIds.length };
  });
}

async function requireAuthored(tx, actor, updateId) {
  const [row] = await tx.query(
    'select * from updates where id = $1 and deleted_at is null for update',
    [updateId],
  );
  if (!row || row.author_user_id !== actor.userId) {
    throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');
  }
  return row;
}

export async function publish(actor, updateId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const update = await requireAuthored(tx, actor, updateId);
    if (update.status !== 'draft') throw new AppError('E_STATE', 'ההודעה כבר נשלחה');

    await tx.query(`update updates set status = 'published', published_at = now() where id = $1`, [updateId]);
    const recipients = await tx.query('select user_id from update_recipients where update_id = $1', [updateId]);

    await notify(tx, {
      typeCode: 'update_published',
      recipientIds: recipients.map((r) => r.user_id),
      title: `הודעה חדשה מ${actor.fullName}: ${update.title}`,
      body: update.requires_ack ? 'ההודעה ממתינה לאישור קריאה' : null,
      entityType: 'updates',
      entityId: updateId,
      dedupeKey: `update:${updateId}`,
    });
    return { id: updateId, status: 'published', recipients: recipients.length };
  });
}

/** מחיקת טיוטה שלא נשלחה */
export async function discard(actor, updateId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const update = await requireAuthored(tx, actor, updateId);
    if (update.status !== 'draft') throw new AppError('E_STATE', 'אי אפשר למחוק הודעה שכבר נשלחה');
    await tx.query('update updates set deleted_at = now(), deleted_by = $2 where id = $1', [updateId, actor.userId]);
    return { removed: updateId };
  });
}

const SUMMARY = `
  select u.id, u.title, u.body, u.status, u.requires_ack, u.published_at, u.created_at,
         a.id as author_id, a.full_name as author_name,
         (select count(*)::int from update_attachments x where x.update_id = u.id) as attachment_count`;

export async function inbox(userId) {
  return query(
    `${SUMMARY}, r.read_at, r.acknowledged_at
       from updates u
       join update_recipients r on r.update_id = u.id and r.user_id = $1
       join profiles a on a.id = u.author_user_id
      where u.deleted_at is null and u.status = 'published'
      order by (u.requires_ack and r.acknowledged_at is null) desc, u.published_at desc
      limit 200`,
    [userId],
  );
}

export async function sent(userId) {
  return query(
    `${SUMMARY},
            (select count(*)::int from update_recipients r where r.update_id = u.id) as recipient_count,
            (select count(*)::int from update_recipients r
              where r.update_id = u.id and r.read_at is not null) as read_count,
            (select count(*)::int from update_recipients r
              where r.update_id = u.id and r.acknowledged_at is not null) as ack_count
       from updates u
       join profiles a on a.id = u.author_user_id
      where u.deleted_at is null and u.author_user_id = $1
      order by u.status = 'draft' desc, coalesce(u.published_at, u.created_at) desc
      limit 200`,
    [userId],
  );
}

/** הודעה מלאה. שולח רואה גם את הסטטוס של כל נמען; נמען — רק את שלו. */
export async function get(principal, updateId) {
  const [update] = await query(
    `${SUMMARY}, u.author_user_id
       from updates u join profiles a on a.id = u.author_user_id
      where u.id = $1 and u.deleted_at is null`,
    [updateId],
  );
  if (!update) throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');

  const isAuthor = update.author_user_id === principal.userId;
  const [mine] = await query(
    'select read_at, acknowledged_at from update_recipients where update_id = $1 and user_id = $2',
    [updateId, principal.userId],
  );
  if (!isAuthor && (!mine || update.status !== 'published')) {
    throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');
  }

  const attachments = await query(
    `select id, file_name, mime_type, size_bytes, created_at
       from update_attachments where update_id = $1 order by created_at`,
    [updateId],
  );

  const recipients = isAuthor
    ? await query(
        `select p.id, p.full_name, r.read_at, r.acknowledged_at, r.reminded_at
           from update_recipients r join profiles p on p.id = r.user_id
          where r.update_id = $1
          order by r.acknowledged_at nulls first, r.read_at nulls first, p.full_name`,
        [updateId],
      )
    : null;

  return { ...update, isAuthor, mine: mine ?? null, attachments, recipients, storageEnabled };
}

export async function markRead(userId, updateId) {
  const rows = await query(
    `update update_recipients set read_at = coalesce(read_at, now())
      where update_id = $1 and user_id = $2 returning read_at`,
    [updateId, userId],
  );
  if (!rows.length) throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');
  return rows[0];
}

export async function acknowledge(userId, updateId) {
  const rows = await query(
    `update update_recipients r
        set acknowledged_at = coalesce(r.acknowledged_at, now()),
            read_at = coalesce(r.read_at, now())
       from updates u
      where r.update_id = $1 and r.user_id = $2
        and u.id = r.update_id and u.status = 'published' and u.deleted_at is null
      returning r.read_at, r.acknowledged_at`,
    [updateId, userId],
  );
  if (!rows.length) throw new AppError('E_NOT_FOUND', 'ההודעה המבוקשת לא נמצאה');
  return rows[0];
}

/** תזכורת למי שעוד לא אישר קריאה */
export async function remind(actor, updateId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const update = await requireAuthored(tx, actor, updateId);
    if (update.status !== 'published') throw new AppError('E_STATE', 'ההודעה עוד לא נשלחה');
    if (!update.requires_ack) throw new AppError('E_STATE', 'בהודעה הזו לא התבקש אישור קריאה');

    const pending = await tx.query(
      `update update_recipients set reminded_at = now()
        where update_id = $1 and acknowledged_at is null returning user_id`,
      [updateId],
    );
    await notify(tx, {
      typeCode: 'update_ack_reminder',
      recipientIds: pending.map((r) => r.user_id),
      title: `תזכורת: נא לאשר קריאה של "${update.title}"`,
      entityType: 'updates',
      entityId: updateId,
    });
    return { reminded: pending.length };
  });
}

/* ───────────────────────── קבצים ───────────────────────── */

const safeName = (name) => name.replace(/[^\p{L}\p{N}._-]+/gu, '_').slice(-120) || 'file';

export async function signAttachmentUpload(actor, updateId, { fileName, sizeBytes }) {
  if (sizeBytes > MAX_FILE_BYTES) throw new AppError('E_VALIDATION', 'הקובץ גדול מ-10MB');
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const update = await requireAuthored(tx, actor, updateId);
    if (update.status !== 'draft') throw new AppError('E_STATE', 'אי אפשר לצרף קבצים להודעה שכבר נשלחה');
    const storagePath = `updates/${updateId}/${randomUUID()}-${safeName(fileName)}`;
    return { storagePath, ...(await signUpload(storagePath)) };
  });
}

export async function registerAttachment(actor, updateId, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const update = await requireAuthored(tx, actor, updateId);
    if (update.status !== 'draft') throw new AppError('E_STATE', 'אי אפשר לצרף קבצים להודעה שכבר נשלחה');
    if (!input.storagePath.startsWith(`updates/${updateId}/`)) {
      throw new AppError('E_VALIDATION', 'נתיב הקובץ אינו שייך להודעה הזו');
    }
    const [row] = await tx.query(
      `insert into update_attachments (update_id, file_name, mime_type, size_bytes, storage_path, uploaded_by)
       values ($1, $2, $3, $4, $5, $6) returning id, file_name, mime_type, size_bytes`,
      [updateId, input.fileName, input.mimeType ?? null, input.sizeBytes, input.storagePath, actor.userId],
    );
    return row;
  });
}

export async function attachmentUrl(principal, updateId, attachmentId) {
  const update = await get(principal, updateId); // שולח או נמען בלבד
  const att = update.attachments.find((a) => a.id === attachmentId);
  if (!att) throw new AppError('E_NOT_FOUND', 'הקובץ המבוקש לא נמצא');
  const [row] = await query('select storage_path from update_attachments where id = $1', [attachmentId]);
  return { url: await signDownload(row.storage_path, { fileName: att.file_name }) };
}
