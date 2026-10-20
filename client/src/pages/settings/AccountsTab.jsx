import { useMemo, useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { post } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Field, Modal, Notice } from '../../components/ui/index.jsx';
import { ROLE_NAMES, STATUS_NAMES, statusTone, fmtDateTime } from '../../lib/format.js';

/** סיסמה זמנית קריאה: בלי תווים שמתבלבלים (0/O, 1/l) */
function generatePassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

/**
 * משתמשים וסיסמאות — מנהל ההטמעה בלבד.
 *
 * שם המשתמש הוא כתובת הדוא״ל. הסיסמה נשמרת מוצפנת (hash) ב-Supabase, ולכן
 * אי אפשר להציג סיסמה שמשתמש בחר — אפשר להגדיר לו סיסמה חדשה ולהעביר לו אותה.
 */
export default function AccountsTab() {
  const accounts = useApi('/api/users/accounts');
  const [q, setQ] = useState('');
  const [resetting, setResetting] = useState(null);

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (accounts.data?.accounts ?? []).filter((a) =>
      !term || a.full_name.toLowerCase().includes(term) || String(a.email).toLowerCase().includes(term));
  }, [accounts.data, q]);

  return (
    <>
      <Panel
        title="משתמשים וסיסמאות"
        subtitle="שם המשתמש להתחברות הוא כתובת הדוא״ל. סיסמה שמשתמש בחר שמורה מוצפנת ואי אפשר לצפות בה — אפשר לאפס אותה לסיסמה חדשה."
        actions={<input type="search" placeholder="חיפוש שם או דוא״ל" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 220 }} aria-label="חיפוש" />}
        flush
      >
        <StateView loading={accounts.loading} error={accounts.error} onRetry={accounts.reload}
          empty={!accounts.loading && list.length === 0} emptyProps={{ icon: '👤', title: 'לא נמצאו משתמשים' }}>
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr><th>שם</th><th>שם משתמש (דוא״ל)</th><th>תפקיד</th><th>סטטוס</th><th>כניסה אחרונה</th><th>איפוס אחרון</th><th /></tr>
              </thead>
              <tbody>
                {list.map((a) => (
                  <tr key={a.id}>
                    <td data-label="שם" className="bold">{a.full_name}</td>
                    <td data-label="שם משתמש" className="small" dir="ltr" style={{ textAlign: 'start' }}>{a.email}</td>
                    <td data-label="תפקיד" className="small">{ROLE_NAMES[a.base_role] ?? a.base_role}</td>
                    <td data-label="סטטוס"><Tag tone={statusTone(a.status)}>{STATUS_NAMES[a.status] ?? a.status}</Tag></td>
                    <td data-label="כניסה אחרונה" className="small tnum">{a.last_sign_in_at ? fmtDateTime(a.last_sign_in_at) : '—'}</td>
                    <td data-label="איפוס אחרון" className="small tnum">
                      {a.password_reset_at ? fmtDateTime(a.password_reset_at) : '—'}
                      {a.password_reset_by_name && <div className="tiny muted">{a.password_reset_by_name}</div>}
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm nowrap" onClick={() => setResetting(a)}>איפוס סיסמה</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </Panel>

      {resetting && (
        <ResetDialog account={resetting} onClose={() => setResetting(null)} onDone={accounts.reload} />
      )}
    </>
  );
}

function ResetDialog({ account, onClose, onDone }) {
  const toast = useToast();
  const [password, setPassword] = useState(generatePassword);
  const [saved, setSaved] = useState(false);

  const save = useAction(
    async () => {
      await post(`/api/users/${account.id}/password`, { password });
      setSaved(true);
      onDone();
    },
    { onError: (err) => toast.error(err) },
  );

  const copy = () => {
    navigator.clipboard?.writeText(`שם משתמש: ${account.email}\nסיסמה: ${password}`)
      .then(() => toast.success('הפרטים הועתקו'))
      .catch(() => {});
  };

  return (
    <Modal
      title={`איפוס סיסמה — ${account.full_name}`}
      onClose={onClose}
      footer={saved ? (
        <>
          <button type="button" className="btn btn-primary" onClick={copy}>העתקת שם משתמש וסיסמה</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>סגירה</button>
        </>
      ) : (
        <>
          <button type="button" className="btn btn-primary" onClick={() => save.run()} disabled={save.busy || password.length < 8}>
            {save.busy ? 'שומר…' : 'הגדרת הסיסמה'}
          </button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>ביטול</button>
        </>
      )}
    >
      {saved ? (
        <Notice tone="ok" icon="✅" title="הסיסמה עודכנה">
          <div className="small">העבירו למשתמש את הפרטים. הם מוצגים עכשיו בלבד ולא יישמרו לצפייה.</div>
          <div className="mt-3" dir="ltr" style={{ textAlign: 'start', fontFamily: 'ui-monospace, monospace' }}>
            <div>{account.email}</div>
            <div className="bold" style={{ fontSize: 18 }}>{password}</div>
          </div>
        </Notice>
      ) : (
        <>
          <div className="small muted" style={{ marginBlockEnd: 'var(--space-3)' }}>
            שם משתמש: <span dir="ltr">{account.email}</span>
          </div>
          <Field label="סיסמה חדשה" hint="לפחות 8 תווים. נוצרה סיסמה אקראית — אפשר להחליף.">
            {(props) => (
              <div className="row" style={{ gap: 6 }}>
                <input {...props} value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" style={{ flex: 1, fontFamily: 'ui-monospace, monospace' }} />
                <button type="button" className="btn btn-sm" onClick={() => setPassword(generatePassword())}>אקראית</button>
              </div>
            )}
          </Field>
          <div className="tiny muted">הסיסמה הקודמת תפסיק לעבוד מיד.</div>
        </>
      )}
    </Modal>
  );
}
