-- =============================================================================
-- 0005 — מבנה ארגוני: קטלוגים, תחומים, אתרים, תקופות, משמרות ומיקומים
-- =============================================================================

-- -----------------------------------------------------------------------------
-- קטלוגים (lookup) — ניתנים לעריכה מההגדרות, ללא שינוי קוד (§3.1, AC-08).
-- code הוא ASCII ומשמש את המנועים; name_he הוא מה שהמשתמש רואה.
-- -----------------------------------------------------------------------------

create table if not exists site_statuses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  display_order integer not null default 0,
  is_terminal boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1
);
alter table site_statuses enable row level security;
select app.attach_managed('site_statuses');

insert into site_statuses (code, name_he, display_order, is_terminal) values
  ('training', 'הכשרה',       10, false),
  ('golive',   'Go Live',     20, false),
  ('support',  'תמיכה',       30, false),
  ('ended',    'הסתיים',      40, true)
on conflict (code) do nothing;

create table if not exists activity_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  requires_location boolean not null default true,
  counts_as_training boolean not null default false,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1
);
alter table activity_types enable row level security;
select app.attach_managed('activity_types');

insert into activity_types (code, name_he, counts_as_training, display_order) values
  ('observation_target',  'תצפית באתר המיועד', false, 10),
  ('observation_live',    'תצפית באתר פעיל',   false, 20),
  ('train_implementers',  'הדרכת מטמיעים',     true,  30),
  ('train_users',         'הדרכת משתמשים',     false, 40),
  ('practice',            'תרגול',             true,  50),
  ('support_shift',       'משמרת תמיכה',       false, 60),
  ('other',               'פעילות אחרת',       false, 70)
on conflict (code) do nothing;

create table if not exists constraint_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  requires_note boolean not null default false,
  default_approval_mode approval_mode not null default 'manager',
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1
);
alter table constraint_types enable row level security;
select app.attach_managed('constraint_types');

insert into constraint_types (code, name_he, requires_note, default_approval_mode, display_order) values
  ('vacation', 'חופשה',       true,  'manager', 10),
  ('hours',    'אילוץ שעות',  true,  'manager', 20),
  ('sick',     'מחלה',        false, 'auto',    30),
  ('study',    'לימודים',     true,  'manager', 40),
  ('other',    'אחר',         true,  'manager', 50)
on conflict (code) do nothing;

create table if not exists training_statuses (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  display_order integer not null default 0,
  is_terminal boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1
);
alter table training_statuses enable row level security;
select app.attach_managed('training_statuses');

insert into training_statuses (code, name_he, display_order, is_terminal) values
  ('intake',      'בקליטה',          10, false),
  ('in_training', 'בהכשרה',          20, false),
  ('ready',       'מוכן ל-Go Live',  30, false),
  ('supporting',  'בתמיכה',          40, true)
on conflict (code) do nothing;

create table if not exists qualification_levels (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name_he text not null,
  rank smallint not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1
);
alter table qualification_levels enable row level security;
select app.attach_managed('qualification_levels');

insert into qualification_levels (code, name_he, rank) values
  ('trainee',   'מתלמד',  1),
  ('certified', 'מוסמך',  2),
  ('expert',    'מומחה',  3)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- תחומים ותתי-קטגוריות — שתי טבלאות נפרדות, לא עץ עם parent_id.
--
-- הסיבה: scope_type מבחין בין 'domain' ל-'sub_category' כ-Scopes שונים עם
-- סמנטיקת התאמה שונה, ו-rules.scope_id / qualifications / roster_assignments
-- רוצים יעדי FK שונים. ההיררכיה קבועה על שתי רמות בכל מסך באפיון.
-- -----------------------------------------------------------------------------
create table if not exists domains (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  description text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint domains_name_not_blank check (length(btrim(name)) > 0)
);
create unique index if not exists domains_name_idx on domains (name) where deleted_at is null;
alter table domains enable row level security;
select app.attach_managed('domains');
drop trigger if exists domains_normalize on domains;
create trigger domains_normalize before insert or update on domains
  for each row execute function app.tg_normalize_name();

create table if not exists sub_categories (
  id uuid primary key default gen_random_uuid(),
  domain_id uuid not null references domains(id),
  code text unique,
  name text not null,
  description text,
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint sub_categories_name_not_blank check (length(btrim(name)) > 0)
);
create unique index if not exists sub_categories_name_idx
  on sub_categories (domain_id, name) where deleted_at is null;
create index if not exists sub_categories_domain_idx
  on sub_categories (domain_id) where deleted_at is null and is_active;
alter table sub_categories enable row level security;
select app.attach_managed('sub_categories');
drop trigger if exists sub_categories_normalize on sub_categories;
create trigger sub_categories_normalize before insert or update on sub_categories
  for each row execute function app.tg_normalize_name();

-- -----------------------------------------------------------------------------
-- אתרים
-- -----------------------------------------------------------------------------
create table if not exists sites (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  description text,
  status_id uuid not null references site_statuses(id),
  timezone text not null default 'Asia/Jerusalem',
  go_live_date date,
  open_time  time not null default '07:00',
  close_time time not null default '23:00',

  -- מכסות ההגשה השבועית של זמינות
  availability_max_cannot      smallint not null default 3 check (availability_max_cannot >= 0),
  availability_max_prefer_not  smallint not null default 4 check (availability_max_prefer_not >= 0),
  availability_deadline_weekday smallint check (availability_deadline_weekday between 0 and 6),
  availability_deadline_hour    smallint check (availability_deadline_hour between 0 and 23),

  is_archived boolean not null default false,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  constraint sites_name_not_blank check (length(btrim(name)) > 0),
  constraint sites_hours check (close_time > open_time)
);
create unique index if not exists sites_name_idx on sites (name) where deleted_at is null;
create index if not exists sites_status_idx
  on sites (status_id) where deleted_at is null and is_archived = false;
create index if not exists sites_golive_idx on sites (go_live_date) where deleted_at is null;
alter table sites enable row level security;
select app.attach_managed('sites');
drop trigger if exists sites_normalize on sites;
create trigger sites_normalize before insert or update on sites
  for each row execute function app.tg_normalize_name();

-- כעת אפשר לסגור את ה-FK שנשאר פתוח ב-0002
alter table user_invites drop constraint if exists user_invites_site_id_fkey;
alter table user_invites add constraint user_invites_site_id_fkey
  foreign key (site_id) references sites(id) on delete set null;

-- תקופות האתר: הכשרה / עלייה לאוויר / תמיכה, ללא חפיפה ביניהן
create table if not exists site_periods (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  period period_code not null,
  name text,
  starts_on date not null,
  ends_on   date not null,
  span daterange generated always as (daterange(starts_on, ends_on, '[]')) stored,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint site_periods_order check (ends_on >= starts_on),
  constraint site_periods_unique unique (site_id, period),
  constraint site_periods_no_overlap
    exclude using gist (site_id with =, span with &&) where (deleted_at is null)
);
create index if not exists site_periods_site_idx on site_periods (site_id);
alter table site_periods enable row level security;
select app.attach_managed('site_periods');

-- משמרות האתר. is_mandatory הוא מה שמפעיל את "לא יכול על משמרת חובה"
-- במנגנון הזמינות, ו-required_staff מזין את חוק minStaffCoverage.
create table if not exists site_shift_types (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time   time not null,
  crosses_midnight boolean generated always as (end_time <= start_time) stored,
  is_mandatory boolean not null default false,
  required_staff smallint not null default 1 check (required_staff >= 0),
  domain_id uuid references domains(id),
  sub_category_id uuid references sub_categories(id),
  display_order integer not null default 0,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint site_shift_types_name_not_blank check (length(btrim(name)) > 0)
);
create unique index if not exists site_shift_types_name_idx
  on site_shift_types (site_id, name) where deleted_at is null;
create index if not exists site_shift_types_site_idx
  on site_shift_types (site_id) where deleted_at is null and is_active;
alter table site_shift_types enable row level security;
select app.attach_managed('site_shift_types');
drop trigger if exists site_shift_types_normalize on site_shift_types;
create trigger site_shift_types_normalize before insert or update on site_shift_types
  for each row execute function app.tg_normalize_name();

comment on column site_shift_types.crosses_midnight is
  'משמרת לילה כמו 22:00–06:00. נגזר, ומשמש את החישוב שמעביר את הסיום ליום למחרת.';

-- מדיניות אישור אילוצים לכל אתר וסוג: auto = מאושר מיד, manager = עובר לאישור
create table if not exists site_constraint_policies (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  constraint_type_id uuid not null references constraint_types(id),
  approval_mode approval_mode not null default 'manager',
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  unique (site_id, constraint_type_id)
);
alter table site_constraint_policies enable row level security;
select app.attach_managed('site_constraint_policies');

-- -----------------------------------------------------------------------------
-- סוגי מיקום ופרופילים לפי תקופה
-- -----------------------------------------------------------------------------
create table if not exists location_types (
  id uuid primary key default gen_random_uuid(),
  code text unique,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint location_types_name_not_blank check (length(btrim(name)) > 0)
);
create unique index if not exists location_types_name_idx
  on location_types (name) where deleted_at is null;
alter table location_types enable row level security;
select app.attach_managed('location_types');
drop trigger if exists location_types_normalize on location_types;
create trigger location_types_normalize before insert or update on location_types
  for each row execute function app.tg_normalize_name();

create table if not exists location_type_profiles (
  id uuid primary key default gen_random_uuid(),
  location_type_id uuid not null references location_types(id) on delete cascade,
  period period_code not null,
  active_days smallint[] not null default '{0,1,2,3,4}',   -- 0 = ראשון
  open_time  time not null default '08:00',
  close_time time not null default '17:00',
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  unique (location_type_id, period),
  constraint ltp_days_valid check (active_days <@ array[0,1,2,3,4,5,6]::smallint[])
);
alter table location_type_profiles enable row level security;
select app.attach_managed('location_type_profiles');

create table if not exists location_type_shift_templates (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references location_type_profiles(id) on delete cascade,
  name text not null,
  start_time time not null,
  end_time   time not null,
  display_order integer not null default 0,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint ltst_name_not_blank check (length(btrim(name)) > 0)
);
create index if not exists ltst_profile_idx on location_type_shift_templates (profile_id);
alter table location_type_shift_templates enable row level security;
select app.attach_managed('location_type_shift_templates');

create table if not exists locations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  location_type_id uuid references location_types(id),
  name text not null,
  description text,
  capacity smallint check (capacity is null or capacity > 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint locations_name_not_blank check (length(btrim(name)) > 0)
);
create unique index if not exists locations_name_idx
  on locations (site_id, name) where deleted_at is null;
create index if not exists locations_site_idx
  on locations (site_id) where deleted_at is null and is_active;
alter table locations enable row level security;
select app.attach_managed('locations');
drop trigger if exists locations_normalize on locations;
create trigger locations_normalize before insert or update on locations
  for each row execute function app.tg_normalize_name();
