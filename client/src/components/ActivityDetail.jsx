import { useApi } from '../lib/useApi.js';
import { Modal, StateView, Tag, Notice } from './ui/index.jsx';
import { fmtDate, fmtTime, dayName, STATUS_NAMES } from '../lib/format.js';

/**
 * פירוט פעילות מהלו״ז האישי: מה, איפה ומתי, מי מעביר, מי המלווים,
 * ומי עוד משובץ יחד איתי.
 */
export function ActivityDetailDialog({ activityId, onClose }) {
  const detail = useApi(`/api/schedule/me/activity/${activityId}`);
  const a = detail.data?.activity;
  const team = detail.data?.team ?? [];
  const mentors = detail.data?.mentors ?? [];
  const materials = detail.data?.materials ?? [];

  return (
    <Modal title={a ? (a.title || a.type_name) : 'פעילות'} onClose={onClose}
      footer={<button type="button" className="btn btn-ghost" onClick={onClose}>סגירה</button>}>
      <StateView loading={detail.loading} error={detail.error} onRetry={detail.reload}>
        {a && (
          <>
            <dl className="grid grid-2" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <Item label="מתי" value={`${dayName(a.activity_date)} ${fmtDate(a.activity_date)} · ${fmtTime(a.starts_at)}–${fmtTime(a.ends_at)}`} />
              <Item label="איפה" value={[a.site_name, a.location_name].filter(Boolean).join(' · ') || '—'} />
              <Item label="סוג" value={a.type_name} />
              <Item label="תחום" value={[a.domain_name, a.sub_category_name].filter(Boolean).join(' · ') || '—'} />
              <Item label="מעביר/ה" value={a.owner_name ? `${a.owner_name}${a.owner_phone ? ` · ${a.owner_phone}` : ''}` : '—'} />
              <Item label="סטטוס" value={STATUS_NAMES[a.status] ?? a.status} />
            </dl>

            {a.description && <Notice icon="📝"><span className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.description}</span></Notice>}

            <div className="bold small" style={{ marginBlock: 'var(--space-3) 6px' }}>מלווים</div>
            {mentors.length === 0
              ? <div className="small muted">—</div>
              : (
                <div className="row" style={{ gap: 6 }}>
                  {mentors.map((m) => <Tag key={m.id} tone="accent">{m.full_name} · {m.role}</Tag>)}
                </div>
              )}

            <div className="bold small" style={{ marginBlock: 'var(--space-4) 6px' }}>
              משובצים בפעילות ({team.length})
            </div>
            {team.length === 0
              ? <div className="small muted">אין משובצים</div>
              : (
                <div className="row" style={{ gap: 6 }}>
                  {team.map((p) => <Tag key={p.id}>{p.full_name}</Tag>)}
                </div>
              )}

            {materials.length > 0 && (
              <>
                <div className="bold small" style={{ marginBlock: 'var(--space-4) 6px' }}>חומרים</div>
                <ul className="small" style={{ margin: 0, paddingInlineStart: 18 }}>
                  {materials.map((m) => (
                    <li key={m.id}>{m.url ? <a href={m.url} target="_blank" rel="noreferrer">{m.title}</a> : m.title}{m.note ? ` — ${m.note}` : ''}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </StateView>
    </Modal>
  );
}

const Item = ({ label, value }) => (
  <div>
    <dt className="tiny muted">{label}</dt>
    <dd style={{ margin: 0 }} className="bold small">{value}</dd>
  </div>
);
