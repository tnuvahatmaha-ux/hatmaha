import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { get, post, put, patch, newIdempotencyKey } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, Segmented, Empty,
} from '../components/ui/index.jsx';
import {
  fmtDate, fmtDateTime, fmtWeekRange, dayName, dayShort, today, addDays,
  AVAIL_VALUES, STATUS_NAMES, statusTone,
} from '../lib/format.js';

/**
 * בקשות וזמינות — המסך המרכזי של המטמיע.
 *
 * שני חלקים: בקשות אילוץ, והצהרת הזמינות השבועית כמטריצת יום × משמרת.
 * שניהם מציגים בדיקה מקדימה לפני השליחה, כפי ש-§7 דורש: המשתמש יודע
 * מראש אם הבקשה תקינה, דורשת אישור או חסומה.
 */
export default function Requests() {
  const [tab, setTab] = useState('availability');

  return (
    <>
      <ViewHead
        title="בקשות וזמינות"
        subtitle="הצהרת זמינות לשבוע הבא, ובקשות חופשה ואילוצי שעות"
        actions={
          <Segmented
            label="מעבר בין בקשות לזמינות"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'availability', label: 'זמינות' },
              { value: 'constraints', label: 'בקשות אילוץ' },
            ]}
          />
        }
      />
      {tab === 'availability' ? <AvailabilityTab /> : <ConstraintsTab />}
    </>
  );
}

/* ==========================================================================
   מטריצת הזמינות
   ========================================================================== */

function AvailabilityTab() {
  const toast = useToast();
  const { sites } = usePermissions();

  const [siteId, setSiteId] = useState(sites[0]?.id ?? '');
  useEffect(() => {
    if (!siteId && sites.length) setSiteId(sites[0].id);
  }, [sites, siteId]);

  const window = useApi(siteId ? '/api/availability/window' : null, { siteId });
  const win = window.data;

  const declarations = useApi(
    win?.weekStart && siteId ? '/api/availability/declarations' : null,
    { siteId, weekStart: win?.weekStart },
  );
  const current = declarations.data?.declarations?.[0];

  /**
   * המטריצה כמפה 'תאריך|HH:MM-HH:MM' → ערך.
   * העמודות הן חלונות השעות של האתר ולא משמרות: לכל מיקום משמרות משלו,
   * ומיקומים עם אותן שעות חולקים עמודה אחת.
   */
  const [cells, setCells] = useState({});
  const [note, setNote] = useState('');
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (!current) {
      setCells({});
      setNote('');
      return;
    }
    const next = {};
    for (const cell of current.cells ?? []) {
      next[`${cell.cell_date}|${windowKey(cell.start_time, cell.end_time)}`] = cell.value;
    }
    setCells(next);
    setNote(current.note ?? '');
  }, [current?.id, current?.revision]);

  const decided = ['approved', 'rejected'].includes(current?.status);
  const readOnly = decided;

  const counts = useMemo(() => {
    const values = Object.values(cells);
    return {
      cannot: values.filter((v) => v === 'cannot').length,
      preferNot: values.filter((v) => v === 'prefer_not').length,
    };
  }, [cells]);

  const overCannot = win && counts.cannot > win.limits.maxCannot;
  const overPreferNot = win && counts.preferNot > win.limits.maxPreferNot;

  const mandatoryCannot = useMemo(() => {
    if (!win) return [];
    return Object.entries(cells)
      .filter(([, value]) => value === 'cannot')
      .map(([key]) => key.split('|'))
      .map(([date, key]) => ({ date, window: win.windows.find((w) => w.key === key) }))
      .filter(({ window }) => window?.isMandatory)
      .map(({ date, window }) => ({
        date,
        key: window.key,
        shiftName: `${window.label} ${window.startTime}–${window.endTime}`,
      }));
  }, [cells, win]);

  const willNeedApproval = overCannot || overPreferNot || mandatoryCannot.length > 0;

  /** משמרות "זמין" לפי סוג — אותה ספירה שהשרת עושה בבדיקת המינימום */
  const available = useMemo(() => countAvailable(win?.windows ?? [], cells), [win, cells]);

  /** סבב שבועי: הסוג של המטמיע השבוע נעול על "יכול", והסוגים האחרים בסבב לא נדרשים */
  const rotation = win?.rotation ?? null;
  const rotationLock = (w) =>
    !rotation ? null
      : rotation.categories.includes(w.category) ? 'required'
        : rotation.exempt.includes(w.category) ? 'exempt' : null;

  /** לחיצה מחליפה בין יכול → מעדיף שלא → לא יכול → יכול */
  const cycle = (date, windowKeyValue) => {
    if (readOnly) return;
    if (rotationLock(win.windows.find((w) => w.key === windowKeyValue) ?? {})) return;
    const key = `${date}|${windowKeyValue}`;
    const order = ['can', 'prefer_not', 'cannot'];
    const currentValue = cells[key] ?? 'can';
    const next = order[(order.indexOf(currentValue) + 1) % order.length];
    setCells((c) => ({ ...c, [key]: next }));
    setPreview(null);
  };

  const toCellArray = () =>
    Object.entries(cells)
      .filter(([, value]) => value !== 'can')
      .filter(([key]) => {
        const [date, range] = key.split('|');
        const w = win.windows.find((x) => x.key === range);
        return w && activeOn(w, date) && !rotationLock(w);
      })
      .map(([key, value]) => {
        const [date, range] = key.split('|');
        const [startTime, endTime] = range.split('-');
        return { date, startTime, endTime, value };
      });

  const saveDraft = useAction(
    async () => {
      const { declarationId } = await put('/api/availability/declarations', {
        siteId,
        weekStart: win.weekStart,
        note: note || null,
        cells: toCellArray(),
      });
      return declarationId;
    },
    { onError: (err) => toast.error(err) },
  );

  const runPreview = useAction(
    async () => {
      const declarationId = await saveDraft.run();
      if (!declarationId) return null;
      const result = await post(`/api/availability/declarations/${declarationId}/preview`);
      setPreview(result);
      return result;
    },
    { onError: (err) => toast.error(err) },
  );

  const submit = useAction(
    async () => {
      const declarationId = await saveDraft.run();
      if (!declarationId) return;
      const result = await post(
        `/api/availability/declarations/${declarationId}/submit`,
        {},
        { idempotencyKey: newIdempotencyKey() },
      );
      if (result.status === 'pending_approval') {
        toast.warn('הזמינות הוגשה והועברה לאישור מיוחד של המנהל');
      } else {
        toast.success('הזמינות הוגשה בהצלחה');
      }
      setPreview(null);
      declarations.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const busy = saveDraft.busy || submit.busy || runPreview.busy;

  return (
    <StateView loading={window.loading} error={window.error} onRetry={window.reload}>
      {sites.length > 1 && (
        <Panel title="אתר">
          <Field label="הזמינות מוגשת לאתר">
            {(props) => (
              <select {...props} value={siteId} onChange={(e) => setSiteId(e.target.value)}>
                {sites.map((site) => (
                  <option key={site.id} value={site.id}>{site.name}</option>
                ))}
              </select>
            )}
          </Field>
        </Panel>
      )}

      {!win?.siteId ? (
        <Panel>
          <Empty
            icon="🏥"
            title="עדיין לא שויכת לאתר"
            text="הגשת זמינות אפשרית רק אחרי שיוך לאתר. פנה/י למנהל ההטמעה."
          />
        </Panel>
      ) : win.windows.length === 0 ? (
        <Panel>
          <Empty
            icon="🕐"
            title="לא הוגדרו משמרות לאתר הזה"
            text="לא ניתן להגיש זמינות עד שמנהל ההטמעה יגדיר משמרות למיקומי האתר."
          />
        </Panel>
      ) : (
        <Panel
          title={`זמינות לשבוע ${fmtWeekRange(win.weekStart)}`}
          subtitle="כל עמודה היא טווח שעות שקיים באחד המיקומים באתר. לחיצה על תא מחליפה בין יכול, מעדיף שלא, ולא יכול"
          actions={
            current && (
              <Tag tone={statusTone(current.status)}>
                {STATUS_NAMES[current.status] ?? current.status}
                {current.revision > 1 && ` · גרסה ${current.revision}`}
              </Tag>
            )
          }
        >
          {!win.isOpen && (
            <Notice tone="warn" icon="⏰" title="מועד ההגשה נסגר">
              ההגשה עדיין אפשרית, אך היא תועבר לאישור מיוחד של המנהל.
            </Notice>
          )}

          {decided && (
            <Notice tone={current.status === 'approved' ? 'ok' : 'danger'} icon={current.status === 'approved' ? '✓' : '✕'}
              title={current.status === 'approved' ? 'ההצהרה אושרה' : 'ההצהרה נדחתה'}>
              <div>{current.decision_note}</div>
              <div className="small mt-3">
                כדי לשנות את הזמינות יש להגיש הצהרה חדשה — ההחלטה הקיימת נשמרת בהיסטוריה.
              </div>
              <button
                type="button"
                className="btn btn-sm mt-3"
                onClick={() => submit.run()}
                disabled={busy}
              >
                פתיחת גרסה חדשה
              </button>
            </Notice>
          )}

          {rotation && (
            <Notice icon="🔄" title={`השבוע את/ה בסבב ${rotation.categories.map((c) => CATEGORY_NAMES[c]).join(' / ')}`}>
              {rotation.locations.map((l) => l.locationName).join(', ')} עובד/ת במתכונת שבוע־שבוע.
              יש להיות זמין/ה בכל משמרות ה{rotation.categories.map((c) => CATEGORY_NAMES[c]).join(' / ')} השבוע
              {rotation.exempt.length > 0 && `, ואין צורך לסמן זמינות ל${rotation.exempt.map((c) => CATEGORY_NAMES[c]).join(' ול')}`}.
              להיעדרות יש להגיש בקשת אילוץ.
            </Notice>
          )}

          {win.minimums && <QuotaBar minimums={win.minimums} available={available} exempt={rotation?.exempt ?? []} />}

          <AvailabilityGrid
            days={win.days}
            phases={win.phases ?? {}}
            windows={win.windows}
            cells={cells}
            onCycle={cycle}
            readOnly={readOnly}
            lockOf={rotationLock}
          />

          <div className="row mt-3" style={{ justifyContent: 'space-between' }}>
            <div className="legend">
              {Object.entries(AVAIL_VALUES).map(([key, meta]) => (
                <span className="legend-item" key={key}>
                  <span className={`legend-swatch avail-${key}`} />
                  {meta.label}
                </span>
              ))}
              <span className="legend-item">
                <span className="mandatory-dot" />
                משמרת חובה
              </span>
            </div>

            <div className="row">
              <Tag tone={overCannot ? 'danger' : ''}>
                לא יכול: {counts.cannot}/{win.limits.maxCannot}
              </Tag>
              <Tag tone={overPreferNot ? 'danger' : ''}>
                מעדיף שלא: {counts.preferNot}/{win.limits.maxPreferNot}
              </Tag>
            </div>
          </div>

          {willNeedApproval && !readOnly && (
            <Notice tone="warn" icon="⚠" title="ההגשה חורגת מהכללים שהוגדרו">
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {overCannot && (
                  <li>סומנו {counts.cannot} תאי "לא יכול", מעל המכסה של {win.limits.maxCannot}</li>
                )}
                {overPreferNot && (
                  <li>סומנו {counts.preferNot} תאי "מעדיף שלא", מעל המכסה של {win.limits.maxPreferNot}</li>
                )}
                {mandatoryCannot.map((v) => (
                  <li key={`${v.date}-${v.key}`}>
                    סומן "לא יכול" במשמרת חובה {v.shiftName} ב-{fmtDate(v.date)}
                  </li>
                ))}
              </ul>
              <div className="small mt-3">
                ההגשה תועבר לאישור מיוחד ולא תיכנס לתוקף אוטומטית.
              </div>
            </Notice>
          )}

          {preview && <PreviewResult preview={preview} />}

          <Field label="הערה למנהל (אופציונלי)">
            {(props) => (
              <textarea
                {...props}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                disabled={readOnly}
                placeholder="למשל: מבחן בתאריך 18/11, זמינה רק אחרי 14:00"
              />
            )}
          </Field>

          {!readOnly && (
            <div className="row mt-3">
              <button type="button" className="btn" onClick={() => runPreview.run()} disabled={busy}>
                {runPreview.busy ? 'בודק…' : 'בדיקה לפני שליחה'}
              </button>
              <button type="button" className="btn btn-primary" onClick={() => submit.run()} disabled={busy}>
                {submit.busy ? 'שולח…' : 'שליחת זמינות למנהל'}
              </button>
              {current?.submitted_at && (
                <span className="small muted">
                  נשלח לאחרונה ב-{fmtDateTime(current.submitted_at)}
                </span>
              )}
            </div>
          )}
        </Panel>
      )}

      <Panel title="היסטוריית הגשות" flush>
        <StateView
          loading={declarations.loading}
          error={declarations.error}
          onRetry={declarations.reload}
          empty={!declarations.loading && (declarations.data?.declarations ?? []).length === 0}
          emptyProps={{ icon: '📋', title: 'עדיין לא הוגשה זמינות' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>שבוע</th>
                  <th>גרסה</th>
                  <th>סטטוס</th>
                  <th>הוגש</th>
                  <th>הערת מנהל</th>
                </tr>
              </thead>
              <tbody>
                {(declarations.data?.declarations ?? []).map((d) => (
                  <tr key={d.id}>
                    <td data-label="שבוע" className="tnum">{fmtWeekRange(d.week_start)}</td>
                    <td data-label="גרסה">{d.revision}</td>
                    <td data-label="סטטוס">
                      <Tag tone={statusTone(d.status)}>{STATUS_NAMES[d.status] ?? d.status}</Tag>
                    </td>
                    <td data-label="הוגש" className="tnum">{d.submitted_at ? fmtDateTime(d.submitted_at) : '—'}</td>
                    <td data-label="הערת מנהל" className="small">{d.decision_note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>
    </StateView>
  );
}

const CATEGORY_NAMES = { morning: 'בוקר', afternoon: 'צהריים', night: 'לילה', weekend: 'סוף שבוע' };
const PHASE_NAMES = { training: 'הכשרה', golive: 'עלייה לאוויר', support: 'ליווי' };
const isWeekend = (date) => [5, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());
const activeOn = (w, date) => !w.days || w.days.includes(date);

function countAvailable(windows, cells) {
  const out = { morning: 0, afternoon: 0, night: 0, weekend: 0 };
  for (const w of windows) {
    for (const day of w.days ?? []) {
      if ((cells[`${day}|${w.key}`] ?? 'can') !== 'can') continue;
      if (w.category in out) out[w.category] += 1;
      if (isWeekend(day)) out.weekend += 1;
    }
  }
  return out;
}

/** המינימום שהמנהל הגדיר לכל סוג משמרת, מול מה שסומן "זמין" */
function QuotaBar({ minimums, available, exempt = [] }) {
  const keys = Object.keys(CATEGORY_NAMES).filter((k) => minimums[k] > 0 && !exempt.includes(k));
  if (!keys.length) return null;
  return (
    <div className="quota-bar" aria-label="מינימום משמרות זמינות">
      {keys.map((k) => {
        const ok = available[k] >= minimums[k];
        return (
          <span key={k} className={`quota ${ok ? 'ok' : 'short'}`}>
            {CATEGORY_NAMES[k]}
            <strong>{available[k]}/{minimums[k]}</strong>
          </span>
        );
      })}
    </div>
  );
}

function AvailabilityGrid({ days, phases, windows, cells, onCycle, readOnly, lockOf = () => null }) {
  return (
    <div
      className="avail-grid"
      style={{ gridTemplateColumns: `minmax(92px, auto) repeat(${windows.length}, minmax(84px, 1fr))` }}
      role="grid"
      aria-label="מטריצת זמינות שבועית"
    >
      <div className="avail-head" role="columnheader">יום</div>
      {windows.map((w) => (
        <div className="avail-head" key={w.key} role="columnheader" title={w.locations}>
          <span className="tnum">
            {w.startTime}–{w.endTime}
            {w.isMandatory && <span className="mandatory-dot" title="כולל משמרת חובה" />}
          </span>
          <small>{w.label}</small>
          {w.category && <small>{CATEGORY_NAMES[w.category]}</small>}
        </div>
      ))}

      {days.map((date) => (
        <Row key={date} date={date} phase={phases[date]} showPhase={new Set(Object.values(phases)).size > 1}
          windows={windows} cells={cells} onCycle={onCycle} readOnly={readOnly} lockOf={lockOf} />
      ))}
    </div>
  );
}

const ROTATION_LOCKS = {
  required: { glyph: '✓', label: 'חובה בסבב השבועי' },
  exempt: { glyph: '·', label: 'לא נדרש השבוע (סבב שבועי)' },
};

function Row({ date, phase, showPhase, windows, cells, onCycle, readOnly, lockOf }) {
  return (
    <>
      <div className="avail-day" role="rowheader">
        {dayName(date)}
        <small className="tnum">{fmtDate(date)}</small>
        {showPhase && phase && <span className={`phase phase-${phase}`}>{PHASE_NAMES[phase]}</span>}
      </div>
      {windows.map((w) => {
        // המשמרת לא קיימת ביום הזה (למשל שעות הכשרה אחרי העלייה לאוויר)
        if (!activeOn(w, date)) {
          return (
            <button key={w.key} type="button" className="avail-cell" disabled
              aria-label={`${dayName(date)} ${fmtDate(date)}, ${w.startTime}–${w.endTime}: אין משמרת ביום הזה`}>
              <span aria-hidden="true">—</span>
            </button>
          );
        }
        const lock = lockOf(w);
        if (lock) {
          const meta = ROTATION_LOCKS[lock];
          return (
            <button key={w.key} type="button" className={`avail-cell avail-rot-${lock}`} disabled
              aria-label={`${dayName(date)} ${fmtDate(date)}, ${w.startTime}–${w.endTime}: ${meta.label}`}
              title={meta.label}>
              <span aria-hidden="true">{meta.glyph}</span>
            </button>
          );
        }
        const value = cells[`${date}|${w.key}`] ?? 'can';
        const meta = AVAIL_VALUES[value];
        return (
          <button
            key={w.key}
            type="button"
            className={`avail-cell avail-${value}`}
            onClick={() => onCycle(date, w.key)}
            disabled={readOnly}
            aria-label={`${dayName(date)} ${fmtDate(date)}, ${w.startTime}–${w.endTime} (${w.label}): ${meta.label}`}
            title={meta.label}
          >
            <span aria-hidden="true">{meta.glyph}</span>
          </button>
        );
      })}
    </>
  );
}

/** מפתח החלון, זהה לזה שהשרת מחזיר: 'HH:MM-HH:MM' */
const windowKey = (start, end) => `${String(start).slice(0, 5)}-${String(end).slice(0, 5)}`;

function PreviewResult({ preview }) {
  const tone = preview.willBe === 'blocked' ? 'danger' : preview.willBe === 'ok' ? 'ok' : 'warn';
  const title = {
    ok: 'ההגשה תקינה ותיכנס לתוקף מיד',
    pending_approval: 'ההגשה תועבר לאישור מיוחד',
    blocked: 'ההגשה חסומה',
  }[preview.willBe];

  return (
    <Notice tone={tone} icon={{ ok: '✓', pending_approval: '⏳', blocked: '⛔' }[preview.willBe]} title={title}>
      {preview.findings.length > 0 ? (
        <ul style={{ margin: 0, paddingInlineStart: 18 }}>
          {preview.findings.map((f, i) => (
            <li key={i}>
              <span className="bold">{f.ruleName}:</span> {f.message}
            </li>
          ))}
        </ul>
      ) : (
        <span className="small">לא נמצאו חריגות מהכללים.</span>
      )}
    </Notice>
  );
}

/* ==========================================================================
   בקשות אילוץ
   ========================================================================== */

function ConstraintsTab() {
  const toast = useToast();
  const requests = useApi('/api/requests', { limit: 100 });
  const [showForm, setShowForm] = useState(false);
  const [fixing, setFixing] = useState(null);

  return (
    <>
      <Panel
        title="הבקשות שלי"
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setShowForm(true)}>
            + בקשה חדשה
          </button>
        }
        flush
      >
        <StateView
          loading={requests.loading}
          error={requests.error}
          onRetry={requests.reload}
          empty={!requests.loading && (requests.data?.requests ?? []).length === 0}
          emptyProps={{
            icon: '📝',
            title: 'עדיין לא הגשת בקשות',
            text: 'בקשת חופשה או אילוץ שעות תיבדק מול חוקי האתר לפני השמירה.',
          }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>סוג</th>
                  <th>תאריך</th>
                  <th>שעות</th>
                  <th>סטטוס</th>
                  <th>הערה</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {(requests.data?.requests ?? []).map((request) => (
                  <RequestRow key={request.id} request={request} onChanged={requests.reload} onFix={setFixing} />
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {fixing && (
        <ConstraintForm
          existing={fixing}
          onClose={() => setFixing(null)}
          onSaved={() => { setFixing(null); requests.reload(); toast.success('הבקשה הוגשה מחדש'); }}
        />
      )}

      {showForm && (
        <ConstraintForm
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            requests.reload();
            toast.success('הבקשה נשמרה');
          }}
        />
      )}
    </>
  );
}

function RequestRow({ request, onChanged, onFix }) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const returned = request.status === 'draft' && request.returned_at;

  const cancel = useAction(
    async () => {
      await post(`/api/requests/${request.id}/cancel`);
      toast.success('הבקשה בוטלה');
      setConfirming(false);
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const canCancel = ['draft', 'submitted', 'approved'].includes(request.status);

  return (
    <>
      <tr>
        <td data-label="סוג" className="bold">{request.type_name}</td>
        <td data-label="תאריך" className="tnum">{fmtDate(request.constraint_date)}</td>
        <td data-label="שעות" className="tnum">
          {request.start_time.slice(0, 5)}–{request.end_time.slice(0, 5)}
        </td>
        <td data-label="סטטוס">
          {returned
            ? <Tag tone="warn">הוחזר לתיקון</Tag>
            : <Tag tone={statusTone(request.status)}>{STATUS_NAMES[request.status] ?? request.status}</Tag>}
          {request.auto_approved && <span className="tiny muted"> (אוטומטי)</span>}
        </td>
        <td data-label="הערה" className="small">
          {request.note ?? '—'}
          {returned && request.return_note && (
            <div className="tiny" style={{ color: 'var(--warn)' }}>
              לתיקון{request.returned_by_name ? ` (${request.returned_by_name})` : ''}: {request.return_note}
            </div>
          )}
          {request.decision_note && (
            <div className="tiny muted">החלטה: {request.decision_note}</div>
          )}
        </td>
        <td>
          <div className="row" style={{ gap: 4 }}>
            {request.status === 'draft' && (
              <button type="button" className="btn btn-sm btn-primary" onClick={() => onFix(request)}>
                {returned ? 'תיקון והגשה' : 'עריכה והגשה'}
              </button>
            )}
            {canCancel && (
              <button type="button" className="btn btn-sm" onClick={() => setConfirming(true)}>
                ביטול
              </button>
            )}
          </div>
        </td>
      </tr>


      {confirming && (
        <tr>
          <td colSpan={6}>
            <Notice tone="warn" icon="⚠" title="לבטל את הבקשה?">
              <div className="row mt-3">
                <button type="button" className="btn btn-danger btn-sm" onClick={() => cancel.run()} disabled={cancel.busy}>
                  {cancel.busy ? 'מבטל…' : 'כן, בטל/י'}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
                  השאר/י
                </button>
              </div>
            </Notice>
          </td>
        </tr>
      )}
    </>
  );
}

function ConstraintForm({ onClose, onSaved, existing }) {
  const toast = useToast();
  const { sites } = usePermissions();
  const types = useApi('/api/settings/lookups/constraintTypes');

  const [form, setForm] = useState(existing ? {
    constraintTypeId: existing.constraint_type_id,
    constraintDate: existing.constraint_date,
    startTime: existing.start_time.slice(0, 5),
    endTime: existing.end_time.slice(0, 5),
    note: existing.note ?? '',
    siteId: existing.site_id ?? sites[0]?.id ?? '',
  } : {
    constraintTypeId: '',
    constraintDate: addDays(today(), 7),
    startTime: '00:00',
    endTime: '23:59',
    note: '',
    siteId: sites[0]?.id ?? '',
  });
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    const first = types.data?.items?.[0];
    if (first && !form.constraintTypeId) setForm((f) => ({ ...f, constraintTypeId: first.id }));
  }, [types.data]);

  const body = () => ({
    constraintTypeId: form.constraintTypeId,
    constraintDate: form.constraintDate,
    startTime: form.startTime,
    endTime: form.endTime,
    note: form.note || null,
    siteId: form.siteId || null,
  });

  const check = useAction(
    async () => setPreview(await post('/api/requests/preview', { ...body(), ...(existing ? { id: existing.id } : {}) })),
    { onError: (err) => toast.error(err) },
  );

  const submit = useAction(
    async () => {
      const { siteId: _site, ...changes } = body();
      const { request } = existing
        ? await patch(`/api/requests/${existing.id}`, changes)
        : await post('/api/requests', body());
      const result = await post(
        `/api/requests/${request.id}/submit`,
        {},
        { idempotencyKey: newIdempotencyKey() },
      );
      if (result.status === 'approval_required') {
        toast.warn('הבקשה נשמרה והועברה לאישור — היא אינה בתוקף עד להחלטה');
      }
      onSaved();
    },
    { onError: (err) => toast.error(err) },
  );

  // בלי סוג בקשה אין מה לבדוק או לשלוח — הכפתורים נעולים עד שהטופס נטען
  const notReady = types.loading || !!types.error || !form.constraintTypeId;

  const willBeLabel = {
    approved: ['ok', '✓', 'הבקשה תאושר אוטומטית לפי מדיניות האתר'],
    pending_manager: ['warn', '⏳', 'הבקשה תועבר להחלטת מנהל'],
    pending_exception: ['warn', '⚠', 'הבקשה חורגת מכלל ותועבר לאישור חריגה'],
    blocked: ['danger', '⛔', 'הבקשה חסומה ולא ניתן להגיש אותה'],
  };

  return (
    <Modal
      title={existing ? 'תיקון הבקשה והגשה מחדש' : 'בקשת חופשה או אילוץ'}
      onClose={onClose}
      footer={
        <>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => submit.run()}
            disabled={notReady || submit.busy || check.busy || preview?.willBe === 'blocked'}
          >
            {submit.busy ? 'שולח…' : 'שליחה'}
          </button>
          <button type="button" className="btn" onClick={() => check.run()} disabled={notReady || check.busy || submit.busy}>
            {check.busy ? 'בודק…' : 'בדיקה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <StateView loading={types.loading} error={types.error} onRetry={types.reload}>
        {sites.length > 1 && (
          <Field label="אתר" required hint="מדיניות האישור נקבעת לפי האתר">
            {(props) => (
              <select {...props} value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })}>
                {sites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
            )}
          </Field>
        )}

        <Field label="סוג הבקשה" required>
          {(props) => (
            <select
              {...props}
              value={form.constraintTypeId}
              onChange={(e) => { setForm({ ...form, constraintTypeId: e.target.value }); setPreview(null); }}
            >
              {(types.data?.items ?? []).map((t) => (
                <option key={t.id} value={t.id}>{t.name_he}</option>
              ))}
            </select>
          )}
        </Field>

        <Field label="תאריך" required>
          {(props) => (
            <input
              {...props}
              type="date"
              value={form.constraintDate}
              min={today()}
              onChange={(e) => { setForm({ ...form, constraintDate: e.target.value }); setPreview(null); }}
            />
          )}
        </Field>

        <div className="grid grid-2">
          <Field label="משעה">
            {(props) => (
              <input
                {...props}
                type="time"
                value={form.startTime}
                onChange={(e) => { setForm({ ...form, startTime: e.target.value }); setPreview(null); }}
              />
            )}
          </Field>
          <Field label="עד שעה">
            {(props) => (
              <input
                {...props}
                type="time"
                value={form.endTime}
                onChange={(e) => { setForm({ ...form, endTime: e.target.value }); setPreview(null); }}
              />
            )}
          </Field>
        </div>

        <Field label="הערה" hint="מה שיעזור למנהל להבין את הבקשה">
          {(props) => (
            <textarea {...props} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          )}
        </Field>

        {preview && (
          <Notice
            tone={willBeLabel[preview.willBe]?.[0]}
            icon={willBeLabel[preview.willBe]?.[1]}
            title={willBeLabel[preview.willBe]?.[2]}
          >
            {preview.findings.length > 0 && (
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {preview.findings.map((f, i) => (
                  <li key={i}><span className="bold">{f.ruleName}:</span> {f.message}</li>
                ))}
              </ul>
            )}
          </Notice>
        )}
      </StateView>
    </Modal>
  );
}
