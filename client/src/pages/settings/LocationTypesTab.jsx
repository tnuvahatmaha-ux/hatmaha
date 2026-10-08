import { useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post, put } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Field, Accordion, Segmented, Empty } from '../../components/ui/index.jsx';
import { fmtClock, DAY_NAMES } from '../../lib/format.js';

const PERIODS = [
  { value: 'training', label: 'הכשרה' },
  { value: 'golive', label: 'עלייה לאוויר' },
  { value: 'support', label: 'ליווי' },
];

/**
 * מאגר המיקומים — כל מיקום שהוקם באתר כלשהו נשמר כאן, ומופיע ברשימה
 * בפעם הבאה שמקימים אתר. לכל מיקום מוגדרים ימי פעילות, שעות ותבניות
 * משמרת — בנפרד לתקופת ההכשרה ולתקופת העלייה לאוויר.
 */
export default function LocationTypesTab() {
  const toast = useToast();
  const types = useApi('/api/settings/location-types');
  const [name, setName] = useState('');

  const add = useAction(
    async () => {
      if (!name.trim()) return;
      await post('/api/settings/location-types', { name: name.trim() });
      setName('');
      types.reload();
      toast.success('המיקום נוסף למאגר');
    },
    { onError: (err) => toast.error(err) },
  );

  return (
    <Panel
      title="מאגר מיקומים"
      subtitle="כל מיקום שהוקם נשמר כאן ומופיע ברשימה בהקמת אתר. השעות ותבניות המשמרת מוגדרות בנפרד להכשרה ולעלייה לאוויר"
      flush
    >
      <div className="panel-body">
        <form className="row" onSubmit={(e) => { e.preventDefault(); add.run(); }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="מיקום חדש — למשל: מחלקה פנימית"
            aria-label="שם המיקום"
            style={{ maxWidth: 280 }}
          />
          <button type="submit" className="btn btn-primary btn-sm" disabled={add.busy || !name.trim()}>
            הוספה
          </button>
        </form>
      </div>

      <StateView
        loading={types.loading}
        error={types.error}
        onRetry={types.reload}
        empty={!types.loading && (types.data?.locationTypes ?? []).length === 0}
        emptyProps={{ icon: '📍', title: 'המאגר ריק', text: 'מיקום שמוקם באתר נשמר כאן אוטומטית.' }}
      >
        {(types.data?.locationTypes ?? []).map((type) => (
          <LocationTypeCard key={type.id} type={type} onChanged={types.reload} />
        ))}
      </StateView>
    </Panel>
  );
}

function LocationTypeCard({ type, onChanged }) {
  const toast = useToast();
  const [period, setPeriod] = useState('training');

  const profile = type.profiles?.[period] ?? {
    active_days: [0, 1, 2, 3, 4],
    open_time: '08:00:00',
    close_time: '17:00:00',
    shift_templates: [],
  };

  const [draft, setDraft] = useState(null);
  const current = draft ?? {
    activeDays: profile.active_days ?? [],
    openTime: fmtClock(profile.open_time),
    closeTime: fmtClock(profile.close_time),
    shiftTemplates: (profile.shift_templates ?? []).map((t) => ({
      name: t.name, startTime: fmtClock(t.startTime), endTime: fmtClock(t.endTime),
    })),
  };

  const [newShift, setNewShift] = useState({ name: '', startTime: '08:00', endTime: '16:00' });

  const save = useAction(
    async () => {
      await put(`/api/settings/location-types/${type.id}/profiles/${period}`, current);
      setDraft(null);
      onChanged();
      toast.success('הפרופיל נשמר');
    },
    { onError: (err) => toast.error(err) },
  );

  const update = (patch) => setDraft({ ...current, ...patch });

  const toggleDay = (day) =>
    update({
      activeDays: current.activeDays.includes(day)
        ? current.activeDays.filter((d) => d !== day)
        : [...current.activeDays, day].sort(),
    });

  return (
    <Accordion
      title={type.name}
      meta={
        <>
          {!type.is_active && <Tag>מושבת</Tag>}
          <Tag>{Object.keys(type.profiles ?? {}).length} פרופילים</Tag>
        </>
      }
    >
      <Segmented
        label="תקופה"
        value={period}
        onChange={(value) => { setPeriod(value); setDraft(null); }}
        options={PERIODS}
      />

      <div className="mt-3">
        <Field label={`ימי פעילות — ${PERIODS.find((p) => p.value === period).label}`}>
          <div className="row" style={{ gap: 4 }}>
            {DAY_NAMES.map((dayName, index) => (
              <button
                key={index}
                type="button"
                className={`btn btn-sm${current.activeDays.includes(index) ? ' btn-primary' : ''}`}
                onClick={() => toggleDay(index)}
                aria-pressed={current.activeDays.includes(index)}
              >
                {dayName}
              </button>
            ))}
          </div>
        </Field>

        <div className="grid grid-2">
          <Field label="שעת פתיחה">
            {(props) => (
              <input {...props} type="time" value={current.openTime}
                onChange={(e) => update({ openTime: e.target.value })} />
            )}
          </Field>
          <Field label="שעת סגירה">
            {(props) => (
              <input {...props} type="time" value={current.closeTime}
                onChange={(e) => update({ closeTime: e.target.value })} />
            )}
          </Field>
        </div>

        <Field label="תבניות משמרת">
          {current.shiftTemplates.length === 0 ? (
            <p className="small muted">אין עדיין תבניות משמרת לתקופה הזו.</p>
          ) : (
            <div className="row" style={{ gap: 6, marginBlockEnd: 'var(--space-2)' }}>
              {current.shiftTemplates.map((shift, index) => (
                <span key={index} className="tag">
                  {shift.name} {shift.startTime}–{shift.endTime}
                  <button
                    type="button"
                    onClick={() => update({ shiftTemplates: current.shiftTemplates.filter((_, i) => i !== index) })}
                    aria-label={`הסרת ${shift.name}`}
                    style={{ border: 'none', background: 'transparent', cursor: 'pointer', padding: '0 2px' }}
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <div className="row">
            <input
              type="text"
              value={newShift.name}
              onChange={(e) => setNewShift({ ...newShift, name: e.target.value })}
              placeholder="שם המשמרת"
              aria-label="שם תבנית המשמרת"
              style={{ maxWidth: 160 }}
            />
            <input
              type="time"
              value={newShift.startTime}
              onChange={(e) => setNewShift({ ...newShift, startTime: e.target.value })}
              aria-label="שעת התחלה"
              style={{ width: 'auto' }}
            />
            <input
              type="time"
              value={newShift.endTime}
              onChange={(e) => setNewShift({ ...newShift, endTime: e.target.value })}
              aria-label="שעת סיום"
              style={{ width: 'auto' }}
            />
            <button
              type="button"
              className="btn btn-sm"
              disabled={!newShift.name.trim()}
              onClick={() => {
                update({ shiftTemplates: [...current.shiftTemplates, { ...newShift, name: newShift.name.trim() }] });
                setNewShift({ name: '', startTime: '08:00', endTime: '16:00' });
              }}
            >
              הוספה
            </button>
          </div>
        </Field>

        <Notice icon="ℹ">
          <span className="small">
            מיקום חדש מסוג זה מקבל את תבניות המשמרת של התקופה הנוכחית באתר, ומשם
            הן שלו: אפשר לערוך אותן במסך האתרים, ושינוי כאן אינו משנה מיקומים קיימים.
            להוספת תבנית למיקום קיים — כפתור ״העתקה מתבנית״ במסך האתרים.
          </span>
        </Notice>

        <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || !draft}>
          {save.busy ? 'שומר…' : 'שמירת הפרופיל'}
        </button>
      </div>
    </Accordion>
  );
}
