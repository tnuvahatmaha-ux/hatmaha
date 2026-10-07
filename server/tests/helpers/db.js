import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * עוזרי בדיקות אינטגרציה.
 *
 * הבדיקות רצות מול Postgres מקומי. כשאין כזה, הן מדלגות על עצמן במקום
 * להיכשל — כדי ש-`npm test` יעבוד גם אצל מי שלא הרים מסד.
 */

const ROOT = path.resolve(import.meta.dirname, '../..');
const REPO = path.resolve(ROOT, '..');

const SOCKET = process.env.TEST_PG_SOCKET ?? '/tmp/hpg';
const PORT = process.env.TEST_PG_PORT ?? '54999';

/**
 * לכל קובץ בדיקות אינטגרציה מסד משלו. vitest מריץ קבצים במקביל, ומסד
 * משותף היה גורם לקובץ אחד למחוק את הסכמה תחת רגליו של השני.
 */
export const dbUrlFor = (name) =>
  `postgresql://postgres@localhost/${name}?host=${SOCKET}&port=${PORT}`;

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? dbUrlFor('hatmaha_test');

let available = null;

/** האם יש מסד בדיקות זמין */
export async function dbAvailable() {
  if (available !== null) return available;
  try {
    const pg = (await import('pg')).default;
    // מתחברים ל-postgres ולא למסד הבדיקות: הוא נוצר מחדש בכל ריצה,
    // ולכן אסור שהבדיקה לזמינות תיפול רק משום שעדיין אין אותו.
    const client = new pg.Client({
      connectionString: TEST_DB_URL.replace(/\/[^/?]+\?/, '/postgres?'),
      ssl: false,
    });
    await client.connect();
    await client.end();
    available = true;
  } catch {
    available = false;
  }
  return available;
}

/** מריץ את כל המיגרציות על מסד בדיקות נקי */
export function resetSchema({ socket = SOCKET, port = PORT, db = 'hatmaha_test' } = {}) {
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  const psql = (args, extra = {}) =>
    execFileSync('psql', ['-h', socket, '-p', port, '-U', 'postgres', '-v', 'ON_ERROR_STOP=1', '-q', ...args],
      { env, stdio: 'pipe', ...extra });

  psql(['-d', 'postgres', '-c', `drop database if exists "${db}" with (force);`]);
  psql(['-d', 'postgres', '-c', `create database "${db}";`]);

  const stub = path.join(REPO, 'supabase/tests/00_local_auth_stub.sql');
  if (existsSync(stub)) psql(['-d', db, '-f', stub]);

  const dir = path.join(REPO, 'supabase/migrations');
  const files = execFileSync('ls', [dir]).toString().trim().split('\n').filter((f) => f.endsWith('.sql'));
  for (const f of files.sort()) psql(['-d', db, '-f', path.join(dir, f)]);
}

/** יוצר משתמש דרך auth.users, כך שטריגר יצירת הפרופיל באמת רץ */
export async function createUser(tx, { email, fullName, role }) {
  if (role && role !== 'implementer') {
    await tx.query(
      `insert into user_invites (email, full_name, base_role) values ($1, $2, $3::base_role)`,
      [email, fullName, role],
    );
  }
  await tx.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, $2::jsonb)`,
    [email, JSON.stringify({ full_name: fullName })],
  );
  const [row] = await tx.query('select * from profiles where email = $1', [email]);
  return row;
}
