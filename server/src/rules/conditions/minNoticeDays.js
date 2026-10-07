import { DAY_MS } from '../../lib/time.js';
import { round1 } from './_shared.js';

/** הודעה מוקדמת: כמה ימים מראש הוגשה הבקשה */
export default {
  code: 'minNoticeDays',
  evaluate(ctx, params) {
    if (!ctx.startsAt) return { passed: true };
    const required = Number(params.days);
    if (!Number.isFinite(required)) return { passed: true };

    const noticeDays = (ctx.startsAt.getTime() - Date.now()) / DAY_MS;
    if (noticeDays >= required) return { passed: true };

    const shown = Math.max(0, round1(noticeDays));
    return {
      passed: false,
      detail: `הודעה מוקדמת של ${shown} ימים בלבד, נדרשים ${required}`,
      facts: { noticeDays: shown, required },
    };
  },
};
