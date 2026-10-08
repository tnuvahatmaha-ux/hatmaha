import { env } from '../config/env.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';

/**
 * לקוח מינימלי ל-Supabase Storage, דרך ה-REST API ובלי תלות נוספת.
 *
 * הקבצים לא עוברים דרך השרת: הוא מנפיק קישור העלאה חתום, הדפדפן מעלה
 * ישירות ל-Storage, ואחר כך השרת מנפיק קישורי הורדה זמניים. כך Render
 * בחבילה החינמית לא מחזיק קבצים בזיכרון.
 *
 * ה-bucket פרטי, ולכן אין דרך לקרוא קובץ בלי קישור חתום מהשרת — שמנפיק
 * אותו רק לשולח ההודעה ולנמעניה.
 */

export const BUCKET = 'attachments';
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const storageEnabled = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) && !env.isTest;

const base = () => `${env.SUPABASE_URL.replace(/\/$/, '')}/storage/v1`;

async function call(path, body) {
  if (!storageEnabled) {
    throw new AppError('E_STATE', 'אחסון קבצים אינו מוגדר בשרת הזה');
  }
  const res = await fetch(`${base()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    logger.error('קריאה ל-Storage נכשלה', { path, status: res.status, body: await res.text() });
    throw new AppError('E_UNEXPECTED', 'שירות הקבצים אינו זמין כרגע');
  }
  return res.json();
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

/** קישור העלאה חתום (תקף שעתיים, לפי ברירת המחדל של Supabase) */
export async function signUpload(objectPath) {
  const out = await call(`/object/upload/sign/${BUCKET}/${encodePath(objectPath)}`);
  return { uploadUrl: `${base()}${out.url}` };
}

/** קישור הורדה חתום וקצר-מועד */
export async function signDownload(objectPath, { expiresIn = 300, fileName } = {}) {
  const out = await call(`/object/sign/${BUCKET}/${encodePath(objectPath)}`, { expiresIn });
  const url = new URL(`${base()}${out.signedURL}`);
  if (fileName) url.searchParams.set('download', fileName);
  return url.toString();
}
