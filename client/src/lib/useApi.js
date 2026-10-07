import { useCallback, useEffect, useRef, useState } from 'react';
import { get } from './api.js';

/**
 * טעינת נתונים ממסך.
 *
 * מחזיר את ארבעת המצבים ש-AC-14 דורש — loading, error, data, ורענון —
 * כך שכל מסך מקבל אותם בחינם ואין מסך שמציג ריק לבן כשמשהו נכשל.
 *
 * @param {string|null} path  null משהה את הטעינה (למשל עד שנבחר אתר)
 * @param {object} [query]
 */
export function useApi(path, query) {
  const [state, setState] = useState({ data: null, loading: !!path, error: null });
  const requestId = useRef(0);

  // השוואה לפי תוכן, כדי שאובייקט query חדש בכל רינדור לא יפיל לולאה
  const queryKey = JSON.stringify(query ?? null);

  const load = useCallback(async () => {
    if (!path) {
      setState({ data: null, loading: false, error: null });
      return;
    }

    const id = ++requestId.current;
    setState((s) => ({ ...s, loading: true, error: null }));

    try {
      const data = await get(path, query);
      // תשובה של בקשה שהוחלפה בינתיים נזרקת, כדי שלא תדרוס חדשה יותר
      if (id === requestId.current) setState({ data, loading: false, error: null });
    } catch (error) {
      if (id === requestId.current) setState({ data: null, loading: false, error });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, queryKey]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load, setData: (data) => setState((s) => ({ ...s, data })) };
}

/**
 * פעולה שהמשתמש מפעיל (שמירה, אישור, פרסום).
 * מנהלת busy ושגיאות שדה, כדי שכל טופס לא יכתוב את זה מחדש.
 */
export function useAction(handler, { onSuccess, onError } = {}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const run = useCallback(
    async (...args) => {
      setBusy(true);
      setError(null);
      try {
        const result = await handler(...args);
        onSuccess?.(result);
        return result;
      } catch (err) {
        setError(err);
        onError?.(err);
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [handler, onSuccess, onError],
  );

  return { run, busy, error, fieldErrors: error?.fieldErrors ?? {}, clearError: () => setError(null) };
}
