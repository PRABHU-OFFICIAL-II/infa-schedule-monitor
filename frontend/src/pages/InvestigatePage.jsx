import { useState, Fragment } from 'react'
import { useKibana } from '../context/KibanaContext'
import './InvestigatePage.css'

// ── helpers ───────────────────────────────────────────────────────────────
function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function toLocalInput(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const PRESETS = [
  { label: 'Last 1 h',  hours: 1   },
  { label: 'Last 6 h',  hours: 6   },
  { label: 'Last 24 h', hours: 24  },
  { label: 'Last 48 h', hours: 48  },
  { label: 'Last 7 d',  hours: 168 },
  { label: 'Last 30 d', hours: 720 },
]

/**
 * Build KQL using orgId + "runContext":"SCHEDULER" as the reliable base.
 *
 * All scheduler-triggered job logs contain this JSON fragment in the message.
 * Optionally narrow by task name or error state.
 */
function buildKql(sched, taskName, errorsOnly) {
  const parts = []

  if (sched.orgId) parts.push(`"${sched.orgId}"`)
  parts.push(`"\\"runContext\\":\\"SCHEDULER\\""`)

  if (taskName.trim()) parts.push(`"${taskName.trim()}"`)
  if (errorsOnly)      parts.push('"error"')

  return parts.join(' AND ')
}

/**
 * Try to extract the inner payload object from a log message string.
 *
 * Log format (example):
 *   "JobExecution started: jsonPayload: {\"operation\":\"start\",...,\"payload\":{\"assetId\":...,\"assetName\":...}}"
 *
 * Returns the payload object, or null if the message can't be parsed.
 */
function parsePayload(message) {
  if (!message) return null
  try {
    // Try to pull the JSON from after "jsonPayload:" first
    const idx = message.indexOf('jsonPayload:')
    const jsonStr = idx !== -1
      ? message.slice(idx + 'jsonPayload:'.length).trim()
      : message.trim()
    const outer = JSON.parse(jsonStr)
    // The real fields may be nested inside a "payload" key
    return outer?.payload ?? outer ?? null
  } catch {
    // Message may itself be a raw JSON string
    try {
      const obj = JSON.parse(message)
      return obj?.payload ?? obj ?? null
    } catch {
      return null
    }
  }
}

const PAYLOAD_FIELDS = ['assetName', 'assetId', 'state', 'errorMessage', 'startTime', 'scheduleId', 'runContext']

// ── Step indicator ────────────────────────────────────────────────────────
function Steps({ current }) {
  const steps = ['Org + Pod', 'Select Schedule', 'Search Kibana', 'Results']
  return (
    <div className="inv-steps">
      {steps.map((s, i) => (
        <Fragment key={s}>
          <div className={`inv-step ${i < current ? 'inv-step-done' : i === current ? 'inv-step-active' : ''}`}>
            <span className="inv-step-num">{i < current ? '✓' : i + 1}</span>
            <span className="inv-step-label">{s}</span>
          </div>
          {i < steps.length - 1 && <span className="inv-step-sep" />}
        </Fragment>
      ))}
    </div>
  )
}

// ── Main page ─────────────────────────────────────────────────────────────
export default function InvestigatePage() {
  const { kibanaSession, userSession, xsrfToken } = useKibana()

  // Step 0 — org + pod
  const [orgId,   setOrgId]   = useState('')
  const [podHost, setPodHost] = useState('')   // e.g. "na1.dm-us"

  // Step 1 — schedule selection
  const [schedules,        setSchedules]        = useState([])
  const [schedLoading,     setSchedLoading]     = useState(false)
  const [schedError,       setSchedError]       = useState(null)
  const [schedulesFetched, setSchedulesFetched] = useState(false)
  const [selectedSched,    setSelectedSched]    = useState(null)
  const [schedSearch,      setSchedSearch]      = useState('')
  const [taskName,         setTaskName]         = useState('')

  // Step 2 — time range
  const [dateFrom, setDateFrom] = useState(() => toLocalInput(new Date(Date.now() - 24*3600*1000)))
  const [dateTo,   setDateTo]   = useState(() => toLocalInput(new Date()))

  // Step 2.5 — search options
  const [errorsOnly, setErrorsOnly] = useState(true)

  // Step 3 — results
  const [searching,   setSearching]   = useState(false)
  const [searchError, setSearchError] = useState(null)
  const [results,     setResults]     = useState(null)
  const [expandedHit, setExpandedHit] = useState(null)

  // Asset map
  const [assetMap,        setAssetMap]        = useState(null)
  const [assetMapLoading, setAssetMapLoading] = useState(false)
  const [assetMapError,   setAssetMapError]   = useState(null)
  const [assetMapOpen,    setAssetMapOpen]    = useState(false)
  const [assetSearch,     setAssetSearch]     = useState('')
  const [crawlProgress,   setCrawlProgress]   = useState([])  // [{text, done, error}]

  // Derive step index
  const step = results ? 3 : selectedSched ? 2 : schedulesFetched ? 1 : 0

  // ── Fetch schedules ─────────────────────────────────────────────────────
  async function fetchSchedules() {
    const trimmedOrg = orgId.trim()
    const trimmedPod = podHost.trim()
    if (!trimmedOrg) { setSchedError('Please enter an Org ID.'); return }
    if (!trimmedPod) { setSchedError('Please enter a pod host (e.g. na1.dm-us).'); return }
    if (!userSession) { setSchedError('No IDMC session — please log in again via Support Login.'); return }

    setSchedLoading(true)
    setSchedError(null)
    try {
      const res = await fetch('/api/support/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId:       trimmedOrg,
          podHost:     trimmedPod,
          userSession: userSession,
          xsrfToken:   xsrfToken,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSchedError(data.detail || 'Failed to load schedules')
        return
      }
      setSchedules(data.schedules || [])
      setSchedulesFetched(true)
    } catch {
      setSchedError('Network error — is the backend running?')
    } finally {
      setSchedLoading(false)
    }
  }

  // ── Kibana search ───────────────────────────────────────────────────────
  async function runSearch() {
    if (!selectedSched || !kibanaSession) return
    setSearching(true)
    setSearchError(null)
    setResults(null)
    setExpandedHit(null)
    try {
      const kql = buildKql(selectedSched, taskName, errorsOnly)
      const res = await fetch('/api/kibana/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-kibana-sid': kibanaSession.sid,
        },
        body: JSON.stringify({
          kql,
          time_from: new Date(dateFrom).toISOString(),
          time_to:   new Date(dateTo).toISOString(),
          size: 50,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setSearchError(data.detail || 'Kibana search failed')
        return
      }
      setResults(data)
    } catch {
      setSearchError('Network error during Kibana search')
    } finally {
      setSearching(false)
    }
  }

  function applyPreset(hours) {
    const end   = new Date()
    const start = new Date(end.getTime() - hours * 3600 * 1000)
    setDateFrom(toLocalInput(start))
    setDateTo(toLocalInput(end))
  }

  // ── Asset map ───────────────────────────────────────────────────────────
  function _cacheKey() { return `asset_inventory_${orgId.trim()}` }

  function _loadCached() {
    try { const r = sessionStorage.getItem(_cacheKey()); return r ? JSON.parse(r) : null }
    catch { return null }
  }

  function _saveCache(data) {
    try { sessionStorage.setItem(_cacheKey(), JSON.stringify(data)) } catch {}
  }

  function _addProgress(text, done = false, isError = false) {
    setCrawlProgress(prev => [...prev, { text, done, isError }])
  }

  function _updateLastProgress(text, done = true, isError = false) {
    setCrawlProgress(prev => {
      if (!prev.length) return [{ text, done, isError }]
      const next = [...prev]
      next[next.length - 1] = { text, done, isError }
      return next
    })
  }

  async function buildAssetMap(forceRefresh = false) {
    if (!userSession) { setAssetMapError('No IDMC session — re-login as support user.'); return }

    if (forceRefresh) {
      try { sessionStorage.removeItem(_cacheKey()) } catch {}
    } else {
      const cached = _loadCached()
      if (cached) {
        setAssetMap(_joinWithSchedules(cached))
        setAssetMapOpen(true)
        return
      }
    }

    setAssetMapLoading(true)
    setAssetMapError(null)
    setAssetMap(null)
    setCrawlProgress([])

    try {
      // ── Step 1: list projects ──────────────────────────────────────────
      _addProgress('Fetching project list…')
      const projRes = await fetch('/api/frs/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orgId: orgId.trim(), podHost: podHost.trim(),
          userSession, xsrfToken,
        }),
      })
      const projData = await projRes.json()
      if (!projRes.ok) {
        _updateLastProgress(`Project list failed: ${projData.detail || projRes.status}`, true, true)
        setAssetMapError(projData.detail || 'Failed to load project list')
        return
      }
      const projects = projData.projects || []
      _updateLastProgress(`Found ${projects.length} project${projects.length !== 1 ? 's' : ''}`, true)

      if (projects.length === 0) {
        setAssetMapError('No projects found for this org. Check your pod host and session.')
        return
      }

      // ── Step 2: crawl each project one at a time ───────────────────────
      const allAssets = []
      for (let i = 0; i < projects.length; i++) {
        const proj = projects[i]
        _addProgress(`[${i + 1}/${projects.length}] Scanning "${proj.name}"…`)
        try {
          const assetRes = await fetch('/api/frs/project-assets', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              projectId: proj.id, projectName: proj.name,
              podHost: podHost.trim(), userSession, xsrfToken,
            }),
          })
          const assetData = await assetRes.json()
          if (!assetRes.ok) {
            _updateLastProgress(
              `[${i + 1}/${projects.length}] "${proj.name}" — error: ${assetData.detail || assetRes.status}`,
              true, true
            )
            continue
          }
          const count   = assetData.assetCount || 0
          const folders = assetData.foldersScanned || 0
          const folderNote = folders > 0 ? `, ${folders} folder${folders !== 1 ? 's' : ''} scanned` : ''
          _updateLastProgress(
            `[${i + 1}/${projects.length}] "${proj.name}" — ${count} asset${count !== 1 ? 's' : ''}${folderNote}`,
            true
          )
          allAssets.push(...(assetData.assets || []))
        } catch {
          _updateLastProgress(`[${i + 1}/${projects.length}] "${proj.name}" — network error`, true, true)
        }
      }

      _addProgress(`Crawl complete — ${allAssets.length} schedulable asset${allAssets.length !== 1 ? 's' : ''} total`, true)

      if (allAssets.length === 0) {
        setAssetMapError('No schedulable assets (MCT / Taskflow / Linear Taskflow) found in any project.')
        return
      }

      const inventoryData = { assets: allAssets, projects, total: allAssets.length }
      _saveCache(inventoryData)
      setAssetMap(_joinWithSchedules(inventoryData))
      setAssetMapOpen(true)
    } catch {
      setAssetMapError('Unexpected error during asset crawl')
    } finally {
      setAssetMapLoading(false)
    }
  }

  function _joinWithSchedules(inventoryData) {
    // Build a lookup: scheduleId → schedule (from Kibana logs via schedule.id)
    const schedById = Object.fromEntries(schedules.map(s => [s.id, s]))

    // Each asset from FRS: { id, name, documentType, path, projectId, projectName, frsId }
    // Build reverse lookup from all possible schedule→asset ID fields.
    // scheduler-service may use: taskId, frsId, taskRef, assets[0].id, assetRef
    const schedByAssetId = {}
    for (const s of schedules) {
      const candidates = [
        s.taskId, s.frsId, s.taskRef, s.assetRef,
        s.assets?.[0]?.id, s.assets?.[0]?.frsId,
      ].filter(Boolean)
      for (const fid of candidates) schedByAssetId[fid] = s
    }

    const rows = (inventoryData.assets || []).map(a => {
      const sched = schedByAssetId[a.id] || schedByAssetId[a.frsId]
      return {
        assetId:      a.id,
        assetName:    a.name || '—',
        documentType: a.documentType || '—',
        projectName:  a.projectName || '—',
        path:         a.path || '',
        scheduleId:   sched?.id   || '—',
        scheduleName: sched?.name || '—',
        scheduleStatus: sched?.status || '—',
        nextRunUtc:   sched?.nextRunUtc || null,
        intervalLabel: sched?.intervalLabel || '—',
      }
    })

    // Sort: scheduled first, then alphabetically by name
    rows.sort((a, b) => {
      const aHasSched = a.scheduleId !== '—' ? 0 : 1
      const bHasSched = b.scheduleId !== '—' ? 0 : 1
      if (aHasSched !== bHasSched) return aHasSched - bHasSched
      return a.assetName.localeCompare(b.assetName)
    })

    return {
      rows,
      total:    inventoryData.total,
      projects: inventoryData.projects || [],
      cached:   false,
    }
  }

  function resetAll() {
    setSchedulesFetched(false)
    setSchedules([])
    setSelectedSched(null)
    setTaskName('')
    setResults(null)
    setSearchError(null)
    setSchedSearch('')
    setSchedError(null)
    setAssetMap(null)
    setAssetMapError(null)
    setAssetSearch('')
    setCrawlProgress([])
  }

  const filteredScheds = schedules.filter(s =>
    !schedSearch || s.name.toLowerCase().includes(schedSearch.toLowerCase())
  )

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <div className="inv-page">

      {/* ── Header ── */}
      <div className="inv-header">
        <div>
          <h2 className="inv-title">Schedule Investigation</h2>
          <p className="inv-sub">
            Enter a customer org ID and pod, load their schedules, then search Kibana for scheduler errors.
          </p>
        </div>
        {schedulesFetched && (
          <button className="inv-reset-btn" onClick={resetAll}>↩ Start Over</button>
        )}
      </div>

      <Steps current={step} />

      {/* ── Step 0: Org ID + Pod host ── */}
      <div className={`inv-card ${schedulesFetched ? 'inv-card-done' : ''}`}>
        <div className="inv-card-title">
          <span className="inv-card-num">1</span>
          Customer Org &amp; Pod
          {schedulesFetched && (
            <>
              <span className="inv-selected-pill">{orgId.trim()}</span>
              <span className="inv-selected-pill inv-pill-pod">{podHost.trim()}</span>
              <button className="inv-change-btn" onClick={resetAll}>Change</button>
            </>
          )}
        </div>

        {!schedulesFetched && (
          <>
            <div className="inv-org-row">
              <label className="inv-label">
                Org ID
                <span className="inv-label-hint">found in the customer org settings or ticket</span>
              </label>
              <input
                className="inv-input"
                placeholder="e.g. 6BThIifoQQme9C1rkULL8Q"
                value={orgId}
                onChange={e => { setOrgId(e.target.value); setSchedError(null) }}
                disabled={schedLoading}
                spellCheck={false}
              />
            </div>

            <div className="inv-org-row">
              <label className="inv-label">
                Pod host
                <span className="inv-label-hint">subdomain prefix, e.g. <code>na1.dm-us</code> or <code>usw5.dm-us</code></span>
              </label>
              <input
                className="inv-input"
                placeholder="e.g. na1.dm-us"
                value={podHost}
                onChange={e => { setPodHost(e.target.value); setSchedError(null) }}
                disabled={schedLoading}
                spellCheck={false}
              />
            </div>

            {schedError && <div className="inv-error">{schedError}</div>}

            <button className="inv-fetch-btn" onClick={fetchSchedules} disabled={schedLoading}>
              {schedLoading
                ? <><span className="inv-spinner" /> Loading schedules…</>
                : '⬇ Load Schedules'}
            </button>
          </>
        )}
      </div>

      {/* ── Step 1: Pick a schedule ── */}
      {schedulesFetched && (
        <div className={`inv-card ${selectedSched ? 'inv-card-done' : ''}`}>
          <div className="inv-card-title">
            <span className="inv-card-num">2</span>
            Select Schedule
            {selectedSched && (
              <>
                <span className="inv-selected-pill">{selectedSched.name}</span>
                <button className="inv-change-btn" onClick={() => { setSelectedSched(null); setResults(null) }}>
                  Change
                </button>
              </>
            )}
          </div>

          {!selectedSched && (
            <>
              <div className="inv-search-row">
                <input
                  className="inv-input"
                  placeholder="Filter schedule name…"
                  value={schedSearch}
                  onChange={e => setSchedSearch(e.target.value)}
                />
                <span className="inv-count">{filteredScheds.length} of {schedules.length}</span>
              </div>
              <div className="inv-sched-list">
                {filteredScheds.length === 0 && (
                  <div className="inv-empty">No schedules match the filter.</div>
                )}
                {filteredScheds.map(s => (
                  <button
                    key={s.id}
                    className="inv-sched-row"
                    onClick={() => setSelectedSched(s)}
                  >
                    <div className="inv-sched-name">{s.name}</div>
                    <div className="inv-sched-meta">
                      <span className={`inv-status-badge ${s.status === 'enabled' ? 'inv-badge-enabled' : 'inv-badge-disabled'}`}>
                        {s.status === 'enabled' ? 'Enabled' : 'Disabled'}
                      </span>
                      <span className="inv-sched-interval">{s.intervalLabel || '—'}</span>
                      {s.nextRunUtc && (
                        <span className="inv-sched-next">Next: {fmt(s.nextRunUtc)}</span>
                      )}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {selectedSched && (
            <div className="inv-task-row">
              <label className="inv-label">
                Task name
                <span className="inv-label-hint">optional — add to narrow Kibana results to a specific task</span>
              </label>
              <input
                className="inv-input"
                placeholder="e.g. MY_MAPPING_TASK"
                value={taskName}
                onChange={e => setTaskName(e.target.value)}
              />
            </div>
          )}
        </div>
      )}

      {/* ── Asset Map ── */}
      {schedulesFetched && (
        <div className="inv-card inv-asset-map-card">
          <div className="inv-card-title" style={{ cursor: 'pointer' }} onClick={() => assetMap && setAssetMapOpen(o => !o)}>
            <span className="inv-card-num inv-card-num-map">M</span>
            Asset Map
            <span className="inv-label-hint" style={{ fontWeight: 400 }}>
              — all assets in org, joined with schedule assignments
            </span>
            {assetMap && (
              <>
                <span className="inv-results-count" style={{ marginLeft: 'auto' }}>
                  {assetMap.rows.length} asset{assetMap.rows.length !== 1 ? 's' : ''}
                </span>
                <span className="inv-results-count" style={{ background: '#f0fdf4', color: '#15803d' }}>
                  {assetMap.rows.filter(r => r.scheduleId !== '—').length} scheduled
                </span>
              </>
            )}
          </div>

          {!assetMap && !assetMapLoading && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button
                className="inv-fetch-btn"
                onClick={() => buildAssetMap(false)}
                style={{ background: '#7c3aed' }}
              >
                🗺 Build Asset Map
              </button>
              <span className="inv-label-hint">Crawls MCT / Taskflow assets across all FRS projects — cached in this tab</span>
            </div>
          )}

          {/* ── Live crawl progress ── */}
          {(assetMapLoading || crawlProgress.length > 0) && (
            <div className="inv-crawl-log">
              {crawlProgress.map((line, i) => (
                <div
                  key={i}
                  className={`inv-crawl-line ${line.done ? (line.isError ? 'inv-crawl-error' : 'inv-crawl-done') : 'inv-crawl-pending'}`}
                >
                  <span className="inv-crawl-icon">
                    {line.isError ? '✗' : line.done ? '✓' : <span className="inv-spinner inv-spinner-sm" />}
                  </span>
                  {line.text}
                </div>
              ))}
            </div>
          )}

          {assetMapError && <div className="inv-error">{assetMapError}</div>}

          {assetMap && assetMapOpen && (
            <>
              <div className="inv-search-row" style={{ marginBottom: 4 }}>
                <input
                  className="inv-input"
                  placeholder="Filter by asset name, type, project, or schedule…"
                  value={assetSearch}
                  onChange={e => setAssetSearch(e.target.value)}
                />
                <span className="inv-count">
                  {assetMap.rows.filter(r =>
                    !assetSearch ||
                    r.assetName.toLowerCase().includes(assetSearch.toLowerCase()) ||
                    r.documentType.toLowerCase().includes(assetSearch.toLowerCase()) ||
                    r.projectName.toLowerCase().includes(assetSearch.toLowerCase()) ||
                    r.scheduleName.toLowerCase().includes(assetSearch.toLowerCase())
                  ).length} of {assetMap.rows.length}
                </span>
                <button
                  className="inv-preset-btn"
                  style={{ marginLeft: 8 }}
                  onClick={() => { setCrawlProgress([]); buildAssetMap(true) }}
                  disabled={assetMapLoading}
                  title="Re-fetch from FRS (clears cache)"
                >
                  {assetMapLoading ? <span className="inv-spinner" style={{ borderTopColor: '#374151' }} /> : '↺'} Refresh
                </button>
              </div>
              <div className="inv-asset-table-wrap">
                <table className="inv-asset-table">
                  <thead>
                    <tr>
                      <th>Asset Name</th>
                      <th>Type</th>
                      <th>Project</th>
                      <th>Schedule</th>
                      <th>Schedule Status</th>
                      <th>Interval</th>
                      <th>Next Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {assetMap.rows
                      .filter(r =>
                        !assetSearch ||
                        r.assetName.toLowerCase().includes(assetSearch.toLowerCase()) ||
                        r.documentType.toLowerCase().includes(assetSearch.toLowerCase()) ||
                        r.projectName.toLowerCase().includes(assetSearch.toLowerCase()) ||
                        r.scheduleName.toLowerCase().includes(assetSearch.toLowerCase())
                      )
                      .map(r => (
                        <tr
                          key={r.assetId}
                          className={r.scheduleId !== '—' ? 'inv-asset-row-scheduled' : ''}
                          onClick={() => {
                            if (r.scheduleId !== '—') {
                              const found = schedules.find(s => s.id === r.scheduleId)
                              if (found) {
                                setSelectedSched(found)
                                setTaskName(r.assetName !== '—' ? r.assetName : '')
                              }
                            }
                          }}
                          title={r.scheduleId !== '—' ? 'Click to investigate this schedule' : ''}
                          style={{ cursor: r.scheduleId !== '—' ? 'pointer' : 'default' }}
                        >
                          <td className="inv-asset-name">{r.assetName}</td>
                          <td><span className="inv-asset-type">{r.documentType}</span></td>
                          <td className="inv-asset-muted">{r.projectName}</td>
                          <td>
                            {r.scheduleName !== '—'
                              ? <span className="inv-asset-sched-name">{r.scheduleName}</span>
                              : <span className="inv-asset-muted">—</span>}
                          </td>
                          <td>
                            {r.scheduleStatus !== '—' && (
                              <span className={`inv-status-badge ${r.scheduleStatus === 'enabled' ? 'inv-badge-enabled' : 'inv-badge-disabled'}`}>
                                {r.scheduleStatus}
                              </span>
                            )}
                          </td>
                          <td className="inv-asset-muted">{r.intervalLabel !== '—' ? r.intervalLabel : ''}</td>
                          <td className="inv-asset-muted">{r.nextRunUtc ? fmt(r.nextRunUtc) : ''}</td>
                        </tr>
                      ))
                    }
                  </tbody>
                </table>
              </div>
            </>
          )}

          {assetMap && !assetMapOpen && (
            <p className="inv-label-hint" style={{ margin: 0 }}>
              {assetMap.rows.length} assets — {assetMap.rows.filter(r => r.scheduleId !== '—').length} with a schedule — click the title to expand
            </p>
          )}
        </div>
      )}

      {/* ── Step 2: Time range + search ── */}
      {selectedSched && (
        <div className={`inv-card ${results ? 'inv-card-done' : ''}`}>
          <div className="inv-card-title">
            <span className="inv-card-num">3</span>
            Search Kibana
          </div>

          <div className="inv-preset-row">
            <span className="inv-preset-label">Quick:</span>
            {PRESETS.map(p => (
              <button key={p.hours} className="inv-preset-btn" onClick={() => applyPreset(p.hours)}>
                {p.label}
              </button>
            ))}
          </div>

          <div className="inv-range-row">
            <label className="inv-label">
              From
              <input
                type="datetime-local"
                className="inv-datetime"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
              />
            </label>
            <label className="inv-label">
              To
              <input
                type="datetime-local"
                className="inv-datetime"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
              />
            </label>
          </div>

          <label className="inv-errors-toggle">
            <input
              type="checkbox"
              checked={errorsOnly}
              onChange={e => setErrorsOnly(e.target.checked)}
            />
            Errors / failures only
            <span className="inv-errors-hint">(adds AND "error" to the KQL)</span>
          </label>

          <div className="inv-kql-preview">
            <span className="inv-kql-label">KQL:</span>
            <code className="inv-kql-code">{buildKql(selectedSched, taskName, errorsOnly)}</code>
          </div>

          <button className="inv-run-btn" onClick={runSearch} disabled={searching}>
            {searching
              ? <><span className="inv-spinner" /> Searching…</>
              : '🔍 Search Kibana'}
          </button>

          {searchError && <div className="inv-error">{searchError}</div>}
        </div>
      )}

      {/* ── Step 3: Results ── */}
      {results && (
        <div className="inv-card">
          <div className="inv-card-title">
            <span className="inv-card-num">4</span>
            Results
            <span className="inv-results-count">
              {results.total} log{results.total !== 1 ? 's' : ''} found
            </span>
            <span className="inv-results-window">
              {new Date(dateFrom).toLocaleString()} → {new Date(dateTo).toLocaleString()}
            </span>
          </div>

          {results.total === 0 && (
            <div className="inv-no-results">
              <div className="inv-no-results-icon">✓</div>
              <p>No Kibana entries matched <strong>{buildKql(selectedSched, taskName, errorsOnly)}</strong></p>
              <p className="inv-no-results-hint">Schedule may have run cleanly, or logs were not ingested for this window.</p>
            </div>
          )}

          {results.hits?.length > 0 && (
            <div className="inv-hits">
              {results.hits.map((hit, i) => {
                const isExpanded = expandedHit === i
                const msg = hit.message || ''
                const payload = parsePayload(msg)
                const state = payload?.state || ''
                const isError = /error|fail|miss/i.test(state) || /error|exception|fail|miss/i.test(msg)
                const assetName = payload?.assetName || ''
                const assetId   = payload?.assetId   || ''
                const errMsg    = payload?.errorMessage || ''
                const startTime = payload?.startTime  || hit.timestamp
                return (
                  <div key={i} className={`inv-hit ${isError ? 'inv-hit-error' : ''}`}>
                    <div className="inv-hit-header" onClick={() => setExpandedHit(isExpanded ? null : i)}>
                      <span className="inv-hit-toggle">{isExpanded ? '▾' : '▸'}</span>
                      <span className="inv-hit-time">{fmt(startTime)}</span>
                      <span className={`inv-hit-severity ${isError ? 'inv-sev-error' : 'inv-sev-info'}`}>
                        {state || (isError ? 'ERROR' : 'INFO')}
                      </span>
                      {assetName
                        ? <span className="inv-hit-asset">{assetName}</span>
                        : <span className="inv-hit-msg">{msg.slice(0, 120)}{msg.length > 120 ? '…' : ''}</span>
                      }
                      {assetId && <span className="inv-hit-assetid">{assetId}</span>}
                    </div>
                    {isExpanded && (
                      <div className="inv-hit-body">
                        {/* ── Structured payload fields ── */}
                        {payload && (
                          <div className="inv-payload-grid">
                            {PAYLOAD_FIELDS.map(f => payload[f] !== undefined && (
                              <Fragment key={f}>
                                <span className="inv-pay-key">{f}</span>
                                <span className={`inv-pay-val ${f === 'state' && isError ? 'inv-pay-val-error' : ''}`}>
                                  {String(payload[f]) || '—'}
                                </span>
                              </Fragment>
                            ))}
                            {errMsg && (
                              <>
                                <span className="inv-pay-key">errorMessage</span>
                                <span className="inv-pay-val inv-pay-val-error">{errMsg}</span>
                              </>
                            )}
                          </div>
                        )}
                        {/* ── Raw message ── */}
                        <details className="inv-raw-details">
                          <summary className="inv-raw-summary">Raw log message</summary>
                          <div className="inv-hit-full-msg">{msg}</div>
                        </details>
                        {/* ── Other ES fields ── */}
                        <details className="inv-raw-details">
                          <summary className="inv-raw-summary">ES source fields</summary>
                          <div className="inv-hit-source-grid">
                            {Object.entries(hit.source || {})
                              .filter(([k]) => !['message', '@timestamp'].includes(k))
                              .slice(0, 30)
                              .map(([k, v]) => (
                                <Fragment key={k}>
                                  <span className="inv-src-key">{k}</span>
                                  <span className="inv-src-val">{String(v).slice(0, 200)}</span>
                                </Fragment>
                              ))
                            }
                          </div>
                        </details>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
