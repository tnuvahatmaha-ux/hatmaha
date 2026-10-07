import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { onServerWaking } from '../lib/api.js';

const ToastContext = createContext(null);

/**
 * הודעות צפות.
 *
 * שגיאה מציגה גם את מזהה המעקב — כך משתמש שפונה לתמיכה יכול למסור אותו,
 * ואפשר לאתר את האירוע בלוגים בלי לנחש.
 */
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [serverWaking, setServerWaking] = useState(false);

  useEffect(() => onServerWaking(setServerWaking), []);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((t) => t.id !== id));
  }, []);

  const push = useCallback(
    (toast) => {
      const id = crypto.randomUUID?.() ?? String(Date.now() + Math.random());
      const entry = { id, kind: 'info', ...toast };
      setToasts((current) => [...current, entry]);

      // שגיאה נשארת ארוך יותר: יש בה מה לקרוא ולהעתיק
      const ms = entry.kind === 'error' ? 9000 : 4000;
      setTimeout(() => dismiss(id), ms);
      return id;
    },
    [dismiss],
  );

  const value = useMemo(
    () => ({
      push,
      dismiss,
      success: (text) => push({ kind: 'ok', text }),
      info: (text) => push({ kind: 'info', text }),
      warn: (text) => push({ kind: 'warn', text }),
      /** מקבל ApiError ומציג את ההודעה שהשרת ניסח */
      error: (err) =>
        push({
          kind: 'error',
          text: err?.message ?? 'אירעה שגיאה בלתי צפויה',
          traceId: err?.traceId,
        }),
    }),
    [push, dismiss],
  );

  return (
    <ToastContext.Provider value={value}>
      {children}

      {serverWaking && (
        <div className="toasts" style={{ insetBlockEnd: 'auto', insetBlockStart: 16 }}>
          <div className="toast toast-warn" role="status">
            <span aria-hidden="true">⏳</span>
            <div>
              <div className="bold">השרת מתעורר, זה עשוי לקחת כמה שניות…</div>
              <div className="tiny muted">
                השירות החינמי נרדם אחרי חוסר פעילות. הבקשה תמשיך אוטומטית.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="toasts" aria-live="polite" aria-atomic="false">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.kind}`} role="status">
            <span aria-hidden="true">
              {{ ok: '✓', error: '✕', warn: '⚠', info: 'ℹ' }[toast.kind] ?? 'ℹ'}
            </span>
            <div style={{ flex: 1 }}>
              <div>{toast.text}</div>
              {toast.traceId && <div className="toast-trace">מזהה מעקב: {toast.traceId}</div>}
            </div>
            <button
              type="button"
              className="btn btn-ghost btn-icon btn-sm"
              onClick={() => dismiss(toast.id)}
              aria-label="סגירת ההודעה"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast חייב לרוץ בתוך ToastProvider');
  return ctx;
};
