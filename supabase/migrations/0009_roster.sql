-- =============================================================================
-- 0009 — סידור עבודה: גרסאות, שיבוצים והגנת "לקריאה בלבד"
-- §5.3 + AC-12
-- =============================================================================

create table if not exists roster_versions (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  week_start date not null,
  version_number integer not null,
  status roster_status not null default 'draft',
  period period_code,
  source_version_id uuid references roster_versions(id),
  published_at timestamptz,
  published_by uuid references profiles(id),
  published_snapshot jsonb,
  publish_note text,
  idempotency_key text,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  constraint roster_week_starts_sunday check (extract(dow from week_start) = 0),
  constraint roster_version_positive check (version_number > 0),
  constraint roster_published_fields check (
    status <> 'published' or (published_at is not null and published_by is not null)),
  unique (site_id, week_start, version_number)
);

-- טיוטה אחת לכל (אתר, שבוע) — גם תחת לחיצה כפולה או שתי בקשות במקביל
create unique index if not exists roster_one_draft_idx
  on roster_versions (site_id, week_start)
  where status = 'draft' and deleted_at is null;
create index if not exists roster_versions_site_status_idx
  on roster_versions (site_id, status, week_start desc) where deleted_at is null;
create index if not exists roster_versions_published_idx
  on roster_versions (site_id, week_start) where status = 'published' and deleted_at is null;

alter table roster_versions enable row level security;
select app.attach_managed('roster_versions');

-- -----------------------------------------------------------------------------
-- roster_assignments
--
-- ה-EXCLUDE כאן מתקן שני באגים של הפרוטוטייפ בבת אחת:
--   1. הוא פועל על tstzrange, ולכן משמרת 22:00–06:00 נבדקת נכון. הפרוטוטייפ
--      השווה דקות-מחצות, ולכן 1320 < 360 היה false וכל חפיפת לילה התפספסה.
--   2. הוא ממודר לפי version_id, ולכן טיוטה אינה "מתנגשת" עם העותק שלה
--      שכבר פורסם.
-- -----------------------------------------------------------------------------
create table if not exists roster_assignments (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references roster_versions(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  assignment_date date not null,
  location_id uuid not null references locations(id),
  user_id uuid not null references profiles(id),
  shift_type_id uuid references site_shift_types(id),   -- NULL = שעות מותאמות אישית
  start_time time not null,
  end_time   time not null,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  span tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,
  domain_id uuid references domains(id),
  sub_category_id uuid references sub_categories(id),
  note text,
  warning_text text,
  rule_evaluation_id uuid references rule_evaluations(id),

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  constraint ra_order check (ends_at > starts_at),
  constraint ra_no_overlap
    exclude using gist (version_id with =, user_id with =, span with &&)
    where (deleted_at is null)
);

create index if not exists ra_version_date_idx on roster_assignments (version_id, assignment_date);
create index if not exists ra_user_date_idx    on roster_assignments (user_id, assignment_date);
create index if not exists ra_site_date_idx    on roster_assignments (site_id, assignment_date);
create index if not exists ra_location_idx     on roster_assignments (location_id, assignment_date);
create index if not exists ra_span_idx         on roster_assignments using gist (span);
create index if not exists ra_cell_idx
  on roster_assignments (version_id, location_id, assignment_date, shift_type_id)
  where deleted_at is null;

alter table roster_assignments enable row level security;
select app.attach_managed('roster_assignments');

-- -----------------------------------------------------------------------------
-- ההגנה על גרסה שפורסמה יושבת כאן ולא בראוטר, ולכן לא ניתן לעקוף אותה
-- מאף נתיב, מסקריפט או משאילתה ידנית.
-- -----------------------------------------------------------------------------
create or replace function app.tg_roster_assignment_draft_only() returns trigger
language plpgsql as $$
declare st roster_status; vid uuid;
begin
  vid := coalesce(new.version_id, old.version_id);
  select status into st from roster_versions where id = vid;

  if st is distinct from 'draft' then
    raise exception 'ROSTER_VERSION_READ_ONLY'
      using detail = format('גרסת סידור %s בסטטוס %s — שיבוציה לקריאה בלבד', vid, st);
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists ra_draft_only on roster_assignments;
create trigger ra_draft_only
  before insert or update or delete on roster_assignments
  for each row execute function app.tg_roster_assignment_draft_only();

-- גרסה שפורסמה אינה חוזרת לטיוטה, וה-snapshot שלה אינו משתנה
create or replace function app.tg_roster_version_transition() returns trigger
language plpgsql as $$
begin
  if old.status = 'published' then
    if new.status not in ('published', 'archived') then
      raise exception 'ROSTER_VERSION_READ_ONLY'
        using detail = 'גרסה שפורסמה אינה חוזרת לטיוטה';
    end if;
    if new.published_snapshot is distinct from old.published_snapshot then
      raise exception 'ROSTER_SNAPSHOT_IMMUTABLE'
        using detail = 'צילום הגרסה שפורסמה אינו ניתן לשינוי';
    end if;
    if new.version_number is distinct from old.version_number
       or new.published_at is distinct from old.published_at then
      raise exception 'ROSTER_VERSION_READ_ONLY'
        using detail = 'פרטי הפרסום אינם ניתנים לשינוי';
    end if;
  end if;
  return new;
end $$;

drop trigger if exists roster_version_transition on roster_versions;
create trigger roster_version_transition
  before update on roster_versions
  for each row execute function app.tg_roster_version_transition();

-- הערות על הסידור
create table if not exists roster_notes (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references roster_versions(id) on delete cascade,
  author_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  constraint roster_notes_body_not_blank check (length(btrim(body)) > 0)
);
create index if not exists roster_notes_version_idx on roster_notes (version_id, created_at desc);
alter table roster_notes enable row level security;
