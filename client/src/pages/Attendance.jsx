import { useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { download } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Segmented, WeekNav } from '../components/ui/index.jsx';
import { fmtDate, fmtTime, dayName, today, addDays } from '../lib/format.js';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthLabel = (iso) => `${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
const monthRange = (iso) => {
  const from = `${iso.slice(0, 7)}-01`;
  const d = new Date(`${from}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return { from, to: d.toISOString().slice(0, 10) };
};
const shiftMonth = (iso, n) => {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const STATUS = {
  ok: { label: 'בזמן', tone: 'ok' },
  late: { label: 'איחור', tone: 'warn' },
  early: { label: 'יציאה מוקדמת', tone: 'warn' },
  open: { label: 'במשמרת', tone: 'accent' },
  missing: { label: 'לא דווחה נוכחות', tone: 'danger' },
  unplanned: { label: 'ללא שיבוץ', tone: '' },
  absence: { label: 'חופש / אילוץ', tone: 'accent' },
  upcoming: { label: 'מתוכנן', tone: '' },
};

const Kpi = ({ label, value }) => (
  <div className="kpi">
    <div className="kpi-label">{label}</div>
    <div className="kpi-value">{value}</div>
  </div>
);

/** מספר עם סימן, בכיוון LTR כדי שהמינוס לא יקפוץ לסוף בעברית */
const signed = (n) => <bdi dir="ltr">{n > 0 ? `+${n}` : String(n)}</bdi>;

function StatusTag({ row }) {
  const st = STATUS[row.status] ?? { label: row.status, tone: '' };
  return (
    <span className="row" style={{ gap: 4 }}>
      <Tag tone={st.tone}>{st.label}{row.status === 'late' && row.late_min ? ` ${row.late_min} דק׳` : ''}{row.status === 'early' && row.early_min ? ` ${row.early_min} דק׳` : ''}</Tag>
      {(row.absences ?? []).map((a) => <Tag key={a}>{a}</Tag>)}
    </span>
  );
}

/**
 * נוכחות: דוח יומי, דוח חודשי לאדם וסיכום חודשי.
 *
 * כל שורה מתאימה בין הלו״ז (משמרות שפורסמו ופעילויות) לבין שעת ההגעה והיציאה
 * שנרשמו — איחור, יציאה מוקדמת, ושעות מתוכננות מול בפועל. מטמיע רואה ומייצא
 * את הדוח של עצמו; מדריך — של הצוות שלו; מנהל ההטמעה — של כולם.
 */
export default function Attendance() {
  const { role, profile } = usePermissions();
  const self = role === 'implementer' || role === 'lead';
  const [tab, setTab] = useState(self ? 'monthly' : 'daily');
  const [userId, setUserId] = useState(null);

  const openPerson = (id) => { setUserId(id); setTab('monthly'); };

  const tabs = [
    { value: 'daily', label: 'יומי' },
    { value: 'monthly', label: self ? 'חודשי — הדוח שלי' : 'חודשי לעובד' },
    ...(self ? [] : [{ value: 'summary', label: 'סיכום חודשי' }]),
  ];

  return (
    <>
      <ViewHead
        title="נוכחות"
        subtitle="הלו״ז מול שעות ההגעה והיציאה, וסיכום השעות החודשי"
        actions={<Segmented label="דוח" value={tab} onChange={setTab} options={tabs} />}
      />
      {tab === 'daily' && <Daily self={self} onPerson={openPerson} />}
      {tab === 'monthly' && <Monthly self={self} userId={self ? profile?.id : userId} onUser={setUserId} />}
      {tab === 'summary' && <Summary onPerson={openPerson} />}
    </>
  );
}

function SiteSelect({ value, onChange }) {
  const sites = useApi('/api/sites');
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label="אתר" style={{ width: 'auto' }}>
      <option value="">כל האתרים</option>
      {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

function Daily({ self, onPerson }) {
  const toast = useToast();
  const [date, setDate] = useState(today());
  const [siteId, setSiteId] = useState('');
  const params = { date, siteId: siteId || undefined };
  const report = useApi('/api/attendance/report/daily', params);
  const rows = report.data?.rows ?? [];

  const counts = rows.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] ?? 0) + 1 }), {});

  return (
    <Panel
      title={`${dayName(date)} ${fmtDate(date)}`}
      actions={<>
        {!self && <SiteSelect value={siteId} onChange={setSiteId} />}
        <WeekNav label={fmtDate(date)} onPrev={() => setDate(addDays(date, -1))} onNext={() => setDate(addDays(date, 1))} onToday={() => setDate(today())} />
        <input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} aria-label="תאריך" style={{ width: 'auto' }} />
        <button type="button" className="btn btn-sm"
          onClick={() => download('/api/attendance/report/daily/export.csv', params, `נוכחות-${date}.csv`).catch(toast.error)}>
          ייצוא לאקסל
        </button>
      </>}
      flush
    >
      <StateView loading={report.loading} error={report.error} onRetry={report.reload}
        empty={!report.loading && rows.length === 0}
        emptyProps={{ icon: '🕐', title: 'אין ביום הזה שיבוצים או דיווחי נוכחות' }}>
        {!self && rows.length > 0 && (
          <div className="row small" style={{ gap: 6, padding: 'var(--space-3) var(--space-4) 0' }}>
            {Object.entries(counts).map(([k, n]) => <Tag key={k} tone={STATUS[k]?.tone}>{STATUS[k]?.label ?? k}: {n}</Tag>)}
          </div>
        )}
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>שם</th><th>לו״ז</th><th>הגעה</th><th>יציאה</th><th>שעות מתוכננות</th><th>בפועל</th><th>התאמה</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.user_id}>
                  <td data-label="שם">
                    {self ? <span className="bold">{r.full_name}</span> : (
                      <button type="button" className="link bold" onClick={() => onPerson(r.user_id)}>{r.full_name}</button>
                    )}
                    {r.sites && <div className="tiny muted">{r.sites}</div>}
                  </td>
                  <td data-label="לו״ז" className="small">
                    {r.planned.length === 0 ? '—' : r.planned.map((p, i) => (
                      <div key={i}><span className="tnum">{fmtTime(p.starts_at)}–{fmtTime(p.ends_at)}</span> {p.title}</div>
                    ))}
                  </td>
                  <td data-label="הגעה" className="tnum">{r.first_in ? fmtTime(r.first_in) : '—'}</td>
                  <td data-label="יציאה" className="tnum">{r.last_out ? fmtTime(r.last_out) : r.records.length ? 'פתוח' : '—'}</td>
                  <td data-label="שעות מתוכננות" className="tnum">{r.planned_hours}</td>
                  <td data-label="בפועל" className="tnum bold">{r.actual_hours}</td>
                  <td data-label="התאמה"><StatusTag row={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

function Monthly({ self, userId, onUser }) {
  const toast = useToast();
  const [anchor, setAnchor] = useState(today());
  const users = useApi(self ? null : '/api/users', { status: 'active', limit: 500 });
  const people = (users.data?.users ?? []).filter((u) => u.base_role !== 'manager');
  const chosen = userId ?? (self ? null : people[0]?.id);
  const range = monthRange(anchor);
  const params = { ...range, userId: chosen };
  const report = useApi(chosen ? '/api/attendance/report/monthly' : null, params);
  const r = report.data;

  return (
    <>
      <div className="row" style={{ gap: 'var(--space-3)', marginBlockEnd: 'var(--space-4)' }}>
        {!self && (
          <select value={chosen ?? ''} onChange={(e) => onUser(e.target.value)} aria-label="עובד" style={{ width: 'auto', minWidth: 180 }}>
            {people.map((p) => <option key={p.id} value={p.id}>{p.full_name}</option>)}
          </select>
        )}
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-sm" onClick={() => setAnchor(shiftMonth(anchor, -1))} aria-label="חודש קודם">›</button>
          <span className="bold small nowrap">{monthLabel(anchor)}</span>
          <button type="button" className="btn btn-sm" onClick={() => setAnchor(shiftMonth(anchor, 1))} aria-label="חודש הבא">‹</button>
        </div>
        <button type="button" className="btn btn-sm row-end" disabled={!chosen}
          onClick={() => download('/api/attendance/report/monthly/export.csv', params,
            `נוכחות-${r?.person?.full_name ?? ''}-${range.from.slice(0, 7)}.csv`).catch(toast.error)}>
          {self ? 'ייצוא הדוח שלי לאקסל' : 'ייצוא לאקסל'}
        </button>
      </div>

      <StateView loading={report.loading || users.loading} error={report.error ?? users.error} onRetry={report.reload}
        empty={!chosen && !users.loading} emptyProps={{ icon: '👤', title: 'אין עובדים להצגה' }}>
        {r && (
          <>
            <div className="kpi-strip" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <Kpi label="שעות מתוכננות" value={r.totals.planned_hours} />
              <Kpi label="שעות בפועל" value={r.totals.actual_hours} />
              <Kpi label="הפרש" value={signed(r.totals.diff_hours)} />
              <Kpi label="ימי נוכחות" value={`${r.totals.work_days}/${r.totals.planned_days}`} />
              <Kpi label="ימי איחור" value={r.totals.late_days} />
              <Kpi label="ימים בלי דיווח" value={r.totals.missing_days} />
            </div>
            <Panel title={`${r.person.full_name} · ${monthLabel(anchor)}`} flush>
              <StateView empty={r.rows.length === 0} emptyProps={{ icon: '🕐', title: 'אין בחודש הזה שיבוצים או נוכחות' }}>
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead>
                      <tr><th>יום</th><th>לו״ז</th><th>הגעה</th><th>יציאה</th><th>מתוכנן</th><th>בפועל</th><th>הפרש</th><th>התאמה</th></tr>
                    </thead>
                    <tbody>
                      {r.rows.map((d) => (
                        <tr key={d.date}>
                          <td data-label="יום" className="nowrap">{dayName(d.date)} <span className="tnum small muted">{fmtDate(d.date)}</span></td>
                          <td data-label="לו״ז" className="small">
                            {d.planned.length === 0 ? '—' : d.planned.map((p, i) => (
                              <div key={i}><span className="tnum">{fmtTime(p.starts_at)}–{fmtTime(p.ends_at)}</span> {p.title}</div>
                            ))}
                          </td>
                          <td data-label="הגעה" className="tnum">{d.first_in ? fmtTime(d.first_in) : '—'}</td>
                          <td data-label="יציאה" className="tnum">{d.last_out ? fmtTime(d.last_out) : d.records.length ? 'פתוח' : '—'}</td>
                          <td data-label="מתוכנן" className="tnum">{d.planned_hours}</td>
                          <td data-label="בפועל" className="tnum bold">{d.actual_hours}</td>
                          <td data-label="הפרש" className="tnum">{d.records.length || d.planned.length ? signed(d.diff_hours) : ''}</td>
                          <td data-label="התאמה"><StatusTag row={d} /></td>
                        </tr>
                      ))}
                      <tr className="bold">
                        <td data-label="סה״כ">סה״כ</td>
                        <td />
                        <td />
                        <td />
                        <td data-label="מתוכנן" className="tnum">{r.totals.planned_hours}</td>
                        <td data-label="בפועל" className="tnum">{r.totals.actual_hours}</td>
                        <td data-label="הפרש" className="tnum">{signed(r.totals.diff_hours)}</td>
                        <td />
                      </tr>
                    </tbody>
                  </table>
                </div>
              </StateView>
            </Panel>
          </>
        )}
      </StateView>
    </>
  );
}

function Summary({ onPerson }) {
  const toast = useToast();
  const [anchor, setAnchor] = useState(today());
  const [siteId, setSiteId] = useState('');
  const params = { ...monthRange(anchor), siteId: siteId || undefined };
  const report = useApi('/api/attendance/report/summary', params);
  const people = report.data?.people ?? [];

  return (
    <Panel
      title={`סיכום ${monthLabel(anchor)}`}
      actions={<>
        <SiteSelect value={siteId} onChange={setSiteId} />
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-sm" onClick={() => setAnchor(shiftMonth(anchor, -1))} aria-label="חודש קודם">›</button>
          <span className="bold small nowrap">{monthLabel(anchor)}</span>
          <button type="button" className="btn btn-sm" onClick={() => setAnchor(shiftMonth(anchor, 1))} aria-label="חודש הבא">‹</button>
        </div>
        <button type="button" className="btn btn-sm"
          onClick={() => download('/api/attendance/report/summary/export.csv', params, `נוכחות-סיכום-${params.from.slice(0, 7)}.csv`).catch(toast.error)}>
          ייצוא לאקסל
        </button>
      </>}
      flush
    >
      <StateView loading={report.loading} error={report.error} onRetry={report.reload}
        empty={!report.loading && people.length === 0} emptyProps={{ icon: '📊', title: 'אין נתונים בחודש הזה' }}>
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>שם</th><th>ימי נוכחות</th><th>שעות מתוכננות</th><th>שעות בפועל</th><th>הפרש</th><th>ימי איחור</th><th>בלי דיווח</th><th>חופש / אילוץ</th></tr>
            </thead>
            <tbody>
              {people.map((p) => (
                <tr key={p.id}>
                  <td data-label="שם">
                    <button type="button" className="link bold" onClick={() => onPerson(p.id)}>{p.full_name}</button>
                    {p.sites && <div className="tiny muted">{p.sites}</div>}
                  </td>
                  <td data-label="ימי נוכחות" className="tnum">{p.work_days}/{p.planned_days}</td>
                  <td data-label="שעות מתוכננות" className="tnum">{p.planned_hours}</td>
                  <td data-label="שעות בפועל" className="tnum bold">{p.actual_hours}</td>
                  <td data-label="הפרש" className="tnum">{signed(p.diff_hours)}</td>
                  <td data-label="ימי איחור" className="tnum">{p.late_days ? <Tag tone="warn">{p.late_days}</Tag> : 0}</td>
                  <td data-label="בלי דיווח" className="tnum">{p.missing_days ? <Tag tone="danger">{p.missing_days}</Tag> : 0}</td>
                  <td data-label="חופש / אילוץ" className="tnum">{p.absence_days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}
