/** עיצוב תאריכים, שעות ומספרים — במקום אחד, בעברית ובאזור הזמן העסקי. */

const TZ = 'Asia/Jerusalem';

export const DAY_NAMES = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
export const DAY_SHORT = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

const dt = (opts) => new Intl.DateTimeFormat('he-IL', { timeZone: TZ, ...opts });

/** 'YYYY-MM-DD' → '16/11' */
export function fmtDate(value) {
  if (!value) return '—';
  const [, month, day] = String(value).slice(0, 10).split('-');
  return `${day}/${month}`;
}

/** 'YYYY-MM-DD' → '16/11/2026' */
export function fmtDateFull(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  return `${day}/${month}/${year}`;
}

/** ISO → '16/11/26 09:30' */
export function fmtDateTime(iso) {
  if (!iso) return '—';
  return dt({
    day: '2-digit', month: '2-digit', year: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(iso));
}

/** ISO → '09:30' */
export function fmtTime(iso) {
  if (!iso) return '';
  return dt({ hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}

/** '09:30:00' → '09:30' */
export const fmtClock = (value) => (value ? String(value).slice(0, 5) : '');

/** ISO → 'לפני 5 דקות' */
export function fmtRelative(iso) {
  if (!iso) return '';
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60_000);

  if (minutes < 1) return 'עכשיו';
  if (minutes < 60) return `לפני ${minutes} דק׳`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `לפני ${hours} שע׳`;
  const days = Math.round(hours / 24);
  if (days < 30) return `לפני ${days} ימים`;
  return fmtDateFull(iso.slice(0, 10));
}

/** יום השבוע של 'YYYY-MM-DD' */
export const dayName = (date) => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()];
export const dayShort = (date) => DAY_SHORT[new Date(`${date}T12:00:00Z`).getUTCDay()];

/* ── אריתמטיקת תאריכים, זהה לזו שבשרת ── */

const pad = (n) => String(n).padStart(2, '0');

export function toDateString(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

export function addDays(dateStr, days) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return toDateString(new Date(Date.UTC(y, m - 1, d + days)));
}

/** תחילת השבוע — תמיד יום ראשון */
export function weekStartOf(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return toDateString(new Date(date.getTime() - date.getUTCDay() * 86_400_000));
}

export const weekDays = (weekStart) =>
  Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

export function today() {
  const parts = dt({ year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date())
    .reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export const nextWeekStart = () => addDays(weekStartOf(today()), 7);

/** '15/11 – 21/11' */
export const fmtWeekRange = (weekStart) =>
  `${fmtDate(weekStart)} – ${fmtDate(addDays(weekStart, 6))}`;

/* ── תרגומי ערכים ── */

export const ROLE_NAMES = {
  manager: 'מנהל הטמעה',
  mentor: 'מדריך',
  lead: 'מטמיע מוביל',
  implementer: 'מטמיע',
};

export const STATUS_NAMES = {
  invited: 'הוזמן',
  active: 'פעיל',
  suspended: 'מושבת',
  archived: 'בארכיון',
  draft: 'טיוטה',
  submitted: 'הוגש',
  approved: 'אושר',
  rejected: 'נדחה',
  cancelled: 'בוטל',
  pending: 'ממתין',
  pending_approval: 'ממתין לאישור',
  expired: 'פג תוקף',
  ok: 'תקין',
  superseded: 'הוחלף',
  published: 'פורסם',
  scheduled: 'מתוכנן',
  completed: 'הושלם',
};

export const SEVERITY_NAMES = {
  warning: 'אזהרה',
  approval_required: 'דורש אישור',
  blocking: 'חוסם',
};

export const SEVERITY_TONE = {
  warning: 'warn',
  approval_required: 'accent',
  blocking: 'danger',
};

export const TRIGGER_NAMES = {
  submit: 'הגשה',
  assign: 'שיבוץ',
  change: 'שינוי',
  publish: 'פרסום',
};

export const SCOPE_NAMES = {
  global: 'מערכת',
  site: 'אתר',
  domain: 'תחום',
  sub_category: 'תת-קטגוריה',
  assigned_users: 'משויכים אליי',
  own_data: 'מידע אישי',
  user: 'משתמש',
};

export const TARGET_NAMES = {
  any: 'הכל',
  constraint: 'אילוץ',
  availability: 'זמינות',
  activity: 'פעילות',
  roster: 'סידור',
  mentor_assignment: 'שיוך מדריך',
};

export const AVAIL_VALUES = {
  can: { label: 'יכול', glyph: '✓' },
  prefer_not: { label: 'מעדיף שלא', glyph: '?' },
  cannot: { label: 'לא יכול', glyph: '✕' },
};

export const statusTone = (status) => {
  if (['approved', 'active', 'ok', 'published', 'completed'].includes(status)) return 'ok';
  if (['rejected', 'blocking', 'suspended'].includes(status)) return 'danger';
  if (['submitted', 'pending', 'pending_approval', 'warning', 'invited'].includes(status)) return 'warn';
  return '';
};

/** ראשי תיבות לאווטאר */
export const initials = (name) =>
  (name ?? '?').trim().split(/\s+/).map((part) => part[0]).slice(0, 2).join('');
