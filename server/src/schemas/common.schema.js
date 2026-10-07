import { z } from 'zod';

export const uuid = z.string().uuid('מזהה אינו תקין');
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'תאריך חייב להיות בפורמט YYYY-MM-DD');
export const timeStr = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'שעה חייבת להיות בפורמט HH:MM');
export const name = z.string().trim().min(1, 'שדה חובה').max(200);
export const optionalText = z.string().trim().max(2000).nullish();
export const idParam = z.object({ id: uuid });

/** תאריך שהוא יום ראשון — שבועות הזמינות והסידור מתחילים בראשון */
export const sundayDate = dateStr.refine(
  (v) => new Date(`${v}T00:00:00Z`).getUTCDay() === 0,
  'השבוע חייב להתחיל ביום ראשון',
);

export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
