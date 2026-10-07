-- =============================================================================
-- בדיקת RLS — מוכיחה את AC-13: "אין חשיפת מידע מחוץ ל-Scope".
--
-- מדמה בדיוק את התרחיש שממנו RLS מגנה: ה-anon key דלף, ותוקף מחזיק טוקן
-- תקף של משתמש אחד ומנסה לקרוא ישירות מ-Supabase, בעקיפת השרת.
--
-- הרצה:  psql ... -f supabase/tests/rls.test.sql
-- כל בדיקה שנכשלת זורקת חריגה ועוצרת את הסקריפט.
-- =============================================================================
\set ON_ERROR_STOP on

-- ---------- הכנה: שני משתמשים ונתונים לכל אחד ----------
insert into auth.users (email, raw_user_meta_data)
  values ('rls-manager@test.local', '{"full_name":"מנהלת בדיקה"}')
  on conflict do nothing;
insert into auth.users (email, raw_user_meta_data)
  values ('rls-a@test.local', '{"full_name":"משתמש א"}') on conflict do nothing;
insert into auth.users (email, raw_user_meta_data)
  values ('rls-b@test.local', '{"full_name":"משתמש ב"}') on conflict do nothing;

insert into domains (name) values ('תחום בדיקה') on conflict do nothing;
insert into sites (name, status_id)
  select 'אתר בדיקה', id from site_statuses where code = 'training'
  on conflict do nothing;

insert into constraint_requests
  (user_id, site_id, constraint_type_id, constraint_date, starts_at, ends_at, status, submitted_at)
select p.id,
       (select id from sites where name = 'אתר בדיקה'),
       (select id from constraint_types where code = 'vacation'),
       current_date + 7,
       (current_date + 7)::timestamptz,
       (current_date + 7)::timestamptz + interval '8 hours',
       'submitted', now()
  from profiles p where p.email in ('rls-a@test.local', 'rls-b@test.local')
on conflict do nothing;

insert into notifications (recipient_user_id, type_code, title)
select p.id, 'welcome', 'ברוך הבא'
  from profiles p where p.email in ('rls-a@test.local', 'rls-b@test.local');

-- ---------- התחזות למשתמש א׳ דרך התפקיד authenticated ----------
do $$
declare
  a_id uuid;
  n    integer;
begin
  select id into a_id from profiles where email = 'rls-a@test.local';

  -- כך Supabase מציגה את המשתמש בפני RLS
  perform set_config('request.jwt.claim.sub', a_id::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  set local role authenticated;

  -- 1. רואה רק את הפרופיל של עצמו
  select count(*) into n from profiles;
  if n <> 1 then
    raise exception 'RLS FAIL: profiles החזירה % שורות, ציפינו ל-1', n;
  end if;

  -- 2. רואה רק את בקשות האילוץ של עצמו
  select count(*) into n from constraint_requests;
  if n <> 1 then
    raise exception 'RLS FAIL: constraint_requests החזירה % שורות, ציפינו ל-1', n;
  end if;
  select count(*) into n from constraint_requests where user_id <> a_id;
  if n <> 0 then
    raise exception 'RLS FAIL: נחשפו בקשות של משתמש אחר';
  end if;

  -- 3. רואה רק את ההתראות של עצמו
  select count(*) into n from notifications;
  if n <> 1 then
    raise exception 'RLS FAIL: notifications החזירה % שורות, ציפינו ל-1', n;
  end if;

  reset role;
  raise notice '✓ קריאה עצמית מוגבלת לשורות המשתמש בלבד';
end $$;

-- ---------- טבלאות ללא policy: חייבות להיחסם לגמרי ----------
do $$
declare
  a_id uuid;
  tbl  text;
  blocked text[] := array[
    'audit_log', 'rule_evaluations', 'permission_grants', 'role_permissions',
    'permissions', 'exception_requests', 'roster_versions', 'roster_assignments',
    'activities', 'sites', 'domains', 'rules', 'mentor_assignments',
    'site_assignments', 'user_invites', 'app_settings'];
  leaked text[] := '{}';
begin
  select id into a_id from profiles where email = 'rls-a@test.local';
  perform set_config('request.jwt.claim.sub', a_id::text, true);
  set local role authenticated;

  foreach tbl in array blocked loop
    begin
      execute format('select 1 from public.%I limit 1', tbl);
      -- אם לא נזרקה שגיאת הרשאה, הטבלה חשופה
      leaked := leaked || tbl;
    exception
      when insufficient_privilege then null;   -- זו התוצאה הרצויה
    end;
  end loop;

  reset role;

  if array_length(leaked, 1) > 0 then
    raise exception 'RLS FAIL: הטבלאות הבאות נגישות ל-authenticated: %', leaked;
  end if;
  raise notice '✓ % טבלאות רגישות חסומות לחלוטין ל-anon key', array_length(blocked, 1);
end $$;

-- ---------- כתיבה ישירה חייבת להיחסם בכל מקרה ----------
do $$
declare a_id uuid; ok boolean := false;
begin
  select id into a_id from profiles where email = 'rls-a@test.local';
  perform set_config('request.jwt.claim.sub', a_id::text, true);
  set local role authenticated;

  begin
    update profiles set full_name = 'שם שהושתל' where id = a_id;
  exception when insufficient_privilege or others then ok := true;
  end;

  reset role;
  if not ok then
    raise exception 'RLS FAIL: משתמש הצליח לכתוב ישירות ל-profiles';
  end if;
  raise notice '✓ כתיבה ישירה חסומה — כל שינוי חייב לעבור דרך השרת';
end $$;

\echo '✓ כל בדיקות ה-RLS עברו'
