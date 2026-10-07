import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import { createApp } from './app.js';
import { closePool } from './lib/db.js';

const app = createApp();

// במצב התחברות מקומי כל מי שמגיע לשרת יכול להיכנס כל משתמש, ולכן השרת
// מאזין אז רק למחשב עצמו ולא לרשת. במצב הרגיל — כל הממשקים, כפי ש-Render דורש.
const host = env.isLocalAuth ? '127.0.0.1' : undefined;

const server = app.listen(env.PORT, host, () => {
  logger.info('השרת עלה', {
    port: env.PORT,
    host: host ?? 'all',
    env: env.NODE_ENV,
    authMode: env.AUTH_MODE,
    allowedOrigins: env.clientOrigins,
  });
  if (env.isLocalAuth) {
    logger.warn('⚠ מצב התחברות מקומי פעיל: כניסה ללא סיסמה, לפיתוח בלבד. השרת מאזין רק ל-127.0.0.1');
  }
});

/** כיבוי מסודר — Render שולח SIGTERM לפני החלפת גרסה */
async function shutdown(signal) {
  logger.info('מתחיל כיבוי מסודר', { signal });
  server.close(async () => {
    await closePool().catch(() => {});
    logger.info('השרת נסגר');
    process.exit(0);
  });
  // אם חיבור תקוע, לא ממתינים לנצח
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  logger.error('Promise שנדחה ללא טיפול', { reason: String(reason) });
});
