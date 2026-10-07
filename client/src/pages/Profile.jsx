import { useEffect, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { patch, get, put } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead, Avatar } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Field, Notice } from '../components/ui/index.jsx';
import { fmtDateFull, ROLE_NAMES, STATUS_NAMES, statusTone } from '../lib/format.js';

/**
 * הפרופיל האישי.
 *
 * §7: "מטמיע רשאי לערוך רק מידע אישי שהוגדר כניתן לעריכה". השדות
 * הנעולים מוצגים כקריאה בלבד עם הסבר, במקום להיעלם ולבלבל.
 */
export default function Profile() {
  const toast = useToast();
  const { profile, role, sites, domains, mentors, reload } = usePermissions();
  const settings = useApi('/api/settings/app');
  const prefs = useApi('/api/notifications/preferences');

  const [form, setForm] = useState({ phone: '', bio: '', fullName: '' });

  useEffect(() => {
    if (profile) {
      setForm({ phone: profile.phone ?? '', bio: profile.bio ?? '', fullName: profile.full_name ?? '' });
    }
  }, [profile]);

  const editable = new Set(
    settings.data?.settings?.editable_profile_fields?.value ?? ['phone', 'bio'],
  );
  const isManager = role === 'manager';
  const canEdit = (field) => isManager || editable.has(field);

  const save = useAction(
    async () => {
      const body = {};
      if (canEdit('fullName')) body.fullName = form.fullName;
      if (canEdit('phone')) body.phone = form.phone;
      if (canEdit('bio')) body.bio = form.bio;

      await patch(`/api/users/${profile.id}`, body, { ifMatch: profile.row_version });
      toast.success('הפרופיל עודכן');
      reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const savePrefs = useAction(
    async (updated) => {
      await put('/api/notifications/preferences', { preferences: updated });
      toast.success('העדפות ההתראות נשמרו');
      prefs.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  if (!profile) return <StateView loading />;

  return (
    <>
      <ViewHead title="הפרופיל שלי" subtitle="פרטים אישיים, שיוכים והעדפות התראה" />

      <div className="row" style={{ alignItems: 'flex-start', gap: 'var(--space-4)' }}>
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <Panel title="פרטים אישיים">
            <div className="row" style={{ marginBlockEnd: 'var(--space-4)' }}>
              <Avatar name={profile.full_name} size={52} />
              <div>
                <div className="bold" style={{ fontSize: 16 }}>{profile.full_name}</div>
                <div className="small muted">{ROLE_NAMES[role]}</div>
                <Tag tone={statusTone(profile.status)}>{STATUS_NAMES[profile.status]}</Tag>
              </div>
            </div>

            <Field
              label="שם מלא"
              hint={!canEdit('fullName') ? 'שינוי שם נעשה על ידי מנהל ההטמעה' : undefined}
            >
              {(props) => (
                <input {...props} type="text" value={form.fullName} disabled={!canEdit('fullName')}
                  onChange={(e) => setForm({ ...form, fullName: e.target.value })} />
              )}
            </Field>

            <Field label="כתובת דוא״ל" hint="כתובת ההתחברות אינה ניתנת לשינוי מכאן">
              {(props) => <input {...props} type="email" dir="ltr" value={profile.email} disabled />}
            </Field>

            <Field label="טלפון" hint={!canEdit('phone') ? 'נעול לעריכה עצמית' : undefined}>
              {(props) => (
                <input {...props} type="tel" dir="ltr" value={form.phone} disabled={!canEdit('phone')}
                  onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              )}
            </Field>

            <Field label="אודות" hint={!canEdit('bio') ? 'נעול לעריכה עצמית' : undefined}>
              {(props) => (
                <textarea {...props} value={form.bio} disabled={!canEdit('bio')}
                  onChange={(e) => setForm({ ...form, bio: e.target.value })} />
              )}
            </Field>

            <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
              {save.busy ? 'שומר…' : 'שמירה'}
            </button>
          </Panel>
        </div>

        <div style={{ flex: '1 1 280px', minWidth: 0 }}>
          <Panel title="השיוכים שלי" subtitle="נקבעים על ידי מנהל ההטמעה">
            <dl style={{ margin: 0, display: 'grid', gap: 'var(--space-3)' }}>
              <div>
                <dt className="field-label">אתרים</dt>
                <dd style={{ margin: 0 }} className="row">
                  {sites.length ? sites.map((s) => (
                    <Tag key={s.id}>{s.name}{s.assignment_role === 'lead' && ' (מוביל)'}</Tag>
                  )) : <span className="muted">לא שויך אתר</span>}
                </dd>
              </div>
              <div>
                <dt className="field-label">תחומים</dt>
                <dd style={{ margin: 0 }} className="row">
                  {domains.length ? domains.map((d) => (
                    <Tag key={d.id} tone={d.isPrimary ? 'accent' : ''}>{d.name}</Tag>
                  )) : <span className="muted">לא שויך תחום</span>}
                </dd>
              </div>
              <div>
                <dt className="field-label">מדריכים</dt>
                <dd style={{ margin: 0 }} className="row">
                  {mentors.length ? mentors.map((m) => (
                    <Tag key={m.id} tone={m.isPrimary ? 'accent' : ''}>
                      {m.name}{m.isPrimary && ' (ראשי)'}
                    </Tag>
                  )) : <span className="muted">לא שויך מדריך</span>}
                </dd>
              </div>
              {profile.intake_date && (
                <div>
                  <dt className="field-label">תאריך קליטה</dt>
                  <dd style={{ margin: 0 }}>{fmtDateFull(profile.intake_date)}</dd>
                </div>
              )}
            </dl>
          </Panel>

          <Panel title="התראות" subtitle="איפה לקבל כל סוג התראה" flush>
            <StateView loading={prefs.loading} error={prefs.error} onRetry={prefs.reload}>
              <div className="table-wrap">
                <table className="table">
                  <thead>
                    <tr><th>סוג</th><th>באפליקציה</th><th>בדוא״ל</th></tr>
                  </thead>
                  <tbody>
                    {(prefs.data?.preferences ?? []).map((pref) => (
                      <tr key={pref.code}>
                        <td>{pref.name_he}</td>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={pref.inapp}
                            aria-label={`${pref.name_he} באפליקציה`}
                            onChange={(e) =>
                              savePrefs.run([{ typeCode: pref.code, inapp: e.target.checked, email: pref.email }])
                            }
                          />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <input
                            type="checkbox"
                            checked={pref.email}
                            aria-label={`${pref.name_he} בדוא״ל`}
                            onChange={(e) =>
                              savePrefs.run([{ typeCode: pref.code, inapp: pref.inapp, email: e.target.checked }])
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </StateView>
          </Panel>
        </div>
      </div>
    </>
  );
}
