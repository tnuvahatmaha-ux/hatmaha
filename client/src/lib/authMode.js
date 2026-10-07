/**
 * מצב ההזדהות של הלקוח.
 *
 * 'local' — כניסה ללא סיסמה מתוך רשימת משתמשי דמו, בלי Supabase.
 * פעיל רק כשגם VITE_AUTH_MODE=local וגם מדובר בשרת הפיתוח של Vite
 * (import.meta.env.DEV). בבנייה לייצור התנאי השני תמיד false, ולכן גם אם
 * מישהו יגדיר את המשתנה ב-Cloudflare Pages בטעות — המצב לא יופעל.
 * השרת, מצידו, מסרב לעלות במצב הזה בייצור.
 */
export const isLocalAuth =
  import.meta.env.DEV && import.meta.env.VITE_AUTH_MODE === 'local';

const STORAGE_KEY = 'hatmaha.localUserId';

export function getLocalUserId() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setLocalUserId(userId) {
  try {
    if (userId) localStorage.setItem(STORAGE_KEY, userId);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* דפדפן בלי localStorage — הכניסה תחזיק עד רענון */
  }
}

/** הטוקן שהשרת מצפה לו במצב מקומי */
export const localToken = (userId) => `local:${userId}`;
