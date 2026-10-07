-- =============================================================================
-- 0004 — קטלוג ההרשאות, ברירות המחדל לתפקידים, והרשאות פרטניות
-- §3.1: RBAC עם הרשאות פרטניות. AC-02: מנהל הטמעה מעניק ומסיר ללא פיתוח.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- permissions — הקטלוג. דאטה, לא קוד: הוספת משאב חדש היא INSERT.
-- -----------------------------------------------------------------------------
create table if not exists permissions (
  id        uuid primary key default gen_random_uuid(),
  code      text not null unique,          -- '<resource>.<action>'
  resource  text not null,
  action    perm_action not null,
  name_he   text not null,
  description_he text,
  is_active boolean not null default true,
  display_order integer not null default 0,
  unique (resource, action)
);

alter table permissions enable row level security;

-- שמות המשאבים מילה במילה ממנוע הרפרנס.
-- VALUES מוטבעים, ולא טבלאות זמניות, כדי שהסקריפט ירוץ נכון גם מחוץ לטרנזקציה.
insert into permissions (code, resource, action, name_he, display_order, is_active)
select r.code || '.' || a.code,
       r.code,
       a.code,
       r.name_he || ' / ' || a.name_he,
       r.ord * 10 + a.ord,
       -- צירופים חסרי משמעות מושבתים כדאטה, כך שהפעלתם בעתיד אינה deploy
       not (
            (r.code = 'audit'        and a.code in ('create','edit','delete','approve','publish'))
         or (r.code = 'teamSchedule' and a.code in ('create','edit','delete','approve','publish'))
         or (r.code = 'chat'         and a.code in ('approve','publish','export'))
         or (r.code = 'reports'      and a.code in ('create','edit','delete','approve','publish'))
         or (r.code = 'availability' and a.code = 'publish')
         or (r.code = 'requests'     and a.code = 'publish')
       )
  from (values
        ('users',         'משתמשים',        10),
        ('implementers',  'מטמיעים',        20),
        ('mentors',       'מדריכים',        30),
        ('sites',         'אתרים',          40),
        ('domains',       'תחומים',         50),
        ('activities',    'פעילויות',       60),
        ('availability',  'זמינות',         70),
        ('requests',      'בקשות ואישורים', 80),
        ('rules',         'חוקיות',         90),
        ('roster',        'סידור עבודה',    100),
        ('teamSchedule',  'לו״ז צוותי',     110),
        ('materials',     'חומרים',         120),
        ('updates',       'עדכונים',        130),
        ('chat',          'צ׳אט',           140),
        ('reports',       'דוחות',          150),
        ('audit',         'יומן ביקורת',    160),
        ('permissions',   'הרשאות',         170),
        ('settings',      'הגדרות',         180)
       ) as r(code, name_he, ord)
 cross join (values
        ('view'::perm_action,    'צפייה',  1),
        ('create'::perm_action,  'יצירה',  2),
        ('edit'::perm_action,    'עריכה',  3),
        ('delete'::perm_action,  'מחיקה',  4),
        ('approve'::perm_action, 'אישור',  5),
        ('publish'::perm_action, 'פרסום',  6),
        ('export'::perm_action,  'ייצוא',  7),
        ('manage'::perm_action,  'ניהול',  8)
       ) as a(code, name_he, ord)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- role_permissions — ברירת המחדל של כל אחד מארבעת תפקידי הבסיס
-- -----------------------------------------------------------------------------
create table if not exists role_permissions (
  id            uuid primary key default gen_random_uuid(),
  role          base_role not null,
  permission_id uuid not null references permissions(id) on delete cascade,
  effect        perm_effect not null default 'allow',
  scope_type    scope_type  not null default 'global',

  created_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  deleted_at timestamptz,
  deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  unique (role, permission_id, scope_type)
);

create index if not exists role_permissions_role_idx
  on role_permissions (role) where deleted_at is null;

alter table role_permissions enable row level security;
select app.attach_managed('role_permissions');

-- הזרעה: מנהל הטמעה פתוח לכלל ההרשאות והאתרים (§3)
insert into role_permissions (role, permission_id, effect, scope_type)
select 'manager', p.id, 'allow', 'global'
  from permissions p
 where p.action = 'manage' and p.is_active
on conflict do nothing;

-- שאר התפקידים: רשימה מפורשת (resource, action, scope)
insert into role_permissions (role, permission_id, effect, scope_type)
select rp.role, p.id, 'allow', rp.scope::scope_type
  from (values
  -- מדריך: ניהול המטמיעים שבאחריותו, הדרכות, חומרים, עדכונים וצ׳אט (§8)
        ('mentor'::base_role,'implementers','view','assigned_users'),
        ('mentor','implementers','edit','assigned_users'),
        ('mentor','users','view','assigned_users'),
        ('mentor','users','edit','own_data'),
        ('mentor','activities','view','assigned_users'),
        ('mentor','activities','create','assigned_users'),
        ('mentor','activities','edit','assigned_users'),
        ('mentor','activities','delete','assigned_users'),
        ('mentor','materials','view','own_data'),
        ('mentor','materials','create','own_data'),
        ('mentor','materials','edit','own_data'),
        ('mentor','materials','publish','own_data'),
        ('mentor','materials','delete','own_data'),
        ('mentor','updates','view','assigned_users'),
        ('mentor','updates','create','assigned_users'),
        ('mentor','chat','view','assigned_users'),
        ('mentor','chat','create','assigned_users'),
        ('mentor','availability','view','assigned_users'),
        ('mentor','availability','approve','assigned_users'),
        ('mentor','requests','view','assigned_users'),
        ('mentor','requests','approve','assigned_users'),
        ('mentor','roster','view','assigned_users'),
        ('mentor','teamSchedule','view','site'),
        ('mentor','reports','view','assigned_users'),

  -- מטמיע מוביל: צפייה תפעולית בצוות ובפעילויות לפי ה-Scope שניתן לו (AC-07)
        ('lead','implementers','view','site'),
        ('lead','users','view','site'),
        ('lead','users','edit','own_data'),
        ('lead','activities','view','site'),
        ('lead','roster','view','site'),
        ('lead','teamSchedule','view','site'),
        ('lead','availability','view','own_data'),
        ('lead','availability','create','own_data'),
        ('lead','availability','edit','own_data'),
        ('lead','availability','delete','own_data'),
        ('lead','requests','view','own_data'),
        ('lead','requests','create','own_data'),
        ('lead','requests','edit','own_data'),
        ('lead','requests','delete','own_data'),
        ('lead','chat','view','own_data'),
        ('lead','chat','create','own_data'),
        ('lead','materials','view','own_data'),
        ('lead','updates','view','own_data'),

  -- מטמיע: לו״ז אישי, לו״ז צוותי מותר, בקשות, זמינות, הודעות, פרופיל וצ׳אט (AC-05)
        ('implementer','activities','view','own_data'),
        ('implementer','roster','view','own_data'),
        ('implementer','teamSchedule','view','site'),
        ('implementer','availability','view','own_data'),
        ('implementer','availability','create','own_data'),
        ('implementer','availability','edit','own_data'),
        ('implementer','availability','delete','own_data'),
        ('implementer','requests','view','own_data'),
        ('implementer','requests','create','own_data'),
        ('implementer','requests','edit','own_data'),
        ('implementer','requests','delete','own_data'),
        ('implementer','chat','view','own_data'),
        ('implementer','chat','create','own_data'),
        ('implementer','users','view','own_data'),
        ('implementer','users','edit','own_data'),
        ('implementer','materials','view','own_data'),
        ('implementer','updates','view','own_data')
       ) as rp(role, resource, action, scope)
  join permissions p
    on p.resource = rp.resource
   and p.action   = rp.action::perm_action
on conflict do nothing;

-- -----------------------------------------------------------------------------
-- permission_grants — הרשאה פרטנית שמרחיבה או מצמצמת את תפקיד הבסיס (AC-03)
-- -----------------------------------------------------------------------------
create table if not exists permission_grants (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id) on delete cascade,
  permission_id uuid not null references permissions(id),
  effect        perm_effect not null,
  scope_type    scope_type  not null,
  scope_id      uuid,
  valid_from    timestamptz not null default now(),
  valid_to      timestamptz,
  reason        text,
  granted_by    uuid not null references profiles(id),
  revoked_at    timestamptz,
  revoked_by    uuid references profiles(id),
  revoke_reason text,

  created_at timestamptz not null default now(),
  created_by uuid references profiles(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references profiles(id),
  deleted_at timestamptz,
  deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  -- צורת ה-Scope נאכפת, לא רק מומלצת
  constraint grant_scope_shape check (
    (scope_type in ('global','own_data','assigned_users') and scope_id is null) or
    (scope_type in ('site','domain','sub_category')       and scope_id is not null)),

  constraint grant_window check (valid_to is null or valid_to > valid_from),

  -- §3.2: "סיבה — שדה חובה בהרחבה חריגה".
  -- הרחבה (allow) מחייבת נימוק; צמצום (deny) אינו מחייב.
  constraint grant_reason_required check (
    effect = 'deny' or length(btrim(coalesce(reason, ''))) >= 5)
);

comment on table permission_grants is
  'הרשאה פרטנית. פקיעה מיידית ומוצהרת: המנוע מסנן על now(), ולכן אינה תלויה ב-cron.';

-- אידמפוטנטיות לפי מפתח טבעי: POST חוזר של אותה הרשאה הוא no-op (§13)
create unique index if not exists permission_grants_natural_idx
  on permission_grants (
    user_id, permission_id, effect, scope_type,
    coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
  where revoked_at is null and deleted_at is null;

create index if not exists permission_grants_live_idx
  on permission_grants (user_id, valid_from, valid_to)
  where revoked_at is null and deleted_at is null;

create index if not exists permission_grants_expiry_idx
  on permission_grants (valid_to)
  where revoked_at is null and deleted_at is null and valid_to is not null;

alter table permission_grants enable row level security;
select app.attach_managed('permission_grants');

-- -----------------------------------------------------------------------------
-- הגנה: אי אפשר לשלול מאף אחד את היכולת לנהל הרשאות.
-- בלעדיה, deny יחיד על permissions.manage היה הופך את המערכת לבלתי ניתנת
-- לניהול ומחייב ניתוח SQL ידני כדי להתאושש.
-- -----------------------------------------------------------------------------
create or replace function app.tg_guard_permissions_manage() returns trigger
language plpgsql as $$
declare code text;
begin
  select p.code into code from permissions p where p.id = new.permission_id;
  if new.effect = 'deny' and code = 'permissions.manage' then
    raise exception 'CANNOT_DENY_PERMISSIONS_MANAGE'
      using detail = 'שלילת ניהול הרשאות הייתה הופכת את המערכת לבלתי ניתנת לניהול';
  end if;
  return new;
end $$;

drop trigger if exists permission_grants_guard on permission_grants;
create trigger permission_grants_guard
  before insert or update on permission_grants
  for each row execute function app.tg_guard_permissions_manage();
