import { logger } from '../lib/logger.js';
import { sendPush, urlFor } from './push.js';

/**
 * יצירת התראות.
 *
 * ההתראות נכתבות לטבלה בתוך אותה טרנזקציה של הפעולה שיצרה אותן, ולכן
 * פעולה שמתגלגלת אחורה אינה משאירה התראה על משהו שלא קרה.
 *
 * השליחה בפועל (דוא״ל) נעשית מאוחר יותר ע״י /internal/cron/dispatch-notifications,
 * שהפינגר החיצוני מפעיל — ל-Render בחבילה החינמית אין מתזמן משלו.
 */

/**
 * @param {object} tx
 * @param {object} args
 * @param {string} args.typeCode      קוד מ-notification_types
 * @param {string[]} args.recipientIds
 * @param {string} args.title
 * @param {string} [args.body]
 * @param {object} [args.payload]
 * @param {string} [args.entityType]
 * @param {string} [args.entityId]
 * @param {string} [args.dedupeKey]   מונע שליחה כפולה של אותו אירוע לאותו נמען
 */
export async function notify(tx, args) {
  const recipients = [...new Set((args.recipientIds ?? []).filter(Boolean))];
  if (recipients.length === 0) return [];

  const [type] = await tx.query(
    `select code, default_inapp, default_email from notification_types
      where code = $1 and is_active`,
    [args.typeCode],
  );

  if (!type) {
    logger.warn('סוג התראה לא מוכר', { typeCode: args.typeCode });
    return [];
  }

  // נמענים פעילים בלבד, עם העדפות הערוצים שלהם
  const targets = await tx.query(
    `select p.id, p.email,
            coalesce(np.inapp, $2) as want_inapp,
            coalesce(np.email, $3) as want_email
       from profiles p
       left join notification_preferences np
              on np.user_id = p.id and np.type_code = $4
      where p.id = any($1::uuid[])
        and p.status = 'active' and p.deleted_at is null`,
    [recipients, type.default_inapp, type.default_email, type.code],
  );

  // סטטוס המסירה נקבע כאן ולא בעדכון נפרד אחר כך: נמען בלי כתובת דוא״ל
  // נרשם מיד ככישלון, כך שיופיע במסך "סטטוס מסירה" ולא ייעלם בשקט.
  const rows = [];
  for (const t of targets) {
    if (t.want_inapp) {
      rows.push({ userId: t.id, channel: 'inapp', status: 'pending', error: null });
    }
    if (t.want_email) {
      rows.push(
        t.email
          ? { userId: t.id, channel: 'email', status: 'pending', error: null }
          : { userId: t.id, channel: 'email', status: 'failed', error: 'חסרה כתובת דוא״ל בפרופיל' },
      );
    }
  }
  if (rows.length === 0) return [];

  const COLS = 11;
  const values = rows.map(
    (_, i) => `(${Array.from({ length: COLS }, (_, c) => `$${i * COLS + c + 1}`).join(', ')})`,
  );
  const params = rows.flatMap((r) => [
    r.userId,
    args.typeCode,
    args.title,
    args.body ?? null,
    JSON.stringify(args.payload ?? {}),
    args.entityType ?? null,
    args.entityId ?? null,
    r.channel,
    args.dedupeKey ? `${args.dedupeKey}:${r.userId}:${r.channel}` : null,
    r.status,
    r.error,
  ]);

  // on conflict על dedupe_key — שידור חוזר של אותו אירוע אינו מייצר כפילות
  const inserted = await tx.query(
    `insert into notifications
       (recipient_user_id, type_code, title, body, payload,
        entity_type, entity_id, channel, dedupe_key, delivery_status, last_error)
     values ${values.join(', ')}
     on conflict (dedupe_key) where dedupe_key is not null do nothing
     returning id, recipient_user_id, channel, delivery_status`,
    params,
  );

  // Push לטלפון — לכל מי שקיבל עכשיו התראה במערכת, ורק אחרי שהפעולה נשמרה
  const pushTo = [...new Set(inserted.filter((r) => r.channel === 'inapp').map((r) => r.recipient_user_id))];
  if (pushTo.length && tx.afterCommit) {
    const message = {
      title: args.title,
      body: args.body,
      url: args.payload?.url ?? urlFor(args.entityType, args.typeCode),
      tag: args.entityId ? `${args.typeCode}:${args.entityId}` : args.typeCode,
    };
    tx.afterCommit(() => sendPush(pushTo, message));
  }

  return inserted;
}

/** סימון כנקרא */
export async function markRead(tx, { userId, notificationId }) {
  const rows = await tx.query(
    `update notifications set read_at = coalesce(read_at, now())
      where recipient_user_id = $1 and ($2::uuid is null or id = $2)
        and read_at is null
      returning id`,
    [userId, notificationId ?? null],
  );
  return rows.length;
}
