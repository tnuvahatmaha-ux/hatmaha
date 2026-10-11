import { Link, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { ScorePill } from './Skills.jsx';
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

        <SkillsCard sites={sites.data?.sites ?? []} />

        <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
          <div style={{ flex: '1 1 320px', minWidth: 0 }}>
            <Panel title="עלייה לאוויר קרובה" flush>
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

/**
 * סקילומטר: אחוז ההשלמה של הסבב הפעיל, ממוצע לכל תחום, ומשתמשי הקצה
 * המובילים ומי שזקוק לחיזוק — עם השוואה לסבב הקודם.
 */
function SkillsCard({ sites }) {
  const [siteId, setSiteId] = useState('');
  const active = sites.filter((s) => !s.is_archived);
  useEffect(() => {
    if (!siteId && active.length) setSiteId((active.find((s) => s.status_code !== 'training') ?? active[0]).id);
  }, [active, siteId]);

  const summary = useApi(siteId ? '/api/skills/summary' : null, { siteId });
  const data = summary.data;

  const PersonRow = ({ p }) => (
    <tr>
      <td data-label="שם" className="bold">{p.full_name}<div className="tiny muted">{p.domain_name}</div></td>
      <td data-label="ממוצע"><ScorePill value={p.avg_score} /></td>
      <td data-label="שינוי" className="tnum small">
        {p.prev_avg == null ? '—'
          : Number(p.avg_score) === Number(p.prev_avg) ? <span className="muted">=</span>
          : <span style={{ color: Number(p.avg_score) > Number(p.prev_avg) ? 'var(--success)' : 'var(--danger)' }}>
              {Number(p.avg_score) > Number(p.prev_avg) ? '▲' : '▼'} {Math.abs(p.avg_score - p.prev_avg).toFixed(1)}
            </span>}
      </td>
      <td data-label="נושא חלש" className="small">{p.min_score < 4 ? p.weakest_topic : '—'}</td>
    </tr>
  );

  return (
    <Panel
      title="סקילומטר"
      subtitle={data?.round ? `${data.round.name} · ${data.completion}% הושלם` : 'רמת הידע של משתמשי הקצה'}
      actions={
        <>
          {active.length > 1 && (
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="אתר לסקילומטר" style={{ width: 'auto' }}>
              {active.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
          <Link to="/skills" className="btn btn-sm">לסקילומטר</Link>
        </>
      }
    >
      <StateView loading={summary.loading} error={summary.error} onRetry={summary.reload}
        empty={!summary.loading && !data?.round}
        emptyProps={{ icon: '📝', title: 'עדיין לא נפתח סבב סקילומטר באתר הזה' }}>
        {data?.round && (
          <>
            <div className="progress" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <span style={{ width: `${data.completion}%` }} />
            </div>
            {data.domains.length > 0 && (
              <div className="kpi-strip">
                {data.domains.map((d) => (
                  <div key={d.domain} className="kpi" style={{ cursor: 'default' }}>
                    <div className="kpi-label">{d.domain} · {d.users} משתמשים</div>
                    <div className="kpi-value">{d.avg.toFixed(1)}</div>
                  </div>
                ))}
              </div>
            )}
            <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
              {[['מובילים', data.top], ['זקוקים לחיזוק', data.struggling]].map(([title, list]) => (
                <div key={title} style={{ flex: '1 1 300px', minWidth: 0 }}>
                  <h3 style={{ marginBlockEnd: 'var(--space-2)' }}>{title}</h3>
                  {list.length === 0 ? (
                    <p className="small muted">אין עדיין נתונים</p>
                  ) : (
                    <div className="table-wrap">
                      <table className="table table-cards">
                        <thead><tr><th>שם</th><th>ממוצע</th><th>שינוי</th><th>נושא חלש</th></tr></thead>
                        <tbody>{list.map((p) => <PersonRow key={p.end_user_id} p={p} />)}</tbody>
                      </table>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </StateView>
    </Panel>
  );
}
