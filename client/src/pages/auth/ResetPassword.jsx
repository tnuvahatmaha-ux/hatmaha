import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Notice } from '../../components/ui/index.jsx';
import { BrandMark } from '../../components/layout/Brand.jsx';

export default function ResetPassword() {
  const { updatePassword, isAuthenticated, loading } = useAuth();
  const navigate = useNavigate();

  const [form, setForm] = useState({ password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  // Supabase ממיר את הקישור מהמייל ל-session זמני. אם אין אחד כזה,
  // הגענו לכאן בלי קישור תקף.
  const [linkValid, setLinkValid] = useState(null);
  useEffect(() => {
    if (loading) return;
    setLinkValid(isAuthenticated);
  }, [isAuthenticated, loading]);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);

    if (form.password !== form.confirm) {
      setError('הסיסמאות אינן זהות');
      return;
    }
    if (form.password.length < 8) {
      setError('הסיסמה חייבת להכיל 8 תווים לפחות');
      return;
    }

    setBusy(true);
    try {
      await updatePassword(form.password);
      setDone(true);
      setTimeout(() => navigate('/'), 1800);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>סיסמה חדשה</h1>
            <p className="small muted">בחר/י סיסמה חדשה לחשבון</p>
          </div>
        </div>

        {done ? (
          <div className="state">
            <div className="state-icon" aria-hidden="true">✓</div>
            <div className="state-title">הסיסמה עודכנה</div>
            <div className="state-text">מעביר אותך למערכת…</div>
          </div>
        ) : linkValid === false ? (
          <div className="state">
            <div className="state-icon" aria-hidden="true">🔗</div>
            <div className="state-title">הקישור אינו תקף</div>
            <div className="state-text">
              ייתכן שפג תוקפו או שכבר נעשה בו שימוש. אפשר לבקש קישור חדש.
            </div>
            <Link to="/forgot-password" className="btn">בקשת קישור חדש</Link>
          </div>
        ) : (
          <>
            {error && <Notice tone="danger" icon="⚠">{error}</Notice>}

            <form onSubmit={submit} noValidate>
              <Field label="סיסמה חדשה" required hint="8 תווים לפחות">
                {(props) => (
                  <input
                    {...props}
                    type="password"
                    autoComplete="new-password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    required
                    minLength={8}
                  />
                )}
              </Field>

              <Field label="אימות סיסמה" required>
                {(props) => (
                  <input
                    {...props}
                    type="password"
                    autoComplete="new-password"
                    value={form.confirm}
                    onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                    required
                  />
                )}
              </Field>

              <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? 'מעדכן…' : 'עדכון סיסמה'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
