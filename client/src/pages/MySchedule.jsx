import { useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Segmented, WeekNav, Empty, Notice } from '../components/ui/index.jsx';
import { fmtDate, fmtTime, fmtWeekRange, dayName, today, addDays, weekStartOf, weekDays } from '../lib/format.js';

/** הלו״ז האישי. חפיפות מסומנות, כפי ש-§7 דורש. */
export default function MySchedule() {
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
        subtitle="שיבוצים, פעילויות ואילוצים — מגרסאות הסידור שפורסמו בלבד"
        actions={
          <>
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
          </>
        }
      />

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
                      style={{
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
    </>
  );
}
