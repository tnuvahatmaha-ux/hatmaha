/**
 * שגיאות היישום.
 *
 * §13 מחייב שכל שגיאה תחזיר קוד יציב, הודעה ידידותית ומזהה מעקב — וללא
 * Stack Trace. הקודים כאן הם החוזה עם הלקוח: הם יציבים, והלקוח רשאי
 * להסתמך עליהם כדי להחליט מה להציג.
 */
export class AppError extends Error {
  /**
   * @param {string} code    קוד יציב, למשל E_RULE_BLOCKED
   * @param {string} message הודעה בעברית שמוצגת למשתמש כמות שהיא
   * @param {object} [opts]
   * @param {number} [opts.status] קוד HTTP
   * @param {object} [opts.details] מידע נוסף מובנֶה ללקוח (לא רגיש)
   * @param {Error}  [opts.cause]
   */
  constructor(code, message, opts = {}) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = opts.status ?? STATUS_BY_CODE[code] ?? 400;
    this.details = opts.details;
    this.expected = true; // שגיאה צפויה: נרשמת כ-warn ולא כ-error
  }
}

const STATUS_BY_CODE = {
  E_VALIDATION: 400,
  E_UNAUTHENTICATED: 401,
  E_FORBIDDEN: 403,
  E_NOT_FOUND: 404,
  E_CONFLICT: 409,
  E_DUPLICATE: 409,
  E_STATE: 409,
  E_RULE_BLOCKED: 422,
  E_PENDING_APPROVAL: 202,
  E_INVALID_ASSIGNMENT: 422,
  E_READ_ONLY: 409,
  E_IDEMPOTENCY_IN_PROGRESS: 409,
  E_RATE_LIMITED: 429,
  E_UNEXPECTED: 500,
};

/* קיצורים לשימוש נוח באתרי הקריאה */
export const badRequest = (msg, details) => new AppError('E_VALIDATION', msg, { details });
export const unauthenticated = (msg = 'נדרשת התחברות') => new AppError('E_UNAUTHENTICATED', msg);
export const forbidden = (msg = 'אין לך הרשאה לבצע פעולה זו', details) =>
  new AppError('E_FORBIDDEN', msg, { details });
export const notFound = (msg = 'הפריט המבוקש לא נמצא') => new AppError('E_NOT_FOUND', msg);
export const conflict = (msg, details) => new AppError('E_CONFLICT', msg, { details });
export const duplicate = (msg) => new AppError('E_DUPLICATE', msg);
export const invalidState = (msg) => new AppError('E_STATE', msg);
export const ruleBlocked = (msg, details) => new AppError('E_RULE_BLOCKED', msg, { details });
export const readOnly = (msg) => new AppError('E_READ_ONLY', msg);

/**
 * ממפה שגיאות Postgres להודעות בעברית.
 *
 * חלק ניכר מכללי העסק נאכפים ב-DB (EXCLUDE, CHECK, טריגרים), ולכן המיפוי
 * הזה הוא מה שהופך אכיפה במסד להודעה מובנת למשתמש — במקום 500 סתמי.
 */
const CONSTRAINT_MESSAGES = {
  // חפיפות
  ra_no_overlap: ['E_RULE_BLOCKED', 'לא ניתן לשבץ — המטמיע כבר משובץ בטווח השעות הזה'],
  cr_no_duplicate_active: ['E_DUPLICATE', 'קיימת כבר בקשה פעילה מאותו סוג בטווח הזה'],
  site_assignments_no_overlap: ['E_DUPLICATE', 'קיים כבר שיוך פעיל של המשתמש לאתר הזה'],
  mentor_assign_no_overlap: ['E_DUPLICATE', 'קיים כבר שיוך פעיל בין המדריך למטמיע הזה'],
  mentor_assign_one_primary: [
    'E_INVALID_ASSIGNMENT',
    'למטמיע כבר משויך מדריך ראשי — יש לסיים את השיוך הקיים תחילה',
  ],
  site_periods_no_overlap: ['E_VALIDATION', 'תקופות האתר חופפות זו לזו'],

  // ייחודיות
  sites_name_idx: ['E_DUPLICATE', 'כבר קיים אתר בשם הזה'],
  domains_name_idx: ['E_DUPLICATE', 'כבר קיים תחום בשם הזה'],
  sub_categories_name_idx: ['E_DUPLICATE', 'כבר קיימת תת-קטגוריה בשם הזה בתחום'],
  locations_name_idx: ['E_DUPLICATE', 'כבר קיים מיקום בשם הזה באתר'],
  shift_types_location_name_idx: ['E_DUPLICATE', 'כבר קיימת משמרת בשם הזה במיקום'],
  avail_cells_window_unique: ['E_DUPLICATE', 'אותו חלון שעות סומן פעמיים באותו יום'],
  location_types_name_idx: ['E_DUPLICATE', 'כבר קיים סוג מיקום בשם הזה'],
  profiles_email_key: ['E_DUPLICATE', 'כתובת הדוא״ל כבר קיימת במערכת'],
  avail_current_idx: ['E_DUPLICATE', 'כבר קיימת הצהרת זמינות לשבוע הזה'],
  roster_one_draft_idx: ['E_DUPLICATE', 'כבר קיימת טיוטת סידור פתוחה לשבוע הזה'],
  user_domains_one_primary_idx: ['E_VALIDATION', 'ניתן להגדיר תחום ראשי אחד בלבד'],
  qualifications_live_idx: ['E_DUPLICATE', 'למשתמש כבר קיימת הסמכה בתת-הקטגוריה הזו'],
  permission_grants_natural_idx: ['E_DUPLICATE', 'ההרשאה הזו כבר הוענקה למשתמש'],

  // בדיקות
  grant_reason_required: ['E_VALIDATION', 'הרחבת הרשאה מחייבת ציון סיבה'],
  grant_scope_shape: ['E_VALIDATION', 'ה-Scope שנבחר מחייב בחירת ישות מתאימה'],
  grant_window: ['E_VALIDATION', 'תאריך סיום התוקף חייב להיות אחרי תאריך ההתחלה'],
  exception_decision_comment: ['E_VALIDATION', 'החלטה מחייבת נימוק'],
  rules_approver_required: ['E_VALIDATION', 'חוק שדורש אישור חייב מאשר מוגדר'],
  rules_scope_shape: ['E_VALIDATION', 'רמת החוק שנבחרה מחייבת בחירת ישות'],
  avail_week_starts_sunday: ['E_VALIDATION', 'שבוע הזמינות חייב להתחיל ביום ראשון'],
  roster_week_starts_sunday: ['E_VALIDATION', 'שבוע הסידור חייב להתחיל ביום ראשון'],
  ra_order: ['E_VALIDATION', 'שעת הסיום חייבת להיות אחרי שעת ההתחלה'],
  cr_order: ['E_VALIDATION', 'שעת הסיום חייבת להיות אחרי שעת ההתחלה'],
  activities_order: ['E_VALIDATION', 'שעת הסיום חייבת להיות אחרי שעת ההתחלה'],
  sites_hours: ['E_VALIDATION', 'שעת הסגירה חייבת להיות אחרי שעת הפתיחה'],
  mentor_assign_not_self: ['E_INVALID_ASSIGNMENT', 'לא ניתן לשייך מדריך לעצמו'],
};

/** חריגות שטריגרים ב-DB זורקים במפורש */
const RAISED_MESSAGES = {
  ROSTER_VERSION_READ_ONLY: ['E_READ_ONLY', 'גרסת הסידור פורסמה ואינה ניתנת לשינוי'],
  ROSTER_SNAPSHOT_IMMUTABLE: ['E_READ_ONLY', 'צילום הגרסה שפורסמה אינו ניתן לשינוי'],
  AVAILABILITY_DECLARATION_READ_ONLY: [
    'E_READ_ONLY',
    'ההצהרה כבר הוכרעה — יש להגיש הצהרה חדשה במקום לערוך אותה',
  ],
  APPEND_ONLY_TABLE: ['E_READ_ONLY', 'רשומות ביקורת אינן ניתנות לשינוי או למחיקה'],
  SHIFT_LOCATION_NOT_FOUND: ['E_VALIDATION', 'המיקום של המשמרת לא נמצא'],
  CANNOT_DENY_PERMISSIONS_MANAGE: [
    'E_VALIDATION',
    'לא ניתן לשלול את ההרשאה לנהל הרשאות — המערכת הייתה הופכת לבלתי ניתנת לניהול',
  ],
};

/**
 * הופך שגיאת pg ל-AppError. מחזיר null אם אין התאמה, וכך המטפל המרכזי
 * יטפל בה כשגיאה בלתי צפויה.
 */
export function mapDatabaseError(err) {
  if (!err || typeof err !== 'object') return null;

  const raised = RAISED_MESSAGES[err.message];
  if (raised) return new AppError(raised[0], raised[1], { cause: err });

  const name = err.constraint;
  if (name && CONSTRAINT_MESSAGES[name]) {
    const [code, message] = CONSTRAINT_MESSAGES[name];
    return new AppError(code, message, { cause: err, details: { constraint: name } });
  }

  switch (err.code) {
    case '23505': // unique_violation
      return new AppError('E_DUPLICATE', 'הרשומה כבר קיימת במערכת', { cause: err });
    case '23P01': // exclusion_violation
      return new AppError('E_CONFLICT', 'הפעולה מתנגשת ברשומה קיימת', { cause: err });
    case '23503': // foreign_key_violation
      return new AppError('E_VALIDATION', 'אחד מהפריטים שנבחרו אינו קיים', { cause: err });
    case '23514': // check_violation
      return new AppError('E_VALIDATION', 'הנתונים שהוזנו אינם עומדים בכללי המערכת', { cause: err });
    case '22P02': // invalid_text_representation
      return new AppError('E_VALIDATION', 'אחד מהערכים שנשלחו אינו בפורמט תקין', { cause: err });
    case '40001': // serialization_failure
      return new AppError('E_CONFLICT', 'הרשומה עודכנה במקביל — נסה/י שוב', { cause: err });
    default:
      return null;
  }
}
