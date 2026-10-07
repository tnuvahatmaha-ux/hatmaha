import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/requireAuth.js';
import { validate } from '../middleware/validate.js';
import { withIdempotency } from '../lib/idempotency.js';
import { withTransaction, query } from '../lib/db.js';
import { decideException, canDecide } from '../rules/exceptions.js';
import { AppError } from '../lib/errors.js';
import { uuid, idParam } from '../schemas/common.schema.js';

export const exceptionsRouter = Router();
exceptionsRouter.use(requireAuth);

const LIST_SQL = `
  select e.id, e.subject_type, e.subject_id, e.severity, e.summary, e.reason,
         e.status::text as status, e.created_at, e.decided_at, e.decision_comment,
         e.expires_at, e.approver_user_id, e.approver_role::text as approver_role,
         r.name as rule_name, r.condition_type_code,
         requester.full_name as requested_by_name,
         target.full_name as target_name,
         approver.full_name as approver_name,
         s.name as site_name
    from exception_requests e
    left join rules r on r.id = e.rule_id
    left join profiles requester on requester.id = e.requested_by
    left join profiles target on target.id = e.target_user_id
    left join profiles approver on approver.id = e.approver_user_id
    left join sites s on s.id = e.site_id
   where e.deleted_at is null`;

/**
 * תור האישורים.
 * mine=true מחזיר רק את מה שאני באמת יכול להכריע בו — זה מה שמופיע
 * במסך "בקשות ואישורים" של המנהל ושל המדריך.
 */
exceptionsRouter.get(
  '/',
  validate({
    query: z.object({
      status: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired']).optional(),
      mine: z.coerce.boolean().default(false),
      siteId: uuid.optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
  }),
  async (req, res) => {
    const { status, mine, siteId, limit } = req.validQuery;
    const isManager = req.user.baseRole === 'manager';

    const rows = await query(
      `${LIST_SQL}
         and ($1::text is null or e.status::text = $1)
         and ($2::uuid is null or e.site_id = $2)
         and (
              $3                                          -- מנהל רואה הכל
           or e.approver_user_id = $4                     -- אני המאשר
           or e.requested_by = $4                         -- אני הגשתי
           or e.target_user_id = $4                       -- הבקשה עליי
           or e.target_user_id = any($5::uuid[])          -- מטמיע שמשויך אליי
         )
         and (not $6 or (e.status = 'pending' and ($3 or e.approver_user_id = $4)))
       order by e.status = 'pending' desc, e.created_at desc
       limit $7`,
      [status ?? null, siteId ?? null, isManager, req.user.userId,
       req.user.scopes.assignedUserIds, mine, limit],
    );
    res.json({ exceptions: rows });
  },
);

exceptionsRouter.get(
  '/:id',
  validate({ params: idParam }),
  async (req, res) => {
    const [row] = await query(`${LIST_SQL} and e.id = $1`, [req.params.id]);
    if (!row) throw new AppError('E_NOT_FOUND', 'החריגה המבוקשת לא נמצאה');

    // ההערכה המלאה, כולל צילום החוקים כפי שהיו — כך ההחלטה ניתנת להסבר
    const [evaluation] = await query(
      `select id, trigger::text, outcome::text, results, rules_snapshot, context, created_at
         from rule_evaluations where id = (select rule_evaluation_id from exception_requests where id = $1)`,
      [req.params.id],
    );

    res.json({ exception: row, evaluation, canDecide: await canDecide(req.user, row) });
  },
);

/**
 * הכרעה. נימוק חובה. באישור — הפעולה שחנתה ב-pending_action מבוצעת עכשיו,
 * אחרי בדיקה חוזרת שהיא עדיין חוקית.
 */
exceptionsRouter.post(
  '/:id/decision',
  validate({
    params: idParam,
    body: z.object({
      decision: z.enum(['approve', 'reject']),
      comment: z.string().trim().min(3, 'החלטה מחייבת נימוק של 3 תווים לפחות').max(1000),
    }),
  }),
  async (req, res) => {
    const result = await withIdempotency(req, 'exceptions.decision', async () => {
      const body = await withTransaction(
        { actorId: req.user.userId, traceId: req.traceId },
        async (tx) => {
          const row = await tx.one('select * from exception_requests where id = $1', [req.params.id]);
          if (!row) throw new AppError('E_NOT_FOUND', 'החריגה המבוקשת לא נמצאה');

          if (!(await canDecide(req.user, row))) {
            throw new AppError(
              'E_FORBIDDEN',
              row.status === 'pending'
                ? 'אינך מוגדר/ת כמאשר/ת לחריגה הזו'
                : 'החריגה כבר הוכרעה',
            );
          }

          return decideException(tx, {
            exceptionId: req.params.id,
            approverId: req.user.userId,
            decision: req.body.decision,
            comment: req.body.comment,
            traceId: req.traceId,
          });
        },
      );
      return { status: 200, body };
    });
    res.status(result.status).json(result.body);
  },
);
