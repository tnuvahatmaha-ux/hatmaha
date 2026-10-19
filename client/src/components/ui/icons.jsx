import {
  AlertTriangle, Info, Lock, Building2, Clock, MapPin, Scale, Coffee, AlarmClock, FlaskConical,
  Puzzle, Rocket, CalendarDays, KeyRound, Mail, FileText, User, Moon, Check, OctagonX, Hourglass,
  X, Inbox, WifiOff, Home, LayoutDashboard, Calendar, Users, GraduationCap, ClipboardList,
  CheckCircle2, BookOpen, LayoutGrid, Hospital, UserCog, BarChart3, Bell, Settings, MessageSquare,
  Sparkles, Gauge, ListChecks,
} from 'lucide-react';

/**
 * האייקונים של המערכת — סט אחיד בסגנון SF Symbols (lucide), במקום אמוג'י
 * שמוצגים אחרת בכל מערכת הפעלה.
 *
 * המסכים עדיין מעבירים "icon" כתו (⚠, ℹ, 🔒…), כדי שהקוד שלהם יישאר קריא.
 * כאן התו מתורגם לאייקון; תו שאינו מוכר מוצג כמות שהוא.
 */
const BY_GLYPH = {
  '⚠': AlertTriangle, '⚠️': AlertTriangle, 'ℹ': Info, '🔒': Lock, '🔐': KeyRound,
  '🏥': Building2, '🕐': Clock, '⏰': AlarmClock, '📍': MapPin, '⚖️': Scale, '☕': Coffee,
  '🧪': FlaskConical, '🧩': Puzzle, '🚀': Rocket, '🗓️': CalendarDays, '📧': Mail, '📝': FileText,
  '👤': User, '🌙': Moon, '✓': Check, '✕': X, '⛔': OctagonX, '⏳': Hourglass, '📭': Inbox,
  '📡': WifiOff, '💬': MessageSquare, '✨': Sparkles,
};

export function GlyphIcon({ value, size = 18 }) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  const Cmp = BY_GLYPH[value];
  return Cmp ? <Cmp className="icon" size={size} aria-hidden="true" /> : <span aria-hidden="true">{value}</span>;
}

/** אייקוני הניווט, לפי נתיב */
export const NAV_ICONS = {
  '/': Home,
  '/dashboard': LayoutDashboard,
  '/my-schedule': Calendar,
  '/team-schedule': Users,
  '/my-team': GraduationCap,
  '/requests': ClipboardList,
  '/approvals': CheckCircle2,
  '/activities': BookOpen,
  '/roster': LayoutGrid,
  '/sites': Hospital,
  '/people': UserCog,
  '/implementers': UserCog,
  '/messages': MessageSquare,
  '/skills': Gauge,
  '/training': ListChecks,
  '/reports': BarChart3,
  '/notifications': Bell,
  '/settings': Settings,
  '/profile': User,
};
