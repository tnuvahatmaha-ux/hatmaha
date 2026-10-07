import { describe, it, expect } from 'vitest';
import {
  toInstants,
  overlaps,
  zonedLocalToUtc,
  utcToZonedParts,
  addDays,
  weekStartOf,
  weekDays,
  deadlineForWeek,
  hoursBetween,
} from '../src/lib/time.js';

const TZ = 'Asia/Jerusalem';

describe('zonedLocalToUtc', () => {
  it('ממיר שעון חורף (UTC+2)', () => {
    // 1 בינואר 2026, 09:00 בישראל = 07:00 UTC
    expect(zonedLocalToUtc('2026-01-01', '09:00', TZ).toISOString()).toBe('2026-01-01T07:00:00.000Z');
  });

  it('ממיר שעון קיץ (UTC+3)', () => {
    // 1 ביולי 2026, 09:00 בישראל = 06:00 UTC
    expect(zonedLocalToUtc('2026-07-01', '09:00', TZ).toISOString()).toBe('2026-07-01T06:00:00.000Z');
  });

  it('הלוך ושוב שומר על שעון הקיר', () => {
    for (const [date, time] of [
      ['2026-01-15', '06:00'],
      ['2026-03-29', '14:00'], // סביב מעבר לשעון קיץ
      ['2026-07-04', '22:30'],
      ['2026-10-25', '03:30'], // סביב חזרה לשעון חורף
    ]) {
      const back = utcToZonedParts(zonedLocalToUtc(date, time, TZ), TZ);
      expect(`${back.date} ${back.time}`).toBe(`${date} ${time}`);
    }
  });
});

describe('toInstants — הבאג של משמרת הלילה', () => {
  it('משמרת יום נשארת באותו תאריך', () => {
    const r = toInstants('2026-11-16', '06:00', '14:00', TZ);
    expect(r.crossesMidnight).toBe(false);
    expect(hoursBetween(r.startsAt, r.endsAt)).toBe(8);
  });

  it('משמרת לילה 22:00–06:00 מסתיימת למחרת, לא באורך שלילי', () => {
    const r = toInstants('2026-11-16', '22:00', '06:00', TZ);
    expect(r.crossesMidnight).toBe(true);
    expect(hoursBetween(r.startsAt, r.endsAt)).toBe(8);
    expect(r.endsAt.getTime()).toBeGreaterThan(r.startsAt.getTime());
  });

  it('משמרת לילה חופפת למשמרת בוקר של למחרת — מה שהפרוטוטייפ פספס', () => {
    const night = toInstants('2026-11-16', '22:00', '06:00', TZ); // עד 17/11 06:00
    const morning = toInstants('2026-11-17', '05:00', '13:00', TZ); // מ-17/11 05:00

    // הבדיקה שהייתה בפרוטוטייפ: דקות מחצות
    const legacy = (a1, a2, b1, b2) => {
      const min = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
      return min(a1) < min(b2) && min(b1) < min(a2);
    };
    expect(legacy('22:00', '06:00', '05:00', '13:00')).toBe(false); // ⟵ הבאג

    expect(overlaps(night.startsAt, night.endsAt, morning.startsAt, morning.endsAt)).toBe(true);
  });

  it('משמרות צמודות אינן חופפות — טווח חצי פתוח', () => {
    const a = toInstants('2026-11-16', '06:00', '14:00', TZ);
    const b = toInstants('2026-11-16', '14:00', '22:00', TZ);
    expect(overlaps(a.startsAt, a.endsAt, b.startsAt, b.endsAt)).toBe(false);
  });

  it('משמרת לילה שומרת על 8 שעות גם כשהיא חוצה מעבר שעון', () => {
    // בישראל השעון מוקדם בסוף אוקטובר: הלילה הזה נמשך 9 שעות שעון-קיר
    const r = toInstants('2026-10-24', '22:00', '06:00', TZ);
    expect(r.crossesMidnight).toBe(true);
    expect(hoursBetween(r.startsAt, r.endsAt)).toBeGreaterThanOrEqual(8);
  });
});

describe('אריתמטיקת שבועות', () => {
  it('addDays עובד על תאריך מקומי וחוצה מעבר שעון בלי להיסחף', () => {
    expect(addDays('2026-10-23', 7)).toBe('2026-10-30'); // מעבר שעון באמצע
    expect(addDays('2026-03-26', 7)).toBe('2026-04-02');
    expect(addDays('2026-12-28', 7)).toBe('2027-01-04'); // מעבר שנה
  });

  it('weekStartOf מחזיר תמיד יום ראשון', () => {
    expect(weekStartOf('2026-11-18')).toBe('2026-11-15'); // רביעי → ראשון
    expect(weekStartOf('2026-11-15')).toBe('2026-11-15'); // ראשון נשאר
    expect(new Date(`${weekStartOf('2026-07-04')}T00:00:00Z`).getUTCDay()).toBe(0);
  });

  it('weekDays מחזיר שבעה ימים רצופים', () => {
    const d = weekDays('2026-11-15');
    expect(d).toHaveLength(7);
    expect(d[0]).toBe('2026-11-15');
    expect(d[6]).toBe('2026-11-21');
  });
});

describe('deadlineForWeek', () => {
  it('חמישי 12:00 שלפני תחילת השבוע', () => {
    // שבוע שמתחיל ראשון 15/11/2026 → חמישי שלפניו הוא 12/11/2026
    const dl = deadlineForWeek('2026-11-15', 4, 12, TZ);
    const parts = utcToZonedParts(dl, TZ);
    expect(parts.date).toBe('2026-11-12');
    expect(parts.time).toBe('12:00');
    expect(parts.weekday).toBe(4); // חמישי
  });
});
