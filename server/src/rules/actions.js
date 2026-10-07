import { AppError } from '../lib/errors.js';

/**
 * מרשם הפעולות שניתן לשחזר.
 *
 * זהו החצי השני של AC-10. כשחוק דורש אישור, הפעולה אינה מבוצעת ואז
 * מגולגלת אחורה — היא כלל אינה מבוצעת. היא נשמרת כ-JSON בעמודת
 * pending_action, ומשוחזרת כאן אחרי שהמאשר הכריע.
 *
 * כל service שמייצר חריגות רושם את המבצע שלו כאן, ולכן קיים נתיב ביצוע
 * אחד ויחיד — זה שרץ בהגשה הרגילה וזה שרץ אחרי אישור.
 */
const registry = new Map();

/**
 * @param {string} type  מזהה יציב שנשמר ב-DB, למשל 'roster.assign'
 * @param {(tx: object, payload: object, meta: object) => Promise<any>} handler
 */
export function registerAction(type, handler) {
  if (registry.has(type)) {
    throw new Error(`פעולה כפולה במרשם: ${type}`);
  }
  registry.set(type, handler);
}

export function hasAction(type) {
  return registry.has(type);
}

export async function runAction(tx, pendingAction, meta) {
  const { type, payload } = pendingAction ?? {};
  const handler = registry.get(type);

  if (!handler) {
    // גרסה ישנה של השרת שמרה פעולה שהקוד הנוכחי אינו מכיר
    throw new AppError(
      'E_STATE',
      'לא ניתן לבצע את הפעולה שאושרה — סוג הפעולה אינו מוכר עוד למערכת',
      { details: { type } },
    );
  }

  return handler(tx, payload ?? {}, meta ?? {});
}

export function registeredTypes() {
  return [...registry.keys()].sort();
}
