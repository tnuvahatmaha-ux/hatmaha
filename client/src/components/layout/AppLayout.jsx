import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { usePermissions } from '../../context/PermissionsContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { get } from '../../lib/api.js';
import { ROLE_NAMES, initials } from '../../lib/format.js';
import { Loading, ErrorState } from '../ui/index.jsx';

/**
 * תפריט הניווט.
 *
 * כל פריט מצהיר על ההרשאה שהוא דורש, ומוצג רק אם יש אותה בפועל. זו
 * נוחות: השרת בודק שוב בכל בקשה, והנתיב עצמו מוגן גם אם מישהו יקליד
 * אותו ישירות.
 */
const NAV = [
  { to: '/', label: 'בית', icon: '🏠', end: true },
  { to: '/dashboard', label: 'דשבורד', icon: '📊', need: ['reports', 'view'], roles: ['manager'] },
  { to: '/schedule', label: 'הלו״ז שלי', icon: '🗓️' },
  { to: '/team-schedule', label: 'לו״ז צוות', icon: '👥', need: ['teamSchedule', 'view'] },
  { to: '/my-team', label: 'הצוות שלי', icon: '🎓', need: ['implementers', 'view'], roles: ['mentor'] },
  { to: '/requests', label: 'בקשות וזמינות', icon: '📝', need: ['requests', 'create'] },
  { to: '/approvals', label: 'בקשות ואישורים', icon: '✅', need: ['requests', 'approve'] },
  { to: '/activities', label: 'פעילויות והדרכות', icon: '📚', need: ['activities', 'view'] },
  { to: '/roster', label: 'בונה סידור', icon: '🧩', need: ['roster', 'edit'] },
  { to: '/sites', label: 'אתרים', icon: '🏥', need: ['sites', 'edit'] },
  { to: '/implementers', label: 'מטמיעים', icon: '🧑‍💻', need: ['users', 'create'] },
  { to: '/reports', label: 'דוחות', icon: '📈', need: ['reports', 'view'], roles: ['manager'] },
  { to: '/notifications', label: 'התראות', icon: '🔔', badge: 'unread' },
  { to: '/settings', label: 'הגדרות', icon: '⚙️', need: ['settings', 'view'] },
  { to: '/profile', label: 'פרופיל', icon: '👤' },
];

export function AppLayout() {
  const { loading, error, profile, role, can, reload } = usePermissions();
  const { signOut, isLocalAuth } = useAuth();
  const location = useLocation();
  const [unread, setUnread] = useState(0);

  // מונה ההתראות מתרענן בכל מעבר מסך, ובנוסף כל שתי דקות
  useEffect(() => {
    if (!profile) return undefined;
    let active = true;

    const poll = () =>
      get('/api/notifications', { unreadOnly: true, limit: 1 })
        .then((data) => active && setUnread(data.unread ?? 0))
        .catch(() => {});

    poll();
    const timer = setInterval(poll, 120_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [profile, location.pathname]);

  if (loading) {
    return (
      <div className="auth-shell">
        <Loading text="טוען את המערכת…" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <ErrorState error={error} onRetry={reload} />
          <div className="mt-3">
            <button type="button" className="btn" onClick={signOut}>
              התנתקות
            </button>
          </div>
        </div>
      </div>
    );
  }

  const items = NAV.filter((item) => {
    if (item.roles && !item.roles.includes(role)) return false;
    if (item.need && !can(item.need[0], item.need[1])) return false;
    return true;
  });

  return (
    <div className="app-shell">
      <a href="#main" className="sr-only">דילוג לתוכן הראשי</a>

      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden="true">הט</div>
          <div>
            <div className="brand-title">ניהול הטמעה</div>
            <div className="brand-sub">{ROLE_NAMES[role] ?? ''}</div>
          </div>
        </div>

        <nav className="nav" aria-label="ניווט ראשי">
          {items.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span>{item.label}</span>
              {item.badge === 'unread' && unread > 0 && (
                <span className="nav-badge" aria-label={`${unread} התראות שלא נקראו`}>
                  {unread > 99 ? '99+' : unread}
                </span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="who">
            <strong>{profile?.full_name}</strong>
            {profile?.email}
          </div>
          <button type="button" className="btn btn-sm row-end" onClick={signOut}>
            {isLocalAuth ? 'החלפת משתמש' : 'התנתקות'}
          </button>
        </div>
      </aside>

      <main className="main" id="main">
        {isLocalAuth && (
          <div
            role="status"
            className="row small"
            style={{
              background: 'var(--warn-bg)', border: '2px solid var(--warn)',
              padding: '6px var(--space-3)', marginBlockEnd: 'var(--space-4)',
              maxWidth: 1180, marginInline: 'auto',
            }}
          >
            <span aria-hidden="true">🧪</span>
            <span>
              <span className="bold">מצב פיתוח מקומי</span> — מחובר/ת כ{profile?.full_name}
              {' '}({ROLE_NAMES[role]}). כניסה ללא סיסמה, לא לשימוש בייצור.
            </span>
            <button type="button" className="btn btn-sm row-end" onClick={signOut}>
              כניסה כמשתמש אחר
            </button>
          </div>
        )}
        <div className="view">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

/** כותרת מסך אחידה */
export function ViewHead({ title, subtitle, actions }) {
  return (
    <header className="view-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="view-actions">{actions}</div>}
    </header>
  );
}

export function Avatar({ name, size = 36 }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width: size, height: size, flexShrink: 0,
        background: 'var(--primary)', color: 'var(--ink)',
        border: '2px solid var(--ink)',
        display: 'grid', placeItems: 'center',
        fontWeight: 900, fontSize: size * 0.36,
      }}
    >
      {initials(name)}
    </div>
  );
}
