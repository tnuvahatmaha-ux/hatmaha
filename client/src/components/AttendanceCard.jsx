import { useEffect, useState } from 'react';
import { useApi, useAction } from '../lib/useApi.js';
import { post } from '../lib/api.js';
import { useToast } from '../context/ToastContext.jsx';
import { Panel, StateView } from './ui/index.jsx';
import { fmtTime } from '../lib/format.js';

/** משך "3:25" מרגע מסוים ועד עכשיו (או עד רגע אחר) */
const duration = (from, to) => {
  const mins = Math.max(0, Math.round(((to ? new Date(to) : new Date()) - new Date(from)) / 60000));
  return `${Math.floor(mins / 60)}:${String(mins % 60).padStart(2, '0')}`;
};

/**
 * נוכחות במסך הבית: כפתור כניסה / יציאה, מה מתוכנן היום, ומה כבר נרשם.
 */
export function AttendanceCard() {
  const toast = useToast();
  const data = useApi('/api/attendance/me/today');
  const [, tick] = useState(0);
  const open = data.data?.open;

  // שעון רץ בזמן שהמשמרת פתוחה
  useEffect(() => {
    if (!open) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, [open]);

  const clock = useAction(
    async () => {
      if (open) {
        await post('/api/attendance/clock-out', {});
        toast.success('היציאה נרשמה. יום טוב!');
      } else {
        await post('/api/attendance/clock-in', {});
        toast.success('הכניסה נרשמה');
      }
      data.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const planned = data.data?.planned ?? [];
  const closed = (data.data?.records ?? []).filter((r) => r.clock_out_at);

  return (
    <Panel title="נוכחות" subtitle={open ? `במשמרת מ-${fmtTime(open.clock_in_at)}` : 'סימון שעת הגעה ויציאה'}>
      <StateView loading={data.loading} error={data.error} onRetry={data.reload}>
        {planned.length > 0 && (
          <div className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
            מתוכנן היום:{' '}
            {planned.map((p) => `${fmtTime(p.starts_at)}–${fmtTime(p.ends_at)} ${p.title}`).join(' · ')}
          </div>
        )}
        <button
          type="button"
          className={`btn ${open ? 'btn-danger' : 'btn-primary'} attendance-btn`}
          onClick={() => clock.run()}
          disabled={clock.busy}
        >
          {clock.busy ? '…' : open ? `יציאה · ${duration(open.clock_in_at)}` : 'כניסה'}
        </button>
        {closed.length > 0 && (
          <div className="tiny muted mt-3">
            היום: {closed.map((r) => `${fmtTime(r.clock_in_at)}–${fmtTime(r.clock_out_at)}`).join(' · ')}
          </div>
        )}
      </StateView>
    </Panel>
  );
}
