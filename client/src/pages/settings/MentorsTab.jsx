import { useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post, del, newIdempotencyKey } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Field, Modal, Accordion, Empty } from '../../components/ui/index.jsx';
import { fmtDateFull, today, STATUS_NAMES, statusTone } from '../../lib/format.js';

/**
 * ניהול מדריכים (AC-08 — כאן, ולא כמודול ניווט עצמאי).
 *
 * תחום אחריות הוא השער לשיוך: מדריך ניתן לשיוך רק במסגרת האתר, התחום
 * ותת-הקטגוריה שהוגדרו לו. §9: "מניעת שיוך לא תקין".
 */
export default function MentorsTab() {
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [addingTo, setAddingTo] = useState(null);

  const mentors = useApi('/api/settings/mentors', { q: search });
  const unassigned = useApi('/api/settings/mentors/unassigned-implementers');

  const removeResponsibility = useAction(
    async (id) => {
      await del(`/api/settings/mentors/responsibilities/${id}`);
      toast.success('תחום האחריות הסתיים');
      mentors.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      {(unassigned.data?.implementers ?? []).filter((i) => i.missing_mentor).length > 0 && (
        <Notice tone="warn" icon="⚠" title="מטמיעים ללא מדריך">
          <div className="row" style={{ gap: 6 }}>
            {unassigned.data.implementers
              .filter((i) => i.missing_mentor)
              .map((i) => <Tag key={i.user_id}>{i.full_name}</Tag>)}
          </div>
          <div className="small mt-3">שיוך מדריך נעשה מכרטיס המטמיע במסך "אנשים".</div>
        </Notice>
      )}

      <Panel
        title="מדריכים"
        subtitle="לכל מדריך תחומי אחריות, והם קובעים את מי מותר לשייך אליו"
        actions={
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם"
            aria-label="חיפוש מדריך"
            style={{ maxWidth: 200 }}
          />
        }
        flush
      >
        <StateView
          loading={mentors.loading}
          error={mentors.error}
          onRetry={mentors.reload}
          empty={!mentors.loading && (mentors.data?.mentors ?? []).length === 0}
          emptyProps={{
            icon: '🎓',
            title: 'עדיין אין מדריכים',
            text: 'כדי להגדיר מדריך: במסך "אנשים" פותחים את האדם ומשנים את התפקיד שלו ל"מדריך".',
          }}
        >
          {(mentors.data?.mentors ?? []).map((mentor) => (
            <Accordion
              key={mentor.id}
              title={mentor.full_name}
              meta={
                <>
                  <Tag tone={statusTone(mentor.status)}>{STATUS_NAMES[mentor.status]}</Tag>
                  <Tag>{mentor.implementer_count} מטמיעים</Tag>
                  <Tag tone={mentor.responsibilities.length ? '' : 'warn'}>
                    {mentor.responsibilities.length} תחומי אחריות
                  </Tag>
                </>
              }
              actions={
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setAddingTo(mentor)}>
                  + תחום אחריות
                </button>
              }
            >
              <div className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
                {mentor.email}{mentor.phone && ` · ${mentor.phone}`}
              </div>

              <div className="bold small" style={{ marginBlockEnd: 6 }}>
                המטמיעים של {mentor.full_name.split(' ')[0]} ({mentor.implementers?.length ?? 0})
              </div>
              {(mentor.implementers ?? []).length === 0 ? (
                <p className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>עדיין לא שויכו מטמיעים.</p>
              ) : (
                <div className="table-wrap" style={{ marginBlockEnd: 'var(--space-4)' }}>
                  <table className="table table-cards">
                    <thead><tr><th>שם</th><th>שיוך</th><th>אתר</th><th>תחום</th></tr></thead>
                    <tbody>
                      {mentor.implementers.map((i) => (
                        <tr key={i.id}>
                          <td data-label="שם" className="bold">{i.name}</td>
                          <td data-label="שיוך">{i.isPrimary ? <Tag tone="accent">מדריך ראשי</Tag> : <Tag>תומך</Tag>}</td>
                          <td data-label="אתר" className="small">{i.sites ?? '—'}</td>
                          <td data-label="תחום" className="small">{i.domains ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="bold small" style={{ marginBlockEnd: 6 }}>תחומי אחריות</div>

              {mentor.responsibilities.length === 0 ? (
                <Notice tone="warn" icon="⚠" title="אין תחומי אחריות">
                  בלי תחום אחריות אי אפשר לשייך למדריך הזה אף מטמיע.
                </Notice>
              ) : (
                <div className="table-wrap">
                  <table className="table table-cards">
                    <thead>
                      <tr><th>אתר</th><th>תחום</th><th>תת-קטגוריה</th><th>מתאריך</th><th /></tr>
                    </thead>
                    <tbody>
                      {mentor.responsibilities.map((r) => (
                        <tr key={r.id}>
                          <td data-label="אתר">{r.siteName ?? <Tag>כל האתרים</Tag>}</td>
                          <td data-label="תחום">{r.domainName ?? <Tag>כל התחומים</Tag>}</td>
                          <td data-label="תת-קטגוריה">{r.subCategoryName ?? <Tag>הכול</Tag>}</td>
                          <td data-label="מתאריך" className="tnum">{fmtDateFull(r.fromDate)}</td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => removeResponsibility.run(r.id)}
                              disabled={removeResponsibility.busy}
                            >
                              סיום
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Accordion>
          ))}
        </StateView>
      </Panel>

      {addingTo && (
        <ResponsibilityForm
          mentor={addingTo}
          onClose={() => setAddingTo(null)}
          onSaved={() => { setAddingTo(null); mentors.reload(); toast.success('תחום האחריות נוסף'); }}
        />
      )}
    </>
  );
}

export function ResponsibilityForm({ mentor, onClose, onSaved }) {
  const toast = useToast();
  const sites = useApi('/api/sites');
  const domains = useApi('/api/settings/domains');

  const [form, setForm] = useState({
    siteId: '', domainId: '', subCategoryId: '', fromDate: today(),
  });

  const subCategories =
    (domains.data?.domains ?? []).find((d) => d.id === form.domainId)?.subCategories ?? [];

  const save = useAction(
    async () => {
      await post(`/api/settings/mentors/${mentor.id}/responsibilities`, {
        siteId: form.siteId || null,
        domainId: form.domainId || null,
        subCategoryId: form.subCategoryId || null,
        fromDate: form.fromDate,
      });
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal
      title={`תחום אחריות ל${mentor.full_name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'הוספה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Notice icon="ℹ">
        <span className="small">
          שדה שנשאר ריק פירושו "הכול": אחריות ללא אתר חלה על כל האתרים.
          ככל שתגדיר/י צר יותר, כך פחות מטמיעים יהיו ניתנים לשיוך.
        </span>
      </Notice>

      <StateView loading={sites.loading || domains.loading} error={sites.error ?? domains.error}>
        <Field label="אתר">
          {(props) => (
            <select {...props} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
              <option value="">כל האתרים</option>
              {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </Field>

        <Field label="תחום">
          {(props) => (
            <select {...props} value={form.domainId}
              onChange={(e) => setForm({ ...form, domainId: e.target.value, subCategoryId: '' })}>
              <option value="">כל התחומים</option>
              {(domains.data?.domains ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
        </Field>

        <Field label="תת-קטגוריה" error={save.fieldErrors.domainId}>
          {(props) => (
            <select
              {...props}
              value={form.subCategoryId}
              onChange={(e) => setForm({ ...form, subCategoryId: e.target.value })}
              disabled={!form.domainId}
            >
              <option value="">כל תתי-הקטגוריות</option>
              {subCategories.map((sc) => <option key={sc.id} value={sc.id}>{sc.name}</option>)}
            </select>
          )}
        </Field>

        <Field label="מתאריך" required>
          {(props) => (
            <input {...props} type="date" value={form.fromDate}
              onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
          )}
        </Field>
      </StateView>
    </Modal>
  );
}
