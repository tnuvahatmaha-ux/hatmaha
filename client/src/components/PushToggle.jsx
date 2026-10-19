import { useEffect, useState } from 'react';
import { useToast } from '../context/ToastContext.jsx';
import { post } from '../lib/api.js';
import { pushState, enablePush, disablePush, isIos } from '../lib/push.js';
import { Notice } from './ui/index.jsx';

/**
 * הפעלת התראות לטלפון במכשיר הנוכחי.
 * compact — באנר קטן למסך הבית, שמופיע רק כשההתראות עוד לא הופעלו.
 */
export function PushToggle({ compact = false }) {
  const toast = useToast();
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem('push-banner-dismissed') === '1'; } catch { return false; }
  });

  useEffect(() => { pushState().then(setState).catch(() => setState('unsupported')); }, []);

  const toggle = async (on) => {
    setBusy(true);
    try {
      if (on) {
        await enablePush();
        toast.success('התראות לטלפון הופעלו במכשיר הזה');
      } else {
        await disablePush();
        toast.success('התראות לטלפון כובו במכשיר הזה');
      }
      setState(await pushState());
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  if (!state) return null;

  if (compact) {
    if (dismissed || !['off', 'needs-install'].includes(state)) return null;
    const dismiss = () => {
      setDismissed(true);
      try { localStorage.setItem('push-banner-dismissed', '1'); } catch { /* אין אחסון — לא נורא */ }
    };
    return (
      <Notice icon="🔔" title="לקבל התראות לטלפון?">
        <div className="small">
          {state === 'needs-install'
            ? 'באייפון: לחיצה על כפתור השיתוף ⬆ ← "הוספה למסך הבית", ואז לפתוח את המטמיעון מהמסך הבית ולהפעיל כאן.'
            : 'הודעה חדשה, שינוי בלו״ז או החלטה בבקשה — יגיעו ישר לטלפון.'}
        </div>
        <div className="row mt-3" style={{ gap: 6 }}>
          {state === 'off' && (
            <button type="button" className="btn btn-primary btn-sm" onClick={() => toggle(true)} disabled={busy}>
              {busy ? 'מפעיל…' : 'הפעלת התראות'}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={dismiss}>לא עכשיו</button>
        </div>
      </Notice>
    );
  }

  return (
    <div className="stack" style={{ gap: 8 }}>
      {state === 'on' && (
        <div className="row" style={{ gap: 6 }}>
          <span className="small">✓ פעיל במכשיר הזה</span>
          <button type="button" className="btn btn-sm" onClick={() => post('/api/push/test').then(() => toast.success('נשלחה התראת ניסיון')).catch(toast.error)}>
            שליחת ניסיון
          </button>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => toggle(false)} disabled={busy}>כיבוי</button>
        </div>
      )}
      {state === 'off' && (
        <button type="button" className="btn btn-primary btn-sm" onClick={() => toggle(true)} disabled={busy} style={{ alignSelf: 'flex-start' }}>
          {busy ? 'מפעיל…' : 'הפעלת התראות לטלפון במכשיר הזה'}
        </button>
      )}
      {state === 'denied' && <span className="small muted">ההתראות חסומות בדפדפן. יש לאפשר אותן בהגדרות האתר ולרענן.</span>}
      {state === 'needs-install' && (
        <span className="small muted">
          באייפון: כפתור השיתוף ⬆ ← "הוספה למסך הבית", ואז לפתוח את המטמיעון מהמסך הבית ולהפעיל כאן.
        </span>
      )}
      {state === 'unsupported' && (
        <span className="small muted">
          {isIos() ? 'נדרשת גרסת iOS 16.4 ומעלה.' : 'הדפדפן הזה אינו תומך בהתראות.'}
        </span>
      )}
    </div>
  );
}
