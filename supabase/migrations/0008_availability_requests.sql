-- =============================================================================
-- 0008 — בקשות אילוץ והצהרות זמינות
-- §5.2, §7 + AC-09
-- =============================================================================

-- -----------------------------------------------------------------------------
-- constraint_requests — בקשת חופשה או אילוץ שעות.
--
-- starts_at/ends_at מחושבים בשרת ונשמרים ב-UTC. span הוא מה שמאפשר לזהות
-- חפיפה נכון גם כשהבקשה חוצה חצות.
-- -----------------------------------------------------------------------------
create table if not exists constraint_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  site_id uuid references sites(id),
  constraint_type_id uuid not null references constraint_types(id),

  constraint_date date not null,
  start_time time not null default '00:00',
  end_time   time not null default '23:59',
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  span tstzrange generated always as (tstzrange(starts_at, ends_at, '[)')) stored,

  note text,
  status request_status not null default 'draft',
  submitted_at timestamptz,
  approver_user_id uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,
  auto_approved boolean not null default false,
  rule_evaluation_id uuid references rule_evaluations(id),
  cancelled_at timestamptz,
  cancelled_by uuid references profiles(id),
  idempotency_key text,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  constraint cr_order check (ends_at > starts_at),
  constraint cr_decided check (
    status not in ('approved','rejected') or decided_at is not null),

  -- §7: "אין בקשה כפולה פעילה לאותו סוג וטווח" — נאכף, לא נבדק בקוד
  constraint cr_no_duplicate_active
    exclude using gist (user_id with =, constraint_type_id with =, span with &&)
    where (status in ('submitted','approved') and deleted_at is null)
);

create index if not exists cr_user_status_idx
  on constraint_requests (user_id, status, constraint_date desc) where deleted_at is null;
create index if not exists cr_site_date_idx
  on constraint_requests (site_id, constraint_date) where deleted_at is null;
create index if not exists cr_pending_idx
  on constraint_requests (status, submitted_at) where status = 'submitted' and deleted_at is null;
create index if not exists cr_span_idx
  on constraint_requests using gist (span) where status = 'approved' and deleted_at is null;

alter table constraint_requests enable row level security;
select app.attach_managed('constraint_requests');

-- -----------------------------------------------------------------------------
-- availability_declarations — הצהרת זמינות שבועית.
--
-- הצהרה שהוכרעה היא immutable. הגשה חוזרת יוצרת revision חדשה עם
-- supersedes_id, והישנה מסומנת superseded. כך החלטת מנהל אינה נדרסת בשקט —
-- הבאג שהיה בפרוטוטייפ — וכל היסטוריית ההחלטות שורדת (§12).
-- -----------------------------------------------------------------------------
create table if not exists availability_declarations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references profiles(id) on delete cascade,
  site_id uuid not null references sites(id) on delete cascade,
  week_start date not null,
  revision integer not null default 1,
  supersedes_id uuid references availability_declarations(id),
  superseded_at timestamptz,
  status avail_status not null default 'draft',
  note text,
  submitted_at timestamptz,
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_note text,

  -- המכסות מצולמות ברגע ההגשה: הידוק מכסה בדיעבד לא הופך הגשות קיימות לחריגות
  max_cannot_snapshot smallint not null default 3,
  max_prefer_not_snapshot smallint not null default 4,

  rule_evaluation_id uuid references rule_evaluations(id),
  idempotency_key text,

  created_at timestamptz not null default now(), created_by uuid references profiles(id),
  updated_at timestamptz not null default now(), updated_by uuid references profiles(id),
  deleted_at timestamptz, deleted_by uuid references profiles(id),
  row_version integer not null default 1,

  -- השבוע מתחיל תמיד ביום ראשון
  constraint avail_week_starts_sunday check (extract(dow from week_start) = 0),
  constraint avail_decided check (
    status not in ('approved','rejected')
    or (decided_by is not null and decided_at is not null))
);

-- הצהרה נוכחית אחת בדיוק לכל (משתמש, אתר, שבוע)
create unique index if not exists avail_current_idx
  on availability_declarations (user_id, site_id, week_start)
  where superseded_at is null and deleted_at is null;
create index if not exists avail_week_status_idx
  on availability_declarations (site_id, week_start, status) where deleted_at is null;
create index if not exists avail_pending_idx
  on availability_declarations (status, submitted_at)
  where status = 'pending_approval' and deleted_at is null;
create index if not exists avail_user_idx
  on availability_declarations (user_id, week_start desc) where deleted_at is null;

alter table availability_declarations enable row level security;
select app.attach_managed('availability_declarations');

-- הגשה חוזרת מסמנת את הקודמת כמוחלפת
create or replace function app.tg_supersede_declaration() returns trigger
language plpgsql as $$
begin
  if new.supersedes_id is not null then
    update availability_declarations
       set superseded_at = now(), status = 'superseded'
     where id = new.supersedes_id and superseded_at is null;
  end if;
  return new;
end $$;

drop trigger if exists avail_supersede on availability_declarations;
create trigger avail_supersede after insert on availability_declarations
  for each row execute function app.tg_supersede_declaration();

-- -----------------------------------------------------------------------------
-- availability_cells — מטריצת יום × משמרת
-- -----------------------------------------------------------------------------
create table if not exists availability_cells (
  id uuid primary key default gen_random_uuid(),
  declaration_id uuid not null references availability_declarations(id) on delete cascade,
  cell_date date not null,
  shift_type_id uuid not null references site_shift_types(id) on delete cascade,
  value avail_value not null default 'can',
  note text,
  unique (declaration_id, cell_date, shift_type_id)
);
create index if not exists avail_cells_lookup_idx
  on availability_cells (declaration_id, cell_date);
create index if not exists avail_cells_shift_idx
  on availability_cells (shift_type_id, cell_date);
alter table availability_cells enable row level security;

-- תאים של הצהרה שהוכרעה או הוחלפה הם לקריאה בלבד
create or replace function app.tg_cells_declaration_open() returns trigger
language plpgsql as $$
declare st avail_status; sup timestamptz;
begin
  select status, superseded_at into st, sup
    from availability_declarations
   where id = coalesce(new.declaration_id, old.declaration_id);

  if sup is not null or st in ('approved', 'rejected', 'superseded') then
    raise exception 'AVAILABILITY_DECLARATION_READ_ONLY'
      using detail = 'הצהרה שהוכרעה או הוחלפה אינה ניתנת לשינוי — יש להגיש גרסה חדשה';
  end if;
  return coalesce(new, old);
end $$;

drop trigger if exists avail_cells_guard on availability_cells;
create trigger avail_cells_guard
  before insert or update or delete on availability_cells
  for each row execute function app.tg_cells_declaration_open();

-- -----------------------------------------------------------------------------
-- availability_violations — נגזר מהתאים, אבל נשמר כדי שיהיה ניתן לשאילתה
-- בתור האישורים של המנהל ובדוחות.
-- -----------------------------------------------------------------------------
create table if not exists availability_violations (
  id uuid primary key default gen_random_uuid(),
  declaration_id uuid not null references availability_declarations(id) on delete cascade,
  kind text not null check (kind in (
    'mandatory_cannot', 'over_max_cannot', 'over_max_prefer_not', 'deadline_missed')),
  cell_date date,
  shift_type_id uuid references site_shift_types(id) on delete cascade,
  detail jsonb not null default '{}'::jsonb
);
create index if not exists avail_violations_decl_idx
  on availability_violations (declaration_id);
alter table availability_violations enable row level security;
