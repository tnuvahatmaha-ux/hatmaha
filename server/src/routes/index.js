import { Router } from 'express';
import { authRouter } from './auth.js';
import { permissionsRouter } from './permissions.js';
import { usersRouter } from './users.js';
import { sitesRouter } from './sites.js';
import { settingsRouter } from './settings.js';
import { mentorsRouter } from './mentors.js';
import { activitiesRouter } from './activities.js';
import { availabilityRouter } from './availability.js';
import { requestsRouter } from './requests.js';
import { exceptionsRouter } from './exceptions.js';
import { rulesRouter } from './rules.js';
import { rosterRouter } from './roster.js';
import { scheduleRouter } from './schedule.js';
import { reportsRouter } from './reports.js';
import { notificationsRouter } from './notifications.js';
import { auditRouter } from './audit.js';
import { updatesRouter } from './updates.js';
import { chatRouter } from './chat.js';
import { skillsRouter } from './skills.js';

/**
 * טבלת ההרכבה, כדאטה.
 *
 * גם האפליקציה וגם בדיקת כיסוי ההרשאות קוראות מכאן, ולכן אין דרך
 * שנתיב יהיה מותקן באפליקציה אך לא ייבדק — או להפך.
 *
 * הסדר משמעותי: '/settings/mentors' חייב להירשם לפני '/settings',
 * אחרת הנתיב הכללי יתפוס קודם.
 */
export const API_ROUTES = [
  ['/auth', authRouter],
  ['/users', usersRouter],
  ['/permissions', permissionsRouter],
  ['/sites', sitesRouter],
  // AC-08: ניהול מדריכים יושב תחת הגדרות ולא כמודול ניווט עצמאי
  ['/settings/mentors', mentorsRouter],
  ['/settings', settingsRouter],
  ['/activities', activitiesRouter],
  ['/availability', availabilityRouter],
  ['/requests', requestsRouter],
  ['/exceptions', exceptionsRouter],
  ['/rules', rulesRouter],
  ['/roster', rosterRouter],
  ['/schedule', scheduleRouter],
  ['/reports', reportsRouter],
  ['/notifications', notificationsRouter],
  ['/updates', updatesRouter],
  ['/chat', chatRouter],
  ['/skills', skillsRouter],
  ['/audit', auditRouter],
];

export const apiRouter = Router();
for (const [path, router] of API_ROUTES) apiRouter.use(path, router);
