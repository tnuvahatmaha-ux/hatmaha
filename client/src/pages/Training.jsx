import { Fragment, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { post, patch, del } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Field, Modal, Notice, Empty } from '../components/ui/index.jsx';
import { fmtDate, fmtDateTime, fmtWeekRange, today, addDays, weekStartOf, STATUS_NAMES, statusTone } from '../lib/format.js';

const DAY_PX = 14;
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/**
 * הכשרה — גאנט לכל מטמיע.
 *
 * כל שורה היא שלב עם תאריך התחלה ויעד; המילוי בפס הוא האחוז המאושר.
 * מדריך (או המטמיע) מדווח התקדמות שבועית, ומנהל ההטמעה מאשר בתור שבראש המסך.
 */
export default function Training() {
  const { can, role } = usePermissions();
  const toast = useToast();
  const [siteId, setSiteId] = useState('');
  const [domainId, setDomainId] = useState('');
  const [selected, setSelected] = useState(null);
  const [adding, setAdding] = useState(null);

  const self = role === 'implementer' || role === 'lead';
  const canEdit = can('implementers', 'edit');
  const canApprove = can('implementers', 'approve');

  const sites = useApi(self ? null : '/api/sites');
  const domains = useApi(self ? null : '/api/settings/domains');
  const plans = useApi('/api/training/plans', { siteId: siteId || undefined, domainId: domainId || undefined });
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

  return (
    <>
      <ViewHead
        title={self ? 'ההכשרה שלי' : 'הכשרה'}
        subtitle="שלבי ההכשרה על ציר הזמן, והתקדמות שבועית מאושרת באחוזים"
        actions={!self && (
          <>
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
        emptyProps={{ icon: '🎓', title: self ? 'עדיין לא הוגדרה לך תוכנית הכשרה' : 'אין מטמיעים בסינון הזה' }}
      >
        <Gantt people={people} canEdit={canEdit} onSelect={setSelected} onAdd={setAdding} />
      </StateView>

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
                  <select {...props} value={trackId || list[0].id} onChange={(e) => setTrackId(e.target.value)}>
                    {list.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.items.length} שלבים)</option>)}
                  </select>
                )}
              </Field>
              <Field label="תאריך התחלה" hint="כל שלב מתחיל כשהקודם מסתיים">
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
