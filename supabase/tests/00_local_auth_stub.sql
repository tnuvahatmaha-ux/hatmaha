-- =============================================================================
-- חיקוי מקומי של סכמת auth של Supabase — לבדיקות בלבד.
-- לעולם אינו מורץ על פרויקט Supabase אמיתי: שם הסכמה הזו כבר קיימת ומנוהלת.
-- מאפשר להריץ את כל המיגרציות מול Postgres מקומי ולוודא שהן תקינות.
-- =============================================================================

create schema if not exists auth;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  encrypted_password text,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- ב-Supabase הפונקציה קוראת את ה-JWT; מקומית היא קוראת משתנה סשן.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

create or replace function auth.role() returns text
language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''), 'anon')
$$;

-- תפקידי Supabase, כדי ש-grant/revoke ו-policies יעברו מקומית
do $$ begin create role anon nologin;          exception when duplicate_object then null; end $$;
do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
