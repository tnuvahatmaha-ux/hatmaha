import { env } from '../config/env.js';
import { AppError, mapDatabaseError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

/** 404 לנתיב שאינו קיים */
export function notFoundHandler(req, _res, next) {
  next(new AppError('E_NOT_FOUND', `הנתיב ${req.method} ${req.path} אינו קיים`));
}

/**
 * מטפל השגיאות המרכזי.
 *
 * §13: "שגיאה תחזיר קוד יציב, הודעה ידידותית ומזהה מעקב ללא Stack Trace".
 * הפירוט הטכני נכתב ללוג בלבד; ללקוח יוצאת רק ההודעה, הקוד ומזהה המעקב.
 */
export function errorHandler(err, req, res, _next) {
  const appErr =
    err instanceof AppError
      ? err
      : mapDatabaseError(err) ??
        new AppError('E_UNEXPECTED', 'אירעה שגיאה בלתי צפויה. נסה/י שוב בעוד רגע.', { cause: err });

  const traceId = req.traceId ?? 'trc_unknown';

  if (appErr.status >= 500) {
    logger.error('שגיאה בלתי צפויה', {
      traceId,
      code: appErr.code,
      message: err?.message,
      stack: err?.stack?.split('\n').slice(0, 6).join(' | '),
      path: req.originalUrl,
      userId: req.user?.userId,
    });
  } else {
    logger.warn('בקשה נדחתה', {
      traceId,
      code: appErr.code,
      message: appErr.message,
      path: req.originalUrl,
      userId: req.user?.userId,
    });
  }

  if (res.headersSent) return;

  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      traceId,
      ...(appErr.details ? { details: appErr.details } : {}),
      // בפיתוח בלבד: עוזר לאתר את המקור בלי לפתוח לוגים
      ...(env.isProd ? {} : { debug: err?.message }),
    },
  });
}
