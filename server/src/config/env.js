import { z } from 'zod';

/**
 * משתני הסביבה מאומתים ברגע העלייה. שרת שעולה עם קונפיגורציה חסרה נופל
 * מיד עם הודעה ברורה, במקום להיכשל מאוחר יותר באמצע בקשה של משתמש.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(8080),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL חסר — ראה/י server/.env.example'),
  DB_SSL: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

  // supabase — אימות מול Supabase Auth (ברירת המחדל, והיחיד שמותר בייצור)
  // local   — התחברות מקומית ללא סיסמה, לפיתוח ולהדגמה בלבד
  AUTH_MODE: z.enum(['supabase', 'local']).default('supabase'),

  SUPABASE_URL: z.string().url('SUPABASE_URL אינו כתובת תקינה').optional(),
  SUPABASE_ANON_KEY: z.string().min(1, 'SUPABASE_ANON_KEY חסר').optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional().default(''),

  // כמה כתובות מופרדות בפסיק, כדי לאפשר localhost לצד כתובת הייצור
  CLIENT_URL: z.string().min(1).default('http://localhost:5173'),

  CRON_SECRET: z.string().optional().default(''),
}).superRefine((v, ctx) => {
  // התחברות מקומית מאפשרת לכל מי שמגיע לשרת להיכנס כל משתמש, בלי סיסמה.
  // לכן היא נחסמת כאן, בעלייה, ולא בבדיקה כלשהי בזמן ריצה שאפשר לפספס.
  if (v.AUTH_MODE === 'local' && v.NODE_ENV === 'production') {
    ctx.addIssue({
      code: 'custom',
      path: ['AUTH_MODE'],
      message: 'מצב התחברות מקומי אסור בייצור — השרת לא יעלה. יש להסיר את AUTH_MODE או להגדיר supabase',
    });
  }
  if (v.AUTH_MODE === 'supabase') {
    if (!v.SUPABASE_URL) ctx.addIssue({ code: 'custom', path: ['SUPABASE_URL'], message: 'SUPABASE_URL חסר' });
    if (!v.SUPABASE_ANON_KEY) ctx.addIssue({ code: 'custom', path: ['SUPABASE_ANON_KEY'], message: 'SUPABASE_ANON_KEY חסר' });
  }
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  • ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  console.error(`\n✗ קונפיגורציית הסביבה אינה תקינה:\n${issues}\n`);
  console.error('  העתק/י את server/.env.example ל-server/.env ומלא/י את הערכים.\n');
  process.exit(1);
}

const raw = parsed.data;

export const env = Object.freeze({
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  isLocalAuth: raw.AUTH_MODE === 'local',
  /** רשימת המקורות המורשים ל-CORS */
  clientOrigins: raw.CLIENT_URL.split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean),
});

// אזור הזמן מוגדר ב-lib/time.js, המודול היחיד שמתעסק בזמן, ומיוצא מחדש כאן
// לנוחות. אין לו כפילות: מקור אמת אחד.
export { DEFAULT_TIMEZONE } from '../lib/time.js';
