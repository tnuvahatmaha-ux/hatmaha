import noOverlap from './conditions/noOverlap.js';
import maxHoursPerDay from './conditions/maxHoursPerDay.js';
import minRestHours from './conditions/minRestHours.js';
import maxConsecutiveHours from './conditions/maxConsecutiveHours.js';
import withinSiteHours from './conditions/withinSiteHours.js';
import minNoticeDays from './conditions/minNoticeDays.js';
import maxConstraintsPerWeek from './conditions/maxConstraintsPerWeek.js';
import requiresQualification from './conditions/requiresQualification.js';
import mentorRatio from './conditions/mentorRatio.js';
import mandatoryTraining from './conditions/mandatoryTraining.js';
import availabilityRequired from './conditions/availabilityRequired.js';
import deadline from './conditions/deadline.js';
import blackoutDates from './conditions/blackoutDates.js';
import minStaffCoverage from './conditions/minStaffCoverage.js';
import minShiftsPerCategory from './conditions/minShiftsPerCategory.js';

/**
 * מרשם סוגי התנאים.
 *
 * הקוד של כל תנאי חייב להתאים לשורה בטבלת rule_condition_types, ובדיקה
 * ב-tests מוודאת שהשניים לא נפרדו. הוספת סוג תנאי היא קובץ כאן ושורה שם.
 */
const modules = [
  noOverlap, maxHoursPerDay, minRestHours, maxConsecutiveHours, withinSiteHours,
  minNoticeDays, maxConstraintsPerWeek, requiresQualification, mentorRatio,
  mandatoryTraining, availabilityRequired, deadline, blackoutDates, minStaffCoverage,
  minShiftsPerCategory,
];

export const conditionRegistry = new Map(modules.map((m) => [m.code, m]));
export const conditionCodes = modules.map((m) => m.code);

export function getCondition(code) {
  return conditionRegistry.get(code);
}
