import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Notice } from '../../components/ui/index.jsx';
import { BrandMark } from '../../components/layout/Brand.jsx';

export default function Register() {
  const { signUp, isAuthenticated } = useAuth();

  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  if (isAuthenticated) return <Navigate to="/" replace />;

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
      const result = await signUp(form.email.trim(), form.password, form.fullName.trim());
      if (result.needsEmailConfirmation) setDone('confirm');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (done === 'confirm') {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <div className="state">
            <div className="state-icon" aria-hidden="true">📧</div>
            <div className="state-title">נשלח אליך מייל אימות</div>
            <div className="state-text">
              פתח/י את הקישור שנשלח אל {form.email} כדי להשלים את ההרשמה.
              אם המייל לא הגיע, בדוק/בדקי בתיקיית הספאם.
            </div>
            <Link to="/login" className="btn">חזרה להתחברות</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark />
          <div>
            <h1>הרשמה</h1>
            <p className="small muted">יצירת חשבון חדש במערכת</p>
          </div>
        </div>

        {error && <Notice tone="danger" icon="⚠">{error}</Notice>}

        <Notice icon="ℹ">
          <span className="small">
            התפקיד שלך נקבע לפי ההזמנה שמנהל ההטמעה יצר עבורך.
            המשתמש הראשון שנרשם למערכת נהיה מנהל ההטמעה.
          </span>
        </Notice>

        <form onSubmit={submit} noValidate>
          <Field label="שם מלא" required>
            {(props) => (
              <input
                {...props}
                type="text"
                autoComplete="name"
                value={form.fullName}
                onChange={(e) => setForm({ ...form, fullName: e.target.value })}
                required
              />
            )}
          </Field>

          <Field label="כתובת דוא״ל" required hint="יש להשתמש בכתובת שאליה נשלחה ההזמנה">
            {(props) => (
              <input
                {...props}
                type="email"
                autoComplete="username"
                dir="ltr"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                required
              />
            )}
          </Field>

          <Field label="סיסמה" required hint="8 תווים לפחות">
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
            {busy ? 'נרשם…' : 'הרשמה'}
          </button>
        </form>

        <div className="auth-links">
          <span className="muted">כבר יש לך חשבון?</span>
          <Link to="/login">התחברות</Link>
        </div>
      </div>
    </div>
  );
}
