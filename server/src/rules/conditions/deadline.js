import { deadlineForWeek, utcToZonedParts, DAY_NAMES_HE } from '../../lib/time.js';

/** מועד הגשת זמינות: יום ושעה בשבוע שלפני השבוע המוצהר */
export default {
  code: 'deadline',
  evaluate(ctx, params) {
    if (!ctx.weekStart) return { passed: true };
    const { weekday, hour } = params;
    if (weekday === undefined || hour === undefined) return { passed: true };

    const cutoff = deadlineForWeek(ctx.weekStart, weekday, hour, ctx.timeZone);
    if (Date.now() <= cutoff.getTime()) return { passed: true };

    const parts = utcToZonedParts(cutoff, ctx.timeZone);
    const [, month, day] = parts.date.split('-');
    return {
      passed: false,
      detail: `מועד ההגשה נסגר ביום ${DAY_NAMES_HE[parts.weekday]} ${day}/${month} בשעה ${parts.time}`,
      facts: { deadline: cutoff.toISOString() },
    };
  },
};
