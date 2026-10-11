import { Link } from 'react-router-dom';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { useApi } from '../lib/useApi.js';
import { ViewHead, Avatar } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Notice, Empty } from '../components/ui/index.jsx';
import { fmtTime, fmtDate, dayName, today, addDays, ROLE_NAMES, statusTone, STATUS_NAMES } from '../lib/format.js';

/**
 * מסך הבית.
 *
 * מציג לכל תפקיד את מה שרלוונטי לו: למטמיע — הלו״ז והזמינות, למדריך —
 * המטלות והצוות. שיוך חסר מוצג בבירור בראש המסך, כפי ש-§7 דורש.
 */
export default function Home() {
  const { profile, role, sites, domains, mentors, missingAssignments, can, submitsAvailability, missingMigrations } = usePermissions();
  const approver = can('requests', 'approve');

  const from = today();
  const to = addDays(from, 7);
  const schedule = useApi('/api/schedule/me', { from, to });
  const tasks = useApi(role === 'mentor' ? '/api/activities/my-tasks' : null);
  const team = useApi(role === 'mentor' ? '/api/settings/mentors/my-team' : null);
  const inbox = useApi('/api/updates/inbox');
  const pendingRequests = useApi(approver ? '/api/requests' : null, { status: 'submitted', limit: 100 });
  const pendingExceptions = useApi(approver ? '/api/exceptions' : null, { status: 'pending', limit: 100 });
  const pendingAvailability = useApi(approver ? '/api/availability/pending' : null);

  const awaitingAck = (inbox.data?.updates ?? []).filter((u) => u.requires_ack && !u.acknowledged_at);
  const pendingCount =
    (pendingRequests.data?.requests?.length ?? 0) +
    (pendingExceptions.data?.exceptions?.length ?? 0) +
    (pendingAvailability.data?.declarations?.length ?? 0);

  const items = schedule.data?.items ?? [];
  const todayItems = items.filter((i) => i.entry_date === from);
  const upcoming = items.filter((i) => i.entry_date > from).slice(0, 6);

  return (
    <>
      <ViewHead
        title={`שלום, ${profile?.full_name?.split(' ')[0] ?? ''}`}
        subtitle={[ROLE_NAMES[role], sites.map((s) => s.name).join(', ')].filter(Boolean).join(' · ')}
      />

      {missingAssignments.length > 0 && (
        <Notice tone="warn" icon="⚠" title="חסרים שיוכים בפרופיל שלך">
          <div>{missingAssignments.join(' · ')}</div>
          <div className="small mt-3">
            בלי השיוכים האלה לא נוכל לשבץ אותך ולא תוכל/י להגיש זמינות.
            פנה/י למנהל ההטמעה.
          </div>
        </Notice>
      )}

      {missingMigrations.length > 0 && (
        <Notice tone="danger" icon="⚠" title="המסד לא עודכן — חלק מהמסכים לא יעבדו">
          חסרות מיגרציות: {missingMigrations.join(', ')}. יש להריץ אותן ב-Supabase ← SQL Editor
          (לפי הסדר, מתוך התיקייה supabase/migrations). פירוט ב-DEPLOY.md, "תחזוקה שוטפת".
        </Notice>
      )}

      {awaitingAck.length > 0 && (
        <Notice tone="warn" icon="💬" title={`${awaitingAck.length} הודעות ממתינות לאישור קריאה`}>
          <div className="row">
            <span>{awaitingAck.slice(0, 3).map((u) => u.title).join(' · ')}</span>
            <Link to="/messages" className="btn btn-sm row-end">לקריאה ואישור</Link>
          </div>
        </Notice>
      )}

      <div className="row" style={{ alignItems: 'stretch', gap: 'var(--space-4)', flexWrap: 'wrap' }}>
        <div style={{ flex: '2 1 380px', minWidth: 0 }}>
          <Panel title="היום" subtitle={`${dayName(from)}, ${fmtDate(from)}`} flush>
            <StateView
              loading={schedule.loading}
              error={schedule.error}
              onRetry={schedule.reload}
              empty={!schedule.loading && todayItems.length === 0}
              emptyProps={{ icon: '☕', title: 'אין פעילויות או שיבוצים להיום' }}
            >
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {todayItems.map((item) => (
                  <ScheduleRow key={`${item.kind}-${item.id}`} item={item} />
                ))}
              </ul>
            </StateView>
          </Panel>

          <Panel
            title="בקרוב"
            actions={<Link to="/schedule" className="btn btn-sm">הלו״ז המלא</Link>}
            flush
          >
            {upcoming.length === 0 ? (
              <Empty icon="🗓️" title="אין פעילויות בשבוע הקרוב" />
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {upcoming.map((item) => (
                  <ScheduleRow key={`${item.kind}-${item.id}`} item={item} showDate />
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div style={{ flex: '1 1 260px', minWidth: 0 }}>
          <Panel title="הפרופיל שלי">
            <div className="row" style={{ marginBlockEnd: 'var(--space-3)' }}>
              <Avatar name={profile?.full_name} size={44} />
              <div>
                <div className="bold">{profile?.full_name}</div>
                <div className="small muted">{ROLE_NAMES[role]}</div>
              </div>
            </div>

            <dl style={{ margin: 0, display: 'grid', gap: 6, fontSize: 13 }}>
              {submitsAvailability && (
                <>
                  <Row label="אתר" value={sites.map((s) => s.name).join(', ') || '—'} />
                  <Row label="תחום" value={domains.map((d) => d.name).join(', ') || '—'} />
                </>
              )}
              {['implementer', 'lead'].includes(role) && (
                <Row
                  label="מדריך ראשי"
                  value={mentors.find((m) => m.isPrimary)?.name ?? '—'}
                />
              )}
              {profile?.training_status_name && (
                <Row label="סטטוס הכשרה" value={profile.training_status_name} />
              )}
            </dl>

            <Link to="/profile" className="btn btn-sm mt-3">עריכת הפרופיל</Link>
          </Panel>

          {approver && (
            <Panel title="ממתין לאישורך">
              <div className="kpi-value" style={{ marginBlockEnd: 6 }}>{pendingCount}</div>
              <p className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
                בקשות, חריגות והצהרות זמינות שמחכות להחלטה.
              </p>
              <Link to="/approvals" className="btn btn-sm">לבקשות ואישורים</Link>
            </Panel>
          )}

          {submitsAvailability && can('availability', 'create') && (
            <Panel title="זמינות לשבוע הבא">
              <p className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
                סימון הזמינות שלך משפיע ישירות על השיבוץ.
              </p>
              <Link to="/requests" className="btn btn-primary btn-sm">מעבר להגשת זמינות</Link>
            </Panel>
          )}
        </div>
      </div>

      {role === 'mentor' && (
        <>
          <Panel title="מטלות שדורשות טיפול" flush>
            <StateView
              loading={tasks.loading}
              error={tasks.error}
              onRetry={tasks.reload}
              empty={!tasks.loading && (tasks.data?.tasks ?? []).length === 0}
              emptyProps={{ icon: '✓', title: 'אין מטלות פתוחות' }}
            >
              <div className="table-wrap">
                <table className="table table-cards">
                  <thead>
                    <tr>
                      <th>פעילות</th>
                      <th>מועד</th>
                      <th>נדרש</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(tasks.data?.tasks ?? []).map((task) => (
                      <tr key={task.id}>
                        <td data-label="פעילות">{task.title ?? task.type_name}</td>
                        <td data-label="מועד" className="tnum">{fmtDate(task.activity_date)} {task.start_time?.slice(0, 5)}</td>
                        <td data-label="נדרש">
                          <Tag tone={new Date(task.ends_at) < new Date() ? 'warn' : 'accent'}>
                            {new Date(task.ends_at) < new Date() ? 'עדכון לאחר סיום' : 'הכנה'}
                          </Tag>
                        </td>
                        <td>
                          <Link to="/activities" className="btn btn-sm">פתיחה</Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </StateView>
          </Panel>

          <Panel
            title="הצוות שלי"
            actions={<Link to="/my-team" className="btn btn-sm">לכל הצוות</Link>}
            flush
          >
            <StateView
              loading={team.loading}
              error={team.error}
              onRetry={team.reload}
              empty={!team.loading && (team.data?.team ?? []).length === 0}
              emptyProps={{ icon: '👥', title: 'עדיין לא שויכו אליך מטמיעים' }}
            >
              <div className="table-wrap">
                <table className="table table-cards">
                  <thead>
                    <tr>
                      <th>שם</th>
                      <th>אתר</th>
                      <th>תחום</th>
                      <th>סטטוס הכשרה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(team.data?.team ?? []).slice(0, 8).map((person) => (
                      <tr key={person.id}>
                        <td data-label="שם" className="bold">{person.full_name}</td>
                        <td data-label="אתר">{person.sites.map((s) => s.name).join(', ') || '—'}</td>
                        <td data-label="תחום">{person.domains.map((d) => d.name).join(', ') || '—'}</td>
                        <td data-label="סטטוס הכשרה">
                          {person.training_status_name
                            ? <Tag>{person.training_status_name}</Tag>
                            : <span className="muted">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </StateView>
          </Panel>
        </>
      )}
    </>
  );
}

function ScheduleRow({ item, showDate }) {
  const tone = { shift: 'accent', activity: '', constraint: 'warn' }[item.kind];
  const kindLabel = { shift: 'משמרת', activity: 'פעילות', constraint: 'אילוץ' }[item.kind];

  return (
    <li
      style={{
        display: 'flex', gap: 'var(--space-3)', alignItems: 'center',
        padding: 'var(--space-3) var(--space-4)',
        borderBlockEnd: '1px solid var(--line-soft)',
        background: item.overlap ? 'var(--danger-bg)' : undefined,
      }}
    >
      <div className="tnum bold nowrap" style={{ minWidth: 56 }}>
        {fmtTime(item.starts_at)}
        <div className="tiny muted">{fmtTime(item.ends_at)}</div>
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="bold">{item.title}</div>
        {item.note && <div className="small" style={{ color: 'var(--primary)' }}>הערה: {item.note}</div>}
        <div className="small muted">
          {showDate && `${dayName(item.entry_date)} ${fmtDate(item.entry_date)} · `}
          {[item.site_name, item.location_name].filter(Boolean).join(' · ')}
        </div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        {item.overlap && <Tag tone="danger">חפיפה</Tag>}
        <Tag tone={tone}>{kindLabel}</Tag>
      </div>
    </li>
  );
}

const Row = ({ label, value }) => (
  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
    <dt className="muted">{label}</dt>
    <dd style={{ margin: 0, fontWeight: 600, textAlign: 'end' }}>{value}</dd>
  </div>
);
