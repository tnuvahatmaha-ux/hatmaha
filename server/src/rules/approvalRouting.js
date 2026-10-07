/**
 * ניתוב מאשר לחריגה.
 *
 * סדר ההכרעה, מהספציפי לכללי:
 *   1. מאשר מפורש על החוק עצמו.
 *   2. מטריצת המאשרים (§17: "לפי אתר, תחום וסוג חריגה") — השורה הספציפית ביותר.
 *   3. תפקיד המאשר שעל החוק, שנפתר לאדם קונקרטי.
 *   4. מנהל הטמעה, כברירת מחדל אחרונה.
 *
 * תמיד מוחזר אדם קונקרטי כשאפשר: חריגה שמנותבת ל"תפקיד" בלבד עלולה
 * להישאר בלי נמען, ואז היא תקועה בתור לנצח.
 */
export async function routeApprover(tx, rule, ctx) {
  // 1. מאשר מפורש על החוק
  if (rule?.approver_user_id) {
    return { userId: rule.approver_user_id, role: null, source: 'rule' };
  }

  // 2. מטריצת המאשרים — ככל שהשורה מגדירה יותר ממדים, כך היא קודמת
  const [row] = await tx.query(
    `select approver_user_id, approver_role::text, fallback_user_id
       from approval_matrix
      where is_active and deleted_at is null
        and valid_from <= now() and (valid_to is null or valid_to > now())
        and (site_id is null or site_id = $1::uuid)
        and (domain_id is null or domain_id = $2::uuid)
        and (condition_type_code is null or condition_type_code = $3)
        and (constraint_type_id is null or constraint_type_id = $4::uuid)
      order by ((site_id is not null)::int
              + (domain_id is not null)::int
              + (condition_type_code is not null)::int
              + (constraint_type_id is not null)::int) desc,
               priority asc
      limit 1`,
    [
      ctx.siteId ?? null,
      ctx.domainId ?? null,
      rule?.condition_type_code ?? null,
      ctx.constraintTypeId ?? null,
    ],
  );

  if (row?.approver_user_id) {
    return { userId: row.approver_user_id, role: null, source: 'matrix' };
  }

  const role = row?.approver_role ?? rule?.approver_role ?? 'manager';
  const resolved = await resolveRole(tx, role, ctx);

  if (resolved) return { userId: resolved, role, source: row ? 'matrix' : 'rule' };
  if (row?.fallback_user_id) return { userId: row.fallback_user_id, role, source: 'fallback' };

  // 4. ברירת מחדל אחרונה
  const manager = await resolveRole(tx, 'manager', ctx);
  return { userId: manager ?? null, role: 'manager', source: 'default' };
}

/** הופך תפקיד מאשר לאדם קונקרטי, בהקשר הנתון */
async function resolveRole(tx, role, ctx) {
  switch (role) {
    case 'mentor': {
      if (!ctx.targetUserId) return null;
      const [row] = await tx.query('select app.primary_mentor_of($1) as id', [ctx.targetUserId]);
      return row?.id ?? null;
    }

    case 'lead': {
      if (!ctx.siteId) return null;
      const [row] = await tx.query(
        `select p.id
           from site_assignments sa
           join profiles p on p.id = sa.user_id
          where sa.site_id = $1 and sa.assignment_role = 'lead'
            and sa.deleted_at is null and sa.span @> current_date
            and p.status = 'active' and p.deleted_at is null
            and ($2::uuid is null or p.id <> $2)
          order by p.full_name limit 1`,
        [ctx.siteId, ctx.targetUserId ?? null],
      );
      return row?.id ?? null;
    }

    case 'manager':
    default: {
      const [row] = await tx.query(
        `select id from profiles
          where base_role = 'manager' and status = 'active' and deleted_at is null
          order by created_at limit 1`,
      );
      return row?.id ?? null;
    }
  }
}

/** כל מי שרשאי להכריע בחריגה — המאשר עצמו, ומנהלי ההטמעה */
export async function approversFor(tx, exceptionRow) {
  const ids = new Set();
  if (exceptionRow.approver_user_id) ids.add(exceptionRow.approver_user_id);

  const managers = await tx.query(
    `select id from profiles
      where base_role = 'manager' and status = 'active' and deleted_at is null`,
  );
  managers.forEach((m) => ids.add(m.id));

  return [...ids];
}
