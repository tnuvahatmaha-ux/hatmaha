import { useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post, put } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { usePermissions } from '../../context/PermissionsContext.jsx';
import { Panel, StateView, Tag, Empty } from '../../components/ui/index.jsx';

/**
 * קטלוגים: סוגי פעילות, סוגי אילוץ, סטטוסי הכשרה ורמות הסמכה.
 * הוספת ערך היא שורה במסד, לא deploy — זה מה ש-§3.1 מבטיח.
 */
const CATALOGS = [
  { kind: 'activityTypes', label: 'סוגי פעילות', hint: 'הדרכה, תצפית, תרגול' },
  { kind: 'constraintTypes', label: 'סוגי בקשות ואילוצים', hint: 'חופשה, מחלה, אילוץ שעות' },
  { kind: 'trainingStatuses', label: 'סטטוסי הכשרה', hint: 'בקליטה, בהכשרה, מוכן ל-Go Live' },
  { kind: 'qualificationLevels', label: 'רמות הסמכה', hint: 'מתלמד, מוסמך, מומחה' },
];

export default function CatalogsTab() {
  return (
    <>
      <ApprovalRulesPanel />
      {CATALOGS.map((catalog) => (
        <CatalogPanel key={catalog.kind} {...catalog} />
      ))}
    </>
  );
}

function CatalogPanel({ kind, label, hint }) {
  const toast = useToast();
  const items = useApi(`/api/settings/lookups/${kind}`, { includeInactive: true });
  const [name, setName] = useState('');

  const add = useAction(
    async () => {
      if (!name.trim()) return;
      await post(`/api/settings/lookups/${kind}`, { nameHe: name.trim() });
      setName('');
      items.reload();
      toast.success('הפריט נוסף');
    },
    { onError: (err) => toast.error(err) },
  );

  const toggle = useAction(
    async (item) => {
      await post(
        `/api/settings/lookups/${kind}`,
        { id: item.id, nameHe: item.name_he, isActive: !item.is_active },
        { ifMatch: item.row_version },
      );
      items.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel title={label} subtitle={hint}>
      <form className="row" onSubmit={(e) => { e.preventDefault(); add.run(); }} style={{ marginBlockEnd: 'var(--space-3)' }}>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={`${label} — ערך חדש`}
          aria-label={`ערך חדש ב${label}`}
          style={{ maxWidth: 260 }}
        />
        <button type="submit" className="btn btn-sm btn-primary" disabled={add.busy || !name.trim()}>
          הוספה
        </button>
      </form>

      <StateView
        loading={items.loading}
        error={items.error}
        onRetry={items.reload}
        empty={!items.loading && (items.data?.items ?? []).length === 0}
        emptyProps={{ icon: '📋', title: 'הקטלוג ריק' }}
      >
        <div className="row" style={{ gap: 6 }}>
          {(items.data?.items ?? []).map((item) => (
            <button
              key={item.id}
              type="button"
              className={`tag${item.is_active ? '' : ' tag-warn'}`}
              onClick={() => toggle.run(item)}
              disabled={toggle.busy}
              title={item.is_active ? 'לחיצה משביתה' : 'לחיצה מפעילה'}
              style={{ cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 700 }}
            >
              {item.name_he}
              {!item.is_active && ' (מושבת)'}
            </button>
          ))}
        </div>
        <p className="tiny muted mt-3">
          פריט שהיה בשימוש אינו נמחק — הוא מושבת, כדי שנתונים היסטוריים יישארו מוסברים.
        </p>
      </StateView>
    </Panel>
  );
}

/**
 * כללי אישור אילוצים — אחד לכל סוג בקשה, וחל על כל האתרים.
 * "אוטומטי" מאשר את הבקשה מיד בהגשה; "דורש אישור" מעביר אותה לתור.
 * חוקי מנוע החוקיות (למשל הודעה מוקדמת) עדיין חלים בשני המצבים.
 */
function ApprovalRulesPanel() {
  const toast = useToast();
  const { can } = usePermissions();
  const rules = useApi('/api/settings/constraint-approval');
  const editable = can('settings', 'manage');

  const setMode = useAction(
    async (rule, approvalMode) => {
      if (rule.approval_mode === approvalMode) return;
      await put(`/api/settings/constraint-approval/${rule.id}`, { approvalMode });
      rules.reload();
      toast.success(
        approvalMode === 'auto'
          ? `${rule.name_he}: בקשות יאושרו אוטומטית בכל האתרים`
          : `${rule.name_he}: בקשות יועברו לאישור בכל האתרים`,
      );
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      title="כללי אישור אילוצים"
      subtitle="לכל סוג בקשה — אישור אוטומטי בהגשה, או העברה להחלטת מנהל. הכלל חל על כל האתרים."
      flush
    >
      <StateView
        loading={rules.loading}
        error={rules.error}
        onRetry={rules.reload}
        empty={!rules.loading && (rules.data?.rules ?? []).length === 0}
        emptyProps={{ icon: '📋', title: 'לא הוגדרו סוגי בקשות' }}
      >
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>סוג הבקשה</th><th>כלל אישור</th></tr>
            </thead>
            <tbody>
              {(rules.data?.rules ?? []).map((rule) => (
                <tr key={rule.id}>
                  <td data-label="סוג הבקשה" className="bold">
                    {rule.name_he}
                    {!rule.is_active && <Tag> מושבת</Tag>}
                  </td>
                  <td data-label="כלל אישור">
                    <div className="row" style={{ gap: 0 }} role="group" aria-label={`כלל האישור של ${rule.name_he}`}>
                      {[
                        { value: 'auto', label: 'אישור אוטומטי' },
                        { value: 'manager', label: 'דורש אישור' },
                      ].map((option) => (
                        <button
                          key={option.value}
                          type="button"
                          className={`btn btn-sm${rule.approval_mode === option.value ? ' btn-primary' : ''}`}
                          onClick={() => setMode.run(rule, option.value)}
                          disabled={!editable || setMode.busy}
                          aria-pressed={rule.approval_mode === option.value}
                          style={{ marginInlineStart: -2 }}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="tiny muted" style={{ padding: 'var(--space-3) var(--space-4)' }}>
          גם בבקשה שמאושרת אוטומטית, חוקי החוקיות (כמו הודעה מוקדמת) נבדקים קודם — וחריגה מהם עוברת לאישור.
        </p>
      </StateView>
    </Panel>
  );
}
