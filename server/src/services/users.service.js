import { query, withTransaction } from '../lib/db.js';
import { invalidatePrincipal } from '../permissions/repository.js';
import { assertIfMatch } from '../lib/etag.js';
import { AppError } from '../lib/errors.js';
import { evaluateAndExecute } from '../rules/exceptions.js';
import { registerAction } from '../rules/actions.js';
import { notify } from '../notifications/service.js';

const PERSON_SELECT = `
  select p.id, p.full_name, p.email, p.phone, p.bio, p.base_role::text as base_role,
         p.status::text as status, p.intake_date, p.notes, p.row_version, p.created_at,
         ts.code as training_status_code, ts.name_he as training_status_name,
         coalesce((select json_agg(json_build_object('id', s.id, 'name', s.name,
                    'role', sa.assignment_role))
                     from site_assignments sa join sites s on s.id = sa.site_id
                    where sa.user_id = p.id and sa.deleted_at is null
                      and sa.span @> current_date), '[]') as sites,
         coalesce((select json_agg(json_build_object('id', d.id, 'name', d.name,
                    'isPrimary', ud.is_primary))
                     from user_domains ud join domains d on d.id = ud.domain_id
                    where ud.user_id = p.id and ud.deleted_at is null), '[]') as domains,
         coalesce((select json_agg(json_build_object('id', sc.id, 'name', sc.name))
                     from user_sub_categories usc join sub_categories sc on sc.id = usc.sub_category_id
                    where usc.user_id = p.id and usc.deleted_at is null), '[]') as sub_categories,
         coalesce((select json_agg(json_build_object('id', m.id, 'name', m.full_name,
                    'isPrimary', ma.is_primary))
                     from mentor_assignments ma join profiles m on m.id = ma.mentor_user_id
                    where ma.implementer_user_id = p.id and ma.deleted_at is null
                      and ma.span @> current_date), '[]') as mentors
    from profiles p
    left join training_statuses ts on ts.id = p.training_status_id
   where p.deleted_at is null`;

/** רשימת משתמשים, מסוננת ל-Scope של הקורא */
export async function list(principal, filters = {}) {
  const isManager = principal.baseRole === 'manager';
  return query(
    `${PERSON_SELECT}
       and ($1 or p.id = $2 or p.id = any($3::uuid[])
            or exists (select 1 from site_assignments sa
                        where sa.user_id = p.id and sa.deleted_at is null
                          and sa.site_id = any($4::uuid[])))
       and ($5::text is null or p.base_role::text = $5)
       and ($6::text is null or p.status::text = $6)
       and ($7::uuid is null or exists (select 1 from site_assignments sa
                                         where sa.user_id = p.id and sa.site_id = $7
                                           and sa.deleted_at is null))
       and ($8::uuid is null or exists (select 1 from user_domains ud
                                         where ud.user_id = p.id and ud.domain_id = $8
                                           and ud.deleted_at is null))
       and ($9::text is null or p.full_name ilike '%' || $9 || '%'
                             or p.email::text ilike '%' || $9 || '%'
                             or p.phone ilike '%' || $9 || '%')
     order by p.full_name
     limit $10`,
    [
      isManager, principal.userId, principal.scopes.assignedUserIds, principal.scopes.siteIds,
      filters.role ?? null, filters.status ?? null, filters.siteId ?? null,
      filters.domainId ?? null, filters.q ?? null, filters.limit ?? 200,
    ],
  );
}

export async function get(userId) {
  const [row] = await query(`${PERSON_SELECT} and p.id = $1`, [userId]);
  if (!row) throw new AppError('E_NOT_FOUND', 'המשתמש המבוקש לא נמצא');
  return row;
}

/**
 * עדכון פרופיל.
 * מטמיע רשאי לערוך רק את השדות שהוגדרו כניתנים לעריכה עצמית (§7).
 */
export async function updateProfile(actor, userId, input, req) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const current = await tx.lock('profiles', userId);
    if (!current || current.deleted_at) throw new AppError('E_NOT_FOUND', 'המשתמש המבוקש לא נמצא');
    assertIfMatch(req, current);

    const isSelfEdit = actor.userId === userId && actor.baseRole !== 'manager';
    let allowed = input;

    if (isSelfEdit) {
      const [setting] = await tx.query(
        `select value from app_settings where key = 'editable_profile_fields'`,
      );
      const editable = new Set(setting?.value ?? ['phone', 'bio']);
      allowed = Object.fromEntries(Object.entries(input).filter(([k]) => editable.has(k)));

      if (Object.keys(allowed).length === 0) {
        throw new AppError('E_FORBIDDEN', 'השדות שנשלחו אינם פתוחים לעריכה עצמית');
      }
    }

    const [row] = await tx.query(
      `update profiles set
         full_name = coalesce($2, full_name),
         phone = coalesce($3, phone),
         bio = coalesce($4, bio),
         notes = coalesce($5, notes),
         intake_date = coalesce($6, intake_date),
         base_role = coalesce($7::base_role, base_role),
         status = coalesce($8::user_status, status),
         training_status_id = coalesce($9, training_status_id)
       where id = $1 returning *`,
      [
        userId, allowed.fullName ?? null, allowed.phone ?? null, allowed.bio ?? null,
        allowed.notes ?? null, allowed.intakeDate ?? null,
        isSelfEdit ? null : (allowed.baseRole ?? null),
        isSelfEdit ? null : (allowed.status ?? null),
        isSelfEdit ? null : (allowed.trainingStatusId ?? null),
      ],
    );

    invalidatePrincipal(userId);
    return row;
  });
}

/** שיוך לתחומים — החלפה מלאה */
export async function setDomains(actor, userId, domainIds, primaryId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    await tx.query('delete from user_domains where user_id = $1', [userId]);
    for (const id of domainIds) {
      await tx.query(
        'insert into user_domains (user_id, domain_id, is_primary) values ($1, $2, $3)',
        [userId, id, id === (primaryId ?? domainIds[0])],
      );
    }
    invalidatePrincipal(userId);
    return domainIds.length;
  });
}

export async function setSubCategories(actor, userId, subCategoryIds) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    // תת-קטגוריה חייבת להשתייך לאחד התחומים של המשתמש
    if (subCategoryIds.length) {
      const [check] = await tx.query(
        `select count(*)::int as bad
           from sub_categories sc
          where sc.id = any($1::uuid[])
            and sc.domain_id not in (select domain_id from user_domains
                                      where user_id = $2 and deleted_at is null)`,
        [subCategoryIds, userId],
      );
      if (check.bad > 0) {
        throw new AppError('E_VALIDATION', 'נבחרה תת-קטגוריה שאינה שייכת לתחומים של המשתמש');
      }
    }

    await tx.query('delete from user_sub_categories where user_id = $1', [userId]);
    for (const id of subCategoryIds) {
      await tx.query(
        'insert into user_sub_categories (user_id, sub_category_id) values ($1, $2)',
        [userId, id],
      );
    }
    invalidatePrincipal(userId);
    return subCategoryIds.length;
  });
}

export async function setSiteAssignment(actor, userId, { siteId, assignmentRole = 'implementer' }) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [existing] = await tx.query(
      `select id from site_assignments
        where user_id = $1 and site_id = $2 and deleted_at is null and span @> current_date`,
      [userId, siteId],
    );

    if (existing) {
      await tx.query('update site_assignments set assignment_role = $2::site_role where id = $1', [
        existing.id, assignmentRole,
      ]);
      invalidatePrincipal(userId);
      return existing.id;
    }

    const [row] = await tx.query(
      `insert into site_assignments (site_id, user_id, assignment_role)
       values ($1, $2, $3::site_role) returning id`,
      [siteId, userId, assignmentRole],
    );
    invalidatePrincipal(userId);
    return row.id;
  });
}

export async function endSiteAssignment(actor, assignmentId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update site_assignments set to_date = current_date
        where id = $1 and deleted_at is null returning user_id`,
      [assignmentId],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'השיוך המבוקש לא נמצא');
    invalidatePrincipal(row.user_id);
    return { ended: assignmentId };
  });
}

/** השבתת משתמש: שיוכי המדריך שלו מסתיימים יחד איתו */
export async function deactivate(actor, userId) {
  if (userId === actor.userId) {
    throw new AppError('E_VALIDATION', 'לא ניתן להשבית את המשתמש המחובר');
  }

  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [managers] = await tx.query(
      `select count(*)::int as n from profiles
        where base_role = 'manager' and status = 'active' and deleted_at is null and id <> $1`,
      [userId],
    );
    const [target] = await tx.query('select base_role::text as role from profiles where id = $1', [userId]);

    // המערכת חייבת להישאר ניתנת לניהול
    if (target?.role === 'manager' && managers.n === 0) {
      throw new AppError('E_VALIDATION', 'לא ניתן להשבית את מנהל ההטמעה האחרון במערכת');
    }

    await tx.query(`update profiles set status = 'suspended' where id = $1`, [userId]);
    await tx.query(
      `update mentor_assignments set to_date = current_date
        where (mentor_user_id = $1 or implementer_user_id = $1)
          and deleted_at is null and (to_date is null or to_date > current_date)`,
      [userId],
    );

    invalidatePrincipal(userId);
    return get(userId);
  });
}

/* ───────────────────────── קליטת מטמיע ───────────────────────── */

/**
 * אשף הקליטה (§5.1).
 *
 * אינו יוצר משתמש auth — הזמנה נשמרת, והפרופיל נוצר אוטומטית ברגע
 * שהמוזמן נרשם. כך אין סיסמה שעוברת דרך השרת שלנו.
 */
export async function invite(actor, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [existing] = await tx.query(
      'select id from profiles where email = $1 and deleted_at is null',
      [input.email],
    );
    if (existing) throw new AppError('E_DUPLICATE', 'כתובת הדוא״ל כבר קיימת במערכת');

    if (input.mentorUserId) {
      await assertMentorCovers(tx, input.mentorUserId, {
        siteId: input.siteId,
        domainIds: input.domainIds ?? [],
        subCategoryIds: input.subCategoryIds ?? [],
      });
    }

    const [row] = await tx.query(
      `insert into user_invites
         (email, full_name, phone, base_role, site_id, domain_ids, sub_category_ids,
          mentor_user_id, invited_by)
       values ($1, $2, $3, $4::base_role, $5, $6, $7, $8, $9)
       on conflict (email) where accepted_at is null and deleted_at is null
       do update set full_name = excluded.full_name, phone = excluded.phone,
                     base_role = excluded.base_role, site_id = excluded.site_id,
                     domain_ids = excluded.domain_ids,
                     sub_category_ids = excluded.sub_category_ids,
                     mentor_user_id = excluded.mentor_user_id,
                     expires_at = now() + interval '14 days'
       returning *`,
      [
        input.email, input.fullName, input.phone ?? null, input.baseRole ?? 'implementer',
        input.siteId ?? null, input.domainIds ?? [], input.subCategoryIds ?? [],
        input.mentorUserId ?? null, actor.userId,
      ],
    );
    return row;
  });
}

export async function listInvites() {
  return query(
    `select i.id, i.email, i.full_name, i.phone, i.base_role::text as base_role,
            i.expires_at, i.accepted_at, s.name as site_name,
            inviter.full_name as invited_by_name
       from user_invites i
       left join sites s on s.id = i.site_id
       left join profiles inviter on inviter.id = i.invited_by
      where i.deleted_at is null
      order by i.accepted_at nulls first, i.created_at desc`,
  );
}

/* ───────────────────────── שיוך מדריך ───────────────────────── */

/**
 * §9: "מניעת שיוך לא תקין".
 * מדריך ניתן לשיוך רק במסגרת תחומי האחריות שהוגדרו לו.
 */
async function assertMentorCovers(tx, mentorId, { siteId, domainIds, subCategoryIds }) {
  const [mentor] = await tx.query(
    `select id, full_name, base_role::text as role, status::text as status
       from profiles where id = $1 and deleted_at is null`,
    [mentorId],
  );
  if (!mentor) throw new AppError('E_INVALID_ASSIGNMENT', 'המדריך המבוקש לא נמצא');
  if (mentor.role !== 'mentor') {
    throw new AppError('E_INVALID_ASSIGNMENT', `${mentor.full_name} אינו מוגדר כמדריך`);
  }
  if (mentor.status !== 'active') {
    throw new AppError('E_INVALID_ASSIGNMENT', `${mentor.full_name} אינו פעיל`);
  }

  const [cover] = await tx.query(
    `select count(*)::int as n
       from mentor_responsibilities r
      where r.mentor_user_id = $1 and r.deleted_at is null and r.span @> current_date
        and (r.site_id is null or r.site_id = $2)
        and (r.domain_id is null or r.domain_id = any($3::uuid[]))
        and (r.sub_category_id is null or r.sub_category_id = any($4::uuid[]))`,
    [mentorId, siteId ?? null, domainIds ?? [], subCategoryIds ?? []],
  );

  if (cover.n === 0) {
    throw new AppError(
      'E_INVALID_ASSIGNMENT',
      `ל${mentor.full_name} אין תחום אחריות שמכסה את האתר והתחום של המטמיע`,
      { details: { mentorId, siteId, domainIds } },
    );
  }
}

/** בדיקה יבשה — מחזירה את הסיבות בלי לכתוב (§9) */
export async function validateMentorAssignment(mentorId, implementerId) {
  return withTransaction({}, async (tx) => {
    const [impl] = await tx.query(
      `select p.id, p.full_name,
              (select site_id from site_assignments
                where user_id = p.id and deleted_at is null and span @> current_date limit 1) as site_id,
              array(select domain_id from user_domains
                     where user_id = p.id and deleted_at is null) as domain_ids,
              array(select sub_category_id from user_sub_categories
                     where user_id = p.id and deleted_at is null) as sub_ids
         from profiles p where p.id = $1 and p.deleted_at is null`,
      [implementerId],
    );
    if (!impl) return { valid: false, reasons: ['המטמיע המבוקש לא נמצא'] };

    const reasons = [];
    if (!impl.site_id) reasons.push('המטמיע אינו משויך לאתר');
    if (impl.domain_ids.length === 0) reasons.push('המטמיע אינו משויך לתחום');

    if (reasons.length === 0) {
      try {
        await assertMentorCovers(tx, mentorId, {
          siteId: impl.site_id,
          domainIds: impl.domain_ids,
          subCategoryIds: impl.sub_ids,
        });
      } catch (err) {
        reasons.push(err.message);
      }
    }

    return { valid: reasons.length === 0, reasons };
  });
}

export async function assignMentor(actor, { mentorUserId, implementerUserId, isPrimary = false, traceId }) {
  return withTransaction({ actorId: actor.userId, traceId }, async (tx) => {
    const [impl] = await tx.query(
      `select p.id, p.full_name,
              (select site_id from site_assignments
                where user_id = p.id and deleted_at is null and span @> current_date limit 1) as site_id,
              array(select domain_id from user_domains
                     where user_id = p.id and deleted_at is null) as domain_ids,
              array(select sub_category_id from user_sub_categories
                     where user_id = p.id and deleted_at is null) as sub_ids
         from profiles p where p.id = $1 and p.deleted_at is null`,
      [implementerUserId],
    );
    if (!impl) throw new AppError('E_NOT_FOUND', 'המטמיע המבוקש לא נמצא');
    if (!impl.site_id || impl.domain_ids.length === 0) {
      throw new AppError('E_INVALID_ASSIGNMENT', 'יש לשייך אתר ותחום למטמיע לפני שיוך מדריך');
    }

    await assertMentorCovers(tx, mentorUserId, {
      siteId: impl.site_id,
      domainIds: impl.domain_ids,
      subCategoryIds: impl.sub_ids,
    });

    return evaluateAndExecute(
      tx,
      {
        trigger: 'assign',
        subjectType: 'mentor_assignment',
        targetUserId: implementerUserId,
        mentorUserId,
        siteId: impl.site_id,
        domainId: impl.domain_ids[0],
        subCategoryIds: impl.sub_ids,
      },
      {
        meta: { actorId: actor.userId, traceId },
        summary: `שיוך מדריך ל${impl.full_name}`,
        action: {
          type: 'mentors.assign',
          payload: { mentorUserId, implementerUserId, isPrimary },
        },
      },
    );
  });
}

registerAction('mentors.assign', async (tx, { mentorUserId, implementerUserId, isPrimary }) => {
  // מדריך ראשי חדש מסיים את הקודם, כדי שמגבלת ה-EXCLUDE לא תיפול
  if (isPrimary) {
    await tx.query(
      `update mentor_assignments set to_date = current_date - 1
        where implementer_user_id = $1 and is_primary and deleted_at is null
          and span @> current_date`,
      [implementerUserId],
    );
  }

  const [row] = await tx.query(
    `insert into mentor_assignments (mentor_user_id, implementer_user_id, is_primary)
     values ($1, $2, $3) returning *`,
    [mentorUserId, implementerUserId, isPrimary],
  );

  await notify(tx, {
    typeCode: 'assignment_changed',
    recipientIds: [mentorUserId, implementerUserId],
    title: 'עודכן שיוך מדריך',
    body: isPrimary ? 'שויך מדריך ראשי' : 'שויך מדריך תומך',
    entityType: 'mentor_assignments',
    entityId: row.id,
  });

  invalidatePrincipal(mentorUserId);
  invalidatePrincipal(implementerUserId);
  return row;
});

export async function endMentorAssignment(actor, assignmentId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update mentor_assignments set to_date = current_date
        where id = $1 and deleted_at is null
        returning mentor_user_id, implementer_user_id`,
      [assignmentId],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'השיוך המבוקש לא נמצא');
    invalidatePrincipal(row.mentor_user_id);
    invalidatePrincipal(row.implementer_user_id);
    return { ended: assignmentId };
  });
}

/* ───────────────────────── מדריכים ───────────────────────── */

export async function mentors(filters = {}) {
  return query(
    `select p.id, p.full_name, p.email, p.phone, p.status::text as status,
            (select count(*)::int from mentor_assignments ma
              where ma.mentor_user_id = p.id and ma.deleted_at is null
                and ma.span @> current_date) as implementer_count,
            coalesce((select json_agg(json_build_object(
                'id', r.id, 'siteId', r.site_id, 'siteName', s.name,
                'domainId', r.domain_id, 'domainName', d.name,
                'subCategoryId', r.sub_category_id, 'subCategoryName', sc.name,
                'fromDate', r.from_date, 'toDate', r.to_date))
              from mentor_responsibilities r
              left join sites s on s.id = r.site_id
              left join domains d on d.id = r.domain_id
              left join sub_categories sc on sc.id = r.sub_category_id
             where r.mentor_user_id = p.id and r.deleted_at is null), '[]') as responsibilities
       from profiles p
      where p.base_role = 'mentor' and p.deleted_at is null
        and ($1::text is null or p.status::text = $1)
        and ($2::text is null or p.full_name ilike '%' || $2 || '%')
      order by p.full_name`,
    [filters.status ?? null, filters.q ?? null],
  );
}

export async function addResponsibility(actor, mentorId, input) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `insert into mentor_responsibilities
         (mentor_user_id, site_id, domain_id, sub_category_id, from_date, to_date)
       values ($1, $2, $3, $4, coalesce($5, current_date), $6) returning *`,
      [mentorId, input.siteId ?? null, input.domainId ?? null, input.subCategoryId ?? null,
       input.fromDate ?? null, input.toDate ?? null],
    );
    invalidatePrincipal(mentorId);
    return row;
  });
}

export async function endResponsibility(actor, responsibilityId) {
  return withTransaction({ actorId: actor.userId }, async (tx) => {
    const [row] = await tx.query(
      `update mentor_responsibilities set to_date = current_date
        where id = $1 and deleted_at is null returning mentor_user_id`,
      [responsibilityId],
    );
    if (!row) throw new AppError('E_NOT_FOUND', 'תחום האחריות המבוקש לא נמצא');
    invalidatePrincipal(row.mentor_user_id);
    return { ended: responsibilityId };
  });
}

/** §9: "התרעה על מטמיע ללא מדריך" */
export async function unassigned() {
  return query(
    `select user_id, full_name, base_role::text as base_role,
            missing_site, missing_domain, missing_mentor
       from v_unassigned_implementers
      where missing_site or missing_domain or missing_mentor
      order by full_name`,
  );
}

/** המטמיעים שבאחריות המדריך — מסך "הצוות שלי" */
export async function myTeam(mentorId) {
  return query(
    `${PERSON_SELECT}
       and p.id in (select implementer_user_id from mentor_assignments
                     where mentor_user_id = $1 and deleted_at is null
                       and span @> current_date)
     order by p.full_name`,
    [mentorId],
  );
}
