-- =============================================================================
-- 0001 — הרחבות, סכמת עזר, טיפוסים מוגדרים (enums)
-- מערכת לניהול צוות הטמעה
--
-- כלל ה-enum מול טבלת lookup:
--   enum         — רק היכן שהאפיון מקפיא את קבוצת הערכים (שינוי = שינוי קוד ממילא)
--   טבלת lookup  — בכל מקום שבו §3.1 מבטיח "ניהול הגדרות ללא שינוי קוד"
--                  (ALTER TYPE ... ADD VALUE הוא מיגרציה, ומיגרציה היא שינוי קוד)
--
-- עברית לעולם לא במפתח, רק בעמודת name_he. המנועים ניטרליים לשפה.
-- =============================================================================

create extension if not exists pgcrypto;    -- gen_random_uuid()
create extension if not exists btree_gist;  -- exclude (uuid with =, tstzrange with &&)
create extension if not exists citext;      -- אימייל case-insensitive
create extension if not exists pg_trgm;     -- חיפוש שמות בעברית

-- סכמת עזר. אינה חשופה ל-PostgREST ולכן פונקציות העזר אינן ניתנות לקריאה מהלקוח.
create schema if not exists app;
revoke all on schema app from public, anon, authenticated;

-- -----------------------------------------------------------------------------
-- Enums — קבוצות ערכים שהאפיון מקפיא
-- -----------------------------------------------------------------------------

-- AC-01: קיימים רק ארבעת תפקידי הבסיס שאושרו
do $$ begin
  create type base_role as enum ('manager', 'mentor', 'lead', 'implementer');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_status as enum ('invited', 'active', 'suspended', 'archived');
exception when duplicate_object then null; end $$;

-- §3.1 ממד "פעולה"
do $$ begin
  create type perm_action as enum (
    'view', 'create', 'edit', 'delete', 'approve', 'publish', 'export', 'manage');
exception when duplicate_object then null; end $$;

do $$ begin
  create type perm_effect as enum ('allow', 'deny');
exception when duplicate_object then null; end $$;

-- §3.1 ממד "Scope"
do $$ begin
  create type scope_type as enum (
    'global', 'site', 'domain', 'sub_category', 'assigned_users', 'own_data');
exception when duplicate_object then null; end $$;

-- §10 מנוע החוקיות.
-- רמות ה-Scope של חוק שונות מאלה של הרשאה: לחוק יש רמת 'user' (חוק שחל על
-- אדם מסוים), ואילו להרשאה יש 'own_data' ו-'assigned_users'. שני enum נפרדים,
-- כדי ששום צד לא יקבל ערך חסר משמעות עבורו.
do $$ begin
  create type rule_scope_type as enum ('global', 'site', 'domain', 'sub_category', 'user');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rule_trigger as enum ('submit', 'assign', 'change', 'publish');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rule_severity as enum ('warning', 'approval_required', 'blocking');
exception when duplicate_object then null; end $$;

do $$ begin
  create type rule_outcome as enum ('pass', 'warning', 'approval_required', 'blocked');
exception when duplicate_object then null; end $$;

do $$ begin
  create type exception_status as enum (
    'pending', 'approved', 'rejected', 'cancelled', 'expired');
exception when duplicate_object then null; end $$;

-- §7 בקשות ואילוצים
do $$ begin
  create type request_status as enum (
    'draft', 'submitted', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null; end $$;

do $$ begin
  create type approval_mode as enum ('auto', 'manager');
exception when duplicate_object then null; end $$;

-- זמינות: מטריצת יום × משמרת
do $$ begin
  create type avail_value as enum ('can', 'prefer_not', 'cannot');
exception when duplicate_object then null; end $$;

do $$ begin
  create type avail_status as enum (
    'draft', 'ok', 'pending_approval', 'approved', 'rejected', 'superseded');
exception when duplicate_object then null; end $$;

-- §5.3 סידור עבודה
do $$ begin
  create type roster_status as enum ('draft', 'published', 'archived');
exception when duplicate_object then null; end $$;

do $$ begin
  create type site_role as enum ('implementer', 'lead');
exception when duplicate_object then null; end $$;

-- תקופות אתר
do $$ begin
  create type period_code as enum ('training', 'golive', 'support');
exception when duplicate_object then null; end $$;

-- פעילויות
do $$ begin
  create type audience_type as enum ('all', 'site', 'domain', 'sub_category', 'users');
exception when duplicate_object then null; end $$;

do $$ begin
  create type visibility_type as enum ('participants', 'managers_only', 'draft');
exception when duplicate_object then null; end $$;

-- -----------------------------------------------------------------------------
-- פונקציות עזר לזהות המבצע
--
-- השרת משתמש ב-service role, כך ש-auth.uid() ריק בתוך טריגרים. מיד אחרי
-- requireAuth השרת מריץ  set local app.actor_id = '<uuid>'  ו-
-- set local app.trace_id = '<ulid>' , וכך גם טריגרי ה-audit וגם טריגרי
-- created_by/updated_by יודעים מי האדם האמיתי מאחורי החיבור.
-- -----------------------------------------------------------------------------

create or replace function app.actor() returns uuid
language sql stable as $$
  select nullif(current_setting('app.actor_id', true), '')::uuid
$$;

create or replace function app.trace() returns text
language sql stable as $$
  select nullif(current_setting('app.trace_id', true), '')
$$;

-- -----------------------------------------------------------------------------
-- טריגר משותף: חותמות זמן, מבצע, ומונה גרסה לנעילה אופטימית (ETag)
-- -----------------------------------------------------------------------------

create or replace function app.tg_touch_row() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at  := now();
    new.updated_at  := now();
    new.row_version := 1;
    new.created_by  := coalesce(new.created_by, app.actor());
    new.updated_by  := new.created_by;
  else
    -- created_* אינם ניתנים לשינוי
    new.created_at  := old.created_at;
    new.created_by  := old.created_by;
    new.updated_at  := now();
    new.updated_by  := coalesce(app.actor(), old.updated_by);
    new.row_version := old.row_version + 1;
  end if;
  return new;
end $$;

-- נרמול שם לפני בדיקת ייחודיות: trim + כיווץ רווחים פנימיים.
-- בלי זה "אתר צפון" ו-"אתר  צפון" הן שתי רשומות שונות בהשוואת בתים.
create or replace function app.norm_name(txt text) returns text
language sql immutable as $$
  select nullif(regexp_replace(btrim(coalesce(txt, '')), '\s+', ' ', 'g'), '')
$$;

create or replace function app.tg_normalize_name() returns trigger
language plpgsql as $$
begin
  new.name := app.norm_name(new.name);
  return new;
end $$;
