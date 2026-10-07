/**
 * הדרכת חובה הושלמה.
 *
 * נשען על activity_participants שממוטרל בזמן שמירה, ולכן זו בדיקה על
 * אינדקס ולא סריקה של קהלי יעד בזמן אמת.
 */
export default {
  code: 'mandatoryTraining',
  evaluate(ctx, params, facts) {
    const required = params.activityTypeId;
    if (!required || !ctx.targetUserId) return { passed: true };

    const completed = facts.completedTraining ?? [];
    if (completed.includes(required)) return { passed: true };

    const name = ctx.activityTypeNames?.[required] ?? 'הדרכת חובה';
    return {
      passed: false,
      detail: `טרם הושלמה ${name}`,
      facts: { activityTypeId: required },
    };
  },
};
