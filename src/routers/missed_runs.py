"""
Missed-run detection.

Algorithm:
1. Fetch all enabled schedules (v3 API).
2. Fetch activityLog entries within the lookback window (paginated).
3. Build a set of schedule names that have proven linked tasks:
     a. Any schedule that appears in the window activity log has tasks.
     b. For schedules with zero window runs, probe the most-recent activity
        page (offset=0, 200 rows) — if the schedule appears there, it has tasks
        but they all ran before the window (e.g. an incident wiped the window).
     c. Schedules that appear nowhere are empty (no tasks assigned) → skipped.
4. For each schedule with proven tasks, generate expected fire times.
5. For each expected time, find the nearest actual run within ±tolerance.
6. Classify the slot:
     - "missed"       — no matching run found at all
     - "failed_infra" — run exists but failed with an infra error
     - "failed_other" — run exists but failed with another error
     - "ok"           — run succeeded (or is still running)
"""

import re
import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from datetime import datetime, timedelta, timezone

from src.utils.schedule_utils import generate_expected_times, interval_label, _normalize_freq, _sched_freq_type
from src.routers.activity import INFRA_ERROR_KEYWORDS, _best_error, classify_error


def _parse_ts(ts_str: str) -> datetime | None:
    """
    Parse Informatica timestamps robustly.
    Handles: ISO 8601 Z suffix, +0000 (no colon), +00:00, with/without milliseconds.
    Always returns a UTC-aware datetime or None.
    """
    if not ts_str:
        return None
    s = ts_str.strip()
    try:
        # Normalise Z → +00:00
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        # Normalise +0000 / -0000 → +00:00 (no colon)
        s = re.sub(r'([+-])(\d{2})(\d{2})$', r'\1\2:\3', s)
        ts = datetime.fromisoformat(s)
        if ts.tzinfo is None:
            ts = ts.replace(tzinfo=timezone.utc)
        return ts.astimezone(timezone.utc)
    except (ValueError, TypeError):
        return None

router = APIRouter()

PAGE_SIZE = 200


# ── shared HTTP helper ─────────────────────────────────────────────────────

async def _get(url: str, session_id: str, use_v3: bool = False) -> list | dict:
    header_key = "INFA-SESSION-ID" if use_v3 else "icSessionId"
    async with httpx.AsyncClient(timeout=30) as client:
        try:
            resp = await client.get(
                url,
                headers={"Content-Type": "application/json",
                         "Accept": "application/json",
                         header_key: session_id},
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach Informatica: {e}")
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Session expired.")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


# ── activity log fetcher (paginated within window) ─────────────────────────

async def _fetch_activity_window(
    server_url: str,
    session_id: str,
    window_start: datetime,
    window_end: datetime,
) -> list[dict]:
    """
    Fetch activityLog pages until entries fall entirely before window_start.
    Returns only entries whose startTimeUtc is within [window_start, window_end].
    """
    all_entries: list[dict] = []
    offset = 0

    while True:
        url = f"{server_url}/api/v2/activity/activityLog?rowLimit={PAGE_SIZE}&offset={offset}"
        rows = await _get(url, session_id, use_v3=False)
        rows = rows if isinstance(rows, list) else []
        if not rows:
            break

        for entry in rows:
            ts_str = entry.get("startTimeUtc") or entry.get("startTime") or ""
            ts = _parse_ts(ts_str)
            if ts is None:
                continue
            if ts < window_start:
                # activityLog is newest-first; once we're before the window we can stop
                return all_entries
            if ts <= window_end:
                all_entries.append({**entry, "_ts": ts})

        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE

    return all_entries


# ── main endpoint ──────────────────────────────────────────────────────────

MAX_WINDOW_HOURS = 720  # 30 days


@router.get("/analyze")
async def analyze_missed_runs(
    lookback_hours: int   = Query(24, ge=1, le=MAX_WINDOW_HOURS),
    tolerance_mins: int   = Query(15, ge=1, le=120),
    window_start_iso: str = Query(""),   # e.g. "2026-01-10T00:00:00"
    window_end_iso:   str = Query(""),   # e.g. "2026-01-11T00:00:00"
    active_from_iso:  str = Query(""),   # optional: earliest date schedule had a task
    x_session_id: str     = Header(...),
    x_server_url: str     = Header(...),
):
    """
    Detect missed / failed schedule slots.
    If window_start_iso / window_end_iso are provided they take precedence over
    lookback_hours.  Times are treated as UTC when no offset is given.
    active_from_iso, when set, forces eff_window_start = max(window_start, active_from)
    for every schedule — overriding the automatic activity-log heuristic.
    """
    now = datetime.now(timezone.utc)

    if window_start_iso and window_end_iso:
        window_start = _parse_ts(window_start_iso)
        window_end   = _parse_ts(window_end_iso)
        if window_start is None or window_end is None:
            raise HTTPException(status_code=422, detail="Invalid datetime in window_start_iso / window_end_iso")
        if window_start >= window_end:
            raise HTTPException(status_code=422, detail="window_start must be before window_end")
        lookback_hours = round((window_end - window_start).total_seconds() / 3600, 1)
        if lookback_hours > MAX_WINDOW_HOURS:
            raise HTTPException(status_code=422, detail=f"Window cannot exceed 30 days ({MAX_WINDOW_HOURS} hours)")
    else:
        window_start = now - timedelta(hours=lookback_hours)
        window_end   = now

    # Optional explicit "schedule active from" override
    global_active_from: datetime | None = None
    if active_from_iso:
        global_active_from = _parse_ts(active_from_iso)
        if global_active_from is None:
            raise HTTPException(status_code=422, detail="Invalid datetime in active_from_iso")

    tolerance    = timedelta(minutes=tolerance_mins)

    # ── 1. fetch schedules ────────────────────────────────────────────────
    sched_data = await _get(
        f"{x_server_url}/public/core/v3/schedule",
        x_session_id,
        use_v3=True,
    )
    all_schedules = (
        sched_data if isinstance(sched_data, list)
        else sched_data.get("schedules", sched_data.get("value", []))
    )
    enabled_schedules = [
        s for s in all_schedules
        if str(s.get("status", "")).lower() == "enabled"
    ]

    # ── 2. fetch activity log within window ───────────────────────────────
    activity = await _fetch_activity_window(
        x_server_url, x_session_id, window_start, window_end
    )

    print(f"[missed] window={window_start.isoformat()} → {window_end.isoformat()}")
    print(f"[missed] enabled_schedules={len(enabled_schedules)} activity_entries={len(activity)}")
    for s in enabled_schedules:
        print(f"[missed] sched '{s.get('name')}' frequency={s.get('frequency')!r} intervalType={s.get('intervalType')!r} interval={s.get('interval')!r} startTime={s.get('startTime')!r}")

    # group actual runs by scheduleName (lower-cased) → list of run dicts
    runs_by_schedule: dict[str, list[dict]] = {}
    for entry in activity:
        sn = (entry.get("scheduleName") or "").strip()
        if not sn:
            continue
        runs_by_schedule.setdefault(sn.lower(), []).append(entry)

    print(f"[missed] runs_by_schedule keys={list(runs_by_schedule.keys())}")

    # ── 2b. probe latest page for schedules absent from the window ────────
    # Schedules that had ALL their runs before the window still deserve
    # gap analysis (incident scenario).  Schedules that never appear
    # anywhere have no tasks and must be skipped entirely.
    # Also track which schedules have pre-window history so we don't mark
    # historical slots as "missed" for schedules whose tasks were only
    # assigned recently (within the window).
    schedules_in_window = set(runs_by_schedule.keys())
    enabled_names_lower = {
        (s.get("name") or "").strip().lower()
        for s in enabled_schedules
        if (s.get("name") or "").strip()
    }
    needs_probe = enabled_names_lower - schedules_in_window

    schedules_with_tasks: set[str] = set(schedules_in_window)
    # Set of schedule names (lower) that have at least one run BEFORE window_start.
    # Schedules NOT in this set (but present in schedules_in_window) started
    # running within the window → clamp gap analysis to their first actual run.
    schedules_with_prewindow_runs: set[str] = set()

    # Always probe the latest activity page to (a) detect schedules with no
    # window runs but that do have tasks, and (b) detect pre-window history
    # for schedules that do have window runs.
    if enabled_names_lower:
        probe_rows = await _get(
            f"{x_server_url}/api/v2/activity/activityLog?rowLimit={PAGE_SIZE}&offset=0",
            x_session_id,
            use_v3=False,
        )
        probe_rows = probe_rows if isinstance(probe_rows, list) else []
        for entry in probe_rows:
            sn = (entry.get("scheduleName") or "").strip().lower()
            if sn in needs_probe:
                schedules_with_tasks.add(sn)
            # Any entry timestamped before the window means the schedule predates it
            ts_str = entry.get("startTimeUtc") or entry.get("startTime") or ""
            ts = _parse_ts(ts_str)
            if ts and ts < window_start:
                schedules_with_prewindow_runs.add(sn)

    print(f"[missed] schedules_with_tasks={schedules_with_tasks} enabled_names={enabled_names_lower}")
    print(f"[missed] schedules_with_prewindow_runs={schedules_with_prewindow_runs}")

    # ── 3. analyse each schedule that has proven linked tasks ─────────────
    schedule_results = []
    total_expected   = 0
    total_missed     = 0
    total_failed_infra  = 0
    total_failed_other  = 0
    total_ok         = 0

    for sched in enabled_schedules:
        sched_name = (sched.get("name") or "").strip()
        if not sched_name:
            continue

        freq = _sched_freq_type(sched)
        # skip Once schedules — they fire at most once, gap detection doesn't apply
        if freq == "once":
            continue

        # skip schedules that have never triggered any task in the activity log
        if sched_name.lower() not in schedules_with_tasks:
            continue

        actual_runs = runs_by_schedule.get(sched_name.lower(), [])

        # Determine effective analysis start for this schedule:
        # 1. If user supplied an explicit active_from, always use it.
        # 2. Otherwise, if the schedule has no pre-window history in the probe
        #    page, clamp to the earliest actual run (task assigned recently).
        # 3. If the schedule has proven pre-window runs, use window_start.
        sched_name_lower = sched_name.lower()
        if global_active_from is not None:
            eff_window_start = max(window_start, global_active_from)
        elif actual_runs and sched_name_lower not in schedules_with_prewindow_runs:
            earliest_run_ts  = min(r["_ts"] for r in actual_runs)
            eff_window_start = max(window_start, earliest_run_ts)
        else:
            eff_window_start = window_start

        expected_times = generate_expected_times(sched, eff_window_start, window_end)
        if not expected_times:
            continue

        slots = []
        sched_missed = sched_failed_infra = sched_failed_other = sched_ok = 0

        used_run_idxs: set[int] = set()
        indexed_runs = list(enumerate(actual_runs))

        for exp_dt in expected_times:
            # find the closest actual run within tolerance; each run can only match one slot
            best_run = None
            best_idx = -1
            best_delta = timedelta.max
            for idx, run in indexed_runs:
                if idx in used_run_idxs:
                    continue
                delta = abs(run["_ts"] - exp_dt)
                if delta <= tolerance and delta < best_delta:
                    best_delta = delta
                    best_run = run
                    best_idx = idx

            if best_run is not None:
                used_run_idxs.add(best_idx)

            if best_run is None:
                status = "missed"
                sched_missed += 1
                slot = {
                    "expectedTime": exp_dt.isoformat(),
                    "status":       "missed",
                    "taskName":     None,
                    "taskType":     None,
                    "actualStart":  None,
                    "actualEnd":    None,
                    "driftMins":    None,
                    "errorMsg":     None,
                    "errorKind":    None,
                }
            else:
                real_error, _ = _best_error(best_run)
                error_kind    = classify_error(real_error) if real_error else None
                run_state     = best_run.get("state")
                drift_mins    = round(
                    (best_run["_ts"] - exp_dt).total_seconds() / 60, 1
                )

                if run_state == 1:
                    status = "ok"
                    sched_ok += 1
                elif run_state in (2, 3):
                    if error_kind == "infra":
                        status = "failed_infra"
                        sched_failed_infra += 1
                    else:
                        status = "failed_other"
                        sched_failed_other += 1
                else:
                    status = "ok"
                    sched_ok += 1

                slot = {
                    "expectedTime": exp_dt.isoformat(),
                    "status":       status,
                    "taskName":     best_run.get("objectName"),
                    "taskType":     best_run.get("type"),
                    "actualStart":  best_run.get("startTimeUtc"),
                    "actualEnd":    best_run.get("endTimeUtc"),
                    "driftMins":    drift_mins,
                    "errorMsg":     real_error or None,
                    "errorKind":    error_kind,
                }

            slots.append(slot)

        total_expected      += len(expected_times)
        total_missed        += sched_missed
        total_failed_infra  += sched_failed_infra
        total_failed_other  += sched_failed_other
        total_ok            += sched_ok

        has_problem = sched_missed + sched_failed_infra + sched_failed_other > 0

        # Actual runs that happened during the window for this schedule
        runs_out = []
        for r in sorted(actual_runs, key=lambda x: x.get("startTimeUtc") or ""):
            err, _ = _best_error(r)
            runs_out.append({
                "taskName":  r.get("objectName") or "",
                "taskType":  r.get("type") or "",
                "startTime": r.get("startTimeUtc") or "",
                "endTime":   r.get("endTimeUtc") or "",
                "state":     r.get("state"),
                "errorMsg":  err or None,
            })

        schedule_results.append({
            "scheduleName":  sched_name,
            "intervalLabel": interval_label(sched),
            "frequency":     freq,
            "hasProblems":   has_problem,
            "counts": {
                "expected":     len(expected_times),
                "ok":           sched_ok,
                "missed":       sched_missed,
                "failedInfra":  sched_failed_infra,
                "failedOther":  sched_failed_other,
            },
            "slots": slots,
            "runs":  runs_out,
        })

    # sort: schedules with problems first, then by name
    schedule_results.sort(key=lambda s: (0 if s["hasProblems"] else 1, s["scheduleName"].lower()))

    return {
        "windowStart":    window_start.isoformat(),
        "windowEnd":      window_end.isoformat(),
        "lookbackHours":  lookback_hours,
        "toleranceMins":  tolerance_mins,
        "activeFrom":     global_active_from.isoformat() if global_active_from else None,
        "summary": {
            "schedulesAnalyzed": len(schedule_results),
            "schedulesWithIssues": sum(1 for s in schedule_results if s["hasProblems"]),
            "totalExpected":    total_expected,
            "totalOk":          total_ok,
            "totalMissed":      total_missed,
            "totalFailedInfra": total_failed_infra,
            "totalFailedOther": total_failed_other,
        },
        "schedules": schedule_results,
    }
