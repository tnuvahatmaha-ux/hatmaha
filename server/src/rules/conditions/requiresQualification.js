/**
 * דרישת הסמכה.
 *
 * בלי פרמטר — נבדקות תתי-הקטגוריות של השיבוץ עצמו. עם פרמטר — נבדקת
 * ההסמכה המסוימת שהחוק דורש.
 */
export default {
  code: 'requiresQualification',
  evaluate(ctx, params, facts) {
    const required = params.subCategoryId
      ? [params.subCategoryId]
      : (ctx.subCategoryIds ?? []);
    if (required.length === 0) return { passed: true };

    const held = new Map((facts.qualifications ?? []).map((q) => [q.sub_category_id, q.name]));
    const missing = required.filter((id) => !held.has(id));
    if (missing.length === 0) return { passed: true };

    const names = missing.map((id) => ctx.subCategoryNames?.[id] ?? 'תת-קטגוריה').join(', ');
    return {
      passed: false,
      detail: `חסרה הסמכה: ${names}`,
      facts: { missing },
    };
  },
};
