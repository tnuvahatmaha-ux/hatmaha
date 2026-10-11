import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

import { AuthProvider } from './context/AuthContext.jsx';
import { PermissionsProvider } from './context/PermissionsContext.jsx';
import { ToastProvider } from './context/ToastContext.jsx';
import { ProtectedRoute, RequirePermission } from './components/ProtectedRoute.jsx';
import { AppLayout } from './components/layout/AppLayout.jsx';

import Login from './pages/auth/Login.jsx';
import Register from './pages/auth/Register.jsx';
import ForgotPassword from './pages/auth/ForgotPassword.jsx';
import ResetPassword from './pages/auth/ResetPassword.jsx';
import DevLogin from './pages/auth/DevLogin.jsx';
import LocalModeUnavailable from './pages/auth/LocalModeUnavailable.jsx';
import { isLocalAuth } from './lib/authMode.js';

import Home from './pages/Home.jsx';
import Dashboard from './pages/Dashboard.jsx';
import MySchedule from './pages/MySchedule.jsx';
import TeamSchedule from './pages/TeamSchedule.jsx';
import MyTeam from './pages/MyTeam.jsx';
import Requests from './pages/Requests.jsx';
import Approvals from './pages/Approvals.jsx';
import Activities from './pages/Activities.jsx';
import Roster from './pages/Roster.jsx';
import Sites from './pages/Sites.jsx';
import Implementers from './pages/Implementers.jsx';
import Reports from './pages/Reports.jsx';
import Notifications from './pages/Notifications.jsx';
import Profile from './pages/Profile.jsx';
import Messages from './pages/Messages.jsx';
import Skills from './pages/Skills.jsx';
import Settings from './pages/settings/index.jsx';

/**
 * שורש האפליקציה.
 *
 * כל נתיב מוגן פעמיים: ProtectedRoute מוודא התחברות, RequirePermission
 * מוודא הרשאה, והשרת בודק שוב בכל בקשה. הסתרת פריט בתפריט היא נוחות,
 * לא אכיפה.
 */
export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <ToastProvider>
          <PermissionsProvider>
            <Routes>
              {/* מסכי הזדהות — ללא מעטפת האפליקציה */}
              <Route path="/login" element={isLocalAuth ? <DevLogin /> : <Login />} />
              <Route path="/register" element={isLocalAuth ? <LocalModeUnavailable /> : <Register />} />
              <Route path="/forgot-password" element={isLocalAuth ? <LocalModeUnavailable /> : <ForgotPassword />} />
              <Route path="/reset-password" element={isLocalAuth ? <LocalModeUnavailable /> : <ResetPassword />} />

              <Route
                element={
                  <ProtectedRoute>
                    <AppLayout />
                  </ProtectedRoute>
                }
              >
                <Route index element={<Home />} />
                <Route path="schedule" element={<MySchedule />} />
                <Route path="profile" element={<Profile />} />
                <Route path="notifications" element={<Notifications />} />
                <Route path="messages" element={<Messages />} />
                <Route
                  path="skills"
                  element={<RequirePermission resource="skills" action="view"><Skills /></RequirePermission>}
                />

                <Route
                  path="dashboard"
                  element={<RequirePermission resource="reports" action="view"><Dashboard /></RequirePermission>}
                />
                <Route
                  path="team-schedule"
                  element={<RequirePermission resource="teamSchedule" action="view"><TeamSchedule /></RequirePermission>}
                />
                <Route
                  path="my-team"
                  element={<RequirePermission resource="implementers" action="view"><MyTeam /></RequirePermission>}
                />
                <Route
                  path="requests"
                  element={<RequirePermission resource="requests" action="create"><Requests /></RequirePermission>}
                />
                <Route
                  path="approvals"
                  element={<RequirePermission resource="requests" action="approve"><Approvals /></RequirePermission>}
                />
                <Route
                  path="activities"
                  element={<RequirePermission resource="activities" action="view"><Activities /></RequirePermission>}
                />
                <Route
                  path="roster"
                  element={<RequirePermission resource="roster" action="view"><Roster /></RequirePermission>}
                />
                <Route
                  path="sites"
                  element={<RequirePermission resource="sites" action="view"><Sites /></RequirePermission>}
                />
                <Route
                  path="implementers"
                  element={<RequirePermission resource="users" action="view"><Implementers /></RequirePermission>}
                />
                <Route
                  path="reports"
                  element={<RequirePermission resource="reports" action="view"><Reports /></RequirePermission>}
                />
                <Route
                  path="settings"
                  element={<RequirePermission resource="settings" action="view"><Settings /></RequirePermission>}
                />
              </Route>

              {/* נתיב לא מוכר — חזרה לבית, ולא מסך שבור */}
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          </PermissionsProvider>
        </ToastProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
