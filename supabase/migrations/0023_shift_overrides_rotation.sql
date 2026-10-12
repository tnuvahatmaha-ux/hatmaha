-- =============================================================================
-- 0023 — שעות משמרת נקודתיות, וסבב שבועי
--
-- 1. שינוי שעות של משמרת במיקום מסוים ביום מסוים ("היום הבוקר מתחיל ב-06:30"),
--    בלי לגעת בהגדרת המשמרת עצמה. השינוי חל על כל מי שמשובץ בה באותו יום.
--    שינוי שעות של מטמיע אחד בלבד נשמר על השיבוץ עצמו, כמו קודם.
-- 2. מיקומים שעובדים "שבוע שבוע": כל שבוע המטמיע עובד בסוג משמרת אחד, והסוג
--    מתחלף לפי סדר קבוע (בוקר ← צהריים ← לילה). המיקום מגדיר את הסדר, ורק
--    מטמיעים שנרשמו לסבב כפופים לו.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. שעות משמרת נקודתיות
-- -----------------------------------------------------------------------------
create table if not exists shift_overrides (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  shift_type_id uuid not null references shift_types(id) on delete cascade,
  override_date date not null,
  start_time time not null,
  end_time time not null,
  note text,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint shift_overrides_not_same check (start_time <> end_time)
);

-- שינוי אחד לכל משמרת ביום
create unique index if not exists shift_overrides_cell_idx
  on shift_overrides (shift_type_id, override_date) where deleted_at is null;
create index if not exists shift_overrides_site_date_idx
  on shift_overrides (site_id, override_date) where deleted_at is null;

alter table shift_overrides enable row level security;
select app.attach_managed('shift_overrides');
revoke all on shift_overrides from anon, authenticated;

comment on table shift_overrides is
  'שעות שונות למשמרת ביום מסוים. השיבוצים באותו תא מקבלים את השעות האלה.';

-- -----------------------------------------------------------------------------
-- 2. סבב שבועי
-- -----------------------------------------------------------------------------
alter table locations add column if not exists rotation_cycle shift_category[];

alter table locations drop constraint if exists locations_rotation_cycle_valid;
alter table locations
  add constraint locations_rotation_cycle_valid
  check (rotation_cycle is null or cardinality(rotation_cycle) between 2 and 3);

comment on column locations.rotation_cycle is
  'סדר הסבב השבועי במיקום, למשל {morning,afternoon,night}. NULL = המיקום אינו עובד בסבב.';

-- מטמיע בסבב: שבוע עוגן וסוג המשמרת שלו באותו שבוע. ממנו נגזר הסוג של כל
-- שבוע אחר, כשאין סידור שפורסם שממנו אפשר לגזור את הסוג בפועל.
create table if not exists user_rotations (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  location_id uuid not null references locations(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  anchor_week date not null,
  anchor_category shift_category not null,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint user_rotations_anchor_sunday check (extract(dow from anchor_week) = 0)
);

create unique index if not exists user_rotations_user_location_idx
  on user_rotations (user_id, location_id) where deleted_at is null;
create index if not exists user_rotations_site_idx
  on user_rotations (site_id) where deleted_at is null;

alter table user_rotations enable row level security;
select app.attach_managed('user_rotations');
revoke all on user_rotations from anon, authenticated;

