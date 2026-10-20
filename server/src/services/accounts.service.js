import { query, withTransaction } from '../lib/db.js';
import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/**
 * חשבונות משתמשים: שם המשתמש (הדוא״ל) ואיפוס סיסמה ע״י מנהל ההטמעה.
 *
 * הסיסמה נשמרת ב-Supabase Auth כ-hash בלבד, ולכן אי אפשר לשלוף ולהציג סיסמה
 * שמשתמש בחר. במקום זה המנהל מגדיר סיסמה חדשה, רואה אותה פעם אחת, ומעביר
 * אותה למשתמש.
 */

export async function list() {
  return query(
    `select p.id, p.full_name, p.email, p.base_role::text as base_role, p.status::text as status,
            p.password_reset_at, rb.full_name as password_reset_by_name,
            (to_jsonb(u) ->> 'last_sign_in_at')::timestamptz as last_sign_in_at,
            u.created_at as account_created_at
       from profiles p
       left join auth.users u on u.id = p.id
       left join profiles rb on rb.id = p.password_reset_by
      where p.deleted_at is null
      order by p.status = 'active' desc, p.full_name`,
  );
}

/** דרך ה-Admin API של Supabase, אם מפתח השירות מוגדר */
async function setViaAdminApi(userId, password) {
  let res;
  try {
    res = await fetch(`${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        apikey: env.SUPABASE_SERVICE_ROLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password, email_confirm: true }),
    });
  } catch (err) {
    logger.error('שירות ההתחברות של Supabase אינו זמין', { message: err.message });
    throw new AppError('E_UNEXPECTED', 'שירות ההתחברות אינו זמין כרגע — נסו שוב בעוד רגע');
  }
  if (!res.ok) {
    const body = await res.text();
    logger.error('איפוס סיסמה ב-Supabase נכשל', { status: res.status, body });
    if (res.status === 422) throw new AppError('E_VALIDATION', 'הסיסמה נדחתה — נסו סיסמה ארוכה או מורכבת יותר');
    throw new AppError('E_UNEXPECTED', 'שירות ההתחברות לא אישר את הסיסמה החדשה');
  }
}

export async function resetPassword(actor, userId, { password }) {
  const useApi = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) && !env.isTest && !env.isLocalAuth;

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [user] = await tx.query(
      'select id, full_name, email from profiles where id = $1 and deleted_at is null',
      [userId],
    );
    if (!user) throw new AppError('E_NOT_FOUND', 'המשתמש לא נמצא');

    if (!useApi) {
      // בלי מפתח שירות: hash של bcrypt ישירות בטבלת המשתמשים — אותו פורמט ש-Supabase Auth בודק
      await tx.query("select set_config('search_path', 'public, extensions', true)");
      const rows = await tx.query(
        `update auth.users set encrypted_password = crypt($2, gen_salt('bf')) where id = $1 returning id`,
        [userId, password],
      );
      if (!rows.length) throw new AppError('E_NOT_FOUND', 'למשתמש אין חשבון התחברות');
    }

    await tx.query(
      'update profiles set password_reset_at = now(), password_reset_by = $2 where id = $1',
      [userId, actor.userId],
    );
    // הקריאה החיצונית אחרונה: אם היא נכשלת, גם הרישום מתגלגל אחורה
    if (useApi) await setViaAdminApi(userId, password);
    return { id: userId, email: user.email };
  });
}
