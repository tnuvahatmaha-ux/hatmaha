import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Notice, Empty } from '../components/ui/index.jsx';
import { fmtDate, dayName, today, addDays } from '../lib/format.js';

/**
 * לו״ז צוותי.
 *
 * השדות המוצגים נקבעים בהגדרות והשרת מחזיר רק אותם — מזעור המידע נאכף
 * בשרת ולא בהסתרה בלקוח. אין כאן סיבות אילוץ ואין הערות פרטיות (§7, §14).
 */
export default function TeamSchedule() {
  const { sites } = usePermissions();
  const [siteId, setSiteId] = useState('');
  const [date, setDate] = useState(today());

  const allSites = useApi('/api/sites');
  const options = allSites.data?.sites ?? sites;

  useEffect(() => {
    if (!siteId && options.length) setSiteId(options[0].id);
  }, [options, siteId]);

  const schedule = useApi(siteId ? '/api/schedule/team' : null, { siteId, date });
  const entries = schedule.data?.entries ?? [];
  const fields = schedule.data?.fields ?? [];

  const labels = {
    name: 'שם', activity: 'פעילות', location: 'מיקום',
    status: 'סטטוס', time: 'שעות', domain: 'תחום',
  };
  const columns = ['name', 'activity', 'location', 'time', 'domain', 'status'].filter(
    (key) => fields.includes(key) || (key === 'location' && fields.includes('site')),
  );

  return (
    <>
      <ViewHead
        title="לו״ז צוות"
        subtitle="מי עובד היום באתר — מידע צוותי מותר בלבד"
        actions={
          <>
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              aria-label="בחירת אתר"
              style={{ width: 'auto', minWidth: 160 }}
            >
              {options.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
            </select>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              aria-label="תאריך"
              style={{ width: 'auto' }}
            />
            <button type="button" className="btn btn-sm" onClick={() => setDate(today())}>היום</button>
          </>
        }
      />

      <Notice icon="🔒">
        <span className="small">
          התצוגה מציגה שם, פעילות, מיקום וסטטוס בלבד. סיבות חופשה והערות אישיות
          אינן נחשפות בלו״ז הצוותי.
        </span>
      </Notice>

      <Panel title={`${dayName(date)} · ${fmtDate(date)}`} flush>
        <StateView
          loading={schedule.loading}
          error={schedule.error}
          onRetry={schedule.reload}
          empty={!schedule.loading && entries.length === 0}
          emptyProps={{ icon: '👥', title: 'אין פעילות מתוכננת ביום הזה' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>{columns.map((key) => <th key={key}>{labels[key]}</th>)}</tr>
              </thead>
              <tbody>
                {entries.map((entry, index) => (
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
        </StateView>
      </Panel>
    </>
  );
}
