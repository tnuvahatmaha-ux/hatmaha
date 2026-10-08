-- =============================================================================
-- 0019 — סוג משמרת (בוקר / צהריים / לילה) וכלל מינימום משמרות בהגשת זמינות
--
-- הכלל minShiftsPerCategory מאפשר למנהל לדרוש, למשל, לפחות 4 משמרות בוקר,
-- 4 צהריים, 4 לילה ומשמרת אחת בסוף השבוע (שישי–שבת). נספרות רק משמרות
-- שסומנו "זמין" — "מעדיף שלא" ו"לא יכול" אינן נספרות.
-- =============================================================================

do $$ begin
  create type shift_category as enum ('morning', 'afternoon', 'night');
exception when duplicate_object then null; end $$;

-- 05:00–11:59 בוקר · 12:00–18:59 צהריים · השאר לילה
create or replace function app.shift_category_for(p_start time)
returns shift_category
language sql immutable as $$
  select case
           when p_start >= '05:00' and p_start < '12:00' then 'morning'::shift_category
           when p_start >= '12:00' and p_start < '19:00' then 'afternoon'::shift_category
           else 'night'::shift_category
         end
$$;

alter table shift_types add column if not exists category shift_category;

update shift_types set category = app.shift_category_for(start_time) where category is null;

alter table shift_types alter column category set not null;

-- משמרת שנוצרת בלי סוג מקבלת אותו משעת ההתחלה; סוג שנבחר במפורש נשמר
create or replace function app.tg_shift_category_default() returns trigger
language plpgsql as $$
begin
  if new.category is null then
    new.category := app.shift_category_for(new.start_time);
  end if;
  return new;
end $$;

drop trigger if exists shift_types_category_default on shift_types;
create trigger shift_types_category_default
  before insert or update on shift_types
  for each row execute function app.tg_shift_category_default();

comment on column shift_types.category is
  'בוקר / צהריים / לילה. נגזר משעת ההתחלה כברירת מחדל, וניתן לשינוי.';

-- -----------------------------------------------------------------------------
-- סוג התנאי החדש
-- -----------------------------------------------------------------------------
insert into rule_condition_types
  (code, name_he, description_he, params_schema, allowed_triggers, allowed_scopes, display_order)
values
  ('minShiftsPerCategory', 'מינימום משמרות לפי סוג',
   'בהגשת זמינות: מספר המשמרות המינימלי שיש לסמן "זמין" בכל סוג משמרת, ובסוף השבוע (שישי–שבת). 0 = לא נבדק',
   '{"type":"object","properties":{
       "morning":{"type":"integer","minimum":0,"maximum":14,"title":"בוקר"},
       "afternoon":{"type":"integer","minimum":0,"maximum":14,"title":"צהריים"},
       "night":{"type":"integer","minimum":0,"maximum":14,"title":"לילה"},
       "weekend":{"type":"integer","minimum":0,"maximum":14,"title":"סוף שבוע"}},
     "required":[]}'::jsonb,
   '{submit}'::rule_trigger[],
   '{global,site,domain}'::rule_scope_type[],
   125)
on conflict (code) do nothing;
