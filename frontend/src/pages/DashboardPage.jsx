import { useState, useMemo } from 'react'
import { useInfaFetch } from '../hooks/useInfaFetch'
import { useLazyFailures, UI_PAGE_SIZE } from '../hooks/useLazyFailures'
import Pagination from '../components/Pagination'
import './DashboardPage.css'

const STATE_LABEL = { 1: 'Success', 2: 'Warning', 3: 'Failed' }
const STATE_CLASS  = { 1: 'state-success', 2: 'state-warning', 3: 'state-failed' }

function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

// ── Stat tile ────────────────────────────────────────────────────
function StatTile({ label, value, sub, accent }) {
  return (
    <div className={`stat-tile ${accent ? `tile-${accent}` : ''}`}>
      <span className="tile-value">{value ?? '—'}</span>
      <span className="tile-label">{label}</span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  )
}

// ── Single failure row ───────────────────────────────────────────
function ErrorRow({ job }) {
  const showSource = job.errorSource && job.errorSource !== job.taskName
  return (
    <tr className={job.errorKind === 'infra' ? 'row-infra' : 'row-other'}>
      <td>
        <span className={`error-kind-badge ${job.errorKind === 'infra' ? 'badge-infra' : 'badge-other'}`}>
          {job.errorKind === 'infra' ? 'POD / Infra' : 'Other'}
        </span>
      </td>
      <td className="col-name" title={job.taskName}>
        {job.taskName || '—'}
        {showSource && (
          <span className="error-source" title="Child task where error originated">
            ↳ {job.errorSource}
          </span>
        )}
      </td>
      <td><span className="task-type-badge">{job.taskType || '—'}</span></td>
      <td className="col-schedule">
        {job.scheduleName
          ? job.scheduleName
          : <span className="run-context-badge">{job.runContextType || 'manual'}</span>}
      </td>
      <td><span className={`state-badge ${STATE_CLASS[job.state]}`}>{STATE_LABEL[job.state]}</span></td>
      <td className="col-time">{fmt(job.startTime)}</td>
      <td className="col-time">{fmt(job.endTime)}</td>
      <td className="col-error" title={job.errorMsg}>{job.errorMsg || '—'}</td>
    </tr>
  )
}

// ── Main page ────────────────────────────────────────────────────
export default function DashboardPage() {
  const { data: schedData, loading: schedLoading, error: schedErr, refetch: refetchSched } =
    useInfaFetch('/api/schedules/summary')

  const {
    failures, counts, loadedBatches, totalFetched, allDone,
    loading, error: failErr, uiPage, setUiPage, reset,
  } = useLazyFailures()

  // ── Filters ──────────────────────────────────────────────────
  const [filterName,      setFilterName]      = useState('')
  const [filterSchedule,  setFilterSchedule]  = useState('')
  const [filterErrorKind, setFilterErrorKind] = useState('')
  const [filterDateFrom,  setFilterDateFrom]  = useState('')
  const [filterDateTo,    setFilterDateTo]    = useState('')

  const filtered = useMemo(() => {
    return failures.filter((job) => {
      if (filterName && !(job.taskName || '').toLowerCase().includes(filterName.toLowerCase())) return false
      if (filterSchedule && job.runContextType !== filterSchedule) return false
      if (filterErrorKind && job.errorKind !== filterErrorKind) return false
      if (filterDateFrom) {
        if (!job.startTime || new Date(job.startTime) < new Date(filterDateFrom)) return false
      }
      if (filterDateTo) {
        if (!job.startTime || new Date(job.startTime) > new Date(filterDateTo)) return false
      }
      return true
    })
  }, [failures, filterName, filterSchedule, filterErrorKind, filterDateFrom, filterDateTo])

  const totalPages  = Math.max(1, Math.ceil(filtered.length / UI_PAGE_SIZE))
  const pagedRows   = filtered.slice((uiPage - 1) * UI_PAGE_SIZE, uiPage * UI_PAGE_SIZE)
  const hasFilters  = filterName || filterSchedule || filterErrorKind || filterDateFrom || filterDateTo
  const error       = schedErr || failErr

  function clearFilters() {
    setFilterName(''); setFilterSchedule(''); setFilterErrorKind('')
    setFilterDateFrom(''); setFilterDateTo(''); setUiPage(1)
  }

  function handleRefresh() {
    refetchSched()
    reset()
  }

  return (
    <div className="dashboard">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Dashboard</h2>
          <p className="page-sub">Overview of schedules, jobs and failures</p>
        </div>
        <div className="header-right">
          {allDone && (
            <div className="fetch-done">
              ✓ {totalFetched} entries loaded ({loadedBatches} batches)
            </div>
          )}
          <button className="refresh-btn" onClick={handleRefresh} disabled={loading || schedLoading}>
            {loading || schedLoading ? '⟳ Loading…' : '⟳ Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="dash-error"><strong>Error:</strong> {error}</div>}

      {/* ── Stat tiles — always visible; show '…' while loading ── */}
      <div className="tiles-grid">
        <StatTile label="Total Schedules"    value={schedLoading ? '…' : schedData?.total}   accent="blue" />
        <StatTile label="Enabled Schedules"  value={schedLoading ? '…' : schedData?.enabled} sub={schedData ? `${schedData.disabled} disabled` : null} accent="indigo" />
        <StatTile label="Successful Jobs"    value={loading ? '…' : counts.successCount}                     sub="complete" accent="green" />
        <StatTile label="Failed — POD/Infra" value={loading ? '…' : counts.failedInfra}                      sub="UnknownHostException / DNS" accent="red" />
        <StatTile label="Failed — Other"     value={loading ? '…' : counts.failedOther}                      sub="mapping / config errors"   accent="orange" />
      </div>

      {/* ── Infra alert ── */}
      {!loading && counts.failedInfra > 0 && (
        <div className="infra-alert">
          <span className="infra-alert-icon">⚠</span>
          <div>
            <strong>{counts.failedInfra} POD / Infra failure{counts.failedInfra > 1 ? 's' : ''} detected</strong>
            <p>Jobs failed with <code>UnknownHostException</code> pointing to an internal Informatica host (<code>*.internal.infacloudops.net</code>). This is a POD-side DNS or infrastructure issue — escalate to the platform team.</p>
          </div>
        </div>
      )}

      {/* ── Failures table ── */}
      <div className="table-card">
        <div className="table-header">
          <div>
            <h3>Failed Jobs</h3>
            <span className="table-sub">
              {loading
                ? <span className="loading-more">Loading activity log…</span>
                : <>
                    {filtered.length} match{filtered.length !== 1 ? 'es' : ''}
                    {hasFilters ? ` (filtered from ${failures.length})` : ` of ${failures.length} loaded`}
                    {!allDone && <span className="loading-more"> · loading more…</span>}
                  </>
              }
            </span>
          </div>
          <span className="table-count">{loading ? '' : filtered.length}</span>
        </div>

        {/* ── Filters ── */}
        <div className="filters-bar">
          <input
            className="filter-input"
            type="text"
            placeholder="Search asset name…"
            value={filterName}
            onChange={(e) => { setFilterName(e.target.value); setUiPage(1) }}
          />

          <select
            className="filter-select"
            value={filterSchedule}
            onChange={(e) => { setFilterSchedule(e.target.value); setUiPage(1) }}
          >
            <option value="">All trigger types</option>
            <option value="SCHEDULER">Scheduler</option>
            <option value="ICS_UI">Manual (UI)</option>
            <option value="REST-API">REST API</option>
            <option value="OUTBOUND MESSAGE">Outbound Message</option>
          </select>

          <select
            className="filter-select"
            value={filterErrorKind}
            onChange={(e) => { setFilterErrorKind(e.target.value); setUiPage(1) }}
          >
            <option value="">All error types</option>
            <option value="infra">POD / Infra only</option>
            <option value="other">Other errors only</option>
          </select>

          <div className="filter-date-group">
            <label>From</label>
            <input
              className="filter-input filter-date"
              type="datetime-local"
              value={filterDateFrom}
              onChange={(e) => { setFilterDateFrom(e.target.value); setUiPage(1) }}
            />
          </div>

          <div className="filter-date-group">
            <label>To</label>
            <input
              className="filter-input filter-date"
              type="datetime-local"
              value={filterDateTo}
              onChange={(e) => { setFilterDateTo(e.target.value); setUiPage(1) }}
            />
          </div>

          {hasFilters && (
            <button className="clear-filters-btn" onClick={clearFilters}>✕ Clear</button>
          )}
        </div>

        {/* Table body states */}
        {loading && (
          <div className="dash-loading-state">
            <span className="dash-big-spinner" />
            <p className="dash-loading-msg">Loading activity log…</p>
            <p className="dash-loading-sub">{totalFetched > 0 ? `${totalFetched} entries fetched across ${loadedBatches} batch${loadedBatches !== 1 ? 'es' : ''}` : 'Fetching first batch…'}</p>
          </div>
        )}

        {!loading && failures.length === 0 && allDone && (
          <div className="table-empty">No failures found in the activity log.</div>
        )}

        {!loading && filtered.length === 0 && failures.length > 0 && (
          <div className="table-empty">No failures match the current filters.</div>
        )}

        {!loading && filtered.length > 0 && (
          <>
            <Pagination
              page={uiPage}
              totalPages={totalPages}
              totalItems={filtered.length}
              pageSize={UI_PAGE_SIZE}
              onPageChange={setUiPage}
            />
            <div className="table-scroll">
              <table className="failures-table">
                <thead>
                  <tr>
                    <th>Error Type</th>
                    <th>Task Name</th>
                    <th>Type</th>
                    <th>Schedule / Trigger</th>
                    <th>State</th>
                    <th>Start Time</th>
                    <th>End Time</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedRows.map((job) => <ErrorRow key={job.id} job={job} />)}
                </tbody>
              </table>
            </div>
            <Pagination
              page={uiPage}
              totalPages={totalPages}
              totalItems={filtered.length}
              pageSize={UI_PAGE_SIZE}
              onPageChange={setUiPage}
            />
          </>
        )}

      </div>
    </div>
  )
}
