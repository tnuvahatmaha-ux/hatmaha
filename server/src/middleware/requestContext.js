import { randomUUID } from 'node:crypto';
import { logger } from '../lib/logger.js';

/**
 * מזהה מעקב לכל בקשה. §13 דורש שכל שגיאה תחזיר מזהה מעקב שמאפשר לאתר
 * את האירוע בלוגים — בלי לחשוף Stack Trace למשתמש.
 *
 * אותו מזהה נכתב גם ל-app.trace_id בטרנזקציה, ולכן שורת Audit ושורת לוג
 * ניתנות לחיבור זו לזו.
 */
export function requestContext(req, res, next) {
  req.traceId = `trc_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
  req.startedAt = process.hrtime.bigint();
  res.setHeader('X-Trace-Id', req.traceId);

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
    const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
    logger[level]('request', {
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
      userId: req.user?.userId,
      traceId: req.traceId,
    });
  });

  next();
}
