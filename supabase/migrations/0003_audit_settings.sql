-- =============================================================================
-- 0003 — Audit Log, הגדרות מערכת, מפתחות אידמפוטנטיות, ועוזרי טריגרים
-- §14: "Audit בלתי ניתן לעריכה למשתמשי קצה"
-- =============================================================================

-- -----------------------------------------------------------------------------
-- audit_log — append-only. אין policy ל-RLS כלל, ולכן בלתי נגיש לחלוטין
-- דרך ה-anon key. רק ה-service role של השרת רואה אותו.
-- -----------------------------------------------------------------------------
create table if not exists audit_log (
  id            bigint generated always as identity primary key,
  occurred_at   timestamptz not null default now(),
  actor_user_id uuid references profiles(id),
  actor_role    base_role,
  entity_type   text not null,
  entity_id     uuid,
  action        text not null,   -- create|update|delete|submit|approve|reject|publish|grant|revoke|export|login|denied
  before_data   jsonb,
  after_data    jsonb,
  reason        text,
  trace_id      text,
  ip_address    inet,
  user_agent    text
);

comment on table audit_log is 'יומן ביקורת append-only. מחיקה ועדכון חסומים בטריגר.';

create index if not exists audit_entity_idx
  on audit_log (entity_type, entity_id, occurred_at desc);
create index if not exists audit_actor_idx
  on audit_log (actor_user_id, occurred_at desc);
create index if not exists audit_action_idx
  on audit_log (action, occurred_at desc);
-- BRIN: היומן גדל מונוטונית לפי זמן, וזה אינדקס בגודל זניח
create index if not exists audit_occurred_brin
  on audit_log using brin (occurred_at);

alter table audit_log enable row level security;

-- append-only נאכף ברמת ה-DB, לא במשמעת אפליקטיבית
create or replace function app.tg_append_only() returns trigger
language plpgsql as $$
begin
  raise exception 'APPEND_ONLY_TABLE'
    using detail = format('%s does not allow %s', tg_table_name, tg_op);
end $$;

drop trigger if exists audit_log_append_only on audit_log;
create trigger audit_log_append_only
  before update or delete on audit_log
  for each row execute function app.tg_append_only();

-- -----------------------------------------------------------------------------
-- טריגר ביקורת גנרי. מתחבר לכל טבלה ניהולית ורושם before/after.
-- שדות רועשים (חותמות זמן ומונה הגרסה) נשמטים כדי שה-diff יהיה קריא.
-- -----------------------------------------------------------------------------
create or replace function app.tg_audit() returns trigger
language plpgsql security definer set search_path = public, app as $$
declare
  noise   text[] := array['created_at','updated_at','created_by','updated_by','row_version'];
  v_before jsonb;
  v_after  jsonb;
  v_action text;
  v_id     uuid;
begin
  if tg_op = 'INSERT' then
    v_action := 'create';
    v_after  := to_jsonb(new) - noise;
    v_id     := (to_jsonb(new) ->> 'id')::uuid;
  elsif tg_op = 'UPDATE' then
    v_before := to_jsonb(old) - noise;
    v_after  := to_jsonb(new) - noise;
    v_id     := (to_jsonb(new) ->> 'id')::uuid;
    -- מחיקה לוגית נרשמת כמחיקה, לא כעדכון
    if (to_jsonb(old) ->> 'deleted_at') is null
       and (to_jsonb(new) ->> 'deleted_at') is not null then
      v_action := 'delete';
    else
      v_action := 'update';
    end if;
    if v_before = v_after then
      return coalesce(new, old);   -- שינוי ריק — לא רושמים
    end if;
  else
    v_action := 'hard_delete';
    v_before := to_jsonb(old) - noise;
    v_id     := (to_jsonb(old) ->> 'id')::uuid;
  end if;

  insert into audit_log (
    actor_user_id, actor_role, entity_type, entity_id,
    action, before_data, after_data, trace_id)
  values (
    app.actor(),
    (select base_role from profiles where id = app.actor()),
    tg_table_name, v_id,
    v_action, v_before, v_after, app.trace());

  return coalesce(new, old);
end $$;

-- -----------------------------------------------------------------------------
-- app.attach_managed(table) — מחבר בבת אחת את טריגר החותמות ואת טריגר הביקורת.
-- כל טבלה ניהולית נרשמת דרכו, כך שאי אפשר לשכוח אחד מהשניים.
-- -----------------------------------------------------------------------------
create or replace function app.attach_managed(tbl regclass) returns void
language plpgsql as $$
declare t text := tbl::text;
begin
  execute format('drop trigger if exists %I on %s', t || '_touch', t);
  execute format(
    'create trigger %I before insert or update on %s
       for each row execute function app.tg_touch_row()', t || '_touch', t);

  execute format('drop trigger if exists %I on %s', t || '_audit', t);
  execute format(
    'create trigger %I after insert or update or delete on %s
       for each row execute function app.tg_audit()', t || '_audit', t);
end $$;

select app.attach_managed('profiles');
select app.attach_managed('user_invites');

-- -----------------------------------------------------------------------------
-- app_settings — הגדרות כלליות כזוגות מפתח/ערך
-- -----------------------------------------------------------------------------
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  name_he     text,
  description_he text,
  updated_at  timestamptz not null default now(),
  updated_by  uuid references profiles(id)
);

alter table app_settings enable row level security;

insert into app_settings (key, value, name_he, description_he) values
  ('timezone',            '"Asia/Jerusalem"'::jsonb, 'אזור זמן עסקי',      'אזור הזמן שבו מוצגים כל הזמנים'),
  ('exception_ttl_days',  '14'::jsonb,               'תוקף חריגה בימים',    'אחרי כמה ימים חריגה שלא הוכרעה פגה'),
  ('audit_retention_months', '12'::jsonb,            'שמירת Audit בחודשים', 'אחרי כמה חודשים שורות Audit מיוצאות ונמחקות'),
  ('team_schedule_fields', '["name","activity","site","status"]'::jsonb,
     'שדות בלו״ז צוותי', 'אילו שדות נחשפים בלו״ז הצוותי — מזעור מידע לפי §14'),
  ('editable_profile_fields', '["phone","bio"]'::jsonb,
     'שדות פרופיל לעריכה עצמית', 'אילו שדות מטמיע רשאי לערוך בעצמו'),
  ('max_file_kb',         '2048'::jsonb,             'גודל קובץ מרבי (KB)', null),
  ('notification_channels', '["inapp","email"]'::jsonb, 'ערוצי התראה פעילים', null)
on conflict (key) do nothing;

-- -----------------------------------------------------------------------------
-- idempotency_keys — §13: "פעולות הגשה, אישור, פרסום ומתן הרשאה יהיו Idempotent"
-- שידור חוזר של אותה פעולה מחזיר את התשובה השמורה במקום לבצע שוב.
-- -----------------------------------------------------------------------------
create table if not exists idempotency_keys (
  key          text primary key,
  user_id      uuid not null references profiles(id) on delete cascade,
  endpoint     text not null,
  request_hash text not null,
  status_code  integer,
  response     jsonb,
  state        text not null default 'in_progress'
               check (state in ('in_progress', 'completed')),
  created_at   timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idempotency_created_idx on idempotency_keys (created_at);
alter table idempotency_keys enable row level security;
