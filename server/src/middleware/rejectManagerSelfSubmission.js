import { AppError } from '../lib/errors.js';

/**
 * מנהל הטמעה אינו משובץ במשמרות, ולכן אינו מגיש זמינות או אילוצים לעצמו.
 * הגשה בשם אדם אחר (userId בגוף הבקשה) נשארת מותרת לו.
 */
export function rejectManagerSelfSubmission(req, _res, next) {
  const target = req.body?.userId ?? req.user.userId;
  if (req.user.baseRole === 'manager' && target === req.user.userId) {
    return next(new AppError('E_VALIDATION', 'מנהל הטמעה אינו מגיש זמינות או אילוצים לעצמו'));
  }
  next();
}
