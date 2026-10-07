import { AppError } from '../lib/errors.js';

/**
 * הגבלת קצב פשוטה בזיכרון.
 *
 * מספיקה כאן משום שב-Render בחבילה החינמית רץ מופע יחיד. אם יתווספו
 * מופעים, ההגבלה תהיה לכל מופע בנפרד — ואז יידרש מונה משותף.
 */
export function rateLimit({ windowMs = 60_000, max = 120, key } = {}) {
  const hits = new Map();

  setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [k, v] of hits) if (v.start < cutoff) hits.delete(k);
  }, windowMs).unref();

  return (req, res, next) => {
    const id = key ? key(req) : (req.user?.userId ?? req.ip);
    const now = Date.now();
    const entry = hits.get(id);

    if (!entry || now - entry.start >= windowMs) {
      hits.set(id, { start: now, count: 1 });
      return next();
    }

    entry.count += 1;
    if (entry.count > max) {
      const retryIn = Math.ceil((entry.start + windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryIn));
      return next(
        new AppError('E_RATE_LIMITED', `יותר מדי בקשות. נסה/י שוב בעוד ${retryIn} שניות.`),
      );
    }
    next();
  };
}
