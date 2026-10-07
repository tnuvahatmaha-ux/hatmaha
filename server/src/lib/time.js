/** אזור הזמן העסקי. אתר יחיד יכול לדרוס אותו דרך sites.timezone. */
export const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

/**
 * המודול היחיד במערכת שממיר בין זמן מקומי ל-UTC.
 *
 * הפרוטוטייפ השווה "דקות מחצות" כדי לזהות חפיפות, ולכן משמרת 22:00–06:00
 * נתנה 1320 < 360 → false, וכל חפיפת משמרת לילה התפספסה. התיקון יושב כאן,
 * בשורה אחת ב-toInstants, ועוד שכבה ב-DB דרך tstzrange + EXCLUDE.
 *
 * ריכוז ההמרה במקום אחד הוא מה שמונע מהבאג לחזור דרך call-site חדש.
 */

const MINUTE = 60_000;
const HOUR = 3_600_000;
export const DAY_MS = 86_400_000;

/** שמות הימים, אינדקס = Date#getDay */
export const DAY_NAMES_HE = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' מתוך Date, לפי רכיבי ה-UTC שלו */
export function toDateString(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/**
 * ההיסט של אזור הזמן ברגע נתון, במילישניות.
 * מחושב ע״י עיצוב הרגע באזור היעד וקריאתו בחזרה כאילו היה UTC.
 */
function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(instant)
    .reduce((acc, p) => {
      if (p.type !== 'literal') acc[p.type] = Number(p.value);
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour % 24,
    parts.minute,
    parts.second,
  );
  return asIfUtc - instant.getTime();
}

/**
 * ממיר שעון-קיר באזור זמן עסקי לרגע מוחלט (UTC).
 *
 * שני מעברים: הראשון מעריך את ההיסט, והשני מתקן אותו סביב מעבר שעון קיץ,
 * שבישראל נופל בסוף מרץ ובסוף אוקטובר — שניהם בתוך חלון Go-Live טיפוסי.
 *
 * @param {string} dateStr 'YYYY-MM-DD'
 * @param {string} timeStr 'HH:MM' או 'HH:MM:SS'
 * @param {string} [timeZone]
 * @returns {Date}
 */
export function zonedLocalToUtc(dateStr, timeStr, timeZone = DEFAULT_TIMEZONE) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const [hh = 0, mm = 0, ss = 0] = String(timeStr).split(':').map(Number);

  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) {
    throw new TypeError(`תאריך לא תקין: ${dateStr}`);
  }

  const naive = Date.UTC(y, m - 1, d, hh, mm, ss);
  let guess = new Date(naive - zoneOffsetMs(new Date(naive), timeZone));
  guess = new Date(naive - zoneOffsetMs(guess, timeZone));
  return guess;
}

/** ההפך: רגע מוחלט → { date: 'YYYY-MM-DD', time: 'HH:MM' } באזור העסקי */
export function utcToZonedParts(instant, timeZone = DEFAULT_TIMEZONE) {
  const local = new Date(instant.getTime() + zoneOffsetMs(instant, timeZone));
  return {
    date: toDateString(local),
    time: `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`,
    weekday: local.getUTCDay(),
  };
}

/**
 * ⭐ התיקון המרכזי: הופך תאריך + שעת התחלה + שעת סיום לשני רגעים מוחלטים.
 *
 * אם שעת הסיום אינה אחרי שעת ההתחלה, המשמרת חוצה חצות והסיום עובר ליום
 * שלמחרת. זו השורה שבלעדיה כל משמרת לילה נראית כאילו אורכה שלילי.
 *
 * @returns {{ startsAt: Date, endsAt: Date, crossesMidnight: boolean }}
 */
export function toInstants(dateStr, startTime, endTime, timeZone = DEFAULT_TIMEZONE) {
  const startsAt = zonedLocalToUtc(dateStr, startTime, timeZone);
  let endsAt = zonedLocalToUtc(dateStr, endTime, timeZone);
  let crossesMidnight = false;

  if (endsAt.getTime() <= startsAt.getTime()) {
    crossesMidnight = true;
    endsAt = zonedLocalToUtc(addDays(dateStr, 1), endTime, timeZone);
  }

  return { startsAt, endsAt, crossesMidnight };
}

/**
 * חפיפה על טווח חצי-פתוח [start, end).
 * כך 06:00–14:00 ו-14:00–22:00 צמודות ואינן חופפות — בדיוק כמו
 * ה-tstzrange '[)' שב-DB, ולכן שתי השכבות מסכימות תמיד.
 */
export function overlaps(aStart, aEnd, bStart, bEnd) {
  return ms(aStart) < ms(bEnd) && ms(bStart) < ms(aEnd);
}

const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());
export { ms as toMs };

/** הוספת ימים לתאריך *מקומי*. שכפול שבוע חייב לעבור דרך כאן: הוספת
 *  7×24 שעות לרגע UTC נשברת במעבר שעון קיץ. */
export function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return toDateString(shifted);
}

/** תחילת השבוע (יום ראשון) של תאריך נתון, כמחרוזת */
export function weekStartOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return toDateString(new Date(dt.getTime() - dt.getUTCDay() * DAY_MS));
}

/** שבעת ימי השבוע שמתחיל ב-weekStart */
export function weekDays(weekStart) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** היום, באזור הזמן העסקי */
export function today(timeZone = DEFAULT_TIMEZONE) {
  return utcToZonedParts(new Date(), timeZone).date;
}

/** תחילת השבוע הבא — השבוע שעליו מוצהרת הזמינות */
export function nextWeekStart(timeZone = DEFAULT_TIMEZONE) {
  return addDays(weekStartOf(today(timeZone)), 7);
}

/** משך בשעות בין שני רגעים */
export function hoursBetween(a, b) {
  return (ms(b) - ms(a)) / HOUR;
}

/** 'HH:MM' → דקות מחצות. לשימוש בהשוואת *שעות פתיחה*, שהן חוק ולא רגע. */
export function timeToMinutes(timeStr) {
  const [h = 0, m = 0] = String(timeStr).split(':').map(Number);
  return h * 60 + m;
}

/**
 * מועד ההגשה האחרון לשבוע נתון: יום ושעה בשבוע שלפניו.
 * למשל weekday=4 (חמישי) ו-hour=12 → חמישי 12:00 שלפני תחילת השבוע.
 */
export function deadlineForWeek(weekStart, weekday, hour, timeZone = DEFAULT_TIMEZONE) {
  const dayOffset = -(7 - Number(weekday));
  const date = addDays(weekStart, dayOffset);
  return zonedLocalToUtc(date, `${pad(Number(hour))}:00`, timeZone);
}

export { MINUTE, HOUR };
