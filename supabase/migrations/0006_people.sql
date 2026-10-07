-- =============================================================================
-- 0006 — שיוכי אנשים: תחומים, הסמכות, אתרים, מדריכים ומסלולי הכשרה
--
-- עיקרון מנחה: שום שיוך אינו ניתן ל-[0]. הפרוטוטייפ חתך מטמיע רב-אתרי
-- ורב-תחומי ע״י .find() ו-domainIds[0] בניתוב אילוצים, במכסות ובמשמרות.
-- כאן כל קריאה עוברת דרך הטבלאות כקבוצה, וערך יחיד לגיטימי רק דרך is_primary.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- שיוך מקצועי
-- -----------------------------------------------------------------------------
create table if not exists user_domains (
  user_id   uuid not null references profiles(id) on delete cascade,
  domain_id uuid not null references domains(id)  on delete cascade,
  is_primary boolean not null default false,
  from_date date not null default current_date,
  to_date   date,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  primary key (user_id, domain_id),
  constraint user_domains_order check (to_date is null or to_date >= from_date)
);
create index if not exists user_domains_domain_idx on user_domains (domain_id);
-- תחום ראשי אחד לכל היותר
create unique index if not exists user_domains_one_primary_idx
  on user_domains (user_id) where is_primary and deleted_at is null;
alter table user_domains enable row level security;
select app.attach_managed('user_domains');

create table if not exists user_sub_categories (
  user_id uuid not null references profiles(id) on delete cascade,
  sub_category_id uuid not null references sub_categories(id) on delete cascade,
  from_date date not null default current_date,
  to_date   date,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  primary key (user_id, sub_category_id),
  constraint user_sub_categories_order check (to_date is null or to_date >= from_date)
);
create index if not exists user_sub_categories_sc_idx on user_sub_categories (sub_category_id);
alter table user_sub_categories enable row level security;
select app.attach_managed('user_sub_categories');

-- הסמכות — מזינות את חוק requiresQualification
create table if not exists qualifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  sub_category_id uuid not null references sub_categories(id),
  level_id uuid not null references qualification_levels(id),
  certified_on date not null default current_date,
  valid_to date,
  certified_by uuid references profiles(id),
  evidence_note text,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint qualifications_order check (valid_to is null or valid_to >= certified_on)
);
-- הסמכה חיה אחת לכל (משתמש, תת-קטגוריה)
create unique index if not exists qualifications_live_idx
  on qualifications (user_id, sub_category_id) where deleted_at is null;
create index if not exists qualifications_sc_idx on qualifications (sub_category_id);
alter table qualifications enable row level security;
select app.attach_managed('qualifications');

-- -----------------------------------------------------------------------------
-- שיוך לאתר. assignment_role קובע את ה-Scope התפעולי; base_role קובע את
-- סט ההרשאות. האפקטיבי הוא האיחוד של השניים.
-- -----------------------------------------------------------------------------
create table if not exists site_assignments (
  id uuid primary key default gen_random_uuid(),
  site_id uuid not null references sites(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  assignment_role site_role not null default 'implementer',
  from_date date not null default current_date,
  to_date   date,
  span daterange generated always as (daterange(from_date, to_date, '[]')) stored,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint site_assignments_order check (to_date is null or to_date >= from_date),
  -- אותו אדם לא יכול להיות משויך פעמיים לאותו אתר בתקופות חופפות
  constraint site_assignments_no_overlap
    exclude using gist (site_id with =, user_id with =, span with &&) where (deleted_at is null)
);
create index if not exists site_assignments_user_idx
  on site_assignments (user_id) where deleted_at is null;
create index if not exists site_assignments_site_role_idx
  on site_assignments (site_id, assignment_role) where deleted_at is null;
alter table site_assignments enable row level security;
select app.attach_managed('site_assignments');

-- -----------------------------------------------------------------------------
-- אחריות מדריך — השער לשיוך. NULL בתת-קטגוריה = כל תתי-הקטגוריות בתחום.
-- §9: "מניעת שיוך לא תקין"
-- -----------------------------------------------------------------------------
create table if not exists mentor_responsibilities (
  id uuid primary key default gen_random_uuid(),
  mentor_user_id uuid not null references profiles(id) on delete cascade,
  site_id   uuid references sites(id)   on delete cascade,
  domain_id uuid references domains(id) on delete cascade,
  sub_category_id uuid references sub_categories(id) on delete cascade,
  from_date date not null default current_date,
  to_date   date,
  span daterange generated always as (daterange(from_date, to_date, '[]')) stored,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint mentor_resp_order check (to_date is null or to_date >= from_date),
  -- תת-קטגוריה בלי תחום היא חסרת משמעות
  constraint mentor_resp_shape check (sub_category_id is null or domain_id is not null)
);
create index if not exists mentor_resp_mentor_idx
  on mentor_responsibilities (mentor_user_id) where deleted_at is null;
create index if not exists mentor_resp_lookup_idx
  on mentor_responsibilities (site_id, domain_id, sub_category_id) where deleted_at is null;
alter table mentor_responsibilities enable row level security;
select app.attach_managed('mentor_responsibilities');

-- -----------------------------------------------------------------------------
-- שיוך מדריך–מטמיע. מזין את Scope 'assigned_users' ואת ניתוב המאשרים.
-- -----------------------------------------------------------------------------
create table if not exists mentor_assignments (
  id uuid primary key default gen_random_uuid(),
  mentor_user_id      uuid not null references profiles(id) on delete cascade,
  implementer_user_id uuid not null references profiles(id) on delete cascade,
  is_primary boolean not null default false,
  from_date date not null default current_date,
  to_date   date,
  span daterange generated always as (daterange(from_date, to_date, '[]')) stored,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint mentor_assign_order check (to_date is null or to_date >= from_date),
  constraint mentor_assign_not_self check (mentor_user_id <> implementer_user_id),
  -- אין שיוך כפול חופף בין אותו זוג
  constraint mentor_assign_no_overlap
    exclude using gist (mentor_user_id with =, implementer_user_id with =, span with &&)
    where (deleted_at is null),
  -- "מדריך ראשי אחד ותומכים אופציונליים" — נאכף, לא רק מומלץ
  constraint mentor_assign_one_primary
    exclude using gist (implementer_user_id with =, span with &&)
    where (is_primary and deleted_at is null)
);
create index if not exists mentor_assign_impl_idx
  on mentor_assignments (implementer_user_id) where deleted_at is null;
create index if not exists mentor_assign_mentor_idx
  on mentor_assignments (mentor_user_id) where deleted_at is null;
alter table mentor_assignments enable row level security;
select app.attach_managed('mentor_assignments');

-- -----------------------------------------------------------------------------
-- מסלולי הכשרה: תבנית + מופע אישי (§5.1 שלב 4)
-- -----------------------------------------------------------------------------
create table if not exists training_tracks (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  site_id   uuid references sites(id)   on delete cascade,
  domain_id uuid references domains(id) on delete cascade,
  sub_category_id uuid references sub_categories(id) on delete cascade,
  is_default boolean not null default false,
  is_active boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint training_tracks_name_not_blank check (length(btrim(name)) > 0)
);
alter table training_tracks enable row level security;
select app.attach_managed('training_tracks');

create table if not exists training_track_items (
  id uuid primary key default gen_random_uuid(),
  track_id uuid not null references training_tracks(id) on delete cascade,
  display_order integer not null,
  title text not null,
  description text,
  activity_type_id uuid references activity_types(id),
  is_mandatory boolean not null default true,
  expected_offset_days smallint,          -- ימים מתאריך הקליטה
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint tti_title_not_blank check (length(btrim(title)) > 0)
);
create index if not exists tti_track_idx on training_track_items (track_id, display_order);
alter table training_track_items enable row level security;
select app.attach_managed('training_track_items');

create table if not exists user_training_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  track_item_id uuid not null references training_track_items(id) on delete cascade,
  status_id uuid not null references training_statuses(id),
  due_on date,
  completed_on date,
  completed_activity_id uuid,    -- FK ל-activities נוסף ב-0009
  verified_by uuid references profiles(id),
  note text,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  unique (user_id, track_item_id)
);
create index if not exists uti_user_status_idx on user_training_items (user_id, status_id);
create index if not exists uti_due_idx on user_training_items (due_on) where completed_on is null;
alter table user_training_items enable row level security;
select app.attach_managed('user_training_items');

-- הפרופיל מצביע על סטטוס ההכשרה הנוכחי
alter table profiles add column if not exists training_status_id uuid references training_statuses(id);

-- -----------------------------------------------------------------------------
-- פונקציות Scope — משמשות את מנוע ההרשאות וגם את ה-RLS ב-0011.
-- כולן stable ומקבלות משתמש מפורש, כדי שיעבדו גם תחת service role.
-- -----------------------------------------------------------------------------

-- האתרים של המשתמש: שיוכי אתר חיים + אתרים שהוא מדריך אחראי עליהם
create or replace function app.user_site_ids(p_user uuid) returns uuid[]
language sql stable as $$
  select coalesce(array_agg(distinct s), '{}')
  from (
    select site_id as s from site_assignments
     where user_id = p_user and deleted_at is null and span @> current_date
    union
    select site_id from mentor_responsibilities
     where mentor_user_id = p_user and deleted_at is null and span @> current_date
       and site_id is not null
  ) q
$$;

-- התחומים של המשתמש: שיוך מקצועי + תחומי אחריות כמדריך
create or replace function app.user_domain_ids(p_user uuid) returns uuid[]
language sql stable as $$
  select coalesce(array_agg(distinct d), '{}')
  from (
    select domain_id as d from user_domains
     where user_id = p_user and deleted_at is null
       and (to_date is null or to_date >= current_date)
    union
    select domain_id from mentor_responsibilities
     where mentor_user_id = p_user and deleted_at is null and span @> current_date
       and domain_id is not null
  ) q
$$;

create or replace function app.user_sub_category_ids(p_user uuid) returns uuid[]
language sql stable as $$
  select coalesce(array_agg(distinct sub_category_id), '{}')
  from user_sub_categories
  where user_id = p_user and deleted_at is null
    and (to_date is null or to_date >= current_date)
$$;

-- המטמיעים שבאחריות המדריך — מזין את Scope 'assigned_users'
create or replace function app.assigned_user_ids(p_user uuid) returns uuid[]
language sql stable as $$
  select coalesce(array_agg(distinct implementer_user_id), '{}')
  from mentor_assignments
  where mentor_user_id = p_user and deleted_at is null and span @> current_date
$$;

-- המדריך הראשי של מטמיע — ניתוב מאשרים
create or replace function app.primary_mentor_of(p_user uuid) returns uuid
language sql stable as $$
  select mentor_user_id from mentor_assignments
   where implementer_user_id = p_user and is_primary
     and deleted_at is null and span @> current_date
   limit 1
$$;

-- -----------------------------------------------------------------------------
-- הגדרה מחדש של טריגר ה-auth: כעת, אחרי שטבלאות השיוך קיימות, ההזמנה
-- מחילה גם את האתר, התחומים, תתי-הקטגוריות והמדריך.
-- -----------------------------------------------------------------------------
create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  inv        user_invites;
  role_out   base_role := 'implementer';
  no_manager boolean;
  d          uuid;
  ord        integer := 0;
begin
  select * into inv
    from user_invites
   where email = new.email and accepted_at is null and deleted_at is null
     and expires_at > now()
   order by created_at desc limit 1;

  select not exists (
    select 1 from profiles where base_role = 'manager' and deleted_at is null
  ) into no_manager;

  if inv.id is not null then
    role_out := inv.base_role;
  elsif no_manager then
    role_out := 'manager';      -- bootstrap: המשתמש הראשון אי־פעם
  end if;

  insert into profiles (id, full_name, email, phone, base_role, status, intake_date)
  values (
    new.id,
    coalesce(app.norm_name(inv.full_name),
             app.norm_name(new.raw_user_meta_data ->> 'full_name'),
             split_part(new.email, '@', 1)),
    new.email, inv.phone, role_out, 'active', current_date)
  on conflict (id) do nothing;

  if inv.id is null then
    return new;
  end if;

  if inv.site_id is not null then
    insert into site_assignments (site_id, user_id, assignment_role, from_date)
    values (inv.site_id, new.id, 'implementer', current_date)
    on conflict do nothing;
  end if;

  foreach d in array inv.domain_ids loop
    ord := ord + 1;
    insert into user_domains (user_id, domain_id, is_primary)
    values (new.id, d, ord = 1)
    on conflict do nothing;
  end loop;

  foreach d in array inv.sub_category_ids loop
    insert into user_sub_categories (user_id, sub_category_id)
    values (new.id, d) on conflict do nothing;
  end loop;

  if inv.mentor_user_id is not null then
    insert into mentor_assignments (mentor_user_id, implementer_user_id, is_primary)
    values (inv.mentor_user_id, new.id, true)
    on conflict do nothing;
  end if;

  update user_invites
     set accepted_at = now(), accepted_user_id = new.id
   where id = inv.id;

  return new;
end $$;
