-- =============================================================================
-- 0018 — מיקומים ומשמרות לפי שלב האתר, ומאגר מיקומים משותף
--
-- 1. אתר עובר שלבים: הכשרה ← עלייה לאוויר ← ליווי. מיקום יכול להתקיים רק
--    בחלק מהשלבים (כיתת הדרכה — רק בהכשרה), ומשמרת יכולה להיות מוגדרת
--    לשלב מסוים (שעות ההכשרה שונות משעות העלייה לאוויר).
-- 2. השלב בכל תאריך נגזר מ-site_periods, ואם אין שם שורה שמכסה אותו —
--    מתאריך העלייה לאוויר של האתר. שבוע שחוצה את מועד העלייה מתחלף באמצע.
-- 3. סוגי המיקום הם מאגר המיקומים: כל שם מיקום שהוקם נשמר בו, וכך מופיע
--    ברשימה בפעם הבאה שמקימים אתר.
-- =============================================================================

alter table locations
  add column if not exists periods period_code[] not null
    default '{training,golive,support}'::period_code[];

alter table locations drop constraint if exists locations_periods_not_empty;
alter table locations
  add constraint locations_periods_not_empty check (cardinality(periods) > 0);

comment on column locations.periods is 'השלבים שבהם המיקום פעיל. ברירת המחדל: כל השלבים.';

alter table shift_types add column if not exists period period_code;

comment on column shift_types.period is
  'השלב שבו המשמרת חלה. NULL = בכל השלבים.';

-- המרת enum לטקסט אינה IMMUTABLE בעיני Postgres, ולכן אינה מותרת באינדקס.
-- תוויות period_code לעולם אינן משתנות, ולכן העטיפה בטוחה.
create or replace function app.period_key(p period_code) returns text
language sql immutable as $$ select coalesce(p::text, '*') $$;

-- משמרת "בוקר" יכולה להתקיים בנפרד לכל תחום ולכל שלב באותו מיקום
drop index if exists shift_types_location_name_idx;
create unique index shift_types_location_name_idx
  on shift_types (
    location_id, name,
    coalesce(domain_id, '00000000-0000-0000-0000-000000000000'::uuid),
    app.period_key(period)
  )
  where deleted_at is null;

-- -----------------------------------------------------------------------------
-- השלב של אתר בתאריך נתון
-- -----------------------------------------------------------------------------
create or replace function app.site_period_on(p_site uuid, p_date date)
returns period_code
language sql stable as $$
  select coalesce(
    (select sp.period
       from site_periods sp
      where sp.site_id = p_site and sp.deleted_at is null
        and p_date between sp.starts_on and sp.ends_on
      order by sp.starts_on desc
      limit 1),
    (select case
              when s.go_live_date is null then
                case st.code when 'golive' then 'golive'::period_code
                             when 'support' then 'support'::period_code
                             when 'ended' then 'support'::period_code
                             else 'training'::period_code end
              when p_date < s.go_live_date then 'training'::period_code
              when st.code in ('support', 'ended') then 'support'::period_code
              else 'golive'::period_code
            end
       from sites s join site_statuses st on st.id = s.status_id
      where s.id = p_site),
    'training'::period_code)
$$;

comment on function app.site_period_on(uuid, date) is
  'שלב האתר בתאריך: לפי site_periods, ואם אין — לפי go_live_date וסטטוס האתר.';

-- -----------------------------------------------------------------------------
-- מאגר המיקומים: כל מיקום שאין לו סוג נכנס למאגר ומקושר אליו
-- -----------------------------------------------------------------------------
insert into location_types (name)
select distinct l.name
  from locations l
 where l.location_type_id is null and l.deleted_at is null
   and not exists (select 1 from location_types lt
                    where lt.name = l.name and lt.deleted_at is null)
on conflict do nothing;

update locations l
   set location_type_id = lt.id
  from location_types lt
 where l.location_type_id is null and l.deleted_at is null
   and lt.name = l.name and lt.deleted_at is null;

-- לכל סוג במאגר פרופיל הכשרה ופרופיל עלייה לאוויר
insert into location_type_profiles (location_type_id, period)
select lt.id, p.period
  from location_types lt
 cross join (values ('training'::period_code), ('golive'::period_code)) as p(period)
 where lt.deleted_at is null
on conflict (location_type_id, period) do nothing;
