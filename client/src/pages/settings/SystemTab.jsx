import { useEffect, useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { put } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Field } from '../../components/ui/index.jsx';

const TEAM_FIELDS = [
  { value: 'name', label: 'שם' },
  { value: 'activity', label: 'פעילות' },
  { value: 'site', label: 'מיקום' },
  { value: 'status', label: 'סטטוס' },
  { value: 'time', label: 'שעות' },
  { value: 'domain', label: 'תחום' },
];

const PROFILE_FIELDS = [
  { value: 'phone', label: 'טלפון' },
  { value: 'bio', label: 'אודות' },
  { value: 'fullName', label: 'שם מלא' },
];

/** הגדרות רוחביות: מזעור מידע בלו״ז הצוותי, עריכה עצמית, ותוקף חריגות. */
export default function SystemTab() {
  const toast = useToast();
  const settings = useApi('/api/settings/app');
  const [local, setLocal] = useState({});

  useEffect(() => {
    if (settings.data?.settings) {
      setLocal(
        Object.fromEntries(
          Object.entries(settings.data.settings).map(([key, entry]) => [key, entry.value]),
        ),
      );
    }
  }, [settings.data]);

  const save = useAction(
    async (key, value) => {
      await put(`/api/settings/app/${key}`, { value });
      toast.success('ההגדרה נשמרה');
      settings.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const toggleInList = (key, value) => {
    const list = local[key] ?? [];
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    setLocal({ ...local, [key]: next });
    save.run(key, next);
  };

  return (
    <StateView loading={settings.loading} error={settings.error} onRetry={settings.reload}>
      <Panel
        title="מזעור מידע בלו״ז הצוותי"
        subtitle="אילו שדות נחשפים כשמטמיע אחד רואה את הלו״ז של הצוות"
      >
        <Notice icon="🔒">
          <span className="small">
            השרת מחזיר רק את השדות שסומנו כאן. סיבות חופשה והערות אישיות אינן
            נחשפות בלו״ז הצוותי בשום מצב.
          </span>
        </Notice>

        <div className="row" style={{ gap: 6 }}>
          {TEAM_FIELDS.map((field) => {
            const on = (local.team_schedule_fields ?? []).includes(field.value);
            return (
              <button
                key={field.value}
                type="button"
                className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                onClick={() => toggleInList('team_schedule_fields', field.value)}
                aria-pressed={on}
                disabled={save.busy}
              >
                {on && <span aria-hidden="true">✓</span>}
                {field.label}
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel
        title="שדות פרופיל שניתן לערוך עצמאית"
        subtitle="מה מטמיע רשאי לשנות בעצמו, בלי מנהל"
      >
        <div className="row" style={{ gap: 6 }}>
          {PROFILE_FIELDS.map((field) => {
            const on = (local.editable_profile_fields ?? []).includes(field.value);
            return (
              <button
                key={field.value}
                type="button"
                className={`btn btn-sm${on ? ' btn-primary' : ''}`}
                onClick={() => toggleInList('editable_profile_fields', field.value)}
                aria-pressed={on}
                disabled={save.busy}
              >
                {on && <span aria-hidden="true">✓</span>}
                {field.label}
              </button>
            );
          })}
        </div>
      </Panel>

      <Panel title="חריגות ויומן" subtitle="תוקף חריגה שלא הוכרעה, ושמירת יומן הביקורת">
        <div className="grid grid-2">
          <Field label="תוקף חריגה (ימים)" hint="אחרי כמה ימים חריגה שלא הוכרעה פגה אוטומטית">
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                max={365}
                value={local.exception_ttl_days ?? 14}
                onChange={(e) => setLocal({ ...local, exception_ttl_days: Number(e.target.value) })}
                onBlur={(e) => save.run('exception_ttl_days', Number(e.target.value))}
              />
            )}
          </Field>

          <Field label="שמירת יומן ביקורת (חודשים)">
            {(props) => (
              <input
                {...props}
                type="number"
                min={1}
                max={120}
                value={local.audit_retention_months ?? 12}
                onChange={(e) => setLocal({ ...local, audit_retention_months: Number(e.target.value) })}
                onBlur={(e) => save.run('audit_retention_months', Number(e.target.value))}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="מידע על המערכת">
        <dl className="grid grid-2">
          <div>
            <dt className="field-label">אזור זמן עסקי</dt>
            <dd style={{ margin: 0 }}>{local.timezone ?? 'Asia/Jerusalem'}</dd>
          </div>
          <div>
            <dt className="field-label">ערוצי התראה</dt>
            <dd style={{ margin: 0 }} className="row">
              {(local.notification_channels ?? []).map((channel) => (
                <Tag key={channel}>{channel === 'inapp' ? 'באפליקציה' : 'דוא״ל'}</Tag>
              ))}
            </dd>
          </div>
        </dl>

        <Notice icon="⏰" title="משימות מתוזמנות">
          <span className="small">
            פקיעת הרשאות, פקיעת חריגות, שליחת התראות ופתיחת חלון הזמינות רצות דרך
            נתיבי <code>/internal/cron</code>, שפינגר חיצוני מפעיל. ההגדרה מתועדת ב-DEPLOY.md.
          </span>
        </Notice>
      </Panel>
    </StateView>
  );
}
