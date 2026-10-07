import { useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post, newIdempotencyKey } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Notice, Field, Modal, Segmented, Empty } from '../components/ui/index.jsx';
import {
  fmtDate, fmtDateTime, fmtWeekRange, STATUS_NAMES, statusTone, SEVERITY_NAMES, SEVERITY_TONE,
} from '../lib/format.js';

/**
 * תור האישורים.
 *
 * שלושה סוגי פריטים: חריגות שמנוע החוקיות יצר, בקשות אילוץ שממתינות
 * להחלטה, והגשות זמינות שחרגו מהמכסות. חריגה והגשת זמינות מחייבות נימוק
 * (§10); בקשת אילוץ רגילה מוכרעת בלחיצה אחת.
 */
export default function Approvals() {
  const [tab, setTab] = useState('exceptions');

  const exceptions = useApi('/api/exceptions', { status: 'pending', limit: 100 });
  const requests = useApi('/api/requests', { status: 'submitted', limit: 100 });
  const availability = useApi('/api/availability/pending');

  const counts = {
    exceptions: (exceptions.data?.exceptions ?? []).length,
    requests: (requests.data?.requests ?? []).length,
    availability: (availability.data?.declarations ?? []).length,
  };

  const reloadAll = () => {
    exceptions.reload();
    requests.reload();
    availability.reload();
  };

  return (
    <>
      <ViewHead
        title="בקשות ואישורים"
        subtitle="כל מה שממתין להחלטה שלך. בקשות — בלחיצה אחת; חריגות וזמינות — עם נימוק."
        actions={
          <Segmented
            label="סוג הפריטים"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'exceptions', label: `חריגות (${counts.exceptions})` },
              { value: 'requests', label: `בקשות (${counts.requests})` },
              { value: 'availability', label: `זמינות (${counts.availability})` },
            ]}
          />
        }
      />

      {tab === 'exceptions' && <ExceptionsQueue query={exceptions} onChanged={reloadAll} />}
      {tab === 'requests' && (
        <RequestsQueue
          query={requests}
          onChanged={reloadAll}
          onShowExceptions={() => setTab('exceptions')}
        />
      )}
      {tab === 'availability' && <AvailabilityQueue query={availability} onChanged={reloadAll} />}
    </>
  );
}

/* ── חריגות ───────────────────────────────────────────────── */

function ExceptionsQueue({ query, onChanged }) {
  const [selected, setSelected] = useState(null);

  return (
    <>
      <Panel title="חריגות שממתינות להחלטה" flush>
        <StateView
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={!query.loading && (query.data?.exceptions ?? []).length === 0}
          emptyProps={{ icon: '✓', title: 'אין חריגות פתוחות', text: 'כל הבקשות שדרשו אישור הוכרעו.' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>נושא</th>
                  <th>חוק</th>
                  <th>פירוט</th>
                  <th>הוגש</th>
                  <th>תוקף</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(query.data?.exceptions ?? []).map((ex) => (
                  <tr key={ex.id}>
                    <td data-label="נושא" className="bold">
                      {ex.target_name ?? ex.requested_by_name}
                      <div className="tiny muted">{ex.site_name}</div>
                    </td>
                    <td data-label="חוק" className="small">{ex.rule_name}</td>
                    <td data-label="פירוט" className="small">{ex.summary}</td>
                    <td data-label="הוגש" className="tnum small">{fmtDateTime(ex.created_at)}</td>
                    <td data-label="תוקף" className="tnum small">
                      {ex.expires_at ? fmtDate(ex.expires_at.slice(0, 10)) : '—'}
                    </td>
                    <td>
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setSelected(ex)}>
                        בדיקה והחלטה
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {selected && (
        <ExceptionDialog
          exceptionId={selected.id}
          onClose={() => setSelected(null)}
          onDecided={() => { setSelected(null); onChanged(); }}
        />
      )}
    </>
  );
}

function ExceptionDialog({ exceptionId, onClose, onDecided }) {
  const toast = useToast();
  const detail = useApi(`/api/exceptions/${exceptionId}`);
  const [comment, setComment] = useState('');
  const [touched, setTouched] = useState(false);

  const decide = useAction(
    async (decision) => {
      await post(
        `/api/exceptions/${exceptionId}/decision`,
        { decision, comment: comment.trim() },
        { idempotencyKey: newIdempotencyKey() },
      );
      toast.success(decision === 'approve' ? 'החריגה אושרה והפעולה בוצעה' : 'החריגה נדחתה');
      onDecided();
    },
    { onError: (err) => toast.error(err) },
  );

  const commentError = touched && comment.trim().length < 3 ? 'נימוק הוא שדה חובה (3 תווים לפחות)' : null;
  const ex = detail.data?.exception;
  const evaluation = detail.data?.evaluation;

  const submit = (decision) => {
    setTouched(true);
    if (comment.trim().length < 3) return;
    decide.run(decision);
  };

  return (
    <Modal
      title="החלטה בחריגה"
      onClose={onClose}
      width={640}
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => submit('approve')}
            disabled={decide.busy || !detail.data?.canDecide}
          >
            {decide.busy ? 'מבצע…' : 'אישור'}
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => submit('reject')}
            disabled={decide.busy || !detail.data?.canDecide}
          >
            דחייה
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>סגירה</button>
        </>
      }
    >
      <StateView loading={detail.loading} error={detail.error} onRetry={detail.reload}>
        {ex && (
          <>
            {!detail.data.canDecide && (
              <Notice tone="warn" icon="🔒" title="אינך מוגדר/ת כמאשר/ת לחריגה הזו">
                החריגה נותבה ל{ex.approver_name ?? 'גורם אחר'}.
              </Notice>
            )}

            <dl className="grid grid-2" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <Detail label="נושא הבקשה" value={ex.target_name ?? '—'} />
              <Detail label="הוגש על ידי" value={ex.requested_by_name} />
              <Detail label="אתר" value={ex.site_name ?? '—'} />
              <Detail label="הוגש" value={fmtDateTime(ex.created_at)} />
            </dl>

            <Notice tone="warn" icon="⚠" title={ex.rule_name ?? 'חריגה מחוק'}>
              {ex.summary}
            </Notice>

            {evaluation?.results?.length > 0 && (
              <Panel title="כל החוקים שנבדקו" flush className="mb-0">
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr><th>חוק</th><th>חומרה</th><th>תוצאה</th></tr>
                    </thead>
                    <tbody>
                      {evaluation.results.map((r, i) => (
                        <tr key={i}>
                          <td>{r.name}</td>
                          <td>
                            <Tag tone={SEVERITY_TONE[r.severity]}>{SEVERITY_NAMES[r.severity]}</Tag>
                          </td>
                          <td className="small">
                            {r.passed ? <span className="muted">עבר</span> : r.message}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Panel>
            )}

            <Notice icon="ℹ">
              <span className="small">
                באישור, הפעולה שחנתה תבוצע עכשיו — אחרי בדיקה חוזרת שהיא עדיין חוקית.
                בדחייה, הפעולה לא תבוצע כלל.
              </span>
            </Notice>

            <Field label="נימוק ההחלטה" required error={commentError} htmlFor="decision-comment">
              {(props) => (
                <textarea
                  {...props}
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onBlur={() => setTouched(true)}
                  placeholder="הנימוק נשמר ביומן הביקורת ונשלח למגיש"
                />
              )}
            </Field>
          </>
        )}
      </StateView>
    </Modal>
  );
}

/* ── בקשות אילוץ ──────────────────────────────────────────── */

function RequestsQueue({ query, onChanged, onShowExceptions }) {
  const toast = useToast();
  // הבקשה שההחלטה עליה בדרך — כדי לנעול רק את הכפתורים שלה
  const [pendingId, setPendingId] = useState(null);

  const decide = useAction(
    async (request, decision) => {
      setPendingId(request.id);
      try {
        await post(
          `/api/requests/${request.id}/decision`,
          { decision },
          { idempotencyKey: newIdempotencyKey() },
        );
        toast.success(
          decision === 'approve'
            ? `הבקשה של ${request.user_name} אושרה`
            : `הבקשה של ${request.user_name} נדחתה`,
        );
        onChanged();
      } finally {
        setPendingId(null);
      }
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      title="בקשות שממתינות להחלטה"
      subtitle="אישור או דחייה בלחיצה אחת. המטמיע מקבל התראה על ההחלטה."
      flush
    >
      <StateView
        loading={query.loading}
        error={query.error}
        onRetry={query.reload}
        empty={!query.loading && (query.data?.requests ?? []).length === 0}
        emptyProps={{ icon: '✓', title: 'אין בקשות שממתינות להחלטה' }}
      >
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>מטמיע</th><th>סוג</th><th>תאריך</th><th>שעות</th><th>הערה</th><th>החלטה</th></tr>
            </thead>
            <tbody>
              {(query.data?.requests ?? []).map((request) => {
                const locked = request.has_pending_exception;
                const busy = pendingId === request.id;
                return (
                  <tr key={request.id}>
                    <td data-label="מטמיע" className="bold">
                      {request.user_name}
                      {request.site_name && <div className="tiny muted">{request.site_name}</div>}
                    </td>
                    <td data-label="סוג">{request.type_name}</td>
                    <td data-label="תאריך" className="tnum">{fmtDate(request.constraint_date)}</td>
                    <td data-label="שעות" className="tnum">
                      {request.start_time.slice(0, 5)}–{request.end_time.slice(0, 5)}
                    </td>
                    <td data-label="הערה" className="small">{request.note ?? '—'}</td>
                    <td data-label="החלטה">
                      {locked ? (
                        <div className="stack" style={{ gap: 4 }}>
                          <Tag tone="warn">ממתינה להחלטה בחריגה</Tag>
                          <button type="button" className="btn btn-sm btn-ghost" onClick={onShowExceptions}>
                            ללשונית החריגות
                          </button>
                        </div>
                      ) : (
                        <div className="row" style={{ gap: 4, flexWrap: 'nowrap' }}>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            onClick={() => decide.run(request, 'approve')}
                            disabled={decide.busy}
                            aria-label={`אישור הבקשה של ${request.user_name}`}
                          >
                            {busy ? '…' : '✓ אישור'}
                          </button>
                          <button
                            type="button"
                            className="btn btn-sm btn-danger"
                            onClick={() => decide.run(request, 'reject')}
                            disabled={decide.busy}
                            aria-label={`דחיית הבקשה של ${request.user_name}`}
                          >
                            ✕ דחייה
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

/* ── הגשות זמינות שחרגו ───────────────────────────────────── */

function AvailabilityQueue({ query, onChanged }) {
  const toast = useToast();
  const [deciding, setDeciding] = useState(null);
  const [comment, setComment] = useState('');

  const decide = useAction(
    async (decision) => {
      await post(
        `/api/availability/declarations/${deciding.id}/decision`,
        { decision, comment: comment.trim() },
        { idempotencyKey: newIdempotencyKey() },
      );
      toast.success(decision === 'approve' ? 'ההצהרה אושרה' : 'ההצהרה נדחתה');
      setDeciding(null);
      setComment('');
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      <Panel title="הגשות זמינות שחורגות מהכללים" flush>
        <StateView
          loading={query.loading}
          error={query.error}
          onRetry={query.reload}
          empty={!query.loading && (query.data?.declarations ?? []).length === 0}
          emptyProps={{ icon: '✓', title: 'אין הגשות שממתינות לאישור מיוחד' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr><th>מטמיע</th><th>שבוע</th><th>מכסות</th><th>חריגות</th><th /></tr>
              </thead>
              <tbody>
                {(query.data?.declarations ?? []).map((d) => (
                  <tr key={d.id}>
                    <td data-label="מטמיע" className="bold">
                      {d.user_name}
                      <div className="tiny muted">{d.site_name}</div>
                    </td>
                    <td data-label="שבוע" className="tnum">{fmtWeekRange(d.week_start)}</td>
                    <td data-label="מכסות" className="small tnum">
                      <Tag tone={d.cannot_count > d.max_cannot_snapshot ? 'danger' : ''}>
                        לא יכול {d.cannot_count}/{d.max_cannot_snapshot}
                      </Tag>{' '}
                      <Tag tone={d.prefer_not_count > d.max_prefer_not_snapshot ? 'danger' : ''}>
                        מעדיף שלא {d.prefer_not_count}/{d.max_prefer_not_snapshot}
                      </Tag>
                    </td>
                    <td data-label="חריגות" className="small">
                      <ul style={{ margin: 0, paddingInlineStart: 16 }}>
                        {(d.violations ?? []).map((v, i) => (
                          <li key={i}>{v.detail?.message ?? v.kind}</li>
                        ))}
                      </ul>
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => setDeciding(d)}>
                        החלטה
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {deciding && (
        <Modal
          title={`הצהרת זמינות — ${deciding.user_name}`}
          onClose={() => { setDeciding(null); setComment(''); }}
          footer={
            <>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => decide.run('approve')}
                disabled={decide.busy || comment.trim().length < 3}
              >
                אישור
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => decide.run('reject')}
                disabled={decide.busy || comment.trim().length < 3}
              >
                דחייה
              </button>
              <button type="button" className="btn btn-ghost" onClick={() => setDeciding(null)}>ביטול</button>
            </>
          }
        >
          <Notice tone="warn" icon="⚠" title={`שבוע ${fmtWeekRange(deciding.week_start)}`}>
            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
              {(deciding.violations ?? []).map((v, i) => (
                <li key={i}>{v.detail?.message ?? v.kind}</li>
              ))}
            </ul>
          </Notice>

          <Notice icon="ℹ">
            <span className="small">
              אישור הופך את הסימונים למחייבים: שיבוץ במשמרת שסומנה "לא יכול" ייחסם.
              דחייה משאירה את הסימון כאזהרה בלבד.
            </span>
          </Notice>

          <Field label="נימוק ההחלטה" required htmlFor="avail-comment">
            {(props) => (
              <textarea {...props} value={comment} onChange={(e) => setComment(e.target.value)} />
            )}
          </Field>
        </Modal>
      )}
    </>
  );
}

const Detail = ({ label, value }) => (
  <div>
    <dt className="field-label">{label}</dt>
    <dd style={{ margin: 0 }}>{value}</dd>
  </div>
);
