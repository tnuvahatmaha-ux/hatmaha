import { AppError } from './errors.js';

/**
 * נעילה אופטימית. §13: "עדכונים רגישים יתמכו ב-Version או ETag".
 *
 * row_version מתקדם בטריגר בכל עדכון, ולכן ETag נגזר ממנו נאמן תמיד —
 * גם אם השורה שונתה ממקום אחר לגמרי.
 */

export const toETag = (rowVersion) => `W/"${rowVersion}"`;

export function setETag(res, row) {
  if (row?.row_version != null) res.setHeader('ETag', toETag(row.row_version));
  return row;
}

/** מחלץ את מספר הגרסה מכותרת If-Match */
export function parseIfMatch(req) {
  const header = req.get('if-match');
  if (!header) return null;
  const match = header.match(/"?(\d+)"?/);
  return match ? Number(match[1]) : null;
}

/**
 * מוודא שהלקוח עורך את הגרסה שהוא באמת ראה.
 *
 * @param {object} req
 * @param {object} row       השורה הנוכחית מהמסד
 * @param {object} [opts]
 * @param {boolean} [opts.required]  לחייב If-Match; ברירת המחדל: רק לבדוק אם נשלח
 */
export function assertIfMatch(req, row, { required = false } = {}) {
  const expected = parseIfMatch(req);

  if (expected == null) {
    if (required) {
      throw new AppError('E_CONFLICT', 'העריכה דורשת ציון גרסה (If-Match)');
    }
    return;
  }

  if (expected !== row.row_version) {
    throw new AppError(
      'E_CONFLICT',
      'הרשומה עודכנה בינתיים על ידי משתמש אחר. רענן/י את הדף ונסה/י שוב.',
      { details: { expected, actual: row.row_version } },
    );
  }
}
