import { Fragment, useMemo, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useApi, useAction } from '../lib/useApi.js';
import { post, patch, del } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Field, Modal, Notice, Empty, Segmented } from '../components/ui/index.jsx';
import { fmtDate, fmtDateTime, fmtWeekRange, today, addDays, weekStartOf, STATUS_NAMES, statusTone } from '../lib/format.js';

const DAY_PX = 14;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** סטטוס לפי אחוז — אותו סטטוס בטבלה ובסימון המרוכז */
export const STAGE_STATUSES = [
  { pct: 0, label: 'לא התחיל' },
  { pct: 25, label: '25%' },
  { pct: 50, label: 'בתהליך · 50%' },
  { pct: 75, label: '75%' },
  { pct: 100, label: 'הושלם' },
];
const statusOf = (pct) => (pct >= 100 ? { label: 'הושלם', tone: 'ok' } : pct > 0 ? { label: `${pct}%`, tone: 'accent' } : { label: 'לא התחיל', tone: '' });

/**
 * הכשרה — מנהל ההטמעה והמדריכים בלבד (המטמיע אינו רואה את הלשונית).
 *
 * שתי תצוגות: טבלה — שורה לכל עובד ועמודה לכל שלב, עם סימון סטטוס לכמה שלבים
 * יחד; וגאנט — שלבי ההכשרה על ציר הזמן. מדריך מדווח, ומנהל ההטמעה מאשר.
 * גאנט כללי אפשר לטעון מקובץ ולשייך אליו עובדים.
 */
export default function Training() {
  const { can, role } = usePermissions();
  const toast = useToast();
  const [siteId, setSiteId] = useState('');
  const [domainId, setDomainId] = useState('');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(null);
  const [view, setView] = useState('table');
  const [importing, setImporting] = useState(false);

  const self = role === 'implementer' || role === 'lead';
  const canEdit = can('implementers', 'edit');
  const canApprove = can('implementers', 'approve');

  const sites = useApi(self ? null : '/api/sites');
  const domains = useApi(self ? null : '/api/settings/domains');
  const plans = useApi(self ? null : '/api/training/plans', { siteId: siteId || undefined, domainId: domainId || undefined });
  const pending = useApi(canApprove ? '/api/training/progress/pending' : null);

  const people = plans.data?.people ?? [];
  const reload = () => { plans.reload(); pending.reload(); };

  const decide = useAction(
    async (u, decision) => {
      await post(`/api/training/progress/${u.id}/decision`, { decision });
      toast.success(decision === 'approve' ? `ההתקדמות של ${u.full_name} אושרה` : 'הדיווח נדחה');
      reload();
    },
    { onError: (err) => toast.error(err) },
  );

  if (self) return <Navigate to="/" replace />;

  return (
    <>
      <ViewHead
        title="הכשרה"
        subtitle="סטטוס שלבי ההכשרה של כל עובד, והתקדמות מאושרת באחוזים"
        actions={(
          <>
            <Segmented label="תצוגה" value={view} onChange={setView}
              options={[{ value: 'table', label: 'טבלה' }, { value: 'gantt', label: 'גאנט' }]} />
            {canEdit && (
              <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>טעינת גאנט מקובץ</button>
            )}
            <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="אתר" style={{ width: 'auto' }}>
              <option value="">כל האתרים</option>
              {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
            <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="תחום" style={{ width: 'auto' }}>
              <option value="">כל התחומים</option>
              {(domains.data?.domains ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          </>
        )}
      />

      {canApprove && (pending.data?.updates ?? []).length > 0 && (
        <Panel title={`דיווחי התקדמות לאישור (${pending.data.updates.length})`} flush>
          <div className="table-wrap">
            <table className="table table-cards">
              <thead><tr><th>מטמיע</th><th>שלב</th><th>שבוע</th><th>התקדמות</th><th>הערה</th><th /></tr></thead>
              <tbody>
                {pending.data.updates.map((u) => (
                  <tr key={u.id}>
                    <td data-label="מטמיע" className="bold">{u.full_name}<div className="tiny muted">דיווח: {u.submitted_by_name}</div></td>
                    <td data-label="שלב">{u.item_title}</td>
                    <td data-label="שבוע" className="tnum small">{fmtWeekRange(u.week_start)}</td>
                    <td data-label="התקדמות" className="tnum">
                      <span className="muted">{u.current_pct}%</span> ← <span className="bold">{u.progress_pct}%</span>
                    </td>
                    <td data-label="הערה" className="small">{u.note ?? '—'}</td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-sm btn-primary" disabled={decide.busy} onClick={() => decide.run(u, 'approve')}>אישור</button>
                        <button type="button" className="btn btn-sm" disabled={decide.busy} onClick={() => decide.run(u, 'reject')}>דחייה</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <StateView
        loading={plans.loading}
        error={plans.error}
        onRetry={plans.reload}
        empty={!plans.loading && people.length === 0}
        emptyProps={{ icon: '🎓', title: 'אין מטמיעים בסינון הזה' }}
      >
        {view === 'table'
          ? <StageTable people={people} canEdit={canEdit} autoApprove={role === 'manager'} onSelect={setSelected} onAdd={setAdding} onChanged={reload} />
          : <Gantt people={people} canEdit={canEdit} onSelect={setSelected} onAdd={setAdding} />}
      </StateView>

      {importing && (
        <ImportDialog people={people} onClose={() => setImporting(false)} onSaved={() => { setImporting(false); reload(); }} />
      )}

      {selected && (
        <StageDialog
          stage={selected.item}
          person={selected.person}
          canEdit={canEdit}
          autoApprove={role === 'manager'}
          onClose={() => setSelected(null)}
          onChanged={() => { setSelected(null); reload(); }}
        />
      )}
      {adding && (
        <AddStagesDialog person={adding} onClose={() => setAdding(null)} onSaved={() => { setAdding(null); reload(); }} />
      )}
    </>
  );
}

function Gantt({ people, canEdit, onSelect, onAdd }) {
  const now = today();
  const { start, end } = useMemo(() => {
    const dates = people.flatMap((p) => p.items.flatMap((i) => [i.start_on, i.due_on])).filter(Boolean);
    const min = dates.length ? dates.reduce((a, b) => (a < b ? a : b)) : now;
    const max = dates.length ? dates.reduce((a, b) => (a > b ? a : b)) : addDays(now, 56);
    return {
      start: weekStartOf(min < now ? min : addDays(now, -7)),
      end: addDays(weekStartOf(max > now ? max : addDays(now, 28)), 6),
    };
  }, [people, now]);

  const weeks = [];
  for (let w = start; w <= end; w = addDays(w, 7)) weeks.push(w);
  const width = (days(start, end) + 1) * DAY_PX;
  const x = (date) => days(start, date) * DAY_PX;

  return (
    <Panel flush>
      <div className="gantt" style={{ padding: 'var(--space-3)' }}>
        <div className="gantt-grid" style={{ gridTemplateColumns: `auto ${width}px` }}>
          <div className="gantt-label gantt-head" style={{ alignItems: 'flex-start' }}>שלב</div>
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${weeks.length}, ${7 * DAY_PX}px)` }}>
            {weeks.map((w) => <div key={w} className="gantt-head tnum">{fmtDate(w)}</div>)}
          </div>

          {people.map((p) => (
            <PersonRows key={p.id} person={p} x={x} now={now} canEdit={canEdit} onSelect={onSelect} onAdd={onAdd} />
          ))}
        </div>
      </div>
      <div className="legend" style={{ padding: '0 var(--space-4) var(--space-3)' }}>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--primary)' }} />התקדמות מאושרת</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--success)' }} />הושלם</span>
        <span className="legend-item"><span className="legend-swatch" style={{ outline: '2px dashed var(--warn)' }} />ממתין לאישור</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--danger)', width: 2 }} />היום</span>
      </div>
    </Panel>
  );
}

function PersonRows({ person, x, now, canEdit, onSelect, onAdd }) {
  return (
    <>
      <div className="gantt-label gantt-person">
        <span>{person.full_name}</span>
        <span className="tiny muted" style={{ fontWeight: 400 }}>
          {[person.domains, person.mentor_name && `מדריך: ${person.mentor_name}`].filter(Boolean).join(' · ')}
        </span>
        <span className="row" style={{ gap: 6 }}>
          {person.overall_pct != null && (
            <span className="small"><span className="progress" style={{ width: 70 }}><span className="progress-fill" style={{ width: `${person.overall_pct}%`, display: 'block' }} /></span>{person.overall_pct}%</span>
          )}
          {canEdit && <button type="button" className="btn btn-sm" onClick={() => onAdd(person)}>+ שלבים</button>}
        </span>
      </div>
      <div className="gantt-track gantt-person">
        <div className="gantt-today" style={{ insetInlineStart: x(now) }} />
      </div>

      {person.items.length === 0 && (
        <>
          <div className="gantt-label small muted">אין שלבים</div>
          <div className="gantt-track" />
        </>
      )}

      {person.items.map((item) => {
        const startOn = item.start_on ?? item.due_on ?? now;
        const dueOn = item.due_on ?? item.start_on ?? now;
        const total = days(startOn, dueOn) + 1;
        const expected = Math.max(0, Math.min(100, Math.round(((days(startOn, now) + 1) / total) * 100)));
        const behind = item.progress_pct < 100 && expected - item.progress_pct >= 20;
        return (
          <Fragment key={item.id}>
            <div className="gantt-label">
              <span className="small bold">{item.title}</span>
              <span className="tiny muted tnum">
                {item.progress_pct}%{item.pending_pct != null ? ` · ממתין ${item.pending_pct}%` : ''}
                {item.due_on ? ` · יעד ${fmtDate(item.due_on)}` : ''}
              </span>
            </div>
            <div className="gantt-track">
              <div className="gantt-today" style={{ insetInlineStart: x(now) }} />
              <button
                type="button"
                className={`gantt-bar ${item.completed_on ? 'is-done' : ''} ${behind ? 'is-behind' : ''} ${item.pending_id ? 'has-pending' : ''}`}
                style={{ insetInlineStart: x(startOn), width: Math.max(total * DAY_PX - 2, 18) }}
                onClick={() => onSelect({ item, person })}
                title={`${item.title} · ${item.progress_pct}% · ${fmtDate(startOn)}–${fmtDate(dueOn)}${behind ? ' · בפיגור' : ''}`}
              >
                <span className="gantt-bar-fill" style={{ width: `${item.progress_pct}%` }} />
                <span className="gantt-bar-text">{item.progress_pct}%</span>
              </button>
            </div>
          </Fragment>
        );
      })}
    </>
  );
}

/** שלב: עריכה, דיווח התקדמות שבועי, והיסטוריית הדיווחים */
function StageDialog({ stage, person, canEdit, autoApprove, onClose, onChanged }) {
  const toast = useToast();
  const history = useApi(`/api/training/items/${stage.id}/history`);
  const [pct, setPct] = useState(stage.pending_pct ?? stage.progress_pct);
  const [note, setNote] = useState('');
  const [form, setForm] = useState({ title: stage.title, startOn: stage.start_on ?? today(), dueOn: stage.due_on ?? today() });

  const report = useAction(
    async () => {
      await post(`/api/training/items/${stage.id}/progress`, { progressPct: Number(pct), note: note || null });
      toast.success(autoApprove ? 'ההתקדמות עודכנה' : 'הדיווח נשלח לאישור מנהל ההטמעה');
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );
  const save = useAction(
    async () => {
      await patch(`/api/training/items/${stage.id}`, form);
      toast.success('השלב עודכן');
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );
  const remove = useAction(
    async () => {
      await del(`/api/training/items/${stage.id}`);
      toast.success('השלב הוסר');
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal title={`${person.full_name} · ${stage.title}`} onClose={onClose} width={620}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>סגירה</button>}>
      {stage.pending_id && (
        <Notice tone="warn" icon="⏳" title={`ממתין לאישור: ${stage.pending_pct}%`}>
          <span className="small">דווח ע״י {stage.pending_by ?? '—'}. דיווח חדש יחליף אותו.</span>
        </Notice>
      )}

      <div className="bold small" style={{ marginBlockEnd: 6 }}>דיווח התקדמות לשבוע {fmtWeekRange(weekStartOf(today()))}</div>
      <div className="row" style={{ gap: 'var(--space-3)', alignItems: 'center' }}>
        <input type="range" min={0} max={100} step={5} value={pct} onChange={(e) => setPct(e.target.value)} aria-label="אחוז התקדמות" style={{ flex: 1 }} />
        <span className="kpi-value" style={{ fontSize: 24, minWidth: 64 }}>{pct}%</span>
      </div>
      <Field label="הערה" hint="מה הושג השבוע, מה נשאר">
        {(props) => <textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} />}
      </Field>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => report.run()} disabled={report.busy}>
        {report.busy ? 'שולח…' : autoApprove ? 'עדכון התקדמות' : 'שליחה לאישור'}
      </button>

      {canEdit && (
        <>
          <div className="divider" />
          <div className="bold small" style={{ marginBlockEnd: 6 }}>פרטי השלב</div>
          <Field label="שם">
            {(props) => <input {...props} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />}
          </Field>
          <div className="grid grid-2">
            <Field label="התחלה">
              {(props) => <input {...props} type="date" value={form.startOn} onChange={(e) => setForm({ ...form, startOn: e.target.value })} />}
            </Field>
            <Field label="יעד">
              {(props) => <input {...props} type="date" value={form.dueOn} min={form.startOn} onChange={(e) => setForm({ ...form, dueOn: e.target.value })} />}
            </Field>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button type="button" className="btn btn-sm" onClick={() => save.run()} disabled={save.busy}>שמירת השלב</button>
            <button type="button" className="btn btn-sm btn-danger" onClick={() => remove.run()} disabled={remove.busy}>הסרת השלב</button>
          </div>
        </>
      )}

      <div className="divider" />
      <div className="bold small" style={{ marginBlockEnd: 6 }}>היסטוריית דיווחים</div>
      <StateView loading={history.loading} error={history.error} onRetry={history.reload}
        empty={!history.loading && (history.data?.history ?? []).length === 0}
        emptyProps={{ icon: '📈', title: 'עדיין אין דיווחים' }}>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>שבוע</th><th>%</th><th>סטטוס</th><th>מי</th></tr></thead>
            <tbody>
              {(history.data?.history ?? []).map((h) => (
                <tr key={h.id}>
                  <td className="tnum small">{fmtWeekRange(h.week_start)}</td>
                  <td className="tnum bold">{h.progress_pct}%</td>
                  <td><Tag tone={statusTone(h.status)}>{STATUS_NAMES[h.status] ?? h.status}</Tag></td>
                  <td className="small">
                    {h.submitted_by_name}{h.decided_by_name && h.decided_by_name !== h.submitted_by_name ? ` ← ${h.decided_by_name}` : ''}
                    <div className="tiny muted">{fmtDateTime(h.created_at)}{h.note ? ` · ${h.note}` : ''}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Modal>
  );
}

/** הוספת שלבים: מתבנית (שלב אחרי שלב מתאריך התחלה), או שלב בודד */
function AddStagesDialog({ person, onClose, onSaved }) {
  const toast = useToast();
  const tracks = useApi('/api/training/tracks');
  const [mode, setMode] = useState('track');
  const [trackId, setTrackId] = useState('');
  const [startOn, setStartOn] = useState(today());
  const [single, setSingle] = useState({ title: '', startOn: today(), dueOn: addDays(today(), 6) });
  const list = (tracks.data?.tracks ?? []).filter((t) => t.is_active && t.items.length);

  const save = useAction(
    async () => {
      if (mode === 'track') {
        const { created } = await post(`/api/training/plans/${person.id}/apply-track`, { trackId: trackId || list[0]?.id, startOn });
        toast.success(`נוספו ${created} שלבים`);
      } else {
        await post(`/api/training/plans/${person.id}/items`, single);
        toast.success('השלב נוסף');
      }
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal title={`שלבי הכשרה — ${person.full_name}`} onClose={onClose}
      footer={<>
        <button type="button" className="btn btn-primary" onClick={() => save.run()}
          disabled={save.busy || (mode === 'track' ? list.length === 0 : !single.title.trim())}>
          {save.busy ? 'שומר…' : 'הוספה'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
      </>}>
      <div className="seg" role="tablist" style={{ marginBlockEnd: 'var(--space-3)' }}>
        <button type="button" className="seg-btn" aria-pressed={mode === 'track'} onClick={() => setMode('track')}>מתבנית</button>
        <button type="button" className="seg-btn" aria-pressed={mode === 'single'} onClick={() => setMode('single')}>שלב בודד</button>
      </div>
      {mode === 'track' ? (
        <StateView loading={tracks.loading} error={tracks.error} onRetry={tracks.reload}>
          {list.length === 0 ? (
            <Empty icon="🎓" title="אין תבניות הכשרה" text="מגדירים תבניות בהגדרות ← תבניות הכשרה." />
          ) : (
            <>
              <Field label="תבנית">
                {(props) => (
                  <select {...props} value={trackId || list[0].id} onChange={(e) => {
                    setTrackId(e.target.value);
                    const t = list.find((x) => x.id === e.target.value);
                    if (t?.start_on) setStartOn(t.start_on);
                  }}>
                    {list.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.items.length} שלבים)</option>)}
                  </select>
                )}
              </Field>
              <Field label="תאריך התחלה" hint="גאנט מקובץ שומר על הפערים בין השלבים; בתבנית רגילה כל שלב מתחיל כשהקודם מסתיים">
                {(props) => <input {...props} type="date" value={startOn} onChange={(e) => setStartOn(e.target.value)} />}
              </Field>
            </>
          )}
        </StateView>
      ) : (
        <>
          <Field label="שם השלב" required>
            {(props) => <input {...props} value={single.title} onChange={(e) => setSingle({ ...single, title: e.target.value })} />}
          </Field>
          <div className="grid grid-2">
            <Field label="התחלה">
              {(props) => <input {...props} type="date" value={single.startOn} onChange={(e) => setSingle({ ...single, startOn: e.target.value })} />}
            </Field>
            <Field label="יעד">
              {(props) => <input {...props} type="date" value={single.dueOn} min={single.startOn} onChange={(e) => setSingle({ ...single, dueOn: e.target.value })} />}
            </Field>
          </div>
        </>
      )}
    </Modal>
  );
}

/**
 * טבלת הכשרה: שורה לכל עובד, עמודה לכל שלב (לפי שם השלב), והסטטוסים באותה
 * שורה. לחיצה על תא בוחרת אותו; אפשר לבחור שורה או עמודה שלמה, ולסמן סטטוס
 * לכל הנבחרים בבת אחת.
 */
function StageTable({ people, canEdit, autoApprove, onSelect, onAdd, onChanged }) {
  const toast = useToast();
  const [picked, setPicked] = useState(() => new Set());
  const [note, setNote] = useState('');

  const columns = useMemo(() => {
    const order = new Map();
    for (const p of people) {
      for (const i of p.items) {
        const key = i.start_on ?? '9999';
        if (!order.has(i.title) || key < order.get(i.title)) order.set(i.title, key);
      }
    }
    return [...order.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([title]) => title);
  }, [people]);

  const cellOf = (person, title) => person.items.find((i) => i.title === title);
  const toggle = (ids) => setPicked((prev) => {
    const next = new Set(prev);
    const all = ids.every((id) => next.has(id));
    for (const id of ids) (all ? next.delete(id) : next.add(id));
    return next;
  });

  const apply = useAction(
    async (pct) => {
      const out = await post('/api/training/progress/bulk', { itemIds: [...picked], progressPct: pct, note: note || null });
      toast.success(out.status === 'pending'
        ? `${out.updated} שלבים נשלחו לאישור מנהל ההטמעה`
        : `${out.updated} שלבים עודכנו`);
      setPicked(new Set());
      setNote('');
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  if (columns.length === 0) {
    return (
      <Panel>
        <Empty icon="🎓" title="עדיין אין שלבי הכשרה" text="טענו גאנט כללי מקובץ ושייכו אליו עובדים, או הוסיפו שלבים לעובד מתבנית." />
      </Panel>
    );
  }

  return (
    <Panel flush>
      {picked.size > 0 && (
        <div className="bulk-bar">
          <span className="bold small">נבחרו {picked.size} שלבים · סימון:</span>
          {STAGE_STATUSES.map((st) => (
            <button key={st.pct} type="button" className={`btn btn-sm ${st.pct === 100 ? 'btn-primary' : ''}`}
              disabled={apply.busy} onClick={() => apply.run(st.pct)}>
              {st.label}
            </button>
          ))}
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="הערה (לא חובה)" aria-label="הערה" style={{ width: 180 }} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setPicked(new Set())}>ניקוי בחירה</button>
          {!autoApprove && <span className="tiny muted">הסימון יישלח לאישור מנהל ההטמעה</span>}
        </div>
      )}
      <div className="table-wrap stage-table-wrap">
        <table className="table stage-table">
          <thead>
            <tr>
              <th className="stage-sticky">עובד</th>
              <th className="tnum">סה״כ</th>
              {columns.map((title) => {
                const ids = people.map((p) => cellOf(p, title)?.id).filter(Boolean);
                return (
                  <th key={title}>
                    <label className="row" style={{ gap: 4, alignItems: 'center', fontWeight: 600 }}>
                      <input type="checkbox" checked={ids.length > 0 && ids.every((id) => picked.has(id))}
                        onChange={() => toggle(ids)} aria-label={`בחירת כל העמודה ${title}`} />
                      <span>{title}</span>
                    </label>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {people.map((p) => {
              const ids = p.items.map((i) => i.id);
              return (
                <tr key={p.id}>
                  <td className="stage-sticky">
                    <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                      <input type="checkbox" checked={ids.length > 0 && ids.every((id) => picked.has(id))}
                        disabled={!ids.length} onChange={() => toggle(ids)} aria-label={`בחירת כל השלבים של ${p.full_name}`} />
                      <span>
                        <span className="bold">{p.full_name}</span>
                        <span className="tiny muted" style={{ display: 'block' }}>
                          {[p.domains, p.mentor_name && `מדריך: ${p.mentor_name}`].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                    </label>
                    {canEdit && <button type="button" className="btn btn-sm btn-ghost tiny" onClick={() => onAdd(p)}>+ שלבים</button>}
                  </td>
                  <td className="tnum bold">{p.overall_pct != null ? `${p.overall_pct}%` : '—'}</td>
                  {columns.map((title) => {
                    const item = cellOf(p, title);
                    if (!item) return <td key={title} className="muted tiny">—</td>;
                    const st = statusOf(item.progress_pct);
                    const on = picked.has(item.id);
                    return (
                      <td key={title} className={`stage-cell${on ? ' is-picked' : ''}`}>
                        <button type="button" className="stage-pick" onClick={() => toggle([item.id])} aria-pressed={on}
                          title={`${item.title} · ${fmtDate(item.start_on)}–${fmtDate(item.due_on)}`}>
                          <Tag tone={st.tone}>{st.label}</Tag>
                          {item.pending_pct != null && <span className="tiny" style={{ color: 'var(--warn)' }}>⏳ {item.pending_pct}%</span>}
                        </button>
                        <button type="button" className="stage-more" onClick={() => onSelect({ item, person: p })} aria-label="פרטי השלב">⋯</button>
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/** קריאת קובץ ל-base64, בלי הקידומת data: */
const readBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(file);
});

/**
 * טעינת גאנט הכשרה כללי מקובץ (אקסל או CSV): תצוגה מקדימה שאפשר לתקן, שם
 * לגאנט, ובחירת העובדים שישויכו אליו. הגאנט נשמר כתבנית עם תאריכים, כך
 * שאפשר לשייך אליו עובדים נוספים גם אחר כך ("+ שלבים" ← מתבנית).
 */
function ImportDialog({ people, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [rows, setRows] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [userIds, setUserIds] = useState(() => new Set());

  const parse = useAction(
    async (file) => {
      if (file.size > 5 * 1024 * 1024) throw new Error('הקובץ גדול מ-5MB');
      const out = await post('/api/training/import/parse', { fileName: file.name, data: await readBase64(file) });
      setRows(out.rows);
      setWarnings(out.warnings ?? []);
      if (!name) setName(file.name.replace(/\.[^.]+$/, ''));
    },
    { onError: (err) => toast.error(err) },
  );
  const save = useAction(
    async () => {
      const out = await post('/api/training/import/apply', { name: name.trim(), rows, userIds: [...userIds] });
      toast.success(`הגאנט נשמר${out.people ? ` ושויך ל-${out.people} עובדים (${out.created} שלבים)` : ''}`);
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const setRow = (i, patchRow) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patchRow } : r)));
  const toggleUser = (id) => setUserIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <Modal title="טעינת גאנט הכשרה כללי" onClose={onClose} width={760}
      footer={<>
        <button type="button" className="btn btn-primary" onClick={() => save.run()}
          disabled={save.busy || !rows?.length || !name.trim()}>
          {save.busy ? 'שומר…' : userIds.size ? `שמירה ושיוך ${userIds.size} עובדים` : 'שמירת הגאנט'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
      </>}>
      <Field label="קובץ (xlsx או csv)" hint="עמודות: שם השלב, תאריך התחלה, תאריך סיום (או משך בימים). שורת כותרות מזוהה לבד.">
        {(props) => (
          <input {...props} type="file" accept=".xlsx,.csv"
            onChange={(e) => e.target.files?.[0] && parse.run(e.target.files[0])} disabled={parse.busy} />
        )}
      </Field>
      {parse.busy && <div className="small muted">קורא את הקובץ…</div>}
      {warnings.length > 0 && (
        <Notice tone="warn" icon="⚠️" title="שורות שדולגו">
          <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>{warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </Notice>
      )}

      {rows && (
        <>
          <Field label="שם הגאנט" required>
            {(props) => <input {...props} value={name} onChange={(e) => setName(e.target.value)} />}
          </Field>
          <div className="bold small" style={{ marginBlockEnd: 6 }}>{rows.length} שלבים</div>
          <div className="table-wrap" style={{ maxHeight: 260, overflow: 'auto' }}>
            <table className="table">
              <thead><tr><th>שלב</th><th>התחלה</th><th>סיום</th><th /></tr></thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i}>
                    <td><input value={r.title} onChange={(e) => setRow(i, { title: e.target.value })} aria-label="שם השלב" /></td>
                    <td><input type="date" value={r.startOn} onChange={(e) => setRow(i, { startOn: e.target.value })} aria-label="התחלה" /></td>
                    <td><input type="date" value={r.dueOn} min={r.startOn} onChange={(e) => setRow(i, { dueOn: e.target.value })} aria-label="סיום" /></td>
                    <td><button type="button" className="btn btn-sm btn-ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))} aria-label="הסרת השורה">✕</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="divider" />
          <div className="row" style={{ justifyContent: 'space-between', marginBlockEnd: 6 }}>
            <span className="bold small">שיוך עובדים ({userIds.size})</span>
            <button type="button" className="btn btn-sm btn-ghost"
              onClick={() => setUserIds(userIds.size === people.length ? new Set() : new Set(people.map((p) => p.id)))}>
              {userIds.size === people.length ? 'ניקוי' : 'בחירת כולם'}
            </button>
          </div>
          <div className="chip-grid">
            {people.map((p) => (
              <label key={p.id} className="row small" style={{ gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={userIds.has(p.id)} onChange={() => toggleUser(p.id)} />
                {p.full_name}
              </label>
            ))}
          </div>
        </>
      )}
    </Modal>
  );
}
