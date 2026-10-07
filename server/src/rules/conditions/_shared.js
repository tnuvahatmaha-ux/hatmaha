import { DEFAULT_TIMEZONE, utcToZonedParts } from '../../lib/time.js';

/** 'יום/חודש HH:MM–HH:MM' באזור הזמן העסקי */
export function fmtRange(startsAt, endsAt, timeZone = DEFAULT_TIMEZONE) {
  const s = utcToZonedParts(startsAt, timeZone);
  const e = utcToZonedParts(endsAt, timeZone);
  const [, month, day] = s.date.split('-');
  return `${day}/${month} ${s.time}–${e.time}`;
}

export function fmtDate(dateStr) {
  const [, month, day] = String(dateStr).split('-');
  return `${day}/${month}`;
}

/** עיגול לספרה אחת אחרי הנקודה, בלי לגרור אפסים מיותרים */
export const round1 = (n) => Math.round(n * 10) / 10;
