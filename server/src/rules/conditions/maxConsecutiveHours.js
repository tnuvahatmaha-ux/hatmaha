import { round1 } from './_shared.js';
import { hoursBetween } from '../../lib/time.js';

/** משך רצוף מרבי של שיבוץ יחיד */
export default {
  code: 'maxConsecutiveHours',
  evaluate(ctx, params) {
    if (!ctx.startsAt || !ctx.endsAt) return { passed: true };
    const limit = Number(params.hours);
    if (!Number.isFinite(limit)) return { passed: true };

    const duration = hoursBetween(ctx.startsAt, ctx.endsAt);
    if (duration <= limit) return { passed: true };

    return {
      passed: false,
      detail: `משך רצוף של ${round1(duration)} שעות, מעל המקסימום של ${limit}`,
      facts: { duration: round1(duration), limit },
    };
  },
};
