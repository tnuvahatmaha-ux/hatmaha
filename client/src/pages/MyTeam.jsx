import { useState } from 'react';
import { useApi } from '../lib/useApi.js';
import { ViewHead, Avatar } from '../components/layout/AppLayout.jsx';
import { Panel, StateView, Tag, Accordion, Empty } from '../components/ui/index.jsx';
import { fmtDate, fmtTime, today, addDays, ROLE_NAMES, STATUS_NAMES, statusTone } from '../lib/format.js';

/** מסך המדריך: המטמיעים שבאחריותו, עם מצב ההכשרה והלו״ז הקרוב של כל אחד. */
export default function MyTeam() {
  const team = useApi('/api/settings/mentors/my-team');

  return (
    <>
      <ViewHead title="הצוות שלי" subtitle="המטמיעים שמשויכים אליך, והמצב שלהם" />

      <StateView
        loading={team.loading}
        error={team.error}
        onRetry={team.reload}
        empty={!team.loading && (team.data?.team ?? []).length === 0}
        emptyProps={{
          icon: '👥',
          title: 'עדיין לא שויכו אליך מטמיעים',
          text: 'שיוך מטמיע למדריך נעשה במסך המטמיעים, על ידי מנהל ההטמעה.',
        }}
      >
        <Panel flush>
          {(team.data?.team ?? []).map((person) => (
            <TeamMember key={person.id} person={person} />
          ))}
        </Panel>
      </StateView>
    </>
  );
}

function TeamMember({ person }) {
  const [open, setOpen] = useState(false);
  const from = today();
  const schedule = useApi(open ? '/api/schedule/me' : null, {
    from, to: addDays(from, 14), userId: person.id,
  });

  return (
    <Accordion
      title={
        <span className="row" style={{ gap: 8 }}>
          <Avatar name={person.full_name} size={28} />
          {person.full_name}
        </span>
      }
      meta={
        <>
          <Tag>{ROLE_NAMES[person.base_role]}</Tag>
          {person.sites.map((s) => <Tag key={s.id}>{s.name}</Tag>)}
          {person.training_status_name && <Tag tone="accent">{person.training_status_name}</Tag>}
          <Tag tone={statusTone(person.status)}>{STATUS_NAMES[person.status]}</Tag>
        </>
      }
    >
      <div onFocus={() => setOpen(true)} onMouseEnter={() => setOpen(true)}>
        <div className="grid grid-2" style={{ marginBlockEnd: 'var(--space-4)' }}>
          <div>
            <div className="field-label">תחומים</div>
            <div className="row" style={{ gap: 4 }}>
              {person.domains.length
                ? person.domains.map((d) => <Tag key={d.id}>{d.name}</Tag>)
                : <span className="muted">—</span>}
            </div>
          </div>
          <div>
            <div className="field-label">תתי-קטגוריות</div>
            <div className="row" style={{ gap: 4 }}>
              {person.sub_categories.length
                ? person.sub_categories.map((sc) => <Tag key={sc.id}>{sc.name}</Tag>)
                : <span className="muted">—</span>}
            </div>
          </div>
          <div>
            <div className="field-label">דוא״ל</div>
            <div dir="ltr" style={{ textAlign: 'start' }}>{person.email}</div>
          </div>
          <div>
            <div className="field-label">טלפון</div>
            <div dir="ltr" style={{ textAlign: 'start' }}>{person.phone ?? '—'}</div>
          </div>
        </div>

        <h3 style={{ marginBlockEnd: 'var(--space-2)' }}>הלו״ז הקרוב</h3>
        <StateView
          loading={schedule.loading}
          error={schedule.error}
          onRetry={schedule.reload}
          empty={!schedule.loading && (schedule.data?.items ?? []).length === 0}
          emptyProps={{ icon: '🗓️', title: 'אין שיבוצים או פעילויות בשבועיים הקרובים' }}
        >
          <div className="table-wrap">
            <table className="table table-cards">
              <thead>
                <tr><th>תאריך</th><th>שעות</th><th>פעילות</th><th>סוג</th></tr>
              </thead>
              <tbody>
                {(schedule.data?.items ?? []).slice(0, 10).map((item) => (
                  <tr key={`${item.kind}-${item.id}`}>
                    <td data-label="תאריך" className="tnum">{fmtDate(item.entry_date)}</td>
                    <td data-label="שעות" className="tnum">
                      {fmtTime(item.starts_at)}–{fmtTime(item.ends_at)}
                    </td>
                    <td data-label="פעילות">{item.title}</td>
                    <td data-label="סוג">
                      <Tag tone={{ shift: 'accent', activity: '', constraint: 'warn' }[item.kind]}>
                        {{ shift: 'משמרת', activity: 'פעילות', constraint: 'אילוץ' }[item.kind]}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </StateView>
      </div>
    </Accordion>
  );
}
