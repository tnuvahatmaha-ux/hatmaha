import { createClient } from '@supabase/supabase-js';
import { isLocalAuth } from './authMode.js';

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!isLocalAuth && (!url || !anonKey)) {
  // נופל מוקדם ובבירור, במקום להיכשל בהתחברות הראשונה עם שגיאה סתומה
  throw new Error(
    'חסרים VITE_SUPABASE_URL או VITE_SUPABASE_ANON_KEY. ' +
      'העתק/י את client/.env.example ל-client/.env ומלא/י את הערכים.',
  );
}

/**
 * לקוח Supabase — לאימות בלבד.
 *
 * כל הנתונים עוברים דרך שרת ה-API, שם רצים מנוע ההרשאות, מנוע החוקיות
 * ויומן הביקורת. RLS חוסמת ממילא כמעט כל קריאה ישירה עם ה-anon key.
 *
 * במצב התחברות מקומי אין Supabase כלל, והערך הוא null.
 */
export const supabase = isLocalAuth
  ? null
  : createClient(url, anonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
