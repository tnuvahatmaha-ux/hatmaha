import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { post, del, download, newIdempotencyKey } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import {
  Panel, StateView, Tag, Notice, Field, Modal, Segmented, WeekNav, Empty, ConfirmDialog,
} from '../components/ui/index.jsx';
import {
  fmtDate, fmtDateTime, fmtWeekRange, fmtClock, dayName, dayShort,
  today, addDays, weekStartOf, weekDays, STATUS_NAMES, statusTone, SEVERITY_TONE, SEVERITY_NAMES,
} from '../lib/format.js';

/**
 * בונה הסידור.
 *
 * מטריצה: שורות = מיקומים, עמודות = שבעה ימים × משמרות האתר.
 * לכל תא מוצגים השיבוצים הקיימים והמועמדים להוספה — כשלצד כל שם מופיע
 * סימון הזמינות שלו. זו הנקודה שבה המשבץ רואה את המידע לפני שהוא טועה,
 * במקום לגלות את הבעיה אחרי הפרסום.
 */
export default function Roster() {
  const toast = useToast();
  const { sites, can } = usePermissions();

  const [siteId, setSiteId] = useState('');
  const [weekStart, setWeekStart] = useState(weekStartOf(today()));
  const [layout, setLayout] = useState('matrix');
  const [viewVersionId, setViewVersionId] = useState(null);

  const allSites = useApi('/api/sites');
  const options = allSites.data?.sites ?? sites;

  useEffect(() => {
    if (!siteId && options.length) setSiteId(options[0].id);
  }, [options, siteId]);

  const draft = useApi(siteId ? '/api/roster/draft' : null, { siteId, weekStart });
  const versions = useApi(siteId ? '/api/roster/versions' : null, { siteId, weekStart });

  const activeVersionId = viewVersionId ?? draft.data?.version?.id;
  const board = useApi(activeVersionId ? `/api/roster/versions/${activeVersionId}/board` : null);

  const [issues, setIssues] = useState(null);
  const [showDuplicate, setShowDuplicate] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);

  // שינוי שבוע או אתר מאפס את התצוגה ואת תוצאות הבדיקה
  useEffect(() => {
    setViewVersionId(null);
    setIssues(null);
  }, [siteId, weekStart]);

  const version = board.data?.version;
  const isDraft = version?.status === 'draft';
  const editable = isDraft && can('roster', 'edit');

  const validate = useAction(
    async () => {
      const result = await post(`/api/roster/versions/${activeVersionId}/validate`);
      setIssues(result);
      if (result.issues.length === 0 && result.openExceptions.length === 0) {
        toast.success('הסידור תקין — ניתן לפרסם');
      }
      return result;
    },
    { onError: (err) => toast.error(err) },
  );

  const publish = useAction(
    async () => {
      const result = await post(
        `/api/roster/versions/${activeVersionId}/publish`,
        {},
        { idempotencyKey: newIdempotencyKey(), ifMatch: version.row_version },
      );
      toast.success(
        `גרסה ${result.versionNumber} פורסמה · נשלחו התראות ל-${result.notified} מטמיעים`,
      );
      setConfirmPublish(false);
      setIssues(null);
      draft.reload();
      versions.reload();
      board.reload();
    },
    {
      onError: (err) => {
        setConfirmPublish(false);
        toast.error(err);
        if (err.details?.issues || err.details?.openExceptions) validate.run();
      },
    },
  );

  const refreshBoard = () => {
    board.reload();
    setIssues(null);
  };

  return (
    <>
      <ViewHead
        title="בונה סידור"
        subtitle="שיבוץ לפי מיקום, יום ומשמרת — עם בדיקת חוקיות וזמינות"
        actions={
          <>
            <select
              value={siteId}
              onChange={(e) => setSiteId(e.target.value)}
              aria-label="בחירת אתר"
              style={{ width: 'auto', minWidth: 160 }}
            >
              {options.map((site) => (
                <option key={site.id} value={site.id}>{site.name}</option>
              ))}
            </select>
            <WeekNav
              label={fmtWeekRange(weekStart)}
              onPrev={() => setWeekStart(addDays(weekStart, -7))}
              onNext={() => setWeekStart(addDays(weekStart, 7))}
              onToday={() => setWeekStart(weekStartOf(today()))}
            />
          </>
        }
      />

      <StateView loading={allSites.loading} error={allSites.error} onRetry={allSites.reload}>
        {options.length === 0 ? (
          <Panel>
            <Empty icon="🏥" title="אין אתרים" text="יש להגדיר אתר לפני בניית סידור." />
          </Panel>
        ) : (
          <StateView loading={draft.loading || board.loading} error={draft.error ?? board.error} onRetry={refreshBoard}>
            {board.data && (
              <>
                <Panel
                  title={
                    isDraft
                      ? `טיוטה — גרסה ${version.version_number}`
                      : `גרסה ${version.version_number} · ${STATUS_NAMES[version.status]}`
                  }
                  subtitle={
                    isDraft
                      ? 'שינויים נשמרים מיד. הפרסום יוצר גרסה חדשה לקריאה בלבד.'
                      : `פורסם ${fmtDateTime(version.published_at)} — לקריאה בלבד`
                  }
                  actions={
                    <>
                      <Segmented
                        label="תצוגה"
                        value={layout}
                        onChange={setLayout}
                        options={[
                          { value: 'matrix', label: 'מטריצה' },
                          { value: 'list', label: 'רשימה' },
                        ]}
                      />
                      {editable && (
                        <>
                          <button type="button" className="btn btn-sm" onClick={() => setShowDuplicate(true)}>
                            שכפול שבוע
                          </button>
                          <button type="button" className="btn btn-sm" onClick={() => validate.run()} disabled={validate.busy}>
                            {validate.busy ? 'בודק…' : 'בדיקת תקינות'}
                          </button>
                        </>
                      )}
                      {can('roster', 'export') && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() =>
                            download(
                              `/api/roster/versions/${activeVersionId}/export.csv`,
                              {},
                              `סידור-עבודה-${weekStart}.csv`,
                            ).catch(toast.error)
                          }
                        >
                          ייצוא CSV
                        </button>
                      )}
                      {editable && can('roster', 'publish') && (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => setConfirmPublish(true)}
                          disabled={publish.busy || board.data.assignments.length === 0}
                        >
                          פרסום גרסה
                        </button>
                      )}
                    </>
                  }
                  flush
                >
                  {!isDraft && (
                    <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
                      <Notice icon="🔒" title="גרסה שפורסמה">
                        השיבוצים כאן אינם ניתנים לשינוי. כדי לתקן — חזרה לטיוטה הפתוחה.
                        <div className="mt-3">
                          <button type="button" className="btn btn-sm" onClick={() => setViewVersionId(null)}>
                            חזרה לטיוטה
                          </button>
                        </div>
                      </Notice>
                    </div>
                  )}

                  {board.data.shiftTypes.length === 0 ? (
                    <Empty
                      icon="🕐"
                      title="לא הוגדרו משמרות לאתר הזה"
                      text="המטריצה בנויה על משמרות האתר. יש להגדיר אותן במסך האתרים."
                    />
                  ) : board.data.locations.length === 0 ? (
                    <Empty icon="📍" title="לא הוגדרו מיקומים לאתר הזה" />
                  ) : layout === 'matrix' ? (
                    <RosterMatrix
                      board={board.data}
                      editable={editable}
                      onChanged={refreshBoard}
                    />
                  ) : (
                    <RosterList board={board.data} editable={editable} onChanged={refreshBoard} />
                  )}
                </Panel>

                {issues && <IssuesPanel issues={issues} />}

                <VersionsPanel
                  versions={versions}
                  activeId={activeVersionId}
                  onOpen={(id) => { setViewVersionId(id); setIssues(null); }}
                />
              </>
            )}
          </StateView>
        )}
      </StateView>

      {showDuplicate && (
        <DuplicateDialog
          versionId={activeVersionId}
          weekStart={weekStart}
          onClose={() => setShowDuplicate(false)}
          onDone={(result) => {
            setShowDuplicate(false);
            toast.success(
              `שוכפלו ${result.created} שיבוצים לשבוע ${fmtDate(result.targetWeekStart)}` +
                (result.skipped ? ` · ${result.skipped} דולגו בגלל התנגשות` : ''),
            );
            setWeekStart(result.targetWeekStart);
          }}
        />
      )}

      {confirmPublish && (
        <ConfirmDialog
          title="פרסום גרסת סידור"
          message={
            `הפרסום יקפיא את הגרסה הנוכחית כגרסה ${version.version_number} לקריאה בלבד, ` +
            'יפתח עותק כטיוטה הבאה, וישלח התראה לכל המטמיעים המשובצים. להמשיך?'
          }
          confirmLabel="פרסום"
          tone="primary"
          busy={publish.busy}
          onConfirm={() => publish.run()}
          onCancel={() => setConfirmPublish(false)}
        />
      )}
    </>
  );
}

/* ==========================================================================
   המטריצה
   ========================================================================== */

function RosterMatrix({ board, editable, onChanged }) {
  const { days, locations, shiftTypes, assignments } = board;
  const columns = days.length * shiftTypes.length;

  return (
    <div className="roster-wrap">
      <div
        className="roster-grid"
        style={{ gridTemplateColumns: `minmax(120px, auto) repeat(${columns}, minmax(98px, 1fr))` }}
      >
        <div className="roster-corner" style={{ gridRow: 'span 2' }}>מיקום</div>

        {days.map((date) => (
          <div
            key={date}
            className="roster-dayhead"
            style={{ gridColumn: `span ${shiftTypes.length}` }}
          >
            {dayName(date)}
            <small className="tnum">{fmtDate(date)}</small>
          </div>
        ))}

        {days.map((date) =>
          shiftTypes.map((shift) => (
            <div className="roster-shifthead" key={`${date}-${shift.id}`}>
              <span>
                {shift.name}
                {shift.is_mandatory && <span className="mandatory-dot" title="משמרת חובה" />}
              </span>
              <small className="tnum">
                {fmtClock(shift.start_time)}–{fmtClock(shift.end_time)}
              </small>
            </div>
          )),
        )}

        {locations.map((location) => (
          <LocationRow
            key={location.id}
            location={location}
            board={board}
            editable={editable}
            onChanged={onChanged}
          />
        ))}
      </div>

      <div className="legend mt-3">
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--surface-2)' }} />פנוי</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--success-bg)' }} />מאויש</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--warn-bg)' }} />מאויש עם התראה</span>
        <span className="legend-item">סימון הזמינות מוצג לצד כל שם ברשימת ההוספה</span>
      </div>
    </div>
  );
}

function LocationRow({ location, board, editable, onChanged }) {
  return (
    <>
      <div className="roster-loc">
        <span aria-hidden="true">📍</span>
        {location.name}
      </div>
      {board.days.map((date) =>
        board.shiftTypes.map((shift) => (
          <Slot
            key={`${location.id}-${date}-${shift.id}`}
            board={board}
            location={location}
            date={date}
            shift={shift}
            editable={editable}
            onChanged={onChanged}
          />
        )),
      )}
    </>
  );
}

function Slot({ board, location, date, shift, editable, onChanged }) {
  const toast = useToast();

  const inCell = board.assignments.filter(
    (a) => a.location_id === location.id && a.assignment_date === date && a.shift_type_id === shift.id,
  );

  /** סימון הזמינות של אדם למשמרת הזו — זה מה שמונע שיבוץ שגוי */
  const flagsFor = (userId) => {
    const cell = board.availability.find(
      (a) => a.user_id === userId && a.cell_date === date && a.shift_type_id === shift.id,
    );
    const blocked = board.constraints.find((c) => c.user_id === userId && overlapsShift(c, date, shift));

    const flags = [];
    if (blocked) {
      flags.push({
        severity: blocked.status === 'approved' ? 'blocking' : 'warning',
        label: blocked.status === 'approved' ? `⛔ ${blocked.type_name}` : `${blocked.type_name} ממתין`,
      });
    }
    if (cell?.value === 'cannot') {
      flags.push({
        severity: cell.status === 'pending_approval' ? 'warning' : 'blocking',
        label: cell.status === 'pending_approval' ? 'לא יכול (ממתין)' : 'לא יכול',
      });
    } else if (cell?.value === 'prefer_not') {
      flags.push({ severity: 'warning', label: 'מעדיף שלא' });
    } else if (cell) {
      flags.push({ severity: 'ok', label: '✓ זמין' });
    }
    return flags;
  };

  const assignedIds = inCell.map((a) => a.user_id);
  const candidates = board.people.filter((p) => !assignedIds.includes(p.id));

  const hasIssue = inCell.some((a) => flagsFor(a.user_id).some((f) => f.severity !== 'ok') || a.warning_text);
  const status = inCell.length === 0 ? 'vacant' : hasIssue ? 'issue' : 'covered';

  const assign = useAction(
    async (userId) => {
      const result = await post(
        `/api/roster/versions/${board.version.id}/assignments`,
        { userId, date, locationId: location.id, shiftTypeId: shift.id },
        { idempotencyKey: newIdempotencyKey() },
      );
      if (result.status === 'approval_required') {
        toast.warn('השיבוץ דורש אישור חריגה — הוא לא בוצע עד שיאושר');
      } else if (result.status === 'warning') {
        toast.warn(`שובץ עם אזהרה: ${result.warnings.map((w) => w.message).join(' · ')}`);
      }
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const remove = useAction(
    async (id) => {
      await del(`/api/roster/assignments/${id}`);
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const shortName = (name) => name.split(' ')[0];

  return (
    <div className={`roster-slot ${status}`}>
      {inCell.map((assignment) => {
        const flags = flagsFor(assignment.user_id);
        const issue = flags.some((f) => f.severity !== 'ok');
        const tooltip = [...flags.map((f) => f.label), assignment.warning_text].filter(Boolean).join(' · ');

        return (
          <span key={assignment.id} className={`roster-chip${issue ? ' issue' : ''}`} title={tooltip || undefined}>
            {shortName(assignment.user_name)}
            {issue && <span aria-hidden="true">⚠</span>}
            {editable && (
              <button
                type="button"
                onClick={() => remove.run(assignment.id)}
                disabled={remove.busy}
                aria-label={`הסרת ${assignment.user_name} מהמשמרת`}
              >
                ✕
              </button>
            )}
          </span>
        );
      })}

      {editable && candidates.length > 0 && (
        <select
          className="roster-add"
          value=""
          onChange={(e) => e.target.value && assign.run(e.target.value)}
          disabled={assign.busy}
          aria-label={`הוספת מטמיע ל${location.name}, ${dayName(date)}, ${shift.name}`}
        >
          <option value="">+ הוספה</option>
          {candidates.map((person) => {
            const flags = flagsFor(person.id);
            const suffix = flags.length ? ` — ${flags.map((f) => f.label).join(', ')}` : '';
            return (
              <option key={person.id} value={person.id}>
                {person.full_name}{suffix}
              </option>
            );
          })}
        </select>
      )}
    </div>
  );
}

/** האם אילוץ חופף למשמרת ביום מסוים. חישוב גס בלקוח — השרת הוא הקובע. */
function overlapsShift(constraint, date, shift) {
  const start = new Date(`${date}T${shift.start_time}`);
  let end = new Date(`${date}T${shift.end_time}`);
  if (end <= start) end = new Date(end.getTime() + 86_400_000);
  return new Date(constraint.starts_at) < end && start < new Date(constraint.ends_at);
}

/* ==========================================================================
   תצוגת רשימה
   ========================================================================== */

function RosterList({ board, editable, onChanged }) {
  const toast = useToast();
  const [groupBy, setGroupBy] = useState('date');

  const remove = useAction(
    async (id) => {
      await del(`/api/roster/assignments/${id}`);
      onChanged();
    },
    { onError: (err) => toast.error(err) },
  );

  const groups = useMemo(() => {
    const map = new Map();
    for (const a of board.assignments) {
      const key = groupBy === 'date'
        ? a.assignment_date
        : board.locations.find((l) => l.id === a.location_id)?.name ?? 'ללא מיקום';
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(a);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [board, groupBy]);

  if (board.assignments.length === 0) {
    return <Empty icon="🧩" title="אין שיבוצים בגרסה הזו" text="אפשר להוסיף שיבוצים בתצוגת המטריצה." />;
  }

  return (
    <div>
      <div className="row" style={{ padding: 'var(--space-3) var(--space-4)' }}>
        <Segmented
          label="קיבוץ"
          value={groupBy}
          onChange={setGroupBy}
          options={[
            { value: 'date', label: 'לפי תאריך' },
            { value: 'location', label: 'לפי מיקום' },
          ]}
        />
      </div>

      {groups.map(([key, rows]) => (
        <div key={key}>
          <div
            className="bold small"
            style={{ padding: '6px var(--space-4)', background: 'var(--surface-2)', borderBlock: '1px solid var(--ink)' }}
          >
            {groupBy === 'date' ? `${dayName(key)} · ${fmtDate(key)}` : key}
          </div>
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>מטמיע</th>
                  {groupBy === 'date' && <th>מיקום</th>}
                  {groupBy === 'location' && <th>תאריך</th>}
                  <th>שעות</th>
                  <th>התראות</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td data-label="מטמיע" className="bold">{a.user_name}</td>
                    {groupBy === 'date' && (
                      <td data-label="מיקום">
                        {board.locations.find((l) => l.id === a.location_id)?.name ?? '—'}
                      </td>
                    )}
                    {groupBy === 'location' && (
                      <td data-label="תאריך" className="tnum">{fmtDate(a.assignment_date)}</td>
                    )}
                    <td data-label="שעות" className="tnum">
                      {fmtClock(a.start_time)}–{fmtClock(a.end_time)}
                    </td>
                    <td data-label="התראות">
                      {a.warning_text ? <Tag tone="warn">{a.warning_text}</Tag> : <Tag tone="ok">תקין</Tag>}
                    </td>
                    <td>
                      {editable && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => remove.run(a.id)}
                          disabled={remove.busy}
                        >
                          הסרה
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

/* ==========================================================================
   תוצאות הבדיקה, גרסאות, שכפול
   ========================================================================== */

function IssuesPanel({ issues }) {
  const blocking = issues.issues.filter((i) => i.severity === 'blocking');
  const pending = issues.openExceptions ?? [];

  return (
    <Panel
      title="תוצאות בדיקת התקינות"
      subtitle={`${issues.assignmentCount} שיבוצים נבדקו`}
      actions={
        issues.canPublish
          ? <Tag tone="ok">ניתן לפרסם</Tag>
          : <Tag tone="danger">לא ניתן לפרסם</Tag>
      }
    >
      {issues.issues.length === 0 && pending.length === 0 ? (
        <Notice tone="ok" icon="✓" title="הסידור תקין">לא נמצאו חריגות.</Notice>
      ) : (
        <>
          {blocking.length > 0 && (
            <Notice tone="danger" icon="⛔" title="חריגות חוסמות — יש לתקן לפני הפרסום">
              {blocking.length} שיבוצים חורגים מחוק חוסם.
            </Notice>
          )}
          {pending.length > 0 && (
            <Notice tone="warn" icon="⏳" title="חריגות הממתינות לאישור">
              <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                {pending.map((ex) => (
                  <li key={ex.id}>{ex.summary}</li>
                ))}
              </ul>
              <div className="small mt-3">
                לא ניתן לפרסם עד שכל החריגות יוכרעו, במסך "בקשות ואישורים".
              </div>
            </Notice>
          )}

          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr>
                  <th>חומרה</th>
                  <th>מי ומתי</th>
                  <th>חוק</th>
                  <th>פירוט</th>
                </tr>
              </thead>
              <tbody>
                {issues.issues.map((issue, index) => (
                  <tr key={index}>
                    <td data-label="חומרה">
                      <Tag tone={SEVERITY_TONE[issue.severity]}>{SEVERITY_NAMES[issue.severity]}</Tag>
                    </td>
                    <td data-label="מי ומתי">{issue.who}</td>
                    <td data-label="חוק" className="small">{issue.ruleName}</td>
                    <td data-label="פירוט" className="small">{issue.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}

function VersionsPanel({ versions, activeId, onOpen }) {
  return (
    <Panel title="גרסאות" flush>
      <StateView
        loading={versions.loading}
        error={versions.error}
        onRetry={versions.reload}
        empty={!versions.loading && (versions.data?.versions ?? []).length === 0}
        emptyProps={{ icon: '📄', title: 'אין עדיין גרסאות לשבוע הזה' }}
      >
        <div className="table-wrap">
          <table className="table table-cards">
            <thead>
              <tr>
                <th>גרסה</th>
                <th>סטטוס</th>
                <th>שיבוצים</th>
                <th>פורסם</th>
                <th>על ידי</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(versions.data?.versions ?? []).map((v) => (
                <tr key={v.id} style={v.id === activeId ? { background: 'var(--primary-ink)' } : undefined}>
                  <td data-label="גרסה" className="bold">{v.version_number}</td>
                  <td data-label="סטטוס">
                    <Tag tone={statusTone(v.status)}>{STATUS_NAMES[v.status] ?? v.status}</Tag>
                  </td>
                  <td data-label="שיבוצים" className="tnum">{v.assignment_count}</td>
                  <td data-label="פורסם" className="tnum">
                    {v.published_at ? fmtDateTime(v.published_at) : '—'}
                  </td>
                  <td data-label="על ידי">{v.published_by_name ?? '—'}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => onOpen(v.id)}>
                      פתיחה
                    </button>
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

function DuplicateDialog({ versionId, weekStart, onClose, onDone }) {
  const toast = useToast();
  const [mode, setMode] = useState('copy');
  const [target, setTarget] = useState(addDays(weekStart, 7));

  const run = useAction(
    async () => {
      const result = await post(
        `/api/roster/versions/${versionId}/duplicate-week`,
        { targetWeekStart: target, mode },
        { idempotencyKey: newIdempotencyKey() },
      );
      onDone(result);
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Modal
      title="שכפול הסידור לשבוע אחר"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn btn-primary" onClick={() => run.run()} disabled={run.busy}>
            {run.busy ? 'משכפל…' : 'שכפול'}
          </button>
          <button type="button" className="btn" onClick={onClose}>ביטול</button>
        </>
      }
    >
      <Field label="שבוע היעד" required hint="חייב להתחיל ביום ראשון">
        {(props) => (
          <select {...props} value={target} onChange={(e) => setTarget(e.target.value)}>
            {[1, 2, 3, 4].map((n) => {
              const value = addDays(weekStart, 7 * n);
              return (
                <option key={value} value={value}>{fmtWeekRange(value)}</option>
              );
            })}
          </select>
        )}
      </Field>

      <Field label="אופן השכפול">
        <div className="stack">
          <label className="check">
            <input type="radio" name="mode" checked={mode === 'copy'} onChange={() => setMode('copy')} />
            <span>
              <span className="bold">שכפול רגיל</span>
              <div className="small muted">כל מטמיע נשאר באותו מיקום, אותו יום בשבוע ואותה משמרת.</div>
            </span>
          </label>
          <label className="check">
            <input type="radio" name="mode" checked={mode === 'rotate'} onChange={() => setMode('rotate')} />
            <span>
              <span className="bold">שכפול עם רוטציית משמרות</span>
              <div className="small muted">
                כל שיבוץ עובר למשמרת הבאה בתור שהוגדר באתר (בוקר ← ערב ← לילה ← בוקר).
              </div>
            </span>
          </label>
        </div>
      </Field>

      <Notice icon="ℹ">
        <span className="small">
          שיבוץ שייצור חפיפה בשבוע היעד ידולג, והמספר שדולג יוצג בסיום.
        </span>
      </Notice>
    </Modal>
  );
}
