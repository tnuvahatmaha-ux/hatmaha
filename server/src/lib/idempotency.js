import { createHash } from 'node:crypto';
import { query, withTransaction } from './db.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

/**
 * אידמפוטנטיות לפעולות רגישות.
 *
 * §13: "פעולות הגשה, אישור, פרסום ומתן הרשאה יהיו Idempotent".
 * בפועל זה מגן על שני מקרים אמיתיים: לחיצה כפולה על כפתור, ו-retry של
 * הלקוח אחרי שהשרת החינמי התעורר לאט והבקשה עברה timeout.
 *
 * המפתח מגיע מכותרת Idempotency-Key. שידור חוזר עם אותו מפתח ואותו גוף
 * מחזיר את התשובה השמורה; אותו מפתח עם גוף שונה הוא שגיאה.
 */

const hashBody = (body) =>
  createHash('sha256').update(JSON.stringify(body ?? {})).digest('hex').slice(0, 32);

/**
 * @param {object} req
 * @param {string} endpoint  מזהה הנתיב, למשל 'roster.publish'
 * @param {() => Promise<{status?: number, body: any}>} handler
 */
export async function withIdempotency(req, endpoint, handler) {
  const key = req.get('idempotency-key');

  // בלי מפתח הפעולה פשוט מתבצעת. הלקוח שלנו תמיד שולח מפתח לפעולות
  // הרגישות, אך אנחנו לא חוסמים לקוחות אחרים.
  if (!key) return handler();

  const userId = req.user.userId;
  const requestHash = hashBody(req.body);
  const scopedKey = `${userId}:${endpoint}:${key}`;

  const [existing] = await query('select * from idempotency_keys where key = $1', [scopedKey]);

  if (existing) {
    if (existing.request_hash !== requestHash) {
      throw new AppError(
        'E_CONFLICT',
        'מפתח האידמפוטנטיות כבר שימש לבקשה אחרת',
        { details: { endpoint } },
      );
    }
    if (existing.state === 'completed') {
      return { status: existing.status_code ?? 200, body: existing.response, replayed: true };
    }
    // בקשה זהה עדיין רצה — לא מריצים אותה פעמיים במקביל
    throw new AppError(
      'E_IDEMPOTENCY_IN_PROGRESS',
      'הבקשה כבר בטיפול. נסה/י שוב בעוד רגע.',
    );
  }

  try {
    await query(
      `insert into idempotency_keys (key, user_id, endpoint, request_hash, state)
       values ($1, $2, $3, $4, 'in_progress')`,
      [scopedKey, userId, endpoint, requestHash],
    );
  } catch (err) {
    // מירוץ בין שתי בקשות זהות שהגיעו יחד
    if (err.code === 'E_DUPLICATE' || err.cause?.code === '23505') {
      throw new AppError('E_IDEMPOTENCY_IN_PROGRESS', 'הבקשה כבר בטיפול. נסה/י שוב בעוד רגע.');
    }
    throw err;
  }

  try {
    const result = await handler();
    await query(
      `update idempotency_keys
          set state = 'completed', status_code = $2, response = $3, completed_at = now()
        where key = $1`,
      [scopedKey, result.status ?? 200, JSON.stringify(result.body ?? null)],
    );
    return result;
  } catch (err) {
    // כישלון אינו נשמר: הלקוח רשאי לנסות שוב עם אותו מפתח
    await query('delete from idempotency_keys where key = $1', [scopedKey]).catch(() => {});
    throw err;
  }
}

/** ניקוי מפתחות ישנים — נקרא מ-/internal/cron/purge-idempotency */
export async function purgeIdempotencyKeys(olderThanHours = 48) {
  const rows = await query(
    `delete from idempotency_keys
      where created_at < now() - ($1 || ' hours')::interval
      returning key`,
    [String(olderThanHours)],
  );
  logger.info('ניקוי מפתחות אידמפוטנטיות', { removed: rows.length });
  return rows.length;
}

export { withTransaction };
