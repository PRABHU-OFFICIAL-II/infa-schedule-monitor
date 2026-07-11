import { createContext, useContext, useState, useCallback } from 'react'

const KibanaContext = createContext(null)

export function KibanaProvider({ children }) {
  const [kibanaSession, setKibanaSession] = useState(() => {
    try {
      const s = sessionStorage.getItem('kibana_session')
      return s ? JSON.parse(s) : null
    } catch {
      return null
    }
  })

  const connectKibana = useCallback((data) => {
    sessionStorage.setItem('kibana_session', JSON.stringify(data))
    setKibanaSession(data)
  }, [])

  const disconnectKibana = useCallback(() => {
    sessionStorage.removeItem('kibana_session')
    setKibanaSession(null)
  }, [])

  return (
    <KibanaContext.Provider value={{
      kibanaSession,
      connectKibana,
      disconnectKibana,
      isKibanaConnected: !!kibanaSession,
      // IDMC session tokens entered by support user
      userSession: kibanaSession?.userSession ?? null,
      xsrfToken:   kibanaSession?.xsrfToken   ?? null,
    }}>
      {children}
    </KibanaContext.Provider>
  )
}

export function useKibana() {
  const ctx = useContext(KibanaContext)
  if (!ctx) throw new Error('useKibana must be inside KibanaProvider')
  return ctx
}
