import { z } from 'zod';
import { uuid, dateStr, timeStr, name, optionalText } from './common.schema.js';

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
