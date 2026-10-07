import { AppError } from '../lib/errors.js';

/**
 * ולידציית קלט עם zod. מחליפה את req.body/query/params בערכים המפוענחים,
 * כך שכל מה שמגיע ל-service כבר תקין ומטופס.
 *
 * השגיאה מחזירה רשימת שדות, ולכן הלקוח יכול לסמן את השדה הבעייתי במקום
 * להציג הודעה כללית — זה מה שהיה חסר בפרוטוטייפ, שבו כפתור שמירה עם
 * קלט לא תקין פשוט לא עשה כלום.
 */
export function validate({ body, query, params }) {
  return (req, _res, next) => {
    try {
      if (params) req.params = parse(params, req.params, 'params');
      if (query) req.validQuery = parse(query, req.query, 'query');
      if (body) req.body = parse(body, req.body ?? {}, 'body');
      next();
    } catch (err) {
      next(err);
    }
  };
}

function parse(schema, value, where) {
  const result = schema.safeParse(value);
  if (result.success) return result.data;

  const fields = result.error.issues.map((i) => ({
    field: i.path.join('.') || where,
    message: i.message,
  }));

  throw new AppError('E_VALIDATION', fields[0]?.message ?? 'הנתונים שנשלחו אינם תקינים', {
    details: { fields },
  });
}
