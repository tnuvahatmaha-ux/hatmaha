/**
 * ייצוא CSV.
 *
 * ה-BOM בתחילת הקובץ הוא מה שגורם ל-Excel בעברית לפתוח את הקובץ
 * בקידוד הנכון במקום ג׳יבריש. בלעדיו הייצוא חסר ערך למשתמש הסופי.
 */
export function toCsv(rows) {
  if (!rows || rows.length === 0) return '﻿';

  const columns = Object.keys(rows[0]);
  const escape = (value) => `"${String(value ?? '').replace(/"/g, '""')}"`;

  const lines = [
    columns.map(escape).join(','),
    ...rows.map((row) => columns.map((c) => escape(row[c])).join(',')),
  ];

  return `﻿${lines.join('\r\n')}`;
}

/** שולח CSV כהורדה, עם שם קובץ שעובד גם כשהוא בעברית */
export function sendCsv(res, filename, rows) {
  const body = toCsv(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
  );
  res.send(body);
}
