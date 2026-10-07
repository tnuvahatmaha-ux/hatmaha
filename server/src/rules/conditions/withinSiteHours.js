import { utcToZonedParts, timeToMinutes, hoursBetween } from '../../lib/time.js';

const DAY_MINUTES = 24 * 60;

/**
 * בתוך שעות פעילות האתר.
 *
 * שעות האתר הן חוק ולא רגע, ולכן ההשוואה היא על שעון קיר.
 *
 * משמרת שחוצה חצות היא מקרה נפרד ולא שגיאה: היא נמשכת אל תוך היום הבא,
 * ולכן היא יכולה להתקיים רק באתר שפתוח מסביב לשעון. אתר עם חלון פעילות
 * מוגבל פשוט אינו יכול להריץ משמרת כזו, וזו בדיוק ההודעה שהמשבץ צריך.
 */
export default {
  code: 'withinSiteHours',
  evaluate(ctx, _params, facts) {
    const site = facts.site;
    if (!site || !ctx.startsAt || !ctx.endsAt) return { passed: true };

    const tz = site.timezone ?? ctx.timeZone;
    const openMin = timeToMinutes(site.open_time);
    const closeMin = timeToMinutes(site.close_time);
    const open = site.open_time.slice(0, 5);
    const close = site.close_time.slice(0, 5);

    const startMin = timeToMinutes(utcToZonedParts(ctx.startsAt, tz).time);
    const durationMin = Math.round(hoursBetween(ctx.startsAt, ctx.endsAt) * 60);
    const endMin = startMin + durationMin;

    const crossesMidnight = endMin > DAY_MINUTES;

    if (crossesMidnight) {
      // האתר נחשב פתוח מסביב לשעון כשחלון הפעילות שלו מכסה יממה שלמה
      const isRoundTheClock = openMin === 0 && closeMin >= DAY_MINUTES - 1;
      if (isRoundTheClock) return { passed: true };

      return {
        passed: false,
        detail: `משמרת שחוצה חצות אינה אפשרית באתר ${site.name}, שפעיל בין ${open} ל-${close}`,
        facts: { open, close, crossesMidnight: true },
      };
    }

    if (startMin >= openMin && endMin <= closeMin) return { passed: true };

    return {
      passed: false,
      detail: `מחוץ לשעות הפעילות של ${site.name} (${open}–${close})`,
      facts: { open, close, crossesMidnight: false },
    };
  },
};
