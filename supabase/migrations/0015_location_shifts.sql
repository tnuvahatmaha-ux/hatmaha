-- =============================================================================
-- 0015 — משמרות לפי מיקום, זמינות לפי חלונות שעות, וכללי אישור אילוצים גנריים
--
-- 1. משמרת שייכת למיקום ולא לאתר. לכל מיקום שעות משלו (מחלקה, מיון, הדרכה).
-- 2. תא זמינות מתאר חלון שעות (התחלה–סיום) ולא משמרת מסוימת, כי משמרות
--    שונות במיקומים שונים חולקות לעיתים את אותן שעות.
-- 3. כלל אישור אחד לכל סוג אילוץ, שחל על כל האתרים. העקיפה לפי אתר נמחקת.
--
-- המיגרציה מעבירה נתונים קיימים בלי לאבד שיבוץ או תא זמינות: כל משמרת אתר
-- משוכפלת לכל מיקום של האתר, וכל שיבוץ מופנה לעותק של המיקום שלו.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. משמרות → מיקום
-- -----------------------------------------------------------------------------
alter table site_shift_types rename to shift_types;

alter trigger site_shift_types_touch     on shift_types rename to shift_types_touch;
alter trigger site_shift_types_audit     on shift_types rename to shift_types_audit;
alter trigger site_shift_types_normalize on shift_types rename to shift_types_normalize;

alter table shift_types add column location_id uuid references locations(id) on delete cascade;
alter table shift_types add column _source_id uuid;   -- זמני, להעברת הנתונים בלבד

-- הייחודיות לפי (אתר, שם) הייתה חוסמת את השכפול לכמה מיקומים
drop index if exists site_shift_types_name_idx;
drop index if exists site_shift_types_site_idx;

-- שכפול: כל משמרת אתר → עותק לכל מיקום של אותו אתר, כולל מיקומים
-- מושבתים או מחוקים, כדי שגם שיבוצים היסטוריים שלהם ימצאו לאן להצביע
insert into shift_types
  (site_id, location_id, name, start_time, end_time, is_mandatory, required_staff,
   domain_id, sub_category_id, display_order, is_active, deleted_at, created_by, _source_id)
select s.site_id, l.id, s.name, s.start_time, s.end_time, s.is_mandatory, s.required_staff,
       s.domain_id, s.sub_category_id, s.display_order, s.is_active,
       coalesce(s.deleted_at, l.deleted_at), s.created_by, s.id
  from shift_types s
  join locations l on l.site_id = s.site_id
 where s.location_id is null;

-- הפניית השיבוצים לעותק של המיקום שלהם.
-- טריגר "לקריאה בלבד" מושבת לזמן ההעברה בלבד: זה שינוי מבני של הפניה,
-- לא עריכת תוכן של סידור שפורסם — השעות, האנשים והתאריכים לא משתנים.
alter table roster_assignments disable trigger ra_draft_only;

update roster_assignments ra
   set shift_type_id = copy.id
  from shift_types copy
 where copy._source_id = ra.shift_type_id
   and copy.location_id = ra.location_id;

alter table roster_assignments enable trigger ra_draft_only;

-- -----------------------------------------------------------------------------
-- 2. זמינות → חלונות שעות
-- -----------------------------------------------------------------------------
alter table availability_cells add column start_time time, add column end_time time;
alter table availability_violations add column start_time time, add column end_time time;

-- גם כאן טריגר ההגנה מושבת לזמן ההעברה בלבד: הערכים שהוגשו נשמרים כמות שהם
alter table availability_cells disable trigger avail_cells_guard;

update availability_cells c
   set start_time = s.start_time, end_time = s.end_time
  from shift_types s
 where s.id = c.shift_type_id;

update availability_violations v
   set start_time = s.start_time, end_time = s.end_time
  from shift_types s
 where s.id = v.shift_type_id;

-- שתי משמרות שונות עם אותן שעות הופכות לאותו חלון. כשהיו להן ערכים שונים
-- באותו יום, נשמר המחמיר מביניהם — כך שאיש לא "מקבל" זמינות שלא הצהיר.
delete from availability_cells c
 using availability_cells d
 where c.declaration_id = d.declaration_id
   and c.cell_date = d.cell_date
   and c.start_time = d.start_time
   and c.end_time = d.end_time
   and c.id <> d.id
   and (
     (case c.value when 'cannot' then 3 when 'prefer_not' then 2 else 1 end)
       < (case d.value when 'cannot' then 3 when 'prefer_not' then 2 else 1 end)
     or ((case c.value when 'cannot' then 3 when 'prefer_not' then 2 else 1 end)
           = (case d.value when 'cannot' then 3 when 'prefer_not' then 2 else 1 end)
         and c.id < d.id)
   );

alter table availability_cells drop column shift_type_id;      -- גורר את הייחודיות והאינדקס הישנים
alter table availability_cells alter column start_time set not null;
alter table availability_cells alter column end_time set not null;
alter table availability_cells
  add constraint avail_cells_window_unique unique (declaration_id, cell_date, start_time, end_time);

alter table availability_cells enable trigger avail_cells_guard;

alter table availability_violations drop column shift_type_id;

-- -----------------------------------------------------------------------------
-- 3. סגירת ההעברה: המשמרות המקוריות של האתר אינן נחוצות עוד
-- -----------------------------------------------------------------------------
delete from shift_types where location_id is null;

alter table shift_types drop column _source_id;
alter table shift_types alter column location_id set not null;

create unique index shift_types_location_name_idx
  on shift_types (location_id, name) where deleted_at is null;
create index shift_types_location_idx
  on shift_types (location_id) where deleted_at is null and is_active;
create index shift_types_site_idx
  on shift_types (site_id) where deleted_at is null and is_active;

comment on table shift_types is
  'משמרות של מיקום. site_id נגזר מהמיקום בטריגר, ונשמר לשאילתות לפי אתר.';

-- site_id נגזר תמיד מהמיקום, ולכן אי אפשר שיתפצל ממנו
create or replace function app.tg_shift_site_from_location() returns trigger
language plpgsql as $$
begin
  select site_id into new.site_id from locations where id = new.location_id;
  if new.site_id is null then
    raise exception 'SHIFT_LOCATION_NOT_FOUND';
  end if;
  return new;
end $$;

drop trigger if exists shift_types_site_sync on shift_types;
create trigger shift_types_site_sync
  before insert or update of location_id on shift_types
  for each row execute function app.tg_shift_site_from_location();

-- -----------------------------------------------------------------------------
-- 4. כללי אישור אילוצים — גנריים, אחד לכל סוג, לכל האתרים
-- -----------------------------------------------------------------------------
alter table constraint_types rename column default_approval_mode to approval_mode;

comment on column constraint_types.approval_mode is
  'auto = מאושר מיד בהגשה; manager = ממתין להחלטה. חל על כל האתרים.';

drop table if exists site_constraint_policies;
