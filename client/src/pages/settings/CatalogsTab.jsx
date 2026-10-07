import { useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
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
