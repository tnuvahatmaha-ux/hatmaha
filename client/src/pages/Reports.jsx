import { useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { download } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Segmented, Empty } from '../components/ui/index.jsx';
import { fmtDate, dayName, today, addDays, weekStartOf, STATUS_NAMES } from '../lib/format.js';

/** דוחות: שעות, כיסוי משמרות, הכשרה, ובקשות וחריגות. */
export default function Reports() {
  const toast = useToast();
  const [tab, setTab] = useState('workload');
  const [range, setRange] = useState({
    from: weekStartOf(today()),
    to: addDays(weekStartOf(today()), 27),
    siteId: '',
    domainId: '',
  });

  const sites = useApi('/api/sites');
  const domains = useApi('/api/settings/domains');

  return (
    <>
      <ViewHead
        title="דוחות"
        subtitle="שעות, כיסוי משמרות, מצב הכשרה ובקשות"
        actions={
          <Segmented
            label="סוג הדוח"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'workload', label: 'שעות' },
              { value: 'coverage', label: 'כיסוי' },
              { value: 'training', label: 'הכשרה' },
              { value: 'requests', label: 'בקשות' },
            ]}
          />
        }
      />

      <Panel title="סינון" flush>
        <div className="panel-body row">
          <label className="small">
            מתאריך{' '}
            <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} style={{ width: 'auto' }} />
          </label>
          <label className="small">
            עד{' '}
            <input type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} style={{ width: 'auto' }} />
          </label>
          <select value={range.siteId} onChange={(e) => setRange({ ...range, siteId: e.target.value })} aria-label="אתר" style={{ width: 'auto' }}>
            <option value="">כל האתרים</option>
            {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={range.domainId} onChange={(e) => setRange({ ...range, domainId: e.target.value })} aria-label="תחום" style={{ width: 'auto' }}>
            <option value="">כל התחומים</option>
            {(domains.data?.domains ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </div>
      </Panel>

      {tab === 'workload' && <Workload range={range} onExport={() => download('/api/reports/workload/export.csv', range, `דוח-שעות-${range.from}.csv`).catch(toast.error)} />}
      {tab === 'coverage' && <Coverage range={range} />}
      {tab === 'training' && <Training range={range} />}
      {tab === 'requests' && <Requests range={range} />}
    </>
  );
}

function Workload({ range, onExport }) {
  const report = useApi('/api/reports/workload', range);
  const rows = report.data?.rows ?? [];
  const totalHours = rows.reduce((sum, r) => sum + Number(r.total_hours ?? 0), 0);

  return (
    <Panel
      title="שעות לפי מטמיע"
      subtitle="משמרות מגרסאות שפורסמו, ופעילויות מתוכננות והושלמו"
      actions={<button type="button" className="btn btn-sm" onClick={onExport}>ייצוא CSV</button>}
      flush
    >
      <StateView
        loading={report.loading}
        error={report.error}
        onRetry={report.reload}
        empty={!report.loading && rows.length === 0}
        emptyProps={{ icon: '📊', title: 'אין נתונים בטווח שנבחר' }}
      >
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>שם</th><th>שעות משמרות</th><th>שעות פעילויות</th><th>סה״כ</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id}>
                  <td data-label="שם" className="bold">{row.full_name}</td>
                  <td data-label="שעות משמרות" className="tnum">{row.shift_hours}</td>
                  <td data-label="שעות פעילויות" className="tnum">{row.activity_hours}</td>
                  <td data-label="סה״כ" className="tnum bold">{row.total_hours}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ background: 'var(--surface-2)', fontWeight: 800 }}>
                <td>סה״כ</td><td /><td />
                <td className="tnum">{totalHours.toFixed(1)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

function Coverage({ range }) {
  const report = useApi(range.siteId ? '/api/reports/coverage' : null, range);
  const rows = report.data?.rows ?? [];
  const gaps = rows.filter((r) => r.gap > 0);

  if (!range.siteId) {
    return (
      <Panel>
        <Empty icon="🏥" title="בחר/י אתר" text="דוח הכיסוי מוצג לאתר אחד בכל פעם." />
      </Panel>
    );
  }

  return (
    <Panel
      title="כיסוי משמרות"
      subtitle="תקן כוח אדם מול מה שמשובץ בפועל, מגרסאות שפורסמו"
      actions={gaps.length > 0 ? <Tag tone="warn">{gaps.length} משמרות בחוסר</Tag> : <Tag tone="ok">כיסוי מלא</Tag>}
      flush
    >
      <StateView
        loading={report.loading}
        error={report.error}
        onRetry={report.reload}
        empty={!report.loading && rows.length === 0}
        emptyProps={{ icon: '📊', title: 'אין נתונים בטווח שנבחר' }}
      >
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>תאריך</th><th>משמרת</th><th>תקן</th><th>משובצים</th><th>חוסר</th></tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} style={row.gap > 0 ? { background: 'var(--warn-bg)' } : undefined}>
                  <td data-label="תאריך" className="tnum">
                    {dayName(row.date)} {fmtDate(row.date)}
                  </td>
                  <td data-label="משמרת" className="bold">{row.shift_name}</td>
                  <td data-label="תקן" className="tnum">{row.required_staff}</td>
                  <td data-label="משובצים" className="tnum">{row.assigned}</td>
                  <td data-label="חוסר">
                    {row.gap > 0 ? <Tag tone="warn">{row.gap}</Tag> : <Tag tone="ok">✓</Tag>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

function Training({ range }) {
  const report = useApi('/api/reports/training', { siteId: range.siteId, domainId: range.domainId });
  const rows = report.data?.rows ?? [];

  return (
    <Panel title="מצב הכשרה" subtitle="התקדמות במסלול ההכשרה לכל מטמיע" flush>
      <StateView
        loading={report.loading}
        error={report.error}
        onRetry={report.reload}
        empty={!report.loading && rows.length === 0}
        emptyProps={{ icon: '🎓', title: 'אין נתוני הכשרה' }}
      >
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>שם</th><th>סטטוס</th><th>הושלמו</th><th>התקדמות</th></tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.user_id}>
                  <td data-label="שם" className="bold">{row.full_name}</td>
                  <td data-label="סטטוס">{row.training_status ? <Tag>{row.training_status}</Tag> : '—'}</td>
                  <td data-label="הושלמו" className="tnum">{row.completed_items}/{row.total_items}</td>
                  <td data-label="התקדמות">
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ flex: 1, height: 10, border: '2px solid var(--ink)', background: 'var(--surface)', minWidth: 80 }}>
                        <div style={{ width: `${row.percent}%`, height: '100%', background: 'var(--primary)' }} />
                      </div>
                      <span className="tnum small bold">{row.percent}%</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

function Requests({ range }) {
  const report = useApi('/api/reports/requests', range);

  return (
    <StateView loading={report.loading} error={report.error} onRetry={report.reload}>
      <Panel title="בקשות אילוץ לפי סוג וסטטוס" flush>
        {(report.data?.requests ?? []).length === 0 ? (
          <Empty icon="📝" title="אין בקשות בטווח שנבחר" />
        ) : (
          <div className="table-wrap">
            <table className="table table-cards">
              <thead><tr><th>סוג</th><th>סטטוס</th><th>כמות</th></tr></thead>
              <tbody>
                {report.data.requests.map((row, i) => (
                  <tr key={i}>
                    <td data-label="סוג" className="bold">{row.type_name}</td>
                    <td data-label="סטטוס">{STATUS_NAMES[row.status] ?? row.status}</td>
                    <td data-label="כמות" className="tnum">{row.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="חריגות — זמן עד להחלטה" flush>
        {(report.data?.exceptions ?? []).length === 0 ? (
          <Empty icon="⚖️" title="אין חריגות בטווח שנבחר" />
        ) : (
          <div className="table-wrap">
            <table className="table table-cards">
              <thead><tr><th>סטטוס</th><th>כמות</th><th>זמן ממוצע להחלטה</th></tr></thead>
              <tbody>
                {report.data.exceptions.map((row, i) => (
                  <tr key={i}>
                    <td data-label="סטטוס">{STATUS_NAMES[row.status] ?? row.status}</td>
                    <td data-label="כמות" className="tnum">{row.count}</td>
                    <td data-label="זמן ממוצע להחלטה" className="tnum">
                      {row.avg_hours_to_decision != null ? `${row.avg_hours_to_decision} שעות` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </StateView>
  );
}
