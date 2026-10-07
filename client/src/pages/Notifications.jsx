import { useApi, useAction } from '../lib/useApi.js';
import { post } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Empty } from '../components/ui/index.jsx';
import { fmtRelative, fmtDateTime } from '../lib/format.js';

export default function Notifications() {
  const toast = useToast();
  const list = useApi('/api/notifications', { limit: 100 });

  const markAll = useAction(
    async () => {
      await post('/api/notifications/read-all');
      list.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const markOne = useAction(
    async (id) => {
      await post(`/api/notifications/${id}/read`);
      list.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const notifications = list.data?.notifications ?? [];
  const unread = list.data?.unread ?? 0;

  return (
    <>
      <ViewHead
        title="התראות"
        subtitle={unread > 0 ? `${unread} התראות שלא נקראו` : 'הכול נקרא'}
        actions={
          unread > 0 && (
            <button type="button" className="btn btn-sm" onClick={() => markAll.run()} disabled={markAll.busy}>
              סימון הכול כנקרא
            </button>
          )
        }
      />

      <Panel flush>
        <StateView
          loading={list.loading}
          error={list.error}
          onRetry={list.reload}
          empty={!list.loading && notifications.length === 0}
          emptyProps={{ icon: '🔔', title: 'אין התראות', text: 'כאן יופיעו עדכוני סידור, החלטות בבקשות והודעות מהמדריך.' }}
        >
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {notifications.map((n) => (
              <li
                key={n.id}
                style={{
                  display: 'flex', gap: 'var(--space-3)', alignItems: 'flex-start',
                  padding: 'var(--space-3) var(--space-4)',
                  borderBlockEnd: '1px solid var(--line-soft)',
                  background: n.read_at ? undefined : 'var(--primary-ink)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="bold">{n.title}</span>
                    <Tag>{n.type_name}</Tag>
                    {!n.read_at && <Tag tone="accent">חדש</Tag>}
                  </div>
                  {n.body && <div className="small" style={{ marginBlockStart: 2 }}>{n.body}</div>}
                  <div className="tiny muted" title={fmtDateTime(n.created_at)}>
                    {fmtRelative(n.created_at)}
                  </div>
                </div>
                {!n.read_at && (
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => markOne.run(n.id)}
                    disabled={markOne.busy}
                  >
                    סימון כנקרא
                  </button>
                )}
              </li>
            ))}
          </ul>
        </StateView>
      </Panel>
    </>
  );
}
