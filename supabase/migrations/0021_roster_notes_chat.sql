-- =============================================================================
-- 0021 — הערות לעובד בשיבוץ, הודעות לקבוצות, וצ׳אט קבוצתי
--
-- 1. הערה על שיבוץ ("להגיע 10 דקות קודם", "חפיפה עם נועה") ניתנת לעריכה
--    גם אחרי שהסידור פורסם — זה מידע לעובד, לא שינוי בסידור עצמו.
-- 2. הודעה רשמית (עם אישור קריאה) יכולה להישלח לתחום, לתת-תחום או לאתר.
-- 3. צ׳אט: קבוצות לפי תחום / תת-תחום / אתר (חברים נגזרים מהשיוכים),
--    או קבוצה חופשית שהמדריך בוחר את חבריה.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. הערות בשיבוץ
-- -----------------------------------------------------------------------------
alter table roster_assignments add column if not exists note_updated_at timestamptz;
alter table roster_assignments add column if not exists note_updated_by uuid references profiles(id);

-- גרסה שפורסמה נשארת לקריאה בלבד — חוץ מעדכון ההערה לעובד
create or replace function app.tg_roster_assignment_draft_only() returns trigger
language plpgsql as $$
declare st roster_status; vid uuid;
begin
  vid := coalesce(new.version_id, old.version_id);
  select status into st from roster_versions where id = vid;

  if st is distinct from 'draft' then
    if tg_op = 'UPDATE'
       and (new.version_id, new.user_id, new.assignment_date, new.location_id, new.shift_type_id,
            new.start_time, new.end_time, new.starts_at, new.ends_at, new.domain_id,
            new.sub_category_id, new.warning_text, new.deleted_at)
           is not distinct from
           (old.version_id, old.user_id, old.assignment_date, old.location_id, old.shift_type_id,
            old.start_time, old.end_time, old.starts_at, old.ends_at, old.domain_id,
            old.sub_category_id, old.warning_text, old.deleted_at)
    then
      return new;   -- רק ההערה השתנתה
    end if;
    raise exception 'ROSTER_VERSION_READ_ONLY'
      using detail = format('גרסת סידור %s בסטטוס %s — שיבוציה לקריאה בלבד', vid, st);
  end if;
  return coalesce(new, old);
end $$;

-- -----------------------------------------------------------------------------
-- 2. הודעה רשמית לקבוצה
-- -----------------------------------------------------------------------------
alter table updates add column if not exists sub_category_id uuid references sub_categories(id) on delete cascade;

-- -----------------------------------------------------------------------------
-- 3. צ׳אט קבוצתי
-- -----------------------------------------------------------------------------
create table if not exists chat_groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null default 'custom' check (kind in ('custom', 'domain', 'sub_category', 'site')),
  site_id uuid references sites(id) on delete cascade,
  domain_id uuid references domains(id) on delete cascade,
  sub_category_id uuid references sub_categories(id) on delete cascade,
  is_archived boolean not null default false,
  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,
  constraint chat_groups_name_not_blank check (length(btrim(name)) > 0),
  constraint chat_groups_kind_target check (
    (kind = 'custom') or
    (kind = 'domain' and domain_id is not null) or
    (kind = 'sub_category' and sub_category_id is not null) or
    (kind = 'site' and site_id is not null))
);
alter table chat_groups enable row level security;
select app.attach_managed('chat_groups');
revoke all on chat_groups from anon, authenticated;

create table if not exists chat_group_members (
  group_id uuid not null references chat_groups(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  role text not null default 'member' check (role in ('owner', 'member')),
  -- derived = נגזר מהשיוכים (תחום/אתר) ומתעדכן בסנכרון; ידני נשאר עד שמסירים
  is_derived boolean not null default false,
  last_read_at timestamptz,
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create index if not exists chat_group_members_user_idx on chat_group_members (user_id);
alter table chat_group_members enable row level security;
revoke all on chat_group_members from anon, authenticated;

create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  group_id uuid not null references chat_groups(id) on delete cascade,
  author_user_id uuid not null references profiles(id),
  body text not null,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  constraint chat_messages_body_not_blank check (length(btrim(body)) > 0),
  constraint chat_messages_body_len check (length(body) <= 4000)
);
create index if not exists chat_messages_group_idx on chat_messages (group_id, id);
alter table chat_messages enable row level security;
revoke all on chat_messages from anon, authenticated;

/**
 * חברי קבוצה לפי תחום / תת-תחום / אתר: כל המשתמשים הפעילים המשויכים, ובנוסף
 * המדריכים שאחראים על התחום או האתר. חבר שהוסף ידנית אינו מוסר בסנכרון.
 */
create or replace function app.sync_group_members(p_group uuid) returns void
language plpgsql as $$
declare g chat_groups;
begin
  select * into g from chat_groups where id = p_group;
  if g.kind = 'custom' or g.id is null then return; end if;

  create temporary table if not exists _wanted (user_id uuid primary key) on commit drop;
  delete from _wanted;

  insert into _wanted
  select distinct p.id from profiles p
   where p.deleted_at is null and p.status = 'active'
     and (
       (g.kind = 'domain' and (
          exists (select 1 from user_domains ud where ud.user_id = p.id and ud.domain_id = g.domain_id and ud.deleted_at is null)
          or exists (select 1 from mentor_responsibilities r where r.mentor_user_id = p.id and r.deleted_at is null
                      and r.span @> current_date and r.domain_id = g.domain_id)))
       or (g.kind = 'sub_category' and (
          exists (select 1 from user_sub_categories us where us.user_id = p.id and us.sub_category_id = g.sub_category_id and us.deleted_at is null)
          or exists (select 1 from mentor_responsibilities r where r.mentor_user_id = p.id and r.deleted_at is null
                      and r.span @> current_date and r.sub_category_id = g.sub_category_id)))
       or (g.kind = 'site' and (
          exists (select 1 from site_assignments sa where sa.user_id = p.id and sa.site_id = g.site_id
                   and sa.deleted_at is null and sa.span @> current_date)
          or exists (select 1 from mentor_responsibilities r where r.mentor_user_id = p.id and r.deleted_at is null
                      and r.span @> current_date and r.site_id = g.site_id)))
     );

  -- היוצר תמיד חבר
  insert into _wanted select g.created_by where g.created_by is not null on conflict do nothing;

  insert into chat_group_members (group_id, user_id, is_derived, role)
  select p_group, w.user_id, true, case when w.user_id = g.created_by then 'owner' else 'member' end
    from _wanted w
  on conflict (group_id, user_id) do nothing;

  delete from chat_group_members m
   where m.group_id = p_group and m.is_derived
     and not exists (select 1 from _wanted w where w.user_id = m.user_id);
end $$;

insert into notification_types (code, name_he, default_email, display_order) values
  ('chat_message', 'הודעה חדשה בקבוצה', false, 96)
on conflict (code) do nothing;
