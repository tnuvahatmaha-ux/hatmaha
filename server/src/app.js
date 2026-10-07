import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';

import { env } from './config/env.js';
import { requestContext } from './middleware/requestContext.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { rateLimit } from './middleware/rateLimit.js';
import { healthRouter } from './routes/health.js';
import { apiRouter } from './routes/index.js';
import { internalRouter } from './routes/internal.js';
import { devRouter } from './routes/dev.js';

const CLIENT_DIST = fileURLToPath(new URL('../../client/dist', import.meta.url));

export function createApp() {
  const app = express();

  // Render עומד מאחורי פרוקסי; בלי זה req.ip הוא כתובת הפרוקסי
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // CSP כבוי: הממשק מוגש מכאן, אך הוא פונה ל-Supabase ישירות, ומדיניות
      // שגויה תשבור את ההתחברות בשקט. הגנת XSS נשענת על React.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  // CORS מוגבל לאותו מקור ולכתובות שב-CLIENT_URL בלבד
  const corsOptions = {
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'If-Match', 'X-Cron-Secret'],
    exposedHeaders: ['ETag', 'X-Trace-Id'],
    maxAge: 86_400,
  };
  app.use(
    cors((req, callback) => {
      const origin = req.get('Origin');
      // בקשות ללא Origin (curl, בדיקות חיות) מותרות
      if (!origin) return callback(null, { ...corsOptions, origin: true });
      const clean = origin.replace(/\/$/, '');
      // הממשק מוגש מהשרת הזה עצמו; הדפדפן שולח Origin גם בבקשות POST מאותו מקור
      const self = `${req.protocol}://${req.get('host')}`;
      if (clean === self || env.clientOrigins.includes(clean)) {
        return callback(null, { ...corsOptions, origin: true });
      }
      callback(new Error(`CORS: מקור ${origin} אינו מורשה`));
    }),
  );

  app.use(express.json({ limit: '1mb' }));
  app.use(requestContext);

  app.use(healthRouter);
  app.use('/api', rateLimit({ windowMs: 60_000, max: 300 }), apiRouter);

  // משימות מתוזמנות — סוד משותף, לא טוקן משתמש. מחוץ ל-/api בכוונה,
  // כדי שלא יתערבב עם נתיבים שדורשים הזדהות של אדם.
  app.use('/internal', internalRouter);

  // נתיבי פיתוח קיימים רק במצב התחברות מקומי. בייצור הם אינם נרשמים כלל.
  if (env.isLocalAuth) app.use('/dev', devRouter);

  serveClient(app);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * מגיש את הממשק הבנוי (client/dist), כך שהאפליקציה כולה רצה כשירות אחד ב-Render.
 * אם הממשק לא נבנה (פיתוח, בדיקות), השרת ממשיך כ-API בלבד.
 */
function serveClient(app) {
  const indexHtml = path.join(CLIENT_DIST, 'index.html');
  if (!fs.existsSync(indexHtml)) return;

  // קבצי assets נושאים hash בשם, ולכן אפשר לשמור אותם בקאש לתמיד
  app.use(
    '/assets',
    express.static(path.join(CLIENT_DIST, 'assets'), { immutable: true, maxAge: '1y' }),
  );
  app.use(express.static(CLIENT_DIST, { index: false }));

  // ניתוב SPA: כל נתיב GET שאינו של השרת מחזיר את index.html, כדי שרענון
  // ב-/roster לא יחזיר 404. נתיבי השרת, וקובץ asset שאינו קיים, ממשיכים ל-404 בפורמט JSON.
  const serverPaths = /^\/(api|internal|dev|health|assets)(\/|$)/;
  app.use((req, res, next) => {
    if (req.method !== 'GET' || serverPaths.test(req.path) || !req.accepts('html')) return next();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(indexHtml);
  });
}
