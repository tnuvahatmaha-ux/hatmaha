import { useState } from 'react';
import { Link, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Notice } from '../../components/ui/index.jsx';
import { BrandMark } from '../../components/layout/Brand.jsx';

export default function Login() {
  const { signIn, isAuthenticated } = useAuth();
  const location = useLocation();

  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  if (isAuthenticated) {
    return <Navigate to={location.state?.from ?? '/'} replace />;
  }

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(form.email.trim(), form.password);
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
            <h1>המטמיעון</h1>
            <p className="small muted">התחברות למערכת</p>
          </div>
        </div>

        {error && <Notice tone="danger" icon="⚠">{error}</Notice>}

        <form onSubmit={submit} noValidate>
          <Field label="כתובת דוא״ל" required>
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

          <Field label="סיסמה" required>
            {(props) => (
              <input
                {...props}
                type="password"
                autoComplete="current-password"
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                required
              />
            )}
          </Field>

          <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
            {busy ? 'מתחבר…' : 'התחברות'}
          </button>
        </form>

        <div className="auth-links">
          <Link to="/forgot-password">שכחתי סיסמה</Link>
          <Link to="/register">הרשמה למערכת</Link>
        </div>
      </div>
    </div>
  );
}
