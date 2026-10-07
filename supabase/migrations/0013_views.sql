-- =============================================================================
-- 0013 — Views
-- =============================================================================

-- -----------------------------------------------------------------------------
-- v_team_schedule — הלו״ז הצוותי, §7: "מידע צוותי מותר בלבד, ללא סיבת חופשה
-- או הערות פרטיות". מזעור המידע נאכף כאן, במקום אחד, ולא בכל נתיב מחדש.
--
-- אילוצים אינם מופיעים כאן כלל: העובדה שמישהו לא זמין אינה מידע צוותי.
-- -----------------------------------------------------------------------------
create or replace view v_team_schedule as
  -- שיבוצים מתוך גרסאות שפורסמו בלבד. טיוטות אינן נראות לאיש מלבד המשבץ.
  select
    ra.site_id,
    ra.assignment_date              as entry_date,
    ra.user_id,
    p.full_name                     as person_name,
    'shift'                         as kind,
    coalesce(st.name, 'משמרת')      as activity_name,
    l.name                          as location_name,
    ra.starts_at,
    ra.ends_at,
    ra.domain_id,
    d.name                          as domain_name,
    'משובץ'                         as status_he
  from roster_assignments ra
  join roster_versions rv on rv.id = ra.version_id
  join profiles p on p.id = ra.user_id
  join locations l on l.id = ra.location_id
  left join site_shift_types st on st.id = ra.shift_type_id
  left join domains d on d.id = ra.domain_id
  where rv.status = 'published'
    and rv.deleted_at is null
    and ra.deleted_at is null
    and p.deleted_at is null

  union all

  -- פעילויות שנראות למשתתפים בלבד. טיוטות ופעילויות "למנהלים בלבד" מוחרגות.
  select
    a.site_id,
    a.activity_date,
    ap.user_id,
    p.full_name,
    'activity',
    coalesce(nullif(btrim(a.title), ''), at.name_he),
    l.name,
    a.starts_at,
    a.ends_at,
    a.domain_id,
    d.name,
    case a.status
      when 'completed' then 'הושלם'
      when 'scheduled' then 'מתוכנן'
      else 'מתוכנן'
    end
  from activities a
  join activity_participants ap on ap.activity_id = a.id
  join profiles p on p.id = ap.user_id
  join activity_types at on at.id = a.activity_type_id
  left join locations l on l.id = a.location_id
  left join domains d on d.id = a.domain_id
  where a.visibility = 'participants'
    and a.status in ('scheduled', 'completed')
    and a.deleted_at is null
    and p.deleted_at is null;

comment on view v_team_schedule is
  'לו״ז צוותי במזעור מידע: ללא סיבות אילוץ, ללא הערות, וללא טיוטות סידור.';

-- -----------------------------------------------------------------------------
-- v_live_permission_grants — הרשאות פרטניות שבתוקף ברגע זה.
-- פקיעה היא פילטר ולא ג׳וב, ולכן "הרשאה שפג תוקפה תבוטל אוטומטית" מיידי.
-- -----------------------------------------------------------------------------
create or replace view v_live_permission_grants as
  select g.*, p.code as permission_code, p.resource, p.action
    from permission_grants g
    join permissions p on p.id = g.permission_id
   where g.revoked_at is null
     and g.deleted_at is null
     and g.valid_from <= now()
     and (g.valid_to is null or g.valid_to > now());

-- -----------------------------------------------------------------------------
-- v_unassigned_implementers — §9: "התרעה על מטמיע ללא מדריך", וגם
-- כרטיס "מטמיעים ללא שיוך" בדשבורד.
-- -----------------------------------------------------------------------------
create or replace view v_unassigned_implementers as
  select
    p.id as user_id,
    p.full_name,
    p.base_role,
    (select count(*) from site_assignments sa
      where sa.user_id = p.id and sa.deleted_at is null
        and sa.span @> current_date) = 0            as missing_site,
    (select count(*) from user_domains ud
      where ud.user_id = p.id and ud.deleted_at is null) = 0 as missing_domain,
    app.primary_mentor_of(p.id) is null             as missing_mentor
  from profiles p
  where p.deleted_at is null
    and p.status = 'active'
    and p.base_role in ('implementer', 'lead');

-- הרשאות: ה-views נוצרו אחרי ה-REVOKE הגורף ב-0012, ולכן נשללות במפורש.
revoke all on v_team_schedule, v_live_permission_grants, v_unassigned_implementers
  from anon, authenticated;
