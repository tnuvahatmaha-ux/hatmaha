import { round1 } from './_shared.js';
import { zonedLocalToUtc, utcToZonedParts, addDays } from '../../lib/time.js';

/**
 * מקסימום שעות ביום.
 *
 * היממה נמדדת לפי היום העסקי המקומי ולא לפי יממת UTC. בישראל הפרש
 * השעון הוא שעתיים-שלוש, ולכן חישוב לפי UTC היה מזיז את גבול היממה
 * ומשייך שעות ליום הלא נכון — בדיוק במשמרות הבוקר המוקדמות.
 *
 * נספרות רק התחייבויות שהן שעות עבודה: אילוץ תופס זמן אך אינו עבודה.
 * כל התחייבות נחתכת לגבולות היממה, ולכן משמרת לילה נספרת נכון בשני
 * הימים שהיא נוגעת בהם.
 */
export default {
  code: 'maxHoursPerDay',
  evaluate(ctx, params, facts) {
    if (!ctx.startsAt || !ctx.endsAt) return { passed: true };
    const limit = Number(params.hours);
    if (!Number.isFinite(limit)) return { passed: true };

    const tz = ctx.timeZone;
    const localDate = ctx.localDate ?? utcToZonedParts(ctx.startsAt, tz).date;
    const dayStart = zonedLocalToUtc(localDate, '00:00', tz).getTime();
    const dayEnd = zonedLocalToUtc(addDays(localDate, 1), '00:00', tz).getTime();

    const clip = (from, to) =>
      Math.max(0, Math.min(to, dayEnd) - Math.max(from, dayStart)) / 3_600_000;

    const existing = (facts.commitments ?? [])
      .filter((c) => c.countsAsWork)
      .reduce((sum, c) => sum + clip(c.startsAt.getTime(), c.endsAt.getTime()), 0);

    const total = existing + clip(ctx.startsAt.getTime(), ctx.endsAt.getTime());
    if (total <= limit) return { passed: true };

    return {
      passed: false,
      detail: `סך ${round1(total)} שעות ביום ${localDate}, מעל המקסימום של ${limit}`,
      facts: { total: round1(total), limit, date: localDate },
    };
  },
};
