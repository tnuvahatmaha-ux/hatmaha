-- =============================================================================
-- 0010 — פעילויות: הדרכות, תצפיות ותרגולים
-- §7, §8
-- =============================================================================

create table if not exists activities (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  location_id uuid references locations(id),
  activity_type_id uuid not null references activity_types(id),
  title text,
  description text,

  activity_date date not null,
  start_time time not null,
  end_time   time not null,
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  span tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,

  audience   audience_type   not null default 'site',
  visibility visibility_type not null default 'participants',
  status text not null default 'scheduled'
         check (status in ('draft','pending_approval','scheduled','completed','cancelled','rejected')),

  owner_user_id uuid references profiles(id),      -- המדריך האחראי
  domain_id uuid references domains(id),
  sub_category_id uuid references sub_categories(id),
  prep_done boolean not null default false,
  notes text,
  rule_evaluation_id uuid references rule_evaluations(id),
  idempotency_key text,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  -- §7: "סיום חייב להיות לאחר התחלה"
  constraint activities_order check (ends_at > starts_at)
);

create index if not exists activities_site_date_idx
  on activities (site_id, activity_date) where deleted_at is null;
create index if not exists activities_span_idx
  on activities using gist (span) where deleted_at is null;
create index if not exists activities_type_idx
  on activities (activity_type_id, activity_date) where deleted_at is null;
create index if not exists activities_owner_idx
  on activities (owner_user_id, activity_date desc) where deleted_at is null;
create index if not exists activities_status_idx
  on activities (status, activity_date) where deleted_at is null;

alter table activities enable row level security;
select app.attach_managed('activities');

-- כעת אפשר לסגור את ה-FK שנשאר פתוח ב-0006
alter table user_training_items drop constraint if exists uti_activity_fkey;
alter table user_training_items add constraint uti_activity_fkey
  foreign key (completed_activity_id) references activities(id) on delete set null;

-- -----------------------------------------------------------------------------
-- קהל היעד של הפעילות: כולם / אתר / תחום / תת-קטגוריה / עובדים מסוימים
-- -----------------------------------------------------------------------------
create table if not exists activity_audience (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities(id) on delete cascade,
  audience audience_type not null,
  target_id uuid,
  constraint aa_target_shape check (
    (audience = 'all' and target_id is null) or
    (audience <> 'all' and target_id is not null)),
  unique (activity_id, audience, target_id)
);
create index if not exists aa_activity_idx on activity_audience (activity_id);
alter table activity_audience enable row level security;

-- -----------------------------------------------------------------------------
-- activity_participants — ממוטרל בזמן שמירה, לא נפתר בכל קריאה.
--
-- זה מה שהופך את "הלו״ז שלי", את Scope 'assigned_users' ואת פיזור ההתראות
-- ל-join אחד מאונדקס, וזה מה שחוק mandatoryTraining צריך כדי להיות בר-בדיקה.
-- -----------------------------------------------------------------------------
create table if not exists activity_participants (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  source text not null default 'audience' check (source in ('audience','manual')),
  attendance text not null default 'invited'
    check (attendance in ('invited','confirmed','attended','absent','excused')),
  marked_by uuid references profiles(id),
  marked_at timestamptz,
  unique (activity_id, user_id)
);
create index if not exists ap_user_idx on activity_participants (user_id);
create index if not exists ap_activity_idx on activity_participants (activity_id);
create index if not exists ap_attended_idx
  on activity_participants (user_id, attendance) where attendance = 'attended';
alter table activity_participants enable row level security;

-- חומרי הדרכה מצורפים לפעילות (מטא-דאטה בלבד ב-MVP)
create table if not exists activity_materials (
  id uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities(id) on delete cascade,
  title text not null,
  url text,
  note text,
  created_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  constraint am_title_not_blank check (length(btrim(title)) > 0)
);
create index if not exists am_activity_idx on activity_materials (activity_id);
alter table activity_materials enable row level security;
