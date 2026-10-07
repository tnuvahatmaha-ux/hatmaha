import { supabase } from './supabase.js';
import { isLocalAuth, getLocalUserId, localToken } from './authMode.js';

const BASE = (import.meta.env.VITE_API_URL ?? '').replace(/\/$/, '');

/** שגיאה מהשרת, עם הקוד היציב ומזהה המעקב */
export class ApiError extends Error {
  constructor({ code, message, traceId, details, status }) {
    super(message ?? 'אירעה שגיאה');
    this.name = 'ApiError';
    this.code = code ?? 'E_UNEXPECTED';
    this.traceId = traceId;
    this.details = details;
    this.status = status;
  }

  /** שגיאות ולידציה מגיעות עם שם שדה, כדי שהטופס יסמן את המקום הנכון */
  get fieldErrors() {
    const fields = this.details?.fields ?? [];
    return Object.fromEntries(fields.map((f) => [f.field, f.message]));
  }
}

/**
 * השרת ב-Render בחבילה החינמית נרדם אחרי כרבע שעה ללא תנועה, וההתעוררות
 * לוקחת כחצי דקה. בלי הודעה, המשתמש חושב שהמערכת תקועה.
 */
const WAKE_AFTER_MS = 3000;
const TIMEOUT_MS = 60_000;

let wakeListeners = new Set();

/** הרשמה להודעת "השרת מתעורר". מוחזרת פונקציית ביטול. */
export function onServerWaking(listener) {
  wakeListeners.add(listener);
  return () => wakeListeners.delete(listener);
}

const emitWaking = (waking) => wakeListeners.forEach((l) => l(waking));

async function authHeader() {
  if (isLocalAuth) {
    const userId = getLocalUserId();
    return userId ? { Authorization: `Bearer ${localToken(userId)}` } : {};
  }
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * הנתיב היחיד מהלקוח לשרת.
 *
 * @param {string} path  נתיב יחסי, למשל '/api/sites'
 * @param {object} [options]
 * @param {string} [options.method]
 * @param {object} [options.body]
 * @param {object} [options.query]
 * @param {string} [options.idempotencyKey]
 * @param {number} [options.ifMatch]  גרסת השורה, לנעילה אופטימית
 * @param {boolean} [options.raw]     מחזיר Response במקום JSON (לייצוא)
 * @param {boolean} [options.retry]   ניסיון חוזר אחד, לשרת שמתעורר
 */
export async function api(path, options = {}) {
  const {
    method = 'GET',
    body,
    query,
    idempotencyKey,
    ifMatch,
    raw = false,
    retry = true,
  } = options;

  const url = new URL(BASE + path, window.location.origin);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = {
    ...(await authHeader()),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
    ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    ...(ifMatch != null ? { 'If-Match': `W/"${ifMatch}"` } : {}),
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const wakeTimer = setTimeout(() => emitWaking(true), WAKE_AFTER_MS);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    if (raw) return response;

    if (response.status === 204) return null;

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      throw new ApiError({ ...(payload?.error ?? {}), status: response.status });
    }
    return payload;
  } catch (err) {
    if (err instanceof ApiError) throw err;

    // פסק זמן או שרת שעדיין מתעורר — ניסיון אחד נוסף
    const isNetwork = err.name === 'AbortError' || err instanceof TypeError;
    if (isNetwork && retry && method === 'GET') {
      return api(path, { ...options, retry: false });
    }

    throw new ApiError({
      code: err.name === 'AbortError' ? 'E_TIMEOUT' : 'E_NETWORK',
      message:
        err.name === 'AbortError'
          ? 'השרת לא הגיב בזמן. ייתכן שהוא מתעורר — נסה/י שוב בעוד רגע.'
          : 'אין חיבור לשרת. בדוק/בדקי את החיבור לאינטרנט ונסה/י שוב.',
      status: 0,
    });
  } finally {
    clearTimeout(timeout);
    clearTimeout(wakeTimer);
    emitWaking(false);
  }
}

/* קיצורים */
export const get = (path, query) => api(path, { query });
export const post = (path, body, opts) => api(path, { method: 'POST', body, ...opts });
export const put = (path, body, opts) => api(path, { method: 'PUT', body, ...opts });
export const patch = (path, body, opts) => api(path, { method: 'PATCH', body, ...opts });
export const del = (path, opts) => api(path, { method: 'DELETE', ...opts });

/** מוריד קובץ שהשרת מייצר (CSV) */
export async function download(path, query, filename) {
  const response = await api(path, { query, raw: true });

  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError({ ...(payload?.error ?? {}), status: response.status });
  }

  const blob = await response.blob();
  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename ?? 'export.csv';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

/** מפתח אידמפוטנטיות לפעולה רגישה */
export const newIdempotencyKey = () =>
  (crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`);
