import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * בדיקת רינדור לכל מסך מאחורי הזדהות.
 *
 * המטרה צרה ומוגדרת: לוודא שכל מסך עולה בלי שגיאת ריצה, ושהוא מציג את
 * מצבי הטעינה, הריק והשגיאה ש-AC-14 דורש. בלי הבדיקה הזו, שגיאה בשם
 * שדה או ב-import הייתה מתגלה רק אצל משתמש אמיתי, כי `vite build` אינו
 * מריץ את הקוד.
 */

// הבדיקות רצות תמיד במצב ההזדהות הרגיל, גם כש-client/.env מגדיר
// VITE_AUTH_MODE=local לפיתוח — אחרת אין session והמסכים לא נטענים
vi.mock('../src/lib/authMode.js', () => ({
  isLocalAuth: false,
  getLocalUserId: () => null,
  setLocalUserId: () => {},
  localToken: (id) => `local:${id}`,
}));

// Supabase מוחלף: אין צורך ברשת, ואין צורך בפרויקט אמיתי
vi.mock('../src/lib/supabase.js', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: { access_token: 'test-token', user: { id: 'u1' } } } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
      signOut: async () => ({}),
    },
  },
}));

/** תשובות ה-API לכל נתיב שהמסכים מבקשים */
const RESPONSES = {
  '/api/auth/me': {
    profile: {
      id: 'u1', full_name: 'דנה כהן', email: 'dana@test.local', phone: '050-0000000',
      base_role: 'manager', status: 'active', row_version: 1, intake_date: '2026-01-01',
    },
    sites: [{ id: 's1', name: 'מרכז רפואי צפון', assignment_role: 'implementer' }],
    domains: [{ id: 'd1', name: 'מערכות קליניות', isPrimary: true }],
    subCategories: [], mentors: [], missingAssignments: [],
    scopes: { siteIds: ['s1'], domainIds: ['d1'], subCategoryIds: [], assignedUserIds: [] },
  },
  '/api/auth/effective-permissions': {
    userId: 'u1', baseRole: 'manager',
    capabilities: Object.fromEntries(
      ['users', 'implementers', 'mentors', 'sites', 'domains', 'activities', 'availability',
       'requests', 'rules', 'roster', 'teamSchedule', 'materials', 'updates', 'chat',
       'reports', 'audit', 'permissions', 'settings'].map((r) => [r, ['manage']]),
    ),
    matrix: {},
  },
  '/api/sites': { sites: [{ id: 's1', name: 'מרכז רפואי צפון', status_name: 'הכשרה', status_code: 'training', go_live_date: '2026-11-16', is_archived: false, location_count: 1, people_count: 3, row_version: 1, open_time: '07:00:00', close_time: '23:00:00', availability_max_cannot: 3, availability_max_prefer_not: 4 }] },
  '/api/users': { users: [] },
  '/api/settings/domains': { domains: [{ id: 'd1', name: 'מערכות קליניות', is_active: true, row_version: 1, subCategories: [] }] },
  '/api/settings/mentors': { mentors: [] },
  '/api/settings/mentors/unassigned-implementers': { implementers: [] },
  '/api/settings/mentors/my-team': { team: [] },
  '/api/settings/location-types': { locationTypes: [] },
  '/api/settings/app': { settings: { editable_profile_fields: { value: ['phone', 'bio'] }, team_schedule_fields: { value: ['name'] } } },
  '/api/exceptions': { exceptions: [] },
  '/api/requests': {
    requests: [
      { id: 'r1', user_name: 'נועה פרץ', type_name: 'חופשה', constraint_date: '2026-11-20', start_time: '00:00:00', end_time: '23:59:00', note: null, status: 'submitted', has_pending_exception: false },
      { id: 'r2', user_name: 'עומר דהן', type_name: 'מחלה', constraint_date: '2026-11-17', start_time: '00:00:00', end_time: '23:59:00', note: null, status: 'submitted', has_pending_exception: true },
    ],
  },
  '/api/settings/constraint-approval': {
    rules: [
      { id: 'ct1', code: 'vacation', name_he: 'חופשה', approval_mode: 'manager', is_active: true, row_version: 1 },
      { id: 'ct2', code: 'sick', name_he: 'מחלה', approval_mode: 'auto', is_active: true, row_version: 1 },
    ],
  },
  '/api/availability/pending': { declarations: [] },
  '/api/availability/window': { siteId: 's1', siteName: 'מרכז רפואי צפון', weekStart: '2026-11-15', days: ['2026-11-15'], windows: [
    { key: '07:00-15:00', startTime: '07:00', endTime: '15:00', label: 'בוקר', locations: 'מחלקה פנימית', isMandatory: true, crossesMidnight: false },
    { key: '08:00-16:00', startTime: '08:00', endTime: '16:00', label: 'בוקר מיון / הדרכה', locations: 'חדר מיון, חדר הדרכה', isMandatory: false, crossesMidnight: false },
  ], limits: { maxCannot: 3, maxPreferNot: 4 }, deadline: null, isOpen: true },
  '/api/availability/declarations': { declarations: [] },
  '/api/activities': { activities: [] },
  '/api/activities/my-tasks': { tasks: [] },
  '/api/schedule/me': { items: [] },
  '/api/schedule/team': { date: '2026-11-15', fields: ['name'], entries: [] },
  '/api/schedule/team/sites': { sites: [{ id: 's1', name: 'מרכז רפואי צפון' }] },
  '/api/updates/inbox': { updates: [
    { id: 'm1', title: 'נוהל חדש', body: 'נא לקרוא', requires_ack: true, read_at: null, acknowledged_at: null, author_name: 'יוסי לוי', published_at: '2026-11-14T08:00:00Z', attachment_count: 1 },
  ] },
  '/api/updates/sent': { updates: [], storageEnabled: false },
  '/api/updates/recipients': { recipients: [], storageEnabled: false },
  '/api/roster/versions': { versions: [] },
  '/api/roster/draft': { version: { id: 'v1', status: 'draft', version_number: 1, week_start: '2026-11-15', site_id: 's1', row_version: 1 } },
  '/api/notifications': { notifications: [], unread: 0, total: 0 },
  '/api/notifications/preferences': { preferences: [] },
  '/api/reports/workload': { rows: [] },
  '/api/reports/training': { rows: [] },
  '/api/reports/requests': { requests: [], exceptions: [] },
  '/api/rules': { rules: [] },
  '/api/rules/condition-types': { conditionTypes: [] },
  '/api/permissions/catalog': { resources: [] },
  '/api/audit': { entries: [], entityTypes: [] },
};

const matchResponse = (path) => {
  if (RESPONSES[path]) return RESPONSES[path];
  // נתיבי פרטים לפני התאמת הקידומת, אחרת /api/sites/s1 היה מקבל את רשימת האתרים
  if (path.match(/^\/api\/sites\/[^/]+$/)) {
    return {
      site: RESPONSES['/api/sites'].sites[0],
      periods: [],
      locations: [
        { id: 'l1', name: 'חדר מיון', is_active: true, location_type_id: 'lt1', location_type_name: 'מחלקה', row_version: 1,
          shiftTypes: [{ id: 'st1', location_id: 'l1', name: 'בוקר מיון', start_time: '08:00:00', end_time: '16:00:00', crosses_midnight: false, is_mandatory: true, required_staff: 1, is_active: true, row_version: 1 }] },
        { id: 'l2', name: 'אגף ריק', is_active: true, location_type_id: null, row_version: 1, shiftTypes: [] },
      ],
    };
  }
  if (path.includes('/board')) {
    return {
      version: { id: 'v1', status: 'draft', version_number: 1, week_start: '2026-11-15', site_id: 's1', row_version: 1 },
      days: ['2026-11-15', '2026-11-16'],
      locations: [{ id: 'l1', name: 'חדר מיון' }, { id: 'l2', name: 'מחלקה פנימית' }, { id: 'l3', name: 'אגף ריק' }],
      shiftTypes: [
        { id: 'st1', location_id: 'l1', name: 'בוקר מיון', start_time: '08:00:00', end_time: '16:00:00', is_mandatory: true },
        { id: 'st2', location_id: 'l2', name: 'בוקר', start_time: '07:00:00', end_time: '15:00:00', is_mandatory: true },
        { id: 'st3', location_id: 'l2', name: 'לילה', start_time: '23:00:00', end_time: '07:00:00', is_mandatory: false },
      ],
      assignments: [
        { id: 'a1', location_id: 'l2', assignment_date: '2026-11-15', shift_type_id: 'st2', user_id: 'u1', user_name: 'נועה פרץ', start_time: '07:00:00', end_time: '15:00:00' },
      ],
      people: [{ id: 'u1', full_name: 'נועה פרץ' }, { id: 'u2', full_name: 'איתי מזרחי' }],
      availability: [{ user_id: 'u2', cell_date: '2026-11-15', start_time: '23:00:00', end_time: '07:00:00', value: 'cannot', status: 'ok' }],
      declarations: [{ user_id: 'u1', status: 'ok' }, { user_id: 'u2', status: 'ok' }],
      constraints: [],
    };
  }
  const prefix = Object.keys(RESPONSES).find((key) => path.startsWith(key));
  if (prefix) return RESPONSES[prefix];
  if (path.startsWith('/api/settings/lookups/')) return { items: [] };
  return {};
};

const calls = [];

vi.mock('../src/lib/api.js', async () => {
  const actual = await vi.importActual('../src/lib/api.js');
  return {
    ...actual,
    get: async (path, query) => { calls.push(path); return matchResponse(path); },
    post: async () => ({}),
    put: async () => ({}),
    patch: async () => ({}),
    del: async () => ({}),
    download: async () => {},
    onServerWaking: () => () => {},
  };
});

const { AuthProvider } = await import('../src/context/AuthContext.jsx');
const { PermissionsProvider } = await import('../src/context/PermissionsContext.jsx');
const { ToastProvider } = await import('../src/context/ToastContext.jsx');

const SCREENS = [
  ['בית', () => import('../src/pages/Home.jsx')],
  ['דשבורד', () => import('../src/pages/Dashboard.jsx')],
  ['הלו״ז שלי', () => import('../src/pages/MySchedule.jsx')],
  ['לו״ז צוות', () => import('../src/pages/TeamSchedule.jsx')],
  ['הצוות שלי', () => import('../src/pages/MyTeam.jsx')],
  ['בקשות וזמינות', () => import('../src/pages/Requests.jsx')],
  ['בקשות ואישורים', () => import('../src/pages/Approvals.jsx')],
  ['פעילויות', () => import('../src/pages/Activities.jsx')],
  ['בונה סידור', () => import('../src/pages/Roster.jsx')],
  ['אתרים', () => import('../src/pages/Sites.jsx')],
  ['אנשים', () => import('../src/pages/Implementers.jsx')],
  ['הודעות', () => import('../src/pages/Messages.jsx')],
  ['דוחות', () => import('../src/pages/Reports.jsx')],
  ['התראות', () => import('../src/pages/Notifications.jsx')],
  ['פרופיל', () => import('../src/pages/Profile.jsx')],
  ['הגדרות', () => import('../src/pages/settings/index.jsx')],
];

const renderScreen = (Component) =>
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <PermissionsProvider>
            <Component />
          </PermissionsProvider>
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  );

describe('רינדור כל המסכים', () => {
  let errors;

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args) => errors.push(args.join(' ')));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it.each(SCREENS)('%s עולה בלי שגיאת ריצה', async (name, load) => {
    const { default: Component } = await load();
    const { container } = renderScreen(Component);

    // ממתינים לסיום הטעינה, כדי שהמסך יגיע למצב הסופי שלו
    await waitFor(() => expect(container.textContent.length).toBeGreaterThan(0), { timeout: 3000 });

    const real = errors.filter(
      (e) => !e.includes('not wrapped in act') && !e.includes('validateDOMNesting'),
    );
    expect(real, `שגיאות ריצה ב${name}:\n${real.join('\n')}`).toEqual([]);
  });
});

describe('מצבי מסך — AC-14', () => {
  it('StateView מציג טעינה, ריק, שגיאה ואין־הרשאה', async () => {
    const { StateView } = await import('../src/components/ui/index.jsx');

    const { rerender } = render(<StateView loading><div>תוכן</div></StateView>);
    expect(screen.getByText('טוען…')).toBeTruthy();

    rerender(<StateView empty emptyProps={{ title: 'ריק כאן' }}><div>תוכן</div></StateView>);
    expect(screen.getByText('ריק כאן')).toBeTruthy();

    rerender(
      <StateView error={{ code: 'E_UNEXPECTED', message: 'נפל', traceId: 'trc_1' }}>
        <div>תוכן</div>
      </StateView>,
    );
    expect(screen.getByText('משהו השתבש')).toBeTruthy();
    expect(screen.getByText(/trc_1/)).toBeTruthy();

    rerender(
      <StateView error={{ code: 'E_FORBIDDEN', message: 'אין גישה' }}><div>תוכן</div></StateView>,
    );
    expect(screen.getByText('אין לך הרשאה')).toBeTruthy();

    rerender(<StateView><div>תוכן</div></StateView>);
    expect(screen.getByText('תוכן')).toBeTruthy();
  });
});

describe('משמרות לפי מיקום ואישור בלחיצה', () => {
  afterEach(() => cleanup());

  it('בונה הסידור: כל מיקום מציג רק את המשמרות שלו', async () => {
    const { default: Roster } = await import('../src/pages/Roster.jsx');
    renderScreen(Roster);
    await screen.findAllByText('בוקר מיון');
    // שני ימים × משמרת אחת במיון; שני ימים × שתי משמרות במחלקה
    expect(screen.getAllByText('בוקר מיון')).toHaveLength(2);
    expect(screen.getAllByText('לילה')).toHaveLength(2);
    expect(screen.getByText(/למיקום הזה לא הוגדרו משמרות/)).toBeTruthy();

    // איתי סימן "לא יכול" ל-23–07: הסימון מופיע רק ליד משמרת הלילה
    const nightAdd = screen.getAllByLabelText(/הוספת מטמיע למחלקה פנימית, .*, לילה/)[0];
    expect(nightAdd.textContent).toContain('איתי מזרחי — לא יכול');
    const morningAdd = screen.getAllByLabelText(/הוספת מטמיע לחדר מיון, .*, בוקר מיון/)[0];
    expect(morningAdd.textContent).toContain('איתי מזרחי — ✓ זמין');
  });

  it('אתרים: המשמרות מוצגות תחת המיקום שלהן', async () => {
    const { default: Sites } = await import('../src/pages/Sites.jsx');
    renderScreen(Sites);
    fireEvent.click(await screen.findByRole('button', { name: /מרכז רפואי צפון/ }));
    expect(await screen.findByText('בוקר מיון')).toBeTruthy();
    expect(screen.getByText('למיקום הזה אין משמרות')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'העתקה מתבנית' })).toBeTruthy();
    expect(screen.queryByText('כללי אישור אילוצים')).toBeNull();
  });

  it('זמינות: העמודות הן חלונות השעות של האתר', async () => {
    const { default: Requests } = await import('../src/pages/Requests.jsx');
    renderScreen(Requests);
    expect(await screen.findByText('07:00–15:00')).toBeTruthy();
    expect(screen.getByText('בוקר מיון / הדרכה')).toBeTruthy();
  });

  it('אישורים: בקשה רגילה בלחיצה אחת, ובקשה עם חריגה פתוחה נעולה', async () => {
    const { default: Approvals } = await import('../src/pages/Approvals.jsx');
    renderScreen(Approvals);
    fireEvent.click(await screen.findByRole('button', { name: /בקשות \(2\)/ }));

    expect(await screen.findByRole('button', { name: 'אישור הבקשה של נועה פרץ' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'דחיית הבקשה של נועה פרץ' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'אישור הבקשה של עומר דהן' })).toBeNull();
    expect(screen.getByText('ממתינה להחלטה בחריגה')).toBeTruthy();
    expect(screen.queryByText('נימוק ההחלטה')).toBeNull();
  });

  it('הגדרות: כללי אישור אילוצים גנריים', async () => {
    const { default: CatalogsTab } = await import('../src/pages/settings/CatalogsTab.jsx');
    renderScreen(CatalogsTab);
    expect(await screen.findByText('כללי אישור אילוצים')).toBeTruthy();
    const group = await screen.findByRole('group', { name: 'כלל האישור של מחלה' });
    expect(group.querySelector('[aria-pressed="true"]').textContent).toBe('אישור אוטומטי');
  });
});

describe('הודעות לצוות', () => {
  afterEach(cleanup);

  it('הודעה שמחכה לאישור קריאה מסומנת בתיבה', async () => {
    const { default: Messages } = await import('../src/pages/Messages.jsx');
    renderScreen(Messages);
    expect(await screen.findByText('נוהל חדש')).toBeTruthy();
    expect(screen.getByText('ממתין לאישור קריאה')).toBeTruthy();
  });
});
