-- =============================================================================
-- 0025 — אישור קריאה להודעות בקבוצות
--
-- כל משתמש שאינו מטמיע יכול לסמן את ההודעה שהוא שולח לקבוצה כ"נדרש אישור
-- קריאה". חברי הקבוצה מאשרים שקראו, והשולח רואה מי אישר ומי עוד לא.
-- =============================================================================

alter table chat_messages add column if not exists requires_ack boolean not null default false;

create table if not exists chat_message_acks (
  message_id bigint not null references chat_messages(id) on delete cascade,
  user_id uuid not null references profiles(id) on delete cascade,
  acknowledged_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists chat_message_acks_user_idx on chat_message_acks (user_id);
alter table chat_message_acks enable row level security;
revoke all on chat_message_acks from anon, authenticated;

insert into notification_types (code, name_he, default_email, display_order) values
  ('chat_ack_required', 'הודעה בקבוצה שדורשת אישור קריאה', false, 97)
on conflict (code) do nothing;
