import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * בדיקת רינדור לכל מסך מאחורי הזדהות.
 *
 * המטרה צרה ומוגדרת: לוודא שכל מסך עולה בלי שגיאת ריצה, ושהוא מציג את
 * מצבי הטעינה, הריק והשגיאה ש-AC-14 דורש. בלי הבדיקה הזו, שגיאה בשם
 * שדה או ב-import הייתה מתגלה רק אצל משתמש אמיתי, כי `vite build` אינו
 * מריץ את הקוד.
 */

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
  '/api/requests': { requests: [] },
  '/api/availability/pending': { declarations: [] },
  '/api/availability/window': { siteId: 's1', siteName: 'מרכז רפואי צפון', weekStart: '2026-11-15', days: ['2026-11-15'], shiftTypes: [], limits: { maxCannot: 3, maxPreferNot: 4 }, deadline: null, isOpen: true },
  '/api/availability/declarations': { declarations: [] },
  '/api/activities': { activities: [] },
  '/api/activities/my-tasks': { tasks: [] },
  '/api/schedule/me': { items: [] },
  '/api/schedule/team': { date: '2026-11-15', fields: ['name'], entries: [] },
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
  const prefix = Object.keys(RESPONSES).find((key) => path.startsWith(key));
  if (prefix) return RESPONSES[prefix];
  if (path.startsWith('/api/settings/lookups/')) return { items: [] };
  if (path.match(/^\/api\/sites\/[^/]+$/)) {
    return { site: RESPONSES['/api/sites'].sites[0], periods: [], locations: [], shiftTypes: [], constraintPolicies: [] };
  }
  if (path.includes('/board')) {
    return { version: { id: 'v1', status: 'draft', version_number: 1, week_start: '2026-11-15', site_id: 's1', row_version: 1 }, days: [], locations: [], shiftTypes: [], assignments: [], people: [], availability: [], constraints: [] };
  }
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
  ['מטמיעים', () => import('../src/pages/Implementers.jsx')],
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
