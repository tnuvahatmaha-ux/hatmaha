import { useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Field, Empty } from '../../components/ui/index.jsx';

/** תחומים ותתי-קטגוריות — שתי רמות בדיוק, כמו בסכמה. */
export default function DomainsTab() {
  const toast = useToast();
  const [includeInactive, setIncludeInactive] = useState(true);
  const domains = useApi('/api/settings/domains', { includeInactive });

  const [newDomain, setNewDomain] = useState('');
  const [newSub, setNewSub] = useState({});

  const addDomain = useAction(
    async () => {
      if (!newDomain.trim()) return;
      await post('/api/settings/domains', { name: newDomain.trim() });
      setNewDomain('');
      domains.reload();
      toast.success('התחום נוסף');
    },
    { onError: (err) => toast.error(err) },
  );

  const addSub = useAction(
    async (domainId) => {
      const name = (newSub[domainId] ?? '').trim();
      if (!name) return;
      await post('/api/settings/sub-categories', { domainId, name });
      setNewSub((s) => ({ ...s, [domainId]: '' }));
      domains.reload();
      toast.success('תת-הקטגוריה נוספה');
    },
    { onError: (err) => toast.error(err) },
  );

  const toggle = useAction(
    async (kind, item) => {
      const path = kind === 'domain' ? '/api/settings/domains' : '/api/settings/sub-categories';
      await post(path, {
        id: item.id,
        name: item.name,
        domainId: item.domain_id,
        isActive: !item.is_active,
      }, { ifMatch: item.row_version });
      domains.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      title="תחומים מקצועיים"
      subtitle="תחום הוא הרמה העליונה; תת-קטגוריה היא התמחות בתוכו"
      actions={
        <label className="check">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          הצגת מושבתים
        </label>
      }
    >
      <form
        className="row"
        onSubmit={(e) => { e.preventDefault(); addDomain.run(); }}
        style={{ marginBlockEnd: 'var(--space-4)' }}
      >
        <input
          type="text"
          value={newDomain}
          onChange={(e) => setNewDomain(e.target.value)}
          placeholder="תחום חדש — למשל: מערכות קליניות"
          aria-label="שם התחום החדש"
          style={{ maxWidth: 280 }}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={addDomain.busy || !newDomain.trim()}>
          הוספת תחום
        </button>
      </form>

      <StateView
        loading={domains.loading}
        error={domains.error}
        onRetry={domains.reload}
        empty={!domains.loading && (domains.data?.domains ?? []).length === 0}
        emptyProps={{ icon: '🗂️', title: 'עדיין לא הוגדרו תחומים' }}
      >
        <div className="stack">
          {(domains.data?.domains ?? []).map((domain) => (
            <div key={domain.id} style={{ border: '2px solid var(--ink)', background: 'var(--surface)' }}>
              <div className="panel-head">
                <div className="row">
                  <span className="bold">{domain.name}</span>
                  {!domain.is_active && <Tag>מושבת</Tag>}
                  <Tag>{domain.subCategories.length} תתי-קטגוריות</Tag>
                </div>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => toggle.run('domain', domain)}
                  disabled={toggle.busy}
                >
                  {domain.is_active ? 'השבתה' : 'הפעלה'}
                </button>
              </div>

              <div className="panel-body">
                <div className="row" style={{ marginBlockEnd: 'var(--space-3)', gap: 6 }}>
                  {domain.subCategories.length === 0 ? (
                    <span className="small muted">אין תתי-קטגוריות</span>
                  ) : (
                    domain.subCategories.map((sub) => (
                      <button
                        key={sub.id}
                        type="button"
                        className={`tag${sub.is_active ? '' : ' tag-warn'}`}
                        onClick={() => toggle.run('sub', sub)}
                        title={sub.is_active ? 'לחיצה משביתה' : 'לחיצה מפעילה'}
                        style={{ cursor: 'pointer', font: 'inherit', fontSize: 11, fontWeight: 700 }}
                      >
                        {sub.name}
                        {!sub.is_active && ' (מושבת)'}
                      </button>
                    ))
                  )}
                </div>

                <form className="row" onSubmit={(e) => { e.preventDefault(); addSub.run(domain.id); }}>
                  <input
                    type="text"
                    value={newSub[domain.id] ?? ''}
                    onChange={(e) => setNewSub({ ...newSub, [domain.id]: e.target.value })}
                    placeholder={`תת-קטגוריה ב${domain.name}`}
                    aria-label={`תת-קטגוריה חדשה ב${domain.name}`}
                    style={{ maxWidth: 240 }}
                  />
                  <button type="submit" className="btn btn-sm" disabled={addSub.busy}>
                    הוספה
                  </button>
                </form>
              </div>
            </div>
          ))}
        </div>
      </StateView>
    </Panel>
  );
}
