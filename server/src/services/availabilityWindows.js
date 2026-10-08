/**
 * חלונות השעות של אתר בשבוע, וספירת המשמרות שסומנו "זמין".
 *
 * מודול נפרד משירות הזמינות, כי גם מנוע החוקיות (rules/facts.js) צריך
 * אותו — וייבוא של השירות משם היה יוצר מעגל.
 */

/** 'HH:MM' מתוך ערך time של Postgres ('HH:MM:SS') */
export const hhmm = (t) => String(t ?? '').slice(0, 5);

/** מפתח יציב לחלון שעות — משותף לשרת וללקוח */
export const windowKey = (start, end) => `${hhmm(start)}-${hhmm(end)}`;

/**
 * חלונות השעות הייחודיים באתר בשבוע נתון, מתוך המשמרות של המיקומים הפעילים בו.
 * חלון הוא "חובה" אם לפחות אחת מהמשמרות בו מסומנת חובה.
 *
 * המיקומים והמשמרות תלויים בשלב האתר בכל יום (הכשרה / עלייה לאוויר / ליווי),
 * ולכן לכל חלון רשימת `days` — הימים בשבוע שבהם הוא קיים. שבוע שחוצה את
 * מועד העלייה לאוויר מחליף חלונות באמצע.
 *
 * @param {(sql: string, params: any[]) => Promise<any[]>} run  query או tx.query
 */
export async function siteWindows(run, siteId, weekStart) {
  const rows = await run(
    `with days as (
       select d::date as day, app.site_period_on($1, d::date) as period
         from generate_series($2::date, $2::date + 6, interval '1 day') d
     )
     select st.start_time, st.end_time,
            bool_or(st.is_mandatory)                         as is_mandatory,
            bool_or(st.crosses_midnight)                     as crosses_midnight,
            string_agg(distinct st.name, ' / ')              as shift_names,
            string_agg(distinct l.name, ', ')                as location_names,
            mode() within group (order by st.category)::text as category,
            array_agg(distinct days.day::text)               as days
       from shift_types st
       join locations l on l.id = st.location_id and l.deleted_at is null and l.is_active
       join days on days.period = any(l.periods)
                and (st.period is null or st.period = days.period)
      where st.site_id = $1 and st.deleted_at is null and st.is_active
      group by st.start_time, st.end_time
      order by st.start_time, st.end_time`,
    [siteId, weekStart],
  );

  return rows.map((r) => ({
    key: windowKey(r.start_time, r.end_time),
    startTime: hhmm(r.start_time),
    endTime: hhmm(r.end_time),
    label: r.shift_names,
    locations: r.location_names,
    isMandatory: r.is_mandatory,
    crossesMidnight: r.crosses_midnight,
    category: r.category,
    days: [...r.days].sort(),
  }));
}

/** השלב של האתר בכל יום בשבוע — לתגית בכותרת היום */
export async function sitePhases(run, siteId, weekStart) {
  const rows = await run(
    `select d::date::text as day, app.site_period_on($1, d::date)::text as period
       from generate_series($2::date, $2::date + 6, interval '1 day') d`,
    [siteId, weekStart],
  );
  return Object.fromEntries(rows.map((r) => [r.day, r.period]));
}

const WEEKEND_DAYS = new Set([5, 6]); // שישי ושבת

/**
 * כמה משמרות "זמין" יש בהצהרה, לפי סוג משמרת ובסוף השבוע.
 * "זמין" הוא ברירת המחדל ואינו נשמר, ולכן: כל צירוף (חלון, יום) שקיים
 * באותו שבוע, פחות התאים שסומנו "מעדיף שלא" או "לא יכול".
 */
export function countAvailable({ cells, windows }) {
  const marked = new Set(
    cells.map((c) => `${c.cell_date ?? c.date}|${windowKey(c.start_time ?? c.startTime, c.end_time ?? c.endTime)}`),
  );
  const counts = { morning: 0, afternoon: 0, night: 0, weekend: 0 };
  for (const w of windows) {
    for (const day of w.days ?? []) {
      if (marked.has(`${day}|${w.key}`)) continue;
      if (w.category in counts) counts[w.category] += 1;
      if (WEEKEND_DAYS.has(new Date(`${day}T12:00:00Z`).getUTCDay())) counts.weekend += 1;
    }
  }
  return counts;
}

