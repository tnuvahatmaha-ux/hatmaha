-- =============================================================================
-- 0024 — פעילות של כמה ימים
--
-- פעילות שנקבעה לטווח ימים נשמרת כפעילות נפרדת לכל יום (כדי שהלו״ז, הנוכחות
-- והחוקים ימשיכו לעבוד יום-יום), ו-series_id מקשר ביניהן — להצגת "יום 2 מתוך 5"
-- ולביטול הסדרה כולה בפעולה אחת.
-- =============================================================================

alter table activities add column if not exists series_id uuid;

create index if not exists activities_series_idx
  on activities (series_id) where series_id is not null and deleted_at is null;
