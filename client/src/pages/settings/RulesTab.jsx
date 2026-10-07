import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post, patch, del } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Field, Modal, Segmented, Empty } from '../../components/ui/index.jsx';
import {
  today, SEVERITY_NAMES, SEVERITY_TONE, TRIGGER_NAMES, SCOPE_NAMES, TARGET_NAMES,
} from '../../lib/format.js';

/**
 * עורך החוקיות והסימולטור.
 *
 * טופס הפרמטרים נבנה מ-params_schema שמגיע מהשרת, ולכן הוספת סוג תנאי
 * חדש אינה דורשת שינוי במסך הזה.
 */
export default function RulesTab() {
  const [view, setView] = useState('rules');

  return (
    <>
      <Panel
        title="מנוע החוקיות"
        subtitle="חוקים שנבדקים בכל הגשה, שיבוץ ופרסום — וניתן לשנות אותם בלי פיתוח"
        actions={
          <Segmented
            label="תצוגה"
            value={view}
            onChange={setView}
            options={[
              { value: 'rules', label: 'חוקים' },
              { value: 'simulator', label: 'סימולטור' },
            ]}
          />
        }
      >
        <Notice icon="ℹ">
          <span className="small">
            <span className="bold">אזהרה</span> נשמרת ומוצגת · <span className="bold">דורש אישור</span> עוצר
            את הפעולה עד להחלטה · <span className="bold">חוסם</span> מונע אותה לגמרי ומציג את הסיבה.
          </span>
        </Notice>
      </Panel>

      {view === 'rules' ? <RulesList /> : <Simulator />}
    </>
  );
}

function RulesList() {
  const toast = useToast();
  const [filters, setFilters] = useState({ trigger: '', scopeType: '' });
  const [editing, setEditing] = useState(null);

  const rules = useApi('/api/rules', filters);

  const toggle = useAction(
    async (rule) => {
      await post(`/api/rules/${rule.id}/toggle`, { isActive: !rule.is_active });
      rules.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const remove = useAction(
    async (rule) => {
      await del(`/api/rules/${rule.id}`);
      toast.success('החוק הוסר');
      rules.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      <Panel
        title="חוקים"
        actions={
          <>
            <select value={filters.trigger} onChange={(e) => setFilters({ ...filters, trigger: e.target.value })} aria-label="אירוע" style={{ width: 'auto' }}>
              <option value="">כל האירועים</option>
              {Object.entries(TRIGGER_NAMES).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
              + חוק חדש
            </button>
          </>
        }
        flush
      >
        <StateView
          loading={rules.loading}
          error={rules.error}
          onRetry={rules.reload}
          empty={!rules.loading && (rules.data?.rules ?? []).length === 0}
          emptyProps={{ icon: '⚖️', title: 'אין חוקים בסינון הנוכחי' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>עדיפות</th>
                  <th>שם החוק</th>
                  <th>אירוע</th>
                  <th>חל על</th>
                  <th>רמה</th>
                  <th>חומרה</th>
                  <th>מצב</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(rules.data?.rules ?? []).map((rule) => (
                  <tr key={rule.id} style={rule.is_active ? undefined : { opacity: 0.55 }}>
                    <td data-label="עדיפות" className="tnum">{rule.priority}</td>
                    <td data-label="שם החוק" className="bold">
                      {rule.name}
                      <div className="tiny muted">{rule.condition_name}</div>
                    </td>
                    <td data-label="אירוע">{TRIGGER_NAMES[rule.trigger]}</td>
                    <td data-label="חל על">{TARGET_NAMES[rule.applies_to]}</td>
                    <td data-label="רמה">
                      {SCOPE_NAMES[rule.scope_type]}
                      {rule.scope_name && <div className="tiny muted">{rule.scope_name}</div>}
                    </td>
                    <td data-label="חומרה">
                      <Tag tone={SEVERITY_TONE[rule.severity]}>{SEVERITY_NAMES[rule.severity]}</Tag>
                    </td>
                    <td data-label="מצב">
                      {rule.is_active ? <Tag tone="ok">פעיל</Tag> : <Tag>מושבת</Tag>}
                    </td>
                    <td>
                      <div className="row" style={{ gap: 4 }}>
                        <button type="button" className="btn btn-sm" onClick={() => setEditing(rule)}>עריכה</button>
                        <button type="button" className="btn btn-sm" onClick={() => toggle.run(rule)} disabled={toggle.busy}>
                          {rule.is_active ? 'השבתה' : 'הפעלה'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {editing && (
        <RuleForm
          rule={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); rules.reload(); toast.success('החוק נשמר ונכנס לתוקף'); }}
        />
      )}
    </>
  );
}

function RuleForm({ rule, onClose, onSaved }) {
  const toast = useToast();
  const conditionTypes = useApi('/api/rules/condition-types');
  const sites = useApi('/api/sites');
  const domains = useApi('/api/settings/domains');
  const activityTypes = useApi('/api/settings/lookups/activityTypes');

  const [form, setForm] = useState({
    name: rule?.name ?? '',
    description: rule?.description ?? '',
    scopeType: rule?.scope_type ?? 'global',
    scopeId: rule?.scope_id ?? '',
    trigger: rule?.trigger ?? 'assign',
    appliesTo: rule?.applies_to ?? 'any',
    conditionTypeCode: rule?.condition_type_code ?? '',
    conditionParams: rule?.condition_params ?? {},
    severity: rule?.severity ?? 'warning',
    approverRole: rule?.approver_role ?? 'manager',
    priority: rule?.priority ?? 100,
    messageHe: rule?.message_he ?? '',
    isActive: rule?.is_active ?? true,
  });

  const types = conditionTypes.data?.conditionTypes ?? [];
  const selected = types.find((t) => t.code === form.conditionTypeCode);

  useEffect(() => {
    if (!form.conditionTypeCode && types.length) {
      setForm((f) => ({ ...f, conditionTypeCode: types[0].code }));
    }
  }, [types]);

  // סוג התנאי מגביל את האירועים שאפשר לבחור
  const allowedTriggers = selected?.allowed_triggers ?? Object.keys(TRIGGER_NAMES);
  useEffect(() => {
    if (selected && !allowedTriggers.includes(form.trigger)) {
      setForm((f) => ({ ...f, trigger: allowedTriggers[0] }));
    }
  }, [selected]);

  const save = useAction(
    async () => {
      const body = { ...form, scopeId: form.scopeType === 'global' ? null : form.scopeId || null };
      if (rule) await patch(`/api/rules/${rule.id}`, body, { ifMatch: rule.row_version });
      else await post('/api/rules', body);
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const scopeOptions = () => {
    switch (form.scopeType) {
      case 'site':
        return (sites.data?.sites ?? []).map((s) => ({ id: s.id, name: s.name }));
      case 'domain':
        return (domains.data?.domains ?? []).map((d) => ({ id: d.id, name: d.name }));
      case 'sub_category':
        return (domains.data?.domains ?? []).flatMap((d) =>
          d.subCategories.map((sc) => ({ id: sc.id, name: `${sc.name} (${d.name})` })),
        );
      default:
        return [];
    }
  };

  /** טופס הפרמטרים נבנה מהסכמה שמגיעה מהשרת */
  const renderParams = () => {
    const schema = selected?.params_schema;
    const properties = Object.entries(schema?.properties ?? {});
    if (properties.length === 0) {
      return <p className="small muted">לתנאי הזה אין פרמטרים.</p>;
    }

    return properties.map(([key, spec]) => {
      const required = (schema.required ?? []).includes(key);
      const value = form.conditionParams[key] ?? '';
      const setValue = (v) =>
        setForm((f) => ({ ...f, conditionParams: { ...f.conditionParams, [key]: v } }));

      if (spec.format === 'uuid') {
        const options =
          key === 'activityTypeId'
            ? (activityTypes.data?.items ?? []).map((t) => ({ id: t.id, name: t.name_he }))
            : (domains.data?.domains ?? []).flatMap((d) =>
                d.subCategories.map((sc) => ({ id: sc.id, name: `${sc.name} (${d.name})` })),
              );

        return (
          <Field key={key} label={spec.title ?? key} required={required}>
            {(props) => (
              <select {...props} value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">{required ? 'יש לבחור' : 'ללא'}</option>
                {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            )}
          </Field>
        );
      }

      if (spec.format === 'date') {
        return (
          <Field key={key} label={spec.title ?? key} required={required}>
            {(props) => (
              <input {...props} type="date" value={value} onChange={(e) => setValue(e.target.value)} />
            )}
          </Field>
        );
      }

      return (
        <Field key={key} label={spec.title ?? key} required={required}>
          {(props) => (
            <input
              {...props}
              type="number"
              min={spec.minimum}
              max={spec.maximum}
              value={value}
              onChange={(e) => setValue(e.target.value === '' ? '' : Number(e.target.value))}
            />
          )}
        </Field>
      );
    });
  };

  return (
    <Modal
      title={rule ? `עריכת חוק: ${rule.name}` : 'חוק חדש'}
      onClose={onClose}
      width={660}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <StateView loading={conditionTypes.loading} error={conditionTypes.error} onRetry={conditionTypes.reload}>
        <Field label="שם החוק" required error={save.fieldErrors.name}>
          {(props) => (
            <input {...props} type="text" value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
          )}
        </Field>

        <Field label="סוג התנאי" required>
          {(props) => (
            <select {...props} value={form.conditionTypeCode}
              onChange={(e) => setForm({ ...form, conditionTypeCode: e.target.value, conditionParams: {} })}>
              {types.map((t) => <option key={t.code} value={t.code}>{t.name_he}</option>)}
            </select>
          )}
        </Field>

        {selected?.description_he && (
          <p className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
            {selected.description_he}
          </p>
        )}

        <div style={{ border: '2px solid var(--line-soft)', padding: 'var(--space-3)', marginBlockEnd: 'var(--space-3)' }}>
          <div className="field-label">פרמטרים</div>
          {renderParams()}
        </div>

        <div className="grid grid-2">
          <Field label="מתי נבדק" required>
            {(props) => (
              <select {...props} value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
                {allowedTriggers.map((t) => (
                  <option key={t} value={t}>{TRIGGER_NAMES[t]}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="חל על">
            {(props) => (
              <select {...props} value={form.appliesTo} onChange={(e) => setForm({ ...form, appliesTo: e.target.value })}>
                {Object.entries(TARGET_NAMES).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            )}
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="רמת החוק">
            {(props) => (
              <select {...props} value={form.scopeType}
                onChange={(e) => setForm({ ...form, scopeType: e.target.value, scopeId: '' })}>
                <option value="global">מערכת</option>
                <option value="site">אתר</option>
                <option value="domain">תחום</option>
                <option value="sub_category">תת-קטגוריה</option>
              </select>
            )}
          </Field>

          {form.scopeType !== 'global' && (
            <Field label="ישות" required error={save.fieldErrors.scopeId}>
              {(props) => (
                <select {...props} value={form.scopeId} onChange={(e) => setForm({ ...form, scopeId: e.target.value })}>
                  <option value="">בחירה</option>
                  {scopeOptions().map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              )}
            </Field>
          )}
        </div>

        <div className="grid grid-2">
          <Field label="חומרה" required>
            {(props) => (
              <select {...props} value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
                <option value="warning">אזהרה — נשמר ומוצג</option>
                <option value="approval_required">דורש אישור — עוצר עד להחלטה</option>
                <option value="blocking">חוסם — מונע את הפעולה</option>
              </select>
            )}
          </Field>

          {form.severity === 'approval_required' && (
            <Field label="מי מאשר" required error={save.fieldErrors.approverRole}>
              {(props) => (
                <select {...props} value={form.approverRole}
                  onChange={(e) => setForm({ ...form, approverRole: e.target.value })}>
                  <option value="manager">מנהל הטמעה</option>
                  <option value="mentor">המדריך הראשי</option>
                  <option value="lead">מטמיע מוביל באתר</option>
                </select>
              )}
            </Field>
          )}
        </div>

        <Field label="עדיפות" hint="מספר נמוך נבדק קודם">
          {(props) => (
            <input {...props} type="number" min={0} max={9999} value={form.priority}
              onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
          )}
        </Field>

        <Field
          label="ההודעה שתוצג למשתמש"
          required
          error={save.fieldErrors.messageHe}
          hint="הפירוט הקונקרטי שהמנוע מחשב יתווסף אחריה אוטומטית"
        >
          {(props) => (
            <textarea {...props} value={form.messageHe}
              onChange={(e) => setForm({ ...form, messageHe: e.target.value })}
              placeholder="לא ניתן לשבץ — קיימת חפיפה" />
          )}
        </Field>

        <label className="check">
          <input type="checkbox" checked={form.isActive}
            onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
          החוק פעיל
        </label>
      </StateView>
    </Modal>
  );
}

/* ==========================================================================
   סימולטור — "מה היה קורה אם"
   ========================================================================== */

function Simulator() {
  const toast = useToast();
  const sites = useApi('/api/sites');
  const users = useApi('/api/users', { status: 'active', limit: 300 });

  const [form, setForm] = useState({
    trigger: 'assign',
    subjectType: 'roster',
    userId: '',
    siteId: '',
    date: today(),
    startTime: '06:00',
    endTime: '14:00',
  });
  const [result, setResult] = useState(null);

  const run = useAction(
    async () => setResult(await post('/api/rules/simulate', {
      ...form,
      userId: form.userId || null,
      siteId: form.siteId || null,
    })),
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      <Panel
        title="סימולטור חוקיות"
        subtitle="בדיקת תרחיש מול החוקים הפעילים — בלי לשמור דבר ובלי ליצור חריגה"
      >
        <div className="grid grid-2">
          <Field label="אירוע">
            {(props) => (
              <select {...props} value={form.trigger} onChange={(e) => setForm({ ...form, trigger: e.target.value })}>
                {Object.entries(TRIGGER_NAMES).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="נושא">
            {(props) => (
              <select {...props} value={form.subjectType} onChange={(e) => setForm({ ...form, subjectType: e.target.value })}>
                {Object.entries(TARGET_NAMES).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="מטמיע">
            {(props) => (
              <select {...props} value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                <option value="">ללא מטמיע מסוים</option>
                {(users.data?.users ?? []).map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="אתר">
            {(props) => (
              <select {...props} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
                <option value="">ללא אתר מסוים</option>
                {(sites.data?.sites ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="תאריך">
            {(props) => (
              <input {...props} type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            )}
          </Field>

          <div className="grid grid-2">
            <Field label="משעה">
              {(props) => (
                <input {...props} type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
              )}
            </Field>
            <Field label="עד שעה">
              {(props) => (
                <input {...props} type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
              )}
            </Field>
          </div>
        </div>

        <button type="button" className="btn btn-primary" onClick={() => run.run()} disabled={run.busy}>
          {run.busy ? 'מריץ…' : 'הרצת הסימולציה'}
        </button>
      </Panel>

      {result && (
        <Panel
          title="תוצאות"
          subtitle={`${result.evaluated} חוקים נבדקו`}
          actions={
            <Tag tone={{ pass: 'ok', warning: 'warn', approval_required: 'accent', blocked: 'danger' }[result.outcome]}>
              {{ pass: 'תקין', warning: 'אזהרות', approval_required: 'דורש אישור', blocked: 'חסום' }[result.outcome]}
            </Tag>
          }
          flush
        >
          {result.findings.length === 0 ? (
            <Empty icon="⚖️" title="אף חוק לא חל על התרחיש הזה" />
          ) : (
            <div className="table-wrap">
              <table className="table table-cards">
                <thead>
                  <tr><th>חוק</th><th>חומרה</th><th>תוצאה</th><th>פירוט</th></tr>
                </thead>
                <tbody>
                  {result.findings.map((f, i) => (
                    <tr key={i} style={f.passed ? undefined : { background: 'var(--warn-bg)' }}>
                      <td data-label="חוק" className="bold">{f.ruleName}</td>
                      <td data-label="חומרה">
                        <Tag tone={SEVERITY_TONE[f.severity]}>{SEVERITY_NAMES[f.severity]}</Tag>
                      </td>
                      <td data-label="תוצאה">
                        {f.passed ? <Tag tone="ok">עבר</Tag> : <Tag tone="danger">נכשל</Tag>}
                      </td>
                      <td data-label="פירוט" className="small">{f.detail ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
