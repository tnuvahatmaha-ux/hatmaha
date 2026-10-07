import { useEffect, useMemo, useState } from 'react';
import { useApi, useAction } from '../../lib/useApi.js';
import { get, post, del, newIdempotencyKey } from '../../lib/api.js';
import { useToast } from '../../context/ToastContext.jsx';
import { Panel, StateView, Tag, Notice, Field, Empty } from '../../components/ui/index.jsx';
import { fmtDateTime, fmtDateFull, ROLE_NAMES, SCOPE_NAMES } from '../../lib/format.js';

const ACTIONS = ['view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'manage'];
const ACTION_LABELS = {
  view: 'צפייה', create: 'יצירה', edit: 'עריכה', delete: 'מחיקה',
  approve: 'אישור', publish: 'פרסום', export: 'ייצוא', manage: 'ניהול',
};

/**
 * מסך ההרשאות — AC-02 ו-AC-03.
 *
 * הזרימה היא בדיוק זו שב-§3.2: בחירת משתמש → פונקציה → פעולה → Scope →
 * תוקף → סיבה → תצוגה מקדימה של ההרשאות האפקטיביות → שמירה.
 * התצוגה המקדימה היא קריאה בלבד ואינה שומרת דבר.
 */
export default function PermissionsTab() {
  const toast = useToast();
  const [userId, setUserId] = useState('');
  const [search, setSearch] = useState('');

  const users = useApi('/api/users', { q: search, limit: 200 });
  const catalog = useApi('/api/permissions/catalog');
  const sites = useApi('/api/sites');
  const domains = useApi('/api/settings/domains');

  const effective = useApi(userId ? `/api/permissions/effective/${userId}` : null);
  const grants = useApi(userId ? '/api/permissions/grants' : null, { userId });

  const [draft, setDraft] = useState({
    resource: 'roster',
    action: 'edit',
    effect: 'allow',
    scopeType: 'site',
    scopeId: '',
    validTo: '',
    reason: '',
  });
  const [preview, setPreview] = useState(null);

  const selectedUser = (users.data?.users ?? []).find((u) => u.id === userId);

  const draftGrant = useMemo(
    () => ({
      permissionCode: `${draft.resource}.${draft.action}`,
      effect: draft.effect,
      scopeType: draft.scopeType,
      scopeId: ['site', 'domain', 'sub_category'].includes(draft.scopeType) ? draft.scopeId || null : null,
      validTo: draft.validTo ? new Date(`${draft.validTo}T23:59:59`).toISOString() : null,
    }),
    [draft],
  );

  const runPreview = useAction(
    async () => {
      const result = await post('/api/permissions/preview', { userId, draftGrants: [draftGrant] });
      setPreview(result);
      return result;
    },
    { onError: (err) => toast.error(err) },
  );

  const save = useAction(
    async () => {
      await post(
        '/api/permissions/grants',
        { userId, ...draftGrant, reason: draft.reason || null },
        { idempotencyKey: newIdempotencyKey() },
      );
      toast.success('ההרשאה נשמרה ונכנסה לתוקף מיד');
      setPreview(null);
      setDraft({ ...draft, reason: '' });
      effective.reload();
      grants.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  const revoke = useAction(
    async (grantId) => {
      await del(`/api/permissions/grants/${grantId}`, { body: { reason: 'בוטל מהממשק' } });
      toast.success('ההרשאה בוטלה');
      effective.reload();
      grants.reload();
    },
    { onError: (err) => toast.error(err) },
  );

  // התצוגה המקדימה מתאפסת בכל שינוי בטיוטה — אחרת היא מציגה מצב ישן
  useEffect(() => setPreview(null), [draftGrant, userId]);

  const isExtension = preview?.isExtension ?? false;
  const matrix = preview?.matrix ?? effective.data?.matrix;

  const scopeOptions = () => {
    switch (draft.scopeType) {
      case 'site': return (sites.data?.sites ?? []).map((s) => ({ id: s.id, name: s.name }));
      case 'domain': return (domains.data?.domains ?? []).map((d) => ({ id: d.id, name: d.name }));
      case 'sub_category':
        return (domains.data?.domains ?? []).flatMap((d) =>
          d.subCategories.map((sc) => ({ id: sc.id, name: `${sc.name} (${d.name})` })),
        );
      default: return [];
    }
  };

  return (
    <>
      <Notice icon="🔐" title="רק מנהל הטמעה רשאי לנהל הרשאות">
        <span className="small">
          הרשאה פרטנית מרחיבה או מצמצמת את תפקיד הבסיס. שלילה מפורשת גוברת על היתר,
          ואין הרשאה משתמעת. כל שינוי נרשם ביומן הביקורת ונכנס לתוקף מיד, בלי פריסה מחדש.
        </span>
      </Notice>

      <Panel title="בחירת משתמש">
        <div className="row">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="חיפוש לפי שם או דוא״ל"
            aria-label="חיפוש משתמש"
            style={{ maxWidth: 240 }}
          />
          <select
            value={userId}
            onChange={(e) => { setUserId(e.target.value); setPreview(null); }}
            aria-label="בחירת משתמש"
            style={{ maxWidth: 320 }}
          >
            <option value="">בחירת משתמש</option>
            {(users.data?.users ?? []).map((user) => (
              <option key={user.id} value={user.id}>
                {user.full_name} — {ROLE_NAMES[user.base_role]}
              </option>
            ))}
          </select>
        </div>
      </Panel>

      {!userId ? (
        <Panel>
          <Empty icon="👤" title="בחר/י משתמש" text="מטריצת ההרשאות האפקטיביות תוצג כאן." />
        </Panel>
      ) : (
        <>
          <Panel
            title="הענקת הרשאה פרטנית"
            subtitle={`${selectedUser?.full_name ?? ''} — תפקיד בסיס: ${ROLE_NAMES[selectedUser?.base_role] ?? ''}`}
          >
            <div className="grid grid-3">
              <Field label="פונקציה" required>
                {(props) => (
                  <select {...props} value={draft.resource} onChange={(e) => setDraft({ ...draft, resource: e.target.value })}>
                    {(catalog.data?.resources ?? []).map((r) => (
                      <option key={r.resource} value={r.resource}>{r.nameHe}</option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="פעולה" required>
                {(props) => (
                  <select {...props} value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })}>
                    {ACTIONS.map((action) => (
                      <option key={action} value={action}>{ACTION_LABELS[action]}</option>
                    ))}
                  </select>
                )}
              </Field>

              <Field label="סוג" required>
                {(props) => (
                  <select {...props} value={draft.effect} onChange={(e) => setDraft({ ...draft, effect: e.target.value })}>
                    <option value="allow">הרחבה — מתן הרשאה</option>
                    <option value="deny">צמצום — שלילת הרשאה</option>
                  </select>
                )}
              </Field>

              <Field label="Scope" required>
                {(props) => (
                  <select {...props} value={draft.scopeType}
                    onChange={(e) => setDraft({ ...draft, scopeType: e.target.value, scopeId: '' })}>
                    {Object.entries(SCOPE_NAMES)
                      .filter(([key]) => key !== 'user')
                      .map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                )}
              </Field>

              {['site', 'domain', 'sub_category'].includes(draft.scopeType) && (
                <Field label="ישות" required error={save.fieldErrors.scopeId}>
                  {(props) => (
                    <select {...props} value={draft.scopeId} onChange={(e) => setDraft({ ...draft, scopeId: e.target.value })}>
                      <option value="">בחירה</option>
                      {scopeOptions().map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                    </select>
                  )}
                </Field>
              )}

              <Field label="בתוקף עד" hint="ריק = ללא הגבלת זמן. הפקיעה מיידית ואוטומטית.">
                {(props) => (
                  <input {...props} type="date" value={draft.validTo}
                    onChange={(e) => setDraft({ ...draft, validTo: e.target.value })} />
                )}
              </Field>
            </div>

            <Field
              label="סיבה"
              required={draft.effect === 'allow'}
              error={save.fieldErrors.reason}
              hint={
                draft.effect === 'allow'
                  ? 'הרחבה מעבר לתפקיד הבסיס מחייבת נימוק, שנשמר ביומן הביקורת'
                  : 'אופציונלי בצמצום הרשאה'
              }
            >
              {(props) => (
                <textarea {...props} value={draft.reason}
                  onChange={(e) => setDraft({ ...draft, reason: e.target.value })}
                  placeholder="למשל: החלפת רכזת שיצאה לחופשת לידה, עד 31/12" />
              )}
            </Field>

            <div className="row">
              <button type="button" className="btn" onClick={() => runPreview.run()} disabled={runPreview.busy}>
                {runPreview.busy ? 'מחשב…' : 'תצוגה מקדימה'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => save.run()}
                disabled={save.busy || (draft.effect === 'allow' && draft.reason.trim().length < 5)}
              >
                {save.busy ? 'שומר…' : 'שמירה'}
              </button>
              {preview && (
                <Tag tone={isExtension ? 'warn' : ''}>
                  {isExtension ? 'הרחבה חריגה מעבר לתפקיד הבסיס' : 'בתוך תפקיד הבסיס'}
                </Tag>
              )}
            </div>
          </Panel>

          <Panel
            title="הרשאות אפקטיביות"
            subtitle={
              preview
                ? 'התאים המסומנים בכתום ישתנו אם תישמר ההרשאה שבטיוטה'
                : 'מה המשתמש יכול לעשות בפועל, כולל ה-Scope לכל פעולה'
            }
            actions={preview && <Tag tone="accent">תצוגה מקדימה</Tag>}
            flush
          >
            <StateView loading={effective.loading} error={effective.error} onRetry={effective.reload}>
              {matrix && <Matrix matrix={matrix} catalog={catalog.data?.resources ?? []} />}
            </StateView>
          </Panel>

          <Panel title="הרשאות פרטניות שהוענקו" flush>
            <StateView
              loading={grants.loading}
              error={grants.error}
              onRetry={grants.reload}
              empty={!grants.loading && (grants.data?.grants ?? []).length === 0}
              emptyProps={{ icon: '🔑', title: 'למשתמש אין הרשאות פרטניות', text: 'הוא פועל לפי תפקיד הבסיס בלבד.' }}
            >
              <div className="table-wrap">
                <table className="table table-cards">
                  <thead>
                    <tr>
                      <th>הרשאה</th><th>סוג</th><th>Scope</th><th>תוקף</th>
                      <th>סיבה</th><th>מצב</th><th />
                    </tr>
                  </thead>
                  <tbody>
                    {(grants.data?.grants ?? []).map((grant) => (
                      <tr key={grant.id} style={grant.state === 'active' ? undefined : { opacity: 0.55 }}>
                        <td data-label="הרשאה" className="bold">{grant.name_he}</td>
                        <td data-label="סוג">
                          <Tag tone={grant.effect === 'allow' ? 'ok' : 'danger'}>
                            {grant.effect === 'allow' ? 'הרחבה' : 'צמצום'}
                          </Tag>
                        </td>
                        <td data-label="Scope">
                          {SCOPE_NAMES[grant.scope_type]}
                          {grant.scope_name && <div className="tiny muted">{grant.scope_name}</div>}
                        </td>
                        <td data-label="תוקף" className="tnum small">
                          {grant.valid_to ? `עד ${fmtDateFull(grant.valid_to.slice(0, 10))}` : 'ללא הגבלה'}
                        </td>
                        <td data-label="סיבה" className="small">{grant.reason ?? '—'}</td>
                        <td data-label="מצב">
                          <Tag tone={grant.state === 'active' ? 'ok' : grant.state === 'expired' ? 'warn' : ''}>
                            {{ active: 'בתוקף', expired: 'פג תוקף', revoked: 'בוטל', scheduled: 'עתידי' }[grant.state]}
                          </Tag>
                        </td>
                        <td>
                          {grant.state === 'active' && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => revoke.run(grant.id)}
                              disabled={revoke.busy}
                            >
                              ביטול
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </StateView>
          </Panel>
        </>
      )}
    </>
  );
}

function Matrix({ matrix, catalog }) {
  const resourceLabel = (resource) =>
    catalog.find((r) => r.resource === resource)?.nameHe ?? resource;

  return (
    <div className="table-wrap">
      <table className="perm-matrix">
        <thead>
          <tr>
            <th>פונקציה</th>
            {ACTIONS.map((action) => <th key={action}>{ACTION_LABELS[action]}</th>)}
          </tr>
        </thead>
        <tbody>
          {Object.entries(matrix).map(([resource, actions]) => (
            <tr key={resource}>
              <th scope="row">{resourceLabel(resource)}</th>
              {ACTIONS.map((action) => {
                const cell = actions[action];
                const className = [
                  cell.blocked ? 'perm-blocked' : cell.allowed ? 'perm-yes' : 'perm-no',
                  cell.changed ? 'perm-changed' : '',
                ].filter(Boolean).join(' ');

                return (
                  <td key={action} className={className} title={cell.summary || undefined}>
                    {cell.blocked ? '⛔' : cell.allowed ? (cell.scopes[0] ?? '✓') : '—'}
                    {cell.fromGrant && cell.allowed && <span title="מהרשאה פרטנית"> •</span>}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      <div className="legend" style={{ padding: 'var(--space-3)' }}>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--success-bg)' }} />מותר, עם ה-Scope</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--danger-bg)' }} />נשלל במפורש</span>
        <span className="legend-item"><span className="legend-swatch" style={{ outline: '2px solid var(--primary)' }} />ישתנה אם תישמר הטיוטה</span>
        <span className="legend-item">• = מגיע מהרשאה פרטנית ולא מתפקיד הבסיס</span>
      </div>
    </div>
  );
}
