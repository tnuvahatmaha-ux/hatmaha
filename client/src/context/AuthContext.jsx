import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { supabase } from '../lib/supabase.js';
import { isLocalAuth, getLocalUserId, setLocalUserId, localToken } from '../lib/authMode.js';

const AuthContext = createContext(null);

/**
 * מצב ההזדהות.
 *
 * ה-session מנוהל ע״י Supabase; הפרופיל וההרשאות מגיעים מהשרת
 * (PermissionsContext), משום שהמסד הוא מקור האמת ולא הטוקן — כך השבתת
 * משתמש או שינוי הרשאה נכנסים לתוקף בלי להמתין לחידוש טוקן.
 */
export function AuthProvider({ children }) {
  return isLocalAuth ? (
    <LocalAuthProvider>{children}</LocalAuthProvider>
  ) : (
    <SupabaseAuthProvider>{children}</SupabaseAuthProvider>
  );
}

const localSession = (userId) =>
  userId ? { access_token: localToken(userId), user: { id: userId } } : null;

/**
 * מצב פיתוח מקומי: "כניסה כ..." מתוך רשימת משתמשי הדמו, בלי סיסמה.
 * אותו ממשק בדיוק כמו במצב הרגיל, כך ששאר האפליקציה לא יודעת על ההבדל.
 */
function LocalAuthProvider({ children }) {
  const [session, setSession] = useState(() => localSession(getLocalUserId()));

  const signInAs = useCallback((userId) => {
    setLocalUserId(userId);
    setSession(localSession(userId));
  }, []);

  const signOut = useCallback(async () => {
    setLocalUserId(null);
    setSession(null);
  }, []);

  const unavailable = useCallback(async () => {
    throw new Error('הפעולה אינה זמינה במצב פיתוח מקומי');
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading: false,
      isAuthenticated: !!session,
      isLocalAuth: true,
      signInAs,
      signIn: unavailable,
      signUp: unavailable,
      signOut,
      requestPasswordReset: unavailable,
      updatePassword: unavailable,
    }),
    [session, signInAs, signOut, unavailable],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

function SupabaseAuthProvider({ children }) {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session ?? null);
      setLoading(false);
    });

    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next ?? null);
      setLoading(false);
    });

    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signIn = useCallback(async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw translate(error);
  }, []);

  const signUp = useCallback(async (email, password, fullName) => {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { data: { full_name: fullName } },
    });
    if (error) throw translate(error);
    // כשאימות מייל פעיל, אין session עד שהמשתמש מאשר את הקישור
    return { needsEmailConfirmation: !data.session };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const requestPasswordReset = useCallback(async (email) => {
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/reset-password`,
    });
    if (error) throw translate(error);
  }, []);

  const updatePassword = useCallback(async (password) => {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) throw translate(error);
  }, []);

  const value = useMemo(
    () => ({
      session,
      user: session?.user ?? null,
      loading,
      isAuthenticated: !!session,
      isLocalAuth: false,
      signIn,
      signUp,
      signOut,
      requestPasswordReset,
      updatePassword,
    }),
    [session, loading, signIn, signUp, signOut, requestPasswordReset, updatePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** כתובת Supabase שהיא עדיין ערך הדמה מ-.env.example */
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL ?? '';
const isPlaceholderUrl = /example|xxxxxxxx/i.test(SUPABASE_URL);

/** הודעות Supabase מגיעות באנגלית; כאן הן הופכות לעברית מובנת */
function translate(error) {
  const message = error?.message ?? '';

  // שגיאת רשת: הדפדפן לא קיבל תשובה משירות ההזדהות.
  // בפיתוח מסבירים גם את הסיבה הסבירה, כדי שלא יישאר "Failed to fetch" סתום.
  const isNetwork =
    error?.name === 'AuthRetryableFetchError' ||
    /failed to fetch|networkerror|load failed/i.test(message);

  if (isNetwork) {
    const hint =
      import.meta.env.DEV && isPlaceholderUrl
        ? ' (פיתוח: VITE_SUPABASE_URL ב-client/.env עדיין מצביע על כתובת דמה — יש להזין את כתובת פרויקט ה-Supabase)'
        : '';
    const translated = new Error(`אין חיבור לשירות ההזדהות. בדוק/בדקי את החיבור לאינטרנט ונסה/י שוב.${hint}`);
    translated.original = message;
    return translated;
  }
  const map = [
    ['Invalid login credentials', 'כתובת הדוא״ל או הסיסמה שגויים'],
    ['Email not confirmed', 'יש לאשר את כתובת הדוא״ל דרך הקישור שנשלח אליך'],
    ['User already registered', 'כתובת הדוא״ל כבר רשומה במערכת'],
    ['Password should be at least', 'הסיסמה קצרה מדי — נדרשים 6 תווים לפחות'],
    ['Unable to validate email address', 'כתובת הדוא״ל אינה תקינה'],
    ['For security purposes', 'נשלחה בקשה לאחרונה. נסה/י שוב בעוד רגע.'],
    ['Email rate limit exceeded', 'נשלחו יותר מדי מיילים. נסה/י שוב בעוד כמה דקות.'],
    ['same as the old password', 'הסיסמה החדשה זהה לקודמת'],
  ];

  const hit = map.find(([needle]) => message.includes(needle));
  const translated = new Error(hit ? hit[1] : message || 'ההתחברות נכשלה');
  translated.original = message;
  return translated;
}

export const useAuth = () => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth חייב לרוץ בתוך AuthProvider');
  return ctx;
};
