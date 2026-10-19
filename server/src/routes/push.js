import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { query } from '../lib/db.js';
import { vapidKeys, sendPush } from '../notifications/push.js';

/**
 * רישום המכשיר להתראות לטלפון. כל הנתיבים פועלים על המשתמש המחובר בלבד.
 */
export const pushRouter = Router();
pushRouter.use(requireAuth);

pushRouter.get('/key', async (_req, res) => {
  const keys = await vapidKeys();
  res.json({ publicKey: keys.publicKey });
});

const subscription = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(1).max(500), auth: z.string().min(1).max(500) }),
});

pushRouter.post(
  '/subscribe',
  validate({ body: subscription }),
  async (req, res) => {
    const { endpoint, keys } = req.body;
    // אותו מכשיר שעבר משתמש — המנוי עובר איתו
    await query(
      `insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
       values ($1, $2, $3, $4, $5)
       on conflict (endpoint) do update
         set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
             user_agent = excluded.user_agent`,
      [req.user.userId, endpoint, keys.p256dh, keys.auth, req.get('user-agent')?.slice(0, 300) ?? null],
    );
    res.status(201).json({ ok: true });
  },
);

pushRouter.delete(
  '/subscribe',
  validate({ body: z.object({ endpoint: z.string().max(1000) }) }),
  async (req, res) => {
    await query('delete from push_subscriptions where user_id = $1 and endpoint = $2', [req.user.userId, req.body.endpoint]);
    res.json({ ok: true });
  },
);

/** התראת ניסיון למכשירים של המשתמש עצמו */
pushRouter.post('/test', async (req, res) => {
  await sendPush([req.user.userId], { title: 'המטמיעון', body: 'ההתראות לטלפון פועלות ✓', url: '/' });
  res.json({ ok: true });
});
