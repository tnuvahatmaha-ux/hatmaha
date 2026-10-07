import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { requirePermission } from '../middleware/requirePermission.js';
import { validate } from '../middleware/validate.js';
import { query, withTransaction } from '../lib/db.js';
import { markRead } from '../notifications/service.js';
import { idParam } from '../schemas/common.schema.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

notificationsRouter.get(
  '/',
  validate({
    query: z.object({
      unreadOnly: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
  }),
  async (req, res) => {
    const { unreadOnly, limit } = req.validQuery;
    const [notifications, [counts]] = await Promise.all([
      query(
        `select n.id, n.type_code, n.title, n.body, n.payload, n.entity_type, n.entity_id,
                n.channel, n.delivery_status, n.read_at, n.created_at, n.last_error,
                nt.name_he as type_name
           from notifications n
           join notification_types nt on nt.code = n.type_code
          where n.recipient_user_id = $1 and n.channel = 'inapp'
            and (not $2 or n.read_at is null)
          order by n.created_at desc
          limit $3`,
        [req.user.userId, unreadOnly, limit],
      ),
      query(
        `select count(*) filter (where read_at is null)::int as unread,
                count(*)::int as total
           from notifications where recipient_user_id = $1 and channel = 'inapp'`,
        [req.user.userId],
      ),
    ]);
    res.json({ notifications, ...counts });
  },
);

notificationsRouter.post(
  '/:id/read',
  validate({ params: idParam }),
  async (req, res) => {
    const count = await withTransaction({ actorId: req.user.userId }, (tx) =>
      markRead(tx, { userId: req.user.userId, notificationId: req.params.id }),
    );
    res.json({ marked: count });
  },
);

notificationsRouter.post('/read-all', async (req, res) => {
  const count = await withTransaction({ actorId: req.user.userId }, (tx) =>
    markRead(tx, { userId: req.user.userId }),
  );
  res.json({ marked: count });
});

notificationsRouter.get(
  '/preferences',
  async (req, res) => {
    const rows = await query(
      `select nt.code, nt.name_he, nt.default_inapp, nt.default_email,
              coalesce(np.inapp, nt.default_inapp) as inapp,
              coalesce(np.email, nt.default_email) as email
         from notification_types nt
         left join notification_preferences np
                on np.type_code = nt.code and np.user_id = $1
        where nt.is_active order by nt.display_order`,
      [req.user.userId],
    );
    res.json({ preferences: rows });
  },
);

notificationsRouter.put(
  '/preferences',
  validate({
    body: z.object({
      preferences: z.array(
        z.object({ typeCode: z.string().max(64), inapp: z.boolean(), email: z.boolean() }),
      ).max(50),
    }),
  }),
  async (req, res) => {
    await withTransaction({ actorId: req.user.userId }, async (tx) => {
      for (const p of req.body.preferences) {
        await tx.query(
          `insert into notification_preferences (user_id, type_code, inapp, email)
           values ($1, $2, $3, $4)
           on conflict (user_id, type_code)
           do update set inapp = excluded.inapp, email = excluded.email`,
          [req.user.userId, p.typeCode, p.inapp, p.email],
        );
      }
    });
    res.json({ updated: req.body.preferences.length });
  },
);

/** סטטוס מסירה — למנהל, כדי לראות מה נכשל ולמה */
notificationsRouter.get(
  '/delivery-status',
  requirePermission('reports', 'view'),
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) }) }),
  async (req, res) => {
    const rows = await query(
      `select n.id, n.type_code, n.channel, n.delivery_status, n.attempts, n.last_error,
              n.created_at, n.sent_at, p.full_name as recipient_name, p.email
         from notifications n join profiles p on p.id = n.recipient_user_id
        where n.delivery_status in ('failed', 'pending')
        order by n.created_at desc limit $1`,
      [req.validQuery.limit],
    );
    res.json({ notifications: rows });
  },
);
