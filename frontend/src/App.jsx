import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { KibanaProvider, useKibana } from './context/KibanaContext'
import AppShell from './components/AppShell'
import SupportShell from './components/SupportShell'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import SchedulesPage from './pages/SchedulesPage'
import MissedRunsPage from './pages/MissedRunsPage'
import InvestigatePage from './pages/InvestigatePage'

function AppRouter() {
  const { isAuthenticated } = useAuth()
  const { isKibanaConnected } = useKibana()

  // Support mode: Kibana (Okta) login only — no IICS session required
  if (isKibanaConnected) {
    return (
      <Routes>
        <Route path="/support" element={<SupportShell />}>
          <Route index element={<Navigate to="/support/investigate" replace />} />
          <Route path="investigate" element={<InvestigatePage />} />
        </Route>
        <Route path="*" element={<Navigate to="/support/investigate" replace />} />
      </Routes>
    )
  }

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

  // Normal user mode
  return (
    <Routes>
      <Route path="/app" element={<AppShell />}>
        <Route index element={<Navigate to="/app/dashboard" replace />} />
        <Route path="dashboard"   element={<DashboardPage />} />
        <Route path="schedules"   element={<SchedulesPage />} />
        <Route path="missed-runs" element={<MissedRunsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/app/dashboard" replace />} />
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
