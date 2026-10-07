import { Router } from 'express';
import { requireCronSecret } from '../middleware/requirePermission.js';
import { logger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { purgeIdempotencyKeys } from '../lib/idempotency.js';
import { expireGrants } from '../services/permissions.service.js';
import { expireExceptions } from '../services/requests.service.js';

/**
 * משימות מתוזמנות.
 *
 * ל-Render בחבילה החינמית אין מתזמן, והשירות נרדם אחרי כרבע שעה ללא
 * תנועה. פרויקט Supabase חינמי נעצר אחרי שבעה ימי חוסר פעילות.
 * הפתרון: פינגר חיצוני חינמי קורא לנתיבים האלה — הוא גם מריץ את
 * המשימות וגם משאיר את שני השירותים ערים. מתועד ב-DEPLOY.md.
 *
 * ההזדהות היא סוד משותף ולא טוקן משתמש, כי אין כאן אדם.
 */
export const internalRouter = Router();
internalRouter.use(requireCronSecret);

const JOBS = {
  /** הרשאות שפג תוקפן. המנוע מסנן על now() ממילא, אז זו בעיקר היגיינה. */
  'expire-grants': async () => ({ expired: await expireGrants() }),

  /** חריגות שאיש לא הכריע בהן בתוך חלון הזמן */
  'expire-exceptions': async () => ({ expired: await expireExceptions() }),

  /**
   * שליחת ההתראות שממתינות בתור.
   * ב-MVP התראות בתוך האפליקציה מסומנות כנשלחו מיד; שליחת דוא״ל דורשת
   * ספק SMTP, והחיבור אליו מתואר ב-DEPLOY.md.
   */
  'dispatch-notifications': async () => {
    const inapp = await query(
      `update notifications set delivery_status = 'sent', sent_at = now(), attempts = attempts + 1
        where delivery_status = 'pending' and channel = 'inapp'
        returning id`,
    );

    const emails = await query(
      `select count(*)::int as n from notifications
        where delivery_status = 'pending' and channel = 'email'`,
    );

    return { inappSent: inapp.length, emailsPending: emails[0].n };
  },

  /** פתיחת חלון הזמינות לשבוע הבא, עם התראה למי שטרם הגיש */
  'open-availability-window': async () => {
    const rows = await query(
      `insert into notifications (recipient_user_id, type_code, title, body, dedupe_key)
       select p.id, 'availability_window_open',
              'נפתחה הגשת זמינות לשבוע הבא',
              'ניתן להגיש זמינות דרך מסך "בקשות וזמינות"',
              'availability_window:' || p.id || ':' ||
                (date_trunc('week', current_date + 7) - interval '1 day')::date
         from profiles p
         join site_assignments sa on sa.user_id = p.id
              and sa.deleted_at is null and sa.span @> current_date
        where p.status = 'active' and p.deleted_at is null
          and p.base_role in ('implementer','lead')
       on conflict (dedupe_key) where dedupe_key is not null do nothing
       returning id`,
    );
    return { notified: rows.length };
  },

  /** ניקוי מפתחות אידמפוטנטיות ישנים */
  'purge-idempotency': async () => ({ removed: await purgeIdempotencyKeys(48) }),

  /** נגיעה במסד, כדי שפרויקט Supabase חינמי לא ייעצר */
  'keep-alive': async () => {
    const [row] = await query('select now() as at');
    return { at: row.at };
  },
};

internalRouter.post('/cron/:job', async (req, res) => {
  const job = JOBS[req.params.job];

  if (!job) {
    return res.status(404).json({
      error: { code: 'E_NOT_FOUND', message: `משימה לא מוכרת: ${req.params.job}` },
      available: Object.keys(JOBS),
    });
  }

  const started = Date.now();
  const result = await job();
  const ms = Date.now() - started;

  logger.info('משימה מתוזמנת הסתיימה', { job: req.params.job, ms, ...result });
  res.json({ job: req.params.job, ms, ...result });
});

/** מאפשר לפינגר לבדוק אילו משימות קיימות */
internalRouter.get('/cron', (_req, res) => res.json({ jobs: Object.keys(JOBS) }));
