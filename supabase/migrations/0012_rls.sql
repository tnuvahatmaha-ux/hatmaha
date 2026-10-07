-- =============================================================================
-- 0012 — Row Level Security
--
-- המודל: מנוע ההרשאות בשרת הוא מקור האמת (AC-04), והוא פועל עם service role
-- שעוקף RLS ביודעין. RLS כאן היא שכבה שנייה שמטרתה מוגדרת וצרה:
--
--   אם ה-anon key ידלוף, מחזיק טוקן של משתמש לא יוכל לקרוא דבר
--   מלבד השורות שלו עצמו. כל השאר — deny by default, ללא policy כלל.
--
-- לכן: REVOKE גורף, ואז GRANT SELECT נקודתי רק לטבלאות שיש להן policy.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. לוודא ש-RLS דולקת על כל טבלה בסכמה public, כולל כאלה שייווצרו בהמשך
--    ונשכח בהן ALTER TABLE ... ENABLE.
-- -----------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  loop
    execute format('alter table public.%I enable row level security', t.relname);
  end loop;
end $$;

-- בכוונה ENABLE ולא FORCE. ENABLE כבר חוסם לחלוטין את anon ואת
-- authenticated, וזו כל מטרת השכבה הזו. FORCE היה מחיל RLS גם על בעל
-- הטבלה — כלומר על החיבור של השרת עצמו — ואז כל המערכת הייתה נעצרת
-- ברגע שתפקיד החיבור אינו BYPASSRLS. זו החמרה שמסכנת זמינות בלי
-- להוסיף הגנה מול התרחיש שממנו אנחנו מגנים.

-- -----------------------------------------------------------------------------
-- 2. שלילה גורפת של הרשאות מהתפקידים שהלקוח יכול להגיע איתם
-- -----------------------------------------------------------------------------
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind in ('r','v','m')
  loop
    execute format('revoke all on public.%I from anon, authenticated', t.relname);
  end loop;
end $$;

revoke all on schema app from anon, authenticated;
revoke all on all functions in schema app from anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Policies — קריאה בלבד, ורק השורות של המשתמש עצמו.
--    כתיבה מכל סוג עוברת דרך השרת, שם רצים מנוע ההרשאות, מנוע החוקיות
--    וה-Audit. אין policy ל-INSERT/UPDATE/DELETE באף טבלה, בכוונה.
-- -----------------------------------------------------------------------------

-- הפרופיל של המשתמש עצמו
drop policy if exists profiles_self_select on profiles;
create policy profiles_self_select on profiles
  for select to authenticated
  using (id = auth.uid() and deleted_at is null);
grant select on profiles to authenticated;

-- ההתראות של המשתמש עצמו
drop policy if exists notifications_self_select on notifications;
create policy notifications_self_select on notifications
  for select to authenticated
  using (recipient_user_id = auth.uid());
grant select on notifications to authenticated;

-- בקשות האילוץ של המשתמש עצמו
drop policy if exists cr_self_select on constraint_requests;
create policy cr_self_select on constraint_requests
  for select to authenticated
  using (user_id = auth.uid() and deleted_at is null);
grant select on constraint_requests to authenticated;

-- הצהרות הזמינות של המשתמש עצמו
drop policy if exists avail_self_select on availability_declarations;
create policy avail_self_select on availability_declarations
  for select to authenticated
  using (user_id = auth.uid() and deleted_at is null);
grant select on availability_declarations to authenticated;

-- תאי הזמינות — דרך ההצהרה, לא ישירות
drop policy if exists avail_cells_self_select on availability_cells;
create policy avail_cells_self_select on availability_cells
  for select to authenticated
  using (exists (
    select 1 from availability_declarations d
     where d.id = availability_cells.declaration_id
       and d.user_id = auth.uid() and d.deleted_at is null));
grant select on availability_cells to authenticated;

drop policy if exists avail_violations_self_select on availability_violations;
create policy avail_violations_self_select on availability_violations
  for select to authenticated
  using (exists (
    select 1 from availability_declarations d
     where d.id = availability_violations.declaration_id
       and d.user_id = auth.uid() and d.deleted_at is null));
grant select on availability_violations to authenticated;

-- מסלול ההכשרה האישי
drop policy if exists uti_self_select on user_training_items;
create policy uti_self_select on user_training_items
  for select to authenticated
  using (user_id = auth.uid() and deleted_at is null);
grant select on user_training_items to authenticated;

-- עדכונים שנשלחו למשתמש עצמו
drop policy if exists update_recipients_self_select on update_recipients;
create policy update_recipients_self_select on update_recipients
  for select to authenticated
  using (user_id = auth.uid());
grant select on update_recipients to authenticated;

-- -----------------------------------------------------------------------------
-- 4. טבלאות ללא policy כלל — בלתי נגישות לחלוטין דרך ה-anon key (§14).
--    נרשם כאן במפורש כדי שהכוונה תהיה גלויה ולא תיראה כשכחה:
--
--      audit_log, rule_evaluations, permission_grants, role_permissions,
--      permissions, exception_requests, roster_versions, roster_assignments,
--      activities, וכל טבלאות ההגדרות והקטלוגים.
--
--    כולן נקראות אך ורק דרך השרת, אחרי requirePermission.
-- -----------------------------------------------------------------------------

-- -----------------------------------------------------------------------------
-- 5. בדיקת שפיות: כל טבלה שיש לה GRANT ל-authenticated חייבת policy,
--    וכל טבלה עם policy חייבת GRANT. אי-התאמה = שגיאה בזמן מיגרציה.
-- -----------------------------------------------------------------------------
do $$
declare
  granted text[];
  policied text[];
  diff text[];
begin
  select coalesce(array_agg(distinct table_name order by table_name), '{}') into granted
    from information_schema.role_table_grants
   where grantee = 'authenticated' and table_schema = 'public' and privilege_type = 'SELECT';

  select coalesce(array_agg(distinct tablename order by tablename), '{}') into policied
    from pg_policies where schemaname = 'public';

  select coalesce(array_agg(x), '{}') into diff
    from (select unnest(granted) except select unnest(policied)) q(x);
  if array_length(diff, 1) > 0 then
    raise exception 'RLS_MISMATCH: טבלאות עם הרשאת קריאה אך ללא policy: %', diff;
  end if;

  select coalesce(array_agg(x), '{}') into diff
    from (select unnest(policied) except select unnest(granted)) q(x);
  if array_length(diff, 1) > 0 then
    raise exception 'RLS_MISMATCH: טבלאות עם policy אך ללא הרשאת קריאה: %', diff;
  end if;

  raise notice 'RLS: % טבלאות פתוחות לקריאה עצמית, כל השאר חסומות', coalesce(array_length(granted,1), 0);
end $$;
