import { useEffect, useRef, useState } from 'react';
import { Send, Plus, Users, ChevronRight } from 'lucide-react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { Avatar } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Field, Modal, Segmented, Empty } from '../components/ui/index.jsx';
import { fmtRelative, fmtTime } from '../lib/format.js';

const KIND_NAMES = { custom: 'קבוצה', domain: 'תחום', sub_category: 'תת-תחום', site: 'אתר' };
const POLL_MS = 5000;

/**
 * צ׳אט קבוצתי: רשימת קבוצות ושיחה. ההודעות מתרעננות כל 5 שניות —
 * בכל רענון רק מה שחדש מאז ההודעה האחרונה שכבר מוצגת.
 */
export function ChatGroups({ canCreate }) {
  const groups = useApi('/api/chat/groups');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const list = groups.data?.groups ?? [];

  // רשימת הקבוצות (ומוני ההודעות שלא נקראו) מתרעננת ברקע
  useEffect(() => {
    const t = setInterval(() => groups.reload(), 20_000);
    return () => clearInterval(t);
  }, [groups.reload]);

  const open = list.find((g) => g.id === openId);

  return (
    <div className="chat-layout" data-open={open ? 'true' : 'false'}>
      <Panel
        className="chat-list"
        title="קבוצות"
        actions={canCreate && (
          <button type="button" className="btn btn-sm" onClick={() => setCreating(true)}>
            <Plus size={15} /> קבוצה חדשה
          </button>
        )}
        flush
      >
        <StateView
          loading={groups.loading && !groups.data}
          error={groups.error}
          onRetry={groups.reload}
          empty={!groups.loading && list.length === 0}
          emptyProps={{
            icon: '💬',
            title: 'אין עדיין קבוצות',
            text: canCreate ? 'אפשר לפתוח קבוצה לפי תחום, תת-תחום, אתר, או לבחור משתתפים.' : 'כשהמדריך יפתח קבוצה, היא תופיע כאן.',
          }}
        >
          <div className="msg-list">
            {list.map((g) => (
              <button key={g.id} type="button" className={`msg-item${g.id === openId ? ' active' : ''}`}
                onClick={() => setOpenId(g.id)}>
                <span className="chat-avatar" aria-hidden="true"><Users size={18} /></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ flexWrap: 'nowrap' }}>
                    <span className="msg-title">{g.name}</span>
                    {g.last_at && <span className="small muted row-end nowrap">{fmtRelative(g.last_at)}</span>}
                  </div>
                  <div className="msg-preview">
                    {g.last_body ? `${g.last_author}: ${g.last_body}` : `${KIND_NAMES[g.kind]} · ${g.member_count} משתתפים`}
                  </div>
                </div>
                {g.unread > 0 && <span className="nav-badge" aria-label={`${g.unread} הודעות שלא נקראו`}>{g.unread}</span>}
              </button>
            ))}
          </div>
        </StateView>
      </Panel>

      <div className="chat-pane">
        {open ? (
          <Conversation key={open.id} group={open} onBack={() => setOpenId(null)} onRead={groups.reload} />
        ) : (
          <Panel><Empty icon="💬" title="בחר/י קבוצה" text="ההודעות בקבוצה יופיעו כאן." /></Panel>
        )}
      </div>

      {creating && (
        <CreateGroup
          onClose={() => setCreating(false)}
          onCreated={(g) => { setCreating(false); groups.reload(); setOpenId(g.id); }}
        />
      )}
    </div>
  );
}

function Conversation({ group, onBack, onRead }) {
  const toast = useToast();
  const { profile } = usePermissions();
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [text, setText] = useState('');
  const lastId = useRef(null);
  const bottom = useRef(null);

  // טעינה ראשונה ורענון תקופתי — רק הודעות חדשות
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const data = await get(`/api/chat/groups/${group.id}/messages`, lastId.current ? { after: lastId.current } : {});
        if (!active) return;
        if (data.messages.length) {
          lastId.current = data.messages[data.messages.length - 1].id;
          setMessages((m) => [...m, ...data.messages]);
          post(`/api/chat/groups/${group.id}/read`).then(onRead).catch(() => {});
        }
        setError(null);
      } catch (err) {
        if (active) setError(err);
      } finally {
        if (active) setLoading(false);
      }
    };
    load();
    const t = setInterval(load, POLL_MS);
    return () => { active = false; clearInterval(t); };
  }, [group.id]);

  useEffect(() => {
    bottom.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);

  const send = useAction(
    async () => {
      const body = text.trim();
      if (!body) return;
      const { message } = await post(`/api/chat/groups/${group.id}/messages`, { body });
      setText('');
      if (!lastId.current || message.id > lastId.current) {
        lastId.current = message.id;
        setMessages((m) => [...m, message]);
      }
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      className="chat-conversation"
      title={
        <span className="row" style={{ flexWrap: 'nowrap' }}>
          <button type="button" className="btn btn-icon chat-back" onClick={onBack} aria-label="חזרה לקבוצות">
            <ChevronRight size={18} />
          </button>
          {group.name}
        </span>
      }
      subtitle={`${KIND_NAMES[group.kind]} · ${group.member_count} משתתפים`}
      flush
    >
      <div className="chat-messages" role="log" aria-live="polite" aria-label={`הודעות בקבוצה ${group.name}`}>
        <StateView loading={loading} error={error && !messages.length ? error : null}
          empty={!loading && messages.length === 0}
          emptyProps={{ icon: '💬', title: 'אין עדיין הודעות', text: 'כתבו את ההודעה הראשונה.' }}>
          {messages.map((m, i) => {
            const mine = m.author_user_id === profile?.id;
            const sameAsPrev = messages[i - 1]?.author_user_id === m.author_user_id;
            return (
              <div key={m.id} className={`bubble-row${mine ? ' mine' : ''}`}>
                {!mine && !sameAsPrev && <Avatar name={m.author_name} size={26} />}
                {!mine && sameAsPrev && <span style={{ width: 26 }} />}
                <div className="bubble">
                  {!mine && !sameAsPrev && <div className="bubble-author">{m.author_name}</div>}
                  <div className="bubble-text">{m.body}</div>
                  <div className="bubble-time">{fmtTime(m.created_at)}</div>
                </div>
              </div>
            );
          })}
          <div ref={bottom} />
        </StateView>
      </div>

      <form className="chat-compose" onSubmit={(e) => { e.preventDefault(); send.run(); }}>
        <textarea
          value={text}
          rows={1}
          maxLength={4000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send.run(); }
          }}
          placeholder="הודעה"
          aria-label="כתיבת הודעה"
        />
        <button type="submit" className="btn btn-primary btn-icon" disabled={!text.trim() || send.busy} aria-label="שליחה">
          <Send size={17} />
        </button>
      </form>
    </Panel>
  );
}

function CreateGroup({ onClose, onCreated }) {
  const toast = useToast();
  const { role } = usePermissions();
  const domains = useApi('/api/settings/domains');
  const sites = useApi('/api/sites');
  const people = useApi('/api/updates/recipients');
  const [form, setForm] = useState({ name: '', kind: 'domain', targetId: '', memberIds: [] });

  const domainList = domains.data?.domains ?? [];
  const nameFor = (kind, id) =>
    kind === 'domain' ? domainList.find((d) => d.id === id)?.name
      : kind === 'sub_category' ? domainList.flatMap((d) => d.subCategories).find((s) => s.id === id)?.name
        : kind === 'site' ? (sites.data?.sites ?? []).find((s) => s.id === id)?.name : '';

  const create = useAction(
    async () => {
      const { group } = await post('/api/chat/groups', {
        name: form.name.trim() || `צוות ${nameFor(form.kind, form.targetId) ?? ''}`.trim(),
        kind: form.kind,
        domainId: form.kind === 'domain' ? form.targetId : null,
        subCategoryId: form.kind === 'sub_category' ? form.targetId : null,
        siteId: form.kind === 'site' ? form.targetId : null,
        memberIds: form.kind === 'custom' ? form.memberIds : [],
      });
      toast.success('הקבוצה נפתחה');
      onCreated(group);
    },
    { onError: (err) => toast.error(err) },
  );

  const ready = form.kind === 'custom' ? form.name.trim() && form.memberIds.length : form.targetId;

  return (
    <Modal
      title="קבוצה חדשה"
      onClose={onClose}
      width={560}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => create.run()} disabled={!ready || create.busy}>
            {create.busy ? 'פותח…' : 'פתיחת קבוצה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="מי בקבוצה" hint={form.kind === 'custom' ? undefined : 'החברים מתעדכנים לבד לפי השיוכים — מי שמצטרף לתחום מצטרף גם לקבוצה'}>
        {() => (
          <Segmented
            label="סוג הקבוצה"
            value={form.kind}
            onChange={(kind) => setForm({ ...form, kind, targetId: '' })}
            options={[
              { value: 'domain', label: 'תחום' },
              { value: 'sub_category', label: 'תת-תחום' },
              { value: 'site', label: 'אתר' },
              { value: 'custom', label: 'בחירת משתתפים' },
            ]}
          />
        )}
      </Field>

      {form.kind !== 'custom' ? (
        <Field label={{ domain: 'תחום', sub_category: 'תת-תחום', site: 'אתר' }[form.kind]} required>
          {(props) => (
            <select {...props} value={form.targetId} onChange={(e) => setForm({ ...form, targetId: e.target.value })}>
              <option value="">בחירה</option>
              {form.kind === 'domain' && domainList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              {form.kind === 'sub_category' && domainList.flatMap((d) => d.subCategories.map((sc) => (
                <option key={sc.id} value={sc.id}>{d.name} · {sc.name}</option>
              )))}
              {form.kind === 'site' && (sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </Field>
      ) : (
        <Field label="משתתפים" required hint={role === 'manager' ? undefined : 'מתוך המטמיעים שמשויכים אליך'}>
          {() => (
            <div className="row" style={{ gap: 6 }}>
              {(people.data?.recipients ?? []).map((p) => {
                const on = form.memberIds.includes(p.id);
                return (
                  <button key={p.id} type="button" className="chip" aria-pressed={on}
                    onClick={() => setForm({
                      ...form,
                      memberIds: on ? form.memberIds.filter((x) => x !== p.id) : [...form.memberIds, p.id],
                    })}>
                    {p.full_name}
                  </button>
                );
              })}
            </div>
          )}
        </Field>
      )}

      <Field label="שם הקבוצה" required={form.kind === 'custom'}>
        {(props) => (
          <input {...props} type="text" value={form.name} maxLength={120}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={form.kind === 'custom' ? 'למשל: צוות לילה' : `ברירת מחדל: צוות ${nameFor(form.kind, form.targetId) ?? '…'}`} />
        )}
      </Field>
    </Modal>
  );
}
