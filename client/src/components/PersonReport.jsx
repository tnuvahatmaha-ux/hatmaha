import { useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { download, post, patch, del } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { Panel, StateView, Tag, Segmented, Empty, Modal, Field } from './ui/index.jsx';
import { fmtDate, fmtTime, dayName, today, fmtWeekRange } from '../lib/format.js';

const MONTHS = ['ינואר', 'פברואר', 'מרץ', 'אפריל', 'מאי', 'יוני', 'יולי', 'אוגוסט', 'ספטמבר', 'אוקטובר', 'נובמבר', 'דצמבר'];
const monthLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
const monthEnd = (iso) => {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};
const shiftMonth = (iso, n) => {
  const d = new Date(`${iso.slice(0, 7)}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * דוח מטמיע: משמרות ופעילויות (מתוכנן), נוכחות (בפועל) וחופשים —
 * מסוכם לפי שבוע או לפי חודש, עם פירוט יומי וייצוא.
 * self — דוח השעות של המשתמש עצמו (מתוך "הלו״ז שלי").
 */
export function PersonReport({ userId, self = false }) {
  const toast = useToast();
  const { can } = usePermissions();
  const canFix = !self && can('implementers', 'edit');
  const [editing, setEditing] = useState(null);
  const [period, setPeriod] = useState('month');
  const [anchor, setAnchor] = useState(today());
  const [custom, setCustom] = useState(null);

  const range = custom ?? (period === 'month'
    ? { from: monthStart(anchor), to: monthEnd(anchor) }
    : { from: monthStart(shiftMonth(anchor, -2)), to: monthEnd(anchor) });
  const report = useApi(userId ? '/api/reports/person' : null, { userId, ...range });
  const r = report.data;
  const [groupBy, setGroupBy] = useState('week');

  const exportCsv = () =>
    download('/api/reports/person/export.csv', { userId, ...range }, `דוח-שעות-${range.from}.csv`).catch(toast.error);

  const byDate = new Map();
  for (const w of r?.work ?? []) (byDate.get(w.date) ?? byDate.set(w.date, { work: [], att: [], abs: [] }).get(w.date)).work.push(w);
  for (const a of r?.attendance ?? []) (byDate.get(a.date) ?? byDate.set(a.date, { work: [], att: [], abs: [] }).get(a.date)).att.push(a);
  for (const a of r?.absences ?? []) (byDate.get(a.date) ?? byDate.set(a.date, { work: [], att: [], abs: [] }).get(a.date)).abs.push(a);
  const dates = [...byDate.keys()].sort().reverse();
  const groups = groupBy === 'week' ? r?.weeks ?? [] : r?.months ?? [];

  return (
    <>
      <div className="row" style={{ gap: 'var(--space-3)', marginBlockEnd: 'var(--space-4)' }}>
        <Segmented
          label="טווח"
          value={custom ? 'custom' : period}
          onChange={(v) => { if (v === 'custom') setCustom({ from: range.from, to: range.to }); else { setCustom(null); setPeriod(v); } }}
          options={[{ value: 'month', label: 'חודש' }, { value: 'quarter', label: '3 חודשים' }, { value: 'custom', label: 'טווח חופשי' }]}
        />
        {custom ? (
          <>
            <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} aria-label="מתאריך" style={{ width: 'auto' }} />
            <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} aria-label="עד תאריך" style={{ width: 'auto' }} />
          </>
        ) : (
          <div className="row" style={{ gap: 4 }}>
            <button type="button" className="btn btn-sm" onClick={() => setAnchor(shiftMonth(anchor, -1))} aria-label="חודש קודם">›</button>
            <span className="bold small nowrap">{period === 'month' ? monthLabel(anchor) : `${monthLabel(shiftMonth(anchor, -2))} – ${monthLabel(anchor)}`}</span>
            <button type="button" className="btn btn-sm" onClick={() => setAnchor(shiftMonth(anchor, 1))} aria-label="חודש הבא">‹</button>
          </div>
        )}
        <button type="button" className="btn btn-sm row-end" onClick={exportCsv} disabled={!userId}>ייצוא לאקסל</button>
      </div>

      <StateView loading={report.loading} error={report.error} onRetry={report.reload}>
        {r && (
          <>
            {!self && r.person && (
              <div className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
                {[r.person.sites, r.person.domains, r.person.mentor_name && `מדריך: ${r.person.mentor_name}`].filter(Boolean).join(' · ')}
              </div>
            )}
            <div className="kpi-strip" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <Kpi label="שעות מתוכננות" value={r.totals.planned_hours} />
              <Kpi label="שעות בפועל (נוכחות)" value={r.totals.actual_hours} />
              <Kpi label="משמרות" value={r.totals.shifts} />
              <Kpi label="ימי עבודה" value={r.totals.work_days} />
              <Kpi label="ימי חופש / היעדרות" value={r.totals.absence_days} />
            </div>

            <Panel
              title="סיכום"
              actions={<Segmented label="קיבוץ" value={groupBy} onChange={setGroupBy}
                options={[{ value: 'week', label: 'לפי שבוע' }, { value: 'month', label: 'לפי חודש' }]} />}
              flush
            >
              {groups.length === 0 ? <Empty icon="📊" title="אין נתונים בטווח הזה" /> : (
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead>
                      <tr><th>{groupBy === 'week' ? 'שבוע' : 'חודש'}</th><th>משמרות</th><th>שעות משמרות</th><th>שעות פעילויות</th><th>סה״כ מתוכנן</th><th>בפועל</th><th>חופשים / אילוצים</th></tr>
                    </thead>
                    <tbody>
                      {groups.map((g) => (
                        <tr key={g.key}>
                          <td data-label={groupBy === 'week' ? 'שבוע' : 'חודש'} className="bold tnum">{groupBy === 'week' ? fmtWeekRange(g.key) : monthLabel(g.key)}</td>
                          <td data-label="משמרות" className="tnum">{g.shifts}</td>
                          <td data-label="שעות משמרות" className="tnum">{g.shift_hours}</td>
                          <td data-label="שעות פעילויות" className="tnum">{g.activity_hours}</td>
                          <td data-label="סה״כ מתוכנן" className="tnum bold">{g.planned_hours}</td>
                          <td data-label="בפועל" className="tnum">{g.actual_hours}</td>
                          <td data-label="חופשים / אילוצים" className="small">
                            {Object.entries(g.absences).map(([k, v]) => `${k} ×${v}`).join(' · ') || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>

            <Panel title="פירוט יומי" subtitle="מתוכנן מול נוכחות בפועל"
              actions={canFix && <button type="button" className="btn btn-sm" onClick={() => setEditing({})}>+ רישום נוכחות</button>}
              flush>
              {dates.length === 0 ? <Empty icon="🗓️" title="אין רשומות בטווח" /> : (
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead><tr><th>תאריך</th><th>מתוכנן</th><th>נוכחות</th><th>חופש / אילוץ</th></tr></thead>
                    <tbody>
                      {dates.map((d) => {
                        const day = byDate.get(d);
                        return (
                          <tr key={d}>
                            <td data-label="תאריך" className="bold tnum nowrap">{dayName(d)} {fmtDate(d)}</td>
                            <td data-label="מתוכנן" className="small">
                              {day.work.map((w, i) => (
                                <div key={i}>
                                  <span className="tnum">{fmtTime(w.starts_at)}–{fmtTime(w.ends_at)}</span>{' '}
                                  {w.title}{w.location_name ? ` · ${w.location_name}` : ''}{' '}
                                  <Tag tone={w.kind === 'shift' ? 'accent' : ''}>{w.kind === 'shift' ? 'משמרת' : 'פעילות'}</Tag>
                                </div>
                              ))}
                              {day.work.length === 0 && <span className="muted">—</span>}
                            </td>
                            <td data-label="נוכחות" className="small tnum">
                              {day.att.map((a) => (
                                <div key={a.id}>
                                  {fmtTime(a.clock_in_at)}–{a.clock_out_at ? fmtTime(a.clock_out_at) : 'פתוח'}
                                  {a.hours != null && <span className="muted"> ({a.hours} ש׳)</span>}
                                  {a.source === 'manager' && <span className="tiny muted"> · תוקן</span>}
                                  {canFix && (
                                    <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(a)}>תיקון</button>
                                  )}
                                </div>
                              ))}
                              {day.att.length === 0 && <span className="muted">—</span>}
                            </td>
                            <td data-label="חופש / אילוץ" className="small">
                              {day.abs.map((a) => <Tag key={a.id} tone="warn">{a.type_name}{a.full_day ? '' : ` ${a.start_time.slice(0, 5)}–${a.end_time.slice(0, 5)}`}</Tag>)}
                              {day.abs.length === 0 && <span className="muted">—</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </Panel>
          </>
        )}
      </StateView>
      {editing && (
        <AttendanceEdit record={editing} userId={userId} onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); report.reload(); }} />
      )}
    </>
  );
}

/** 'YYYY-MM-DDTHH:MM' בשעון ישראל, לשדה datetime-local */
const toLocalInput = (iso) => {
  if (!iso) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

/** תיקון או הוספה של רישום נוכחות ע״י מנהל / מדריך */
function AttendanceEdit({ record, userId, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    clockIn: toLocalInput(record.clock_in_at) || `${today()}T08:00`,
    clockOut: toLocalInput(record.clock_out_at),
    note: record.note ?? '',
  });
  const save = useAction(
    async () => {
      const body = { clockIn: form.clockIn, clockOut: form.clockOut || null, note: form.note || null };
      if (record.id) await patch(`/api/attendance/${record.id}`, body);
      else await post('/api/attendance', { ...body, userId });
      toast.success('הנוכחות נשמרה');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );
  const remove = useAction(
    async () => { await del(`/api/attendance/${record.id}`); toast.success('הרישום נמחק'); onSaved(); },
    { onError: (err) => toast.error(err) },
  );
  return (
    <Modal title={record.id ? 'תיקון נוכחות' : 'רישום נוכחות'} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || !form.clockIn}>שמירה</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        {record.id && <button type="button" className="btn btn-sm btn-danger" style={{ marginInlineStart: 'auto' }}
          onClick={() => remove.run()} disabled={remove.busy}>מחיקה</button>}
      </>}>
      <div className="grid grid-2">
        <Field label="כניסה" required>
          {(props) => <input {...props} type="datetime-local" value={form.clockIn} onChange={(e) => setForm({ ...form, clockIn: e.target.value })} />}
        </Field>
        <Field label="יציאה">
          {(props) => <input {...props} type="datetime-local" value={form.clockOut} onChange={(e) => setForm({ ...form, clockOut: e.target.value })} />}
        </Field>
      </div>
      <Field label="הערה">
        {(props) => <input {...props} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}
      </Field>
    </Modal>
  );
}

const Kpi = ({ label, value }) => (
  <div className="kpi">
    <div className="kpi-label">{label}</div>
    <div className="kpi-value">{value}</div>
  </div>
);

