/**
 * ערכי סביבה לבדיקות.
 * מוגדרים לפני כל import, כדי ש-config/env.js לא יפיל את התהליך.
 * בדיקות שנוגעות במסד אמיתי מדלגות על עצמן כש-TEST_DATABASE_URL אינו מוגדר.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'error';
process.env.DATABASE_URL ??= process.env.TEST_DATABASE_URL ?? 'postgresql://localhost/none';
process.env.SUPABASE_URL ??= 'https://test.supabase.co';
process.env.SUPABASE_ANON_KEY ??= 'test-anon-key';
process.env.CLIENT_URL ??= 'http://localhost:5173';
process.env.CRON_SECRET ??= 'test-cron-secret';
