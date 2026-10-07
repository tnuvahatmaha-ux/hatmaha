import { useEffect, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post, patch, del } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, Accordion, Empty, ConfirmDialog,
} from '../components/ui/index.jsx';
import { fmtDateFull, fmtClock, today } from '../lib/format.js';

/**
 * ניהול אתרים.
 *
 * כל אתר מגדיר את מה שמניע את שאר המערכת: מיקומים, ולכל מיקום המשמרות
 * שלו (כולל דגל חובה ותקן כוח אדם), תקופות ומכסות הזמינות.
 * כללי אישור האילוצים גנריים לכל האתרים, ונערכים בהגדרות.
 */
export default function Sites() {
  const toast = useToast();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editing, setEditing] = useState(null);

  const sites = useApi('/api/sites', { includeArchived });

  return (
    <>
      <ViewHead
        title="אתרים"
        subtitle="הגדרת אתרי ההטמעה — מיקומים, משמרות לכל מיקום ותקופות"
        actions={
          <>
            <label className="check">
              <input
                type="checkbox"
                checked={includeArchived}
                onChange={(e) => setIncludeArchived(e.target.checked)}
              />
              הצגת אתרים בארכיון
            </label>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setEditing({})}>
              + אתר חדש
            </button>
          </>
        }
      />

      <StateView
        loading={sites.loading}
        error={sites.error}
        onRetry={sites.reload}
        empty={!sites.loading && (sites.data?.sites ?? []).length === 0}
        emptyProps={{
          icon: '🏥',
          title: 'עדיין לא הוגדרו אתרים',
          text: 'אתר הוא נקודת המוצא: בלעדיו אי אפשר לשבץ, להגיש זמינות או לקבוע פעילויות.',
          action: (
            <button type="button" className="btn btn-primary" onClick={() => setEditing({})}>
              יצירת האתר הראשון
            </button>
          ),
        }}
      >
        <Panel flush>
          {(sites.data?.sites ?? []).map((site) => (
            <SiteCard key={site.id} site={site} onEdit={() => setEditing(site)} onChanged={sites.reload} />
          ))}
        </Panel>
      </StateView>

      {editing && (
        <SiteForm
          site={editing.id ? editing : null}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); sites.reload(); toast.success('האתר נשמר'); }}
        />
      )}
    </>
  );
}

function SiteCard({ site, onEdit, onChanged }) {
  const toast = useToast();
  const detail = useApi(null);
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(null);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const loadDetail = async () => {
    if (loaded) return;
    try {
      setLoaded(await get(`/api/sites/${site.id}`));
    } catch (err) {
      toast.error(err);
    }
  };

  const archive = useAction(
    async () => {
      await post(`/api/sites/${site.id}/archive`, { archived: !site.is_archived });
      setConfirmArchive(false);
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <>
      <Accordion
        title={
          <>
            {site.name}
            {site.is_archived && <Tag> בארכיון</Tag>}
          </>
        }
        meta={
          <>
            <Tag tone={site.status_code === 'golive' ? 'accent' : ''}>{site.status_name}</Tag>
            {site.go_live_date && <Tag>Go Live: {fmtDateFull(site.go_live_date)}</Tag>}
            <Tag>{site.people_count} אנשים</Tag>
          </>
        }
        actions={
          <>
            <button type="button" className="btn btn-sm" onClick={onEdit}>עריכה</button>
            <button type="button" className="btn btn-sm" onClick={() => setConfirmArchive(true)}>
              {site.is_archived ? 'שחזור' : 'ארכוב'}
            </button>
          </>
        }
      >
        <SiteDetail siteId={site.id} />
      </Accordion>

      {confirmArchive && (
        <ConfirmDialog
          title={site.is_archived ? 'שחזור אתר' : 'ארכוב אתר'}
          message={
            site.is_archived
              ? `להחזיר את ${site.name} לפעילות?`
              : `לארכב את ${site.name}? הנתונים נשמרים, והאתר נעלם מהרשימות הפעילות.`
          }
          confirmLabel={site.is_archived ? 'שחזור' : 'ארכוב'}
          tone={site.is_archived ? 'primary' : 'danger'}
          busy={archive.busy}
          onConfirm={() => archive.run()}
          onCancel={() => setConfirmArchive(false)}
        />
      )}
    </>
  );
}

const PERIODS = [
  { value: 'training', label: 'הכשרה' },
  { value: 'golive', label: 'עלייה לאוויר' },
  { value: 'support', label: 'תמיכה' },
];

function SiteDetail({ siteId }) {
  const toast = useToast();
  const detail = useApi(`/api/sites/${siteId}`);
  const [locationForm, setLocationForm] = useState(null);

  const data = detail.data;

  return (
    <StateView loading={detail.loading} error={detail.error} onRetry={detail.reload}>
      {data && (
        <>
          <div className="grid grid-2" style={{ marginBlockEnd: 'var(--space-4)' }}>
            <Info label="שעות פעילות" value={`${fmtClock(data.site.open_time)}–${fmtClock(data.site.close_time)}`} />
            <Info
              label="מכסות זמינות שבועיות"
              value={`לא יכול: ${data.site.availability_max_cannot} · מעדיף שלא: ${data.site.availability_max_prefer_not}`}
            />
            <Info
              label="מועד הגשת זמינות"
              value={
                data.site.availability_deadline_weekday != null
                  ? `יום ${['ראשון','שני','שלישי','רביעי','חמישי','שישי','שבת'][data.site.availability_deadline_weekday]} בשעה ${String(data.site.availability_deadline_hour).padStart(2,'0')}:00`
                  : 'לא הוגדר'
              }
            />
            <Info label="תיאור" value={data.site.description ?? '—'} />
          </div>

          {/* מיקומים, ולכל מיקום המשמרות שלו */}
          <Panel
            title="מיקומים ומשמרות"
            subtitle="לכל מיקום שעות משלו. משמרת חובה: סימון ״לא יכול״ על השעות שלה מעביר את ההגשה לאישור מיוחד"
            actions={
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setLocationForm({})}>
                + מיקום
              </button>
            }
            flush
          >
            {data.locations.length === 0 ? (
              <Empty
                icon="📍"
                title="לא הוגדרו מיקומים"
                text="המשמרות מוגדרות לכל מיקום. בלי מיקום לא ניתן לבנות סידור ולא ניתן להגיש זמינות."
              />
            ) : (
              data.locations.map((location) => (
                <LocationShifts
                  key={location.id}
                  siteId={siteId}
                  location={location}
                  onEdit={() => setLocationForm(location)}
                  onChanged={detail.reload}
                />
              ))
            )}
          </Panel>

          {locationForm && (
            <LocationForm
              siteId={siteId}
              location={locationForm.id ? locationForm : null}
              onClose={() => setLocationForm(null)}
              onSaved={(saved) => {
                setLocationForm(null);
                detail.reload();
                toast.success(
                  saved?.copiedShifts
                    ? `המיקום נשמר, ונוספו ${saved.copiedShifts} משמרות מהתבנית של סוג המיקום`
                    : 'המיקום נשמר',
                );
              }}
            />
          )}
        </>
      )}
    </StateView>
  );
}

/** מיקום אחד: פרטים, והמשמרות שלו */
function LocationShifts({ siteId, location, onEdit, onChanged }) {
  const toast = useToast();
  const [shiftForm, setShiftForm] = useState(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const shifts = location.shiftTypes.filter((s) => s.is_active);
  const base = `/api/sites/${siteId}/locations/${location.id}/shift-types`;

  const removeShift = useAction(
    async (id) => {
      const result = await del(`${base}/${id}`);
      toast.success(
        result.removed === 'soft'
          ? 'המשמרת הוסרה מהתצוגה — היא נשמרה כי כבר נעשה בה שימוש'
          : 'המשמרת נמחקה',
      );
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Accordion
      defaultOpen
      title={
        <>
          {location.name}
          {!location.is_active && <Tag> מושבת</Tag>}
        </>
      }
      meta={
        <>
          {location.location_type_name ?? 'ללא סוג'} · {shifts.length} משמרות
        </>
      }
      actions={
        <>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => setShiftForm({})}>
            + משמרת
          </button>
          {location.location_type_id && (
            <button type="button" className="btn btn-sm" onClick={() => setTemplateOpen(true)}>
              העתקה מתבנית
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onEdit}>עריכת מיקום</button>
        </>
      }
    >
      {location.description && <p className="small muted">{location.description}</p>}

      {shifts.length === 0 ? (
        <Empty
          icon="🕐"
          title="למיקום הזה אין משמרות"
          text={
            location.location_type_id
              ? 'אפשר להוסיף משמרת, או להעתיק את התבנית של סוג המיקום.'
              : 'הוסיפו משמרת כדי שאפשר יהיה לשבץ במיקום הזה.'
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>שם</th><th>שעות</th><th>חובה</th><th>תקן</th><th>תחום</th><th /></tr>
            </thead>
            <tbody>
              {shifts.map((shift) => (
                <tr key={shift.id}>
                  <td data-label="שם" className="bold">{shift.name}</td>
                  <td data-label="שעות" className="tnum">
                    {fmtClock(shift.start_time)}–{fmtClock(shift.end_time)}
                    {shift.crosses_midnight && <Tag tone="accent"> חוצה חצות</Tag>}
                  </td>
                  <td data-label="חובה">
                    {shift.is_mandatory ? <Tag tone="accent">חובה</Tag> : <Tag>גמישה</Tag>}
                  </td>
                  <td data-label="תקן" className="tnum">{shift.required_staff}</td>
                  <td data-label="תחום">{shift.domain_name ?? '—'}</td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      <button type="button" className="btn btn-sm" onClick={() => setShiftForm(shift)}>
                        עריכה
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => removeShift.run(shift.id)}
                        disabled={removeShift.busy}
                        aria-label={`הסרת משמרת ${shift.name} ב${location.name}`}
                      >
                        הסרה
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {shiftForm && (
        <ShiftForm
          endpoint={base}
          locationName={location.name}
          shift={shiftForm.id ? shiftForm : null}
          onClose={() => setShiftForm(null)}
          onSaved={() => { setShiftForm(null); onChanged(); toast.success('המשמרת נשמרה'); }}
        />
      )}

      {templateOpen && (
        <TemplateCopy
          endpoint={`${base}/from-template`}
          location={location}
          onClose={() => setTemplateOpen(false)}
          onDone={(result) => {
            setTemplateOpen(false);
            onChanged();
            toast.success(
              result.added
                ? `נוספו ${result.added} משמרות מהתבנית`
                : 'כל המשמרות שבתבנית כבר קיימות במיקום',
            );
          }}
        />
      )}
    </Accordion>
  );
}

/** הוספת משמרות מתבנית סוג המיקום. משמרת בשם שכבר קיים אינה נדרסת. */
function TemplateCopy({ endpoint, location, onClose, onDone }) {
  const toast = useToast();
  const [period, setPeriod] = useState('training');

  const copy = useAction(
    async () => onDone(await post(endpoint, { period })),
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal
      title={`העתקת משמרות מתבנית — ${location.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => copy.run()} disabled={copy.busy}>
            {copy.busy ? 'מעתיק…' : 'העתקה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <p className="small" style={{ marginBlockEnd: 'var(--space-3)' }}>
        יתווספו המשמרות שמוגדרות לסוג המיקום ״{location.location_type_name}״ בתקופה שתבחרו.
        משמרת שכבר קיימת במיקום באותו שם לא תשתנה.
      </p>
      <Field label="תקופה">
        {(props) => (
          <select {...props} value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        )}
      </Field>
    </Modal>
  );
}

function SiteForm({ site, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState({
    name: site?.name ?? '',
    description: site?.description ?? '',
    statusCode: site?.status_code ?? 'training',
    goLiveDate: site?.go_live_date ?? '',
    openTime: fmtClock(site?.open_time) || '07:00',
    closeTime: fmtClock(site?.close_time) || '23:00',
    maxCannot: site?.availability_max_cannot ?? 3,
    maxPreferNot: site?.availability_max_prefer_not ?? 4,
    deadlineWeekday: site?.availability_deadline_weekday ?? 4,
    deadlineHour: site?.availability_deadline_hour ?? 12,
  });

  const save = useAction(
    async () => {
      const body = {
        ...form,
        goLiveDate: form.goLiveDate || null,
        deadlineWeekday: form.deadlineWeekday === '' ? null : Number(form.deadlineWeekday),
        deadlineHour: form.deadlineHour === '' ? null : Number(form.deadlineHour),
      };
      if (site) await patch(`/api/sites/${site.id}`, body, { ifMatch: site.row_version });
      else await post('/api/sites', body);
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const errors = save.fieldErrors;

  return (
    <Modal
      title={site ? `עריכת ${site.name}` : 'אתר חדש'}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="שם האתר" required error={errors.name}>
        {(props) => (
          <input {...props} type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        )}
      </Field>

      <Field label="תיאור">
        {(props) => (
          <input {...props} type="text" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        )}
      </Field>

      <div className="grid grid-2">
        <Field label="סטטוס">
          {(props) => (
            <select {...props} value={form.statusCode} onChange={(e) => setForm({ ...form, statusCode: e.target.value })}>
              <option value="training">הכשרה</option>
              <option value="golive">Go Live</option>
              <option value="support">תמיכה</option>
              <option value="ended">הסתיים</option>
            </select>
          )}
        </Field>

        <Field label="תאריך Go Live">
          {(props) => (
            <input {...props} type="date" value={form.goLiveDate} onChange={(e) => setForm({ ...form, goLiveDate: e.target.value })} />
          )}
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="שעת פתיחה" error={errors.openTime}>
          {(props) => (
            <input {...props} type="time" value={form.openTime} onChange={(e) => setForm({ ...form, openTime: e.target.value })} />
          )}
        </Field>
        <Field
          label="שעת סגירה"
          error={errors.closeTime}
          hint="משמרת שחוצה חצות אפשרית רק באתר שפעיל 00:00–23:59"
        >
          {(props) => (
            <input {...props} type="time" value={form.closeTime} onChange={(e) => setForm({ ...form, closeTime: e.target.value })} />
          )}
        </Field>
      </div>

      <div className="divider" />

      <h3 style={{ marginBlockEnd: 'var(--space-2)' }}>מכסות זמינות שבועיות</h3>
      <p className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
        חריגה מהמכסה, או סימון ״לא יכול״ על משמרת חובה, מעבירים את ההגשה לאישור מיוחד.
      </p>

      <div className="grid grid-2">
        <Field label="מקסימום ״לא יכול״">
          {(props) => (
            <input {...props} type="number" min={0} max={50} value={form.maxCannot}
              onChange={(e) => setForm({ ...form, maxCannot: Number(e.target.value) })} />
          )}
        </Field>
        <Field label="מקסימום ״מעדיף שלא״">
          {(props) => (
            <input {...props} type="number" min={0} max={50} value={form.maxPreferNot}
              onChange={(e) => setForm({ ...form, maxPreferNot: Number(e.target.value) })} />
          )}
        </Field>
      </div>

      <div className="grid grid-2">
        <Field label="יום ההגשה האחרון" hint="בשבוע שלפני השבוע המוצהר">
          {(props) => (
            <select {...props} value={form.deadlineWeekday}
              onChange={(e) => setForm({ ...form, deadlineWeekday: e.target.value })}>
              <option value="">לא מוגדר</option>
              {['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'].map((day, i) => (
                <option key={day} value={i}>{day}</option>
              ))}
            </select>
          )}
        </Field>
        <Field label="שעת ההגשה האחרונה">
          {(props) => (
            <input {...props} type="number" min={0} max={23} value={form.deadlineHour}
              onChange={(e) => setForm({ ...form, deadlineHour: e.target.value })} />
          )}
        </Field>
      </div>
    </Modal>
  );
}

function ShiftForm({ endpoint, locationName, shift, onClose, onSaved }) {
  const toast = useToast();
  const domains = useApi('/api/settings/domains');

  const [form, setForm] = useState({
    name: shift?.name ?? '',
    startTime: fmtClock(shift?.start_time) || '06:00',
    endTime: fmtClock(shift?.end_time) || '14:00',
    isMandatory: shift?.is_mandatory ?? false,
    requiredStaff: shift?.required_staff ?? 1,
    domainId: shift?.domain_id ?? '',
  });

  const save = useAction(
    async () => {
      await post(
        endpoint,
        { ...form, id: shift?.id, domainId: form.domainId || null },
        { ifMatch: shift?.row_version },
      );
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const crossesMidnight = form.endTime <= form.startTime;

  return (
    <Modal
      title={shift ? `עריכת משמרת ${shift.name} — ${locationName}` : `משמרת חדשה — ${locationName}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="שם המשמרת" required error={save.fieldErrors.name}>
        {(props) => (
          <input {...props} type="text" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="בוקר / ערב / לילה" />
        )}
      </Field>

      <div className="grid grid-2">
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

      {crossesMidnight && (
        <Notice tone="warn" icon="🌙" title="משמרת שחוצה חצות">
          המשמרת תסתיים ביום שלמחרת. היא אפשרית רק באתר שפעיל מסביב לשעון.
        </Notice>
      )}

      <div className="grid grid-2">
        <Field label="תקן כוח אדם" hint="כמה אנשים נדרשים למשמרת">
          {(props) => (
            <input {...props} type="number" min={0} max={99} value={form.requiredStaff}
              onChange={(e) => setForm({ ...form, requiredStaff: Number(e.target.value) })} />
          )}
        </Field>
        <Field label="תחום">
          {(props) => (
            <select {...props} value={form.domainId} onChange={(e) => setForm({ ...form, domainId: e.target.value })}>
              <option value="">כל התחומים</option>
              {(domains.data?.domains ?? []).map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>
          )}
        </Field>
      </div>

      <label className="check">
        <input
          type="checkbox"
          checked={form.isMandatory}
          onChange={(e) => setForm({ ...form, isMandatory: e.target.checked })}
        />
        <span>
          <span className="bold">משמרת חובה</span>
          <div className="small muted">
            מטמיע שיסמן ״לא יכול״ עליה יועבר אוטומטית לאישור מיוחד שלך.
          </div>
        </span>
      </label>
    </Modal>
  );
}

function LocationForm({ siteId, location, onClose, onSaved }) {
  const toast = useToast();
  const types = useApi('/api/settings/location-types');

  const [form, setForm] = useState({
    name: location?.name ?? '',
    description: location?.description ?? '',
    locationTypeId: location?.location_type_id ?? '',
    isActive: location?.is_active ?? true,
  });

  const save = useAction(
    async () => {
      const result = await post(
        `/api/sites/${siteId}/locations`,
        { ...form, id: location?.id, locationTypeId: form.locationTypeId || null },
        { ifMatch: location?.row_version },
      );
      onSaved(result.location);
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal
      title={location ? `עריכת ${location.name}` : 'מיקום חדש'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="שם המיקום" required error={save.fieldErrors.name}>
        {(props) => (
          <input {...props} type="text" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        )}
      </Field>

      <Field
        label="סוג המיקום"
        hint={
          location
            ? 'שינוי הסוג אינו משנה את המשמרות הקיימות. אפשר להוסיף מהתבנית בכפתור ״העתקה מתבנית״.'
            : 'מיקום חדש מקבל את המשמרות מהתבנית של הסוג, לפי התקופה הנוכחית באתר. אפשר לערוך אותן אחר כך.'
        }
      >
        {(props) => (
          <select {...props} value={form.locationTypeId}
            onChange={(e) => setForm({ ...form, locationTypeId: e.target.value })}>
            <option value="">ללא סוג מוגדר</option>
            {(types.data?.locationTypes ?? []).map((t) => (
              <option key={t.id} value={t.id}>{t.name}</option>
            ))}
          </select>
        )}
      </Field>

      <Field label="תיאור">
        {(props) => (
          <input {...props} type="text" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        )}
      </Field>

      <label className="check">
        <input type="checkbox" checked={form.isActive}
          onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />
        מיקום פעיל
      </label>
    </Modal>
  );
}

const Info = ({ label, value }) => (
  <div>
    <div className="field-label">{label}</div>
    <div>{value}</div>
  </div>
);
