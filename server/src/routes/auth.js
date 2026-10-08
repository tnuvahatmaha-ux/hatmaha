import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth.js';
import { capabilities, effectiveMatrix } from '../permissions/engine.js';
import { loadPrincipal } from '../permissions/repository.js';
import { query, queryOne } from '../lib/db.js';

export const authRouter = Router();

authRouter.use(requireAuth);

/**
 * מי אני: פרופיל, תפקיד, שיוכים וה-Scope האפקטיבי.
 * זו הקריאה הראשונה שהלקוח עושה אחרי התחברות.
 */
authRouter.get('/me', async (req, res) => {
  const { userId } = req.user;

  const [profile, sites, domains, subCategories, mentors, trainingStatus] = await Promise.all([
    queryOne(
      `select p.id, p.full_name, p.email, p.phone, p.bio, p.base_role, p.status,
              p.timezone, p.intake_date, p.avatar_url, p.row_version,
              ts.code as training_status_code, ts.name_he as training_status_name
         from profiles p
         left join training_statuses ts on ts.id = p.training_status_id
        where p.id = $1`,
      [userId],
    ),
    query(
      `select s.id, s.name, sa.assignment_role, sa.from_date, sa.to_date,
              st.code as status_code, st.name_he as status_name, s.go_live_date
         from site_assignments sa
         join sites s on s.id = sa.site_id
         join site_statuses st on st.id = s.status_id
        where sa.user_id = $1 and sa.deleted_at is null and sa.span @> current_date
        order by s.name`,
      [userId],
    ),
    query(
      `select d.id, d.name, ud.is_primary
         from user_domains ud join domains d on d.id = ud.domain_id
        where ud.user_id = $1 and ud.deleted_at is null
        order by ud.is_primary desc, d.display_order, d.name`,
      [userId],
    ),
    query(
      `select sc.id, sc.name, sc.domain_id
         from user_sub_categories usc join sub_categories sc on sc.id = usc.sub_category_id
        where usc.user_id = $1 and usc.deleted_at is null
        order by sc.display_order, sc.name`,
      [userId],
    ),
    query(
      `select m.id, m.full_name, m.email, m.phone, ma.is_primary
         from mentor_assignments ma join profiles m on m.id = ma.mentor_user_id
        where ma.implementer_user_id = $1 and ma.deleted_at is null
          and ma.span @> current_date
        order by ma.is_primary desc, m.full_name`,
      [userId],
    ),
    Promise.resolve(null),
  ]);

  // §7: "שיוך חסר יוצג בבירור" — הלקוח מציג את זה בראש מסך הבית
  const missing = [];
  if (['implementer', 'lead'].includes(profile.base_role)) {
    if (sites.length === 0) missing.push('לא שויך אתר');
    if (domains.length === 0) missing.push('לא שויך תחום');
    if (!mentors.some((m) => m.is_primary)) missing.push('לא שויך מדריך ראשי');
  }

  res.json({
    profile,
    sites,
    domains,
    subCategories,
    mentors,
    missingAssignments: missing,
    // מנהל הטמעה אינו משובץ במשמרות, ולכן אינו מגיש זמינות או אילוצים לעצמו
    submitsAvailability: profile.base_role !== 'manager',
    scopes: req.user.scopes,
    trainingStatus,
  });
});

/**
 * ההרשאות האפקטיביות שלי.
 *
 * הלקוח משתמש בהן כדי להסתיר פריטי ניווט וכפתורים — אבל השרת בודק שוב
 * בכל בקשה. הסתרה בלקוח היא נוחות, לא אכיפה.
 */
authRouter.get('/effective-permissions', async (req, res) => {
  res.json({
    userId: req.user.userId,
    baseRole: req.user.baseRole,
    capabilities: capabilities(req.user),
    matrix: effectiveMatrix(req.user),
  });
});

/** רענון מפורש אחרי שינוי הרשאות, בלי להמתין לתפוגת הקאש */
authRouter.post('/refresh', async (req, res) => {
  const principal = await loadPrincipal(req.user.userId, { fresh: true });
  res.json({ capabilities: capabilities(principal) });
});
