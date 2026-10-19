import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * הרצת מיגרציות אוטומטית בעליית השרת.
 *
 * עד 0016 המיגרציות הורצו ידנית ב-SQL Editor של Supabase. מ-0017 והלאה השרת
 * מריץ בעצמו כל מיגרציה שעוד לא הורצה, כך שפריסה ל-Render מעדכנת גם את
 * המסד — בלי שלב ידני שקל לשכוח (וזה בדיוק מה שקרה בפריסה של 0017–0020).
 *
 * - כל מיגרציה רצה בטרנזקציה אחת: היא נכנסת במלואה, או לא בכלל.
 * - נעילת advisory ברמת הטרנזקציה מונעת משני מופעים להריץ במקביל. ברמת
 *   הטרנזקציה ולא ברמת החיבור, כי Supabase מחבר דרך pooler במצב transaction,
 *   ושם נעילת חיבור יכולה "לדלוף" ולחסום את הפריסה הבאה.
 * - מיגרציה שכבר הורצה ידנית מזוהה לפי סימן במסד, ונרשמת בלי להריץ שוב.
 * - כישלון לא מפיל את השרת: הוא נרשם בלוג, ו-/health מראה מה חסר.
 */

const DIR = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
const FIRST_AUTO = 17;
const LOCK_KEY = 4_812_017;

/** סימן לכל מיגרציה — אם הוא קיים, המיגרציה כבר הורצה (ידנית) */
export const MARKERS = {
  17: `select exists (select 1 from role_permissions rp join permissions p on p.id = rp.permission_id
         where rp.role = 'mentor' and p.resource = 'requests' and p.action = 'create') as ok`,
  18: `select exists (select 1 from pg_proc where proname = 'site_period_on') as ok`,
  19: `select exists (select 1 from information_schema.columns
         where table_name = 'shift_types' and column_name = 'category') as ok`,
  20: `select exists (select 1 from information_schema.columns
         where table_name = 'updates' and column_name = 'requires_ack') as ok`,
  21: `select exists (select 1 from information_schema.tables where table_name = 'chat_groups') as ok`,
  22: `select exists (select 1 from information_schema.tables where table_name = 'skill_scores') as ok`,
  23: `select exists (select 1 from information_schema.tables where table_name = 'user_rotations') as ok`,
  24: `select exists (select 1 from information_schema.columns
         where table_name = 'activities' and column_name = 'series_id') as ok`,
  25: `select exists (select 1 from information_schema.tables where table_name = 'chat_message_acks') as ok`,
  26: `select exists (select 1 from information_schema.tables where table_name = 'training_progress_updates') as ok`,
};

export async function runPendingMigrations() {
  const files = (await readdir(DIR))
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .map((f) => ({ file: f, no: Number(f.slice(0, 4)) }))
    .filter((m) => m.no >= FIRST_AUTO)
    .sort((a, b) => a.no - b.no);

  const client = await pool.connect();
  const applied = [];
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await client.query(`
      create table if not exists public.schema_migrations (
        version integer primary key,
        file text not null,
        applied_at timestamptz not null default now(),
        how text not null default 'auto'
      )`);
    await client.query('alter table public.schema_migrations enable row level security');
    await client.query('commit');

    const done = new Set((await client.query('select version from public.schema_migrations')).rows.map((r) => r.version));

    for (const m of files) {
      if (done.has(m.no)) continue;

      const marker = MARKERS[m.no];
      if (marker && (await client.query(marker)).rows[0]?.ok) {
        await client.query(
          `insert into public.schema_migrations (version, file, how) values ($1, $2, 'detected')
           on conflict do nothing`,
          [m.no, m.file],
        );
        continue;
      }

      const sql = await readFile(DIR + m.file, 'utf8');
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock($1)', [LOCK_KEY]);
        // מופע אחר אולי הריץ אותה בזמן שחיכינו לנעילה
        const [{ exists }] = (await client.query(
          'select exists (select 1 from public.schema_migrations where version = $1)', [m.no],
        )).rows;
        if (exists) {
          await client.query('commit');
          continue;
        }
        await client.query(sql);
        await client.query('insert into public.schema_migrations (version, file) values ($1, $2)', [m.no, m.file]);
        await client.query('commit');
        applied.push(m.file);
        logger.info('מיגרציה הורצה', { file: m.file });
      } catch (err) {
        await client.query('rollback').catch(() => {});
        logger.error('מיגרציה נכשלה — עוצר כאן', { file: m.file, message: err.message, detail: err.detail });
        break; // מיגרציות תלויות זו בזו: לא ממשיכים אחרי כישלון
      }
    }
  } finally {
    client.release();
  }
  return applied;
}
