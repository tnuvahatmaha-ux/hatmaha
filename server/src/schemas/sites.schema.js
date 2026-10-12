import { z } from 'zod';
import { uuid, dateStr, timeStr, name, optionalText } from './common.schema.js';

const shiftCategory = z.enum(['morning', 'afternoon', 'night']);

const hoursOrder = (v) =>
  !v.openTime || !v.closeTime || v.closeTime > v.openTime;

export const siteBody = z
  .object({
    name,
    description: optionalText,
    statusCode: z.enum(['training', 'golive', 'support', 'ended']).default('training'),
    timezone: z.string().max(64).optional(),
    goLiveDate: dateStr.nullish(),
    openTime: timeStr.default('07:00'),
    closeTime: timeStr.default('23:00'),
    maxCannot: z.coerce.number().int().min(0).max(50).default(3),
    maxPreferNot: z.coerce.number().int().min(0).max(50).default(4),
    deadlineWeekday: z.coerce.number().int().min(0).max(6).nullish(),
    deadlineHour: z.coerce.number().int().min(0).max(23).nullish(),
  })
  .refine(hoursOrder, { message: 'שעת הסגירה חייבת להיות אחרי שעת הפתיחה', path: ['closeTime'] });

export const siteUpdateBody = z
  .object({
    name: name.optional(),
    description: optionalText,
    statusCode: z.enum(['training', 'golive', 'support', 'ended']).optional(),
    goLiveDate: dateStr.nullish(),
    openTime: timeStr.optional(),
    closeTime: timeStr.optional(),
    maxCannot: z.coerce.number().int().min(0).max(50).optional(),
    maxPreferNot: z.coerce.number().int().min(0).max(50).optional(),
    deadlineWeekday: z.coerce.number().int().min(0).max(6).nullish(),
    deadlineHour: z.coerce.number().int().min(0).max(23).nullish(),
    isArchived: z.boolean().optional(),
  })
  .refine(hoursOrder, { message: 'שעת הסגירה חייבת להיות אחרי שעת הפתיחה', path: ['closeTime'] });

export const shiftTypeBody = z.object({
  id: uuid.optional(),
  name,
  startTime: timeStr,
  endTime: timeStr,
  isMandatory: z.boolean().default(false),
  requiredStaff: z.coerce.number().int().min(0).max(99).default(1),
  domainId: uuid.nullish(),
  subCategoryId: uuid.nullish(),
  displayOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
  category: z.enum(['morning', 'afternoon', 'night']).nullish(),
  period: z.enum(['training', 'golive', 'support']).nullish(),
});
// שעת סיום זהה לשעת ההתחלה היא משמרת של 24 שעות, לא משמרת ריקה
export const shiftTypeRefined = shiftTypeBody.refine(
  (v) => v.startTime !== v.endTime,
  { message: 'שעת הסיום זהה לשעת ההתחלה', path: ['endTime'] },
);

export const locationBody = z.object({
  id: uuid.optional(),
  name,
  description: optionalText,
  locationTypeId: uuid.nullish(),
  capacity: z.coerce.number().int().min(1).max(9999).nullish(),
  isActive: z.boolean().optional(),
  periods: z.array(z.enum(['training', 'golive', 'support'])).min(1, 'יש לבחור לפחות שלב אחד').max(3).optional(),
  // סדר הסבב השבועי. null = המיקום אינו עובד בסבב
  rotationCycle: z
    .array(shiftCategory)
    .min(2, 'סבב שבועי צריך לפחות שני סוגי משמרת')
    .max(3)
    .refine((list) => new Set(list).size === list.length, 'סוג משמרת מופיע פעמיים בסבב')
    .nullish(),
});

export const rotationsBody = z.object({
  rotations: z
    .array(
      z.object({
        userId: uuid,
        locationId: uuid,
        anchorWeek: dateStr,
        anchorCategory: shiftCategory,
      }),
    )
    .max(500),
});

export const copyDomainBody = z.object({
  fromDomainId: uuid,
  toDomainId: uuid,
  targetSiteId: uuid.nullish(),
  locationIds: z.array(uuid).max(100).nullish(),
  period: z.enum(['training', 'golive', 'support']).nullish(),
  mode: z.enum(['merge', 'replace']).default('merge'),
});

export const periodsBody = z.object({
  periods: z
    .array(
      z
        .object({
          period: z.enum(['training', 'golive', 'support']),
          name: z.string().trim().max(120).nullish(),
          startsOn: dateStr,
          endsOn: dateStr,
        })
        .refine((p) => p.endsOn >= p.startsOn, {
          message: 'תאריך הסיום חייב להיות אחרי תאריך ההתחלה',
          path: ['endsOn'],
        }),
    )
    .max(10),
});
