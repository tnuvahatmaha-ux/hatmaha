/**
 * סבב שבועי.
 *
 * במיקום שעובד "שבוע שבוע", המטמיע עובד כל שבוע בסוג משמרת אחד, והסוג
 * מתחלף לפי הסדר שהוגדר במיקום (למשל בוקר ← צהריים ← לילה).
 *
 * הסוג של שבוע נגזר קודם כול ממה שהמטמיע עבד בפועל: השבוע האחרון לפניו
 * (עד 8 שבועות אחורה) שבו יש לו שיבוצים במיקום בסידור שפורסם, ומשם מתקדמים
 * בסבב צעד לכל שבוע. כשאין סידור כזה — מהעוגן שנרשם לו בהגדרת הסבב.
 *
 * מודול נפרד, כי גם מנוע החוקיות (rules/facts.js) צריך אותו.
 */

export const CATEGORY_NAMES = { morning: 'בוקר', afternoon: 'צהריים', night: 'לילה' };

const LOOKBACK_WEEKS = 8;

const weeksBetween = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / (7 * 86_400_000));

const step = (cycle, category, weeks) => {
  const idx = Math.max(0, cycle.indexOf(category));
  const n = cycle.length;
  return cycle[(((idx + weeks) % n) + n) % n];
};

/** הסוג שהמטמיע עבד בו הכי הרבה באותו שבוע. תיקו — הסוג שמוקדם יותר בסבב */
function dominant(rows, cycle) {
  const counts = new Map();
  for (const r of rows) counts.set(r.category, (counts.get(r.category) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || cycle.indexOf(a[0]) - cycle.indexOf(b[0]))[0]?.[0] ?? null;
}

/**
 * הסבבים של אתר בשבוע נתון: לכל מטמיע בסבב — הסוג שלו בכל מיקום.
 * @param {(sql: string, params: any[]) => Promise<any[]>} run  query או tx.query
 * @returns {Promise<Map<string, {category: string, categories: string[], locations: object[]}>>}
 */
export async function siteRotations(run, siteId, weekStart, { userId = null } = {}) {
  const members = await run(
    `select ur.user_id, ur.location_id, ur.anchor_week::text as anchor_week,
            ur.anchor_category::text as anchor_category,
            l.name as location_name, l.rotation_cycle::text[] as cycle
       from user_rotations ur
       join locations l on l.id = ur.location_id and l.deleted_at is null and l.rotation_cycle is not null
      where ur.site_id = $1 and ur.deleted_at is null
        and ($2::uuid is null or ur.user_id = $2)`,
    [siteId, userId],
  );
  if (members.length === 0) return new Map();

  // מה שכל אחד עבד בפועל בשבועות שלפני, מסידורים שפורסמו
  const worked = await run(
    `select ra.user_id, ra.location_id, v.week_start::text as week_start, st.category::text as category
       from roster_assignments ra
       join roster_versions v on v.id = ra.version_id
       join shift_types st on st.id = ra.shift_type_id
      where v.site_id = $1 and v.status = 'published' and v.deleted_at is null
        and ra.deleted_at is null
        and v.week_start >= $2::date - ($3 * 7) and v.week_start < $2::date
        and ra.user_id = any($4::uuid[])
        -- הגרסה האחרונה שפורסמה לכל שבוע בלבד
        and v.version_number = (select max(v2.version_number) from roster_versions v2
                                 where v2.site_id = v.site_id and v2.week_start = v.week_start
                                   and v2.status = 'published' and v2.deleted_at is null)`,
    [siteId, weekStart, LOOKBACK_WEEKS, [...new Set(members.map((m) => m.user_id))]],
  );

  const out = new Map();
  for (const m of members) {
    const mine = worked.filter((w) => w.user_id === m.user_id && w.location_id === m.location_id);
    const lastWeek = mine.map((w) => w.week_start).sort().at(-1);

    let category;
    let source;
    if (lastWeek) {
      const was = dominant(mine.filter((w) => w.week_start === lastWeek), m.cycle);
      category = step(m.cycle, was, weeksBetween(lastWeek, weekStart));
      source = { kind: 'roster', week: lastWeek, category: was };
    } else {
      category = step(m.cycle, m.anchor_category, weeksBetween(m.anchor_week, weekStart));
      source = { kind: 'anchor', week: m.anchor_week, category: m.anchor_category };
    }

    const entry = out.get(m.user_id) ?? { categories: [], locations: [] };
    entry.locations.push({
      locationId: m.location_id, locationName: m.location_name, cycle: m.cycle, category, source,
    });
    if (!entry.categories.includes(category)) entry.categories.push(category);
    entry.category = entry.categories[0];
    out.set(m.user_id, entry);
  }
  return out;
}

/** הסבב של משתמש אחד בשבוע, או null כשאינו בסבב */
export async function userRotation(run, userId, siteId, weekStart) {
  const map = await siteRotations(run, siteId, weekStart, { userId });
  return map.get(userId) ?? null;
}

/** תיאור קצר: "סבב צהריים" */
export const rotationLabel = (rotation) =>
  rotation ? `סבב ${rotation.categories.map((c) => CATEGORY_NAMES[c]).join(' / ')}` : null;
