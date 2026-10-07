import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { post, patch, del, download, newIdempotencyKey } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, ChipPicker, Empty,
} from '../components/ui/index.jsx';
import { fmtDate, fmtClock, dayName, today, addDays, STATUS_NAMES, statusTone } from '../lib/format.js';

const AUDIENCE_LABELS = {
  all: 'כלל המטמיעים באתר',
  site: 'לפי אתר',
  domain: 'לפי תחום',
  sub_category: 'לפי תת-קטגוריה',
  users: 'משתתפים נבחרים',
};

const VISIBILITY_LABELS = {
  participants: 'גלוי למשתתפים',
  managers_only: 'גלוי למנהלים בלבד',
  draft: 'טיוטה',
};

/** פעילויות והדרכות — לוח מקובץ לפי תאריך. */
export default function Activities() {
  const toast = useToast();
  const { can } = usePermissions();

  const [filters, setFilters] = useState({
    siteId: '', typeId: '', status: '',
    from: today(), to: addDays(today(), 30),
  });
  const [editing, setEditing] = useState(null);

  const activities = useApi('/api/activities', { ...filters, limit: 300 });
  const sites = useApi('/api/sites');
  const types = useApi('/api/settings/lookups/activityTypes');

  const grouped = useMemo(() => {
    const map = new Map();
    for (const activity of activities.data?.activities ?? []) {
      if (!map.has(activity.activity_date)) map.set(activity.activity_date, []);
      map.get(activity.activity_date).push(activity);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [activities.data]);

  return (
    <>
      <ViewHead
        title="פעילויות והדרכות"
        subtitle="תצפיות, הדרכות ותרגולים — עם קהל יעד ונראות"
        actions={
          <>
            {can('activities', 'export') && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() =>
                  download('/api/activities/export/csv', filters, 'דוח-פעילויות.csv').catch(toast.error)
                }
              >
                ייצוא CSV
              </button>
            )}
            {can('activities', 'create') && (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
                + פעילות חדשה
              </button>
            )}
          </>
        }
      />

      <Panel title="סינון" flush>
        <div className="panel-body row">
          <label className="small">
            מתאריך{' '}
            <input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} style={{ width: 'auto' }} />
          </label>
          <label className="small">
            עד{' '}
            <input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} style={{ width: 'auto' }} />
          </label>
          <select value={filters.siteId} onChange={(e) => setFilters({ ...filters, siteId: e.target.value })} aria-label="אתר" style={{ width: 'auto' }}>
            <option value="">כל האתרים</option>
            {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={filters.typeId} onChange={(e) => setFilters({ ...filters, typeId: e.target.value })} aria-label="סוג פעילות" style={{ width: 'auto' }}>
            <option value="">כל הסוגים</option>
            {(types.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name_he}</option>)}
          </select>
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="סטטוס" style={{ width: 'auto' }}>
            <option value="">כל הסטטוסים</option>
            <option value="scheduled">מתוכנן</option>
            <option value="completed">הושלם</option>
            <option value="cancelled">בוטל</option>
          </select>
        </div>
      </Panel>

      <StateView
        loading={activities.loading}
        error={activities.error}
        onRetry={activities.reload}
        empty={!activities.loading && grouped.length === 0}
        emptyProps={{ icon: '📚', title: 'אין פעילויות בטווח שנבחר' }}
      >
        {grouped.map(([date, items]) => (
          <Panel key={date} title={`${dayName(date)} · ${fmtDate(date)}`} flush>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {items.map((activity) => (
                <ActivityRow
                  key={activity.id}
                  activity={activity}
                  onEdit={() => setEditing(activity)}
                  onChanged={activities.reload}
                />
              ))}
            </ul>
          </Panel>
        ))}
      </StateView>

      {editing && (
        <ActivityForm
          activity={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); activities.reload(); toast.success('הפעילות נשמרה'); }}
        />
      )}
    </>
  );
}

function ActivityRow({ activity, onEdit, onChanged }) {
  const toast = useToast();
  const { can } = usePermissions();

  const setStatus = useAction(
    async (status) => {
      await post(`/api/activities/${activity.id}/status`, { status });
      toast.success(status === 'completed' ? 'הפעילות סומנה כהושלמה' : 'הפעילות בוטלה');
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const togglePrep = useAction(
    async () => {
      await post(`/api/activities/${activity.id}/prep`, { prepDone: !activity.prep_done });
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <li
      style={{
        display: 'flex', gap: 'var(--space-3)', alignItems: 'center',
        padding: 'var(--space-3) var(--space-4)',
        borderBlockEnd: '1px solid var(--line-soft)',
        flexWrap: 'wrap',
      }}
    >
      <div className="tnum bold" style={{ minWidth: 56 }}>
        {fmtClock(activity.start_time)}
        <div className="tiny muted">{fmtClock(activity.end_time)}</div>
      </div>

      <div style={{ flex: 1, minWidth: 180 }}>
        <div className="bold">{activity.title ?? activity.type_name}</div>
        <div className="small muted">
          {[activity.type_name, activity.site_name, activity.location_name].filter(Boolean).join(' · ')}
        </div>
      </div>

      <div className="row" style={{ gap: 4 }}>
        <Tag>{activity.participant_count} משתתפים</Tag>
        <Tag tone={activity.visibility === 'participants' ? '' : 'warn'}>
          {VISIBILITY_LABELS[activity.visibility]}
        </Tag>
        <Tag tone={statusTone(activity.status)}>{STATUS_NAMES[activity.status] ?? activity.status}</Tag>
        {!activity.prep_done && activity.status === 'scheduled' && <Tag tone="warn">דורש הכנה</Tag>}
      </div>

      {can('activities', 'edit') && (
        <div className="row" style={{ gap: 4 }}>
          <button type="button" className="btn btn-sm" onClick={togglePrep.run} disabled={togglePrep.busy}>
            {activity.prep_done ? 'ביטול סימון הכנה' : 'סימון הוכן'}
          </button>
          {activity.status === 'scheduled' && (
            <button type="button" className="btn btn-sm" onClick={() => setStatus.run('completed')} disabled={setStatus.busy}>
              השלמה
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onEdit}>עריכה</button>
        </div>
      )}
    </li>
  );
}

function ActivityForm({ activity, onClose, onSaved }) {
  const toast = useToast();
  const sites = useApi('/api/sites');
  const types = useApi('/api/settings/lookups/activityTypes');
  const domains = useApi('/api/settings/domains');

  const [form, setForm] = useState({
    siteId: activity?.site_id ?? '',
    locationId: activity?.location_id ?? '',
    activityTypeId: activity?.activity_type_id ?? '',
    title: activity?.title ?? '',
    activityDate: activity?.activity_date ?? today(),
    startTime: fmtClock(activity?.start_time) || '09:00',
    endTime: fmtClock(activity?.end_time) || '11:00',
    audience: activity?.audience ?? 'site',
    targetIds: [],
    visibility: activity?.visibility ?? 'participants',
    domainId: activity?.domain_id ?? '',
    notes: activity?.notes ?? '',
  });

  const siteDetail = useApi(form.siteId ? `/api/sites/${form.siteId}` : null);
  const users = useApi(form.audience === 'users' ? '/api/users' : null, {
    siteId: form.siteId, status: 'active', limit: 300,
  });

  useEffect(() => {
    if (!form.siteId && sites.data?.sites?.length) {
      setForm((f) => ({ ...f, siteId: sites.data.sites[0].id }));
    }
    if (!form.activityTypeId && types.data?.items?.length) {
      setForm((f) => ({ ...f, activityTypeId: types.data.items[0].id }));
    }
  }, [sites.data, types.data]);

  // ברירת מחדל ליעד: האתר עצמו
  useEffect(() => {
    if (form.audience === 'site' && form.siteId) {
      setForm((f) => ({ ...f, targetIds: [form.siteId] }));
    }
  }, [form.audience, form.siteId]);

  const save = useAction(
    async () => {
      const body = {
        ...form,
        locationId: form.locationId || null,
        domainId: form.domainId || null,
        title: form.title || null,
        notes: form.notes || null,
      };
      if (activity) {
        await patch(`/api/activities/${activity.id}`, body, { ifMatch: activity.row_version });
      } else {
        await post('/api/activities', body, { idempotencyKey: newIdempotencyKey() });
      }
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const targetOptions = () => {
    switch (form.audience) {
      case 'site':
        return (sites.data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }));
      case 'domain':
        return (domains.data?.domains ?? []).map((d) => ({ value: d.id, label: d.name }));
      case 'sub_category':
        return (domains.data?.domains ?? []).flatMap((d) =>
          d.subCategories.map((sc) => ({ value: sc.id, label: `${sc.name} (${d.name})` })),
        );
      case 'users':
        return (users.data?.users ?? [])
          .filter((u) => ['implementer', 'lead'].includes(u.base_role))
          .map((u) => ({ value: u.id, label: u.full_name }));
      default:
        return [];
    }
  };

  const toggleTarget = (value) =>
    setForm((f) => ({
      ...f,
      targetIds: f.targetIds.includes(value)
        ? f.targetIds.filter((v) => v !== value)
        : [...f.targetIds, value],
    }));

  return (
    <Modal
      title={activity ? 'עריכת פעילות' : 'פעילות חדשה'}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <StateView loading={sites.loading || types.loading} error={sites.error ?? types.error}>
        <Field label="כותרת" hint="אופציונלי — בהיעדרה יוצג שם סוג הפעילות">
          {(props) => (
            <input {...props} type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          )}
        </Field>

        <div className="grid grid-2">
          <Field label="סוג פעילות" required>
            {(props) => (
              <select {...props} value={form.activityTypeId}
                onChange={(e) => setForm({ ...form, activityTypeId: e.target.value })}>
                {(types.data?.items ?? []).map((t) => <option key={t.id} value={t.id}>{t.name_he}</option>)}
              </select>
            )}
          </Field>

          <Field label="אתר" required>
            {(props) => (
              <select {...props} value={form.siteId}
                onChange={(e) => setForm({ ...form, siteId: e.target.value, locationId: '', targetIds: [] })}>
                {(sites.data?.sites ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="grid grid-3">
          <Field label="תאריך" required>
            {(props) => (
              <input {...props} type="date" value={form.activityDate}
                onChange={(e) => setForm({ ...form, activityDate: e.target.value })} />
            )}
          </Field>
          <Field label="שעת התחלה" required>
            {(props) => (
              <input {...props} type="time" value={form.startTime}
                onChange={(e) => setForm({ ...form, startTime: e.target.value })} />
            )}
          </Field>
          <Field label="שעת סיום" required error={save.fieldErrors.endTime}>
            {(props) => (
              <input {...props} type="time" value={form.endTime}
                onChange={(e) => setForm({ ...form, endTime: e.target.value })} />
            )}
          </Field>
        </div>

        <Field label="מיקום">
          {(props) => (
            <select {...props} value={form.locationId}
              onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
              <option value="">כלל האתר</option>
              {(siteDetail.data?.locations ?? []).map((l) => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </select>
          )}
        </Field>

        <div className="divider" />

        <Field label="קהל יעד" required>
          {(props) => (
            <select {...props} value={form.audience}
              onChange={(e) => setForm({ ...form, audience: e.target.value, targetIds: [] })}>
              {Object.entries(AUDIENCE_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          )}
        </Field>

        {form.audience !== 'all' && (
          <Field label="יעדים" required error={save.fieldErrors.targetIds}>
            <ChipPicker
              options={targetOptions()}
              selected={form.targetIds}
              onToggle={toggleTarget}
              emptyText="אין יעדים זמינים לקהל שנבחר"
            />
          </Field>
        )}

        <Field
          label="נראות"
          hint="פעילות שאינה גלויה למשתתפים לא תופיע בלו״ז האישי ולא תישלח עליה התראה"
        >
          {(props) => (
            <select {...props} value={form.visibility}
              onChange={(e) => setForm({ ...form, visibility: e.target.value })}>
              {Object.entries(VISIBILITY_LABELS).map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          )}
        </Field>

        <Field label="הערות">
          {(props) => (
            <textarea {...props} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          )}
        </Field>
      </StateView>
    </Modal>
  );
}
