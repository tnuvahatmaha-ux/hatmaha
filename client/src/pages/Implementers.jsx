import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post, patch, put, newIdempotencyKey } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { ViewHead, Avatar } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, ChipPicker, Empty,
} from '../components/ui/index.jsx';
import { fmtDateFull, ROLE_NAMES, STATUS_NAMES, statusTone } from '../lib/format.js';

/** ניהול המטמיעים, ואשף הקליטה של §5.1. */
export default function Implementers() {
  const toast = useToast();
  const [filters, setFilters] = useState({ q: '', siteId: '', domainId: '', status: 'active' });
  const [onboarding, setOnboarding] = useState(false);
  const [selected, setSelected] = useState(null);

  const users = useApi('/api/users', { ...filters, limit: 300 });
  const sites = useApi('/api/sites');
  const domains = useApi('/api/settings/domains');
  const unassigned = useApi('/api/settings/mentors/unassigned-implementers');

  const people = (users.data?.users ?? []).filter((u) => ['implementer', 'lead'].includes(u.base_role));

  return (
    <>
      <ViewHead
        title="מטמיעים"
        subtitle="קליטה, שיוך מקצועי, שיוך לאתר ולמדריך"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setOnboarding(true)}>
            + קליטת מטמיע
          </button>
        }
      />

      {(unassigned.data?.implementers ?? []).length > 0 && (
        <Notice tone="warn" icon="⚠" title={`${unassigned.data.implementers.length} מטמיעים ללא שיוך מלא`}>
          <span className="small">
            בלי אתר, תחום ומדריך ראשי אי אפשר לשבץ אותם ואי אפשר שיגישו זמינות.
          </span>
        </Notice>
      )}

      <Panel title="סינון" flush>
        <div className="panel-body row">
          <input
            type="text"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="חיפוש לפי שם, דוא״ל או טלפון"
            aria-label="חיפוש"
            style={{ maxWidth: 260 }}
          />
          <select
            value={filters.siteId}
            onChange={(e) => setFilters({ ...filters, siteId: e.target.value })}
            aria-label="סינון לפי אתר"
            style={{ width: 'auto' }}
          >
            <option value="">כל האתרים</option>
            {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select
            value={filters.domainId}
            onChange={(e) => setFilters({ ...filters, domainId: e.target.value })}
            aria-label="סינון לפי תחום"
            style={{ width: 'auto' }}
          >
            <option value="">כל התחומים</option>
            {(domains.data?.domains ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <select
            value={filters.status}
            onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            aria-label="סינון לפי סטטוס"
            style={{ width: 'auto' }}
          >
            <option value="">כל הסטטוסים</option>
            <option value="active">פעילים</option>
            <option value="invited">הוזמנו</option>
            <option value="suspended">מושבתים</option>
          </select>
        </div>
      </Panel>

      <Panel title={`${people.length} מטמיעים`} flush>
        <StateView
          loading={users.loading}
          error={users.error}
          onRetry={users.reload}
          empty={!users.loading && people.length === 0}
          emptyProps={{ icon: '🧑‍💻', title: 'לא נמצאו מטמיעים', text: 'אפשר לקלוט מטמיע חדש דרך אשף הקליטה.' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>שם</th>
                  <th>תפקיד</th>
                  <th>אתר</th>
                  <th>תחום</th>
                  <th>מדריך ראשי</th>
                  <th>סטטוס</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {people.map((person) => {
                  const primaryMentor = person.mentors.find((m) => m.isPrimary);
                  const missing = !person.sites.length || !person.domains.length || !primaryMentor;

                  return (
                    <tr key={person.id} style={missing ? { background: 'var(--warn-bg)' } : undefined}>
                      <td data-label="שם" className="bold">{person.full_name}</td>
                      <td data-label="תפקיד">{ROLE_NAMES[person.base_role]}</td>
                      <td data-label="אתר">{person.sites.map((s) => s.name).join(', ') || <Missing />}</td>
                      <td data-label="תחום">{person.domains.map((d) => d.name).join(', ') || <Missing />}</td>
                      <td data-label="מדריך ראשי">{primaryMentor?.name ?? <Missing />}</td>
                      <td data-label="סטטוס">
                        <Tag tone={statusTone(person.status)}>{STATUS_NAMES[person.status]}</Tag>
                      </td>
                      <td>
                        <button type="button" className="btn btn-sm" onClick={() => setSelected(person)}>
                          פתיחה
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {onboarding && (
        <OnboardingWizard
          onClose={() => setOnboarding(false)}
          onDone={() => {
            setOnboarding(false);
            users.reload();
            unassigned.reload();
            toast.success('ההזמנה נשלחה — הפרופיל ייווצר ברגע שהמוזמן יירשם');
          }}
        />
      )}

      {selected && (
        <PersonDialog
          person={selected}
          onClose={() => setSelected(null)}
          onChanged={() => { users.reload(); unassigned.reload(); }}
        />
      )}
    </>
  );
}

const Missing = () => <Tag tone="warn">חסר</Tag>;

/* ==========================================================================
   אשף הקליטה — §5.1
   ========================================================================== */

const STEPS = ['פרטים אישיים', 'שיוך מקצועי', 'אתר ומדריך', 'סיכום'];

function OnboardingWizard({ onClose, onDone }) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);

  const sites = useApi('/api/sites');
  const domains = useApi('/api/settings/domains');
  const mentors = useApi('/api/settings/mentors', { status: 'active' });

  const [form, setForm] = useState({
    fullName: '', email: '', phone: '',
    baseRole: 'implementer',
    domainIds: [], subCategoryIds: [],
    siteId: '', mentorUserId: '',
  });

  const subCategories = useMemo(
    () =>
      (domains.data?.domains ?? [])
        .filter((d) => form.domainIds.includes(d.id))
        .flatMap((d) => d.subCategories.map((sc) => ({ ...sc, domainName: d.name }))),
    [domains.data, form.domainIds],
  );

  /** רק מדריכים שתחום האחריות שלהם מכסה את האתר והתחום שנבחרו (§9) */
  const eligibleMentors = useMemo(() => {
    if (!form.siteId || form.domainIds.length === 0) return [];
    return (mentors.data?.mentors ?? []).filter((mentor) =>
      (mentor.responsibilities ?? []).some(
        (r) =>
          (!r.siteId || r.siteId === form.siteId) &&
          (!r.domainId || form.domainIds.includes(r.domainId)) &&
          (!r.subCategoryId || form.subCategoryIds.includes(r.subCategoryId)),
      ),
    );
  }, [mentors.data, form.siteId, form.domainIds, form.subCategoryIds]);

  const validate = () => {
    if (step === 0) {
      if (!form.fullName.trim()) return 'יש להזין שם מלא';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) return 'כתובת הדוא״ל אינה תקינה';
    }
    if (step === 1 && form.domainIds.length === 0) return 'יש לבחור לפחות תחום אחד';
    if (step === 2 && !form.siteId) return 'יש לבחור אתר';
    return null;
  };

  const next = () => {
    const problem = validate();
    setError(problem);
    if (!problem) setStep((s) => s + 1);
  };

  const submit = useAction(
    async () => {
      await post(
        '/api/users/invites',
        {
          ...form,
          phone: form.phone || null,
          siteId: form.siteId || null,
          mentorUserId: form.mentorUserId || null,
        },
        { idempotencyKey: newIdempotencyKey() },
      );
      onDone();
    },
    { onError: (err) => { setError(err.message); toast.error(err); } },
  );

  const toggle = (key, value) =>
    setForm((f) => ({
      ...f,
      [key]: f[key].includes(value) ? f[key].filter((v) => v !== value) : [...f[key], value],
    }));

  return (
    <Modal
      title={`קליטת מטמיע — ${STEPS[step]}`}
      onClose={onClose}
      width={640}
      footer={
        <>
          {step < STEPS.length - 1 ? (
            <button type="button" className="btn btn-primary" onClick={next}>המשך</button>
          ) : (
            <button type="button" className="btn btn-primary" onClick={() => submit.run()} disabled={submit.busy}>
              {submit.busy ? 'שולח…' : 'שליחת הזמנה'}
            </button>
          )}
          {step > 0 && (
            <button type="button" className="btn" onClick={() => { setStep((s) => s - 1); setError(null); }}>
              חזרה
            </button>
          )}
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <div className="row" style={{ marginBlockEnd: 'var(--space-4)', gap: 4 }}>
        {STEPS.map((label, index) => (
          <Tag key={label} tone={index === step ? 'accent' : index < step ? 'ok' : ''}>
            {index + 1}. {label}
          </Tag>
        ))}
      </div>

      {error && <Notice tone="danger" icon="⚠">{error}</Notice>}

      <StateView loading={domains.loading || sites.loading} error={domains.error ?? sites.error}>
        {step === 0 && (
          <>
            <Field label="שם מלא" required>
              {(props) => (
                <input {...props} type="text" value={form.fullName}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              )}
            </Field>
            <Field label="כתובת דוא״ל" required hint="אליה תישלח ההזמנה, ואיתה המוזמן יירשם">
              {(props) => (
                <input {...props} type="email" dir="ltr" value={form.email}
                  onChange={(e) => setForm({ ...form, email: e.target.value })} />
              )}
            </Field>
            <Field label="טלפון">
              {(props) => (
                <input {...props} type="tel" dir="ltr" value={form.phone}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              )}
            </Field>
            <Field label="תפקיד">
              {(props) => (
                <select {...props} value={form.baseRole}
                  onChange={(e) => setForm({ ...form, baseRole: e.target.value })}>
                  <option value="implementer">מטמיע</option>
                  <option value="lead">מטמיע מוביל</option>
                  <option value="mentor">מדריך</option>
                  <option value="manager">מנהל הטמעה</option>
                </select>
              )}
            </Field>
          </>
        )}

        {step === 1 && (
          <>
            <Field label="תחומים" required hint="ניתן לבחור יותר מאחד">
              <ChipPicker
                options={(domains.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))}
                selected={form.domainIds}
                onToggle={(id) => toggle('domainIds', id)}
                emptyText="לא הוגדרו תחומים. יש להגדיר אותם בהגדרות."
              />
            </Field>

            <Field label="תתי-קטגוריות" hint="מוצגות רק תתי-הקטגוריות של התחומים שנבחרו">
              <ChipPicker
                options={subCategories.map((sc) => ({ value: sc.id, label: `${sc.name} (${sc.domainName})` }))}
                selected={form.subCategoryIds}
                onToggle={(id) => toggle('subCategoryIds', id)}
                emptyText="בחר/י תחום כדי לראות תתי-קטגוריות"
              />
            </Field>
          </>
        )}

        {step === 2 && (
          <>
            <Field label="אתר" required>
              {(props) => (
                <select {...props} value={form.siteId}
                  onChange={(e) => setForm({ ...form, siteId: e.target.value, mentorUserId: '' })}>
                  <option value="">בחירת אתר</option>
                  {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              )}
            </Field>

            <Field
              label="מדריך ראשי"
              hint="מוצגים רק מדריכים שתחום האחריות שלהם מכסה את האתר והתחום שנבחרו"
            >
              {(props) => (
                <select {...props} value={form.mentorUserId}
                  onChange={(e) => setForm({ ...form, mentorUserId: e.target.value })}>
                  <option value="">ללא מדריך כרגע</option>
                  {eligibleMentors.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.full_name} ({m.implementer_count} מטמיעים)
                    </option>
                  ))}
                </select>
              )}
            </Field>

            {form.siteId && eligibleMentors.length === 0 && (
              <Notice tone="warn" icon="⚠" title="אין מדריך מתאים">
                אף מדריך אינו אחראי על השילוב הזה של אתר ותחום. אפשר להמשיך בלי מדריך
                ולשייך אחר כך, או להגדיר תחום אחריות בהגדרות ← ניהול מדריכים.
              </Notice>
            )}
          </>
        )}

        {step === 3 && (
          <>
            <Notice icon="📧" title="מה קורה עכשיו">
              <span className="small">
                נשמרת הזמנה עם התפקיד והשיוכים שבחרת. הפרופיל ייווצר אוטומטית
                ברגע שהמוזמן יירשם עם הכתובת הזו — כך שאף סיסמה לא עוברת דרכנו.
              </span>
            </Notice>

            <dl className="grid grid-2">
              <Summary label="שם" value={form.fullName} />
              <Summary label="דוא״ל" value={form.email} />
              <Summary label="טלפון" value={form.phone || '—'} />
              <Summary label="תפקיד" value={ROLE_NAMES[form.baseRole]} />
              <Summary
                label="תחומים"
                value={(domains.data?.domains ?? [])
                  .filter((d) => form.domainIds.includes(d.id))
                  .map((d) => d.name).join(', ') || '—'}
              />
              <Summary
                label="תתי-קטגוריות"
                value={subCategories
                  .filter((sc) => form.subCategoryIds.includes(sc.id))
                  .map((sc) => sc.name).join(', ') || '—'}
              />
              <Summary
                label="אתר"
                value={(sites.data?.sites ?? []).find((s) => s.id === form.siteId)?.name ?? '—'}
              />
              <Summary
                label="מדריך ראשי"
                value={eligibleMentors.find((m) => m.id === form.mentorUserId)?.full_name ?? '—'}
              />
            </dl>
          </>
        )}
      </StateView>
    </Modal>
  );
}

const Summary = ({ label, value }) => (
  <div>
    <dt className="field-label">{label}</dt>
    <dd style={{ margin: 0 }}>{value}</dd>
  </div>
);

/* ==========================================================================
   כרטיס אישי
   ========================================================================== */

function PersonDialog({ person, onClose, onChanged }) {
  const toast = useToast();
  const domains = useApi('/api/settings/domains');
  const sites = useApi('/api/sites');
  const mentors = useApi('/api/settings/mentors', { status: 'active' });
  const detail = useApi(`/api/users/${person.id}`);

  const current = detail.data?.user ?? person;

  const [domainIds, setDomainIds] = useState(person.domains.map((d) => d.id));
  const [subCategoryIds, setSubCategoryIds] = useState(person.sub_categories.map((sc) => sc.id));
  const [siteId, setSiteId] = useState(person.sites[0]?.id ?? '');
  const [mentorId, setMentorId] = useState('');
  const [validation, setValidation] = useState(null);

  const subCategories = useMemo(
    () =>
      (domains.data?.domains ?? [])
        .filter((d) => domainIds.includes(d.id))
        .flatMap((d) => d.subCategories.map((sc) => ({ ...sc, domainName: d.name }))),
    [domains.data, domainIds],
  );

  const saveAssignments = useAction(
    async () => {
      await put(`/api/users/${person.id}/domains`, { domainIds });
      await put(`/api/users/${person.id}/sub-categories`, { subCategoryIds });
      if (siteId) await post(`/api/users/${person.id}/site-assignment`, { siteId });
      toast.success('השיוכים נשמרו');
      detail.reload();
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const checkMentor = useAction(
    async () => {
      const result = await post('/api/settings/mentors/assignments/validate', {
        mentorUserId: mentorId,
        implementerUserId: person.id,
      });
      setValidation(result);
      return result;
    },
    { onError: (err) => toast.error(err) },
  );

  const assignMentor = useAction(
    async () => {
      await post(
        '/api/settings/mentors/assignments',
        { mentorUserId: mentorId, implementerUserId: person.id, isPrimary: true },
        { idempotencyKey: newIdempotencyKey() },
      );
      toast.success('המדריך שויך');
      setMentorId('');
      setValidation(null);
      detail.reload();
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const toggle = (list, setList, value) =>
    setList(list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

  return (
    <Modal title={person.full_name} onClose={onClose} width={680}>
      <div className="row" style={{ marginBlockEnd: 'var(--space-4)' }}>
        <Avatar name={person.full_name} size={48} />
        <div>
          <div className="bold">{person.full_name}</div>
          <div className="small muted">
            {ROLE_NAMES[person.base_role]} · {person.email}
            {person.phone && ` · ${person.phone}`}
          </div>
          {person.intake_date && (
            <div className="tiny muted">נקלט ב-{fmtDateFull(person.intake_date)}</div>
          )}
        </div>
        <Tag tone={statusTone(current.status)} >{STATUS_NAMES[current.status]}</Tag>
      </div>

      <StateView loading={domains.loading} error={domains.error}>
        <Field label="תחומים" required>
          <ChipPicker
            options={(domains.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }))}
            selected={domainIds}
            onToggle={(id) => toggle(domainIds, setDomainIds, id)}
          />
        </Field>

        <Field label="תתי-קטגוריות">
          <ChipPicker
            options={subCategories.map((sc) => ({ value: sc.id, label: sc.name }))}
            selected={subCategoryIds}
            onToggle={(id) => toggle(subCategoryIds, setSubCategoryIds, id)}
            emptyText="בחר/י תחום כדי לראות תתי-קטגוריות"
          />
        </Field>

        <Field label="אתר">
          {(props) => (
            <select {...props} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              <option value="">ללא אתר</option>
              {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </Field>

        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => saveAssignments.run()}
          disabled={saveAssignments.busy}
        >
          {saveAssignments.busy ? 'שומר…' : 'שמירת שיוכים'}
        </button>

        <div className="divider" />

        <h3 style={{ marginBlockEnd: 'var(--space-2)' }}>מדריכים</h3>

        {current.mentors?.length > 0 ? (
          <div className="row" style={{ marginBlockEnd: 'var(--space-3)' }}>
            {current.mentors.map((m) => (
              <Tag key={m.id} tone={m.isPrimary ? 'accent' : ''}>
                {m.name}{m.isPrimary && ' (ראשי)'}
              </Tag>
            ))}
          </div>
        ) : (
          <Notice tone="warn" icon="⚠">עדיין לא שויך מדריך.</Notice>
        )}

        <Field label="שיוך מדריך ראשי">
          {(props) => (
            <select
              {...props}
              value={mentorId}
              onChange={(e) => { setMentorId(e.target.value); setValidation(null); }}
            >
              <option value="">בחירת מדריך</option>
              {(mentors.data?.mentors ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.full_name} ({m.implementer_count} מטמיעים)
                </option>
              ))}
            </select>
          )}
        </Field>

        {validation && (
          <Notice
            tone={validation.valid ? 'ok' : 'danger'}
            icon={validation.valid ? '✓' : '⛔'}
            title={validation.valid ? 'השיוך תקין' : 'לא ניתן לשייך'}
          >
            {!validation.valid && (
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {validation.reasons.map((reason, i) => <li key={i}>{reason}</li>)}
              </ul>
            )}
          </Notice>
        )}

        <div className="row">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => checkMentor.run()}
            disabled={!mentorId || checkMentor.busy}
          >
            {checkMentor.busy ? 'בודק…' : 'בדיקת התאמה'}
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => assignMentor.run()}
            disabled={!mentorId || assignMentor.busy || validation?.valid === false}
          >
            {assignMentor.busy ? 'משייך…' : 'שיוך כמדריך ראשי'}
          </button>
        </div>
      </StateView>
    </Modal>
  );
}
