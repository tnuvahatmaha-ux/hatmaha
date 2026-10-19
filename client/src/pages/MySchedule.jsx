import { useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Segmented, WeekNav, Empty, Notice } from '../components/ui/index.jsx';
import { fmtDate, fmtTime, fmtWeekRange, dayName, today, addDays, weekStartOf, weekDays } from '../lib/format.js';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ActivityDetailDialog } from '../components/ActivityDetail.jsx';
import { PersonReport } from '../components/PersonReport.jsx';

/** הלו״ז האישי. חפיפות מסומנות, כפי ש-§7 דורש. */
export default function MySchedule() {
  const { profile } = usePermissions();
  const [view, setView] = useState('schedule');
  const [openActivity, setOpenActivity] = useState(null);
  const [mode, setMode] = useState('week');
  const [anchor, setAnchor] = useState(today());

  const from = mode === 'week' ? weekStartOf(anchor) : anchor;
  const to = mode === 'week' ? addDays(from, 6) : anchor;

  const schedule = useApi('/api/schedule/me', { from, to });
  const items = schedule.data?.items ?? [];
  const overlaps = items.filter((i) => i.overlap);

  const days = mode === 'week' ? weekDays(from) : [anchor];

  return (
    <>
      <ViewHead
        title="הלו״ז שלי"
        subtitle={view === 'hours' ? 'שעות עבודה, נוכחות וחופשים — לפי שבוע וחודש' : 'שיבוצים, פעילויות ואילוצים — מגרסאות הסידור שפורסמו בלבד'}
        actions={
          <>
            <Segmented
              label="מסך"
              value={view}
              onChange={setView}
              options={[{ value: 'schedule', label: 'לו״ז' }, { value: 'hours', label: 'דוח שעות' }]}
            />
            {view === 'schedule' && (<>
            <Segmented
              label="תצוגה"
              value={mode}
              onChange={setMode}
              options={[{ value: 'day', label: 'יומי' }, { value: 'week', label: 'שבועי' }]}
            />
            <WeekNav
              label={mode === 'week' ? fmtWeekRange(from) : `${dayName(anchor)} ${fmtDate(anchor)}`}
              onPrev={() => setAnchor(addDays(anchor, mode === 'week' ? -7 : -1))}
              onNext={() => setAnchor(addDays(anchor, mode === 'week' ? 7 : 1))}
              onToday={() => setAnchor(today())}
            />
            </>)}
          </>
        }
      />

      {view === 'hours' ? <PersonReport userId={profile?.id} self /> : (<>

      {overlaps.length > 0 && (
        <Notice tone="danger" icon="⚠" title="יש חפיפות בלו״ז שלך">
          {overlaps.length / 2} התנגשויות. פנה/י למנהל ההטמעה או למדריך שלך.
        </Notice>
      )}

      <StateView
        loading={schedule.loading}
        error={schedule.error}
        onRetry={schedule.reload}
        empty={!schedule.loading && items.length === 0}
        emptyProps={{ icon: '🗓️', title: 'אין פעילויות או שיבוצים בטווח הזה' }}
      >
        {days.map((date) => {
          const dayItems = items.filter((i) => i.entry_date === date);
          if (mode === 'week' && dayItems.length === 0) return null;

          return (
            <Panel key={date} title={`${dayName(date)} · ${fmtDate(date)}`} flush>
              {dayItems.length === 0 ? (
                <Empty icon="☕" title="אין פעילויות ביום הזה" />
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {dayItems.map((item) => (
                    <li
                      key={`${item.kind}-${item.id}`}
                      onClick={item.kind === 'activity' ? () => setOpenActivity(item.id) : undefined}
                      onKeyDown={item.kind === 'activity' ? (e) => { if (e.key === 'Enter') setOpenActivity(item.id); } : undefined}
                      tabIndex={item.kind === 'activity' ? 0 : undefined}
                      role={item.kind === 'activity' ? 'button' : undefined}
                      style={{
                        cursor: item.kind === 'activity' ? 'pointer' : undefined,
                        display: 'flex', gap: 'var(--space-3)', alignItems: 'center',
                        padding: 'var(--space-3) var(--space-4)',
                        borderBlockEnd: '1px solid var(--line-soft)',
                        background: item.overlap ? 'var(--danger-bg)' : undefined,
                      }}
                    >
                      <div className="tnum bold" style={{ minWidth: 56 }}>
                        {fmtTime(item.starts_at)}
                        <div className="tiny muted">{fmtTime(item.ends_at)}</div>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="bold">{item.title}</div>
                        <div className="small muted">
                          {[item.site_name, item.location_name].filter(Boolean).join(' · ') || '—'}
                        </div>
                        {item.note && (
                          <div className="small" style={{ color: 'var(--primary)', marginBlockStart: 2 }}>
                            הערה: {item.note}
                          </div>
                        )}
                      </div>
                      {item.overlap && <Tag tone="danger">חפיפה</Tag>}
                      {item.as_instructor && <Tag tone="accent">מעביר/ה</Tag>}
                      {item.kind === 'activity' && <span className="tiny muted" aria-hidden="true">פירוט ›</span>}
                      <Tag tone={{ shift: 'accent', activity: '', constraint: 'warn' }[item.kind]}>
                        {{ shift: 'משמרת', activity: 'פעילות', constraint: 'אילוץ' }[item.kind]}
                      </Tag>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          );
        })}
      </StateView>
      </>)}

      {openActivity && <ActivityDetailDialog activityId={openActivity} onClose={() => setOpenActivity(null)} />}
    </>
  );
}
