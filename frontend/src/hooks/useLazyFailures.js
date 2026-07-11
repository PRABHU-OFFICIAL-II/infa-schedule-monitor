import { useState, useRef, useEffect } from 'react'
import { useAuth } from '../context/AuthContext'

const INFA_BATCH = 200
export const UI_PAGE_SIZE = 20

// Module-level cache — survives route navigation, cleared on logout or manual refresh
let _cache = null

export function clearActivityCache() {
  _cache = null
}

export function useLazyFailures() {
  const { session, logout } = useAuth()

  // Keep latest session/logout in refs so the async fetch always reads current values
  const sessionRef = useRef(session)
  const logoutRef  = useRef(logout)
  sessionRef.current = session
  logoutRef.current  = logout

  const [failures,      setFailures]      = useState(() => _cache?.failures      ?? [])
  const [counts,        setCounts]        = useState(() => _cache?.counts        ?? { successCount: 0, failedInfra: 0, failedOther: 0 })
  const [loadedBatches, setLoadedBatches] = useState(() => _cache?.loadedBatches ?? 0)
  const [totalFetched,  setTotalFetched]  = useState(() => _cache?.totalFetched  ?? 0)
  const [allDone,       setAllDone]       = useState(() => !!_cache)
  const [loading,       setLoading]       = useState(() => !_cache)
  const [error,         setError]         = useState(null)
  const [uiPage,        setUiPage]        = useState(1)
  // Incrementing this triggers the effect to re-run (used by reset())
  const [fetchKey,      setFetchKey]      = useState(0)

  useEffect(() => {
    // Per-invocation cancel flag — immune to StrictMode's double-invoke
    let cancelled = false

    async function run() {
      const session = sessionRef.current
      const logout  = logoutRef.current

      if (!session) { setLoading(false); return }

      // Serve from cache without hitting the network
      if (_cache) {
        setFailures(_cache.failures)
        setCounts(_cache.counts)
        setLoadedBatches(_cache.loadedBatches)
        setTotalFetched(_cache.totalFetched)
        setAllDone(true)
        setLoading(false)
        return
      }

      setLoading(true)
      setError(null)

      let offset = 0
      const allFailures = []
      const allCounts   = { successCount: 0, failedInfra: 0, failedOther: 0 }
      let batches = 0
      let fetched = 0

      while (!cancelled) {
        try {
          const res = await fetch(`/api/activity/failures?offset=${offset}`, {
            headers: {
              'x-session-id': session.icSessionId,
              'x-server-url': session.serverUrl,
            },
          })

          if (cancelled) break
          if (res.status === 401) { logout(); break }

          const data = await res.json()
          if (cancelled) break
          if (!res.ok) { setError(data.detail || 'Failed to load activity'); break }

          allFailures.push(...data.failures)
          allCounts.successCount += data.successCount
          allCounts.failedInfra  += data.failedInfra
          allCounts.failedOther  += data.failedOther
          batches += 1
          fetched += data.batchSize

          setTotalFetched(fetched)
          setLoadedBatches(batches)

          if (!data.hasMore) {
            _cache = {
              failures:      allFailures,
              counts:        allCounts,
              loadedBatches: batches,
              totalFetched:  fetched,
            }
            setFailures(allFailures)
            setCounts(allCounts)
            setAllDone(true)
            break
          }

          offset += INFA_BATCH
        } catch {
          if (!cancelled) setError('Network error — is the backend running?')
          break
        }
      }

      if (!cancelled) setLoading(false)
    }

    run()
    return () => { cancelled = true }
  }, [fetchKey]) // eslint-disable-line react-hooks/exhaustive-deps

  function reset() {
    _cache = null
    setFailures([])
    setCounts({ successCount: 0, failedInfra: 0, failedOther: 0 })
    setLoadedBatches(0)
    setTotalFetched(0)
    setAllDone(false)
    setLoading(true)
    setError(null)
    setUiPage(1)
    setFetchKey(k => k + 1) // triggers the effect to re-run with a fresh cancel flag
  }

  return {
    failures,
    counts,
    loadedBatches,
    totalFetched,
    allDone,
    loading,
    error,
    uiPage,
    setUiPage,
    reset,
  }
}
