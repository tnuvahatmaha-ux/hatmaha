import { round1 } from './_shared.js';
import { HOUR } from '../../lib/time.js';

/** מנוחה מינימלית בין שתי התחייבויות עבודה עוקבות */
export default {
  code: 'minRestHours',
  evaluate(ctx, params, facts) {
    if (!ctx.startsAt || !ctx.endsAt) return { passed: true };
    const required = Number(params.hours);
    if (!Number.isFinite(required)) return { passed: true };

    const gapMs = required * HOUR;
    const s = ctx.startsAt.getTime();
    const e = ctx.endsAt.getTime();

    for (const c of facts.commitments ?? []) {
      if (!c.countsAsWork) continue;
      const cs = c.startsAt.getTime();
      const ce = c.endsAt.getTime();

      const before = ce <= s && s - ce < gapMs;
      const after = cs >= e && cs - e < gapMs;
      if (!before && !after) continue;

      const actual = before ? (s - ce) / HOUR : (cs - e) / HOUR;
      return {
        passed: false,
        detail: `מנוחה של ${round1(actual)} שעות בלבד ביחס ל${c.label}, במקום ${required}`,
        facts: { actual: round1(actual), required },
      };
    }
    return { passed: true };
  },
};
