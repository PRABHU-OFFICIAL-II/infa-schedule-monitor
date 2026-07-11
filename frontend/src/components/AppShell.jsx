import { useState } from 'react'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useAuth } from '../context/AuthContext'
import { useKibana } from '../context/KibanaContext'
import './AppShell.css'

const NAV_ITEMS = [
  { to: '/app/dashboard',   icon: '▣', label: 'Dashboard'   },
  { to: '/app/schedules',   icon: '◷', label: 'Schedules'   },
  { to: '/app/missed-runs', icon: '⚠', label: 'Missed Runs' },
]

export default function AppShell() {
  const { session, logout } = useAuth()
  const { isKibanaConnected, disconnectKibana } = useKibana()
  const navigate = useNavigate()
  const [collapsed, setCollapsed] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)

  async function handleLogout() {
    setLoggingOut(true)
    await logout()
    navigate('/login')
  }

  const providerClass = session?.cloudProvider?.toLowerCase() || 'aws'
  const initials = [session?.firstName?.[0], session?.lastName?.[0]].filter(Boolean).join('') || '?'

  return (
    <div className={`shell ${collapsed ? 'shell-collapsed' : ''}`}>

      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <span className="sidebar-logo">⚡</span>
          {!collapsed && <span className="sidebar-title">INFA Monitor</span>}
          <button className="collapse-btn" onClick={() => setCollapsed((c) => !c)} title="Toggle sidebar">
            {collapsed ? '»' : '«'}
          </button>
        </div>

        <nav className="sidebar-nav">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-item ${isActive ? 'nav-active' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              {!collapsed && <span className="nav-label">{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <button className="logout-btn" onClick={handleLogout} disabled={loggingOut} title="Logout">
            {loggingOut
              ? <><span className="logout-spinner" />{!collapsed && <span>Signing out…</span>}</>
              : <><span className="nav-icon">⏻</span>{!collapsed && <span>Logout</span>}</>
            }
          </button>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="shell-main">

        {/* Topbar */}
        <header className="topbar">
          <div className="topbar-left">
            {/* page title injected via CSS :has — nothing needed here */}
          </div>
          <div className="topbar-right">
            {isKibanaConnected && (
              <button className="kibana-badge" onClick={disconnectKibana} title="Click to disconnect Kibana support session">
                <span className="kibana-dot" />
                Kibana connected
              </button>
            )}
            <div className="session-info">
              <span className={`provider-badge provider-${providerClass}`}>
                {session?.cloudProvider}
              </span>
              <span className="session-region">{session?.regionLabel}</span>
              <div className="session-org-block">
                <span className="session-org-row" title="Organisation ID">
                  <span className="org-label">Org ID</span>
                  <span className="org-value">{session?.orgId}</span>
                </span>
                <span className="session-org-row" title="Organisation UUID">
                  <span className="org-label">Org UUID</span>
                  <span className="org-value">{session?.orgUuid}</span>
                </span>
              </div>
            </div>
            <div className="user-pill" title={session?.name}>
              <span className="user-avatar">{initials}</span>
              <span className="user-name">{session?.firstName} {session?.lastName}</span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="shell-content">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
