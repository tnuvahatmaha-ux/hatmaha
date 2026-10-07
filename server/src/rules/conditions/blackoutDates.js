import { overlaps, zonedLocalToUtc, addDays } from '../../lib/time.js';
import { fmtDate } from './_shared.js';

/** תקופת חסימה: טווח תאריכים שבו לא ניתן לשבץ או להגיש */
export default {
  code: 'blackoutDates',
  evaluate(ctx, params) {
    if (!ctx.startsAt || !ctx.endsAt || !params.from || !params.to) return { passed: true };

    const from = zonedLocalToUtc(params.from, '00:00', ctx.timeZone);
    // הטווח כולל את יום הסיום במלואו
    const to = zonedLocalToUtc(addDays(params.to, 1), '00:00', ctx.timeZone);

    if (!overlaps(ctx.startsAt, ctx.endsAt, from, to)) return { passed: true };

    return {
      passed: false,
      detail: `חופף לתקופת חסימה ${fmtDate(params.from)} – ${fmtDate(params.to)}`,
      facts: { from: params.from, to: params.to },
    };
  },
};
