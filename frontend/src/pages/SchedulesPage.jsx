import { useState, useMemo } from 'react'
import { useInfaFetch } from '../hooks/useInfaFetch'
import { useAuth } from '../context/AuthContext'
import Pagination from '../components/Pagination'
import './SchedulesPage.css'

const AM_PAGE_SIZE = 25


// ── Asset Map helpers ────────────────────────────────────────────────────
function fmtTs(ts) {
  return ts ? new Date(ts).toLocaleString() : ''
}

function _amCacheKey(serverUrl) {
  return `iics_asset_inventory_${serverUrl}`
}

function _loadAmCache(serverUrl) {
  try { const r = sessionStorage.getItem(_amCacheKey(serverUrl)); return r ? JSON.parse(r) : null }
  catch { return null }
}

function _saveAmCache(serverUrl, data) {
  try { sessionStorage.setItem(_amCacheKey(serverUrl), JSON.stringify(data)) } catch {}
}

// v2 and v3 APIs use different ID formats but share the same numeric suffix after the last 'D'
// e.g. v2: "01D4T4D0000000000047", v3: "cVHHgrfMM4EjTbJAR5pWYaD0000000000047" → suffix "0000000000047"
function _idSuffix(id) {
  if (!id) return null
  const idx = id.lastIndexOf('D')
  return idx >= 0 ? id.slice(idx + 1) : null
}

function _joinAssetsWithSchedules(inventoryData, schedules, scheduleMap, scheduleNameMap) {
  const schedById   = {}
  const schedByName = {}
  for (const s of (schedules || [])) {
    if (s.id) schedById[s.id] = s
    if (s.scheduleFederatedId) schedById[s.scheduleFederatedId] = s
    const suffix = _idSuffix(s.id)
    if (suffix) schedById[suffix] = s
    if (s.name) schedByName[s.name.trim().toLowerCase()] = s
  }

  const rows = (inventoryData.assets || []).map(a => {
    const schedId = scheduleMap?.[a.id] || null

    // All schedule names the backend found for this asset (comma-separated for multi-schedule taskflows)
    const allNamesRaw = scheduleNameMap?.[a.id + '__all'] || scheduleNameMap?.[a.id] || null
    const allSchedNames = allNamesRaw
      ? allNamesRaw.split(',').map(n => n.trim()).filter(Boolean)
      : []

    // Each ref in allSchedNames could be either a v3 schedule ID or a schedule name.
    // Try ID lookup (full + suffix) first, then name lookup.
    function _resolveRef(ref) {
      if (!ref) return null
      return schedById[ref]
        || schedById[_idSuffix(ref)]
        || schedByName[ref.trim().toLowerCase()]
        || null
    }

    const primaryRef = allSchedNames[0] || null
    const sched = schedId
      ? (schedById[schedId] || schedById[_idSuffix(schedId)] || null)
      : _resolveRef(primaryRef)

    const isScheduled = !!(sched || schedId || primaryRef)

    return {
      assetId:          a.id,
      assetName:        a.name || '—',
      documentType:     a.documentType || '—',
      projectName:      a.projectName || '—',
      path:             a.path || '',
      scheduleId:       sched?.id || schedId || '—',
      scheduleName:     sched?.name || primaryRef || '—',
      scheduleStatus:   sched?.status || '—',
      nextRunUtc:       sched?.nextRunUtc || null,
      intervalLabel:    sched?.intervalLabel || '—',
      isScheduled,
      allScheduleNames: allSchedNames,
    }
  })

  rows.sort((a, b) => {
    if (a.isScheduled !== b.isScheduled) return a.isScheduled ? -1 : 1
    return a.assetName.localeCompare(b.assetName)
  })

  return { rows, total: inventoryData.total }
}

// ── AssetMapCard ─────────────────────────────────────────────────────────
function AssetMapCard({ session, schedules, onAssetMapBuilt }) {
  const [assetMap,        setAssetMap]        = useState(null)
  const [assetMapLoading, setAssetMapLoading] = useState(false)
  const [assetMapError,   setAssetMapError]   = useState(null)
  const [assetMapOpen,    setAssetMapOpen]    = useState(false)
  const [crawlProgress,   setCrawlProgress]   = useState([])

  // filter + pagination
  const [filterName,      setFilterName]      = useState('')
  const [filterType,      setFilterType]      = useState('')
  const [filterScheduled, setFilterScheduled] = useState('')
  const [filterProject,   setFilterProject]   = useState('')
  const [uiPage,          setUiPage]          = useState(1)

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
    if (!session) return

    if (forceRefresh) {
      try { sessionStorage.removeItem(_amCacheKey(session.serverUrl)) } catch {}
    } else {
      const cached = _loadAmCache(session.serverUrl)
      if (cached) {
        const joined = _joinAssetsWithSchedules(cached.inventory, schedules, cached.scheduleMap, cached.scheduleNameMap || {})
        setAssetMap(joined)
        onAssetMapBuilt?.(joined.rows)
        setAssetMapOpen(true)
        return
      }
    }

    setAssetMapLoading(true)
    setAssetMapError(null)
    setAssetMap(null)
    setCrawlProgress([])

    try {
      // ── Step 1: fetch all schedulable assets via v3 objects API ──────────
      _addProgress('Fetching schedulable assets from org…')
      const assetsRes = await fetch('/api/frs/iics/assets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverUrl: session.serverUrl, icSessionId: session.icSessionId }),
      })
      const assetsData = await assetsRes.json()
      if (!assetsRes.ok) {
        _updateLastProgress(`Asset fetch failed: ${assetsData.detail || assetsRes.status}`, true, true)
        setAssetMapError(assetsData.detail || 'Failed to load assets')
        return
      }

      const allAssets = assetsData.assets || []
      _updateLastProgress(
        `Found ${allAssets.length} schedulable asset${allAssets.length !== 1 ? 's' : ''}`,
        true
      )

      if (allAssets.length === 0) {
        setAssetMapError('No schedulable assets (MTT / Taskflow / Workflow) found in your org.')
        return
      }

      // ── Step 2: resolve scheduleId for each asset via task/workflow APIs ─
      _addProgress(`Resolving schedule assignments for ${allAssets.length} assets…`)
      const schedRes = await fetch('/api/frs/iics/asset-schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          serverUrl:   session.serverUrl,
          icSessionId: session.icSessionId,
          userSession: session.userSession || '',
          xsrfToken:   session.xsrfToken   || '',
          assets:      allAssets.map(a => ({ id: a.id, name: a.name || '', documentType: a.documentType, scheduleId: a.scheduleId || '' })),
        }),
      })
      const schedData = await schedRes.json()
      const scheduleMap     = schedRes.ok ? (schedData.scheduleMap     || {}) : {}
      const scheduleNameMap = schedRes.ok ? (schedData.scheduleNameMap || {}) : {}
      const mttCount        = Object.keys(scheduleMap).length
      // Count only primary entries (exclude __all keys)
      const tfCount         = Object.keys(scheduleNameMap).filter(k => !k.endsWith('__all')).length
      const totalScheduled  = mttCount + tfCount
      const tfAssets        = allAssets.filter(a => ['TASKFLOW','WORKFLOW'].includes(a.documentType))
      const tfNote          = tfAssets.length > 0
        ? ` (${tfCount}/${tfAssets.length} taskflows via scheduler-service)`
        : ''

      _updateLastProgress(
        `Schedule resolution complete — ${totalScheduled} of ${allAssets.length} assets have a schedule${tfNote}`,
        true,
        !schedRes.ok
      )

      const inventory = { assets: allAssets, total: allAssets.length }
      _saveAmCache(session.serverUrl, { inventory, scheduleMap, scheduleNameMap })
      const joined = _joinAssetsWithSchedules(inventory, schedules, scheduleMap, scheduleNameMap)
      setAssetMap(joined)
      onAssetMapBuilt?.(joined.rows)
      setAssetMapOpen(true)
    } catch {
      setAssetMapError('Unexpected error — is the backend running?')
    } finally {
      setAssetMapLoading(false)
    }
  }

  // derive unique type / project options for dropdowns
  const typeOptions    = useMemo(() => assetMap ? [...new Set(assetMap.rows.map(r => r.documentType))].sort() : [], [assetMap])
  const projectOptions = useMemo(() => assetMap ? [...new Set(assetMap.rows.map(r => r.projectName).filter(Boolean))].sort() : [], [assetMap])

  const filteredRows = useMemo(() => {
    if (!assetMap) return []
    return assetMap.rows.filter(r => {
      if (filterName && !r.assetName.toLowerCase().includes(filterName.toLowerCase()) &&
                        !r.scheduleName.toLowerCase().includes(filterName.toLowerCase())) return false
      if (filterType && r.documentType !== filterType) return false
      if (filterProject && r.projectName !== filterProject) return false
      if (filterScheduled === 'yes' && !r.isScheduled) return false
      if (filterScheduled === 'no'  && r.isScheduled) return false
      return true
    })
  }, [assetMap, filterName, filterType, filterProject, filterScheduled])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / AM_PAGE_SIZE))
  const pagedRows  = filteredRows.slice((uiPage - 1) * AM_PAGE_SIZE, uiPage * AM_PAGE_SIZE)
  const hasFilters = filterName || filterType || filterProject || filterScheduled

  function clearFilters() {
    setFilterName(''); setFilterType(''); setFilterProject(''); setFilterScheduled(''); setUiPage(1)
  }

  return (
    <div className="table-card am-card">
      {/* ── Header ── */}
      <div
        className="am-card-header"
        onClick={() => assetMap && setAssetMapOpen(o => !o)}
        style={{ cursor: assetMap ? 'pointer' : 'default' }}
      >
        <div className="am-card-title-row">
          <span className="am-card-num">M</span>
          <span className="am-card-title-text">Asset Map</span>
          <span className="am-card-hint">all MTT / Taskflow / Workflow assets joined with schedule assignments</span>
          {assetMap && (
            <div className="am-card-pills">
              <span className="am-pill am-pill-total">{assetMap.rows.length} assets</span>
              <span className="am-pill am-pill-scheduled">
                {assetMap.rows.filter(r => r.isScheduled).length} scheduled
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="am-card-body">
        {/* ── Build prompt ── */}
        {!assetMap && !assetMapLoading && (
          <div className="am-build-row">
            <button className="am-build-btn" onClick={() => buildAssetMap(false)}>
              Build Asset Map
            </button>
            <span className="am-card-hint">Fetches all schedulable assets for your org — cached in this tab</span>
          </div>
        )}

        {/* ── Crawl progress ── */}
        {(assetMapLoading || crawlProgress.length > 0) && (
          <div className="am-crawl-log">
            {crawlProgress.map((line, i) => (
              <div
                key={i}
                className={`am-crawl-line ${line.done ? (line.isError ? 'am-crawl-error' : 'am-crawl-done') : 'am-crawl-pending'}`}
              >
                <span className="am-crawl-icon">
                  {line.isError ? '✗' : line.done ? '✓' : <span className="am-spinner-sm" />}
                </span>
                {line.text}
              </div>
            ))}
          </div>
        )}

        {assetMapError && <div className="am-error">{assetMapError}</div>}

        {/* ── Collapsed summary ── */}
        {assetMap && !assetMapOpen && (
          <p className="am-collapsed-hint">
            {assetMap.rows.length} assets · {assetMap.rows.filter(r => r.isScheduled).length} with a schedule — click the header to expand
          </p>
        )}

        {/* ── Expanded table ── */}
        {assetMap && assetMapOpen && (
          <>
            {/* Filter bar */}
            <div className="filters-bar am-filters-bar">
              <input
                className="filter-input"
                placeholder="Search name or schedule…"
                value={filterName}
                onChange={e => { setFilterName(e.target.value); setUiPage(1) }}
              />
              <select
                className="filter-select"
                value={filterType}
                onChange={e => { setFilterType(e.target.value); setUiPage(1) }}
              >
                <option value="">All types</option>
                {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
              <select
                className="filter-select"
                value={filterProject}
                onChange={e => { setFilterProject(e.target.value); setUiPage(1) }}
              >
                <option value="">All projects</option>
                {projectOptions.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
              <select
                className="filter-select"
                value={filterScheduled}
                onChange={e => { setFilterScheduled(e.target.value); setUiPage(1) }}
              >
                <option value="">All assets</option>
                <option value="yes">Scheduled only</option>
                <option value="no">Unscheduled only</option>
              </select>
              {hasFilters && (
                <button className="clear-filters-btn" onClick={clearFilters}>✕ Clear</button>
              )}
              <span className="am-count" style={{ marginLeft: 'auto' }}>
                {filteredRows.length}{hasFilters ? ` of ${assetMap.rows.length}` : ''} assets
              </span>
              <button
                className="am-refresh-btn"
                onClick={() => { setCrawlProgress([]); buildAssetMap(true) }}
                disabled={assetMapLoading}
                title="Re-fetch from API (clears cache)"
              >
                {assetMapLoading ? <span className="am-spinner-sm" style={{ borderTopColor: '#374151' }} /> : '↺'} Refresh
              </button>
            </div>

            {/* Pagination top */}
            <Pagination
              page={uiPage}
              totalPages={totalPages}
              totalItems={filteredRows.length}
              pageSize={AM_PAGE_SIZE}
              onPageChange={setUiPage}
            />

            {/* Table */}
            <div className="table-scroll">
              <table className="am-table">
                <thead>
                  <tr>
                    <th>Asset Name</th>
                    <th>Type</th>
                    <th>Project</th>
                    <th>Schedule</th>
                    <th>Status</th>
                    <th>Interval</th>
                    <th>Next Run</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.length === 0 ? (
                    <tr><td colSpan={7} className="table-empty">No assets match the current filters.</td></tr>
                  ) : pagedRows.map(r => (
                    <tr
                      key={r.assetId}
                      className={r.scheduleId !== '—' ? 'am-row-scheduled' : ''}
                    >
                      <td className="am-asset-name">{r.assetName}</td>
                      <td><span className="task-type-badge">{r.documentType}</span></td>
                      <td className="am-muted">{r.projectName}</td>
                      <td>
                        {r.scheduleName !== '—'
                          ? <span className="am-sched-name">{r.scheduleName}</span>
                          : <span className="am-muted">—</span>}
                      </td>
                      <td>
                        {r.scheduleStatus !== '—' && (
                          <span className={`status-badge ${r.scheduleStatus === 'enabled' ? 'badge-enabled' : 'badge-disabled'}`}>
                            {r.scheduleStatus}
                          </span>
                        )}
                      </td>
                      <td className="am-muted">{r.intervalLabel !== '—' ? r.intervalLabel : ''}</td>
                      <td className="am-muted">{fmtTs(r.nextRunUtc)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination bottom */}
            <Pagination
              page={uiPage}
              totalPages={totalPages}
              totalItems={filteredRows.length}
              pageSize={AM_PAGE_SIZE}
              onPageChange={setUiPage}
            />
          </>
        )}
      </div>
    </div>
  )
}

const FREQ_INT_MAP = { 1: 'Minutes', 2: 'Hourly', 3: 'Daily', 4: 'Weekly', 5: 'Monthly', 6: 'Once' }

function normalizeFreq(raw) {
  if (raw == null) return ''
  if (typeof raw === 'number') return FREQ_INT_MAP[raw] || String(raw)
  return String(raw)
}


function fmtNext(isoStr) {
  if (!isoStr) return <span className="muted">—</span>
  const d = new Date(isoStr)
  const now = new Date()
  const diffMs = d - now
  if (diffMs < 0) return <span className="muted">—</span>
  const diffMin = Math.round(diffMs / 60000)
  let relative
  if (diffMin < 60) {
    relative = `in ${diffMin} min`
  } else if (diffMin < 1440) {
    relative = `in ${Math.round(diffMin / 60)} hr`
  } else {
    relative = `in ${Math.round(diffMin / 1440)} d`
  }
  return (
    <span title={d.toLocaleString()}>
      {d.toLocaleString()}{' '}
      <span className="relative-time">({relative})</span>
    </span>
  )
}

// ── Linked tasks panel ───────────────────────────────────────────────────
function LinkedTasksPanel({ schedule, assetMapRows }) {
  if (!assetMapRows) {
    return <div className="linked-empty">Build the Asset Map above to see linked tasks.</div>
  }

  // Match by scheduleId (full or suffix) or by any schedule ref (ID or name) in allScheduleNames
  const suffix = _idSuffix(schedule.id)
  const schedNameLower = (schedule.name || '').trim().toLowerCase()
  const linked = assetMapRows.filter(r => {
    if (!r.isScheduled) return false
    // Primary scheduleId match (works for MTT and taskflows where scheduleId was resolved)
    if (r.scheduleId !== '—') {
      if (r.scheduleId === schedule.id) return true
      if (suffix && _idSuffix(r.scheduleId) === suffix) return true
    }
    // Check all raw refs from the scheduler-service (could be IDs or names)
    if (r.allScheduleNames?.length) {
      for (const ref of r.allScheduleNames) {
        if (!ref) continue
        // ref is a v3 ID → compare by suffix
        if (suffix && _idSuffix(ref) === suffix) return true
        if (ref === schedule.id) return true
        // ref is a name → compare by name
        if (ref.trim().toLowerCase() === schedNameLower) return true
      }
    }
    // Fallback: scheduleName field
    if (r.scheduleName !== '—') {
      return r.scheduleName.trim().toLowerCase() === schedNameLower
    }
    return false
  })

  if (!linked.length) {
    return <div className="linked-empty">No assets linked to this schedule.</div>
  }

  return (
    <table className="linked-table">
      <thead>
        <tr>
          <th>Asset Name</th>
          <th>Type</th>
          <th>Project</th>
        </tr>
      </thead>
      <tbody>
        {linked.map((r) => (
          <tr key={r.assetId}>
            <td className="col-name">{r.assetName}</td>
            <td><span className="task-type-badge">{r.documentType}</span></td>
            <td className="col-light">{r.projectName || '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

// ── Single schedule row ──────────────────────────────────────────────────
function ScheduleRow({ schedule, assetMapRows }) {
  const [expanded, setExpanded] = useState(false)
  const isEnabled = (schedule.status || '').toLowerCase() === 'enabled'

  return (
    <>
      <tr
        className={`sched-row ${expanded ? 'sched-row-expanded' : ''}`}
        onClick={() => setExpanded((v) => !v)}
      >
        <td>
          <span className="expand-icon">{expanded ? '▾' : '▸'}</span>
        </td>
        <td className="col-name" title={schedule.name}>{schedule.name || '—'}</td>
        <td>
          <span className={`status-badge ${isEnabled ? 'badge-enabled' : 'badge-disabled'}`}>
            {isEnabled ? 'Enabled' : 'Disabled'}
          </span>
        </td>
        <td className="col-interval">{schedule.intervalLabel || '—'}</td>
        <td className="col-freq">{normalizeFreq(schedule.frequency) || '—'}</td>
        <td className="col-time">{fmtNext(schedule.nextRunUtc)}</td>
        <td className="col-time col-light">{schedule.startDate || '—'}</td>
        <td className="col-time col-light">{schedule.endDate || '—'}</td>
        <td className="col-light">{schedule.timezone || '—'}</td>
      </tr>
      {expanded && (
        <tr className="expanded-row">
          <td colSpan={9}>
            <div className="expanded-panel">
              <div className="panel-section">
                <h4>Schedule Details</h4>
                <div className="detail-grid">
                  {schedule.startTime && <><span>Start Time</span><span>{schedule.startTime}</span></>}
                  {schedule.endTime   && <><span>End Time</span><span>{schedule.endTime}</span></>}
                  {schedule.interval  && <><span>Interval</span><span>{schedule.interval}</span></>}
                  {schedule.days?.length > 0 && <><span>Days</span><span>{(schedule.days || []).join(', ')}</span></>}
                  {schedule.id        && <><span>ID</span><span className="mono">{schedule.id}</span></>}
                </div>
              </div>
              <div className="panel-section">
                <h4>Linked Tasks <span className="panel-hint">(from asset map)</span></h4>
                <LinkedTasksPanel schedule={schedule} assetMapRows={assetMapRows} />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  )
}

// ── Main page ────────────────────────────────────────────────────────────
export default function SchedulesPage() {
  const { session } = useAuth()
  const { data, loading, error, refetch } = useInfaFetch('/api/schedules/all')

  const [filterName,    setFilterName]    = useState('')
  const [filterStatus,  setFilterStatus]  = useState('')
  const [filterFreq,    setFilterFreq]    = useState('')
  const [assetMapRows,  setAssetMapRows]  = useState(null)

  const schedules = data?.schedules || []

  const filtered = useMemo(() => {
    return schedules.filter((s) => {
      if (filterName && !(s.name || '').toLowerCase().includes(filterName.toLowerCase())) return false
      if (filterStatus && (s.status || '').toLowerCase() !== filterStatus) return false
      if (filterFreq && normalizeFreq(s.frequency) !== filterFreq) return false
      return true
    })
  }, [schedules, filterName, filterStatus, filterFreq])

  const hasFilters = filterName || filterStatus || filterFreq

  function clearFilters() {
    setFilterName('')
    setFilterStatus('')
    setFilterFreq('')
  }

  const freqOptions = useMemo(() => {
    const set = new Set(schedules.map((s) => normalizeFreq(s.frequency)).filter(Boolean))
    return [...set].sort()
  }, [schedules])

  return (
    <div className="schedules-page">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Schedules</h2>
          <p className="page-sub">
            {loading ? 'Loading…' : `${data?.total ?? 0} total · ${data?.enabled ?? 0} enabled · ${data?.disabled ?? 0} disabled`}
          </p>
        </div>
        <button className="refresh-btn" onClick={refetch} disabled={loading}>
          {loading ? '⟳ Loading…' : '⟳ Refresh'}
        </button>
      </div>

      {error && <div className="dash-error"><strong>Error:</strong> {error}</div>}

      {/* ── Spinner ── */}
      {loading && (
        <div className="page-loading-state">
          <span className="page-big-spinner" />
          <p className="page-loading-msg">Loading schedules…</p>
        </div>
      )}

      {/* ── Stat row ── */}
      {!loading && data && (
        <div className="sched-stats">
          <div className="sched-stat-tile tile-blue">
            <span className="tile-value">{data.total}</span>
            <span className="tile-label">Total</span>
          </div>
          <div className="sched-stat-tile tile-green">
            <span className="tile-value">{data.enabled}</span>
            <span className="tile-label">Enabled</span>
          </div>
          <div className="sched-stat-tile tile-gray">
            <span className="tile-value">{data.disabled}</span>
            <span className="tile-label">Disabled</span>
          </div>
        </div>
      )}

      {/* ── Asset Map ── */}
      {!loading && data && (
        <AssetMapCard session={session} schedules={schedules} onAssetMapBuilt={setAssetMapRows} />
      )}

      {/* ── Table card ── */}
      {!loading && <div className="table-card">
        <div className="table-header">
          <div>
            <h3>All Schedules</h3>
            <span className="table-sub">
              {filtered.length} match{filtered.length !== 1 ? 'es' : ''}
              {hasFilters ? ` (filtered from ${schedules.length})` : ''}
            </span>
          </div>
          <span className="table-count">{filtered.length}</span>
        </div>

        {/* ── Filters ── */}
        <div className="filters-bar">
          <input
            className="filter-input"
            type="text"
            placeholder="Search schedule name…"
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
          />
          <select
            className="filter-select"
            value={filterStatus}
            onChange={(e) => setFilterStatus(e.target.value)}
          >
            <option value="">All status</option>
            <option value="enabled">Enabled</option>
            <option value="disabled">Disabled</option>
          </select>
          <select
            className="filter-select"
            value={filterFreq}
            onChange={(e) => setFilterFreq(e.target.value)}
          >
            <option value="">All frequencies</option>
            {freqOptions.map((f) => (
              <option key={f} value={f}>{f}</option>
            ))}
          </select>
          {hasFilters && (
            <button className="clear-filters-btn" onClick={clearFilters}>✕ Clear</button>
          )}
        </div>

        {loading && (
          <div className="table-loading">Loading schedules from Informatica…</div>
        )}

        {!loading && filtered.length === 0 && (
          <div className="table-empty">
            {hasFilters ? 'No schedules match the current filters.' : 'No schedules found.'}
          </div>
        )}

        {!loading && filtered.length > 0 && (
          <div className="table-scroll">
            <table className="sched-table">
              <thead>
                <tr>
                  <th style={{ width: 32 }}></th>
                  <th>Schedule Name</th>
                  <th>Status</th>
                  <th>Recurrence</th>
                  <th>Frequency</th>
                  <th>Next Run</th>
                  <th>Start Date</th>
                  <th>End Date</th>
                  <th>Timezone</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => (
                  <ScheduleRow key={s.id || s.name} schedule={s} assetMapRows={assetMapRows} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>}
    </div>
  )
}
