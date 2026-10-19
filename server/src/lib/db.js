import pg from 'pg';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { AppError, mapDatabaseError } from './errors.js';

/**
 * גישה למסד הנתונים.
 *
 * השרת מתחבר ישירות ל-Postgres של Supabase ולא דרך PostgREST, משום
 * שהמערכת נשענת על שלושה דברים שאין ל-PostgREST:
 *   1. טרנזקציות מרובות משפטים — פרסום סידור, שחזור פעולה שאושרה.
 *   2. set local app.actor_id — כך טריגר ה-Audit יודע מי האדם מאחורי
 *      החיבור המנהלי, במקום לרשום NULL בכל שורה.
 *   3. שגיאות EXCLUDE ו-CHECK במלואן, כדי למפות אותן להודעה בעברית.
 */

// Postgres מחזיר numeric ו-bigint כמחרוזות כדי לא לאבד דיוק. במערכת הזו
// המספרים קטנים (שעות, מונים), ולכן ממירים למספר כדי ש-JSON יהיה נקי.
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));
// date נשאר מחרוזת 'YYYY-MM-DD' ולא הופך ל-Date באזור זמן מקומי
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  // Supabase דורש TLS. התעודה חתומה ע״י רשות שאינה בחנות של Node,
  // ולכן האימות מרופף — החיבור מוצפן, אך ה-CA אינו נאכף.
  ssl: env.DB_SSL ? { rejectUnauthorized: false } : false,
  // Render בחבילה החינמית מקבל מעט מאוד זיכרון, ו-Supabase החינמי מגביל
  // חיבורים. מאגר קטן הוא הנכון כאן.
  max: 8,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 15_000,
  // pooler של Supabase סוגר חיבורים מדי פעם; זה מונע שימוש בחיבור מת
  keepAlive: true,
});

pool.on('error', (err) => {
  logger.error('שגיאת מאגר חיבורים', { message: err.message });
});

/** הופך כל שגיאת DB לשגיאת יישום עם הודעה בעברית */
function rethrow(err, sql) {
  const mapped = mapDatabaseError(err);
  if (mapped) throw mapped;
  logger.error('שגיאת מסד נתונים לא ממופה', {
    code: err.code,
    constraint: err.constraint,
    detail: err.detail,
    message: err.message,
    sql: sql?.slice(0, 200),
  });
  throw new AppError('E_UNEXPECTED', 'אירעה שגיאה בגישה לנתונים', { cause: err });
}

/** שאילתת קריאה בודדת, ללא טרנזקציה */
export async function query(sql, params = []) {
  try {
    const res = await pool.query(sql, params);
    return res.rows;
  } catch (err) {
    rethrow(err, sql);
  }
}

/** שורה אחת או undefined */
export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0];
}

/** שורה אחת, או שגיאת "לא נמצא" */
export async function queryRequired(sql, params = [], message = 'הפריט המבוקש לא נמצא') {
  const row = await queryOne(sql, params);
  if (!row) throw new AppError('E_NOT_FOUND', message);
  return row;
}

/**
 * מריץ פונקציה בתוך טרנזקציה אחת.
 *
 * מגדיר app.actor_id ו-app.trace_id ברמת הטרנזקציה, ולכן טריגר ה-Audit
 * וטריגרי created_by/updated_by רושמים את המשתמש האמיתי גם כשהחיבור
 * למסד הוא מנהלי.
 *
 * @param {{ actorId?: string, traceId?: string }} ctx
 * @param {(tx: { query: Function, one: Function, required: Function }) => Promise<any>} fn
 */
export async function withTransaction(ctx, fn) {
  const client = await pool.connect();
  const tx = makeTx(client);
  // פעולות שאסור שיקרו לפני שהטרנזקציה נשמרה (למשל Push לטלפון) — רצות רק אחרי commit
  const afterCommit = [];
  tx.afterCommit = (fn) => afterCommit.push(fn);

  try {
    await client.query('begin');
    // set_config עם is_local=true — הערך חי עד סוף הטרנזקציה בלבד,
    // ולכן אינו דולף לבקשה הבאה שתקבל את אותו חיבור מהמאגר.
    await client.query('select set_config($1, $2, true)', ['app.actor_id', ctx.actorId ?? '']);
    await client.query('select set_config($1, $2, true)', ['app.trace_id', ctx.traceId ?? '']);

    const result = await fn(tx);
    await client.query('commit');
    for (const job of afterCommit) {
      Promise.resolve().then(job).catch((err) => logger.warn('פעולה שאחרי commit נכשלה', { message: err.message }));
    }
    return result;
  } catch (err) {
    try {
      await client.query('rollback');
    } catch (rollbackErr) {
      logger.error('גלגול הטרנזקציה לאחור נכשל', { message: rollbackErr.message });
    }
    if (err instanceof AppError) throw err;
    rethrow(err);
  } finally {
    client.release();
  }
}

function makeTx(client) {
  const run = async (sql, params = []) => {
    try {
      const res = await client.query(sql, params);
      return res.rows;
    } catch (err) {
      rethrow(err, sql);
    }
  };

  return {
    query: run,
    one: async (sql, params) => (await run(sql, params))[0],
    required: async (sql, params, message) => {
      const row = (await run(sql, params))[0];
      if (!row) throw new AppError('E_NOT_FOUND', message ?? 'הפריט המבוקש לא נמצא');
      return row;
    },
    /** נעילת שורה לפני קריאה-ואז-כתיבה, כדי שלא יתחרו בה שתי בקשות */
    lock: async (table, id) =>
      (await run(`select * from ${table} where id = $1 for update`, [id]))[0],
  };
}

/** בדיקת חיות ל-/health */
export async function ping() {
  const started = Date.now();
  await pool.query('select 1');
  return Date.now() - started;
}

export async function closePool() {
  await pool.end();
}
