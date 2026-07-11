import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useKibana } from '../context/KibanaContext'
import './SupportShell.css'

export default function SupportShell() {
  const { session, logout } = useAuth()
  const { disconnectKibana } = useKibana()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    disconnectKibana()
    await logout()
    navigate('/login')
  }

  const initials = [session?.firstName?.[0], session?.lastName?.[0]].filter(Boolean).join('') || 'S'

  return (
    <div className={`support-shell ${collapsed ? 'support-collapsed' : ''}`}>

      {/* ── Sidebar ── */}
      <aside className="support-sidebar">
        <div className="support-sidebar-header">
          <span className="support-logo">🛠</span>
          {!collapsed && (
            <div className="support-title-block">
              <span className="support-title">INFA Monitor</span>
              <span className="support-mode-badge">Support Mode</span>
            </div>
          )}
          <button className="support-collapse-btn" onClick={() => setCollapsed(c => !c)}>
            {collapsed ? '»' : '«'}
          </button>
        </div>

        <nav className="support-nav">
          <NavLink
            to="/support/investigate"
            className={({ isActive }) => `support-nav-item ${isActive ? 'support-nav-active' : ''}`}
            title={collapsed ? 'Investigate' : undefined}
          >
            <span className="support-nav-icon">🔍</span>
            {!collapsed && <span className="support-nav-label">Investigate</span>}
          </NavLink>
        </nav>

        <div className="support-sidebar-footer">
          {!collapsed && (
            <div className="support-session-info">
              <span className="support-session-label">Logged in as</span>
              <span className="support-session-name">{session?.firstName} {session?.lastName}</span>
              <span className="support-session-org">{session?.regionLabel}</span>
            </div>
          )}
          <button className="support-logout-btn" onClick={handleLogout} disabled={loggingOut}>
            {loggingOut
              ? <><span className="support-logout-spinner" />{!collapsed && <span>Signing out…</span>}</>
              : <><span className="support-nav-icon">⏻</span>{!collapsed && <span>Logout</span>}</>
            }
          </button>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="support-main">
        <header className="support-topbar">
          <div className="support-topbar-left">
            <span className="support-topbar-badge">🛠 Support Investigation</span>
          </div>
          <div className="support-topbar-right">
            <div className="support-kibana-pill">
              <span className="support-kibana-dot" />
              <span>Kibana connected</span>
            </div>
            <div className="support-user-pill">
              <span className="support-user-avatar">{initials}</span>
              <span className="support-user-name">{session?.firstName} {session?.lastName}</span>
            </div>
          </div>
        </header>

        <main className="support-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
