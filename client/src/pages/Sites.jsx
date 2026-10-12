import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post, patch, put, del } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, Accordion, Empty, ConfirmDialog, Segmented,
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
            {site.go_live_date && <Tag>עלייה לאוויר: {fmtDateFull(site.go_live_date)}</Tag>}
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
  { value: 'support', label: 'ליווי' },
];
const PERIOD_NAME = Object.fromEntries(PERIODS.map((p) => [p.value, p.label]));
const CATEGORIES = [
  { value: 'morning', label: 'בוקר' },
  { value: 'afternoon', label: 'צהריים' },
  { value: 'night', label: 'לילה' },
];
const CATEGORY_NAME = Object.fromEntries(CATEGORIES.map((c) => [c.value, c.label]));
/** אותה גזירה שבמסד: 05–12 בוקר, 12–19 צהריים, השאר לילה */
const categoryFor = (start) => (start >= '05:00' && start < '12:00' ? 'morning' : start >= '12:00' && start < '19:00' ? 'afternoon' : 'night');

function SiteDetail({ siteId }) {
  const toast = useToast();
  const detail = useApi(`/api/sites/${siteId}`);
  const [locationForm, setLocationForm] = useState(null);
  const [copyDomain, setCopyDomain] = useState(false);

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
            <Info
              label="השלב היום"
              value={<span className={`phase phase-${data.phaseToday}`}>{PERIOD_NAME[data.phaseToday]}</span>}
            />
          </div>

          <PhasesEditor siteId={siteId} site={data.site} periods={data.periods} onSaved={detail.reload} />

          {/* מיקומים, ולכל מיקום המשמרות שלו */}
          <Panel
            title="מיקומים ומשמרות"
            subtitle="לכל מיקום שעות משלו. משמרת חובה: סימון ״לא יכול״ על השעות שלה מעביר את ההגשה לאישור מיוחד"
            actions={
              <>
                <button type="button" className="btn btn-sm" onClick={() => setCopyDomain(true)}>
                  העתקת שעות מתחום…
                </button>
                <button type="button" className="btn btn-sm btn-primary" onClick={() => setLocationForm({})}>
                  + מיקום
                </button>
              </>
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

          {data.locations.some((l) => l.rotation_cycle) && (
            <RotationsPanel siteId={siteId} locations={data.locations.filter((l) => l.rotation_cycle)} />
          )}

          {copyDomain && (
            <CopyDomainShifts
              siteId={siteId}
              locations={data.locations}
              onClose={() => setCopyDomain(false)}
              onDone={(r) => {
                setCopyDomain(false);
                detail.reload();
                toast.success(`הועתקו ${r.created} משמרות${r.replaced ? `, הוחלפו ${r.replaced}` : ''}${r.skipped ? `, ${r.skipped} כבר היו קיימות` : ''}`);
                if (r.missingLocations?.length) toast.warn(`באתר היעד אין מיקום בשם: ${r.missingLocations.join(', ')}`);
              }}
            />
          )}

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
                    ? `המיקום נשמר, ונוספו ${saved.copiedShifts} משמרות ממאגר המיקומים`
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

/**
 * המטמיעים שעובדים בסבב שבועי. לכל אחד שבוע עוגן וסוג המשמרת שלו באותו שבוע;
 * הסוג של שבוע אחר נגזר מהסידור שפורסם לפניו, ובהיעדרו — מהעוגן.
 */
function RotationsPanel({ siteId, locations }) {
  const toast = useToast();
  const data = useApi(`/api/sites/${siteId}/rotations`);
  const people = useApi('/api/users', { siteId, status: 'active', limit: 300 });
  const [rows, setRows] = useState(null);

  useEffect(() => {
    if (data.data) {
      setRows(data.data.rotations.map((r) => ({
        userId: r.user_id, locationId: r.location_id, anchorWeek: r.anchor_week, anchorCategory: r.anchor_category,
        thisWeek: r.thisWeek, nextWeek: r.nextWeek,
      })));
    }
  }, [data.data]);

  const implementers = (people.data?.users ?? []).filter((u) => ['implementer', 'lead'].includes(u.base_role));
  const cycleOf = (locationId) => locations.find((l) => l.id === locationId)?.rotation_cycle ?? [];
  const dirty = rows && data.data && JSON.stringify(rows.map(strip)) !== JSON.stringify(data.data.rotations.map((r) => strip({
    userId: r.user_id, locationId: r.location_id, anchorWeek: r.anchor_week, anchorCategory: r.anchor_category,
  })));

  const save = useAction(
    async () => {
      const result = await put(`/api/sites/${siteId}/rotations`, {
        rotations: rows.filter((r) => r.userId && r.locationId).map(strip),
      });
      data.setData(result);
      toast.success('הסבב נשמר');
    },
    { onError: (err) => toast.error(err) },
  );

  const update = (i, patchRow) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patchRow, thisWeek: null, nextWeek: null } : r)));
  const sunday = (() => {
    const d = new Date(`${today()}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - d.getUTCDay());
    return d.toISOString().slice(0, 10);
  })();

  return (
    <Panel
      title="סבב שבועי"
      subtitle="מטמיעים שעובדים במתכונת שבוע־שבוע. הסוג של כל שבוע נגזר ממה שעבדו בסידור שפורסם לפניו; העוגן משמש כשאין סידור כזה"
      actions={
        <>
          <button type="button" className="btn btn-sm"
            onClick={() => setRows([...(rows ?? []), {
              userId: '', locationId: locations[0].id, anchorWeek: sunday, anchorCategory: locations[0].rotation_cycle[0],
            }])}>
            + מטמיע לסבב
          </button>
          <button type="button" className="btn btn-sm btn-primary" onClick={() => save.run()} disabled={!dirty || save.busy}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
        </>
      }
      flush
    >
      <StateView loading={data.loading || !rows} error={data.error} onRetry={data.reload}
        empty={rows && rows.length === 0}
        emptyProps={{ icon: '🔄', title: 'אין עדיין מטמיעים בסבב', text: 'רק מטמיעים שיתווספו כאן יגישו זמינות לפי הסבב.' }}>
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr><th>מטמיע</th><th>מיקום</th><th>שבוע עוגן</th><th>סוג בשבוע העוגן</th><th>השבוע</th><th>שבוע הבא</th><th /></tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r, i) => (
                <tr key={i}>
                  <td data-label="מטמיע">
                    <select value={r.userId} onChange={(e) => update(i, { userId: e.target.value })} aria-label="מטמיע" style={{ minWidth: 140 }}>
                      <option value="">בחירה…</option>
                      {implementers.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                    </select>
                  </td>
                  <td data-label="מיקום">
                    <select value={r.locationId} aria-label="מיקום" style={{ minWidth: 120 }}
                      onChange={(e) => update(i, { locationId: e.target.value, anchorCategory: cycleOf(e.target.value)[0] })}>
                      {locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                  </td>
                  <td data-label="שבוע עוגן">
                    <input type="date" value={r.anchorWeek} aria-label="שבוע עוגן" step={7}
                      onChange={(e) => update(i, { anchorWeek: e.target.value })} />
                  </td>
                  <td data-label="סוג בשבוע העוגן">
                    <select value={r.anchorCategory} onChange={(e) => update(i, { anchorCategory: e.target.value })} aria-label="סוג משמרת" style={{ minWidth: 90 }}>
                      {cycleOf(r.locationId).map((c) => <option key={c} value={c}>{CATEGORY_NAME[c]}</option>)}
                    </select>
                  </td>
                  <td data-label="השבוע"><RotationWeek info={r.thisWeek} /></td>
                  <td data-label="שבוע הבא"><RotationWeek info={r.nextWeek} /></td>
                  <td>
                    <button type="button" className="btn btn-sm btn-ghost" aria-label="הסרה מהסבב"
                      onClick={() => setRows(rows.filter((_, j) => j !== i))}>✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </StateView>
    </Panel>
  );
}

const strip = ({ userId, locationId, anchorWeek, anchorCategory }) => ({ userId, locationId, anchorWeek, anchorCategory });

function RotationWeek({ info }) {
  if (!info) return <span className="muted">—</span>;
  return (
    <span title={info.source.kind === 'roster' ? `לפי הסידור של שבוע ${fmtDateFull(info.source.week)}` : 'לפי העוגן'}>
      <Tag tone="accent">{CATEGORY_NAME[info.category]}</Tag>
    </span>
  );
}

/** מיקום אחד: פרטים, והמשמרות שלו */
function LocationShifts({ siteId, location, onEdit, onChanged }) {
  const toast = useToast();
  const [shiftForm, setShiftForm] = useState(null);
  const [templateOpen, setTemplateOpen] = useState(false);
  const periods = location.periods ?? PERIODS.map((p) => p.value);
  const [phase, setPhase] = useState('all');
  const allShifts = location.shiftTypes.filter((s) => s.is_active);
  const shifts = allShifts.filter((s) => phase === 'all' || !s.period || s.period === phase);
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
          {allShifts.length} משמרות
          {location.rotation_cycle && (
            <Tag tone="accent">סבב: {location.rotation_cycle.map((c) => CATEGORY_NAME[c]).join(' ← ')}</Tag>
          )}
          {periods.length < 3 && periods.map((p) => (
            <span key={p} className={`phase phase-${p}`}>{PERIOD_NAME[p]}</span>
          ))}
        </>
      }
      actions={
        <>
          <button type="button" className="btn btn-sm btn-primary"
            onClick={() => setShiftForm({ period: phase === 'all' ? null : phase })}>
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

      {allShifts.some((s) => s.period) && (
        <div style={{ marginBlockEnd: 'var(--space-3)' }}>
          <Segmented
            label={`שלב — ${location.name}`}
            value={phase}
            onChange={setPhase}
            options={[{ value: 'all', label: 'כל השלבים' }, ...PERIODS.filter((p) => periods.includes(p.value))]}
          />
        </div>
      )}

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
              <tr><th>שם</th><th>שעות</th><th>סוג</th><th>שלב</th><th>חובה</th><th>תקן</th><th>תחום</th><th /></tr>
            </thead>
            <tbody>
              {shifts.map((shift) => (
                <tr key={shift.id}>
                  <td data-label="שם" className="bold">{shift.name}</td>
                  <td data-label="שעות" className="tnum">
                    {fmtClock(shift.start_time)}–{fmtClock(shift.end_time)}
                    {shift.crosses_midnight && <Tag tone="accent"> חוצה חצות</Tag>}
                  </td>
                  <td data-label="סוג">{CATEGORY_NAME[shift.category] ?? '—'}</td>
                  <td data-label="שלב">
                    {shift.period
                      ? <span className={`phase phase-${shift.period}`}>{PERIOD_NAME[shift.period]}</span>
                      : <span className="muted small">כל השלבים</span>}
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
          defaultPeriod={shiftForm.period ?? null}
          periods={periods}
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
  const [period, setPeriod] = useState('');

  const copy = useAction(
    async () => onDone(await post(endpoint, period ? { period } : {})),
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
        יתווספו המשמרות שמוגדרות במאגר המיקומים ל״{location.location_type_name}״, כל אחת מתויגת
        בשלב שלה. משמרת שכבר קיימת במיקום באותו שם ובאותו שלב לא תשתנה.
      </p>
      <Field label="שלב">
        {(props) => (
          <select {...props} value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">כל השלבים</option>
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
              <option value="golive">עלייה לאוויר</option>
              <option value="support">ליווי</option>
              <option value="ended">הסתיים</option>
            </select>
          )}
        </Field>

        <Field label="תאריך עלייה לאוויר" hint="עד התאריך הזה האתר בהכשרה, ומהתאריך — המיקומים והשעות של העלייה לאוויר">
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

function ShiftForm({ endpoint, locationName, shift, defaultPeriod, periods, onClose, onSaved }) {
  const toast = useToast();
  const domains = useApi('/api/settings/domains');

  const [form, setForm] = useState({
    name: shift?.name ?? '',
    startTime: fmtClock(shift?.start_time) || '06:00',
    endTime: fmtClock(shift?.end_time) || '14:00',
    isMandatory: shift?.is_mandatory ?? false,
    requiredStaff: shift?.required_staff ?? 1,
    domainId: shift?.domain_id ?? '',
    category: shift?.category ?? '',
    period: shift ? (shift.period ?? '') : (defaultPeriod ?? ''),
  });

  const save = useAction(
    async () => {
      await post(
        endpoint,
        {
          ...form,
          id: shift?.id,
          domainId: form.domainId || null,
          category: form.category || categoryFor(form.startTime),
          period: form.period || null,
        },
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

      <div className="grid grid-2">
        <Field label="סוג משמרת" hint="נספר בכלל מינימום המשמרות בהגשת זמינות">
          {(props) => (
            <select {...props} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="">אוטומטי ({CATEGORY_NAME[categoryFor(form.startTime)]})</option>
              {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          )}
        </Field>
        <Field label="שלב" hint="משמרת של שלב מסוים מתחלפת לבד בתאריך העלייה לאוויר">
          {(props) => (
            <select {...props} value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
              <option value="">כל השלבים</option>
              {PERIODS.filter((p) => (periods ?? []).includes(p.value)).map((p) => (
                <option key={p.value} value={p.value}>{p.label}</option>
              ))}
            </select>
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

/**
 * מיקום באתר. השם נבחר ממאגר המיקומים (כל מיקום שהוקם פעם נשמר בו),
 * ואפשר גם להקליד שם חדש — הוא יישמר במאגר לפעם הבאה.
 */
function LocationForm({ siteId, location, onClose, onSaved }) {
  const toast = useToast();
  const types = useApi('/api/settings/location-types');
  const catalog = (types.data?.locationTypes ?? []).filter((t) => t.is_active !== false);

  const [form, setForm] = useState({
    name: location?.name ?? '',
    description: location?.description ?? '',
    isActive: location?.is_active ?? true,
    periods: location?.periods ?? ['training', 'golive', 'support'],
    rotationCycle: location?.rotation_cycle ?? null,
  });

  const match = useMemo(
    () => catalog.find((t) => t.name.trim() === form.name.trim()),
    [catalog, form.name],
  );

  const save = useAction(
    async () => {
      const result = await post(
        `/api/sites/${siteId}/locations`,
        {
          ...form,
          id: location?.id,
          locationTypeId: location ? (location.location_type_id ?? match?.id ?? null) : (match?.id ?? null),
        },
        { ifMatch: location?.row_version },
      );
      onSaved(result.location);
    },
    { onError: (err) => toast.error(err) },
  );

  const togglePeriod = (p) =>
    setForm((f) => ({
      ...f,
      periods: f.periods.includes(p) ? f.periods.filter((x) => x !== p) : [...f.periods, p],
    }));

  return (
    <Modal
      title={location ? `עריכת ${location.name}` : 'מיקום חדש'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()}
            disabled={save.busy || !form.name.trim() || form.periods.length === 0
              || (form.rotationCycle && form.rotationCycle.length < 2)}>
            {save.busy ? 'שומר…' : 'שמירה'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field
        label="שם המיקום"
        required
        error={save.fieldErrors.name}
        hint={
          location
            ? undefined
            : match
              ? `נמצא במאגר המיקומים — המשמרות שהוגדרו לו יועתקו לכל שלב`
              : form.name.trim()
                ? 'מיקום חדש — יישמר במאגר המיקומים, ויופיע ברשימה בפעם הבאה'
                : 'בחרו מהרשימה או הקלידו שם חדש'
        }
      >
        {(props) => (
          <>
            <input {...props} type="text" list={`catalog-${siteId}`} value={form.name}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, name: e.target.value })} />
            <datalist id={`catalog-${siteId}`}>
              {catalog.map((t) => <option key={t.id} value={t.name} />)}
            </datalist>
          </>
        )}
      </Field>

      <Field label="פעיל בשלבים" hint="למשל כיתת הדרכה — רק בהכשרה. המיקום יוצג בסידור ובזמינות רק בתאריכים של השלבים שנבחרו">
        {() => (
          <div className="row" style={{ gap: 6 }}>
            {PERIODS.map((p) => (
              <button key={p.value} type="button" className="chip"
                aria-pressed={form.periods.includes(p.value)} onClick={() => togglePeriod(p.value)}>
                {p.label}
              </button>
            ))}
          </div>
        )}
      </Field>

      <Field label="תיאור">
        {(props) => (
          <input {...props} type="text" value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })} />
        )}
      </Field>

      <Field
        label="מתכונת עבודה"
        hint={form.rotationCycle
          ? 'שבוע־שבוע: כל שבוע המטמיע עובד בסוג משמרת אחד, ובשבוע הבא עובר לסוג הבא בסדר. לחיצה על סוג מוסיפה או מסירה אותו מהסדר'
          : 'רגילה: המטמיע מגיש זמינות לכל המשמרות'}
      >
        {() => (
          <div className="stack" style={{ gap: 8 }}>
            <Segmented
              label="מתכונת עבודה"
              value={form.rotationCycle ? 'rotation' : 'regular'}
              onChange={(v) => setForm({ ...form, rotationCycle: v === 'rotation' ? CATEGORIES.map((c) => c.value) : null })}
              options={[{ value: 'regular', label: 'רגילה' }, { value: 'rotation', label: 'סבב שבועי (שבוע־שבוע)' }]}
            />
            {form.rotationCycle && (
              <>
                <div className="row" style={{ gap: 6 }}>
                  {CATEGORIES.map((c) => {
                    const idx = form.rotationCycle.indexOf(c.value);
                    return (
                      <button key={c.value} type="button" className="chip" aria-pressed={idx >= 0}
                        onClick={() => setForm({
                          ...form,
                          rotationCycle: idx >= 0
                            ? form.rotationCycle.filter((x) => x !== c.value)
                            : [...form.rotationCycle, c.value],
                        })}>
                        {idx >= 0 && <span className="tnum">{idx + 1}. </span>}{c.label}
                      </button>
                    );
                  })}
                </div>
                <div className="small muted">
                  {form.rotationCycle.length >= 2
                    ? `סדר הסבב: ${[...form.rotationCycle, form.rotationCycle[0]].map((c) => CATEGORY_NAME[c]).join(' ← ')}`
                    : 'יש לבחור לפחות שני סוגי משמרת'}
                </div>
              </>
            )}
          </div>
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

/**
 * מועדי השלבים של האתר. בלי הגדרה כאן — השלב נגזר מתאריך העלייה לאוויר:
 * לפניו הכשרה, ממנו והלאה עלייה לאוויר.
 */
function PhasesEditor({ siteId, site, periods, onSaved }) {
  const toast = useToast();
  const initial = Object.fromEntries(
    PERIODS.map((p) => {
      const row = periods.find((x) => x.period === p.value);
      return [p.value, { startsOn: row?.starts_on ?? '', endsOn: row?.ends_on ?? '' }];
    }),
  );
  const [form, setForm] = useState(initial);
  const [open, setOpen] = useState(false);

  const save = useAction(
    async () => {
      const list = PERIODS
        .map((p) => ({ period: p.value, ...form[p.value] }))
        .filter((p) => p.startsOn && p.endsOn);
      await put(`/api/sites/${siteId}/periods`, { periods: list });
      toast.success('מועדי השלבים נשמרו');
      setOpen(false);
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  const summary = periods.length
    ? periods.map((p) => `${PERIOD_NAME[p.period]} מ־${fmtDateFull(p.starts_on)} עד ${fmtDateFull(p.ends_on)}`).join(' · ')
    : site.go_live_date
      ? `הכשרה עד ${fmtDateFull(site.go_live_date)}, ומשם עלייה לאוויר`
      : 'לא הוגדרו מועדים — האתר נחשב בשלב לפי הסטטוס שלו';

  return (
    <Panel
      title="שלבי האתר"
      subtitle={summary}
      actions={
        <button type="button" className="btn btn-sm" onClick={() => setOpen((v) => !v)}>
          {open ? 'סגירה' : 'עריכת מועדים'}
        </button>
      }
    >
      {open ? (
        <>
          {PERIODS.map((p) => (
            <div key={p.value} className="grid grid-3" style={{ alignItems: 'end' }}>
              <div className="field"><span className={`phase phase-${p.value}`}>{p.label}</span></div>
              <Field label="מתאריך">
                {(props) => (
                  <input {...props} type="date" value={form[p.value].startsOn}
                    onChange={(e) => setForm({ ...form, [p.value]: { ...form[p.value], startsOn: e.target.value } })} />
                )}
              </Field>
              <Field label="עד תאריך">
                {(props) => (
                  <input {...props} type="date" value={form[p.value].endsOn}
                    onChange={(e) => setForm({ ...form, [p.value]: { ...form[p.value], endsOn: e.target.value } })} />
                )}
              </Field>
            </div>
          ))}
          <p className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
            שלב בלי שני תאריכים אינו נשמר. תאריך שאינו בשום שלב נקבע לפי תאריך העלייה לאוויר.
          </p>
          <button type="button" className="btn btn-primary btn-sm" onClick={() => save.run()} disabled={save.busy}>
            {save.busy ? 'שומר…' : 'שמירת מועדים'}
          </button>
        </>
      ) : (
        <p className="small muted">
          המיקומים והשעות בסידור ובהגשת הזמינות מתחלפים לבד לפי השלב של כל יום.
        </p>
      )}
    </Panel>
  );
}

/** העתקת שעות משמרת מתחום לתחום — באותו אתר או לאתר אחר */
function CopyDomainShifts({ siteId, locations, onClose, onDone }) {
  const toast = useToast();
  const domains = useApi('/api/settings/domains');
  const sites = useApi('/api/sites');
  const [form, setForm] = useState({
    fromDomainId: '', toDomainId: '', targetSiteId: siteId, locationIds: [], period: '', mode: 'merge',
  });

  const domainList = domains.data?.domains ?? [];
  const sourceCount = locations
    .filter((l) => !form.locationIds.length || form.locationIds.includes(l.id))
    .flatMap((l) => l.shiftTypes)
    .filter((s) => s.domain_id === form.fromDomainId && (!form.period || s.period === form.period)).length;

  const copy = useAction(
    async () =>
      onDone(await post(`/api/sites/${siteId}/shift-types/copy-domain`, {
        fromDomainId: form.fromDomainId,
        toDomainId: form.toDomainId,
        targetSiteId: form.targetSiteId === siteId ? null : form.targetSiteId,
        locationIds: form.locationIds.length ? form.locationIds : null,
        period: form.period || null,
        mode: form.mode,
      })),
    { onError: (err) => toast.error(err) },
  );

  const ready = form.fromDomainId && form.toDomainId &&
    (form.fromDomainId !== form.toDomainId || form.targetSiteId !== siteId) && sourceCount > 0;

  return (
    <Modal
      title="העתקת שעות משמרת מתחום לתחום"
      onClose={onClose}
      width={600}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => copy.run()} disabled={!ready || copy.busy}>
            {copy.busy ? 'מעתיק…' : `העתקת ${sourceCount} משמרות`}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <StateView loading={domains.loading} error={domains.error} onRetry={domains.reload}>
        <div className="grid grid-2">
          <Field label="מתחום" required>
            {(props) => (
              <select {...props} value={form.fromDomainId} onChange={(e) => setForm({ ...form, fromDomainId: e.target.value })}>
                <option value="">בחירה</option>
                {domainList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
          </Field>
          <Field label="לתחום" required>
            {(props) => (
              <select {...props} value={form.toDomainId} onChange={(e) => setForm({ ...form, toDomainId: e.target.value })}>
                <option value="">בחירה</option>
                {domainList.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            )}
          </Field>
        </div>

        <div className="grid grid-2">
          <Field label="לאתר" hint="באתר אחר — למיקום באותו שם">
            {(props) => (
              <select {...props} value={form.targetSiteId} onChange={(e) => setForm({ ...form, targetSiteId: e.target.value })}>
                {(sites.data?.sites ?? []).map((s) => (
                  <option key={s.id} value={s.id}>{s.id === siteId ? `${s.name} (האתר הזה)` : s.name}</option>
                ))}
              </select>
            )}
          </Field>
          <Field label="שלב">
            {(props) => (
              <select {...props} value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })}>
                <option value="">כל השלבים</option>
                {PERIODS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            )}
          </Field>
        </div>

        <Field label="מיקומים" hint="בלי בחירה — כל המיקומים">
          {() => (
            <div className="row" style={{ gap: 6 }}>
              {locations.map((l) => {
                const on = form.locationIds.includes(l.id);
                return (
                  <button key={l.id} type="button" className="chip" aria-pressed={on}
                    onClick={() => setForm({
                      ...form,
                      locationIds: on ? form.locationIds.filter((x) => x !== l.id) : [...form.locationIds, l.id],
                    })}>
                    {l.name}
                  </button>
                );
              })}
            </div>
          )}
        </Field>

        <Field label="אם לתחום היעד כבר יש משמרות">
          {() => (
            <Segmented
              label="מצב העתקה"
              value={form.mode}
              onChange={(mode) => setForm({ ...form, mode })}
              options={[
                { value: 'merge', label: 'להוסיף רק מה שחסר' },
                { value: 'replace', label: 'להחליף את הקיימות' },
              ]}
            />
          )}
        </Field>

        {form.fromDomainId && sourceCount === 0 && (
          <Notice tone="warn" icon="⚠">לתחום המקור אין משמרות לפי הבחירה. משמרת מתויגת בתחום בטופס המשמרת.</Notice>
        )}
      </StateView>
    </Modal>
  );
}

const Info = ({ label, value }) => (
  <div>
    <div className="field-label">{label}</div>
    <div>{value}</div>
  </div>
);
