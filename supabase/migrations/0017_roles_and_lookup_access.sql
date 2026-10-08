-- =============================================================================
-- 0017 — מדריך שמגיש בעצמו, ואתרים שהמדריך רואה
--
-- למדריך לא היו requests.create ו-availability.create, ולכן "בקשת חופשה או
-- אילוץ" החזירה לו "אין לך הרשאה". גם למדריך יש משמרות, חופשות ואילוצים
-- משלו. בנוסף מקבל המדריך sites.view על האתרים שבאחריותו, כדי שבורר האתר
-- בלו״ז הצוות לא יישאר ריק.
--
-- קריאת הקטלוגים (סוגי אילוץ, סוגי פעילות, תחומים) נפתחה בשרת לכל משתמש
-- מחובר — אלה נתוני עזר לטפסים, לא הגדרות רגישות.
-- =============================================================================

insert into role_permissions (role, permission_id, effect, scope_type)
select rp.role, p.id, 'allow', rp.scope::scope_type
  from (values
        ('mentor'::base_role,'requests','create','own_data'),
        ('mentor','requests','edit','own_data'),
        ('mentor','requests','delete','own_data'),
        ('mentor','requests','view','own_data'),
        ('mentor','availability','create','own_data'),
        ('mentor','availability','edit','own_data'),
        ('mentor','availability','delete','own_data'),
        ('mentor','availability','view','own_data'),
        ('mentor','roster','view','own_data'),
        ('mentor','activities','view','own_data'),
        ('mentor','sites','view','site'),
        ('lead','sites','view','site'),
        ('implementer','sites','view','site')
       ) as rp(role, resource, action, scope)
  join permissions p
    on p.resource = rp.resource
   and p.action   = rp.action::perm_action
on conflict do nothing;
