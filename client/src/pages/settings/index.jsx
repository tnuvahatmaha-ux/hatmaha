import { useSearchParams } from 'react-router-dom';
import { usePermissions } from '../../context/PermissionsContext.jsx';
import { ViewHead } from '../../components/layout/AppLayout.jsx';
import { Panel, Forbidden } from '../../components/ui/index.jsx';

import DomainsTab from './DomainsTab.jsx';
import CatalogsTab from './CatalogsTab.jsx';
import LocationTypesTab from './LocationTypesTab.jsx';
import RulesTab from './RulesTab.jsx';
import MentorsTab from './MentorsTab.jsx';
import PermissionsTab from './PermissionsTab.jsx';
import AuditTab from './AuditTab.jsx';
import SystemTab from './SystemTab.jsx';

/**
 * הגדרות המערכת.
 *
 * AC-08: ניהול מדריכים יושב כאן, ולא כמודול ניווט עצמאי.
 * כל טאב מצהיר על ההרשאה שהוא דורש ומוצג רק למי שיש לו אותה.
 */
const TABS = [
  { id: 'domains', label: 'תחומים', need: ['domains', 'view'], Component: DomainsTab },
  { id: 'catalogs', label: 'סוגים וסטטוסים', need: ['settings', 'view'], Component: CatalogsTab },
  { id: 'locationTypes', label: 'סוגי מיקום', need: ['settings', 'view'], Component: LocationTypesTab },
  { id: 'rules', label: 'חוקיות', need: ['rules', 'view'], Component: RulesTab },
  { id: 'mentors', label: 'ניהול מדריכים', need: ['mentors', 'view'], Component: MentorsTab },
  { id: 'permissions', label: 'הרשאות', need: ['permissions', 'view'], Component: PermissionsTab, managerOnly: true },
  { id: 'audit', label: 'יומן ביקורת', need: ['audit', 'view'], Component: AuditTab },
  { id: 'system', label: 'מערכת', need: ['settings', 'manage'], Component: SystemTab },
];

export default function Settings() {
  const { can, role } = usePermissions();
  const [params, setParams] = useSearchParams();

  const available = TABS.filter(
    (tab) => can(tab.need[0], tab.need[1]) && (!tab.managerOnly || role === 'manager'),
  );

  const activeId = params.get('tab') ?? available[0]?.id;
  const active = available.find((tab) => tab.id === activeId) ?? available[0];

  if (available.length === 0) {
    return (
      <>
        <ViewHead title="הגדרות" />
        <Panel><Forbidden text="אין לך הרשאה לאף אחד ממסכי ההגדרות." /></Panel>
      </>
    );
  }

  const Component = active.Component;

  return (
    <>
      <ViewHead
        title="הגדרות"
        subtitle="ניהול תחומים, קטלוגים, חוקיות, מדריכים והרשאות — ללא שינוי קוד"
        actions={
          <div className="row" style={{ gap: 0 }} role="tablist" aria-label="מסכי ההגדרות">
            {available.map((tab) => (
              <button
                key={tab.id}
                type="button"
                role="tab"
                aria-selected={tab.id === active.id}
                className={`btn btn-sm${tab.id === active.id ? ' btn-primary' : ''}`}
                onClick={() => setParams({ tab: tab.id })}
                style={{ marginInlineStart: -2 }}
              >
                {tab.label}
              </button>
            ))}
          </div>
        }
      />
      <Component />
    </>
  );
}
