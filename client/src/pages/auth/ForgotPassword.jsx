import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';
import { Field, Notice } from '../../components/ui/index.jsx';
import { BrandMark } from '../../components/layout/Brand.jsx';

export default function ForgotPassword() {
  const { requestPasswordReset } = useAuth();
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await requestPasswordReset(email.trim());
      setSent(true);
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
            <h1>איפוס סיסמה</h1>
            <p className="small muted">נשלח אליך קישור לאיפוס</p>
          </div>
        </div>

        {sent ? (
          <div className="state">
            <div className="state-icon" aria-hidden="true">📧</div>
            <div className="state-title">הקישור נשלח</div>
            <div className="state-text">
              אם הכתובת {email} רשומה במערכת, יישלח אליה קישור לאיפוס הסיסמה.
              הקישור תקף לשעה אחת.
            </div>
            <Link to="/login" className="btn">חזרה להתחברות</Link>
          </div>
        ) : (
          <>
            {error && <Notice tone="danger" icon="⚠">{error}</Notice>}

            <form onSubmit={submit} noValidate>
              <Field label="כתובת דוא״ל" required>
                {(props) => (
                  <input
                    {...props}
                    type="email"
                    autoComplete="username"
                    dir="ltr"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                  />
                )}
              </Field>

              <button type="submit" className="btn btn-primary" disabled={busy} style={{ width: '100%', justifyContent: 'center' }}>
                {busy ? 'שולח…' : 'שליחת קישור לאיפוס'}
              </button>
            </form>

            <div className="auth-links">
              <Link to="/login">חזרה להתחברות</Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
