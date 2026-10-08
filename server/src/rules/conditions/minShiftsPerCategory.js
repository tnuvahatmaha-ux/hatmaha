/**
 * מינימום משמרות "זמין" בהגשת זמינות, לפי סוג משמרת ובסוף השבוע.
 * פרמטר 0 או חסר — אותו סוג אינו נבדק.
 */
const LABELS = { morning: 'בוקר', afternoon: 'צהריים', night: 'לילה', weekend: 'סוף שבוע' };

export default {
  code: 'minShiftsPerCategory',
  evaluate(_ctx, params, facts) {
    const counts = facts.availabilityCounts;
    if (!counts) return { passed: true };

    const missing = [];
    for (const [key, label] of Object.entries(LABELS)) {
      const min = Number(params[key]) || 0;
      if (min > 0 && (counts[key] ?? 0) < min) missing.push(`${label} ${counts[key] ?? 0}/${min}`);
    }
    if (missing.length === 0) return { passed: true };

    return {
      passed: false,
      detail: `חסרות משמרות זמינות: ${missing.join(' · ')}`,
      facts: { counts, params },
    };
  },
};
