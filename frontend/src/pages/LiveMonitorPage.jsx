import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../context/AuthContext'
import './LiveMonitorPage.css'

const POLL_INTERVAL = 30   // seconds between auto-refreshes

function fmtElapsed(secs) {
  if (secs == null || secs < 0) return '—'
  if (secs < 60)   return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ${secs % 60}s`
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}

function elapsedClass(secs) {
  if (secs == null) return ''
  if (secs > 7200) return 'elapsed-danger'   // > 2 h
  if (secs > 3600) return 'elapsed-warn'     // > 1 h
  return ''
}

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

// ── Live elapsed ticker per row ──────────────────────────────────────────
// Adds seconds locally every second so the elapsed column ticks in real time
// without re-fetching the API.
function ElapsedCell({ initialSecs }) {
  const [secs, setSecs] = useState(initialSecs ?? null)

  useEffect(() => {
    if (secs == null) return
    const id = setInterval(() => setSecs((s) => s + 1), 1000)
    return () => clearInterval(id)
  }, [])   // intentional: only start once on mount

  return (
    <span className={`elapsed-badge ${elapsedClass(secs)}`}>
      {fmtElapsed(secs)}
    </span>
  )
}

// ── Countdown to next poll ───────────────────────────────────────────────
function Countdown({ nextIn }) {
  const [remaining, setRemaining] = useState(nextIn)

  useEffect(() => {
    setRemaining(nextIn)
  }, [nextIn])

  useEffect(() => {
    const id = setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000)
    return () => clearInterval(id)
  }, [])

  return <span className="countdown">next refresh in {remaining}s</span>
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function LiveMonitorPage() {
  const { session, logout } = useAuth()

  const [jobs,      setJobs]      = useState([])
  const [fetchedAt, setFetchedAt] = useState(null)
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [paused,    setPaused]    = useState(false)
  const [nextIn,    setNextIn]    = useState(POLL_INTERVAL)

  const [filterName, setFilterName] = useState('')
  const [filterType, setFilterType] = useState('')

  const timerRef = useRef(null)

  const fetchJobs = useCallback(async () => {
    if (!session) return
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/activity/running', {
        headers: {
          'x-session-id': session.icSessionId,
          'x-server-url': session.serverUrl,
        },
      })
      if (res.status === 401) { logout(); return }
      const data = await res.json()
      if (!res.ok) { setError(data.detail || 'Failed to fetch'); return }
      setJobs(data.jobs || [])
      setFetchedAt(data.fetchedAt || new Date().toISOString())
      setNextIn(POLL_INTERVAL)
    } catch {
      setError('Network error — is the backend running?')
    } finally {
      setLoading(false)
    }
  }, [session, logout])

  // ── Auto-poll ────────────────────────────────────────────────────────
  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  useEffect(() => {
    if (paused) {
      clearInterval(timerRef.current)
      return
    }
    timerRef.current = setInterval(fetchJobs, POLL_INTERVAL * 1000)
    return () => clearInterval(timerRef.current)
  }, [paused, fetchJobs])

  // ── Filter ────────────────────────────────────────────────────────────
  const filtered = jobs.filter((j) => {
    const name = (j.objectName || j.taskName || '').toLowerCase()
    if (filterName && !name.includes(filterName.toLowerCase())) return false
    if (filterType && (j.type || '').toLowerCase() !== filterType.toLowerCase()) return false
    return true
  })

  const typeOptions = [...new Set(jobs.map((j) => j.type).filter(Boolean))].sort()

  return (
    <div className="live-page">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">
            Live Monitor
            <span className="live-dot" />
          </h2>
          <p className="page-sub">
            Currently running jobs · auto-refreshes every {POLL_INTERVAL}s
          </p>
        </div>
        <div className="header-right">
          {fetchedAt && !paused && <Countdown nextIn={nextIn} />}
          {fetchedAt && (
            <span className="fetched-at">Last fetched {fmt(fetchedAt)}</span>
          )}
          <button
            className={`pause-btn ${paused ? 'paused' : ''}`}
            onClick={() => setPaused((v) => !v)}
          >
            {paused ? '▶ Resume' : '⏸ Pause'}
          </button>
          <button className="refresh-btn" onClick={fetchJobs} disabled={loading}>
            {loading ? '⟳ …' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="dash-error"><strong>Error:</strong> {error}</div>}

      {/* ── Stat tiles ── */}
      <div className="live-tiles">
        <div className="live-tile tile-teal">
          <span className="tile-value">{jobs.length}</span>
          <span className="tile-label">Running Now</span>
        </div>
        <div className="live-tile tile-orange">
          <span className="tile-value">
            {jobs.filter((j) => j.elapsedSecs != null && j.elapsedSecs > 3600).length}
          </span>
          <span className="tile-label">Running &gt; 1h</span>
          <span className="tile-sub">may be stalled</span>
        </div>
        <div className="live-tile tile-red">
          <span className="tile-value">
            {jobs.filter((j) => j.elapsedSecs != null && j.elapsedSecs > 7200).length}
          </span>
          <span className="tile-label">Running &gt; 2h</span>
          <span className="tile-sub">investigate</span>
        </div>
      </div>

      {/* ── Table card ── */}
      <div className="table-card">
        <div className="table-header">
          <div>
            <h3>Active Jobs</h3>
            <span className="table-sub">
              {filtered.length} job{filtered.length !== 1 ? 's' : ''}
              {filterName || filterType ? ` (filtered from ${jobs.length})` : ''}
            </span>
          </div>
          {paused && <span className="paused-badge">⏸ Polling paused</span>}
        </div>

        {/* filters */}
        <div className="filters-bar">
          <input
            className="filter-input"
            placeholder="Search task name…"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
          />
          <select
            className="filter-select"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value)}
          >
            <option value="">All types</option>
            {typeOptions.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          {(filterName || filterType) && (
            <button className="clear-filters-btn" onClick={() => { setFilterName(''); setFilterType('') }}>
              ✕ Clear
            </button>
          )}
        </div>

        {loading && jobs.length === 0 && (
          <div className="table-loading">Fetching running jobs…</div>
        )}

        {!loading && jobs.length === 0 && (
          <div className="table-empty">
            <div className="no-jobs-icon">✓</div>
            <p>No jobs are currently running.</p>
          </div>
        )}

        {filtered.length > 0 && (
          <div className="table-scroll">
            <table className="live-table">
              <thead>
                <tr>
                  <th>Task Name</th>
                  <th>Type</th>
                  <th>Schedule / Trigger</th>
                  <th>Started At</th>
                  <th>Elapsed</th>
                  <th>Agent</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((job, i) => {
                  const name = job.objectName || job.taskName || '—'
                  const longRunning = job.elapsedSecs > 3600
                  return (
                    <tr key={job.id || i} className={longRunning ? 'row-long' : ''}>
                      <td className="col-name" title={name}>{name}</td>
                      <td><span className="task-type-badge">{job.type || '—'}</span></td>
                      <td className="col-schedule">
                        {job.scheduleName
                          ? job.scheduleName
                          : <span className="run-context-badge">{job.runContextType || 'manual'}</span>}
                      </td>
                      <td className="col-time">{fmt(job.startTimeUtc || job.startTime)}</td>
                      <td><ElapsedCell initialSecs={job.elapsedSecs} /></td>
                      <td className="col-light">{job.agentName || job.agentId || '—'}</td>
                      <td>
                        <span className="running-badge">
                          <span className="running-dot" /> Running
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
