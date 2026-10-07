-- =============================================================================
-- 0002 — profiles, user_invites, והטריגר שמייצר פרופיל לכל משתמש auth חדש
-- =============================================================================

-- -----------------------------------------------------------------------------
-- profiles — משתמש המערכת. המפתח הוא auth.users.id, כך שהסכמה ניטרלית לספק
-- הזהות: מעבר עתידי ל-SSO הוא הפעלת provider, לא שינוי סכמה.
-- -----------------------------------------------------------------------------
create table if not exists profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  full_name    text   not null,
  email        citext not null unique,
  phone        text,
  bio          text,
  base_role    base_role   not null default 'implementer',  -- AC-01: ארבעה בלבד
  status       user_status not null default 'invited',
  timezone     text not null default 'Asia/Jerusalem',
  locale       text not null default 'he',
  intake_date  date,
  notes        text,
  avatar_url   text,

  created_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  deleted_at timestamptz,
  deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  constraint profiles_full_name_not_blank check (length(btrim(full_name)) > 0)
);

comment on table profiles is 'משתמשי המערכת. base_role מוגבל לארבעת תפקידי הבסיס (AC-01).';

create index if not exists profiles_role_status_idx
  on profiles (base_role, status) where deleted_at is null;
create index if not exists profiles_name_trgm_idx
  on profiles using gin (full_name gin_trgm_ops);
create index if not exists profiles_status_idx
  on profiles (status) where deleted_at is null;

drop trigger if exists profiles_touch on profiles;
create trigger profiles_touch before insert or update on profiles
  for each row execute function app.tg_touch_row();

alter table profiles enable row level security;

-- -----------------------------------------------------------------------------
-- user_invites — התפקיד מגיע מהזמנה שיצר מנהל, לעולם לא מ-metadata של הלקוח.
-- בלי זה, כל נרשם היה יכול להצהיר על עצמו כ-manager.
-- -----------------------------------------------------------------------------
create table if not exists user_invites (
  id          uuid primary key default gen_random_uuid(),
  email       citext not null,
  full_name   text,
  phone       text,
  base_role   base_role not null default 'implementer',
  site_id     uuid,          -- FK נוסף ב-0005 (sites עדיין לא קיימת)
  domain_ids  uuid[] not null default '{}',
  sub_category_ids uuid[] not null default '{}',
  mentor_user_id   uuid references profiles(id),
  invited_by  uuid references profiles(id),
  expires_at  timestamptz not null default now() + interval '14 days',
  accepted_at timestamptz,
  accepted_user_id uuid references profiles(id),

  created_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  deleted_at timestamptz,
  deleted_by uuid references profiles(id),
  row_version integer not null default 1
);

-- הזמנה פתוחה אחת לכל כתובת
create unique index if not exists user_invites_open_email_idx
  on user_invites (email) where accepted_at is null and deleted_at is null;
create index if not exists user_invites_expiry_idx
  on user_invites (expires_at) where accepted_at is null;

drop trigger if exists user_invites_touch on user_invites;
create trigger user_invites_touch before insert or update on user_invites
  for each row execute function app.tg_touch_row();

alter table user_invites enable row level security;

-- -----------------------------------------------------------------------------
-- יצירת פרופיל אוטומטית לכל משתמש auth חדש.
--
-- התפקיד נקבע לפי, בסדר הזה:
--   1. הזמנה פתוחה ותקפה לאותה כתובת
--   2. bootstrap — אם עדיין אין אף מנהל במערכת, המשתמש הראשון אי־פעם נהיה מנהל.
--      כך אין צורך בעריכת SQL ידנית אחרי הפריסה.
--   3. ברירת מחדל: implementer
--
-- הפונקציה מוגדרת מחדש ב-0006, אחרי שנוצרות טבלאות השיוך, כדי להחיל גם את
-- האתר והתחומים שבהזמנה.
-- -----------------------------------------------------------------------------
create or replace function app.handle_new_auth_user() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  inv        user_invites;
  role_out   base_role := 'implementer';
  no_manager boolean;
begin
  select * into inv
    from user_invites
   where email = new.email
     and accepted_at is null
     and deleted_at is null
     and expires_at > now()
   order by created_at desc
   limit 1;

  select not exists (
    select 1 from profiles where base_role = 'manager' and deleted_at is null
  ) into no_manager;

  if inv.id is not null then
    role_out := inv.base_role;
  elsif no_manager then
    role_out := 'manager';
  end if;

  insert into profiles (id, full_name, email, phone, base_role, status, intake_date)
  values (
    new.id,
    coalesce(
      app.norm_name(inv.full_name),
      app.norm_name(new.raw_user_meta_data ->> 'full_name'),
      split_part(new.email, '@', 1)
    ),
    new.email,
    inv.phone,
    role_out,
    'active',
    current_date
  )
  on conflict (id) do nothing;

  if inv.id is not null then
    update user_invites
       set accepted_at = now(), accepted_user_id = new.id
     where id = inv.id;
  end if;

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function app.handle_new_auth_user();
