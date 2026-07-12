import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { AuthProvider, useAuth } from './context/AuthContext'
import { KibanaProvider } from './context/KibanaContext'
import AppShell from './components/AppShell'
import LoginPage from './pages/LoginPage'
import DashboardPage from './pages/DashboardPage'
import SchedulesPage from './pages/SchedulesPage'
import MissedRunsPage from './pages/MissedRunsPage'

function AppRouter() {
  const { isAuthenticated } = useAuth()

  if (!isAuthenticated) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    )
  }

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
