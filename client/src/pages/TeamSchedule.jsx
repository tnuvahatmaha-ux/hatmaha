import { useEffect, useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { usePermissions } from '../context/PermissionsContext.jsx';
import { ViewHead } from '../components/layout/AppLayout.jsx';
import { ChevronLeft, ChevronRight, Download } from 'lucide-react';
import { download } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Segmented } from '../components/ui/index.jsx';
import { fmtDate, dayName, today, addDays, weekStartOf, weekDays, fmtWeekRange } from '../lib/format.js';

/**
 * לו״ז צוותי.
 *
 * השדות המוצגים נקבעים בהגדרות והשרת מחזיר רק אותם — מזעור המידע נאכף
 * בשרת ולא בהסתרה בלקוח. אין כאן סיבות אילוץ ואין הערות פרטיות (§7, §14).
 *
 * שתי תצוגות: רשימה לפי יום, ומטריצה של אנשים × ימים. שתיהן ניתנות לייצוא.
 */
export default function TeamSchedule() {
  const { role } = usePermissions();
  const toast = useToast();
  const [siteId, setSiteId] = useState('');
  const [date, setDate] = useState(today());
  const [mode, setMode] = useState('day');
  const [layout, setLayout] = useState('list');
  const [exporting, setExporting] = useState(false);
  // מדריך: כל הצוות באתר, או רק המטמיעים שמשויכים אליו
  const [scope, setScope] = useState(role === 'mentor' ? 'mine' : 'all');

  const siteList = useApi('/api/schedule/team/sites');
  const options = siteList.data?.sites ?? [];

  useEffect(() => {
    if (!siteId && options.length) setSiteId(options[0].id);
  }, [options, siteId]);

  const weekStart = weekStartOf(date);
  // מטריצה היא תמיד שבועית — ביום אחד אין לה ערך מעבר לרשימה
  const effectiveMode = layout === 'matrix' ? 'week' : mode;
  const range = effectiveMode === 'week' ? { from: weekStart, to: addDays(weekStart, 6) } : { date };
  const schedule = useApi(siteId ? '/api/schedule/team' : null, {
    siteId, ...range, ...(scope === 'mine' ? { mine: '1' } : {}),
  });
  const entries = schedule.data?.entries ?? [];
  const fields = schedule.data?.fields ?? [];

  const labels = {
    name: 'שם', activity: 'פעילות', location: 'מיקום',
    status: 'סטטוס', time: 'שעות', domain: 'תחום',
  };
  const columns = ['name', 'activity', 'location', 'time', 'domain', 'status'].filter(
    (key) => fields.includes(key) || (key === 'location' && fields.includes('site')),
  );

  // מטריצה דורשת לדעת מי האדם — כשהשם אינו מותר בהגדרות, יש רק רשימה
  const canMatrix = fields.includes('name');
  const showMatrix = layout === 'matrix' && canMatrix;

  const days = effectiveMode === 'week' ? weekDays(weekStart) : [date];
  const byDay = days.map((d) => ({ day: d, items: entries.filter((e) => (e.date ?? date) === d) }));
  const shift = (n) => setDate(addDays(date, effectiveMode === 'week' ? 7 * n : n));

  const exportCsv = async () => {
    setExporting(true);
    try {
      await download(
        '/api/schedule/team/export',
        { siteId, ...range, ...(scope === 'mine' ? { mine: '1' } : {}), layout: showMatrix ? 'matrix' : 'list' },
        `לוז-צוות-${range.from ?? range.date}.csv`,
      );
    } catch (err) {
      toast.error(err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <>
      <ViewHead
        title="לו״ז צוות"
        subtitle={scope === 'mine' ? 'המטמיעים שמשויכים אליך' : 'מי עובד באתר — מידע צוותי מותר בלבד'}
        actions={
          <select
            value={siteId}
            onChange={(e) => setSiteId(e.target.value)}
            aria-label="בחירת אתר"
            style={{ width: 'auto', minWidth: 180 }}
          >
            {options.length === 0 && <option value="">אין אתרים זמינים</option>}
            {options.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
          </select>
        }
      />

      <div className="row" style={{ marginBlockEnd: 'var(--space-4)', gap: 'var(--space-3)' }}>
        {role === 'mentor' && (
          <Segmented
            label="מי מוצג"
            value={scope}
            onChange={setScope}
            options={[{ value: 'mine', label: 'המטמיעים שלי' }, { value: 'all', label: 'כל הצוות' }]}
          />
        )}
        <Segmented
          label="סוג תצוגה"
          value={layout}
          onChange={setLayout}
          options={[{ value: 'list', label: 'רשימה' }, { value: 'matrix', label: 'מטריצה' }]}
        />
        {layout === 'list' && (
          <Segmented
            label="תצוגה"
            value={mode}
            onChange={setMode}
            options={[{ value: 'day', label: 'יום' }, { value: 'week', label: 'שבוע' }]}
          />
        )}
        <div className="row row-end">
          <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(-1)} aria-label="הקודם">
            <ChevronRight size={16} />
          </button>
          {effectiveMode === 'day' ? (
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="תאריך" style={{ width: 'auto' }} />
          ) : (
            <span className="bold small tnum nowrap">{fmtWeekRange(weekStart)}</span>
          )}
          <button type="button" className="btn btn-sm btn-icon" onClick={() => shift(1)} aria-label="הבא">
            <ChevronLeft size={16} />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setDate(today())}>היום</button>
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={!siteId || exporting}>
            <Download size={15} /> {exporting ? 'מייצא…' : 'ייצוא'}
          </button>
        </div>
      </div>

      <Notice icon="🔒">
        <span className="small">
          מוצגים שם, פעילות, מיקום וסטטוס בלבד. סיבות חופשה והערות אישיות
          אינן נחשפות בלו״ז הצוותי.
        </span>
      </Notice>

      <StateView
        loading={schedule.loading || siteList.loading}
        error={schedule.error ?? siteList.error}
        onRetry={schedule.reload}
        empty={!schedule.loading && entries.length === 0 && (effectiveMode === 'day' || showMatrix)}
        emptyProps={{ icon: '👥', title: effectiveMode === 'day' ? 'אין פעילות מתוכננת ביום הזה' : 'אין פעילות מתוכננת בשבוע הזה' }}
      >
        {layout === 'matrix' && !canMatrix && !schedule.loading && (
          <Notice icon="ℹ️">
            <span className="small">תצוגת מטריצה מחייבת הצגת שמות בלו״ז הצוותי (הגדרות ← מערכת). מוצגת רשימה.</span>
          </Notice>
        )}
        {showMatrix ? (
          <TeamMatrix days={days} entries={entries} />
        ) : byDay.map(({ day, items }) => (
          <Panel key={day} title={`${dayName(day)} · ${fmtDate(day)}`} flush>
            {items.length === 0 ? (
              <p className="small muted" style={{ padding: '4px 20px 16px' }}>אין פעילות מתוכננת</p>
            ) : (
              <div className="table-wrap">
                <table className="table table-cards">
                  <thead>
                    <tr>{columns.map((key) => <th key={key}>{labels[key]}</th>)}</tr>
                  </thead>
                  <tbody>
                    {items.map((entry, index) => (
                      <tr key={index}>
                        {columns.map((key) => (
                          <td key={key} data-label={labels[key]} className={key === 'name' ? 'bold' : ''}>
                            {key === 'status'
                              ? <Tag tone={entry.kind === 'shift' ? 'accent' : ''}>{entry[key]}</Tag>
                              : (entry[key] ?? '—')}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        ))}
      </StateView>
    </>
  );
}

/** מטריצה: שורה לכל אדם, עמודה לכל יום, ובכל תא מה שיש לו באותו יום */
function TeamMatrix({ days, entries }) {
  const people = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.personId)) continue;
    seen.add(e.personId);
    people.push({ id: e.personId, name: e.name });
  }
  people.sort((a, b) => String(a.name).localeCompare(String(b.name), 'he'));

  return (
    <Panel flush>
      <div className="roster-wrap" style={{ padding: 'var(--space-3)' }}>
        <div className="roster-grid"
          style={{ gridTemplateColumns: `minmax(130px, auto) repeat(${days.length}, minmax(130px, 1fr))` }}>
          <div className="roster-corner">שם</div>
          {days.map((d) => (
            <div key={d} className="roster-dayhead">
              {dayName(d)}
              <small className="tnum">{fmtDate(d)}</small>
            </div>
          ))}

          {people.map((person) => (
            <TeamMatrixRow key={person.id} person={person} days={days} entries={entries} />
          ))}
        </div>
      </div>
    </Panel>
  );
}

function TeamMatrixRow({ person, days, entries }) {
  return (
    <>
      <div className="roster-loc">{person.name}</div>
      {days.map((d) => {
        const items = entries.filter((e) => e.personId === person.id && e.date === d);
        return (
          <div key={d} className={`roster-slot board-cell ${items.length ? 'covered' : 'vacant'}`}>
            {items.map((e, i) => (
              <span key={i} className={`roster-chip ${e.kind === 'shift' ? 'board-shift' : 'board-chip'}`}
                title={[e.activity, e.location, e.status, e.domain].filter(Boolean).join(' · ') || undefined}>
                {e.time && <span className="tnum tiny">{e.time}</span>}
                <span>{[e.activity, e.location].filter(Boolean).join(' · ') || e.status || '—'}</span>
              </span>
            ))}
          </div>
        );
      })}
    </>
  );
}
