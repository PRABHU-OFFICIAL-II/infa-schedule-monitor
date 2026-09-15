import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { KibanaProvider } from './context/KibanaContext'
import AppShell from './components/AppShell'
import SupportShell from './components/SupportShell'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import SchedulesPage from './pages/SchedulesPage'
import MissedRunsPage from './pages/MissedRunsPage'
import InvestigatePage from './pages/InvestigatePage'

function AppRouter() {
  const { isAuthenticated } = useAuth()

  return (
    <Routes>
      {/* Login — always accessible */}
      <Route path="/login" element={<LoginPage />} />

      {/* Support routes — no IICS auth required; Kibana session enforced internally */}
      <Route path="/support" element={<SupportShell />}>
        <Route index element={<Navigate to="/support/investigate" replace />} />
        <Route path="investigate" element={<InvestigatePage />} />
      </Route>

      {/* Customer app — requires IICS auth */}
      <Route
        path="/app"
        element={isAuthenticated ? <AppShell /> : <Navigate to="/login" replace />}
      >
        <Route index element={<Navigate to="/app/dashboard" replace />} />
        <Route path="dashboard"   element={<DashboardPage />} />
        <Route path="schedules"   element={<SchedulesPage />} />
        <Route path="missed-runs" element={<MissedRunsPage />} />
      </Route>

      <Route path="*" element={<Navigate to={isAuthenticated ? '/app/dashboard' : '/login'} replace />} />
    </Routes>
  )
}

function App() {
  return (
    <AuthProvider>
      <KibanaProvider>
        <BrowserRouter>
          <AppRouter />
        </BrowserRouter>
      </KibanaProvider>
    </AuthProvider>
  )
}

export default App
