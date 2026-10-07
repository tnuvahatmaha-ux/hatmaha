/** מקסימום בקשות אילוץ פעילות באותו שבוע */
export default {
  code: 'maxConstraintsPerWeek',
  evaluate(ctx, params, facts) {
    const limit = Number(params.count);
    if (!Number.isFinite(limit)) return { passed: true };

    const existing = facts.constraintsThisWeek ?? 0;
    const withThis = existing + 1;
    if (withThis <= limit) return { passed: true };

    return {
      passed: false,
      detail: `זו הבקשה ה-${withThis} באותו שבוע, מעל המקסימום של ${limit}`,
      facts: { count: withThis, limit },
    };
  },
};
