import webpush from 'web-push';
import { query } from '../lib/db.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * התראות לטלפון (Web Push).
 *
 * מפתחות ה-VAPID נוצרים פעם אחת ונשמרים במסד (app_settings, key פנימי), ולא
 * כמשתני סביבה — כך פריסה ל-Render אינה דורשת הגדרה ידנית, והמפתח שורד
 * החלפת גרסה (אם היה משתנה, כל המנויים הקיימים היו מפסיקים לעבוד).
 *
 * השליחה נעשית אחרי commit בלבד (tx.afterCommit), כך שפעולה שהתגלגלה אחורה
 * אינה משאירה התראה בטלפון.
 */

const KEY = 'internal.push_vapid';
let keysPromise = null;

export async function vapidKeys() {
  keysPromise ??= (async () => {
    const [row] = await query('select value from app_settings where key = $1', [KEY]);
    if (row?.value?.publicKey) return row.value;
    const keys = webpush.generateVAPIDKeys();
    // אם שני מופעים יצרו במקביל — מנצח הראשון, וכולם קוראים אותו
    await query(
      `insert into app_settings (key, value, name_he) values ($1, $2, 'מפתחות Push (פנימי)')
       on conflict (key) do nothing`,
      [KEY, JSON.stringify(keys)],
    );
    const [saved] = await query('select value from app_settings where key = $1', [KEY]);
    return saved.value;
  })().catch((err) => {
    keysPromise = null;
    throw err;
  });
  return keysPromise;
}

/**
 * שליחה לכל המכשירים של הנמענים. לעולם אינה זורקת — Push הוא תוספת, ותקלה
 * בו אינה אמורה לפגוע בפעולה עצמה.
 */
export async function sendPush(userIds, { title, body, url, tag }) {
  if (env.isTest || !userIds?.length) return;
  try {
    const subs = await query(
      'select id, endpoint, p256dh, auth from push_subscriptions where user_id = any($1::uuid[])',
      [userIds],
    );
    if (!subs.length) return;

    const keys = await vapidKeys();
    const options = {
      vapidDetails: { subject: 'mailto:noreply@hatmaha.app', publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 60 * 60 * 24,
    };
    const payload = JSON.stringify({ title, body: body ?? '', url: url ?? '/notifications', tag });

    await Promise.all(subs.map(async (s) => {
      try {
        await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, options);
        await query('update push_subscriptions set last_used_at = now() where id = $1', [s.id]);
      } catch (err) {
        // 404/410 — המנוי בוטל בדפדפן ולא יחזור
        if (err.statusCode === 404 || err.statusCode === 410) {
          await query('delete from push_subscriptions where id = $1', [s.id]);
        } else {
          logger.warn('שליחת Push נכשלה', { status: err.statusCode, message: err.message });
        }
      }
    }));
  } catch (err) {
    logger.warn('שליחת Push נכשלה', { message: err.message });
  }
}

/** לאיזה מסך ההתראה פותחת, לפי סוג הישות */
export function urlFor(entityType, typeCode) {
  if (typeCode?.startsWith('chat_')) return '/messages';
  if (typeCode?.startsWith('training_')) return '/training';
  switch (entityType) {
    case 'constraint_requests': return typeCode === 'request_submitted' ? '/approvals' : '/requests';
    case 'updates': return '/messages';
    case 'chat_groups': return '/messages';
    case 'activities':
    case 'roster_versions':
    case 'roster_assignments': return '/schedule';
    case 'exception_requests': return '/approvals';
    case 'availability_declarations': return '/requests';
    default: return '/notifications';
  }
}
