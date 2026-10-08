import { useEffect, useState } from 'react';
import { Paperclip, Send, BellRing, Download, CheckCircle2 } from 'lucide-react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post, del } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead, Avatar } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Notice, Field, Modal, Segmented } from '../components/ui/index.jsx';
import { fmtDateTime, fmtRelative, ROLE_NAMES } from '../lib/format.js';

/**
 * הודעות לצוות.
 *
 * מדריך שולח לצוות שלו (מנהל — לכל אחד) הודעה, עם קבצים ובקשת אישור
 * קריאה. הנמען רואה את ההודעה בתיבה, ומאשר "קראתי". השולח רואה מי קרא
 * ומי אישר, ויכול לשלוח תזכורת למי שעוד לא אישר.
 */
export default function Messages() {
  const { can } = usePermissions();
  const canSend = can('updates', 'create');
  const [tab, setTab] = useState('inbox');
  const [composing, setComposing] = useState(false);
  const [openId, setOpenId] = useState(null);

  const inbox = useApi('/api/updates/inbox');
  const sent = useApi(canSend && tab === 'sent' ? '/api/updates/sent' : null);

  return (
    <>
      <ViewHead
        title="הודעות"
        subtitle={canSend ? 'הודעות, נהלים וקבצים לצוות — עם אישור קריאה' : 'הודעות מהמדריך וממנהל ההטמעה'}
        actions={
          canSend && (
            <button type="button" className="btn btn-primary" onClick={() => setComposing(true)}>
              <Send size={16} /> הודעה חדשה
            </button>
          )
        }
      />

      {canSend && (
        <div className="row" style={{ marginBlockEnd: 'var(--space-4)' }}>
          <Segmented
            label="תיבת הודעות"
            value={tab}
            onChange={setTab}
            options={[{ value: 'inbox', label: 'נכנסות' }, { value: 'sent', label: 'נשלחו' }]}
          />
        </div>
      )}

      {tab === 'inbox' ? (
        <Panel flush>
          <StateView
            loading={inbox.loading}
            error={inbox.error}
            onRetry={inbox.reload}
            empty={!inbox.loading && (inbox.data?.updates ?? []).length === 0}
            emptyProps={{ icon: '💬', title: 'אין הודעות', text: 'הודעות מהמדריך שלך יופיעו כאן.' }}
          >
            <div className="msg-list">
              {(inbox.data?.updates ?? []).map((u) => (
                <button key={u.id} type="button" className="msg-item" onClick={() => setOpenId(u.id)}>
                  <span className={`msg-dot${u.read_at ? ' read' : ''}`} aria-hidden="true" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <span className="msg-title">{u.title}</span>
                      <span className="small muted row-end nowrap">{fmtRelative(u.published_at)}</span>
                    </div>
                    <div className="small muted">{u.author_name}</div>
                    <div className="msg-preview">{u.body}</div>
                    <div className="row" style={{ gap: 6, marginBlockStart: 6 }}>
                      {u.requires_ack && (u.acknowledged_at
                        ? <Tag tone="ok">אושרה קריאה</Tag>
                        : <Tag tone="warn">ממתין לאישור קריאה</Tag>)}
                      {u.attachment_count > 0 && <Tag><Paperclip size={12} /> {u.attachment_count}</Tag>}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          </StateView>
        </Panel>
      ) : (
        <Panel flush>
          <StateView
            loading={sent.loading}
            error={sent.error}
            onRetry={sent.reload}
            empty={!sent.loading && (sent.data?.updates ?? []).length === 0}
            emptyProps={{ icon: '💬', title: 'עדיין לא שלחת הודעות' }}
          >
            <div className="msg-list">
              {(sent.data?.updates ?? []).map((u) => (
                <button key={u.id} type="button" className="msg-item" onClick={() => setOpenId(u.id)}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="row" style={{ flexWrap: 'nowrap' }}>
                      <span className="msg-title">{u.title}</span>
                      {u.status === 'draft' && <Tag>טיוטה</Tag>}
                      <span className="small muted row-end nowrap">
                        {fmtRelative(u.published_at ?? u.created_at)}
                      </span>
                    </div>
                    <div className="msg-preview">{u.body}</div>
                    <div className="row small muted" style={{ marginBlockStart: 6 }}>
                      <span>{u.recipient_count} נמענים</span>
                      <span>· {u.read_count} קראו</span>
                      {u.requires_ack && <span>· {u.ack_count} אישרו</span>}
                    </div>
                    {u.requires_ack && u.recipient_count > 0 && (
                      <div className="progress" style={{ marginBlockStart: 8, maxWidth: 260 }}>
                        <span style={{ width: `${(u.ack_count / u.recipient_count) * 100}%` }} />
                      </div>
                    )}
                  </div>
                </button>
              ))}
            </div>
          </StateView>
        </Panel>
      )}

      {composing && (
        <Compose
          onClose={() => setComposing(false)}
          onSent={() => { setComposing(false); setTab('sent'); sent.reload(); }}
        />
      )}

      {openId && (
        <MessageDetail
          id={openId}
          onClose={() => { setOpenId(null); inbox.reload(); sent.reload(); }}
        />
      )}
    </>
  );
}

/* ==========================================================================
   כתיבת הודעה
   ========================================================================== */

function Compose({ onClose, onSent }) {
  const toast = useToast();
  const { role } = usePermissions();
  const options = useApi('/api/updates/recipients');
  const [form, setForm] = useState({ title: '', body: '', requiresAck: true, toWholeTeam: true });
  const [recipientIds, setRecipientIds] = useState([]);
  const [files, setFiles] = useState([]);

  const recipients = options.data?.recipients ?? [];
  const storageEnabled = options.data?.storageEnabled;
  const teamLabel = role === 'manager' ? 'כל הצוות (מטמיעים ומדריכים)' : 'כל הצוות שלי';

  const send = useAction(
    async () => {
      const { id } = await post('/api/updates', {
        title: form.title,
        body: form.body,
        requiresAck: form.requiresAck,
        toWholeTeam: form.toWholeTeam,
        recipientIds: form.toWholeTeam ? [] : recipientIds,
      });

      // הקבצים עולים ישירות ל-Storage, ורק אחר כך ההודעה נשלחת
      for (const file of files) {
        const meta = { fileName: file.name, sizeBytes: file.size, mimeType: file.type || null };
        const { uploadUrl, storagePath } = await post(`/api/updates/${id}/attachments/sign`, meta);
        const res = await fetch(uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type || 'application/octet-stream' },
          body: file,
        });
        if (!res.ok) throw new Error(`העלאת הקובץ ${file.name} נכשלה`);
        await post(`/api/updates/${id}/attachments`, { ...meta, storagePath });
      }

      try {
        await post(`/api/updates/${id}/publish`);
      } catch (err) {
        // שליחה שנכשלה משאירה טיוטה יתומה — עדיף למחוק אותה
        await del(`/api/updates/${id}`).catch(() => {});
        throw err;
      }
      toast.success('ההודעה נשלחה');
      onSent();
    },
    { onError: (err) => toast.error(err) },
  );

  const tooBig = files.find((f) => f.size > 10 * 1024 * 1024);
  const ready = form.title.trim() && form.body.trim() && (form.toWholeTeam || recipientIds.length) && !tooBig;

  return (
    <Modal
      title="הודעה חדשה"
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => send.run()} disabled={!ready || send.busy}>
            <Send size={16} /> {send.busy ? 'שולח…' : 'שליחה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <StateView loading={options.loading} error={options.error} onRetry={options.reload}>
        <Field label="נמענים" required>
          {() => (
            <div className="stack" style={{ gap: 8 }}>
              <label className="check">
                <input
                  type="radio"
                  checked={form.toWholeTeam}
                  onChange={() => setForm({ ...form, toWholeTeam: true })}
                />
                {teamLabel} ({recipients.filter((r) => role !== 'manager' || r.base_role !== 'manager').length})
              </label>
              <label className="check">
                <input
                  type="radio"
                  checked={!form.toWholeTeam}
                  onChange={() => setForm({ ...form, toWholeTeam: false })}
                />
                בחירת נמענים
              </label>
              {!form.toWholeTeam && (
                <div className="row" style={{ gap: 6 }}>
                  {recipients.length === 0 && <span className="small muted">אין נמענים זמינים</span>}
                  {recipients.map((r) => {
                    const on = recipientIds.includes(r.id);
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className="chip"
                        aria-pressed={on}
                        onClick={() => setRecipientIds(on ? recipientIds.filter((x) => x !== r.id) : [...recipientIds, r.id])}
                        title={ROLE_NAMES[r.base_role]}
                      >
                        {r.full_name}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </Field>

        <Field label="כותרת" required>
          {(props) => (
            <input {...props} type="text" value={form.title} maxLength={200}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="למשל: נוהל החלפת משמרות" />
          )}
        </Field>

        <Field label="תוכן" required>
          {(props) => (
            <textarea {...props} value={form.body} rows={6}
              onChange={(e) => setForm({ ...form, body: e.target.value })} />
          )}
        </Field>

        <Field label="קבצים מצורפים" hint={storageEnabled ? 'עד 10MB לקובץ' : undefined}>
          {(props) =>
            storageEnabled ? (
              <>
                <input {...props} type="file" multiple onChange={(e) => setFiles([...e.target.files])} />
                {files.length > 0 && (
                  <div className="stack mt-3" style={{ gap: 6 }}>
                    {files.map((f) => (
                      <div key={f.name} className="file-row">
                        <Paperclip size={15} />
                        <span style={{ flex: 1 }}>{f.name}</span>
                        <span className={`small ${f.size > 10 * 1024 * 1024 ? '' : 'muted'}`} style={f.size > 10 * 1024 * 1024 ? { color: 'var(--danger)' } : undefined}>
                          {fmtSize(f.size)}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <p className="small muted">צירוף קבצים אינו זמין בשרת הזה (לא הוגדר אחסון קבצים).</p>
            )
          }
        </Field>

        <label className="check">
          <input
            type="checkbox"
            checked={form.requiresAck}
            onChange={(e) => setForm({ ...form, requiresAck: e.target.checked })}
          />
          לבקש מהנמענים לאשר שקראו את ההודעה
        </label>
      </StateView>
    </Modal>
  );
}

const fmtSize = (bytes) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))}KB` : `${(bytes / 1024 / 1024).toFixed(1)}MB`;

/* ==========================================================================
   פירוט הודעה — לנמען ולשולח
   ========================================================================== */

function MessageDetail({ id, onClose }) {
  const toast = useToast();
  const detail = useApi(`/api/updates/${id}`);
  const update = detail.data?.update;
  const unread = update && !update.isAuthor && update.mine && !update.mine.read_at;

  // פתיחה = קריאה
  useEffect(() => {
    if (unread) post(`/api/updates/${id}/read`).catch(() => {});
  }, [unread, id]);

  const ack = useAction(
    async () => {
      await post(`/api/updates/${id}/ack`);
      toast.success('אישור הקריאה נשלח');
      detail.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const remind = useAction(
    async () => {
      const { reminded } = await post(`/api/updates/${id}/remind`);
      toast.success(reminded ? `נשלחה תזכורת ל-${reminded} נמענים` : 'כולם כבר אישרו');
      detail.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const open = useAction(
    async (att) => {
      const { url } = await get(`/api/updates/${id}/attachments/${att.id}/url`);
      window.open(url, '_blank', 'noopener');
    },
    { onError: (err) => toast.error(err) },
  );

  const recipients = update?.recipients ?? [];
  const acked = recipients.filter((r) => r.acknowledged_at).length;
  const needsAck = update && !update.isAuthor && update.requires_ack && !update.mine?.acknowledged_at;

  return (
    <Modal
      title={update?.title ?? 'הודעה'}
      onClose={onClose}
      width={620}
      footer={
        update && (needsAck || (update.isAuthor && update.requires_ack)) ? (
          needsAck ? (
            <button type="button" className="btn btn-primary" onClick={() => ack.run()} disabled={ack.busy}>
              <CheckCircle2 size={16} /> {ack.busy ? 'שולח…' : 'קראתי ואישרתי'}
            </button>
          ) : (
            <button type="button" className="btn" onClick={() => remind.run()}
              disabled={remind.busy || acked === recipients.length}>
              <BellRing size={16} /> תזכורת למי שלא אישר
            </button>
          )
        ) : null
      }
    >
      <StateView loading={detail.loading} error={detail.error} onRetry={detail.reload}>
        {update && (
          <>
            <div className="row" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <Avatar name={update.author_name} size={36} />
              <div>
                <div className="bold">{update.author_name}</div>
                <div className="small muted">{update.published_at ? fmtDateTime(update.published_at) : 'טיוטה'}</div>
              </div>
              {update.requires_ack && !update.isAuthor && (
                <span className="row-end">
                  {update.mine?.acknowledged_at
                    ? <Tag tone="ok">אישרת קריאה</Tag>
                    : <Tag tone="warn">ממתין לאישורך</Tag>}
                </span>
              )}
            </div>

            <div className="msg-body">{update.body}</div>

            {update.attachments.length > 0 && (
              <div className="stack mt-3" style={{ gap: 6, marginBlockStart: 'var(--space-4)' }}>
                {update.attachments.map((a) => (
                  <button key={a.id} type="button" className="file-row btn" style={{ justifyContent: 'flex-start' }}
                    onClick={() => open.run(a)} disabled={open.busy}>
                    <Paperclip size={15} />
                    <span style={{ flex: 1, textAlign: 'start', color: 'var(--ink)' }}>{a.file_name}</span>
                    <span className="small muted">{fmtSize(a.size_bytes)}</span>
                    <Download size={15} />
                  </button>
                ))}
              </div>
            )}

            {update.isAuthor && (
              <>
                <div className="divider" />
                {update.requires_ack && (
                  <>
                    <div className="row" style={{ marginBlockEnd: 6 }}>
                      <span className="bold">{acked}/{recipients.length} אישרו קריאה</span>
                    </div>
                    <div className="progress" style={{ marginBlockEnd: 'var(--space-3)' }}>
                      <span style={{ width: `${recipients.length ? (acked / recipients.length) * 100 : 0}%` }} />
                    </div>
                  </>
                )}
                <div className="stack" style={{ gap: 4 }}>
                  {recipients.map((r) => (
                    <div key={r.id} className="row" style={{ padding: '6px 0', borderBlockEnd: '1px solid var(--line-soft)' }}>
                      <Avatar name={r.full_name} size={26} />
                      <span>{r.full_name}</span>
                      <span className="row-end">
                        {r.acknowledged_at ? <Tag tone="ok">אישר/ה</Tag>
                          : r.read_at ? <Tag>קרא/ה</Tag>
                          : <Tag tone="warn">לא נקרא</Tag>}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            {!update.isAuthor && update.requires_ack && !update.mine?.acknowledged_at && (
              <Notice tone="warn" icon="ℹ" >
                <span className="small">השולח ביקש לאשר שקראת את ההודעה ואת הקבצים המצורפים.</span>
              </Notice>
            )}
          </>
        )}
      </StateView>
    </Modal>
  );
}
