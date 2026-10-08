-- =============================================================================
-- 0020 — הודעות מדריך לצוות, עם קבצים מצורפים ואישור קריאה
--
-- הטבלאות updates ו-update_recipients קיימות מ-0011. כאן נוספים:
--   • requires_ack — השולח מבקש מהנמענים לאשר שקראו
--   • acknowledged_at — מתי הנמען אישר
--   • update_attachments — קבצים ב-Supabase Storage (bucket פרטי "attachments")
-- =============================================================================

alter table updates add column if not exists requires_ack boolean not null default false;

alter table update_recipients add column if not exists acknowledged_at timestamptz;
alter table update_recipients add column if not exists reminded_at timestamptz;

create index if not exists update_recipients_pending_ack_idx
  on update_recipients (update_id) where acknowledged_at is null;

create table if not exists update_attachments (
  id uuid primary key default gen_random_uuid(),
  update_id uuid not null references updates(id) on delete cascade,
  file_name text not null,
  mime_type text,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 10485760),
  storage_path text not null unique,
  uploaded_by uuid not null references profiles(id),
  created_at timestamptz not null default now(),
  constraint update_attachments_name_not_blank check (length(btrim(file_name)) > 0)
);
create index if not exists update_attachments_update_idx on update_attachments (update_id);
alter table update_attachments enable row level security;
revoke all on update_attachments from anon, authenticated;

insert into notification_types (code, name_he, default_email, display_order) values
  ('update_ack_reminder', 'תזכורת לאישור קריאת הודעה', false, 95)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Bucket פרטי לקבצים. במסד מקומי (בלי Supabase) אין סכמת storage — מדלגים.
-- -----------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.tables
              where table_schema = 'storage' and table_name = 'buckets') then
    execute $q$
      insert into storage.buckets (id, name, public, file_size_limit)
      values ('attachments', 'attachments', false, 10485760)
      on conflict (id) do nothing
    $q$;
  end if;
end $$;
