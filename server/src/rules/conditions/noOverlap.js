import { overlaps } from '../../lib/time.js';
import { fmtRange } from './_shared.js';

/**
 * ללא חפיפות.
 *
 * החישוב על רגעים מוחלטים, ולא על דקות מחצות כמו בפרוטוטייפ, ולכן משמרת
 * לילה 22:00–06:00 נבדקת נכון מול משמרת בוקר של היום שאחריה.
 */
export default {
  code: 'noOverlap',
  evaluate(ctx, _params, facts) {
    if (!ctx.startsAt || !ctx.endsAt) return { passed: true };

    const clash = (facts.commitments ?? []).find((c) =>
      overlaps(ctx.startsAt, ctx.endsAt, c.startsAt, c.endsAt),
    );
    if (!clash) return { passed: true };

    return {
      passed: false,
      detail: `חפיפה עם ${clash.label} ב-${fmtRange(clash.startsAt, clash.endsAt, ctx.timeZone)}`,
      facts: { conflictKind: clash.kind, conflictId: clash.id },
    };
  },
};
