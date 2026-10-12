import { useEffect, useMemo, useState } from 'react';
import { Copy, Download, MessageSquareText, Pencil, Plus, Trash2 } from 'lucide-react';
import { useApi, useAction } from '../lib/useApi.js';
import { post, put, del, download } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Notice, Field, Modal, Segmented, Empty, ConfirmDialog } from '../components/ui/index.jsx';
import { fmtDateFull } from '../lib/format.js';

/**
 * סקילומטר.
 *
 * אחרי העלייה לאוויר, המטמיעים מדרגים את משתמשי הקצה של האתר — 1 (נמוך) עד 4 —
 * בכל נושא ידע של התחום, ומוסיפים הערה לכל משתמש. מנהל ההטמעה בונה את
 * הנושאים, את רשימת משתמשי הקצה ואת הסבבים, ומייצא את התוצאות לאקסל.
 */
const ROUND_STATUS = { draft: ['טיוטה', ''], open: ['פתוח למילוי', 'ok'], closed: ['סגור', 'warn'] };
const SCORE_LABELS = { 1: 'לא מכיר', 2: 'מכיר חלקית', 3: 'מכיר', 4: 'שולט' };

export default function Skills() {
  const { can } = usePermissions();
  const isManager = can('skills', 'manage');
  const [tab, setTab] = useState('fill');
  const sites = useApi('/api/sites');
  const [siteId, setSiteId] = useState('');
  const siteList = sites.data?.sites ?? [];

  useEffect(() => {
    if (!siteId && siteList.length) setSiteId(siteList[0].id);
  }, [siteList, siteId]);

  return (
    <>
      <ViewHead
        title="סקילומטר"
        subtitle="דירוג הידע של משתמשי הקצה באתר — לפי תחומים ונושאים, בכמה סבבים"
        actions={
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="בחירת אתר"
            style={{ width: 'auto', minWidth: 180 }}>
            {siteList.length === 0 && <option value="">אין אתרים</option>}
            {siteList.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        }
      />

      <div className="row" style={{ marginBlockEnd: 'var(--space-4)' }}>
        <Segmented
          label="מסכי הסקילומטר"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'fill', label: 'מילוי ותוצאות' },
            { value: 'progress', label: 'התקדמות' },
            ...(isManager
              ? [
                  { value: 'rounds', label: 'סבבים' },
                  { value: 'topics', label: 'נושאים' },
                  { value: 'users', label: 'משתמשי קצה' },
                ]
              : []),
          ]}
        />
      </div>

      <StateView loading={sites.loading} error={sites.error} onRetry={sites.reload}
        empty={!sites.loading && !siteId} emptyProps={{ icon: '🏥', title: 'אין אתר זמין' }}>
        {siteId && tab === 'fill' && <FillTab siteId={siteId} />}
        {siteId && tab === 'progress' && <ProgressTab siteId={siteId} />}
        {siteId && tab === 'rounds' && <RoundsTab siteId={siteId} />}
        {tab === 'topics' && <TopicsTab />}
        {siteId && tab === 'users' && <EndUsersTab siteId={siteId} />}
      </StateView>
    </>
  );
}

/* ==========================================================================
   מילוי — טבלה של משתמשים × נושאים
   ========================================================================== */

function FillTab({ siteId }) {
  const toast = useToast();
  const { can } = usePermissions();
  const rounds = useApi('/api/skills/rounds', { siteId });
  const list = rounds.data?.rounds ?? [];
  const [roundId, setRoundId] = useState('');
  const [domainId, setDomainId] = useState('');
  const [noteFor, setNoteFor] = useState(null);

  useEffect(() => {
    if (!list.length) return;
    if (!list.some((r) => r.id === roundId)) setRoundId((list.find((r) => r.status === 'open') ?? list[0]).id);
  }, [list, roundId]);

  const sheet = useApi(roundId ? `/api/skills/rounds/${roundId}/sheet` : null, domainId ? { domainId } : undefined);
  const data = sheet.data;

  const scores = useMemo(
    () => new Map((data?.scores ?? []).map((s) => [`${s.end_user_id}|${s.topic_id}`, s.score])),
    [data],
  );
  const notes = useMemo(() => new Map((data?.notes ?? []).map((n) => [n.end_user_id, n.note])), [data]);

  const setScore = useAction(
    async (endUserId, topicId, score) => {
      const key = `${endUserId}|${topicId}`;
      const next = scores.get(key) === score ? null : score; // לחיצה נוספת מוחקת
      // עדכון מיידי במסך; השרת מאשר ברקע
      sheet.setData({
        ...data,
        scores: [
          ...data.scores.filter((s) => `${s.end_user_id}|${s.topic_id}` !== key),
          ...(next ? [{ end_user_id: endUserId, topic_id: topicId, score: next }] : []),
        ],
        progress: {
          ...data.progress,
          filled: data.progress.filled + (next && !scores.has(key) ? 1 : !next && scores.has(key) ? -1 : 0),
        },
      });
      await put(`/api/skills/rounds/${roundId}/scores`, { scores: [{ endUserId, topicId, score: next }] });
    },
    { onError: (err) => { toast.error(err); sheet.reload(); } },
  );

  const exportFile = useAction(
    async (scope) => {
      const round = list.find((r) => r.id === roundId);
      const domain = data?.domains.find((d) => d.id === domainId);
      await download(
        `/api/skills/rounds/${roundId}/export.xlsx`,
        scope === 'domain' && domainId ? { domainId } : undefined,
        `סקילומטר - ${round?.name ?? ''}${scope === 'domain' && domain ? ` - ${domain.name}` : ''}.xlsx`,
      );
    },
    { onError: (err) => toast.error(err) },
  );

  if (!rounds.loading && list.length === 0) {
    return (
      <Panel>
        <Empty icon="📝" title="עדיין לא נפתח סבב סקילומטר באתר"
          text={can('skills', 'manage') ? 'פתחו סבב בלשונית "סבבים" ובחרו את הנושאים שלו.' : 'כשמנהל ההטמעה יפתח סבב, הוא יופיע כאן.'} />
      </Panel>
    );
  }

  const relevant = (u, t) => t.domain_id === u.domain_id && (!t.sub_category_id || t.sub_category_id === u.sub_category_id);
  const pct = data?.progress.total ? Math.round((data.progress.filled / data.progress.total) * 100) : 0;

  return (
    <>
      <div className="row" style={{ marginBlockEnd: 'var(--space-4)', gap: 'var(--space-3)' }}>
        <select value={roundId} onChange={(e) => setRoundId(e.target.value)} aria-label="בחירת סבב" style={{ width: 'auto' }}>
          {list.map((r) => <option key={r.id} value={r.id}>{r.name} · {ROUND_STATUS[r.status][0]}</option>)}
        </select>
        {data?.domains.length > 1 && (
          <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="בחירת תחום" style={{ width: 'auto' }}>
            <option value="">כל התחומים</option>
            {data.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        )}
        {can('skills', 'export') && roundId && (
          <div className="row row-end">
            {domainId && (
              <button type="button" className="btn btn-sm" onClick={() => exportFile.run('domain')} disabled={exportFile.busy}>
                <Download size={15} /> אקסל לתחום
              </button>
            )}
            <button type="button" className="btn btn-sm" onClick={() => exportFile.run('all')} disabled={exportFile.busy}>
              <Download size={15} /> אקסל מלא
            </button>
          </div>
        )}
      </div>

      <StateView loading={sheet.loading && !data} error={sheet.error} onRetry={sheet.reload}>
        {data && (
          <Panel
            title={data.round.name}
            subtitle={[
              data.round.opens_on && `מ־${fmtDateFull(data.round.opens_on)}`,
              data.round.closes_on && `עד ${fmtDateFull(data.round.closes_on)}`,
              `${data.progress.filled} מתוך ${data.progress.total} תאים מולאו`,
            ].filter(Boolean).join(' · ')}
            actions={<Tag tone={ROUND_STATUS[data.round.status][1]}>{ROUND_STATUS[data.round.status][0]}</Tag>}
            flush
          >
            <div style={{ padding: '0 20px 12px' }}>
              <div className="progress"><span style={{ width: `${pct}%` }} /></div>
            </div>

            {!data.canEdit && (
              <div style={{ padding: '0 20px' }}>
                <Notice icon="🔒">{data.round.status === 'closed' ? 'הסבב נסגר — הציונים לקריאה בלבד.' : 'הסבב עוד לא נפתח למילוי.'}</Notice>
              </div>
            )}

            {data.users.length === 0 || data.topics.length === 0 ? (
              <Empty icon="👤"
                title={data.topics.length === 0 ? 'אין נושאים בסבב הזה לתחומים שלך' : 'אין משתמשי קצה בתחומים שלך באתר'}
                text="מנהל ההטמעה מגדיר נושאים ומשתמשי קצה במסך הסקילומטר." />
            ) : (
              <div className="table-wrap" style={{ maxHeight: '70vh' }}>
                <table className="skill-table">
                  <thead>
                    <tr>
                      <th className="sticky-name">משתמש</th>
                      {data.topics.map((t) => <th key={t.id} title={t.description ?? undefined}>{t.name}</th>)}
                      <th>ממוצע</th>
                      <th>הערה</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.users.map((u) => {
                      const mine = data.topics.filter((t) => relevant(u, t));
                      const vals = mine.map((t) => scores.get(`${u.id}|${t.id}`)).filter(Boolean);
                      const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
                      return (
                        <tr key={u.id}>
                          <td className="sticky-name">
                            <div className="bold">{u.full_name}</div>
                            <div className="tiny muted">
                              {[u.domain_name, u.sub_category_name, u.department].filter(Boolean).join(' · ')}
                            </div>
                          </td>
                          {data.topics.map((t) => (
                            <td key={t.id} style={{ textAlign: 'center' }}>
                              {relevant(u, t) ? (
                                <ScorePicker
                                  value={scores.get(`${u.id}|${t.id}`)}
                                  disabled={!data.canEdit}
                                  label={`${u.full_name} — ${t.name}`}
                                  onPick={(score) => setScore.run(u.id, t.id, score)}
                                />
                              ) : <span className="skill-na" aria-label="לא רלוונטי">—</span>}
                            </td>
                          ))}
                          <td style={{ textAlign: 'center' }}><ScorePill value={avg} /></td>
                          <td>
                            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNoteFor(u)}
                              aria-label={`הערה על ${u.full_name}`} title={notes.get(u.id) ?? 'הוספת הערה'}>
                              <MessageSquareText size={15} />
                              {notes.get(u.id) ? 'יש הערה' : 'הערה'}
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}

            <div className="legend" style={{ padding: '12px 20px 16px' }}>
              {Object.entries(SCORE_LABELS).map(([k, label]) => (
                <span key={k} className="legend-item"><span className="skill-picker"><button type="button" className={`s${k}`} aria-pressed="true" tabIndex={-1}>{k}</button></span>{label}</span>
              ))}
            </div>
          </Panel>
        )}
      </StateView>

      {noteFor && (
        <NoteDialog
          roundId={roundId}
          user={noteFor}
          initial={notes.get(noteFor.id) ?? ''}
          readOnly={!data?.canEdit}
          onClose={() => setNoteFor(null)}
          onSaved={() => { setNoteFor(null); sheet.reload(); }}
        />
      )}
    </>
  );
}

function ScorePicker({ value, disabled, label, onPick }) {
  return (
    <div className="skill-picker" role="group" aria-label={label}>
      {[1, 2, 3, 4].map((n) => (
        <button key={n} type="button" className={`s${n}`} aria-pressed={value === n} disabled={disabled}
          onClick={() => onPick(n)} title={SCORE_LABELS[n]}>
          {n}
        </button>
      ))}
    </div>
  );
}

export function ScorePill({ value }) {
  if (value == null) return <span className="muted">—</span>;
  const n = Number(value);
  return <span className={`score-pill ${n <= 2 ? 'low' : n < 3 ? 'mid' : 'high'}`}>{n.toFixed(1)}</span>;
}

function NoteDialog({ roundId, user, initial, readOnly, onClose, onSaved }) {
  const toast = useToast();
  const [note, setNote] = useState(initial);
  const save = useAction(
    async () => {
      await put(`/api/skills/rounds/${roundId}/notes/${user.id}`, { note });
      toast.success('ההערה נשמרה');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );
  return (
    <Modal
      title={`הערה — ${user.full_name}`}
      onClose={onClose}
      width={520}
      footer={!readOnly && (
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      )}
    >
      <Field label="סיבת הציונים" hint="מה המשתמש יודע, מה חסר לו, ומה הומלץ">
        {(props) => (
          <textarea {...props} rows={6} value={note} maxLength={2000} disabled={readOnly}
            onChange={(e) => setNote(e.target.value)} />
        )}
      </Field>
    </Modal>
  );
}

/* ==========================================================================
   סבבים
   ========================================================================== */

function RoundsTab({ siteId }) {
  const toast = useToast();
  const rounds = useApi('/api/skills/rounds', { siteId });
  const [editing, setEditing] = useState(null);

  const duplicate = useAction(
    async (round) => {
      const { round: copy } = await post(`/api/skills/rounds/${round.id}/duplicate`, {});
      toast.success(`נוצר "${copy.name}" — בטיוטה, עם אותם נושאים ובלי ציונים`);
      rounds.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      title="סבבים"
      subtitle="כל סבב נבנה עם הנושאים שלו. בזמן שסבב פתוח, המטמיעים יכולים למלא"
      actions={<button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({})}><Plus size={15} /> סבב חדש</button>}
      flush
    >
      <StateView loading={rounds.loading} error={rounds.error} onRetry={rounds.reload}
        empty={!rounds.loading && (rounds.data?.rounds ?? []).length === 0}
        emptyProps={{ icon: '📝', title: 'עדיין אין סבבים', text: 'סבב ראשון נפתח בדרך כלל בשבוע הראשון אחרי העלייה לאוויר.' }}>
        <div className="table-wrap">
          <table className="table table-cards">
            <thead><tr><th>סבב</th><th>תאריכים</th><th>נושאים</th><th>ציונים</th><th>סטטוס</th><th /></tr></thead>
            <tbody>
              {(rounds.data?.rounds ?? []).map((r) => (
                <tr key={r.id}>
                  <td data-label="סבב" className="bold">{r.name}</td>
                  <td data-label="תאריכים" className="tnum small">
                    {r.opens_on ? fmtDateFull(r.opens_on) : '—'}{r.closes_on && ` – ${fmtDateFull(r.closes_on)}`}
                  </td>
                  <td data-label="נושאים">{r.topic_ids.length}</td>
                  <td data-label="ציונים">{r.score_count}</td>
                  <td data-label="סטטוס"><Tag tone={ROUND_STATUS[r.status][1]}>{ROUND_STATUS[r.status][0]}</Tag></td>
                  <td>
                    <div className="row row-end" style={{ gap: 6 }}>
                      <button type="button" className="btn btn-sm" onClick={() => setEditing(r)}>עריכה</button>
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => duplicate.run(r)}
                        disabled={duplicate.busy} title="סבב חדש עם אותם נושאים, בלי ציונים">
                        <Copy size={15} /> שכפול
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
      {editing && (
        <RoundForm siteId={siteId} round={editing.id ? editing : null}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); rounds.reload(); }} />
      )}
    </Panel>
  );
}

function RoundForm({ siteId, round, onClose, onSaved }) {
  const toast = useToast();
  const topics = useApi('/api/skills/topics');
  const [form, setForm] = useState({
    name: round?.name ?? '',
    opensOn: round?.opens_on ?? '',
    closesOn: round?.closes_on ?? '',
    status: round?.status ?? 'draft',
    topicIds: round?.topic_ids ?? null,
  });

  const all = (topics.data?.topics ?? []).filter((t) => t.is_active);
  const selected = form.topicIds ?? all.map((t) => t.id); // סבב חדש — כל הנושאים מסומנים
  const byDomain = all.reduce((m, t) => ((m[t.domain_name] ??= []).push(t), m), {});

  const save = useAction(
    async () => {
      await post('/api/skills/rounds', {
        id: round?.id, siteId, name: form.name, status: form.status,
        opensOn: form.opensOn || null, closesOn: form.closesOn || null, topicIds: selected,
      });
      toast.success(form.status === 'open' && round?.status !== 'open' ? 'הסבב נפתח — המטמיעים קיבלו התראה' : 'הסבב נשמר');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const toggle = (ids, on) =>
    setForm({ ...form, topicIds: on ? selected.filter((x) => !ids.includes(x)) : [...new Set([...selected, ...ids])] });

  return (
    <Modal
      title={round ? `עריכת ${round.name}` : 'סבב חדש'}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || !form.name.trim()}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="שם הסבב" required>
        {(props) => <input {...props} type="text" value={form.name} placeholder="למשל: סבב 1 — שבוע ראשון אחרי העלייה"
          onChange={(e) => setForm({ ...form, name: e.target.value })} />}
      </Field>
      <div className="grid grid-2">
        <Field label="מתאריך">
          {(props) => <input {...props} type="date" value={form.opensOn} onChange={(e) => setForm({ ...form, opensOn: e.target.value })} />}
        </Field>
        <Field label="עד תאריך">
          {(props) => <input {...props} type="date" value={form.closesOn} onChange={(e) => setForm({ ...form, closesOn: e.target.value })} />}
        </Field>
      </div>
      <Field label="סטטוס">
        {() => (
          <Segmented label="סטטוס הסבב" value={form.status} onChange={(status) => setForm({ ...form, status })}
            options={[{ value: 'draft', label: 'טיוטה' }, { value: 'open', label: 'פתוח למילוי' }, { value: 'closed', label: 'סגור' }]} />
        )}
      </Field>

      <Field label={`נושאים בסבב (${selected.length})`}>
        {() => (
          <StateView loading={topics.loading} error={topics.error}
            empty={!topics.loading && all.length === 0}
            emptyProps={{ icon: '📝', title: 'אין נושאים', text: 'הגדירו נושאים בלשונית "נושאים".' }}>
            <div className="stack" style={{ gap: 12 }}>
              {Object.entries(byDomain).map(([domain, list]) => {
                const ids = list.map((t) => t.id);
                const allOn = ids.every((id) => selected.includes(id));
                return (
                  <div key={domain}>
                    <label className="check bold">
                      <input type="checkbox" checked={allOn} onChange={() => toggle(ids, allOn)} />
                      {domain}
                    </label>
                    <div className="row" style={{ gap: 6, paddingInlineStart: 26 }}>
                      {list.map((t) => {
                        const on = selected.includes(t.id);
                        return (
                          <button key={t.id} type="button" className="chip" aria-pressed={on} onClick={() => toggle([t.id], on)}>
                            {t.name}{t.sub_category_name && ` · ${t.sub_category_name}`}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </StateView>
        )}
      </Field>
    </Modal>
  );
}

/* ==========================================================================
   נושאים
   ========================================================================== */

function TopicsTab() {
  const toast = useToast();
  const domains = useApi('/api/settings/domains');
  const [domainId, setDomainId] = useState('');
  const [subId, setSubId] = useState('');
  const [text, setText] = useState('');
  const domainList = domains.data?.domains ?? [];
  const domain = domainList.find((d) => d.id === domainId);

  useEffect(() => {
    if (!domainId && domainList.length) setDomainId(domainList[0].id);
  }, [domainList, domainId]);

  const topics = useApi(domainId ? '/api/skills/topics' : null, { domainId });

  const add = useAction(
    async () => {
      const names = text.split('\n').map((n) => n.trim()).filter(Boolean);
      const r = await post('/api/skills/topics/import', { domainId, subCategoryId: subId || null, names });
      toast.success(`נוספו ${r.added} נושאים${r.skipped ? ` (${r.skipped} כבר היו קיימים)` : ''}`);
      setText('');
      topics.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const [editing, setEditing] = useState(null);
  const remove = useAction(
    async (id) => { await del(`/api/skills/topics/${id}`); topics.reload(); },
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      <Panel title="הוספת נושאים" subtitle="שורה לכל נושא — אפשר להדביק רשימה מאקסל">
        <div className="grid grid-2">
          <Field label="תחום" required>
            {(props) => (
              <select {...props} value={domainId} onChange={(e) => { setDomainId(e.target.value); setSubId(''); }}>
                {domainList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="תת-תחום" hint="ריק = הנושא לכל התחום">
            {(props) => (
              <select {...props} value={subId} onChange={(e) => setSubId(e.target.value)}>
                <option value="">כל התחום</option>
                {(domain?.subCategories ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </Field>
        </div>
        <Field label="נושאים">
          {(props) => <textarea {...props} rows={5} value={text} onChange={(e) => setText(e.target.value)}
            placeholder={'קבלת מטופל\nרישום תרופות\nהפקת דוח משמרת'} />}
        </Field>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => add.run()} disabled={add.busy || !text.trim() || !domainId}>
          {add.busy ? 'מוסיף…' : 'הוספה'}
        </button>
      </Panel>

      <Panel title={`נושאים — ${domain?.name ?? ''}`} flush>
        <StateView loading={topics.loading} error={topics.error} onRetry={topics.reload}
          empty={!topics.loading && (topics.data?.topics ?? []).length === 0}
          emptyProps={{ icon: '📝', title: 'אין עדיין נושאים לתחום הזה' }}>
          <div className="table-wrap">
            <table className="table table-cards">
              <thead><tr><th>נושא</th><th>תת-תחום</th><th /></tr></thead>
              <tbody>
                {(topics.data?.topics ?? []).map((t) => (
                  <tr key={t.id}>
                    <td data-label="נושא" className="bold">{t.name}</td>
                    <td data-label="תת-תחום">{t.sub_category_name ?? <span className="muted">כל התחום</span>}</td>
                    <td>
                      <div className="row row-end" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(t)}
                          aria-label={`עריכת הנושא ${t.name}`}>
                          <Pencil size={15} />
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => remove.run(t.id)}
                          disabled={remove.busy} aria-label={`מחיקת הנושא ${t.name}`}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {editing && (
        <TopicDialog topic={editing} domains={domainList}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); topics.reload(); }} />
      )}
    </>
  );
}

function TopicDialog({ topic, domains, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: topic.name,
    description: topic.description ?? '',
    domainId: topic.domain_id,
    subCategoryId: topic.sub_category_id ?? '',
  });
  const domain = domains.find((d) => d.id === form.domainId);

  const save = useAction(
    async () => {
      await post('/api/skills/topics', {
        id: topic.id,
        domainId: form.domainId,
        subCategoryId: form.subCategoryId || null,
        name: form.name,
        description: form.description.trim() || null,
      });
      toast.success('הנושא עודכן');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal
      title={`עריכת נושא — ${topic.name}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || !form.name.trim()}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="שם הנושא" required>
        {(props) => <input {...props} type="text" value={form.name} maxLength={200}
          onChange={(e) => setForm({ ...form, name: e.target.value })} />}
      </Field>
      <div className="grid grid-2">
        <Field label="תחום" required>
          {(props) => (
            <select {...props} value={form.domainId}
              onChange={(e) => setForm({ ...form, domainId: e.target.value, subCategoryId: '' })}>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="תת-תחום" hint="ריק = הנושא לכל התחום">
          {(props) => (
            <select {...props} value={form.subCategoryId} onChange={(e) => setForm({ ...form, subCategoryId: e.target.value })}>
              <option value="">כל התחום</option>
              {(domain?.subCategories ?? []).map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
            </select>
          )}
        </Field>
      </div>
      <Field label="תיאור" hint="מוצג כשמעבירים את העכבר על כותרת הנושא בטבלה">
        {(props) => <textarea {...props} rows={3} value={form.description} maxLength={1000}
          onChange={(e) => setForm({ ...form, description: e.target.value })} />}
      </Field>
    </Modal>
  );
}

/* ==========================================================================
   משתמשי קצה — ייבוא בהדבקה מאקסל
   ========================================================================== */

const COLUMNS = ['fullName', 'employeeNo', 'department', 'roleTitle', 'domainName', 'subCategoryName'];

function parsePaste(text) {
  return text
    .split(/\r?\n/)
    .map((line) => line.split('\t'))
    .filter((cells) => cells.some((c) => c.trim()))
    .filter((cells, i) => !(i === 0 && /שם/.test(cells[0]) && cells.length > 1 && /עובד|מחלקה|תחום/.test(cells.join(' '))))
    .map((cells) => Object.fromEntries(COLUMNS.map((c, i) => [c, cells[i]?.trim() || null])));
}

function EndUsersTab({ siteId }) {
  const toast = useToast();
  const users = useApi('/api/skills/end-users', { siteId });
  const domains = useApi('/api/settings/domains');
  const [text, setText] = useState('');
  const [preview, setPreview] = useState(null);
  const [editing, setEditing] = useState(null);
  const [removing, setRemoving] = useState(null);

  const remove = useAction(
    async () => {
      await del(`/api/skills/end-users/${removing.id}`);
      toast.success(`${removing.full_name} הוסר/ה מהסקילומטר`);
      setRemoving(null);
      users.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const check = useAction(
    async () => setPreview(await post('/api/skills/end-users/import', { siteId, dryRun: true, rows: parsePaste(text) })),
    { onError: (err) => toast.error(err) },
  );
  const commit = useAction(
    async () => {
      const r = await post('/api/skills/end-users/import', { siteId, dryRun: false, rows: parsePaste(text) });
      toast.success(`נוספו ${r.created}, עודכנו ${r.updated}${r.skipped ? `, ${r.skipped} שורות דולגו` : ''}`);
      setText('');
      setPreview(null);
      users.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      <Panel title="ייבוא משתמשי קצה" subtitle="העתיקו מאקסל את העמודות לפי הסדר: שם · מספר עובד · מחלקה · תפקיד · תחום · תת-תחום">
        <Field label="הדבקה מאקסל" hint="משתמש עם מספר עובד שכבר קיים באתר יתעדכן ולא ישוכפל. שם התחום חייב להיות זהה לשם בהגדרות">
          {(props) => <textarea {...props} rows={6} value={text} dir="rtl"
            onChange={(e) => { setText(e.target.value); setPreview(null); }} />}
        </Field>
        <div className="row">
          <button type="button" className="btn btn-sm" onClick={() => check.run()} disabled={!text.trim() || check.busy}>
            {check.busy ? 'בודק…' : 'תצוגה מקדימה'}
          </button>
          {preview && preview.valid > 0 && (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => commit.run()} disabled={commit.busy}>
              {commit.busy ? 'מייבא…' : `ייבוא ${preview.valid} משתמשים`}
            </button>
          )}
        </div>

        {preview && (
          <div className="table-wrap mt-3">
            {preview.invalid > 0 && <Notice tone="warn" icon="⚠">{preview.invalid} שורות עם שגיאה לא ייובאו.</Notice>}
            <table className="table">
              <thead><tr><th>#</th><th>שם</th><th>מספר עובד</th><th>מחלקה</th><th>תחום</th><th>תת-תחום</th><th /></tr></thead>
              <tbody>
                {preview.preview.map((p) => (
                  <tr key={p.line}>
                    <td className="tnum muted">{p.line}</td>
                    <td className="bold">{p.fullName || '—'}</td>
                    <td className="tnum">{p.employeeNo ?? '—'}</td>
                    <td>{p.department ?? '—'}</td>
                    <td>{p.domainName ?? '—'}</td>
                    <td>{p.subCategoryName ?? '—'}</td>
                    <td>{p.errors.length ? <Tag tone="danger">{p.errors.join(' · ')}</Tag> : <Tag tone="ok">תקין</Tag>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        title={`${(users.data?.endUsers ?? []).length} משתמשי קצה`}
        actions={<button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({})}><Plus size={15} /> משתמש</button>}
        flush
      >
        <StateView loading={users.loading} error={users.error} onRetry={users.reload}
          empty={!users.loading && (users.data?.endUsers ?? []).length === 0}
          emptyProps={{ icon: '👤', title: 'עדיין לא יובאו משתמשי קצה לאתר' }}>
          <div className="table-wrap">
            <table className="table table-cards">
              <thead><tr><th>שם</th><th>מספר עובד</th><th>מחלקה</th><th>תפקיד</th><th>תחום</th><th>תת-תחום</th><th /></tr></thead>
              <tbody>
                {(users.data?.endUsers ?? []).map((u) => (
                  <tr key={u.id}>
                    <td data-label="שם" className="bold">{u.full_name}</td>
                    <td data-label="מספר עובד" className="tnum">{u.employee_no ?? '—'}</td>
                    <td data-label="מחלקה">{u.department ?? '—'}</td>
                    <td data-label="תפקיד">{u.role_title ?? '—'}</td>
                    <td data-label="תחום">{u.domain_name ?? <Tag tone="warn">חסר</Tag>}</td>
                    <td data-label="תת-תחום">{u.sub_category_name ?? '—'}</td>
                    <td>
                      <div className="row row-end" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(u)}
                          aria-label={`עריכת ${u.full_name}`}>
                          <Pencil size={15} />
                        </button>
                        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRemoving(u)}
                          aria-label={`הסרת ${u.full_name}`}>
                          <Trash2 size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {editing && (
        <EndUserDialog siteId={siteId} user={editing.id ? editing : null} domains={domains.data?.domains ?? []}
          onClose={() => setEditing(null)} onSaved={() => { setEditing(null); users.reload(); }} />
      )}
      {removing && (
        <ConfirmDialog
          title={`הסרת ${removing.full_name}`}
          message="המשתמש יוסר מטבלת המילוי ומהדוחות. ציונים שכבר ניתנו לו נשמרים במסד."
          confirmLabel="הסרה"
          busy={remove.busy}
          onConfirm={() => remove.run()}
          onCancel={() => setRemoving(null)}
        />
      )}
    </>
  );
}

function EndUserDialog({ siteId, user, domains, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    fullName: user?.full_name ?? '',
    employeeNo: user?.employee_no ?? '',
    department: user?.department ?? '',
    roleTitle: user?.role_title ?? '',
    domainId: user?.domain_id ?? '',
    subCategoryId: user?.sub_category_id ?? '',
  });
  const domain = domains.find((d) => d.id === form.domainId);
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value });

  const save = useAction(
    async () => {
      await post('/api/skills/end-users', {
        siteId,
        id: user?.id,
        fullName: form.fullName,
        employeeNo: form.employeeNo.trim() || null,
        department: form.department.trim() || null,
        roleTitle: form.roleTitle.trim() || null,
        domainId: form.domainId || null,
        subCategoryId: form.subCategoryId || null,
      });
      toast.success(user ? 'הפרטים עודכנו' : 'המשתמש נוסף');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal
      title={user ? `עריכת ${user.full_name}` : 'משתמש קצה חדש'}
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || !form.fullName.trim()}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <div className="grid grid-2">
        <Field label="שם מלא" required>
          {(props) => <input {...props} type="text" value={form.fullName} maxLength={200} onChange={set('fullName')} />}
        </Field>
        <Field label="מספר עובד">
          {(props) => <input {...props} type="text" value={form.employeeNo} maxLength={40} onChange={set('employeeNo')} />}
        </Field>
        <Field label="מחלקה">
          {(props) => <input {...props} type="text" value={form.department} maxLength={120} onChange={set('department')} />}
        </Field>
        <Field label="תפקיד">
          {(props) => <input {...props} type="text" value={form.roleTitle} maxLength={120} onChange={set('roleTitle')} />}
        </Field>
        <Field label="תחום">
          {(props) => (
            <select {...props} value={form.domainId} onChange={(e) => setForm({ ...form, domainId: e.target.value, subCategoryId: '' })}>
              <option value="">ללא תחום</option>
              {domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </Field>
        <Field label="תת-תחום">
          {(props) => (
            <select {...props} value={form.subCategoryId} onChange={set('subCategoryId')} disabled={!domain}>
              <option value="">—</option>
              {(domain?.subCategories ?? []).map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
            </select>
          )}
        </Field>
      </div>
    </Modal>
  );
}

/* ==========================================================================
   התקדמות — ממוצע לכל משתמש בכל סבב, כולל סבבים שנסגרו
   ========================================================================== */

function ProgressTab({ siteId }) {
  const toast = useToast();
  const { can } = usePermissions();
  const domains = useApi('/api/settings/domains');
  const [domainId, setDomainId] = useState('');
  const [open, setOpen] = useState(null);
  const params = domainId ? { siteId, domainId } : { siteId };
  const data = useApi('/api/skills/progress', params);
  const rounds = data.data?.rounds ?? [];
  const users = data.data?.users ?? [];

  const exportFile = useAction(
    () => download('/api/skills/progress.xlsx', params, 'סקילומטר - התקדמות.xlsx'),
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      title="התקדמות לפי משתמשים"
      subtitle="הממוצע של כל משתמש בכל סבב — גם בסבבים שנסגרו. לחיצה על שורה מציגה פירוט לפי נושא"
      actions={
        <div className="row" style={{ gap: 8 }}>
          <select value={domainId} onChange={(e) => setDomainId(e.target.value)} aria-label="סינון לפי תחום" style={{ width: 'auto' }}>
            <option value="">כל התחומים</option>
            {(domains.data?.domains ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          {can('skills', 'export') && (
            <button type="button" className="btn btn-sm" onClick={() => exportFile.run()} disabled={exportFile.busy || !users.length}>
              <Download size={15} /> אקסל
            </button>
          )}
        </div>
      }
      flush
    >
      <StateView loading={data.loading} error={data.error} onRetry={data.reload}
        empty={!data.loading && (rounds.length === 0 || users.length === 0)}
        emptyProps={{ icon: '📈', title: rounds.length === 0 ? 'עדיין אין סבבים שנפתחו' : 'אין משתמשי קצה בתחומים האלה' }}>
        <div className="table-wrap" style={{ maxHeight: '70vh' }}>
          <table className="skill-table">
            <thead>
              <tr>
                <th className="sticky-name">משתמש</th>
                {rounds.map((r) => (
                  <th key={r.id}>
                    {r.name}
                    {r.status === 'closed' && <div className="tiny muted">סגור</div>}
                  </th>
                ))}
                <th>שינוי</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <ProgressRow key={u.id} user={u} rounds={rounds} open={open === u.id}
                  onToggle={() => setOpen(open === u.id ? null : u.id)} />
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

function ProgressRow({ user, rounds, open, onToggle }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }} aria-expanded={open}>
        <td className="sticky-name">
          <div className="bold">{user.full_name}</div>
          <div className="tiny muted">{[user.domain_name, user.sub_category_name, user.department].filter(Boolean).join(' · ')}</div>
        </td>
        {user.rounds.map((r, i) => (
          <td key={rounds[i].id} style={{ textAlign: 'center' }}><ScorePill value={r?.avg ?? null} /></td>
        ))}
        <td style={{ textAlign: 'center' }} className="tnum bold">
          {user.delta == null ? <span className="muted">—</span>
            : <span style={{ color: user.delta > 0 ? 'var(--success)' : 'var(--danger)' }}>
                {user.delta > 0 ? '▲' : '▼'} {Math.abs(user.delta).toFixed(2)}
              </span>}
        </td>
      </tr>
      {open && user.topics.map((t) => (
        <tr key={t.topicId} className="muted">
          <td className="sticky-name small" style={{ paddingInlineStart: 28 }}>{t.name}</td>
          {rounds.map((r) => (
            <td key={r.id} style={{ textAlign: 'center' }} className="tnum small">{t.scores[r.id] ?? '—'}</td>
          ))}
          <td />
        </tr>
      ))}
    </>
  );
}
