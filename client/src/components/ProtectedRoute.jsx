import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { Loading } from './ui/index.jsx';

/** מפנה להתחברות, ושומר לאן המשתמש ניסה להגיע */
export function ProtectedRoute({ children }) {
  const { isAuthenticated, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div className="auth-shell">
        <Loading text="בודק הרשאות…" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return children;
}

/** מסך שדורש הרשאה מסוימת */
export function RequirePermission({ resource, action, children }) {
  const { can, loading } = usePermissions();
  if (loading) return <Loading />;
  if (!can(resource, action)) {
    return (
      <div className="state">
        <div className="state-icon" aria-hidden="true">🔒</div>
        <div className="state-title">אין לך הרשאה למסך הזה</div>
        <div className="state-text">פנה/י למנהל ההטמעה אם נדרשת לך גישה.</div>
      </div>
    );
  }
  return children;
}
