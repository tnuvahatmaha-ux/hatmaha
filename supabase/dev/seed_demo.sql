-- =============================================================================
-- נתוני דמו לפיתוח מקומי — מצב AUTH_MODE=local בלבד.
--
-- ⚠ לא מיגרציה, ולעולם לא מורץ על פרויקט Supabase אמיתי.
--   הקובץ יוצר משתמשים ישירות ב-auth.users, מה שאסור ב-Supabase, ולכן הוא
--   בודק בתחילתו שהוא רץ מול החיקוי המקומי ועוצר אם לא.
--
-- כל התאריכים יחסיים להיום, כך שהדמו תמיד "עכשווי": יש סידור שפורסם
-- לשבוע הנוכחי, טיוטה לשבוע הבא, בקשות ממתינות וחריגה בתור.
-- =============================================================================

do $$
begin
  -- ב-Supabase אמיתי לטבלה auth.users יש עמודת aud; בחיקוי המקומי אין
  if exists (select 1 from information_schema.columns
              where table_schema = 'auth' and table_name = 'users' and column_name = 'aud') then
    raise exception 'SEED_LOCAL_ONLY: נתוני הדמו מיועדים ל-Postgres מקומי בלבד, לא לפרויקט Supabase';
  end if;
  if exists (select 1 from profiles) then
    raise exception 'SEED_NOT_EMPTY: במסד כבר יש משתמשים. לאיפוס: npm run db:reset';
  end if;
end $$;

do $$
declare
  -- משתמשים — מזהים קבועים, כדי שמסך "כניסה כ..." יישאר יציב בין איפוסים
  u_mgr    uuid := '00000000-0000-4000-8000-000000000001';
  u_yossi  uuid := '00000000-0000-4000-8000-000000000002';
  u_michal uuid := '00000000-0000-4000-8000-000000000003';
  u_ori    uuid := '00000000-0000-4000-8000-000000000004';
  u_noa    uuid := '00000000-0000-4000-8000-000000000005';
  u_itay   uuid := '00000000-0000-4000-8000-000000000006';
  u_shira  uuid := '00000000-0000-4000-8000-000000000007';
  u_omer   uuid := '00000000-0000-4000-8000-000000000008';

  tz text := 'Asia/Jerusalem';
  today date := current_date;
  ws date := current_date - extract(dow from current_date)::int;   -- ראשון של השבוע
  nws date;

  d_clin uuid; d_admin uuid;
  sc_nurse uuid; sc_doc uuid; sc_admit uuid; sc_fin uuid;
  s_north uuid; s_center uuid;
  -- משמרות לפי מיקום: לכל מיקום שעות משלו
  st_m uuid; st_e uuid; st_n uuid;        -- מחלקה פנימית: 07–15 · 15–23 · 23–07
  st_er_d uuid; st_er_n uuid;             -- חדר מיון: 07–19 · 19–07 (משמרות של 12 שעות)
  st_tr uuid;                             -- חדר הדרכה: 08–16
  st_day uuid; st_aft uuid;               -- אגף מנהלה: 08–16 · 16–20
  l_ward uuid; l_er uuid; l_train uuid; l_admin uuid;
  at_train uuid; at_obs uuid; at_prac uuid;
  ct_vac uuid; ct_hours uuid; ct_sick uuid;
  ts_intake uuid; ts_training uuid; ts_ready uuid;
  ql_cert uuid;
  a_id uuid; v_pub uuid; v_draft uuid; decl uuid; cr uuid; ev uuid;
  tr uuid; ti1 uuid; ti2 uuid; ti3 uuid; ti4 uuid;
  i int;
begin
  nws := ws + 7;

  -- ── משתמשים. הטריגר על auth.users יוצר את הפרופיל; הראשון נהיה מנהל ──
  insert into auth.users (id, email, raw_user_meta_data) values
    (u_mgr,    'dana@demo.local',   '{"full_name":"דנה כהן"}'),
    (u_yossi,  'yossi@demo.local',  '{"full_name":"יוסי לוי"}'),
    (u_michal, 'michal@demo.local', '{"full_name":"מיכל אברהם"}'),
    (u_ori,    'ori@demo.local',    '{"full_name":"אורי ביטון"}'),
    (u_noa,    'noa@demo.local',    '{"full_name":"נועה פרץ"}'),
    (u_itay,   'itay@demo.local',   '{"full_name":"איתי מזרחי"}'),
    (u_shira,  'shira@demo.local',  '{"full_name":"שירה גולן"}'),
    (u_omer,   'omer@demo.local',   '{"full_name":"עומר דהן"}');

  -- מכאן כל שורה נרשמת ביומן הביקורת כפעולה של המנהלת
  perform set_config('app.actor_id', u_mgr::text, true);

  update profiles set base_role = 'mentor' where id in (u_yossi, u_michal);
  update profiles set base_role = 'lead' where id = u_ori;
  update profiles set phone = '050-1111111' where id = u_mgr;
  update profiles set phone = '050-2222222' where id = u_yossi;
  update profiles set phone = '050-3333333' where id = u_michal;
  update profiles set phone = '050-5555555', intake_date = today - 30 where id = u_noa;

  -- ── קטלוגים ──
  select id into at_train from activity_types where code = 'train_implementers';
  select id into at_obs   from activity_types where code = 'observation_target';
  select id into at_prac  from activity_types where code = 'practice';
  select id into ct_vac   from constraint_types where code = 'vacation';
  select id into ct_hours from constraint_types where code = 'hours';
  select id into ct_sick  from constraint_types where code = 'sick';
  select id into ts_intake   from training_statuses where code = 'intake';
  select id into ts_training from training_statuses where code = 'in_training';
  select id into ts_ready    from training_statuses where code = 'ready';
  select id into ql_cert from qualification_levels where code = 'certified';

  -- ── תחומים ──
  insert into domains (name, display_order) values ('מערכות קליניות', 10) returning id into d_clin;
  insert into domains (name, display_order) values ('מערכות מנהלה', 20) returning id into d_admin;
  insert into sub_categories (domain_id, name) values (d_clin, 'סיעוד') returning id into sc_nurse;
  insert into sub_categories (domain_id, name) values (d_clin, 'רופאים') returning id into sc_doc;
  insert into sub_categories (domain_id, name) values (d_admin, 'קבלת חולים') returning id into sc_admit;
  insert into sub_categories (domain_id, name) values (d_admin, 'כספים') returning id into sc_fin;

  -- ── אתרים. צפון פעיל מסביב לשעון, ולכן יש בו משמרת לילה ──
  insert into sites (name, description, status_id, go_live_date, open_time, close_time,
                     availability_deadline_weekday, availability_deadline_hour)
  values ('מרכז רפואי צפון', 'בית חולים כללי, 450 מיטות',
          (select id from site_statuses where code = 'training'),
          today + 30, '00:00', '23:59', 4, 12)
  returning id into s_north;

  insert into sites (name, description, status_id, go_live_date, open_time, close_time)
  values ('בית חולים מרכז', 'מרכז רפואי עירוני',
          (select id from site_statuses where code = 'training'),
          today + 45, '08:00', '20:00')
  returning id into s_center;

  insert into site_periods (site_id, period, name, starts_on, ends_on) values
    (s_north, 'training', 'הכשרה', today - 30, today + 29),
    (s_north, 'golive', 'עלייה לאוויר', today + 30, today + 60),
    (s_center, 'training', 'הכשרה', today - 10, today + 44);

  insert into locations (site_id, name, description) values (s_north, 'מחלקה פנימית א׳', 'קומה 3') returning id into l_ward;
  insert into locations (site_id, name, description) values (s_north, 'חדר מיון', 'קומת קרקע') returning id into l_er;
  insert into locations (site_id, name, description) values (s_north, 'חדר הדרכה', 'אגף הדרכה') returning id into l_train;
  insert into locations (site_id, name, description) values (s_center, 'אגף מנהלה', null) returning id into l_admin;

  -- ── משמרות — לכל מיקום השעות שלו ──
  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_ward, 'בוקר', '07:00', '15:00', true, 2, d_clin, 10) returning id into st_m;
  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_ward, 'ערב', '15:00', '23:00', true, 1, d_clin, 20) returning id into st_e;
  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_ward, 'לילה', '23:00', '07:00', false, 1, d_clin, 30) returning id into st_n;

  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_er, 'יום', '07:00', '19:00', true, 1, d_clin, 10) returning id into st_er_d;
  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_er, 'לילה', '19:00', '07:00', false, 1, d_clin, 20) returning id into st_er_n;

  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_train, 'הדרכה', '08:00', '16:00', false, 1, d_clin, 10) returning id into st_tr;

  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_admin, 'יום', '08:00', '16:00', true, 2, d_admin, 10) returning id into st_day;
  insert into shift_types (location_id, name, start_time, end_time, is_mandatory, required_staff, domain_id, display_order)
  values (l_admin, 'אחה״צ', '16:00', '20:00', false, 1, d_admin, 20) returning id into st_aft;

  -- כללי אישור האילוצים גנריים (constraint_types.approval_mode):
  -- מחלה = אישור אוטומטי, כל השאר דורש אישור — חל על כל האתרים

  -- ── שיוכים ──
  insert into site_assignments (site_id, user_id, assignment_role) values
    (s_north, u_yossi, 'implementer'),
    (s_north, u_ori, 'lead'),
    (s_north, u_noa, 'implementer'),
    (s_north, u_itay, 'implementer'),
    (s_center, u_michal, 'implementer'),
    (s_center, u_shira, 'implementer'),
    (s_center, u_omer, 'implementer');

  insert into user_domains (user_id, domain_id, is_primary) values
    (u_yossi, d_clin, true), (u_ori, d_clin, true), (u_noa, d_clin, true), (u_itay, d_clin, true),
    (u_michal, d_admin, true), (u_shira, d_admin, true), (u_omer, d_admin, true);

  insert into user_sub_categories (user_id, sub_category_id) values
    (u_ori, sc_nurse), (u_noa, sc_nurse), (u_itay, sc_doc),
    (u_shira, sc_admit), (u_omer, sc_fin);

  insert into qualifications (user_id, sub_category_id, level_id, certified_by) values
    (u_ori, sc_nurse, ql_cert, u_mgr), (u_noa, sc_nurse, ql_cert, u_yossi),
    (u_shira, sc_admit, ql_cert, u_michal);

  update profiles set training_status_id = ts_ready    where id = u_ori;
  update profiles set training_status_id = ts_training where id in (u_noa, u_shira);
  update profiles set training_status_id = ts_intake   where id in (u_itay, u_omer);

  insert into mentor_responsibilities (mentor_user_id, site_id, domain_id, from_date) values
    (u_yossi, s_north, d_clin, today - 30),
    (u_michal, s_center, d_admin, today - 30);

  insert into mentor_assignments (mentor_user_id, implementer_user_id, is_primary, from_date) values
    (u_yossi, u_noa, true, today - 30), (u_yossi, u_itay, true, today - 30), (u_yossi, u_ori, true, today - 30),
    (u_michal, u_shira, true, today - 30), (u_michal, u_omer, true, today - 30);

  -- ── מסלול הכשרה ──
  insert into training_tracks (name, domain_id, is_default) values ('מסלול מטמיע קליני', d_clin, true) returning id into tr;
  insert into training_track_items (track_id, display_order, title, activity_type_id) values (tr, 1, 'הדרכת מבוא למערכת', at_train) returning id into ti1;
  insert into training_track_items (track_id, display_order, title, activity_type_id) values (tr, 2, 'תרגול תרחישים', at_prac) returning id into ti2;
  insert into training_track_items (track_id, display_order, title, activity_type_id) values (tr, 3, 'תצפית בשטח', at_obs) returning id into ti3;
  insert into training_track_items (track_id, display_order, title) values (tr, 4, 'מבחן כשירות') returning id into ti4;

  insert into user_training_items (user_id, track_item_id, status_id, completed_on) values
    (u_ori, ti1, ts_ready, today - 25), (u_ori, ti2, ts_ready, today - 20), (u_ori, ti3, ts_ready, today - 15), (u_ori, ti4, ts_ready, today - 10),
    (u_noa, ti1, ts_training, today - 20), (u_noa, ti2, ts_training, today - 12), (u_noa, ti3, ts_training, null), (u_noa, ti4, ts_training, null),
    (u_itay, ti1, ts_intake, null), (u_itay, ti2, ts_intake, null), (u_itay, ti3, ts_intake, null), (u_itay, ti4, ts_intake, null);

  -- ── פעילויות ──
  -- הדרכה שהושלמה בעבר — מזינה את חוק "הדרכת חובה הושלמה"
  insert into activities (site_id, location_id, activity_type_id, title, activity_date, start_time, end_time,
                          starts_at, ends_at, audience, status, owner_user_id, domain_id, prep_done)
  values (s_north, l_train, at_train, 'הדרכת חובה — אבטחת מידע', today - 5, '09:00', '12:00',
          ((today - 5) + time '09:00') at time zone tz, ((today - 5) + time '12:00') at time zone tz,
          'domain', 'completed', u_yossi, d_clin, true)
  returning id into a_id;
  insert into activity_audience (activity_id, audience, target_id) values (a_id, 'domain', d_clin);
  insert into activity_participants (activity_id, user_id, attendance) values
    (a_id, u_noa, 'attended'), (a_id, u_ori, 'attended');

  -- היום, ומחר — הכנה עוד לא סומנה, ולכן תופיע כמטלה אצל יוסי
  insert into activities (site_id, location_id, activity_type_id, title, activity_date, start_time, end_time,
                          starts_at, ends_at, audience, owner_user_id, domain_id)
  values (s_north, l_train, at_train, 'הדרכת מודול סיעוד', today, '10:00', '12:00',
          (today + time '10:00') at time zone tz, (today + time '12:00') at time zone tz,
          'users', u_yossi, d_clin)
  returning id into a_id;
  insert into activity_audience (activity_id, audience, target_id) values (a_id, 'users', u_noa), (a_id, 'users', u_itay);
  insert into activity_participants (activity_id, user_id) values (a_id, u_noa), (a_id, u_itay);

  insert into activities (site_id, location_id, activity_type_id, title, activity_date, start_time, end_time,
                          starts_at, ends_at, audience, owner_user_id, domain_id)
  values (s_north, l_ward, at_obs, 'תצפית במחלקה פנימית', today + 1, '16:00', '18:00',
          ((today + 1) + time '16:00') at time zone tz, ((today + 1) + time '18:00') at time zone tz,
          'users', u_yossi, d_clin)
  returning id into a_id;
  insert into activity_audience (activity_id, audience, target_id) values (a_id, 'users', u_noa);
  insert into activity_participants (activity_id, user_id) values (a_id, u_noa);

  insert into activities (site_id, location_id, activity_type_id, title, activity_date, start_time, end_time,
                          starts_at, ends_at, audience, owner_user_id, domain_id)
  values (s_center, l_admin, at_prac, 'תרגול קבלת חולים', today + 2, '09:00', '11:00',
          ((today + 2) + time '09:00') at time zone tz, ((today + 2) + time '11:00') at time zone tz,
          'domain', u_michal, d_admin)
  returning id into a_id;
  insert into activity_audience (activity_id, audience, target_id) values (a_id, 'domain', d_admin);
  insert into activity_participants (activity_id, user_id) values (a_id, u_shira), (a_id, u_omer);

  -- ── סידור שפורסם לשבוע הנוכחי בצפון ──
  -- נוצר כטיוטה, השיבוצים נכנסים, ואז מפורסם — הטריגר מתיר שינוי רק בטיוטה
  insert into roster_versions (site_id, week_start, version_number, status)
  values (s_north, ws, 1, 'draft') returning id into v_pub;

  for i in 0..6 loop
    insert into roster_assignments (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
                                    start_time, end_time, starts_at, ends_at, domain_id)
    values
      (v_pub, s_north, ws + i, l_ward, case when i % 2 = 0 then u_noa else u_ori end, st_m, '07:00', '15:00',
       ((ws + i) + time '07:00') at time zone tz, ((ws + i) + time '15:00') at time zone tz, d_clin),
      (v_pub, s_north, ws + i, l_ward, case when i % 2 = 0 then u_ori else u_noa end, st_e, '15:00', '23:00',
       ((ws + i) + time '15:00') at time zone tz, ((ws + i) + time '23:00') at time zone tz, d_clin);
  end loop;

  -- לילה אחד — חוצה חצות, מסתיים ב-07:00 של היום שאחריו
  insert into roster_assignments (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
                                  start_time, end_time, starts_at, ends_at, domain_id)
  values (v_pub, s_north, ws + 2, l_er, u_itay, st_er_n, '19:00', '07:00',
          ((ws + 2) + time '19:00') at time zone tz, ((ws + 3) + time '07:00') at time zone tz, d_clin);

  update roster_versions
     set status = 'published', published_at = now() - interval '3 days', published_by = u_mgr,
         publish_note = 'גרסה ראשונה לשבוע',
         published_snapshot = jsonb_build_object('version', 1, 'weekStart', ws, 'seed', true)
   where id = v_pub;

  -- טיוטה לשבוע הבא, עם כמה שיבוצים — ממשיכים מכאן במסך "בונה סידור"
  insert into roster_versions (site_id, week_start, version_number, status)
  values (s_north, nws, 1, 'draft') returning id into v_draft;
  insert into roster_assignments (version_id, site_id, assignment_date, location_id, user_id, shift_type_id,
                                  start_time, end_time, starts_at, ends_at, domain_id)
  values
    (v_draft, s_north, nws, l_ward, u_noa, st_m, '07:00', '15:00',
     (nws + time '07:00') at time zone tz, (nws + time '15:00') at time zone tz, d_clin),
    (v_draft, s_north, nws, l_ward, u_ori, st_e, '15:00', '23:00',
     (nws + time '15:00') at time zone tz, (nws + time '23:00') at time zone tz, d_clin);

  -- ── זמינות לשבוע הבא ──
  -- נועה: הגשה תקינה
  insert into availability_declarations (user_id, site_id, week_start, status, submitted_at,
                                         max_cannot_snapshot, max_prefer_not_snapshot)
  values (u_noa, s_north, nws, 'ok', now() - interval '1 day', 3, 4) returning id into decl;
  insert into availability_cells (declaration_id, cell_date, start_time, end_time, value) values
    (decl, nws + 2, '23:00', '07:00', 'cannot'), (decl, nws + 4, '15:00', '23:00', 'prefer_not');

  -- איתי: סימן "לא יכול" על משמרת חובה, ולכן ממתין לאישור מיוחד
  insert into availability_declarations (user_id, site_id, week_start, status, submitted_at,
                                         max_cannot_snapshot, max_prefer_not_snapshot)
  values (u_itay, s_north, nws, 'pending_approval', now() - interval '5 hours', 3, 4) returning id into decl;
  insert into availability_cells (declaration_id, cell_date, start_time, end_time, value) values
    (decl, nws + 1, '07:00', '15:00', 'cannot'), (decl, nws + 3, '07:00', '15:00', 'cannot');
  insert into availability_violations (declaration_id, kind, cell_date, start_time, end_time, detail) values
    (decl, 'mandatory_cannot', nws + 1, '07:00', '15:00', '{"shiftName":"בוקר","message":"סומן \"לא יכול\" במשמרת חובה בוקר 07:00–15:00"}'),
    (decl, 'mandatory_cannot', nws + 3, '07:00', '15:00', '{"shiftName":"בוקר","message":"סומן \"לא יכול\" במשמרת חובה בוקר 07:00–15:00"}');

  -- ── בקשות אילוץ ──
  insert into constraint_requests (user_id, site_id, constraint_type_id, constraint_date, start_time, end_time,
                                   starts_at, ends_at, note, status, submitted_at, decided_at, approver_user_id, decision_note)
  values (u_noa, s_north, ct_vac, today + 20, '00:00', '23:59',
          ((today + 20) + time '00:00') at time zone tz, ((today + 20) + time '23:59') at time zone tz,
          'חתונה של אחי', 'approved', now() - interval '4 days', now() - interval '3 days', u_mgr, 'מאושר, בהצלחה');

  insert into constraint_requests (user_id, site_id, constraint_type_id, constraint_date, start_time, end_time,
                                   starts_at, ends_at, note, status, submitted_at)
  values (u_ori, s_north, ct_hours, today + 10, '14:00', '23:59',
          ((today + 10) + time '14:00') at time zone tz, ((today + 10) + time '23:59') at time zone tz,
          'לימודים בערב', 'submitted', now() - interval '2 hours');

  -- עומר: בקשה להודעה קצרה מדי — יצרה חריגה שממתינה למדריכה מיכל
  insert into constraint_requests (user_id, site_id, constraint_type_id, constraint_date, start_time, end_time,
                                   starts_at, ends_at, note, status, submitted_at)
  values (u_omer, s_center, ct_vac, today + 1, '00:00', '23:59',
          ((today + 1) + time '00:00') at time zone tz, ((today + 1) + time '23:59') at time zone tz,
          'אירוע משפחתי שנקבע ברגע האחרון', 'submitted', now() - interval '1 hour')
  returning id into cr;

  insert into rule_evaluations (trigger, subject_type, subject_id, actor_user_id, target_user_id, site_id,
                                context, rules_snapshot, results, outcome)
  values ('submit', 'constraint', cr, u_omer, u_omer, s_center, '{}',
          (select jsonb_agg(jsonb_build_object('id', id, 'name', name)) from rules where name = 'הודעה מוקדמת של 3 ימים'),
          '[{"name":"הודעה מוקדמת של 3 ימים","severity":"approval_required","passed":false,"message":"הבקשה הוגשה בפחות מ-3 ימי הודעה מוקדמת — הודעה מוקדמת של 1 ימים בלבד, נדרשים 3"}]',
          'approval_required')
  returning id into ev;

  insert into exception_requests (rule_evaluation_id, rule_id, subject_type, subject_id, requested_by, target_user_id,
                                  site_id, domain_id, summary, reason, pending_action, approver_user_id, approver_role, expires_at)
  values (ev, (select id from rules where name = 'הודעה מוקדמת של 3 ימים'), 'constraint', cr, u_omer, u_omer,
          s_center, d_admin, 'בקשת חופשה של עומר דהן',
          'הבקשה הוגשה בפחות מ-3 ימי הודעה מוקדמת — הודעה מוקדמת של 1 ימים בלבד, נדרשים 3',
          jsonb_build_object(
            'type', 'requests.finalize',
            'payload', jsonb_build_object('requestId', cr, 'policy', 'manager'),
            'ctx', jsonb_build_object('trigger', 'submit', 'subjectType', 'constraint', 'subjectId', cr,
                                      'targetUserId', u_omer, 'siteId', s_center,
                                      'startsAt', ((today + 1) + time '00:00') at time zone tz,
                                      'endsAt', ((today + 1) + time '23:59') at time zone tz)),
          u_michal, 'mentor', now() + interval '14 days');

  -- ── התראות ──
  insert into notifications (recipient_user_id, type_code, title, body, delivery_status) values
    (u_noa, 'welcome', 'ברוכה הבאה לצוות ההטמעה', 'המדריך הראשי שלך: יוסי לוי', 'sent'),
    (u_noa, 'roster_published', 'פורסם סידור עבודה', 'מרכז רפואי צפון · גרסה 1', 'sent'),
    (u_noa, 'request_decided', 'הבקשה אושרה', 'חופשה — מאושר, בהצלחה', 'sent'),
    (u_michal, 'exception_raised', 'חריגה ממתינה לאישורך', 'בקשת חופשה של עומר דהן — הודעה מוקדמת קצרה', 'sent'),
    (u_mgr, 'request_submitted', 'הגשת זמינות שחורגת מהכללים', 'איתי מזרחי סימן "לא יכול" במשמרות חובה', 'sent');

  raise notice 'נתוני הדמו נטענו: 8 משתמשים, 2 אתרים, סידור שפורסם וטיוטה, בקשות וחריגה בתור';
end $$;
