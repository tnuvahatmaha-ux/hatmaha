/**
 * שיבוץ רק בזמינות שהוצהרה.
 *
 * שלושה מצבים, ולא שניים:
 *   • לא הוגשה הצהרה לשבוע כלל  → נכשל ("לא הוצהרה זמינות")
 *   • הוגשה, ואין תא חופף         → "יכול" (ברירת המחדל אינה נשמרת) → עובר
 *   • הוגשה, ויש תא חופף          → לפי הערך המחמיר שבו
 *
 * הבחנה שנשמרה מהפרוטוטייפ: "לא יכול" שהמנהל טרם הכריע בו הוא אזהרה
 * ולא חסימה — אחרת בקשת אישור מיוחד שממתינה בתור הייתה מקפיאה את הסידור.
 * חומרת החוק נקבעת בהגדרות; כאן נקבע רק אם הוא הופר.
 */
export default {
  code: 'availabilityRequired',
  evaluate(ctx, _params, facts) {
    if (!ctx.startsAt) return { passed: true };

    const availability = facts.availability;
    if (!availability?.declared) {
      return { passed: false, detail: 'לא הוגשה הצהרת זמינות לשבוע הזה', facts: { declared: false } };
    }
    if (availability.worst === 'can') return { passed: true };

    const label = availability.worst === 'cannot' ? 'לא יכול' : 'מעדיף שלא';
    const pending = availability.status === 'pending_approval' ? ' (ממתין לאישור)' : '';
    return {
      passed: false,
      detail: `המטמיע סימן "${label}" לשעות האלה${pending}`,
      facts: { value: availability.worst, status: availability.status },
    };
  },
};
