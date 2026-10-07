-- =============================================================================
-- 0016 — רמות הסמכה: display_order כמו בשאר הקטלוגים
--
-- מסך הקטלוגים קורא ומוסיף ערכים בכל הקטלוגים באותה צורה, לפי display_order.
-- ל-qualification_levels לא הייתה העמודה, ולכן הצגת הקטלוג נכשלה (500)
-- והוספת רמה חדשה נכשלה על rank שהוא חובה.
-- =============================================================================

alter table qualification_levels
  add column if not exists display_order smallint not null default 0;

update qualification_levels set display_order = rank * 10 where display_order = 0;

-- rank נשמר כסדר הרמות. רמה שנוספת מהממשק מקבלת את הדרגה הבאה.
create or replace function app.tg_qualification_rank() returns trigger
language plpgsql as $$
begin
  if new.rank is null then
    select coalesce(max(rank), 0) + 1 into new.rank from qualification_levels;
  end if;
  return new;
end $$;

drop trigger if exists qualification_levels_rank on qualification_levels;
create trigger qualification_levels_rank
  before insert on qualification_levels
  for each row execute function app.tg_qualification_rank();
