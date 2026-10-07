/** יחס מדריך למטמיעים */
export default {
  code: 'mentorRatio',
  evaluate(ctx, params, facts) {
    if (!ctx.mentorUserId) return { passed: true };
    const limit = Number(params.max);
    if (!Number.isFinite(limit)) return { passed: true };

    const withThis = (facts.mentorLoad ?? 0) + 1;
    if (withThis <= limit) return { passed: true };

    return {
      passed: false,
      detail: `למדריך יהיו ${withThis} מטמיעים, מעל המקסימום של ${limit}`,
      facts: { count: withThis, limit },
    };
  },
};
