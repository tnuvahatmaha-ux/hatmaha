import { Link, useNavigate } from 'react-router-dom';
import { useApi } from '../lib/useApi.js';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Empty, Notice } from '../components/ui/index.jsx';
import { fmtDate, fmtDateFull, fmtTime, today, addDays, weekStartOf, statusTone, STATUS_NAMES } from '../lib/format.js';

/** תמונת מצב למנהל ההטמעה. כל כרטיס KPI הוא קיצור דרך למסך שמטפל בו. */
export default function Dashboard() {
  const navigate = useNavigate();
  const from = today();

  const sites = useApi('/api/sites');
  const unassigned = useApi('/api/settings/mentors/unassigned-implementers');
  const exceptions = useApi('/api/exceptions', { status: 'pending', limit: 50 });
  const pendingAvail = useApi('/api/availability/pending');
  const activities = useApi('/api/activities', { from, to: addDays(from, 7), limit: 50 });
  const users = useApi('/api/users', { status: 'active', limit: 500 });

  const people = users.data?.users ?? [];
  const implementers = people.filter((u) => ['implementer', 'lead'].includes(u.base_role));
  const mentors = people.filter((u) => u.base_role === 'mentor');

  const goLive = (sites.data?.sites ?? [])
    .filter((s) => s.go_live_date && s.go_live_date >= from && !s.is_archived)
    .sort((a, b) => a.go_live_date.localeCompare(b.go_live_date));

  const todayActivities = (activities.data?.activities ?? []).filter((a) => a.activity_date === from);

  const kpis = [
    { label: 'מטמיעים פעילים', value: implementers.length, to: '/implementers' },
    { label: 'מדריכים', value: mentors.length, to: '/settings?tab=mentors' },
    {
      label: 'חריגות ממתינות',
      value: (exceptions.data?.exceptions ?? []).length,
      to: '/approvals',
      tone: (exceptions.data?.exceptions ?? []).length > 0 ? 'warn' : undefined,
    },
    {
      label: 'זמינות לאישור',
      value: (pendingAvail.data?.declarations ?? []).length,
      to: '/approvals',
      tone: (pendingAvail.data?.declarations ?? []).length > 0 ? 'warn' : undefined,
    },
    {
      label: 'ללא שיוך מלא',
      value: (unassigned.data?.implementers ?? []).length,
      to: '/implementers',
      tone: (unassigned.data?.implementers ?? []).length > 0 ? 'danger' : undefined,
    },
    { label: 'פעילויות השבוע', value: (activities.data?.activities ?? []).length, to: '/activities' },
  ];

  const loading = sites.loading || users.loading;

  return (
    <>
      <ViewHead title="דשבורד" subtitle="תמונת מצב כללית על ההטמעה" />

      <StateView loading={loading} error={sites.error ?? users.error} onRetry={() => { sites.reload(); users.reload(); }}>
        <div className="kpi-strip">
          {kpis.map((kpi) => (
            <button
              key={kpi.label}
              type="button"
              className={`kpi${kpi.tone ? ` tone-${kpi.tone}` : ''}`}
              onClick={() => navigate(kpi.to)}
            >
              <div className="kpi-label">{kpi.label}</div>
              <div className="kpi-value">{kpi.value}</div>
            </button>
          ))}
        </div>

        {(unassigned.data?.implementers ?? []).length > 0 && (
          <Notice tone="warn" icon="⚠" title="מטמיעים ללא שיוך מלא">
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {unassigned.data.implementers.slice(0, 6).map((person) => (
                <li key={person.user_id}>
                  <span className="bold">{person.full_name}</span>
                  {' — '}
                  {[
                    person.missing_site && 'לא שויך אתר',
                    person.missing_domain && 'לא שויך תחום',
                    person.missing_mentor && 'לא שויך מדריך',
                  ].filter(Boolean).join(', ')}
                </li>
              ))}
            </ul>
            {unassigned.data.implementers.length > 6 && (
              <div className="small mt-3">ועוד {unassigned.data.implementers.length - 6}</div>
            )}
            <Link to="/implementers" className="btn btn-sm mt-3">מעבר למסך המטמיעים</Link>
          </Notice>
        )}

        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <Panel title="Go Live קרוב" flush>
              {goLive.length === 0 ? (
                <Empty icon="🚀" title="אין תאריכי עלייה לאוויר קרובים" />
              ) : (
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead>
                      <tr><th>אתר</th><th>סטטוס</th><th>תאריך</th></tr>
                    </thead>
                    <tbody>
                      {goLive.map((site) => (
                        <tr key={site.id}>
                          <td data-label="אתר" className="bold">{site.name}</td>
                          <td data-label="סטטוס"><Tag>{site.status_name}</Tag></td>
                          <td data-label="תאריך" className="tnum">{fmtDateFull(site.go_live_date)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>

          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <Panel title="פעילויות היום" flush>
              {todayActivities.length === 0 ? (
                <Empty icon="☕" title="אין פעילויות מתוכננות להיום" />
              ) : (
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead>
                      <tr><th>שעה</th><th>פעילות</th><th>אתר</th></tr>
                    </thead>
                    <tbody>
                      {todayActivities.map((activity) => (
                        <tr key={activity.id}>
                          <td data-label="שעה" className="tnum">{activity.start_time.slice(0, 5)}</td>
                          <td data-label="פעילות" className="bold">
                            {activity.title ?? activity.type_name}
                            <div className="tiny muted">{activity.type_name}</div>
                          </td>
                          <td data-label="אתר">{activity.site_name}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </div>
        </div>

        <Panel
          title="חריגות שממתינות להחלטה"
          actions={<Link to="/approvals" className="btn btn-sm">לתור האישורים</Link>}
          flush
        >
          <StateView
            loading={exceptions.loading}
            error={exceptions.error}
            onRetry={exceptions.reload}
            empty={!exceptions.loading && (exceptions.data?.exceptions ?? []).length === 0}
            emptyProps={{ icon: '✓', title: 'אין חריגות פתוחות' }}
          >
            <div className="table-wrap">
              <table className="table table-cards">
                <thead>
                  <tr><th>נושא</th><th>חוק</th><th>פירוט</th><th>הוגש</th></tr>
                </thead>
                <tbody>
                  {(exceptions.data?.exceptions ?? []).slice(0, 8).map((ex) => (
                    <tr key={ex.id}>
                      <td data-label="נושא" className="bold">{ex.target_name ?? ex.requested_by_name}</td>
                      <td data-label="חוק" className="small">{ex.rule_name}</td>
                      <td data-label="פירוט" className="small">{ex.summary}</td>
                      <td data-label="הוגש" className="tnum small">{fmtDate(ex.created_at?.slice(0, 10))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </StateView>
        </Panel>
      </StateView>
    </>
  );
}
