import { Router } from 'express';
import { ping } from '../lib/db.js';
import { logger } from '../lib/logger.js';

export const healthRouter = Router();

const startedAt = Date.now();

/**
 * בדיקת חיות. הנתיב היחיד שאינו דורש הרשאה.
 *
 * משמש גם את הפינגר החיצוני שמשאיר את Render ער ואת פרויקט Supabase
 * מחוץ להשהיה אחרי שבעה ימי חוסר פעילות — ולכן הוא נוגע במסד בפועל.
 */
healthRouter.get('/health', async (_req, res) => {
  let database = 'up';
  let latencyMs = null;

  try {
    latencyMs = await ping();
  } catch (err) {
    database = 'down';
    logger.error('בדיקת חיות למסד נכשלה', { message: err.message });
  }

  res.status(database === 'up' ? 200 : 503).json({
    status: database === 'up' ? 'ok' : 'degraded',
    database,
    latencyMs,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    time: new Date().toISOString(),
  });
});
