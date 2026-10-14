import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { post, patch, del, download, newIdempotencyKey } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, ChipPicker, Empty, Segmented, WeekNav,
} from '../components/ui/index.jsx';
import {
  fmtDate, fmtClock, fmtWeekRange, dayName, today, addDays, weekStartOf, STATUS_NAMES, statusTone,
} from '../lib/format.js';

const AUDIENCE_LABELS = {
  users: 'מטמיעים נבחרים (שיוך שמי)',
  all: 'כלל המטמיעים באתר',
  site: 'לפי אתר',
  domain: 'לפי תחום',
  sub_category: 'לפי תת-קטגוריה',
};

const ROLE_NAMES = { manager: 'מנהלים', mentor: 'מדריכים', lead: 'מובילים', implementer: 'מטמיעים' };
const PHASE_NAMES = { training: 'הכשרה', golive: 'עלייה לאוויר', support: 'ליווי' };

const WEEKDAY_LABELS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];

/** הימים בטווח לפי ימי השבוע שנבחרו — כמו seriesDates בשרת */
function seriesDates(from, until, weekdays) {
  const dates = [];
  if (!from || !until || until < from) return dates;
  for (let d = from; d <= until && dates.length < 40; d = addDays(d, 1)) {
    const [y, m, day] = d.split('-').map(Number);
    if (weekdays.includes(new Date(Date.UTC(y, m - 1, day)).getUTCDay())) dates.push(d);
  }
  return dates;
}

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
  const [view, setView] = useState('board');

  const activities = useApi(view === 'list' ? '/api/activities' : null, { ...filters, limit: 300 });
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
        subtitle="תצפיות, הדרכות ותרגולים — מי מעביר, מי נוכח, ומתי"
        actions={
          <>
            <Segmented
              label="תצוגה"
              value={view}
              onChange={setView}
              options={[{ value: 'board', label: 'לו״ז שבועי' }, { value: 'list', label: 'רשימה' }]}
            />
            {view === 'list' && can('activities', 'export') && (
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

      {view === 'board' && <TrainingBoard sites={sites.data?.sites ?? []} onEdit={setEditing} />}

      {view === 'list' && (
      <>
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
                  onDuplicate={() => setEditing({ copyFrom: activity })}
                  onChanged={activities.reload}
                />
              ))}
            </ul>
          </Panel>
        ))}
      </StateView>
      </>
      )}

      {editing && (
        <ActivityForm
          key={editing.id ?? editing.copyFrom?.id ?? 'new'}
          activity={editing.id ? editing : null}
          copyFrom={editing.copyFrom ?? null}
          initial={editing.id || editing.copyFrom ? null : editing}
          onClose={() => setEditing(null)}
          onDuplicate={(activity) => setEditing({ copyFrom: activity })}
          onSaved={(message) => {
            setEditing(null);
            if (view === 'list') activities.reload();
            else window.dispatchEvent(new Event('activities:changed'));
            toast.success(message ?? 'הפעילות נשמרה');
          }}
        />
      )}
    </>
  );
}

function ActivityRow({ activity, onEdit, onDuplicate, onChanged }) {
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
        {activity.owner_name && <div className="small">מעביר/ה: <span className="bold">{activity.owner_name}</span></div>}
      </div>

      <div className="row" style={{ gap: 4 }}>
        {activity.series_id && <Tag tone="accent">יום {activity.series_index} מתוך {activity.series_count}</Tag>}
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
          {can('activities', 'create') && (
            <button type="button" className="btn btn-sm" onClick={onDuplicate}>שכפול</button>
          )}
        </div>
      )}
    </li>
  );
}

function ActivityForm({ activity, copyFrom, initial, onClose, onSaved, onDuplicate }) {
  const toast = useToast();
  const { can } = usePermissions();
  // בשכפול: כל הפרטים מהפעילות המקורית, בתאריך חדש
  const source = activity ?? copyFrom;
  const sites = useApi('/api/sites');
  const types = useApi('/api/settings/lookups/activityTypes');
  const domains = useApi('/api/settings/domains');
  // בעריכה: קהל היעד הקיים, כדי שהיעדים שנבחרו לא יתאפסו
  const detail = useApi(source ? `/api/activities/${source.id}` : null);

  const [form, setForm] = useState({
    siteId: source?.site_id ?? initial?.siteId ?? '',
    locationId: source?.location_id ?? '',
    activityTypeId: source?.activity_type_id ?? '',
    title: source?.title ?? '',
    activityDate: activity?.activity_date
      ?? (copyFrom ? addDays(copyFrom.activity_date, 1) : null)
      ?? initial?.activityDate ?? today(),
    startTime: fmtClock(source?.start_time) || '09:00',
    endTime: fmtClock(source?.end_time) || '11:00',
    audience: source?.audience ?? 'users',
    targetIds: initial?.targetIds ?? [],
    visibility: source?.visibility ?? 'participants',
    ownerUserId: activity?.owner_user_id ?? copyFrom?.owner_user_id ?? '',
    domainId: source?.domain_id ?? '',
    notes: source?.notes ?? '',
  });
  // פעילות של כמה ימים — ביצירה בלבד; ברירת מחדל: ראשון עד חמישי
  const [multiDay, setMultiDay] = useState(false);
  const [untilDate, setUntilDate] = useState('');
  const [weekdays, setWeekdays] = useState([0, 1, 2, 3, 4]);
  const dates = multiDay ? seriesDates(form.activityDate, untilDate, weekdays) : [];
  const tooLong = multiDay && untilDate && untilDate > addDays(form.activityDate, 30);

  useEffect(() => {
    if (!detail.data) return;
    const { audience } = detail.data;
    setForm((f) => ({ ...f, targetIds: audience.filter((a) => a.target_id).map((a) => a.target_id) }));
  }, [detail.data]);

  const siteDetail = useApi(form.siteId ? `/api/sites/${form.siteId}` : null);
  const users = useApi(form.audience === 'users' && form.siteId ? '/api/users' : null, {
    siteId: form.siteId, status: 'active', limit: 300,
  });
  // מי מעביר: כל משתמש פעיל — מדריך, מוביל, או מטמיע שמעביר הדרכת משתמשים
  const people = useApi('/api/users', { status: 'active', limit: 500 });
  const instructors = useMemo(() => {
    const groups = {};
    for (const u of people.data?.users ?? []) (groups[u.base_role] ??= []).push(u);
    return ['mentor', 'lead', 'implementer', 'manager'].filter((r) => groups[r]).map((r) => [r, groups[r]]);
  }, [people.data]);

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
    if (form.audience === 'site' && form.siteId && form.targetIds.length === 0) {
      setForm((f) => ({ ...f, targetIds: [form.siteId] }));
    }
  }, [form.audience, form.siteId]);

  const save = useAction(
    async () => {
      const body = {
        ...form,
        locationId: form.locationId || null,
        ownerUserId: form.ownerUserId || null,
        domainId: form.domainId || null,
        title: form.title || null,
        notes: form.notes || null,
      };
      if (activity) {
        await patch(`/api/activities/${activity.id}`, body, { ifMatch: activity.row_version });
        onSaved();
        return;
      }
      if (multiDay) {
        if (!untilDate) throw new Error('יש לבחור תאריך סיום');
        if (dates.length === 0) throw new Error('אין בטווח שנבחר אף יום מימי השבוע שסומנו');
        Object.assign(body, { untilDate, weekdays });
      }
      const out = await post('/api/activities', body, { idempotencyKey: newIdempotencyKey() });
      onSaved(
        out?.count > 1
          ? out.status === 'approval_required'
            ? `נוצרו ${out.created} מתוך ${out.count} פעילויות; השאר ממתינות לאישור`
            : `נוצרו ${out.count} פעילויות`
          : undefined,
      );
    },
    { onError: (err) => toast.error(err) },
  );

  const remove = useAction(
    async (series) => {
      const what = series ? `את כל ${activity.series_count} הימים בסדרה` : 'את הפעילות';
      if (!window.confirm(`למחוק ${what}? המשתתפים יקבלו התראה על הביטול.`)) return;
      const out = await del(`/api/activities/${activity.id}${series ? '?series=1' : ''}`);
      onSaved(out?.count > 1 ? `נמחקו ${out.count} פעילויות` : 'הפעילות נמחקה');
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
      title={activity ? 'עריכת פעילות' : copyFrom ? 'שכפול פעילות' : 'פעילות חדשה'}
      onClose={onClose}
      width={640}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()}
            disabled={save.busy || tooLong}>
            {save.busy ? 'שומר…' : dates.length > 1 ? `יצירת ${dates.length} פעילויות` : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
          {activity && (
            <span className="row" style={{ gap: 4, marginInlineStart: 'auto' }}>
              {can('activities', 'create') && (
                <button type="button" className="btn btn-sm" onClick={() => onDuplicate(activity)}>שכפול</button>
              )}
              {can('activities', 'delete') && (
                <>
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => remove.run(false)}
                    disabled={remove.busy}>
                    {activity.series_id ? 'מחיקת היום הזה' : 'מחיקה'}
                  </button>
                  {activity.series_id && activity.series_count > 1 && (
                    <button type="button" className="btn btn-sm btn-danger" onClick={() => remove.run(true)}
                      disabled={remove.busy}>
                      מחיקת כל הסדרה
                    </button>
                  )}
                </>
              )}
            </span>
          )}
        </>
      }
    >
      <StateView loading={sites.loading || types.loading || detail.loading} error={sites.error ?? types.error ?? detail.error}>
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

        {activity?.series_id && (
          <Notice icon="ℹ">
            יום {activity.series_index} מתוך {activity.series_count} בסדרה. שינוי כאן חל על היום הזה בלבד.
          </Notice>
        )}

        <div className="grid grid-3">
          <Field label={multiDay ? 'מתאריך' : 'תאריך'} required>
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

        {!activity && (
          <div className="field">
            <label className="row" style={{ gap: 6, fontWeight: 'normal' }}>
              <input type="checkbox" checked={multiDay} style={{ width: 'auto' }}
                onChange={(e) => {
                  setMultiDay(e.target.checked);
                  if (e.target.checked && !untilDate) setUntilDate(addDays(form.activityDate, 4));
                }} />
              פעילות של כמה ימים
            </label>
            {multiDay && (
              <div className="grid grid-2 mt-3" style={{ alignItems: 'end' }}>
                <Field label="עד תאריך" required error={save.fieldErrors.untilDate ?? (tooLong ? 'אפשר עד 31 ימים' : undefined)}>
                  {(props) => (
                    <input {...props} type="date" value={untilDate} min={form.activityDate}
                      max={addDays(form.activityDate, 30)}
                      onChange={(e) => setUntilDate(e.target.value)} />
                  )}
                </Field>
                <Field label="בימים">
                  <ChipPicker
                    options={WEEKDAY_LABELS.map((label, value) => ({ value, label }))}
                    selected={weekdays}
                    onToggle={(d) => setWeekdays((w) => (w.includes(d) ? w.filter((x) => x !== d) : [...w, d].sort()))}
                  />
                </Field>
                <p className="small muted" style={{ gridColumn: '1 / -1', margin: 0 }}>
                  {dates.length > 0
                    ? `ייווצרו ${dates.length} פעילויות נפרדות, אחת לכל יום (${dates.map((d) => fmtDate(d)).slice(0, 7).join(', ')}${dates.length > 7 ? '…' : ''}). אפשר לערוך או למחוק כל יום בנפרד.`
                    : 'אין בטווח אף יום מהימים שסומנו'}
                </p>
              </div>
            )}
          </div>
        )}

        <Field label="מי מעביר" hint="המדריך יראה את הפעילות בלו״ז שלו. ריק = את/ה">
          {(props) => (
            <select {...props} value={form.ownerUserId}
              onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}>
              <option value="">{activity?.owner_name ? `${activity.owner_name} (נוכחי)` : '— אני —'}</option>
              {instructors.map(([role, list]) => (
                <optgroup key={role} label={ROLE_NAMES[role]}>
                  {list.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                </optgroup>
              ))}
            </select>
          )}
        </Field>

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

        <Field label="מי נוכח" required hint="בשיוך שמי, כל מטמיע שנבחר יראה את הפעילות בלו״ז שלו">
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
          <Field label={form.audience === 'users' ? 'מטמיעים' : 'יעדים'} required error={save.fieldErrors.targetIds}>
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

/* ==========================================================================
   לו״ז שבועי — מטמיעים × ימים
   ========================================================================== */

/**
 * לפני העלייה לאוויר הלו״ז נבנה מפעילויות ולא ממשמרות: לכל מטמיע, בכל יום,
 * באילו הדרכות ותצפיות הוא נוכח. שורה עליונה — כל הפעילויות של היום;
 * מתחתיה שורה לכל מטמיע, ובה הפעילויות שלו והמשמרות שלו מהסידור.
 */
function TrainingBoard({ sites, onEdit }) {
  const toast = useToast();
  const { can } = usePermissions();
  const [siteId, setSiteId] = useState('');
  const [weekStart, setWeekStart] = useState(weekStartOf(today()));
  const [cell, setCell] = useState(null);

  useEffect(() => {
    if (!siteId && sites.length) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const board = useApi(siteId ? '/api/activities/board' : null, { siteId, weekStart });

  // שמירה בטופס הפעילות מרעננת את הלוח
  useEffect(() => {
    const reload = () => board.reload();
    window.addEventListener('activities:changed', reload);
    return () => window.removeEventListener('activities:changed', reload);
  }, [board.reload]);

  const toggle = useAction(
    async (activity, userId, present) => {
      // עדכון מיידי במסך; השרת מאשר ברקע
      board.setData({
        ...board.data,
        activities: board.data.activities.map((a) => (a.id !== activity.id ? a : {
          ...a,
          participant_ids: present ? [...a.participant_ids, userId] : a.participant_ids.filter((id) => id !== userId),
        })),
      });
      await post(`/api/activities/${activity.id}/participants`, { userId, present });
      board.reload();
    },
    { onError: (err) => { toast.error(err); board.reload(); } },
  );

  const data = board.data;
  const editable = can('activities', 'edit');

  /** מה יש לאדם ביום: פעילויות שהוא נוכח בהן או מעביר, ומשמרות */
  const itemsFor = (personId, date) => {
    const acts = (data?.activities ?? [])
      .filter((a) => a.activity_date === date && (a.participant_ids.includes(personId) || a.owner_user_id === personId))
      .map((a) => ({ kind: 'activity', start: a.start_time, end: a.end_time, activity: a, instructor: a.owner_user_id === personId }));
    const shifts = (data?.shifts ?? [])
      .filter((s) => s.user_id === personId && s.assignment_date === date)
      .map((s) => ({ kind: 'shift', start: s.start_time, end: s.end_time, shift: s }));
    const items = [...acts, ...shifts].sort((a, b) => a.start.localeCompare(b.start));
    // חפיפה: התחלה לפני סוף של פריט קודם
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (items[j].start < items[i].end && items[i].start < items[j].end) {
          items[i].overlap = true;
          items[j].overlap = true;
        }
      }
    }
    return items;
  };

  return (
    <Panel
      title="לו״ז שבועי"
      subtitle="מי מהמטמיעים נוכח באיזו פעילות, בכל יום. לחיצה על תא — שיוך לפעילות קיימת או פעילות חדשה"
      actions={
        <>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label="בחירת אתר" style={{ width: 'auto', minWidth: 160 }}>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <WeekNav
            label={fmtWeekRange(weekStart)}
            onPrev={() => setWeekStart(addDays(weekStart, -7))}
            onNext={() => setWeekStart(addDays(weekStart, 7))}
            onToday={() => setWeekStart(weekStartOf(today()))}
          />
        </>
      }
      flush
    >
      <StateView loading={board.loading && !data} error={board.error} onRetry={board.reload}
        empty={data && data.people.length === 0}
        emptyProps={{ icon: '👥', title: 'אין מטמיעים משויכים לאתר בשבוע הזה' }}>
        {data && (
          <div className="roster-wrap" style={{ padding: '0 var(--space-3) var(--space-3)' }}>
            <div className="roster-grid"
              style={{ gridTemplateColumns: `minmax(130px, auto) repeat(${data.days.length}, minmax(140px, 1fr))` }}>
              <div className="roster-corner">מטמיע</div>
              {data.days.map((date) => (
                <div key={date} className="roster-dayhead">
                  {dayName(date)}
                  <small className="tnum">{fmtDate(date)}</small>
                  {data.phases[date] && <span className={`phase phase-${data.phases[date]}`}>{PHASE_NAMES[data.phases[date]]}</span>}
                </div>
              ))}

              {/* כל הפעילויות של היום */}
              <div className="roster-loc">פעילויות היום</div>
              {data.days.map((date) => {
                const list = data.activities.filter((a) => a.activity_date === date);
                return (
                  <div key={date} className="roster-day">
                    {list.map((a) => (
                      <button key={a.id} type="button" className="board-activity" onClick={() => onEdit(a)}
                        title={[a.type_name, a.owner_name && `מעביר/ה: ${a.owner_name}`, a.location_name].filter(Boolean).join(' · ')}>
                        <span className="tnum tiny">{fmtClock(a.start_time)}–{fmtClock(a.end_time)}</span>
                        <span className="bold">{a.title || a.type_name}</span>
                        <span className="tiny muted">
                          {a.owner_name ? `${a.owner_name} · ` : ''}{a.participant_ids.length} נוכחים
                        </span>
                      </button>
                    ))}
                    {can('activities', 'create') && (
                      <button type="button" className="roster-add"
                        onClick={() => onEdit({ siteId, activityDate: date, targetIds: [] })}>
                        + פעילות
                      </button>
                    )}
                  </div>
                );
              })}

              {data.people.map((person) => (
                <PersonRow key={person.id} person={person} days={data.days} itemsFor={itemsFor}
                  editable={editable} busy={toggle.busy}
                  onRemove={(activity) => toggle.run(activity, person.id, false)}
                  onOpen={(date) => setCell({ person, date })}
                  onEdit={onEdit} />
              ))}
            </div>

            <div className="legend mt-3">
              <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--primary-ink)' }} />פעילות</span>
              <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--surface-2)' }} />משמרת מהסידור</span>
              <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--danger-bg)' }} />חפיפה</span>
            </div>
          </div>
        )}
      </StateView>

      {cell && data && (
        <AssignDialog
          person={cell.person}
          date={cell.date}
          activities={data.activities.filter((a) => a.activity_date === cell.date)}
          busy={toggle.busy}
          canCreate={can('activities', 'create')}
          onToggle={(activity, present) => toggle.run(activity, cell.person.id, present)}
          onCreate={() => { setCell(null); onEdit({ siteId, activityDate: cell.date, targetIds: [cell.person.id] }); }}
          onClose={() => setCell(null)}
        />
      )}
    </Panel>
  );
}

function PersonRow({ person, days, itemsFor, editable, busy, onRemove, onOpen, onEdit }) {
  return (
    <>
      <div className="roster-loc" title={person.domains ?? undefined}>
        <div>
          <div>{person.full_name}</div>
          {person.domains && <div className="tiny muted" style={{ fontWeight: 400 }}>{person.domains}</div>}
        </div>
      </div>
      {days.map((date) => {
        const items = itemsFor(person.id, date);
        return (
          <div key={date} className={`roster-slot board-cell ${items.length ? 'covered' : 'vacant'}`}>
            {items.map((item) => item.kind === 'activity' ? (
              <span key={`a-${item.activity.id}`} className={`roster-chip board-chip${item.overlap ? ' issue' : ''}`}>
                <button type="button" className="chip-name" onClick={() => onEdit(item.activity)}
                  title={[item.activity.type_name, item.activity.owner_name && `מעביר/ה: ${item.activity.owner_name}`].filter(Boolean).join(' · ')}>
                  <span className="tnum tiny">{fmtClock(item.start)}</span> {item.activity.title || item.activity.type_name}
                </button>
                {item.instructor && <Tag tone="accent">מעביר/ה</Tag>}
                {editable && !item.instructor && (
                  <button type="button" onClick={() => onRemove(item.activity)} disabled={busy}
                    aria-label={`הסרת ${person.full_name} מ${item.activity.title || item.activity.type_name}`}>✕</button>
                )}
              </span>
            ) : (
              <span key={`s-${item.shift.id}`} className={`roster-chip board-shift${item.overlap ? ' issue' : ''}`}
                title={item.shift.version_status === 'draft' ? 'מטיוטת הסידור' : 'מהסידור שפורסם'}>
                <span className="tnum tiny">{fmtClock(item.start)}–{fmtClock(item.end)}</span>
                {item.shift.shift_name ?? 'משמרת'} · {item.shift.location_name}
              </span>
            ))}
            {editable && (
              <button type="button" className="roster-add" onClick={() => onOpen(date)}
                aria-label={`שיוך ${person.full_name} לפעילות ב${dayName(date)}`}>
                + שיוך
              </button>
            )}
          </div>
        );
      })}
    </>
  );
}

function AssignDialog({ person, date, activities, busy, canCreate, onToggle, onCreate, onClose }) {
  return (
    <Modal
      title={`${person.full_name} · ${dayName(date)} ${fmtDate(date)}`}
      onClose={onClose}
      width={520}
      footer={
        <>
          {canCreate && <button type="button" className="btn btn-primary" onClick={onCreate}>+ פעילות חדשה ליום הזה</button>}
          <button type="button" className="btn btn-ghost" onClick={onClose}>סגירה</button>
        </>
      }
    >
      {activities.length === 0 ? (
        <Empty icon="📚" title="אין פעילויות ביום הזה" text="אפשר ליצור פעילות חדשה — המטמיע ישויך אליה אוטומטית." />
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {activities.map((a) => {
            const present = a.participant_ids.includes(person.id);
            const instructor = a.owner_user_id === person.id;
            return (
              <label key={a.id} className="check" style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={present} disabled={busy || instructor}
                  onChange={() => onToggle(a, !present)} />
                <span>
                  <span className="bold">{a.title || a.type_name}</span>{' '}
                  <span className="tnum small">{fmtClock(a.start_time)}–{fmtClock(a.end_time)}</span>
                  <div className="tiny muted">
                    {[a.type_name, a.owner_name && `מעביר/ה: ${a.owner_name}`, a.location_name, `${a.participant_ids.length} נוכחים`]
                      .filter(Boolean).join(' · ')}
                    {instructor && ' · מעביר/ה את הפעילות'}
                  </div>
                </span>
              </label>
            );
          })}
        </div>
      )}
    </Modal>
  );
}
