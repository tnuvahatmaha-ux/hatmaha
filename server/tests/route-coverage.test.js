import { describe, it, expect } from 'vitest';
import { API_ROUTES } from '../src/routes/index.js';
import { internalRouter } from '../src/routes/internal.js';
import { RESOURCES, ACTIONS } from '../src/permissions/engine.js';

/**
 * §13: "כל Endpoint יבדוק הרשאה אפקטיבית ו-Scope בצד השרת".
 *
 * requirePermission הוא middleware ולא קריאה בתוך ה-handler, ולכן אפשר
 * לאמת את הכיסוי במקום להבטיח אותו. נתיב חדש שנכתב בלי אכיפה מפיל את
 * הבדיקה הזו, ולא מתגלה רק כשמישהו ינצל אותו.
 */

/** נתיבים שמוגנים במהותם: הם פועלים אך ורק על המשתמש המחובר עצמו. */
const SELF_SCOPED = new Set([
  'GET /auth/me',
  'GET /auth/effective-permissions',
  'POST /auth/refresh',
  'GET /notifications/',
  'POST /notifications/:id/read',
  'POST /notifications/read-all',
  'GET /notifications/preferences',
  'PUT /notifications/preferences',
  'GET /exceptions/',
  'GET /exceptions/:id',
  'POST /exceptions/:id/decision', // בודק canDecide בתוך ה-handler, מול נושא החריגה
  'GET /updates/inbox',
  'GET /updates/:id',                       // נמען או שולח בלבד — נבדק ב-service
  'GET /updates/:id/attachments/:attId/url', // נמען או שולח בלבד — נבדק ב-service
  'POST /updates/:id/read',
  'POST /updates/:id/ack',
]);

/** קטלוגים לקריאה בלבד שממלאים טפסים של כל התפקידים — אינם מידע רגיש. */
const PUBLIC_CATALOGS = new Set([
  'GET /settings/domains',
  'GET /settings/lookups/:kind',
  'GET /settings/location-types',
]);

/**
 * אוסף את הנתיבים של ראוטר יחיד. הקידומת מגיעה מטבלת ההרכבה המפורשת
 * ולא משחזור של ה-regexp הפנימי של Express, שמשתנה בין גרסאות.
 */
function collect(router, prefix = '') {
  const routes = [];

  for (const layer of router.stack ?? []) {
    if (!layer.route) continue;

    const path = prefix + (layer.route.path === '/' ? '/' : layer.route.path);
    const permission = layer.route.stack.map((s) => s.handle?.__permission).find(Boolean);

    for (const method of Object.keys(layer.route.methods)) {
      if (method === '_all') continue;
      routes.push({ key: `${method.toUpperCase()} ${path}`, permission });
    }
  }
  return routes;
}

const allRoutes = () => API_ROUTES.flatMap(([prefix, router]) => collect(router, prefix));

describe('כיסוי אכיפת הרשאות', () => {
  const routes = allRoutes();

  it('נאספו נתיבים לבדיקה', () => {
    expect(routes.length).toBeGreaterThan(40);
  });

  it('כל נתיב תחת /api אוכף הרשאה, או פועל רק על המשתמש עצמו', () => {
    const unprotected = routes
      .filter((r) => !r.permission)
      .map((r) => r.key)
      .filter((key) => !SELF_SCOPED.has(key) && !PUBLIC_CATALOGS.has(key));

    expect(unprotected, `נתיבים ללא אכיפת הרשאה:\n  ${unprotected.join('\n  ')}`).toEqual([]);
  });

  it('כל אכיפה מפנה למשאב ולפעולה שקיימים בקטלוג', () => {
    const invalid = routes
      .filter((r) => r.permission)
      .filter(
        (r) => !RESOURCES.includes(r.permission.resource) || !ACTIONS.includes(r.permission.action),
      )
      .map((r) => `${r.key} → ${r.permission.resource}.${r.permission.action}`);

    expect(invalid).toEqual([]);
  });

  it('נתיבי /internal אינם משתמשים בהרשאות משתמש — הם מוגנים בסוד משותף', () => {
    const internal = collect(internalRouter);
    expect(internal.length).toBeGreaterThan(0);
    expect(internal.every((r) => !r.permission)).toBe(true);
  });
});

describe('מרשם סוגי התנאים תואם למסד', () => {
  it('כל 15 סוגי התנאים ממומשים בקוד', async () => {
    const { conditionCodes } = await import('../src/rules/registry.js');
    const expected = [
      'noOverlap', 'maxHoursPerDay', 'minRestHours', 'maxConsecutiveHours',
      'withinSiteHours', 'minNoticeDays', 'maxConstraintsPerWeek', 'requiresQualification',
      'mentorRatio', 'mandatoryTraining', 'availabilityRequired', 'deadline',
      'blackoutDates', 'minStaffCoverage', 'minShiftsPerCategory',
    ];
    expect(conditionCodes.sort()).toEqual(expected.sort());
  });
});

describe('מרשם הפעולות הניתנות לשחזור', () => {
  it('כל פעולה שחריגה יכולה לפרוק רשומה במרשם', async () => {
    // ייבוא ה-services רושם את הפעולות שלהם
    await Promise.all([
      import('../src/services/requests.service.js'),
      import('../src/services/availability.service.js'),
      import('../src/services/roster.service.js'),
      import('../src/services/activities.service.js'),
      import('../src/services/users.service.js'),
    ]);
    const { registeredTypes } = await import('../src/rules/actions.js');

    expect(registeredTypes()).toEqual([
      'activities.save',
      'availability.finalize',
      'mentors.assign',
      'requests.finalize',
      'roster.assign',
    ]);
  });
});
