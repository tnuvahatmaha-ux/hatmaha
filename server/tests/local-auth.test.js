import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const SERVER = path.resolve(import.meta.dirname, '..');

/** טוען את config/env.js בתהליך נפרד, עם סביבה נתונה, ומחזיר את התוצאה */
function loadEnv(vars) {
  return spawnSync(
    process.execPath,
    ['--input-type=module', '-e', "await import('./src/config/env.js'); console.log('OK')"],
    {
      cwd: SERVER,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, DATABASE_URL: 'postgresql://x/y', ...vars },
    },
  );
}

describe('שומר הסף של מצב ההתחברות המקומי', () => {
  it('השרת מסרב לעלות עם AUTH_MODE=local בייצור', () => {
    const r = loadEnv({ AUTH_MODE: 'local', NODE_ENV: 'production' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('אסור בייצור');
  });

  it('בפיתוח, מצב מקומי עולה גם בלי פרטי Supabase', () => {
    const r = loadEnv({ AUTH_MODE: 'local', NODE_ENV: 'development' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK');
  });

  it('במצב הרגיל, פרטי Supabase עדיין חובה', () => {
    const r = loadEnv({ NODE_ENV: 'production' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SUPABASE_URL');
  });
});

describe('requireAuth במצב מקומי', () => {
  const USER = '00000000-0000-4000-8000-000000000005';
  let requireAuth;

  beforeEach(async () => {
    vi.resetModules();
    process.env.AUTH_MODE = 'local';
    vi.doMock('../src/permissions/repository.js', () => ({
      loadPrincipal: async (id) =>
        id === USER ? { userId: USER, email: 'noa@demo.local', baseRole: 'implementer', status: 'active' } : null,
      invalidatePrincipal: () => {},
    }));
    ({ requireAuth } = await import('../src/middleware/requireAuth.js'));
    delete process.env.AUTH_MODE;
  });

  const run = (authorization) =>
    new Promise((resolve) => {
      const req = { get: (h) => (h.toLowerCase() === 'authorization' ? authorization : undefined) };
      requireAuth(req, {}, (err) => resolve({ err, req }));
    });

  it('טוקן local:<מזהה> של משתמש קיים — מתקבל', async () => {
    const { err, req } = await run(`Bearer local:${USER}`);
    expect(err).toBeUndefined();
    expect(req.user.userId).toBe(USER);
  });

  it('טוקן בפורמט אחר — נדחה', async () => {
    const { err } = await run('Bearer eyJhbGciOiJIUzI1NiJ9.e30.x');
    expect(err.code).toBe('E_UNAUTHENTICATED');
  });

  it('משתמש שאינו קיים — נדחה', async () => {
    const { err } = await run('Bearer local:00000000-0000-4000-8000-000000000099');
    expect(err.code).toBe('E_UNAUTHENTICATED');
  });
});
