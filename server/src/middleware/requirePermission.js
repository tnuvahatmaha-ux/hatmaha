import { decide } from '../permissions/engine.js';
import { AppError } from '../lib/errors.js';
import { recordDenial } from '../audit/service.js';

/**
 * אכיפת הרשאה על נתיב.
 *
 * זהו middleware ולא קריאה בתוך ה-handler, בכוונה: נתיב שנשכח בלי אכיפה
 * בולט מיד בקריאת routes/, ובדיקת הכיסוי ב-tests/route-coverage.test.js
 * נכשלת עליו. זה מה שהופך את AC-04 לניתן לאימות ולא רק להבטחה.
 *
 * @param {string} resource
 * @param {string} action
 * @param {(req: import('express').Request) => Promise<object>|object} [scopeResolver]
 *        מחזיר את ההקשר לבדיקת ה-Scope. בלעדיו הבדיקה היא "האם אי־פעם מותר לי",
 *        ומתאימה רק לנתיבים שממילא מסננים בעצמם לפי ה-Scope של המשתמש.
 */
export function requirePermission(resource, action, scopeResolver) {
  const middleware = async (req, _res, next) => {
    try {
      const ctx = scopeResolver ? (await scopeResolver(req)) ?? {} : {};
      const decision = decide(req.user, resource, action, ctx);

      if (!decision.allowed) {
        // כל סירוב נרשם ב-Audit. §16 דורש כיסוי בדיקות אבטחה לגישה ישירה
        // ול-IDOR, וללא התיעוד הזה אי אפשר לזהות ניסיון כזה בדיעבד.
        await recordDenial(req, { resource, action, ctx, reason: decision.reason });

        throw new AppError('E_FORBIDDEN', denialMessage(decision.reason), {
          details: { resource, action, reason: decision.reason },
        });
      }

      req.permissionCtx = ctx;
      next();
    } catch (err) {
      next(err);
    }
  };

  // מסומן כדי שבדיקת כיסוי ההרשאות תוכל לזהות נתיב מוגן
  middleware.__permission = { resource, action };
  return middleware;
}

function denialMessage(reason) {
  switch (reason) {
    case 'הפריט נמצא מחוץ לתחום האחריות שלך':
      return 'הפריט המבוקש נמצא מחוץ לתחום האחריות שלך';
    case 'ההרשאה נשללה במפורש':
      return 'ההרשאה לפעולה זו נשללה עבורך';
    case 'המשתמש אינו פעיל':
      return 'חשבון המשתמש אינו פעיל';
    default:
      return 'אין לך הרשאה לבצע פעולה זו';
  }
}

/**
 * נתיבים שרק מנהל הטמעה רשאי לגעת בהם (§3.1: "רק מנהל הטמעה רשאי לנהל הרשאות").
 *
 * הסירוב נרשם ב-Audit בדיוק כמו סירוב הרשאה רגיל. בלי זה, שומר הסף הזה
 * היה עוקף את התיעוד — וניסיון גישה ישירה לנתיבי הרשאות, בדיוק מה ש-§16
 * מבקש לכסות, לא היה מותיר עקבות.
 */
export async function requireManager(req, _res, next) {
  if (req.user?.baseRole === 'manager') return next();

  await recordDenial(req, {
    resource: 'permissions',
    action: 'manage',
    ctx: {},
    reason: 'הפעולה שמורה למנהל הטמעה',
  });
  next(new AppError('E_FORBIDDEN', 'הפעולה שמורה למנהל הטמעה בלבד'));
}

/** נתיבי /internal/cron — סוד משותף, לא טוקן משתמש */
export function requireCronSecret(req, _res, next) {
  const secret = req.get('x-cron-secret');
  const expected = process.env.CRON_SECRET;

  if (!expected) {
    return next(new AppError('E_FORBIDDEN', 'משימות מתוזמנות אינן מוגדרות בשרת'));
  }
  if (!secret || secret.length !== expected.length) {
    return next(new AppError('E_UNAUTHENTICATED', 'סוד משימה שגוי'));
  }
  // השוואה בזמן קבוע, כדי לא לדלוף את הסוד דרך תזמון
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= secret.charCodeAt(i) ^ expected.charCodeAt(i);
  if (diff !== 0) return next(new AppError('E_UNAUTHENTICATED', 'סוד משימה שגוי'));

  next();
}
