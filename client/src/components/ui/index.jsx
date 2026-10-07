import { useEffect, useRef, useState, useId } from 'react';

/* ==========================================================================
   רכיבי בסיס
   ========================================================================== */

export function Panel({ title, subtitle, actions, children, flush = false, className = '' }) {
  return (
    <section className={`panel ${className}`}>
      {(title || actions) && (
        <div className="panel-head">
          <div>
            {title && <h2>{title}</h2>}
            {subtitle && <p className="small muted">{subtitle}</p>}
          </div>
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      <div className={`panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Tag({ tone = '', children, title }) {
  return (
    <span className={`tag${tone ? ` tag-${tone}` : ''}`} title={title}>
      {children}
    </span>
  );
}

export function Notice({ tone = '', title, children, icon }) {
  return (
    <div className={`notice${tone ? ` notice-${tone}` : ''}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon && <span aria-hidden="true">{icon}</span>}
      <div style={{ flex: 1 }}>
        {title && <div className="notice-title">{title}</div>}
        {children}
      </div>
    </div>
  );
}

/**
 * שדה טופס.
 * שגיאה נקשרת לשדה דרך aria-describedby, כך שקורא מסך מקריא אותה —
 * ולא רק מי שרואה את הצבע האדום.
 */
export function Field({ label, error, hint, required, children, htmlFor }) {
  const generated = useId();
  const id = htmlFor ?? generated;
  const describedBy = [error && `${id}-error`, hint && `${id}-hint`].filter(Boolean).join(' ');

  return (
    <div className="field">
      <label htmlFor={id}>
        {label}
        {required && <span aria-hidden="true" style={{ color: 'var(--danger)' }}> *</span>}
      </label>
      {typeof children === 'function'
        ? children({ id, 'aria-invalid': !!error, 'aria-describedby': describedBy || undefined })
        : children}
      {hint && (
        <div className="field-hint" id={`${id}-hint`}>
          {hint}
        </div>
      )}
      {error && (
        <div className="field-error" id={`${id}-error`} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}

/* ==========================================================================
   מצבי מסך — AC-14: "כל מסך כולל מצבי טעינה, ריק, שגיאה וחוסר הרשאה"
   ========================================================================== */

export function Loading({ text = 'טוען…' }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <div className="spinner" aria-hidden="true" />
      <div className="state-text">{text}</div>
    </div>
  );
}

export function Empty({ icon = '📭', title = 'אין כאן עדיין כלום', text, action }) {
  return (
    <div className="state">
      <div className="state-icon" aria-hidden="true">{icon}</div>
      <div className="state-title">{title}</div>
      {text && <div className="state-text">{text}</div>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  const isForbidden = error?.code === 'E_FORBIDDEN';
  const isNetwork = ['E_NETWORK', 'E_TIMEOUT'].includes(error?.code);

  return (
    <div className="state">
      <div className="state-icon" aria-hidden="true">{isForbidden ? '🔒' : isNetwork ? '📡' : '⚠️'}</div>
      <div className="state-title">
        {isForbidden ? 'אין לך הרשאה' : isNetwork ? 'אין חיבור לשרת' : 'משהו השתבש'}
      </div>
      <div className="state-text">{error?.message ?? 'אירעה שגיאה בלתי צפויה'}</div>
      {error?.traceId && <div className="tiny muted">מזהה מעקב: {error.traceId}</div>}
      {onRetry && !isForbidden && (
        <button type="button" className="btn" onClick={onRetry}>
          נסה/י שוב
        </button>
      )}
    </div>
  );
}

export function Forbidden({ text = 'הפריט המבוקש נמצא מחוץ להרשאות שלך.' }) {
  return (
    <div className="state">
      <div className="state-icon" aria-hidden="true">🔒</div>
      <div className="state-title">אין לך הרשאה</div>
      <div className="state-text">{text}</div>
    </div>
  );
}

/**
 * עוטף מסך ומכסה את ארבעת המצבים בבת אחת.
 * כל מסך במערכת עובר דרכו, ולכן אין מסך שמציג ריק לבן כשמשהו נכשל.
 */
export function StateView({ loading, error, empty, emptyProps, onRetry, children }) {
  if (loading) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (empty) return <Empty {...emptyProps} />;
  return children;
}

/* ==========================================================================
   חלונית
   ========================================================================== */

/**
 * מודאל עם לכידת מיקוד, סגירה ב-Escape ונעילת גלילה — שלושת הדברים
 * שחסרו בפרוטוטייפ והפכו אותו לבלתי שמיש במקלדת.
 */
export function Modal({ title, onClose, children, footer, width = 560 }) {
  const ref = useRef(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const { overflow } = document.body.style;
    document.body.style.overflow = 'hidden';

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = ref.current?.querySelectorAll(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    // המיקוד עובר אל תוך החלונית, כדי שניווט במקלדת ימשיך מהמקום הנכון
    setTimeout(() => {
      const target = ref.current?.querySelector(
        'input:not(:disabled), select:not(:disabled), textarea:not(:disabled), button:not(:disabled)',
      );
      target?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.body.style.overflow = overflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={ref}
      >
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="סגירה">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/** אישור לפעולה שקשה לחזור ממנה */
export function ConfirmDialog({ title, message, confirmLabel = 'אישור', tone = 'danger', onConfirm, onCancel, busy }) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      width={440}
      footer={
        <>
          <button type="button" className={`btn btn-${tone}`} onClick={onConfirm} disabled={busy}>
            {busy ? 'מבצע…' : confirmLabel}
          </button>
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            ביטול
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}

/* ==========================================================================
   עזרים
   ========================================================================== */

/** מתגי בחירה — נגישים במקלדת, בשונה מ-div לחיץ */
export function Segmented({ options, value, onChange, label }) {
  return (
    <div className="row" role="group" aria-label={label} style={{ gap: 0 }}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={`btn btn-sm${value === option.value ? ' btn-primary' : ''}`}
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          style={{ marginInlineStart: -2 }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** ניווט שבועי. החצים הפוכים בכוונה — ב-RTL "אחורה" הוא ימינה. */
export function WeekNav({ label, onPrev, onNext, onToday }) {
  return (
    <div className="row" role="group" aria-label="ניווט בין שבועות">
      <button type="button" className="btn btn-sm" onClick={onPrev} aria-label="השבוע הקודם">
        ›
      </button>
      <span className="bold small nowrap tnum" style={{ minWidth: 118, textAlign: 'center' }}>
        {label}
      </span>
      <button type="button" className="btn btn-sm" onClick={onNext} aria-label="השבוע הבא">
        ‹
      </button>
      {onToday && (
        <button type="button" className="btn btn-sm btn-ghost" onClick={onToday}>
          היום
        </button>
      )}
    </div>
  );
}

/** בחירה מרובה כצ׳יפים */
export function ChipPicker({ options, selected, onToggle, emptyText = 'אין אפשרויות זמינות' }) {
  if (!options.length) return <p className="small muted">{emptyText}</p>;

  return (
    <div className="row" style={{ gap: 6 }}>
      {options.map((option) => {
        const on = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            className={`btn btn-sm${on ? ' btn-primary' : ''}`}
            onClick={() => onToggle(option.value)}
            aria-pressed={on}
          >
            {on && <span aria-hidden="true">✓</span>}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** אקורדיון נגיש */
export function Accordion({ title, meta, children, defaultOpen = false, actions }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();

  return (
    <div style={{ borderBlockEnd: '2px solid var(--ink)' }}>
      <div className="panel-head" style={{ borderBlockEnd: open ? '2px solid var(--ink)' : 'none' }}>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={id}
          style={{ flex: 1, justifyContent: 'flex-start', boxShadow: 'none' }}
        >
          <span aria-hidden="true">{open ? '▾' : '◂'}</span>
          <span className="bold">{title}</span>
          {meta && <span className="small muted">{meta}</span>}
        </button>
        {actions && <div className="row">{actions}</div>}
      </div>
      {open && (
        <div id={id} className="panel-body">
          {children}
        </div>
      )}
    </div>
  );
}
