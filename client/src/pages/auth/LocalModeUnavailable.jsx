import { Link } from 'react-router-dom';

/** הרשמה ואיפוס סיסמה אינם קיימים במצב פיתוח מקומי — אין Supabase */
export default function LocalModeUnavailable() {
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="state">
          <div className="state-icon" aria-hidden="true">🧪</div>
          <div className="state-title">לא זמין במצב פיתוח מקומי</div>
          <div className="state-text">
            במצב הזה אין הרשמה ואין סיסמאות — נכנסים כאחד ממשתמשי הדמו.
          </div>
          <Link to="/login" className="btn btn-primary">לבחירת משתמש</Link>
        </div>
      </div>
    </div>
  );
}
