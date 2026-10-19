import { useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { post, patch } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Modal, Field, Notice, Tag, StateView } from './ui/index.jsx';
import { fmtDate, fmtDateTime, dayName, STATUS_NAMES, statusTone } from '../lib/format.js';

/**
 * ניהול בקשת אילוץ שכבר הוגשה או אושרה — למנהל ולמדריך:
 * עריכה (תאריך, שעות, סוג), החזרה למטמיע לתיקון עם הערה, או ביטול עם נימוק.
 * המטמיע מקבל התראה על כל אחת מהפעולות.
 */
export function RequestManageDialog({ request, onClose, onChanged }) {
  const toast = useToast();
  const [mode, setMode] = useState('view');
  const [note, setNote] = useState('');
  const types = useApi(mode === 'edit' ? '/api/settings/lookups/constraintTypes' : null);
  const [form, setForm] = useState({
    constraintTypeId: request.constraint_type_id,
    constraintDate: request.constraint_date,
    startTime: request.start_time.slice(0, 5),
    endTime: request.end_time.slice(0, 5),
    note: request.note ?? '',
  });

  const act = useAction(
    async () => {
      if (mode === 'edit') {
        await patch(`/api/requests/${request.id}`, { ...form, note: form.note || null });
        toast.success('הבקשה עודכנה והמטמיע קיבל התראה');
      } else if (mode === 'return') {
        await post(`/api/requests/${request.id}/return`, { note });
        toast.success('הבקשה הוחזרה למטמיע לתיקון');
      } else if (mode === 'revoke') {
        await post(`/api/requests/${request.id}/revoke`, note.trim() ? { note } : {});
        toast.success('הבקשה בוטלה');
      }
      onChanged?.();
      onClose();
    },
    { onError: (err) => toast.error(err) },
  );

  const open = ['submitted', 'approved'].includes(request.status);
  const noteMissing = mode === 'return' && note.trim().length < 2;

  return (
    <Modal
      title={`${request.type_name} · ${request.user_name}`}
      onClose={onClose}
      footer={
        mode === 'view' ? (
          <>
            {open && <button type="button" className="btn btn-primary" onClick={() => setMode('edit')}>עריכה</button>}
            {open && <button type="button" className="btn" onClick={() => setMode('return')}>החזרה לתיקון</button>}
            {request.status !== 'cancelled' && (
              <button type="button" className="btn btn-danger" onClick={() => setMode('revoke')}>ביטול האילוץ</button>
            )}
            <button type="button" className="btn btn-ghost" onClick={onClose}>סגירה</button>
          </>
        ) : (
          <>
            <button
              type="button"
              className={`btn ${mode === 'revoke' ? 'btn-danger' : 'btn-primary'}`}
              onClick={() => act.run()}
              disabled={act.busy || noteMissing}
            >
              {act.busy ? 'שומר…' : { edit: 'שמירה', return: 'החזרה למטמיע', revoke: 'ביטול האילוץ' }[mode]}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setMode('view'); setNote(''); }}>חזרה</button>
          </>
        )
      }
    >
      <dl className="grid grid-2" style={{ marginBlockEnd: 'var(--space-4)' }}>
        <Detail label="מטמיע" value={request.user_name} />
        <Detail label="סטטוס" value={<Tag tone={statusTone(request.status)}>{STATUS_NAMES[request.status] ?? request.status}</Tag>} />
        <Detail label="תאריך" value={`${dayName(request.constraint_date)} ${fmtDate(request.constraint_date)}`} />
        <Detail label="שעות" value={`${request.start_time.slice(0, 5)}–${request.end_time.slice(0, 5)}`} />
        <Detail label="אתר" value={request.site_name ?? '—'} />
        <Detail label="הוחלט" value={request.decided_at ? `${fmtDateTime(request.decided_at)}${request.approver_name ? ` · ${request.approver_name}` : ''}` : (request.auto_approved ? 'אוטומטית' : '—')} />
      </dl>
      {request.note && <Notice icon="📝"><span className="small">הערת המטמיע: {request.note}</span></Notice>}
      {request.decision_note && <Notice icon="💬"><span className="small">הערת ההחלטה: {request.decision_note}</span></Notice>}

      {mode === 'edit' && (
        <StateView loading={types.loading} error={types.error} onRetry={types.reload}>
          <Field label="סוג">
            {(props) => (
              <select {...props} value={form.constraintTypeId} onChange={(e) => setForm({ ...form, constraintTypeId: e.target.value })}>
                {(types.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name_he}</option>)}
              </select>
            )}
          </Field>
          <Field label="תאריך">
            {(props) => <input {...props} type="date" value={form.constraintDate} onChange={(e) => setForm({ ...form, constraintDate: e.target.value })} />}
          </Field>
          <div className="grid grid-2">
            <Field label="משעה">
              {(props) => <input {...props} type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />}
            </Field>
            <Field label="עד שעה">
              {(props) => <input {...props} type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />}
            </Field>
          </div>
          <Field label="הערה">
            {(props) => <textarea {...props} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />}
          </Field>
        </StateView>
      )}

      {mode === 'return' && (
        <Field label="מה צריך לתקן" required hint="ההערה נשלחת למטמיע, והבקשה חוזרת אליו כטיוטה להגשה מחדש">
          {(props) => <textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} autoFocus />}
        </Field>
      )}

      {mode === 'revoke' && (
        <>
          <Notice tone="warn" icon="⚠" title="האילוץ יבוטל והמטמיע יקבל התראה">
            <span className="small">אחרי הביטול אפשר לשבץ את המטמיע בזמן הזה.</span>
          </Notice>
          <Field label="נימוק" hint="רשות — נשלח למטמיע">
            {(props) => <textarea {...props} value={note} onChange={(e) => setNote(e.target.value)} />}
          </Field>
        </>
      )}
    </Modal>
  );
}

const Detail = ({ label, value }) => (
  <div>
    <dt className="tiny muted">{label}</dt>
    <dd style={{ margin: 0 }} className="bold small">{value}</dd>
  </div>
);
