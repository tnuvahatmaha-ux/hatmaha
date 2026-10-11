-- =============================================================================
-- 0022 — סקילומטר: דירוג ידע של משתמשי הקצה באתר, בכמה סבבים
--
-- אחרי העלייה לאוויר, המטמיעים מדרגים כל משתמש קצה (צוות האתר שלומד את
-- המערכת) בכל נושא ידע של התחום שלו, בציון 1–4 (1 = הנמוך ביותר), ומוסיפים
-- הערה שמסבירה את הציונים. הסקילומטר חוזר בכמה סבבים במהלך העלייה לאוויר.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- הרשאות: משאב חדש "skills"
-- -----------------------------------------------------------------------------
insert into permissions (code, resource, action, name_he, display_order, is_active)
select 'skills.' || a.code, 'skills', a.code, 'סקילומטר / ' || a.name_he, 190 * 10 + a.ord,
       a.code not in ('approve', 'publish')
  from (values
        ('view'::perm_action, 'צפייה', 1), ('create'::perm_action, 'יצירה', 2),
        ('edit'::perm_action, 'עריכה', 3), ('delete'::perm_action, 'מחיקה', 4),
        ('approve'::perm_action, 'אישור', 5), ('publish'::perm_action, 'פרסום', 6),
        ('export'::perm_action, 'ייצוא', 7), ('manage'::perm_action, 'ניהול', 8)
       ) as a(code, name_he, ord)
on conflict (code) do nothing;

insert into role_permissions (role, permission_id, effect, scope_type)
select rp.role, p.id, 'allow', rp.scope::scope_type
  from (values
        ('manager'::base_role, 'manage', 'global'),
        ('mentor', 'view', 'site'),
        ('mentor', 'edit', 'site'),
        ('mentor', 'export', 'site'),
        ('lead', 'view', 'site'),
        ('lead', 'edit', 'site'),
        ('implementer', 'view', 'site'),
        ('implementer', 'edit', 'site')
       ) as rp(role, action, scope)
  join permissions p on p.resource = 'skills' and p.action = rp.action::perm_action
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- משתמשי הקצה של האתר
-- -----------------------------------------------------------------------------
create table if not exists end_users (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  full_name text not null,
  employee_no text,
  department text,
  role_title text,
  domain_id uuid references domains(id),
  sub_category_id uuid references sub_categories(id),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint end_users_name_not_blank check (length(btrim(full_name)) > 0)
);
create unique index if not exists end_users_employee_idx
  on end_users (site_id, employee_no) where employee_no is not null and deleted_at is null;
create index if not exists end_users_site_idx on end_users (site_id, domain_id) where deleted_at is null;
alter table end_users enable row level security;
select app.attach_managed('end_users');
revoke all on end_users from anon, authenticated;

-- -----------------------------------------------------------------------------
-- נושאי הידע — לפי תחום, ואופציונלית תת-תחום
-- -----------------------------------------------------------------------------
create table if not exists skill_topics (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id) on delete cascade,
  sub_category_id uuid references sub_categories(id) on delete cascade,
  name text not null,
  description text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint skill_topics_name_not_blank check (length(btrim(name)) > 0)
);
create unique index if not exists skill_topics_name_idx
  on skill_topics (domain_id, coalesce(sub_category_id, '00000000-0000-0000-0000-000000000000'::uuid), name)
  where deleted_at is null;
alter table skill_topics enable row level security;
select app.attach_managed('skill_topics');
revoke all on skill_topics from anon, authenticated;

-- -----------------------------------------------------------------------------
-- סבבים — כל סבב נבנה עם הנושאים שלו
-- -----------------------------------------------------------------------------
create table if not exists skill_rounds (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  name text not null,
  round_no integer not null default 1,
  opens_on date,
  closes_on date,
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint skill_rounds_name_not_blank check (length(btrim(name)) > 0),
  constraint skill_rounds_dates check (closes_on is null or opens_on is null or closes_on >= opens_on)
);
create index if not exists skill_rounds_site_idx on skill_rounds (site_id, round_no) where deleted_at is null;
alter table skill_rounds enable row level security;
select app.attach_managed('skill_rounds');
revoke all on skill_rounds from anon, authenticated;

create table if not exists skill_round_topics (
  round_id uuid not null references skill_rounds(id) on delete cascade,
  topic_id uuid not null references skill_topics(id) on delete cascade,
  primary key (round_id, topic_id)
);
alter table skill_round_topics enable row level security;
revoke all on skill_round_topics from anon, authenticated;

-- -----------------------------------------------------------------------------
-- ציונים והערות
-- -----------------------------------------------------------------------------
create table if not exists skill_scores (
  round_id uuid not null references skill_rounds(id) on delete cascade,
  end_user_id uuid not null references end_users(id) on delete cascade,
  topic_id uuid not null references skill_topics(id) on delete cascade,
  score smallint not null check (score between 1 and 4),
  rated_by uuid references profiles(id),
  rated_at timestamptz not null default now(),
  primary key (round_id, end_user_id, topic_id)
);
create index if not exists skill_scores_user_idx on skill_scores (end_user_id);
alter table skill_scores enable row level security;
revoke all on skill_scores from anon, authenticated;

create table if not exists skill_user_notes (
  round_id uuid not null references skill_rounds(id) on delete cascade,
  end_user_id uuid not null references end_users(id) on delete cascade,
  note text not null,
  updated_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  primary key (round_id, end_user_id)
);
alter table skill_user_notes enable row level security;
revoke all on skill_user_notes from anon, authenticated;

-- -----------------------------------------------------------------------------
-- ממוצע לכל משתמש קצה בסבב — לדשבורד ולייצוא
-- -----------------------------------------------------------------------------
create or replace view v_skill_summary as
  select s.round_id, eu.id as end_user_id, eu.full_name, eu.site_id, eu.domain_id,
         d.name as domain_name, eu.sub_category_id, eu.department,
         round(avg(s.score)::numeric, 2) as avg_score,
         count(*)::int as rated_count,
         min(s.score)::int as min_score
    from skill_scores s
    join end_users eu on eu.id = s.end_user_id and eu.deleted_at is null
    left join domains d on d.id = eu.domain_id
   group by s.round_id, eu.id, eu.full_name, eu.site_id, eu.domain_id, d.name, eu.sub_category_id, eu.department;

revoke all on v_skill_summary from anon, authenticated;

insert into notification_types (code, name_he, default_email, display_order) values
  ('skill_round_opened', 'נפתח סבב סקילומטר', false, 97)
on conflict (code) do nothing;
