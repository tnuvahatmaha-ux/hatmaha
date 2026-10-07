import { useState } from 'react';
import { useApi } from '../../lib/useApi.js';
import { download } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Empty, Modal } from '../../components/ui/index.jsx';
import { fmtDateTime, today, addDays, ROLE_NAMES } from '../../lib/format.js';

const ACTION_LABELS = {
  create: 'יצירה', update: 'עדכון', delete: 'מחיקה', hard_delete: 'מחיקה מלאה',
  submit: 'הגשה', approve: 'אישור', reject: 'דחייה', publish: 'פרסום',
  denied: 'סירוב הרשאה', rule_blocked: 'נחסם ע״י חוק', exception_created: 'נוצרה חריגה',
  export: 'ייצוא',
};

/** יומן הביקורת — append-only, ובלתי ניתן לעריכה למשתמשי קצה (§14). */
export default function AuditTab() {
  const toast = useToast();
  const [filters, setFilters] = useState({
    entityType: '', action: '', q: '',
    from: addDays(today(), -30), to: today(),
    limit: 200,
  });
  const [inspecting, setInspecting] = useState(null);

  const audit = useApi('/api/audit', filters);

  return (
    <>
      <Notice icon="🔒">
        <span className="small">
          היומן נכתב אוטומטית בכל שינוי, והוא append-only: אי אפשר לערוך או למחוק
          ממנו שורות — גם לא ישירות במסד. סירובי הרשאה נרשמים גם הם.
        </span>
      </Notice>

      <Panel
        title="יומן ביקורת"
        actions={
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => download('/api/audit/export.csv', filters, 'יומן-ביקורת.csv').catch(toast.error)}
          >
            ייצוא CSV
          </button>
        }
      >
        <div className="row">
          <input
            type="text"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="חיפוש חופשי"
            aria-label="חיפוש ביומן"
            style={{ maxWidth: 220 }}
          />
          <select
            value={filters.entityType}
            onChange={(e) => setFilters({ ...filters, entityType: e.target.value })}
            aria-label="ישות"
            style={{ width: 'auto' }}
          >
            <option value="">כל הישויות</option>
            {(audit.data?.entityTypes ?? []).map((type) => (
              <option key={type} value={type}>{type}</option>
            ))}
          </select>
          <select
            value={filters.action}
            onChange={(e) => setFilters({ ...filters, action: e.target.value })}
            aria-label="פעולה"
            style={{ width: 'auto' }}
          >
            <option value="">כל הפעולות</option>
            {Object.entries(ACTION_LABELS).map(([value, label]) => (
              <option key={value} value={value}>{label}</option>
            ))}
          </select>
          <label className="small">
            מ־{' '}
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} style={{ width: 'auto' }} />
          </label>
          <label className="small">
            עד{' '}
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} style={{ width: 'auto' }} />
          </label>
        </div>
      </Panel>

      <Panel title={`${(audit.data?.entries ?? []).length} רשומות`} flush>
        <StateView
          loading={audit.loading}
          error={audit.error}
          onRetry={audit.reload}
          empty={!audit.loading && (audit.data?.entries ?? []).length === 0}
          emptyProps={{ icon: '📜', title: 'אין רשומות בסינון הנוכחי' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr><th>מועד</th><th>מבצע</th><th>ישות</th><th>פעולה</th><th>נימוק</th><th /></tr>
              </thead>
              <tbody>
                {(audit.data?.entries ?? []).map((entry) => (
                  <tr key={entry.id}>
                    <td data-label="מועד" className="tnum small">{fmtDateTime(entry.occurred_at)}</td>
                    <td data-label="מבצע">
                      {entry.actor_name ?? 'מערכת'}
                      {entry.actor_role && <div className="tiny muted">{ROLE_NAMES[entry.actor_role]}</div>}
                    </td>
                    <td data-label="ישות" className="small">{entry.entity_type}</td>
                    <td data-label="פעולה">
                      <Tag tone={entry.action === 'denied' ? 'danger' : entry.action === 'delete' ? 'warn' : ''}>
                        {ACTION_LABELS[entry.action] ?? entry.action}
                      </Tag>
                    </td>
                    <td data-label="נימוק" className="small">{entry.reason ?? '—'}</td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => setInspecting(entry)}>
                        פירוט
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {inspecting && (
        <Modal title="פירוט רשומת ביקורת" onClose={() => setInspecting(null)} width={680}>
          <dl className="grid grid-2" style={{ marginBlockEnd: 'var(--space-3)' }}>
            <div><dt className="field-label">מועד</dt><dd style={{ margin: 0 }}>{fmtDateTime(inspecting.occurred_at)}</dd></div>
            <div><dt className="field-label">מבצע</dt><dd style={{ margin: 0 }}>{inspecting.actor_name ?? 'מערכת'}</dd></div>
            <div><dt className="field-label">ישות</dt><dd style={{ margin: 0 }}>{inspecting.entity_type}</dd></div>
            <div><dt className="field-label">מזהה</dt><dd style={{ margin: 0 }} className="tiny">{inspecting.entity_id ?? '—'}</dd></div>
            <div><dt className="field-label">מזהה מעקב</dt><dd style={{ margin: 0 }} className="tiny">{inspecting.trace_id ?? '—'}</dd></div>
          </dl>

          {inspecting.before_data && (
            <>
              <div className="field-label">לפני</div>
              <pre className="tiny" style={{ background: 'var(--surface-2)', padding: 'var(--space-2)', overflow: 'auto', maxHeight: 200, direction: 'ltr', textAlign: 'left' }}>
                {JSON.stringify(inspecting.before_data, null, 2)}
              </pre>
            </>
          )}

          {inspecting.after_data && (
            <>
              <div className="field-label">אחרי</div>
              <pre className="tiny" style={{ background: 'var(--surface-2)', padding: 'var(--space-2)', overflow: 'auto', maxHeight: 200, direction: 'ltr', textAlign: 'left' }}>
                {JSON.stringify(inspecting.after_data, null, 2)}
              </pre>
            </>
          )}
        </Modal>
      )}
    </>
  );
}
