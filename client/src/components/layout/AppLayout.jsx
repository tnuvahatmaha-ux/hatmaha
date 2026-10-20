import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { LogOut, MoreHorizontal, FlaskConical } from 'lucide-react';
import { usePermissions } from '../../context/PermissionsContext.jsx';
import { useAuth } from '../../context/AuthContext.jsx';
import { get } from '../../lib/api.js';
import { ROLE_NAMES, initials } from '../../lib/format.js';
import { Loading, ErrorState, Modal } from '../ui/index.jsx';
import { NAV_ICONS } from '../ui/icons.jsx';
import { Brand, BrandMark, APP_NAME } from './Brand.jsx';

/**
 * תפריט הניווט.
 *
 * כל פריט מצהיר על ההרשאה שהוא דורש, ומוצג רק אם יש אותה בפועל. זו
 * נוחות: השרת בודק שוב בכל בקשה, והנתיב עצמו מוגן גם אם מישהו יקליד
 * אותו ישירות.
 */
const NAV = [
  { group: 'ראשי', to: '/', label: 'בית', end: true, tab: 1 },
  { group: 'ראשי', to: '/dashboard', label: 'דשבורד', need: ['reports', 'view'], roles: ['manager'] },
  { group: 'ראשי', to: '/schedule', label: 'הלו״ז שלי', icon: '/my-schedule', tab: 2, selfOnly: true },
  { group: 'ראשי', to: '/team-schedule', label: 'לו״ז צוות', need: ['teamSchedule', 'view'] },
  { group: 'ראשי', to: '/my-team', label: 'הצוות שלי', need: ['implementers', 'view'], roles: ['mentor'] },
  { group: 'ראשי', to: '/messages', label: 'הודעות', badge: 'messages', tab: 3 },
  { group: 'ראשי', to: '/skills', label: 'סקילומטר', need: ['skills', 'view'] },
  { group: 'ראשי', to: '/attendance', label: 'נוכחות', need: ['roster', 'view'] },
  { group: 'ראשי', to: '/training', label: 'הכשרה', roles: ['manager', 'mentor'] },
  { group: 'בקשות', to: '/requests', label: 'בקשות וזמינות', need: ['requests', 'create'], selfOnly: true },
  { group: 'בקשות', to: '/approvals', label: 'בקשות ואישורים', need: ['requests', 'approve'] },
  { group: 'בקשות', to: '/activities', label: 'פעילויות והדרכות', need: ['activities', 'view'] },
  { group: 'ניהול', to: '/roster', label: 'בונה סידור', need: ['roster', 'edit'] },
  { group: 'ניהול', to: '/sites', label: 'אתרים', need: ['sites', 'edit'] },
  { group: 'ניהול', to: '/implementers', label: 'אנשים', need: ['users', 'create'] },
  { group: 'ניהול', to: '/reports', label: 'דוחות', need: ['reports', 'view'], roles: ['manager'] },
  { group: 'ניהול', to: '/settings', label: 'הגדרות', need: ['settings', 'view'] },
  { group: 'אישי', to: '/notifications', label: 'התראות', badge: 'unread', tab: 4 },
  { group: 'אישי', to: '/profile', label: 'פרופיל' },
];

function NavIcon({ item, size = 18 }) {
  const Cmp = NAV_ICONS[item.icon ?? item.to];
  return Cmp ? <Cmp size={size} strokeWidth={1.9} /> : null;
}

function Badge({ count, label }) {
  if (!count) return null;
  return (
    <span className="nav-badge" aria-label={label}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

export function AppLayout() {
  const { loading, error, profile, role, can, reload, submitsAvailability } = usePermissions();
  const { signOut, isLocalAuth } = useAuth();
  const location = useLocation();
  const [unread, setUnread] = useState(0);
  const [messages, setMessages] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);

  // המונים מתרעננים בכל מעבר מסך, ובנוסף כל שתי דקות
  useEffect(() => {
    if (!profile) return undefined;
    let active = true;

    const poll = () => {
      get('/api/notifications', { unreadOnly: true, limit: 1 })
        .then((data) => active && setUnread(data.unread ?? 0))
        .catch(() => {});
      get('/api/updates/inbox')
        .then((data) => active && setMessages(
          (data.updates ?? []).filter((u) => !u.read_at || (u.requires_ack && !u.acknowledged_at)).length,
        ))
        .catch(() => {});
    };

    poll();
    const timer = setInterval(poll, 120_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [profile, location.pathname]);

  useEffect(() => setMoreOpen(false), [location.pathname]);

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
    // מנהל הטמעה אינו מגיש זמינות ואינו משובץ — אין לו לו״ז אישי או טופס הגשה
    if (item.selfOnly && !submitsAvailability) return false;
    return true;
  });

  const counts = { unread, messages };
  const badgeFor = (item) =>
    item.badge && (
      <Badge
        count={counts[item.badge]}
        label={item.badge === 'unread' ? `${unread} התראות שלא נקראו` : `${messages} הודעות חדשות`}
      />
    );

  const navList = (
    <nav className="nav" aria-label="ניווט ראשי">
      {items.map((item, i) => (
        <div key={item.to}>
          {item.group !== items[i - 1]?.group && <div className="nav-group-label">{item.group}</div>}
          <NavLink
            to={item.to}
            end={item.end}
            className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
          >
            <span className="nav-icon" aria-hidden="true"><NavIcon item={item} /></span>
            <span>{item.label}</span>
            {badgeFor(item)}
          </NavLink>
        </div>
      ))}
    </nav>
  );

  const tabs = items.filter((i) => i.tab).sort((a, b) => a.tab - b.tab).slice(0, 4);

  return (
    <div className="app-shell">
      <a href="#main" className="sr-only">דילוג לתוכן הראשי</a>

      <aside className="sidebar">
        <Brand sub={ROLE_NAMES[role] ?? ''} />
        {navList}
        <div className="sidebar-footer">
          <Avatar name={profile?.full_name} size={32} />
          <div className="who">
            <strong>{profile?.full_name}</strong>
            {ROLE_NAMES[role]}
          </div>
          <button
            type="button"
            className="btn btn-icon"
            onClick={signOut}
            aria-label={isLocalAuth ? 'החלפת משתמש' : 'התנתקות'}
            title={isLocalAuth ? 'החלפת משתמש' : 'התנתקות'}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>

      <header className="mobile-top">
        <BrandMark />
        <span className="brand-title">{APP_NAME}</span>
        <span className="row-end"><Avatar name={profile?.full_name} size={30} /></span>
      </header>

      <main className="main" id="main">
        {isLocalAuth && (
          <div className="notice notice-warn small dev-notice" role="status" style={{ maxWidth: 1180, marginInline: 'auto', marginBlockEnd: 20 }}>
            <FlaskConical size={16} aria-hidden="true" />
            <span style={{ flex: 1 }}>
              <span className="bold">מצב פיתוח מקומי</span> — מחובר/ת כ{profile?.full_name}
              {' '}({ROLE_NAMES[role]}). כניסה ללא סיסמה, לא לשימוש בייצור.
            </span>
            <button type="button" className="btn btn-sm" onClick={signOut}>
              כניסה כמשתמש אחר
            </button>
          </div>
        )}
        <div className="view">
          <Outlet />
        </div>
      </main>

      <nav className="mobile-tabbar" aria-label="ניווט מהיר">
        {tabs.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => `tab-item${isActive ? ' active' : ''}`}
          >
            <NavIcon item={item} size={24} />
            <span>{item.label}</span>
            {badgeFor(item)}
          </NavLink>
        ))}
        <button type="button" className="tab-item" onClick={() => setMoreOpen(true)} aria-haspopup="dialog">
          <MoreHorizontal size={24} />
          <span>עוד</span>
        </button>
      </nav>

      {moreOpen && (
        <Modal title={APP_NAME} onClose={() => setMoreOpen(false)}>
          <div className="more-sheet">
            {navList}
            <div className="divider" />
            <button type="button" className="btn" style={{ width: '100%' }} onClick={signOut}>
              <LogOut size={16} /> {isLocalAuth ? 'החלפת משתמש' : 'התנתקות'}
            </button>
          </div>
        </Modal>
      )}
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
        borderRadius: '50%',
        background: 'linear-gradient(160deg, #a1a1a6, #6e6e73)', color: '#fff',
        display: 'grid', placeItems: 'center',
        fontWeight: 600, fontSize: size * 0.38, letterSpacing: '-0.02em',
      }}
    >
      {initials(name)}
    </div>
  );
}
