import { createContext, useContext, useState, useCallback } from 'react'
import { clearActivityCache } from '../hooks/useLazyFailures'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(() => {
    try {
      const stored = sessionStorage.getItem('infa_session')
      return stored ? JSON.parse(stored) : null
    } catch {
      return null
    }
  })

  const login = useCallback((sessionData) => {
    sessionStorage.setItem('infa_session', JSON.stringify(sessionData))
    setSession(sessionData)
  }, [])

  const logout = useCallback(async () => {
    if (session) {
      try {
        await fetch(
          `/api/auth/logout?server_url=${encodeURIComponent(session.serverUrl)}&session_id=${encodeURIComponent(session.icSessionId)}`,
          { method: 'POST' }
        )
      } catch {
        // best-effort logout
      }
    }
    clearActivityCache()
    sessionStorage.removeItem('infa_session')
    setSession(null)
  }, [session])

  return (
    <AuthContext.Provider value={{ session, login, logout, isAuthenticated: !!session }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
