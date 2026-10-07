import { env } from '../config/env.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[env.LOG_LEVEL] ?? LEVELS.info;

/** שדות שלעולם אינם נכתבים ללוג */
const REDACT = new Set([
  'password',
  'token',
  'access_token',
  'refresh_token',
  'authorization',
  'apikey',
  'service_role_key',
  'DATABASE_URL',
]);

function scrub(value, depth = 0) {
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => scrub(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT.has(k.toLowerCase()) ? '[redacted]' : scrub(v, depth + 1);
  }
  return out;
}

function emit(level, message, fields) {
  if (LEVELS[level] < threshold) return;
  const record = { time: new Date().toISOString(), level, message, ...scrub(fields ?? {}) };
  const line = env.isProd ? JSON.stringify(record) : formatPretty(record);
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
}

function formatPretty({ time, level, message, ...rest }) {
  const tag = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR' }[level];
  const extras = Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : '';
  return `${time.slice(11, 23)} ${tag} ${message}${extras}`;
}

export const logger = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info: (msg, fields) => emit('info', msg, fields),
  warn: (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};
