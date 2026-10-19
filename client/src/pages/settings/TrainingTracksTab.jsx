import { useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post, put, del } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Field, Modal, Accordion } from '../../components/ui/index.jsx';

/**
 * תבניות הכשרה: רשימת שלבים עם משך בימים. מתבנית יוצרים בלחיצה את גאנט
 * ההכשרה של מטמיע (מסך "הכשרה") — כל שלב מתחיל כשהקודם מסתיים.
 */
export default function TrainingTracksTab() {
  const tracks = useApi('/api/training/tracks');
  const [editing, setEditing] = useState(null);

  return (
    <>
      <Panel
        title="תבניות הכשרה"
        subtitle="שלבי ההכשרה ומשך כל שלב — הבסיס לגאנט האישי של כל מטמיע"
        actions={<button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({ name: '', items: [] })}>+ תבנית חדשה</button>}
        flush
      >
        <StateView
          loading={tracks.loading}
          error={tracks.error}
          onRetry={tracks.reload}
          empty={!tracks.loading && (tracks.data?.tracks ?? []).length === 0}
          emptyProps={{ icon: '🎓', title: 'עדיין אין תבניות', text: 'למשל: היכרות עם המערכת (5 ימים) ← תרגול מודרך (10) ← עבודה עצמאית בליווי (10).' }}
        >
          {(tracks.data?.tracks ?? []).map((t) => (
            <Accordion
              key={t.id}
              title={t.name}
              meta={<>
                <Tag>{t.items.length} שלבים</Tag>
                <Tag>{t.items.reduce((s, i) => s + i.duration_days, 0)} ימים</Tag>
              </>}
              actions={<button type="button" className="btn btn-sm" onClick={() => setEditing(t)}>עריכה</button>}
            >
              {t.description && <p className="small muted">{t.description}</p>}
              <ol className="small" style={{ margin: 0, paddingInlineStart: 20 }}>
                {t.items.map((i) => <li key={i.id}>{i.title} <span className="muted">· {i.duration_days} ימים</span></li>)}
              </ol>
            </Accordion>
          ))}
        </StateView>
      </Panel>

      {editing && (
        <TrackForm track={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); tracks.reload(); }} />
      )}
    </>
  );
}

function TrackForm({ track, onClose, onSaved }) {
  const toast = useToast();
  const [name, setName] = useState(track.name ?? '');
  const [description, setDescription] = useState(track.description ?? '');
  const [items, setItems] = useState(
    (track.items ?? []).map((i) => ({ id: i.id, title: i.title, durationDays: i.duration_days })),
  );

  const save = useAction(
    async () => {
      const body = {
        name, description: description || null,
        items: items.filter((i) => i.title.trim()).map((i) => ({ ...i, durationDays: Number(i.durationDays) || 1 })),
      };
      if (track.id) await put(`/api/training/tracks/${track.id}`, body);
      else await post('/api/training/tracks', body);
      toast.success('התבנית נשמרה');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );
  const remove = useAction(
    async () => {
      await del(`/api/training/tracks/${track.id}`);
      toast.success('התבנית נמחקה');
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const set = (index, patch) => setItems(items.map((it, i) => (i === index ? { ...it, ...patch } : it)));
  const move = (index, dir) => {
    const next = [...items];
    const [it] = next.splice(index, 1);
    next.splice(index + dir, 0, it);
    setItems(next);
  };

  return (
    <Modal
      title={track.id ? 'עריכת תבנית הכשרה' : 'תבנית הכשרה חדשה'}
      onClose={onClose}
      width={620}
      footer={<>
        <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || !name.trim()}>
          {save.busy ? 'שומר…' : 'שמירה'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        {track.id && (
          <button type="button" className="btn btn-sm btn-danger" style={{ marginInlineStart: 'auto' }}
            onClick={() => remove.run()} disabled={remove.busy}>מחיקה</button>
        )}
      </>}
    >
      <Field label="שם התבנית" required>
        {(props) => <input {...props} value={name} onChange={(e) => setName(e.target.value)} placeholder="למשל: הכשרת מטמיע — מחלקות" />}
      </Field>
      <Field label="תיאור">
        {(props) => <textarea {...props} value={description} onChange={(e) => setDescription(e.target.value)} />}
      </Field>

      <div className="bold small" style={{ marginBlock: 'var(--space-3) 6px' }}>שלבים (לפי הסדר)</div>
      <div className="stack" style={{ gap: 6 }}>
        {items.map((it, index) => (
          <div key={it.id ?? `new-${index}`} className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
            <span className="tnum small muted" style={{ minWidth: 18 }}>{index + 1}.</span>
            <input value={it.title} onChange={(e) => set(index, { title: e.target.value })} placeholder="שם השלב" aria-label="שם השלב" />
            <input type="number" min={1} max={365} value={it.durationDays} onChange={(e) => set(index, { durationDays: e.target.value })}
              aria-label="משך בימים" style={{ width: 80 }} />
            <span className="small muted nowrap">ימים</span>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => move(index, -1)} disabled={index === 0} aria-label="למעלה">↑</button>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => move(index, 1)} disabled={index === items.length - 1} aria-label="למטה">↓</button>
            <button type="button" className="btn btn-sm btn-icon" onClick={() => setItems(items.filter((_, i) => i !== index))} aria-label="הסרה">✕</button>
          </div>
        ))}
      </div>
      <button type="button" className="btn btn-sm mt-3" onClick={() => setItems([...items, { title: '', durationDays: 7 }])}>+ שלב</button>
    </Modal>
  );
}
