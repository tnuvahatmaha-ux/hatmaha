import { Router } from 'express';
import { ping, query } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * סימן אחד לכל מיגרציה שהקוד תלוי בה. המיגרציות מורצות ידנית ב-Supabase,
 * ולכן קוד שנפרס לפני שהן רצו נכשל ב"שגיאה בגישה לנתונים" בלי הסבר.
 * כאן רואים מיד מה חסר — בלי לחשוף נתונים.
 */
const SCHEMA_MARKERS = {
  '0017': `select exists (select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
             where rp.role = 'mentor' and p.resource = 'requests' and p.action = 'create') as ok`,
  '0018': `select exists (select 1 from pg_proc where proname = 'site_period_on') as ok`,
  '0019': `select exists (select 1 from information_schema.columns
             where table_name = 'shift_types' and column_name = 'category') as ok`,
  '0020': `select exists (select 1 from information_schema.columns
             where table_name = 'updates' and column_name = 'requires_ack') as ok`,
  '0021': `select exists (select 1 from information_schema.tables where table_name = 'chat_groups') as ok`,
  '0022': `select exists (select 1 from information_schema.tables where table_name = 'skill_scores') as ok`,
};

export async function missingMigrations() {
  const missing = [];
  for (const [name, sql] of Object.entries(SCHEMA_MARKERS)) {
    const [row] = await query(sql);
    if (!row?.ok) missing.push(name);
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
