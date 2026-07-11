import { useState, useMemo, Fragment, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useKibana } from '../context/KibanaContext'
import './MissedRunsPage.css'

const STATUS_META = {
  missed:       { label: 'Missed',      cls: 'badge-missed',       row: 'row-missed'  },
  failed_infra: { label: 'POD / Infra', cls: 'badge-infra',        row: 'row-infra'   },
  failed_other: { label: 'Failed',      cls: 'badge-failed-other', row: 'row-other-f' },
  ok:           { label: 'OK',          cls: 'badge-ok',           row: ''            },
  acknowledged: { label: 'User gap',    cls: 'badge-ack',          row: ''            },
}

// ── Acknowledgment helpers (localStorage) ────────────────────────────────
const ACK_KEY = 'infa_mr_acks_v1'

function ackKey(scheduleName, expectedTime) {
  return `${scheduleName}||${expectedTime}`
}

function loadAcks() {
  try { return JSON.parse(localStorage.getItem(ACK_KEY) || '{}') }
  catch { return {} }
}

// ── Formatting ────────────────────────────────────────────────────────────
function fmt(ts) {
  return ts ? new Date(ts).toLocaleString() : '—'
}

function fmtDrift(mins) {
  if (mins == null) return '—'
  const sign = mins >= 0 ? '+' : ''
  return `${sign}${mins} min`
}

// ── Tooltip ───────────────────────────────────────────────────────────────
function Tooltip({ text, children }) {
  const [visible, setVisible] = useState(false)
  const ref = useRef(null)
  return (
    <span
      className="tooltip-wrap"
      ref={ref}
      onMouseEnter={() => setVisible(true)}
      onMouseLeave={() => setVisible(false)}
      onFocus={() => setVisible(true)}
      onBlur={() => setVisible(false)}
    >
      {children}
      {visible && <span className="tooltip-bubble">{text}</span>}
    </span>
  )
}

function InfoIcon({ tip }) {
  return (
    <Tooltip text={tip}>
      <span className="info-icon" tabIndex={0}>?</span>
    </Tooltip>
  )
}

// ── Kibana helpers ────────────────────────────────────────────────────────
function buildKql(sched, slot) {
  const parts = []
  if (slot.taskName) parts.push(`"${slot.taskName}"`)
  if (sched.scheduleName) parts.push(`"${sched.scheduleName}"`)
  parts.push('UnknownHostException OR "scheduler failure" OR "infacloudops.net"')
  return parts.join(' OR ')
}

function windowAroundSlot(slot) {
  const t = new Date(slot.expectedTime)
  return {
    from: new Date(t.getTime() - 30 * 60 * 1000).toISOString(),
    to:   new Date(t.getTime() + 60 * 60 * 1000).toISOString(),
  }
}

// ── Dot tracker ───────────────────────────────────────────────────────────
const DOT_STATUS_COLOR = {
  ok:           '#22c55e',
  missed:       '#f59e0b',
  failed_infra: '#f97316',
  failed_other: '#ef4444',
  acknowledged: '#9ca3af',
}

function DotTracker({ slots }) {
  if (!slots?.length) return null
  const MAX = 120
  const show = slots.length <= MAX ? slots : slots.slice(-MAX)
  return (
    <div className="dot-tracker" title={`${slots.length} expected slots`}>
      {show.map((s, i) => (
        <span
          key={i}
          className="dot-tracker-dot"
          style={{ background: DOT_STATUS_COLOR[s.status] || '#d1d5db' }}
          title={`${new Date(s.expectedTime).toLocaleString()} — ${s.status}${s.taskName ? ` (${s.taskName})` : ''}`}
        />
      ))}
      {slots.length > MAX && (
        <span className="dot-tracker-overflow">+{slots.length - MAX}</span>
      )}
    </div>
  )
}

// ── Schedule card ─────────────────────────────────────────────────────────
function ScheduleCard({ sched, defaultOpen, kibanaSession, acks, onToggleAck }) {
  const [open, setOpen]           = useState(defaultOpen)
  const [activeTab, setActiveTab] = useState('slots')
  const [slotFilter, setSlotFilter] = useState('all')
  const [kibanaResults, setKibanaResults] = useState({})
  const [kibanaLoading, setKibanaLoading] = useState({})

  const rawSlots = sched.slots || []

  // Overlay: missed slots the user acknowledged become 'acknowledged'
  const effectiveSlots = rawSlots.map(slot => ({
    ...slot,
    _acked: slot.status === 'missed' && !!acks[ackKey(sched.scheduleName, slot.expectedTime)],
  }))

  const ackCount       = effectiveSlots.filter(s => s._acked).length
  const { counts }     = sched
  const effectiveMissed = counts.missed - ackCount
  const effectiveHasProblems = effectiveMissed + counts.failedInfra + counts.failedOther > 0

  // Slots shown in the dot tracker (apply ack overlay for colour)
  const dotSlots = effectiveSlots.map(s => ({ ...s, status: s._acked ? 'acknowledged' : s.status }))

  const filtered = effectiveSlots.filter(s => {
    const ds = s._acked ? 'acknowledged' : s.status
    if (slotFilter === 'all')          return true
    if (slotFilter === 'problems')     return ds !== 'ok' && ds !== 'acknowledged'
    if (slotFilter === 'acknowledged') return ds === 'acknowledged'
    return ds === slotFilter
  })

  async function checkKibana(slot, idx) {
    if (!kibanaSession) return
    setKibanaLoading(p => ({ ...p, [idx]: true }))
    setKibanaResults(p => ({ ...p, [idx]: null }))
    try {
      const { from, to } = windowAroundSlot(slot)
      const res = await fetch('/api/kibana/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-kibana-sid': kibanaSession.sid },
        body: JSON.stringify({ kql: buildKql(sched, slot), time_from: from, time_to: to, size: 10 }),
      })
      const data = await res.json()
      setKibanaResults(p => ({
        ...p,
        [idx]: res.ok ? data : { error: data.detail || 'Search failed' },
      }))
    } catch {
      setKibanaResults(p => ({ ...p, [idx]: { error: 'Network error' } }))
    } finally {
      setKibanaLoading(p => ({ ...p, [idx]: false }))
    }
  }

  const runs = sched.runs || []

  return (
    <div className={`sched-card ${effectiveHasProblems ? 'sched-card-problem' : ''}`}>
      {/* ── Header ── */}
      <div className="scard-header" onClick={() => setOpen(v => !v)}>
        <span className="expand-icon">{open ? '▾' : '▸'}</span>
        <div className="scard-title">
          <span className="scard-name">{sched.scheduleName}</span>
          <span className="scard-interval">{sched.intervalLabel}</span>
        </div>
        <div className="scard-badges">
          {effectiveMissed > 0    && <span className="pill pill-missed">{effectiveMissed} missed</span>}
          {counts.failedInfra > 0 && <span className="pill pill-infra">{counts.failedInfra} POD/Infra</span>}
          {counts.failedOther > 0 && <span className="pill pill-other">{counts.failedOther} failed</span>}
          {ackCount > 0           && <span className="pill pill-ack">{ackCount} acknowledged</span>}
          {!effectiveHasProblems && ackCount === 0 && (
            <span className="pill pill-ok">{counts.ok} / {counts.expected} OK</span>
          )}
        </div>
        <div className="scard-mini">
          <span className="mini-stat">{counts.expected} expected</span>
          <span className="mini-stat ok">{counts.ok} ok</span>
        </div>
      </div>

      {/* ── Dot tracker ── */}
      <DotTracker slots={dotSlots} />

      {open && (
        <div className="scard-body">
          {/* ── Tabs ── */}
          <div className="scard-tabs">
            <button
              className={`scard-tab ${activeTab === 'slots' ? 'active' : ''}`}
              onClick={() => setActiveTab('slots')}
            >
              Slot Tracker
              <span className="scard-tab-count">{counts.expected}</span>
            </button>
            <button
              className={`scard-tab ${activeTab === 'runs' ? 'active' : ''}`}
              onClick={() => setActiveTab('runs')}
            >
              Actual Runs
              <span className="scard-tab-count">{runs.length}</span>
            </button>
          </div>

          {/* ── Slots tab ── */}
          {activeTab === 'slots' && (
            <>
              <div className="slot-filter-row">
                {[
                  { v: 'all',          label: 'All' },
                  { v: 'problems',     label: 'Problems only' },
                  { v: 'missed',       label: 'Missed' },
                  { v: 'failed_infra', label: 'POD / Infra' },
                  { v: 'failed_other', label: 'Failed' },
                  { v: 'ok',           label: 'OK' },
                  { v: 'acknowledged', label: 'Acknowledged' },
                ].map(({ v, label }) => (
                  <button
                    key={v}
                    className={`slot-filter-btn ${slotFilter === v ? 'active' : ''}`}
                    onClick={() => setSlotFilter(v)}
                  >
                    {label}
                  </button>
                ))}
                <span className="slot-count">{filtered.length} slots</span>
              </div>

              {filtered.length === 0 ? (
                <div className="slot-empty">No slots match this filter.</div>
              ) : (
                <div className="slot-scroll">
                  <table className="slot-table">
                    <thead>
                      <tr>
                        <th>Status</th>
                        <th>Expected Time</th>
                        <th>Task Name</th>
                        <th>Actual Start</th>
                        <th>Actual End</th>
                        <th>Drift</th>
                        <th>Error</th>
                        {kibanaSession && <th>Kibana</th>}
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.map((slot, i) => {
                        const displayStatus  = slot._acked ? 'acknowledged' : slot.status
                        const meta           = STATUS_META[displayStatus] || STATUS_META.ok
                        const kr             = kibanaResults[i]
                        const isProblematic  = displayStatus !== 'ok' && displayStatus !== 'acknowledged'
                        return (
                          <Fragment key={i}>
                            <tr className={meta.row}>
                              <td>
                                <div className="status-cell">
                                  <span className={`status-chip ${meta.cls}`}>{meta.label}</span>
                                  {/* Acknowledge toggle — only on missed slots */}
                                  {slot.status === 'missed' && (
                                    <button
                                      className={`ack-btn ${slot._acked ? 'ack-btn-active' : ''}`}
                                      onClick={e => { e.stopPropagation(); onToggleAck(sched.scheduleName, slot.expectedTime) }}
                                      title={slot._acked
                                        ? 'Click to undo acknowledgement'
                                        : 'Mark as an expected gap — e.g. schedule was intentionally detached from the task'}
                                    >
                                      {slot._acked ? '✓ Expected gap' : '+ Expected gap?'}
                                    </button>
                                  )}
                                </div>
                              </td>
                              <td className="col-time">{fmt(slot.expectedTime)}</td>
                              <td className="col-name">{slot.taskName || <span className="muted">—</span>}</td>
                              <td className="col-time">{fmt(slot.actualStart)}</td>
                              <td className="col-time">{fmt(slot.actualEnd)}</td>
                              <td className={`col-drift ${slot.driftMins != null && Math.abs(slot.driftMins) > 5 ? 'drift-warn' : ''}`}>
                                {fmtDrift(slot.driftMins)}
                              </td>
                              <td className="col-error" title={slot.errorMsg || ''}>
                                {slot.errorMsg || <span className="muted">—</span>}
                              </td>
                              {kibanaSession && (
                                <td>
                                  {isProblematic ? (
                                    <button
                                      className="kibana-check-btn"
                                      disabled={kibanaLoading[i]}
                                      onClick={() => checkKibana(slot, i)}
                                    >
                                      {kibanaLoading[i] ? <span className="fetch-spinner" /> : '🔍 Kibana'}
                                    </button>
                                  ) : <span className="muted">—</span>}
                                </td>
                              )}
                            </tr>
                            {kr && (
                              <tr className="kibana-result-row">
                                <td colSpan={kibanaSession ? 8 : 7}>
                                  {kr.error ? (
                                    <div className="kibana-result-error">{kr.error}</div>
                                  ) : kr.total === 0 ? (
                                    <div className="kibana-result-empty">No Kibana logs found for this time window.</div>
                                  ) : (
                                    <div className="kibana-result-hits">
                                      <span className="kibana-result-count">{kr.total} log{kr.total !== 1 ? 's' : ''} found</span>
                                      <ul className="kibana-hits-list">
                                        {kr.hits.map((h, hi) => (
                                          <li key={hi} className="kibana-hit">
                                            <span className="kibana-hit-time">{h.timestamp ? new Date(h.timestamp).toLocaleString() : '—'}</span>
                                            <span className="kibana-hit-msg">{h.message || JSON.stringify(h.source).slice(0, 200)}</span>
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}
                                </td>
                              </tr>
                            )}
                          </Fragment>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}

          {/* ── Runs tab ── */}
          {activeTab === 'runs' && (
            runs.length === 0 ? (
              <div className="slot-empty">No runs recorded in this window for this schedule.</div>
            ) : (
              <div className="slot-scroll">
                <table className="slot-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Task Name</th>
                      <th>Type</th>
                      <th>Start</th>
                      <th>End</th>
                      <th>Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r, i) => {
                      const stateMap = {
                        1: { label: 'OK',      cls: 'badge-ok',           row: '' },
                        2: { label: 'Warning', cls: 'badge-failed-other', row: 'row-other-f' },
                        3: { label: 'Failed',  cls: 'badge-failed-other', row: 'row-other-f' },
                        4: { label: 'Stopped', cls: 'badge-missed',       row: 'row-missed' },
                      }
                      const sm = stateMap[r.state] || { label: '—', cls: '', row: '' }
                      return (
                        <tr key={i} className={sm.row}>
                          <td><span className={`status-chip ${sm.cls}`}>{sm.label}</span></td>
                          <td className="col-name">{r.taskName || <span className="muted">—</span>}</td>
                          <td><span className="run-type-badge">{r.taskType || '—'}</span></td>
                          <td className="col-time">{fmt(r.startTime)}</td>
                          <td className="col-time">{fmt(r.endTime)}</td>
                          <td className="col-error" title={r.errorMsg || ''}>
                            {r.errorMsg || <span className="muted">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

// ── Page helpers ──────────────────────────────────────────────────────────
function toLocalInputValue(date) {
  const pad = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const MAX_WINDOW_HOURS = 720

const PRESETS = [
  { label: 'Last 1 h',  hours: 1 },
  { label: 'Last 6 h',  hours: 6 },
  { label: 'Last 24 h', hours: 24 },
  { label: 'Last 48 h', hours: 48 },
  { label: 'Last 7 d',  hours: 168 },
  { label: 'Last 14 d', hours: 336 },
  { label: 'Last 30 d', hours: 720 },
]

// ── Main page ─────────────────────────────────────────────────────────────
export default function MissedRunsPage() {
  const { session, logout } = useAuth()
  const { kibanaSession }   = useKibana()

  const [dateFrom,  setDateFrom]  = useState(() => toLocalInputValue(new Date(Date.now() - 24 * 3600 * 1000)))
  const [dateTo,    setDateTo]    = useState(() => toLocalInputValue(new Date()))
  const [tolerance, setTolerance] = useState(15)

  // Optional "schedule active from" — excludes slots before this date
  const [useActiveFrom, setUseActiveFrom] = useState(false)
  const [activeFrom,    setActiveFrom]    = useState('')

  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [result,  setResult]  = useState(null)

  const [filterName,   setFilterName]   = useState('')
  const [filterStatus, setFilterStatus] = useState('all')

  // Per-slot acknowledgments persisted to localStorage
  const [acks, setAcks] = useState(loadAcks)

  function toggleAck(scheduleName, expectedTime) {
    const k = ackKey(scheduleName, expectedTime)
    setAcks(prev => {
      const next = { ...prev }
      if (next[k]) delete next[k]
      else next[k] = { acknowledgedAt: new Date().toISOString() }
      try { localStorage.setItem(ACK_KEY, JSON.stringify(next)) } catch {}
      return next
    })
  }

  function applyPreset(hours) {
    const end   = new Date()
    const start = new Date(end.getTime() - hours * 3600 * 1000)
    setDateFrom(toLocalInputValue(start))
    setDateTo(toLocalInputValue(end))
  }

  async function runAnalysis() {
    if (!dateFrom || !dateTo) { setError('Please set both a start and end date/time.'); return }
    const fromMs = new Date(dateFrom).getTime()
    const toMs   = new Date(dateTo).getTime()
    if (toMs <= fromMs) { setError('End date must be after start date.'); return }
    if ((toMs - fromMs) / 3600000 > MAX_WINDOW_HOURS) {
      setError('Maximum analysis window is 30 days. Please narrow your date range.')
      return
    }
    if (useActiveFrom && activeFrom && new Date(activeFrom).getTime() > toMs) {
      setError('"Schedule active from" must be before the end of the analysis window.')
      return
    }

    setLoading(true); setError(null); setResult(null)
    try {
      const params = new URLSearchParams({
        window_start_iso: new Date(dateFrom).toISOString(),
        window_end_iso:   new Date(dateTo).toISOString(),
        tolerance_mins:   tolerance,
      })
      if (useActiveFrom && activeFrom) {
        params.set('active_from_iso', new Date(activeFrom).toISOString())
      }
      const res = await fetch(`/api/missed-runs/analyze?${params}`, {
        headers: {
          'x-session-id': session.icSessionId,
          'x-server-url': session.serverUrl,
        },
      })
      if (res.status === 401) { logout(); return }
      const data = await res.json()
      if (!res.ok) { setError(data.detail || 'Analysis failed'); return }
      setResult(data)
    } catch {
      setError('Network error — is the backend running?')
    } finally {
      setLoading(false)
    }
  }

  const filtered = useMemo(() => {
    if (!result) return []
    return result.schedules.filter(s => {
      if (filterName && !s.scheduleName.toLowerCase().includes(filterName.toLowerCase())) return false
      if (filterStatus === 'problems' && !s.hasProblems) return false
      if (filterStatus === 'ok'       &&  s.hasProblems) return false
      return true
    })
  }, [result, filterName, filterStatus])

  // Count acknowledged missed slots across all results (client-side overlay)
  const totalAcknowledged = useMemo(() => {
    if (!result) return 0
    return result.schedules.reduce((sum, s) =>
      sum + (s.slots || []).filter(slot =>
        slot.status === 'missed' && !!acks[ackKey(s.scheduleName, slot.expectedTime)]
      ).length, 0)
  }, [result, acks])

  const { summary } = result || {}

  return (
    <div className="missed-page">

      {/* ── Header ── */}
      <div className="page-header">
        <div>
          <h2 className="page-title">Missed Runs</h2>
          <p className="page-sub">Compare expected schedule fire times against the actual activity log</p>
        </div>
      </div>

      {/* ── Controls ── */}
      <div className="controls-card">

        {/* Attention banner */}
        <div className="attention-banner">
          <span className="attention-icon">ⓘ</span>
          <div className="attention-body">
            <strong>Set the right window for accurate miss detection</strong>
            <p>
              Use <em>Schedule active from</em> to specify the date you first attached the schedule
              to a task — any expected slots before that date are excluded, preventing false misses
              from periods when the schedule had no assigned task.
              For slots that are genuinely expected gaps (e.g. you temporarily detached the schedule
              for maintenance), click <em>+ Expected gap?</em> on that row to acknowledge it.
              Acknowledged slots are removed from the problem count but remain visible in the tracker.
            </p>
          </div>
        </div>

        {/* Quick presets */}
        <div className="preset-row">
          <span className="preset-label">Quick fill:</span>
          {PRESETS.map(p => (
            <button key={p.hours} className="preset-btn" onClick={() => applyPreset(p.hours)}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="controls-row">
          {/* From */}
          <label className="ctrl-label">
            <span className="ctrl-label-text">
              From
              <InfoIcon tip="Start of the analysis window. The app will look for schedule runs from this point forward." />
            </span>
            <input
              type="datetime-local"
              className="ctrl-datetime"
              value={dateFrom}
              onChange={e => setDateFrom(e.target.value)}
            />
          </label>

          {/* To */}
          <label className="ctrl-label">
            <span className="ctrl-label-text">
              To
              <InfoIcon tip="End of the analysis window. Defaults to now, but you can set a past end-time to analyse a historical incident." />
            </span>
            <input
              type="datetime-local"
              className="ctrl-datetime"
              value={dateTo}
              onChange={e => setDateTo(e.target.value)}
            />
          </label>

          {/* Tolerance */}
          <label className="ctrl-label">
            <span className="ctrl-label-text">
              Tolerance
              <InfoIcon tip={
                "How many minutes either side of the expected fire time counts as 'on time'.\n\n" +
                "Example: expected at 10:00, tolerance ±15 min → any run between 9:45–10:15 is OK.\n\n" +
                "Recommended: ±5 min for sub-hourly, ±15 min for hourly, ±30 min for daily schedules."
              } />
            </span>
            <select
              className="ctrl-select"
              value={tolerance}
              onChange={e => setTolerance(Number(e.target.value))}
            >
              <option value={5}>±5 min</option>
              <option value={10}>±10 min</option>
              <option value={15}>±15 min</option>
              <option value={30}>±30 min</option>
              <option value={60}>±60 min</option>
            </select>
          </label>

          <button className="run-btn" onClick={runAnalysis} disabled={loading}>
            {loading ? <><span className="fetch-spinner" /> Analysing…</> : '▶ Run Analysis'}
          </button>
        </div>

        {/* Schedule active from (optional override) */}
        <div className="active-from-row">
          <label className="active-from-toggle">
            <input
              type="checkbox"
              checked={useActiveFrom}
              onChange={e => setUseActiveFrom(e.target.checked)}
            />
            <span className="active-from-toggle-label">
              Schedule active from
              <InfoIcon tip={
                "Set this to the date you first attached the schedule to a task.\n\n" +
                "Expected slots before this date are excluded from gap analysis — " +
                "preventing the detector from flagging historical time when the schedule " +
                "had no task assigned yet.\n\n" +
                "Leave unchecked to let the analyser infer it automatically from the activity log."
              } />
            </span>
          </label>
          {useActiveFrom ? (
            <input
              type="datetime-local"
              className="ctrl-datetime"
              value={activeFrom}
              onChange={e => setActiveFrom(e.target.value)}
            />
          ) : (
            <span className="active-from-auto">Auto-inferred from activity log</span>
          )}
        </div>

        {/* Window span indicator */}
        {dateFrom && dateTo && (() => {
          const diffHours = (new Date(dateTo) - new Date(dateFrom)) / 3600000
          const days = (diffHours / 24).toFixed(1)
          const over = diffHours > MAX_WINDOW_HOURS
          return (
            <p className={`window-span-hint ${over ? 'window-span-over' : ''}`}>
              {over
                ? `⚠ Window is ${days} days — exceeds the 30-day maximum`
                : `Window: ${days} day${days === '1.0' ? '' : 's'} (max 30)`}
            </p>
          )
        })()}

        <p className="ctrl-hint">
          Only schedules that have previously triggered tasks appear in results — empty schedules are skipped.
          Schedules of type <em>Once</em> are also skipped (single-fire, no gap detection applies).
        </p>
      </div>

      {error && <div className="dash-error"><strong>Error:</strong> {error}</div>}

      {/* ── Spinner ── */}
      {loading && (
        <div className="page-loading-state">
          <span className="page-big-spinner" />
          <p className="page-loading-msg">Analysing schedules…</p>
          <p className="page-loading-sub">Fetching schedules and activity log from Informatica</p>
        </div>
      )}

      {/* ── Summary tiles ── */}
      {!loading && summary && (
        <div className="mr-tiles">
          <div className="mr-tile tile-blue">
            <span className="tile-value">{summary.schedulesAnalyzed}</span>
            <span className="tile-label">Schedules</span>
            <span className="tile-sub">{summary.schedulesWithIssues} with issues</span>
          </div>
          <div className="mr-tile tile-indigo">
            <span className="tile-value">{summary.totalExpected}</span>
            <span className="tile-label">Expected Slots</span>
            <span className="tile-sub">
              {new Date(result.windowStart).toLocaleDateString()} → {new Date(result.windowEnd).toLocaleDateString()}
            </span>
          </div>
          <div className="mr-tile tile-green">
            <span className="tile-value">{summary.totalOk}</span>
            <span className="tile-label">Ran OK</span>
          </div>
          <div className="mr-tile tile-gray">
            <span className="tile-value">{summary.totalMissed - totalAcknowledged}</span>
            <span className="tile-label">Missed</span>
            <span className="tile-sub">
              {totalAcknowledged > 0 ? `${totalAcknowledged} acknowledged` : 'no run found'}
            </span>
          </div>
          <div className="mr-tile tile-red">
            <span className="tile-value">{summary.totalFailedInfra}</span>
            <span className="tile-label">POD / Infra</span>
            <span className="tile-sub">UnknownHostException</span>
          </div>
          <div className="mr-tile tile-orange">
            <span className="tile-value">{summary.totalFailedOther}</span>
            <span className="tile-label">Failed — Other</span>
          </div>
        </div>
      )}

      {/* ── Infra alert ── */}
      {!loading && summary?.totalFailedInfra > 0 && (
        <div className="infra-alert">
          <span className="infra-alert-icon">⚠</span>
          <div>
            <strong>{summary.totalFailedInfra} slot{summary.totalFailedInfra > 1 ? 's' : ''} failed with POD / Infra errors</strong>
            <p>Jobs failed with <code>UnknownHostException</code> on an internal Informatica host. This matches the pattern of a POD-side scheduler DNS failure — escalate to the platform team.</p>
          </div>
        </div>
      )}

      {/* ── Schedule list ── */}
      {!loading && result && (
        <div className="table-card">
          <div className="table-header">
            <div>
              <h3>Schedule Results</h3>
              <span className="table-sub">
                {filtered.length} of {result.schedules.length} schedules
                {' · '}
                {new Date(result.windowStart).toLocaleString()} → {new Date(result.windowEnd).toLocaleString()}
                {result.activeFrom && (
                  <span className="table-sub-active-from"> · active from {new Date(result.activeFrom).toLocaleDateString()}</span>
                )}
              </span>
            </div>
          </div>

          <div className="filters-bar">
            <input
              className="filter-input"
              placeholder="Search schedule name…"
              value={filterName}
              onChange={e => setFilterName(e.target.value)}
            />
            <select
              className="filter-select"
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
            >
              <option value="all">All schedules</option>
              <option value="problems">Problems only</option>
              <option value="ok">Healthy only</option>
            </select>
            {(filterName || filterStatus !== 'all') && (
              <button className="clear-filters-btn" onClick={() => { setFilterName(''); setFilterStatus('all') }}>
                ✕ Clear
              </button>
            )}
          </div>

          <div className="cards-list">
            {filtered.length === 0 && (
              <div className="table-empty">No schedules match the current filters.</div>
            )}
            {filtered.map(s => (
              <ScheduleCard
                key={s.scheduleName}
                sched={s}
                defaultOpen={s.hasProblems}
                kibanaSession={kibanaSession}
                acks={acks}
                onToggleAck={toggleAck}
              />
            ))}
          </div>
        </div>
      )}

      {!loading && !result && (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <p>Set a date range and click <strong>Run Analysis</strong> to detect missed runs.</p>
          <p className="empty-hint">
            To investigate the Jan 2026 outage: set From = <code>2026-01-01</code>, To = <code>2026-02-01</code>.
          </p>
        </div>
      )}
    </div>
  )
}
