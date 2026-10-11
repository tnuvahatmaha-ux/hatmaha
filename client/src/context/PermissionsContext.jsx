import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { get, post } from '../lib/api.js';
import { useAuth } from './AuthContext.jsx';

const PermissionsContext = createContext(null);

/**
 * הפרופיל וההרשאות האפקטיביות של המשתמש המחובר.
 *
 * ה-capabilities משמשות להסתרת פריטי ניווט וכפתורים. זו נוחות בלבד:
 * השרת בודק כל בקשה מחדש, ולכן הסתרה בלקוח אינה אכיפה (AC-04).
 */
export function PermissionsProvider({ children }) {
  const { isAuthenticated, loading: authLoading } = useAuth();

  const [state, setState] = useState({
    loading: true,
    error: null,
    me: null,
    capabilities: {},
  });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const [me, perms] = await Promise.all([
        get('/api/auth/me'),
        get('/api/auth/effective-permissions'),
      ]);
      setState({ loading: false, error: null, me, capabilities: perms.capabilities ?? {} });
    } catch (error) {
      setState({ loading: false, error, me: null, capabilities: {} });
    }
  }, []);

  useEffect(() => {
    if (authLoading) return;
    if (!isAuthenticated) {
      setState({ loading: false, error: null, me: null, capabilities: {} });
      return;
    }
    load();
  }, [isAuthenticated, authLoading, load]);

  /** רענון מפורש — אחרי שינוי הרשאות או שיוך */
  const refresh = useCallback(async () => {
    await post('/api/auth/refresh').catch(() => {});
    await load();
  }, [load]);

  const can = useCallback(
    (resource, action) => {
      const actions = state.capabilities[resource];
      if (!actions) return false;
      return actions.includes(action) || actions.includes('manage');
    },
    [state.capabilities],
  );

  const value = useMemo(
    () => ({
      ...state,
      profile: state.me?.profile ?? null,
      role: state.me?.profile?.base_role ?? null,
      sites: state.me?.sites ?? [],
      domains: state.me?.domains ?? [],
      mentors: state.me?.mentors ?? [],
      missingAssignments: state.me?.missingAssignments ?? [],
      // מנהל הטמעה אינו משובץ, ולכן אינו מגיש זמינות או אילוצים לעצמו
      submitsAvailability: state.me?.submitsAvailability ?? true,
      missingMigrations: state.me?.missingMigrations ?? [],
      can,
      refresh,
      reload: load,
    }),
    [state, can, refresh, load],
  );

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>;
}

export const usePermissions = () => {
  const ctx = useContext(PermissionsContext);
  if (!ctx) throw new Error('usePermissions חייב לרוץ בתוך PermissionsProvider');
  return ctx;
};
