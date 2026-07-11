import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../context/AuthContext'

export function useInfaFetch(path, { skip = false } = {}) {
  const { session, logout } = useAuth()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  // Stable ref to always read latest session without recreating the effect
  const sessionRef = useRef(session)
  const logoutRef  = useRef(logout)
  sessionRef.current = session
  logoutRef.current  = logout

  // refetchCounter lets the manual refetch() trigger a fresh run
  const [refetchCounter, setRefetchCounter] = useState(0)

  useEffect(() => {
    let cancelled = false
    const session = sessionRef.current
    const logout  = logoutRef.current

    if (!session || skip) return

    setLoading(true)
    setError(null)

    fetch(path, {
      headers: {
        'x-session-id': session.icSessionId,
        'x-server-url': session.serverUrl,
      },
    })
      .then(res => {
        if (cancelled) return
        if (res.status === 401) { logout(); return }
        return res.json().then(json => {
          if (cancelled) return
          if (!res.ok) { setError(json.detail || 'Request failed'); return }
          setData(json)
        })
      })
      .catch(() => { if (!cancelled) setError('Network error — is the backend running?') })
      .finally(() => { if (!cancelled) setLoading(false) })

    return () => { cancelled = true }
  }, [path, skip, refetchCounter]) // eslint-disable-line react-hooks/exhaustive-deps

  const refetch = useCallback(() => {
    setRefetchCounter(c => c + 1)
  }, [])

  return { data, loading, error, refetch }
}
