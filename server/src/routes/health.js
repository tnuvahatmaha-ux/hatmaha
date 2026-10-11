import { Router } from 'express';
import { ping, query } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { MARKERS } from '../lib/migrate.js';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * מיגרציות שהקוד תלוי בהן ועוד לא קיימות במסד. בדרך כלל השרת מריץ אותן לבד
 * בעלייה (lib/migrate.js); אם אחת נכשלה — כאן רואים מה חסר, בלי לחשוף נתונים.
 */
export async function missingMigrations() {
  const missing = [];
  for (const [no, sql] of Object.entries(MARKERS)) {
    const [row] = await query(sql);
    if (!row?.ok) missing.push(String(no).padStart(4, '0'));
  }
  return missing;
}

/**
 * בדיקת חיות. הנתיב היחיד שאינו דורש הרשאה.
 *
 * משמש גם את הפינגר החיצוני שמשאיר את Render ער ואת פרויקט Supabase
 * מחוץ להשהיה אחרי שבעה ימי חוסר פעילות — ולכן הוא נוגע במסד בפועל.
 */
healthRouter.get('/health', async (_req, res) => {
  let database = 'up';
  let latencyMs = null;
  let missing = null;

  try {
    latencyMs = await ping();
    missing = await missingMigrations();
    if (missing.length) logger.error('חסרות מיגרציות במסד', { missing });
  } catch (err) {
    database = 'down';
    logger.error('בדיקת חיות למסד נכשלה', { message: err.message });
  }

  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    database,
    latencyMs,
    // רשימה ריקה = כל המיגרציות שהקוד צריך קיימות במסד
    missingMigrations: missing,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
  });
});
