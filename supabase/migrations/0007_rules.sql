-- =============================================================================
-- 0007 — מנוע החוקיות: סוגי תנאים, חוקים, מטריצת מאשרים, הערכות וחריגות
-- §10 + AC-09/10/11
-- =============================================================================

-- -----------------------------------------------------------------------------
-- rule_condition_types — 14 סוגי התנאים, כדאטה. ה-UI בונה את טופס הפרמטרים
-- מתוך params_schema, ולכן חוק חדש הוא INSERT ולא deploy.
-- -----------------------------------------------------------------------------
create table if not exists rule_condition_types (
  code text primary key,
  name_he text not null,
  description_he text,
  params_schema jsonb not null default '{"type":"object","properties":{}}'::jsonb,
  allowed_triggers rule_trigger[] not null,
  allowed_scopes rule_scope_type[] not null default
    '{global,site,domain,sub_category,user}'::rule_scope_type[],
  display_order integer not null default 0,
  is_active boolean not null default true
);
alter table rule_condition_types enable row level security;

insert into rule_condition_types
  (code, name_he, description_he, params_schema, allowed_triggers, display_order) values

  ('noOverlap', 'ללא חפיפות',
   'הפעולה נחסמת אם היא חופפת לשיבוץ, לפעילות או לאילוץ קיים של אותו אדם',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   '{assign,submit,change}'::rule_trigger[], 10),

  ('maxHoursPerDay', 'מקסימום שעות ביום',
   'סך שעות העבודה של אדם ביום קלנדרי אחד',
   '{"type":"object","properties":{"hours":{"type":"number","minimum":1,"maximum":24,"title":"שעות"}},"required":["hours"]}'::jsonb,
   '{assign,change}'::rule_trigger[], 20),

  ('minRestHours', 'מנוחה מינימלית',
   'פער השעות הנדרש בין שתי משמרות או פעילויות עוקבות',
   '{"type":"object","properties":{"hours":{"type":"number","minimum":0,"maximum":24,"title":"שעות"}},"required":["hours"]}'::jsonb,
   '{assign,change}'::rule_trigger[], 30),

  ('maxConsecutiveHours', 'מקסימום שעות רצופות',
   'משך רצוף מרבי של שיבוץ יחיד',
   '{"type":"object","properties":{"hours":{"type":"number","minimum":1,"maximum":24,"title":"שעות"}},"required":["hours"]}'::jsonb,
   '{assign,change}'::rule_trigger[], 40),

  ('withinSiteHours', 'בתוך שעות האתר',
   'השיבוץ חייב להיות בין שעת הפתיחה לשעת הסגירה של האתר',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   '{assign,change}'::rule_trigger[], 50),

  ('minNoticeDays', 'הודעה מוקדמת',
   'מספר הימים המינימלי בין מועד ההגשה למועד הבקשה',
   '{"type":"object","properties":{"days":{"type":"integer","minimum":0,"maximum":90,"title":"ימים"}},"required":["days"]}'::jsonb,
   '{submit}'::rule_trigger[], 60),

  ('maxConstraintsPerWeek', 'מקסימום אילוצים בשבוע',
   'כמה בקשות אילוץ פעילות מותרות לאדם באותו שבוע',
   '{"type":"object","properties":{"count":{"type":"integer","minimum":0,"maximum":20,"title":"כמות"}},"required":["count"]}'::jsonb,
   '{submit}'::rule_trigger[], 70),

  ('requiresQualification', 'דרישת הסמכה',
   'שיבוץ מותנה בהסמכה חיה בתת-הקטגוריה. ללא פרמטר — נבדקות תתי-הקטגוריות של השיבוץ',
   '{"type":"object","properties":{"subCategoryId":{"type":"string","format":"uuid","title":"הסמכה נדרשת"}},"required":[]}'::jsonb,
   '{assign,change}'::rule_trigger[], 80),

  ('mentorRatio', 'יחס מדריך למטמיעים',
   'מספר המטמיעים המרבי שניתן לשייך למדריך אחד',
   '{"type":"object","properties":{"max":{"type":"integer","minimum":1,"maximum":100,"title":"מקסימום"}},"required":["max"]}'::jsonb,
   '{assign,change}'::rule_trigger[], 90),

  ('mandatoryTraining', 'הדרכת חובה הושלמה',
   'שיבוץ מותנה בהשתתפות מושלמת בפעילות מסוג מסוים',
   '{"type":"object","properties":{"activityTypeId":{"type":"string","format":"uuid","title":"סוג פעילות"}},"required":["activityTypeId"]}'::jsonb,
   '{assign,change}'::rule_trigger[], 100),

  ('availabilityRequired', 'שיבוץ רק בזמינות מוצהרת',
   'שיבוץ מותר רק אם האדם הצהיר על זמינות למשמרת הזו',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   '{assign,change}'::rule_trigger[], 110),

  ('deadline', 'מועד הגשת זמינות',
   'המועד שאחריו הגשת זמינות לשבוע הבא מחייבת אישור',
   '{"type":"object","properties":{"weekday":{"type":"integer","minimum":0,"maximum":6,"title":"יום בשבוע (0=ראשון)"},"hour":{"type":"integer","minimum":0,"maximum":23,"title":"שעה"}},"required":["weekday","hour"]}'::jsonb,
   '{submit}'::rule_trigger[], 120),

  ('blackoutDates', 'תקופת חסימה',
   'טווח תאריכים שבו לא ניתן לשבץ או להגיש',
   '{"type":"object","properties":{"from":{"type":"string","format":"date","title":"מתאריך"},"to":{"type":"string","format":"date","title":"עד תאריך"}},"required":["from","to"]}'::jsonb,
   '{assign,submit,change}'::rule_trigger[], 130),

  ('minStaffCoverage', 'כיסוי משמרות',
   'בעת פרסום — כל משמרת חייבת להגיע לתקן כוח האדם שהוגדר לה',
   '{"type":"object","properties":{},"required":[]}'::jsonb,
   '{publish}'::rule_trigger[], 140)

on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- rules — חוק עסקי ברמת מערכת, אתר, תחום, תת-קטגוריה או משתמש
-- -----------------------------------------------------------------------------
create table if not exists rules (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  scope_type rule_scope_type not null default 'global',
  scope_id   uuid,
  trigger    rule_trigger not null,
  applies_to text not null default 'any'
             check (applies_to in ('any','constraint','availability','activity','roster','mentor_assignment')),
  condition_type_code text not null references rule_condition_types(code),
  condition_params jsonb not null default '{}'::jsonb,
  severity rule_severity not null default 'warning',
  approver_role base_role,
  approver_user_id uuid references profiles(id),
  priority integer not null default 100,
  valid_from timestamptz not null default now(),
  valid_to   timestamptz,
  message_he text not null,
  is_active boolean not null default true,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  constraint rules_name_not_blank check (length(btrim(name)) > 0),
  constraint rules_scope_shape check (
    (scope_type = 'global' and scope_id is null) or
    (scope_type in ('site','domain','sub_category','user') and scope_id is not null)),
  constraint rules_window check (valid_to is null or valid_to > valid_from),
  -- חומרה שדורשת אישור חייבת מאשר, אחרת הבקשה תיתקע בלי נמען
  constraint rules_approver_required check (
    severity <> 'approval_required'
    or approver_role is not null or approver_user_id is not null)
);
create index if not exists rules_lookup_idx
  on rules (trigger, scope_type, scope_id, priority)
  where is_active and deleted_at is null;
create index if not exists rules_params_idx on rules using gin (condition_params jsonb_path_ops);
alter table rules enable row level security;
select app.attach_managed('rules');
drop trigger if exists rules_normalize on rules;
create trigger rules_normalize before insert or update on rules
  for each row execute function app.tg_normalize_name();

-- -----------------------------------------------------------------------------
-- approval_matrix — §17 "מטריצת מאשרים לפי אתר, תחום וסוג חריגה"
-- -----------------------------------------------------------------------------
create table if not exists approval_matrix (
  id uuid primary key default gen_random_uuid(),
  site_id   uuid references sites(id)   on delete cascade,
  domain_id uuid references domains(id) on delete cascade,
  condition_type_code text references rule_condition_types(code),
  constraint_type_id uuid references constraint_types(id),
  approver_role base_role,
  approver_user_id uuid references profiles(id),
  fallback_user_id uuid references profiles(id),
  priority integer not null default 100,
  valid_from timestamptz not null default now(),
  valid_to   timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint approval_matrix_target check (
    approver_role is not null or approver_user_id is not null)
);
create index if not exists approval_matrix_lookup_idx
  on approval_matrix (site_id, domain_id, condition_type_code, priority)
  where is_active and deleted_at is null;
alter table approval_matrix enable row level security;
select app.attach_managed('approval_matrix');

-- -----------------------------------------------------------------------------
-- rule_evaluations — append-only. שומר Snapshot של החוקים כפי שהיו ברגע
-- הבדיקה (§12), כך שהחלטה ישנה תמיד ניתנת להסבר גם אחרי שינוי חוק.
-- -----------------------------------------------------------------------------
create table if not exists rule_evaluations (
  id uuid primary key default gen_random_uuid(),
  correlation_id uuid not null default gen_random_uuid(),
  trigger rule_trigger not null,
  subject_type text not null,
  subject_id uuid,
  actor_user_id uuid references profiles(id),
  target_user_id uuid references profiles(id),
  site_id uuid references sites(id),
  domain_id uuid references domains(id),
  context jsonb not null default '{}'::jsonb,
  rules_snapshot jsonb not null default '[]'::jsonb,
  results jsonb not null default '[]'::jsonb,
  outcome rule_outcome not null,
  trace_id text,
  created_at timestamptz not null default now()
);
create index if not exists rule_eval_subject_idx
  on rule_evaluations (subject_type, subject_id, created_at desc);
create index if not exists rule_eval_actor_idx
  on rule_evaluations (actor_user_id, created_at desc);
create index if not exists rule_eval_created_brin
  on rule_evaluations using brin (created_at);
alter table rule_evaluations enable row level security;

drop trigger if exists rule_evaluations_append_only on rule_evaluations;
create trigger rule_evaluations_append_only
  before update or delete on rule_evaluations
  for each row execute function app.tg_append_only();

-- -----------------------------------------------------------------------------
-- exception_requests
--
-- pending_action הוא הביטוי המבני של AC-10: הפעולה אינה מבוצעת ואז מגולגלת
-- אחורה — היא לעולם לא מבוצעת. היא חונה כאן כדאטה, ומשוחזרת רק אחרי אישור.
-- -----------------------------------------------------------------------------
create table if not exists exception_requests (
  id uuid primary key default gen_random_uuid(),
  rule_evaluation_id uuid not null references rule_evaluations(id),
  rule_id uuid references rules(id),
  subject_type text not null,
  subject_id uuid,
  requested_by uuid not null references profiles(id),
  target_user_id uuid references profiles(id),
  site_id uuid references sites(id),
  domain_id uuid references domains(id),
  severity rule_severity not null default 'approval_required',
  summary text not null,
  reason text,
  pending_action jsonb not null default '{}'::jsonb,
  status exception_status not null default 'pending',
  approver_user_id uuid references profiles(id),
  approver_role base_role,
  decided_at timestamptz,
  decision_comment text,
  applied_at timestamptz,
  applied_result jsonb,
  expires_at timestamptz,
  idempotency_key text,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  -- "החלטה עם נימוק חובה" (§10)
  constraint exception_decision_comment check (
    status not in ('approved','rejected')
    or length(btrim(coalesce(decision_comment, ''))) >= 3),
  constraint exception_decided_at check (
    status not in ('approved','rejected') or decided_at is not null)
);
create unique index if not exists exception_idem_idx
  on exception_requests (idempotency_key) where idempotency_key is not null;
create index if not exists exception_queue_idx
  on exception_requests (status, approver_user_id, created_at) where status = 'pending';
create index if not exists exception_subject_idx
  on exception_requests (subject_type, subject_id);
create index if not exists exception_target_idx
  on exception_requests (target_user_id, status);
alter table exception_requests enable row level security;
select app.attach_managed('exception_requests');
