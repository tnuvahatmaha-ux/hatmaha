import { env } from '../config/env.js';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { loadPrincipal } from '../permissions/repository.js';

/**
 * אימות טוקן מול Supabase Auth, וטעינת ההרשאות האפקטיביות של המשתמש.
 *
 * האימות נעשה מול נקודת הקצה /auth/v1/user ולא ע״י אימות חתימה מקומי,
 * משום שפרויקטי Supabase שונים חותמים בסוד סימטרי או במפתח אסימטרי,
 * והשאילתה הזו נכונה לשניהם. כדי לא לשלם קריאת רשת בכל בקשה, התוצאה
 * נשמרת בקאש קצר, שחסום ממילא ע״י תפוגת הטוקן עצמו.
 */

const TOKEN_TTL_MS = 60_000;
const tokenCache = new Map(); // token -> { at, expMs, user }

/** קריאת exp מתוך ה-JWT בלי לאמת חתימה — רק כדי לפסול טוקן שפג מוקדם */
function readExpiry(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

async function verifyWithSupabase(token) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { Authorization: `Bearer ${token}`, apikey: env.SUPABASE_ANON_KEY },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) {
    logger.error('אימות מול Supabase נכשל', { status: res.status });
    throw new AppError('E_UNEXPECTED', 'שירות ההזדהות אינו זמין כעת', { status: 503 });
  }
  return res.json();
}

function extractToken(req) {
  const header = req.get('authorization') ?? '';
  const [scheme, value] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && value ? value.trim() : null;
}

/** מנקה ערכים שפגו, כדי שהקאש לא יגדל בלי גבול */
function prune() {
  const now = Date.now();
  for (const [token, entry] of tokenCache) {
    if (now - entry.at > TOKEN_TTL_MS || (entry.expMs && entry.expMs < now)) tokenCache.delete(token);
  }
}

export async function requireAuth(req, _res, next) {
  const token = extractToken(req);
  if (!token) {
    return next(new AppError('E_UNAUTHENTICATED', 'נדרשת התחברות כדי לגשת למידע הזה'));
  }

  if (env.isLocalAuth) return localAuth(token, req, next);

  const expMs = readExpiry(token);
  if (expMs && expMs < Date.now()) {
    tokenCache.delete(token);
    return next(new AppError('E_UNAUTHENTICATED', 'פג תוקף ההתחברות — יש להתחבר מחדש'));
  }

  try {
    let authUser;
    const cached = tokenCache.get(token);

    if (cached && Date.now() - cached.at < TOKEN_TTL_MS) {
      authUser = cached.user;
    } else {
      authUser = await verifyWithSupabase(token);
      if (!authUser?.id) {
        tokenCache.delete(token);
        return next(new AppError('E_UNAUTHENTICATED', 'ההתחברות אינה תקפה — יש להתחבר מחדש'));
      }
      if (tokenCache.size > 500) prune();
      tokenCache.set(token, { at: Date.now(), expMs, user: authUser });
    }

    // הפרופיל וההרשאות — מקור האמת הוא המסד, לא הטוקן.
    // כך השבתת משתמש או שינוי הרשאה נכנסים לתוקף בלי להמתין לחידוש טוקן.
    const principal = await loadPrincipal(authUser.id);

    if (!principal) {
      return next(
        new AppError('E_FORBIDDEN', 'לא נמצא פרופיל משתמש במערכת — פנה/י למנהל ההטמעה'),
      );
    }
    if (principal.status !== 'active') {
      return next(new AppError('E_FORBIDDEN', 'חשבון המשתמש אינו פעיל — פנה/י למנהל ההטמעה'));
    }

    req.user = principal;
    req.authEmail = authUser.email;
    next();
  } catch (err) {
    next(err);
  }
}

/** מנקה טוקן מהקאש — נקרא כשמשתמש מושבת, כדי שהשינוי יהיה מיידי */
export function forgetToken(token) {
  if (token) tokenCache.delete(token);
  else tokenCache.clear();
}

/**
 * מצב פיתוח מקומי: הטוקן הוא 'local:<מזהה משתמש>', בלי סיסמה ובלי Supabase.
 *
 * זמין רק כש-AUTH_MODE=local, ו-config/env.js מסרב להעלות את השרת במצב
 * הזה בייצור. מעבר לזה, השרת מאזין אז רק ל-127.0.0.1 (ראה index.js).
 * מכאן ואילך הכול זהה למצב הרגיל: אותו Principal, אותו מנוע הרשאות.
 */
const LOCAL_TOKEN = /^local:([0-9a-f-]{36})$/i;

async function localAuth(token, req, next) {
  const match = token.match(LOCAL_TOKEN);
  if (!match) {
    return next(new AppError('E_UNAUTHENTICATED', 'ההתחברות אינה תקפה — יש להתחבר מחדש'));
  }

  try {
    const principal = await loadPrincipal(match[1]);
    if (!principal) {
      return next(new AppError('E_UNAUTHENTICATED', 'משתמש הדמו לא נמצא — ייתכן שהמסד אופס. יש להתחבר מחדש'));
    }
    if (principal.status !== 'active') {
      return next(new AppError('E_FORBIDDEN', 'חשבון המשתמש אינו פעיל — פנה/י למנהל ההטמעה'));
    }
    req.user = principal;
    req.authEmail = principal.email;
    next();
  } catch (err) {
    next(err);
  }
}
