import { DAY_NAMES_HE } from '../../lib/time.js';
import { fmtDate } from './_shared.js';

/**
 * כיסוי משמרות בעת פרסום.
 *
 * הפרוטוטייפ סימן חוסר כיסוי בצבע בלבד ולא מנע דבר; כאן זה חוק ככל חוק
 * אחר, וחומרתו נקבעת בהגדרות — אזהרה כברירת מחדל, אך ניתן להפוך לחוסם.
 */
export default {
  code: 'minStaffCoverage',
  evaluate(_ctx, _params, facts) {
    const gaps = (facts.coverage ?? []).filter((c) => c.assigned < c.required_staff);
    if (gaps.length === 0) return { passed: true };

    const shown = gaps.slice(0, 5).map((g) => {
      const day = DAY_NAMES_HE[new Date(`${g.assignment_date}T12:00:00Z`).getUTCDay()];
      return `${day} ${fmtDate(g.assignment_date)} ${g.location_name ?? ''} ${g.shift_name} ${g.assigned}/${g.required_staff}`.replace(/\s+/g, ' ');
    });
    const more = gaps.length > 5 ? ` ועוד ${gaps.length - 5}` : '';

    return {
      passed: false,
      detail: `חוסר כיסוי: ${shown.join(' · ')}${more}`,
      facts: { gapCount: gaps.length, gaps: gaps.slice(0, 20) },
    };
  },
};
