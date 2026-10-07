-- =============================================================================
-- 0011 — התראות ועדכונים
-- §11: מטריצת האירועים והנמענים
-- =============================================================================

create table if not exists notification_types (
  code text primary key,
  name_he text not null,
  template_he text,
  default_inapp boolean not null default true,
  default_email boolean not null default false,
  display_order integer not null default 0,
  is_active boolean not null default true
);
alter table notification_types enable row level security;

insert into notification_types (code, name_he, default_email, display_order) values
  ('roster_published',        'פורסם סידור עבודה',        true,  10),
  ('roster_changed',          'הסידור שלך עודכן',         true,  20),
  ('request_submitted',       'הוגשה בקשה לאישורך',       false, 30),
  ('request_decided',         'התקבלה החלטה בבקשתך',      true,  40),
  ('exception_raised',        'חריגה ממתינה לאישור',      false, 50),
  ('exception_decided',       'התקבלה החלטה בחריגה',      true,  60),
  ('exception_stale',         'חריגה שאושרה אינה ישימה',  true,  65),
  ('activity_changed',        'עודכנה פעילות',            false, 70),
  ('availability_window_open','נפתחה הגשת זמינות',        false, 80),
  ('availability_decided',    'התקבלה החלטה בזמינות',     true,  85),
  ('update_published',        'עדכון חדש',                false, 90),
  ('permission_changed',      'עודכנו ההרשאות שלך',       true,  100),
  ('assignment_changed',      'עודכן שיוך מדריך',         false, 110),
  ('welcome',                 'ברוך הבא לצוות ההטמעה',    true,  120)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- notifications — תיבת דואר נכנס + תור שליחה.
-- dedupe_key מונע שליחה כפולה של אותו אירוע לאותו נמען.
-- -----------------------------------------------------------------------------
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references profiles(id) on delete cascade,
  type_code text not null references notification_types(code),
  title text not null,
  body text,
  payload jsonb not null default '{}'::jsonb,
  entity_type text,
  entity_id uuid,
  channel text not null default 'inapp' check (channel in ('inapp','email')),
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending','sent','failed','skipped')),
  attempts smallint not null default 0,
  last_error text,
  dedupe_key text,
  sent_at timestamptz,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists notifications_dedupe_idx
  on notifications (dedupe_key) where dedupe_key is not null;
create index if not exists notifications_inbox_idx
  on notifications (recipient_user_id, created_at desc);
create index if not exists notifications_unread_idx
  on notifications (recipient_user_id) where read_at is null and channel = 'inapp';
create index if not exists notifications_outbox_idx
  on notifications (delivery_status, created_at) where delivery_status = 'pending';
alter table notifications enable row level security;

create table if not exists notification_preferences (
  user_id uuid not null references profiles(id) on delete cascade,
  type_code text not null references notification_types(code),
  inapp boolean not null default true,
  email boolean not null default false,
  primary key (user_id, type_code)
);
alter table notification_preferences enable row level security;

-- -----------------------------------------------------------------------------
-- updates — הודעת מדריך ליחיד, לקבוצה, לתחום או לאתר (§8)
-- -----------------------------------------------------------------------------
create table if not exists updates (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text not null,
  author_user_id uuid not null references profiles(id),
  audience audience_type not null default 'users',
  site_id uuid references sites(id) on delete cascade,
  domain_id uuid references domains(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  is_pinned boolean not null default false,
  published_at timestamptz,
  expires_at timestamptz,
  idempotency_key text,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint updates_title_not_blank check (length(btrim(title)) > 0),
  constraint updates_body_not_blank  check (length(btrim(body)) > 0)
);
create index if not exists updates_author_idx on updates (author_user_id, published_at desc);
create index if not exists updates_published_idx
  on updates (status, published_at desc) where deleted_at is null;
alter table updates enable row level security;
select app.attach_managed('updates');

create table if not exists update_recipients (
  update_id uuid not null references updates(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  read_at timestamptz,
  primary key (update_id, user_id)
);
create index if not exists update_recipients_user_idx
  on update_recipients (user_id) where read_at is null;
alter table update_recipients enable row level security;
