import { Router } from 'express';
import { query } from '../lib/db.js';

/**
 * נתיבי פיתוח — מותקנים רק כש-AUTH_MODE=local (ראה app.js).
 *
 * מחוץ ל-/api בכוונה: הם אינם חלק מהחוזה של המערכת, ובייצור הם פשוט
 * אינם קיימים — לא חסומים, אלא לא נרשמו כלל.
 */
export const devRouter = Router();

/** רשימת המשתמשים למסך "כניסה כ..." */
devRouter.get('/users', async (_req, res) => {
  const users = await query(
    `select p.id, p.full_name, p.email, p.base_role::text as base_role,
            coalesce((select string_agg(s.name, ', ' order by s.name)
                        from site_assignments sa join sites s on s.id = sa.site_id
                       where sa.user_id = p.id and sa.deleted_at is null
                         and sa.span @> current_date), '') as sites
       from profiles p
      where p.deleted_at is null and p.status = 'active'
      order by array_position(array['manager','mentor','lead','implementer'], p.base_role::text),
               p.full_name`,
  );
  res.json({ authMode: 'local', users });
});
