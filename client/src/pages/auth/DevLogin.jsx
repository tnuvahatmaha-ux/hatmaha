import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Notice, Loading, ErrorState, Tag } from '../../components/ui/index.jsx';
import { ROLE_NAMES } from '../../lib/format.js';
import { BrandMark } from '../../components/layout/Brand.jsx';

const API = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

const ROLE_HINTS = {
  manager: 'רואה הכול: דשבורד, אתרים, בונה סידור, אישורים, הגדרות והרשאות',
  mentor: 'הצוות שלו, הדרכות, ואישור חריגות של המטמיעים שמשויכים אליו',
  lead: 'לו״ז, זמינות ובקשות, וצפייה בסידור ובצוות של האתר',
  implementer: 'הלו״ז האישי, הגשת זמינות ובקשות, לו״ז צוות',
};

/**
 * כניסה במצב פיתוח מקומי: בחירת משתמש דמו, בלי סיסמה.
 * זמין רק כשהלקוח רץ ב-Vite dev ו-VITE_AUTH_MODE=local, וכשהשרת רץ
 * עם AUTH_MODE=local — אחרת נתיב /dev/users כלל לא קיים.
 */
export default function DevLogin() {
  const { signInAs, isAuthenticated } = useAuth();
  const [state, setState] = useState({ loading: true, error: null, users: [] });

  const load = async () => {
    setState({ loading: true, error: null, users: [] });
    try {
      const res = await fetch(`${API}/dev/users`);
      if (res.status === 404) {
        throw Object.assign(new Error('השרת אינו במצב התחברות מקומי. יש להגדיר AUTH_MODE=local ב-server/.env ולהפעיל אותו מחדש.'), { code: 'E_CONFIG' });
      }
      if (!res.ok) throw new Error('טעינת משתמשי הדמו נכשלה');
      const data = await res.json();
      setState({ loading: false, error: null, users: data.users ?? [] });
    } catch (err) {
      const message = err instanceof TypeError
        ? 'אין חיבור לשרת. ודא/י שהשרת רץ: npm run dev:server'
        : err.message;
      setState({ loading: false, error: { code: err.code ?? 'E_NETWORK', message }, users: [] });
    }
  };

  useEffect(() => { load(); }, []);

  // החלפת משתמש תמיד מובילה למסך הבית: הנתיב שבו היה המשתמש הקודם
  // (למשל הגדרות) לרוב אינו רלוונטי, ואף חסום, עבור המשתמש החדש.
  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const byRole = ['manager', 'mentor', 'lead', 'implementer']
    .map((role) => [role, state.users.filter((u) => u.base_role === role)])
    .filter(([, users]) => users.length);

  return (
    <div className="auth-shell">
      <div className="auth-card" style={{ maxWidth: 520 }}>
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>המטמיעון</h1>
            <p className="small muted">כניסה במצב פיתוח מקומי</p>
          </div>
        </div>

        <Notice tone="warn" icon="🧪" title="מצב פיתוח — כניסה ללא סיסמה">
          <span className="small">
            בחר/י משתמש דמו כדי לראות את המערכת מנקודת המבט שלו. ההרשאות, החוקים
            וה-Audit פועלים בדיוק כמו בייצור — רק ההזדהות מקוצרת.
          </span>
        </Notice>

        {state.loading ? (
          <Loading text="טוען משתמשי דמו…" />
        ) : state.error ? (
          <ErrorState error={state.error} onRetry={load} />
        ) : state.users.length === 0 ? (
          <Notice icon="ℹ" title="אין משתמשים במסד">
            <span className="small">טעינת נתוני הדמו: <code>npm run db:reset</code></span>
          </Notice>
        ) : (
          <div className="stack">
            {byRole.map(([role, users]) => (
              <section key={role}>
                <div className="field-label">{ROLE_NAMES[role]}</div>
                <p className="tiny muted" style={{ marginBlockEnd: 6 }}>{ROLE_HINTS[role]}</p>
                <div className="stack" style={{ gap: 6 }}>
                  {users.map((user) => (
                    <button
                      key={user.id}
                      type="button"
                      className="btn"
                      onClick={() => signInAs(user.id)}
                      style={{ justifyContent: 'space-between', width: '100%' }}
                    >
                      <span>{user.full_name}</span>
                      {user.sites && <Tag>{user.sites}</Tag>}
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
