import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Panel, StateView, Tag, Notice, Segmented } from '../components/ui/index.jsx';
import { fmtDate, dayName, today, addDays, weekStartOf, weekDays, fmtWeekRange } from '../lib/format.js';

/**
 * לו״ז צוותי.
 *
 * השדות המוצגים נקבעים בהגדרות והשרת מחזיר רק אותם — מזעור המידע נאכף
 * בשרת ולא בהסתרה בלקוח. אין כאן סיבות אילוץ ואין הערות פרטיות (§7, §14).
 */
export default function TeamSchedule() {
  const { role } = usePermissions();
  const [siteId, setSiteId] = useState('');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState('day');
  // מדריך: כל הצוות באתר, או רק המטמיעים שמשויכים אליו
  const [scope, setScope] = useState(role === 'mentor' ? 'mine' : 'all');

  const siteList = useApi('/api/schedule/team/sites');
  const options = siteList.data?.sites ?? [];

  useEffect(() => {
    if (!siteId && options.length) setSiteId(options[0].id);
  }, [options, siteId]);

  const weekStart = weekStartOf(date);
  const range = mode === 'week' ? { from: weekStart, to: addDays(weekStart, 6) } : { date };
  const schedule = useApi(siteId ? '/api/schedule/team' : null, {
    siteId, ...range, ...(scope === 'mine' ? { mine: '1' } : {}),
  });
  const entries = schedule.data?.entries ?? [];
  const fields = schedule.data?.fields ?? [];

  const labels = {
    name: 'שם', activity: 'פעילות', location: 'מיקום',
    status: 'סטטוס', time: 'שעות', domain: 'תחום',
  };
  const columns = ['name', 'activity', 'location', 'time', 'domain', 'status'].filter(
    (key) => fields.includes(key) || (key === 'location' && fields.includes('site')),
  );

  const days = mode === 'week' ? weekDays(weekStart) : [date];
  const byDay = days.map((d) => ({ day: d, items: entries.filter((e) => (e.date ?? date) === d) }));
  const shift = (n) => setDate(addDays(date, mode === 'week' ? 7 * n : n));

  return (
    <>
      <ViewHead
        title="לו״ז צוות"
        subtitle={scope === 'mine' ? 'המטמיעים שמשויכים אליך' : 'מי עובד באתר — מידע צוותי מותר בלבד'}
        actions={
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            aria-label="בחירת אתר"
            style={{ width: 'auto', minWidth: 180 }}
          >
            {options.length === 0 && <option value="">אין אתרים זמינים</option>}
            {options.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        }
      />

      <div className="row" style={{ marginBlockEnd: 'var(--space-4)', gap: 'var(--space-3)' }}>
        {role === 'mentor' && (
          <Segmented
            label="מי מוצג"
            value={scope}
            onChange={setScope}
            options={[{ value: 'mine', label: 'המטמיעים שלי' }, { value: 'all', label: 'כל הצוות' }]}
          />
        )}
        <Segmented
          label="תצוגה"
          value={mode}
          onChange={setMode}
          options={[{ value: 'day', label: 'יום' }, { value: 'week', label: 'שבוע' }]}
        />
        <div className="row row-end">
          <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(-1)} aria-label="הקודם">
            <ChevronRight size={16} />
          </button>
          {mode === 'day' ? (
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="תאריך" style={{ width: 'auto' }} />
          ) : (
            <span className="bold small tnum nowrap">{fmtWeekRange(weekStart)}</span>
          )}
          <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(1)} aria-label="הבא">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setDate(today())}>היום</button>
        </div>
      </div>

      <Notice icon="🔒">
        <span className="small">
          מוצגים שם, פעילות, מיקום וסטטוס בלבד. סיבות חופשה והערות אישיות
          אינן נחשפות בלו״ז הצוותי.
        </span>
      </Notice>

      <StateView
        loading={schedule.loading || siteList.loading}
        error={schedule.error ?? siteList.error}
        onRetry={schedule.reload}
        empty={!schedule.loading && mode === 'day' && entries.length === 0}
        emptyProps={{ icon: '👥', title: 'אין פעילות מתוכננת ביום הזה' }}
      >
        {byDay.map(({ day, items }) => (
          <Panel key={day} title={`${dayName(day)} · ${fmtDate(day)}`} flush>
            {items.length === 0 ? (
              <p className="small muted" style={{ padding: '4px 20px 16px' }}>אין פעילות מתוכננת</p>
            ) : (
              <div className="table-wrap">
                <table className="table table-cards">
                  <thead>
                    <tr>{columns.map((key) => <th key={key}>{labels[key]}</th>)}</tr>
                  </thead>
                  <tbody>
                    {items.map((entry, index) => (
                      <tr key={index}>
                        {columns.map((key) => (
                          <td key={key} data-label={labels[key]} className={key === 'name' ? 'bold' : ''}>
                            {key === 'status'
                              ? <Tag tone={entry.kind === 'shift' ? 'accent' : ''}>{entry[key]}</Tag>
                              : (entry[key] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ))}
      </StateView>
    </>
  );
}
