import { z } from 'zod';

export const uuid = z.string().uuid('מזהה אינו תקין');
export const scopeType = z.enum([
  'global', 'site', 'domain', 'sub_category', 'assigned_users', 'own_data',
]);
export const effect = z.enum(['allow', 'deny']);

export const grantBody = z
  .object({
    userId: uuid,
    permissionCode: z.string().min(3, 'יש לבחור הרשאה'),
    effect,
    scopeType,
    scopeId: uuid.nullish(),
    validFrom: z.string().datetime().nullish(),
    validTo: z.string().datetime().nullish(),
    reason: z.string().trim().max(500).nullish(),
  })
  // אותה בדיקה שקיימת כ-CHECK במסד. כאן היא מחזירה שם שדה, ולכן הלקוח
  // יכול לסמן את השדה הנכון במקום להציג הודעה כללית.
  .refine((v) => !['site', 'domain', 'sub_category'].includes(v.scopeType) || !!v.scopeId, {
    message: 'ה-Scope שנבחר מחייב בחירת ישות',
    path: ['scopeId'],
  })
  .refine((v) => v.effect === 'deny' || (v.reason ?? '').trim().length >= 5, {
    message: 'הרחבת הרשאה מחייבת ציון סיבה (5 תווים לפחות)',
    path: ['reason'],
  });

export const previewBody = z.object({
  userId: uuid,
  draftGrants: z
    .array(
      z.object({
        permissionCode: z.string().min(3),
        effect,
        scopeType,
        scopeId: uuid.nullish(),
        validTo: z.string().datetime().nullish(),
      }),
    )
    .max(20)
    .default([]),
});

export const revokeBody = z.object({
  reason: z.string().trim().max(500).optional(),
});
