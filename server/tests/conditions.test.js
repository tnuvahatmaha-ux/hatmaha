import { describe, it, expect } from 'vitest';
import { conditionRegistry, conditionCodes } from '../src/rules/registry.js';
import { toInstants } from '../src/lib/time.js';

const TZ = 'Asia/Jerusalem';
const run = (code, ctx, params = {}, facts = {}) =>
  conditionRegistry.get(code).evaluate({ timeZone: TZ, ...ctx }, params, facts);

const shift = (date, from, to) => {
  const { startsAt, endsAt } = toInstants(date, from, to, TZ);
  return { startsAt, endsAt };
};
const commitment = (date, from, to, extra = {}) => ({
  ...shift(date, from, to),
  kind: 'shift',
  label: 'משמרת בוקר',
  countsAsWork: true,
  ...extra,
});

describe('המרשם', () => {
  it('מכיל בדיוק 14 סוגי תנאים', () => {
    expect(conditionCodes).toHaveLength(14);
  });
  it('כל תנאי חושף code ו-evaluate', () => {
    for (const [code, mod] of conditionRegistry) {
      expect(mod.code).toBe(code);
      expect(typeof mod.evaluate).toBe('function');
    }
  });
});

describe('noOverlap', () => {
  it('עובר כשאין חפיפה', () => {
    const r = run('noOverlap', shift('2026-11-16', '06:00', '14:00'), {}, {
      commitments: [commitment('2026-11-16', '15:00', '22:00')],
    });
    expect(r.passed).toBe(true);
  });

  it('נכשל על חפיפה חלקית', () => {
    const r = run('noOverlap', shift('2026-11-16', '06:00', '14:00'), {}, {
      commitments: [commitment('2026-11-16', '13:00', '20:00')],
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('חפיפה');
  });

  it('⭐ תופס חפיפה של משמרת לילה עם הבוקר שאחריה', () => {
    const r = run('noOverlap', shift('2026-11-17', '05:00', '13:00'), {}, {
      commitments: [commitment('2026-11-16', '22:00', '06:00', { label: 'משמרת לילה' })],
    });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('משמרת לילה');
  });

  it('משמרות צמודות אינן חפיפה', () => {
    const r = run('noOverlap', shift('2026-11-16', '14:00', '22:00'), {}, {
      commitments: [commitment('2026-11-16', '06:00', '14:00')],
    });
    expect(r.passed).toBe(true);
  });
});

describe('maxHoursPerDay', () => {
  it('סופר רק שעות עבודה — אילוץ אינו נספר', () => {
    const r = run('maxHoursPerDay', shift('2026-11-16', '06:00', '14:00'), { hours: 10 }, {
      commitments: [commitment('2026-11-16', '15:00', '20:00', { countsAsWork: false })],
    });
    expect(r.passed).toBe(true);
  });

  it('נכשל כשסך השעות חורג', () => {
    const r = run('maxHoursPerDay', shift('2026-11-16', '06:00', '14:00'), { hours: 10 }, {
      commitments: [commitment('2026-11-16', '15:00', '20:00')],
    });
    expect(r.passed).toBe(false);
    expect(r.facts.total).toBe(13);
  });
});

describe('minRestHours', () => {
  it('נכשל כשהמנוחה קצרה מהנדרש', () => {
    const r = run('minRestHours', shift('2026-11-17', '06:00', '14:00'), { hours: 8 }, {
      commitments: [commitment('2026-11-16', '14:00', '23:00', { label: 'משמרת ערב' })],
    });
    expect(r.passed).toBe(false);
    expect(r.facts.actual).toBe(7);
  });

  it('עובר כשהמנוחה מספקת', () => {
    const r = run('minRestHours', shift('2026-11-17', '06:00', '14:00'), { hours: 8 }, {
      commitments: [commitment('2026-11-16', '06:00', '14:00')],
    });
    expect(r.passed).toBe(true);
  });
});

describe('maxConsecutiveHours', () => {
  it('משמרת לילה נמדדת כ-8 שעות ולא כמספר שלילי', () => {
    expect(run('maxConsecutiveHours', shift('2026-11-16', '22:00', '06:00'), { hours: 9 }).passed).toBe(true);
    const r = run('maxConsecutiveHours', shift('2026-11-16', '20:00', '08:00'), { hours: 9 });
    expect(r.passed).toBe(false);
    expect(r.facts.duration).toBe(12);
  });
});

describe('withinSiteHours', () => {
  const site = { name: 'אתר צפון', open_time: '07:00:00', close_time: '23:00:00', timezone: TZ };

  it('עובר בתוך שעות האתר', () => {
    expect(run('withinSiteHours', shift('2026-11-16', '09:00', '17:00'), {}, { site }).passed).toBe(true);
  });

  it('נכשל כשמתחילים לפני הפתיחה', () => {
    const r = run('withinSiteHours', shift('2026-11-16', '06:00', '14:00'), {}, { site });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('07:00');
  });

  it('משמרת שחוצה חצות נכשלת באתר עם חלון פעילות מוגבל', () => {
    const r = run('withinSiteHours', shift('2026-11-16', '22:00', '06:00'), {}, { site });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('חוצה חצות');
  });

  it('משמרת שחוצה חצות מותרת באתר שפעיל מסביב לשעון', () => {
    const roundTheClock = { ...site, open_time: '00:00:00', close_time: '23:59:00' };
    expect(
      run('withinSiteHours', shift('2026-11-16', '22:00', '06:00'), {}, { site: roundTheClock }).passed,
    ).toBe(true);
  });
});

describe('minNoticeDays', () => {
  const inDays = (n) => new Date(Date.now() + n * 86_400_000);

  it('עובר עם הודעה מספקת', () => {
    expect(run('minNoticeDays', { startsAt: inDays(5) }, { days: 3 }).passed).toBe(true);
  });
  it('נכשל עם הודעה קצרה', () => {
    const r = run('minNoticeDays', { startsAt: inDays(1) }, { days: 3 });
    expect(r.passed).toBe(false);
    expect(r.facts.required).toBe(3);
  });
});

describe('maxConstraintsPerWeek', () => {
  it('סופר את הבקשה הנוכחית בנוסף לקיימות', () => {
    expect(run('maxConstraintsPerWeek', {}, { count: 2 }, { constraintsThisWeek: 1 }).passed).toBe(true);
    const r = run('maxConstraintsPerWeek', {}, { count: 2 }, { constraintsThisWeek: 2 });
    expect(r.passed).toBe(false);
    expect(r.facts.count).toBe(3);
  });
});

describe('requiresQualification', () => {
  const facts = { qualifications: [{ sub_category_id: 'sc-1', name: 'סיעוד' }] };

  it('עובר כשההסמכה קיימת', () => {
    expect(run('requiresQualification', { subCategoryIds: ['sc-1'] }, {}, facts).passed).toBe(true);
  });
  it('נכשל כשההסמכה חסרה', () => {
    const r = run('requiresQualification', { subCategoryIds: ['sc-2'], subCategoryNames: { 'sc-2': 'רופאים' } }, {}, facts);
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('רופאים');
  });
  it('פרמטר מפורש גובר על תתי-הקטגוריות של השיבוץ', () => {
    expect(run('requiresQualification', { subCategoryIds: ['sc-2'] }, { subCategoryId: 'sc-1' }, facts).passed).toBe(true);
  });
});

describe('mentorRatio', () => {
  it('סופר את השיוך הנוכחי', () => {
    expect(run('mentorRatio', { mentorUserId: 'm1' }, { max: 4 }, { mentorLoad: 3 }).passed).toBe(true);
    expect(run('mentorRatio', { mentorUserId: 'm1' }, { max: 4 }, { mentorLoad: 4 }).passed).toBe(false);
  });
  it('אינו חל כשאין מדריך בהקשר', () => {
    expect(run('mentorRatio', {}, { max: 1 }, { mentorLoad: 99 }).passed).toBe(true);
  });
});

describe('mandatoryTraining', () => {
  it('עובר כשההדרכה הושלמה', () => {
    const r = run('mandatoryTraining', { targetUserId: 'u1' }, { activityTypeId: 'at-1' }, { completedTraining: ['at-1'] });
    expect(r.passed).toBe(true);
  });
  it('נכשל כשלא', () => {
    const r = run('mandatoryTraining',
      { targetUserId: 'u1', activityTypeNames: { 'at-1': 'הדרכת אבטחת מידע' } },
      { activityTypeId: 'at-1' }, { completedTraining: [] });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('הדרכת אבטחת מידע');
  });
});

describe('availabilityRequired', () => {
  const base = shift('2026-11-16', '06:00', '14:00');

  it('עובר כשהוצהר "יכול"', () => {
    expect(run('availabilityRequired', base, {}, { availability: { value: 'can', status: 'ok' } }).passed).toBe(true);
  });
  it('נכשל כשלא הוצהר דבר', () => {
    expect(run('availabilityRequired', base, {}, { availability: null }).passed).toBe(false);
  });
  it('מבחין בין "לא יכול" מוכרע לבין ממתין לאישור', () => {
    const decided = run('availabilityRequired', base, {}, { availability: { value: 'cannot', status: 'ok' } });
    const pending = run('availabilityRequired', base, {}, { availability: { value: 'cannot', status: 'pending_approval' } });
    expect(decided.detail).not.toContain('ממתין');
    expect(pending.detail).toContain('ממתין');
  });
});

describe('deadline', () => {
  it('עובר לפני המועד ונכשל אחריו', () => {
    const farFuture = new Date(Date.now() + 90 * 86_400_000).toISOString().slice(0, 10);
    const pastWeek = '2020-01-05'; // ראשון בעבר
    expect(run('deadline', { weekStart: farFuture }, { weekday: 4, hour: 12 }).passed).toBe(true);
    const r = run('deadline', { weekStart: pastWeek }, { weekday: 4, hour: 12 });
    expect(r.passed).toBe(false);
    expect(r.detail).toContain('מועד ההגשה נסגר');
  });
});

describe('blackoutDates', () => {
  it('נכשל בתוך הטווח, כולל יום הסיום', () => {
    const p = { from: '2026-11-16', to: '2026-11-18' };
    expect(run('blackoutDates', shift('2026-11-17', '09:00', '12:00'), p).passed).toBe(false);
    expect(run('blackoutDates', shift('2026-11-18', '22:00', '23:00'), p).passed).toBe(false);
    expect(run('blackoutDates', shift('2026-11-19', '09:00', '12:00'), p).passed).toBe(true);
  });
});

describe('minStaffCoverage', () => {
  it('עובר כשכל המשמרות מאוישות', () => {
    const coverage = [{ assignment_date: '2026-11-16', shift_name: 'בוקר', required_staff: 2, assigned: 2 }];
    expect(run('minStaffCoverage', {}, {}, { coverage }).passed).toBe(true);
  });
  it('מדווח על החוסרים ומגביל את האורך', () => {
    const coverage = Array.from({ length: 8 }, (_, i) => ({
      assignment_date: `2026-11-${16 + i}`, shift_name: 'בוקר', required_staff: 2, assigned: 0,
    }));
    const r = run('minStaffCoverage', {}, {}, { coverage });
    expect(r.passed).toBe(false);
    expect(r.facts.gapCount).toBe(8);
    expect(r.detail).toContain('ועוד 3');
  });
});
