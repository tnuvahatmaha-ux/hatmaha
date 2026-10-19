-- =============================================================================
-- 0026 — נוכחות, התראות לטלפון, החזרת אילוץ לתיקון, קבצים בצ׳אט, וגאנט הכשרה
--
-- 1. attendance_records — כניסה ויציאה בלחיצה. רשומה פתוחה אחת לכל אדם.
-- 2. push_subscriptions — מנויי Web Push לכל מכשיר. מפתחות ה-VAPID נוצרים
--    בשרת בעלייה הראשונה ונשמרים ב-app_settings, כך שאין משתני סביבה להגדיר.
-- 3. החזרת בקשת אילוץ למטמיע לתיקון: הבקשה חוזרת לטיוטה, עם הערה.
-- 4. קובץ מצורף להודעה בצ׳אט (Supabase Storage, אותו bucket של ההודעות).
-- 5. תוכנית הכשרה אישית כשלבים עם תאריכים (גאנט), ודיווח התקדמות שבועי
--    באחוזים שמנהל ההטמעה מאשר. נשען על training_tracks / user_training_items
--    שהוגדרו ב-0006 ולא היו בשימוש עד כה.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. נוכחות
-- -----------------------------------------------------------------------------
create table if not exists attendance_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  site_id uuid references sites(id) on delete set null,
  work_date date not null,
  clock_in_at timestamptz not null,
  clock_out_at timestamptz,
  roster_assignment_id uuid references roster_assignments(id) on delete set null,
  note text,
  source text not null default 'self' check (source in ('self', 'manager')),
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint attendance_order check (clock_out_at is null or clock_out_at > clock_in_at)
);
create unique index if not exists attendance_one_open_idx
  on attendance_records (user_id) where clock_out_at is null and deleted_at is null;
create index if not exists attendance_user_date_idx
  on attendance_records (user_id, work_date) where deleted_at is null;
alter table attendance_records enable row level security;
select app.attach_managed('attendance_records');
revoke all on attendance_records from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 2. מנויי Push
-- -----------------------------------------------------------------------------
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists push_subscriptions_user_idx on push_subscriptions (user_id);
alter table push_subscriptions enable row level security;
revoke all on push_subscriptions from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. החזרת בקשה לתיקון
-- -----------------------------------------------------------------------------
alter table constraint_requests add column if not exists returned_at timestamptz;
alter table constraint_requests add column if not exists returned_by uuid references profiles(id);
alter table constraint_requests add column if not exists return_note text;

-- -----------------------------------------------------------------------------
-- 4. קובץ בצ׳אט
-- -----------------------------------------------------------------------------
alter table chat_messages add column if not exists file_name text;
alter table chat_messages add column if not exists mime_type text;
alter table chat_messages add column if not exists size_bytes integer;
alter table chat_messages add column if not exists storage_path text;

alter table chat_messages drop constraint if exists chat_messages_body_not_blank;
alter table chat_messages add constraint chat_messages_body_not_blank
  check (length(btrim(body)) > 0 or storage_path is not null);

-- -----------------------------------------------------------------------------
-- 5. גאנט הכשרה
-- -----------------------------------------------------------------------------
alter table training_track_items add column if not exists duration_days smallint not null default 7;
alter table user_training_items add column if not exists start_on date;
alter table user_training_items add column if not exists progress_pct smallint not null default 0;
alter table user_training_items add column if not exists display_order integer not null default 0;
alter table user_training_items add column if not exists title text;

-- שלב שכבר סומן כהושלם נחשב 100%
update user_training_items set progress_pct = 100
 where completed_on is not null and progress_pct = 0;

alter table user_training_items drop constraint if exists uti_progress_range;
alter table user_training_items add constraint uti_progress_range
  check (progress_pct between 0 and 100);

-- שלב אישי יכול להיות גם בלי תבנית (שלב שהמדריך הוסיף ידנית)
alter table user_training_items alter column track_item_id drop not null;
alter table user_training_items drop constraint if exists user_training_items_user_id_track_item_id_key;
create unique index if not exists uti_user_track_item_idx
  on user_training_items (user_id, track_item_id)
  where track_item_id is not null and deleted_at is null;

create table if not exists training_progress_updates (
  id uuid primary key default gen_random_uuid(),
  user_training_item_id uuid not null references user_training_items(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  week_start date not null,
  progress_pct smallint not null check (progress_pct between 0 and 100),
  note text,
  submitted_by uuid references profiles(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1
);
create index if not exists tpu_item_idx on training_progress_updates (user_training_item_id, week_start desc);
create index if not exists tpu_pending_idx on training_progress_updates (status) where status = 'pending';
alter table training_progress_updates enable row level security;
select app.attach_managed('training_progress_updates');
revoke all on training_progress_updates from anon, authenticated;

-- -----------------------------------------------------------------------------
-- סוגי התראות
-- -----------------------------------------------------------------------------
insert into notification_types (code, name_he, default_email, display_order) values
  ('request_returned',            'בקשה הוחזרה לתיקון',          false, 42),
  ('request_changed',             'בקשה שאושרה עודכנה או בוטלה', false, 44),
  ('training_progress_submitted', 'דיווח התקדמות הכשרה לאישור',  false, 130),
  ('training_progress_decided',   'התקבלה החלטה בהתקדמות הכשרה', false, 135)
on conflict (code) do nothing;
