"""
Utilities for computing human-readable schedule descriptions and next run estimates.

Informatica schedule fields (from v3 API):
  frequency   : "Daily" | "Weekly" | "Monthly" | "Hourly" | "Minutes" | "Once" | ...
  interval    : int  (every N minutes/hours/days/weeks/months)
  startTime   : "HH:MM:SS"  (wall-clock time for the first run each day/week/month)
  endTime     : "HH:MM:SS"
  startDate   : "YYYY-MM-DD"
  endDate     : "YYYY-MM-DD"
  days        : list of ints (1=Mon … 7=Sun for Weekly; 1-31 for Monthly)
  weeksOfMonth: list of ints
  timezone    : "America/New_York" etc.

Not all fields are present for every schedule type.
"""

from datetime import datetime, timedelta, timezone, date
import re


# ── helpers ────────────────────────────────────────────────────────────────

def _time_str_to_hm(s: str | None) -> tuple[int, int]:
    """Parse "HH:MM:SS" or "HH:MM" → (hour, minute). Defaults to (0, 0)."""
    if not s:
        return 0, 0
    parts = s.split(":")
    try:
        return int(parts[0]), int(parts[1]) if len(parts) > 1 else 0
    except (ValueError, IndexError):
        return 0, 0


_DAY_NAMES = {1: "Mon", 2: "Tue", 3: "Wed", 4: "Thu", 5: "Fri", 6: "Sat", 7: "Sun"}
_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

# Informatica v3 API returns frequency as an integer code
_FREQ_INT_MAP = {
    1: "minutes",
    2: "hourly",
    3: "daily",
    4: "weekly",
    5: "monthly",
    6: "once",
}


def _safe_int(val, default: int = 1) -> int:
    """Convert val to int, returning default if val is None, empty, or non-numeric."""
    try:
        return int(val)
    except (TypeError, ValueError):
        return default


def _normalize_freq(raw) -> str:
    """Normalize frequency type to lowercase string regardless of int/str input."""
    if raw is None:
        return ""
    if isinstance(raw, int):
        return _FREQ_INT_MAP.get(raw, str(raw))
    s = str(raw).lower().strip()
    # v3 API uses "minutely" for per-minute schedules
    if s == "minutely":
        return "minutes"
    return s


def _sched_freq_type(schedule: dict) -> str:
    """
    Return the normalised frequency *type* from a v3 schedule object.
    v3 uses: interval='Minutely'/'Daily'/'Weekly' (type) + frequency=N (count).
    Older / v2 shape uses: frequency=int code.
    """
    # v3: 'interval' holds the type string
    v = schedule.get("interval")
    if v and str(v).lower() not in ("none", ""):
        return _normalize_freq(v)
    # fallback: 'frequency' as int type-code (legacy)
    return _normalize_freq(schedule.get("frequency"))


def _sched_interval_count(schedule: dict) -> int:
    """
    Return the recurrence count (every N units).
    v3: 'frequency' holds the integer count.
    Fallback: 'interval' if it happens to be numeric.
    """
    v = schedule.get("frequency")
    if v is not None:
        n = _safe_int(v, 0)
        if n > 0:
            return n
    return _safe_int(schedule.get("interval"), 1)


def _extract_start_hm(schedule: dict) -> tuple[int, int]:
    """
    Extract (hour, minute) from startTime.
    v3 startTime is a full ISO datetime: '2026-07-08T13:08:00.000Z'.
    Also handles plain 'HH:MM:SS' for backward compat.
    """
    s = schedule.get("startTime") or "00:00:00"
    # ISO datetime — extract the time part after 'T'
    if "T" in s:
        s = s.split("T")[1]          # "13:08:00.000Z" or "13:08:00"
    return _time_str_to_hm(s)


def _extract_start_date(schedule: dict) -> str:
    """
    Extract 'YYYY-MM-DD' from startTime or startDate field.
    v3 startTime = '2026-07-08T13:08:00.000Z', v2 startDate = '2026-07-08'.
    """
    s = schedule.get("startDate") or schedule.get("startTime") or ""
    if "T" in s:
        return s.split("T")[0]
    return s


def _extract_end_date(schedule: dict) -> str:
    """Extract 'YYYY-MM-DD' from endDate or endTime field."""
    s = schedule.get("endDate") or schedule.get("endTime") or ""
    if "T" in s:
        return s.split("T")[0]
    return s


# ── interval label ─────────────────────────────────────────────────────────

def interval_label(schedule: dict) -> str:
    """
    Build a short human-readable recurrence string, e.g.:
      "Every 30 min", "Daily at 06:00", "Weekly Mon/Wed at 08:00",
      "Monthly on 1st at 00:00", "Once"
    """
    freq     = _sched_freq_type(schedule)
    interval = _sched_interval_count(schedule)
    hh, mm   = _extract_start_hm(schedule)
    time_str = f"{hh:02d}:{mm:02d}"

    if freq in ("minutes", "minute"):
        return f"Every {interval} min"

    if freq in ("hourly", "hours", "hour"):
        if interval == 1:
            return "Every hour"
        return f"Every {interval} hr"

    if freq in ("daily", "day"):
        if interval == 1:
            return f"Daily at {time_str}"
        return f"Every {interval} days at {time_str}"

    if freq in ("weekly", "week"):
        days = schedule.get("days") or []
        day_labels = "/".join(_DAY_NAMES.get(d, str(d)) for d in sorted(days)) or "daily"
        if interval == 1:
            return f"Weekly {day_labels} at {time_str}"
        return f"Every {interval} wk on {day_labels} at {time_str}"

    if freq in ("monthly", "month"):
        days = schedule.get("days") or []
        if days:
            ordinal = _ordinal(days[0])
            return f"Monthly on {ordinal} at {time_str}"
        return f"Monthly at {time_str}"

    if freq == "once":
        start_date = _extract_start_date(schedule)
        return f"Once on {start_date}" if start_date else "Once"

    return freq.capitalize() if freq else "—"


def _ordinal(n: int) -> str:
    s = {1: "1st", 2: "2nd", 3: "3rd"}.get(n % 10 if n not in (11, 12, 13) else 0, f"{n}th")
    return s


# ── next run estimate ──────────────────────────────────────────────────────

def next_run_utc(schedule: dict) -> str | None:
    """
    Estimate the next UTC wall-clock time this schedule will fire.
    Returns an ISO-8601 string or None if undetermined.
    """
    freq     = _sched_freq_type(schedule)
    interval = _sched_interval_count(schedule)
    hh, mm   = _extract_start_hm(schedule)

    end_date_str = _extract_end_date(schedule)
    end_dt = None
    if end_date_str:
        try:
            end_dt = datetime.strptime(end_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    now = datetime.now(timezone.utc)

    if freq in ("minutes", "minute"):
        # align to next multiple-of-interval minute boundary
        elapsed_minutes = (now.hour * 60 + now.minute) % interval
        delta = interval - elapsed_minutes if elapsed_minutes else interval
        nxt = now + timedelta(minutes=delta)
        nxt = nxt.replace(second=0, microsecond=0)
        return _cap(nxt, end_dt)

    if freq in ("hourly", "hours", "hour"):
        elapsed_hours = now.hour % interval
        delta = interval - elapsed_hours if elapsed_hours else interval
        nxt = (now + timedelta(hours=delta)).replace(minute=0, second=0, microsecond=0)
        return _cap(nxt, end_dt)

    if freq in ("daily", "day"):
        today_run = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if today_run > now:
            nxt = today_run
        else:
            nxt = today_run + timedelta(days=interval)
        return _cap(nxt, end_dt)

    if freq in ("weekly", "week"):
        days = sorted(schedule.get("days") or [1])  # 1=Mon default
        # weekday() in Python: 0=Mon … 6=Sun
        # Informatica days: 1=Mon … 7=Sun → subtract 1
        py_days = [(d - 1) % 7 for d in days]
        cur_weekday = now.weekday()
        cur_time = now.hour * 60 + now.minute
        target_time = hh * 60 + mm
        for py_day in sorted(py_days):
            if py_day > cur_weekday or (py_day == cur_weekday and target_time > cur_time):
                delta_days = py_day - cur_weekday
                nxt = (now + timedelta(days=delta_days)).replace(
                    hour=hh, minute=mm, second=0, microsecond=0)
                return _cap(nxt, end_dt)
        # wrap to next week
        first_day = sorted(py_days)[0]
        delta_days = (7 - cur_weekday) + first_day
        nxt = (now + timedelta(days=delta_days)).replace(
            hour=hh, minute=mm, second=0, microsecond=0)
        return _cap(nxt, end_dt)

    if freq in ("monthly", "month"):
        days = schedule.get("days") or [1]
        day_of_month = int(days[0])
        # try this month, then next
        for delta_months in range(3):
            year = now.year + (now.month + delta_months - 1) // 12
            month = (now.month + delta_months - 1) % 12 + 1
            try:
                candidate = datetime(year, month, day_of_month, hh, mm, 0,
                                     tzinfo=timezone.utc)
                if candidate > now:
                    return _cap(candidate, end_dt)
            except ValueError:
                continue
        return None

    if freq == "once":
        sd = _extract_start_date(schedule)
        if sd:
            try:
                nxt = datetime.strptime(f"{sd} {hh:02d}:{mm:02d}",
                                        "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc)
                return _cap(nxt, end_dt)
            except ValueError:
                return None

    return None


def _cap(dt: datetime, end_dt: datetime | None) -> str | None:
    if end_dt and dt > end_dt:
        return None
    return dt.isoformat()


# ── expected fire time generation ──────────────────────────────────────────

def generate_expected_times(
    schedule: dict,
    window_start: datetime,
    window_end: datetime,
    max_results: int = 2000,
) -> list[datetime]:
    """
    Return all UTC datetimes when this schedule should fire within
    [window_start, window_end]. Both bounds must be timezone-aware.

    Best-effort: ignores DST and Informatica-side missed-fire policies.
    Caps output at max_results to prevent runaway loops on sub-minute intervals.
    """
    freq     = _sched_freq_type(schedule)
    interval = _sched_interval_count(schedule)
    if interval < 1:
        interval = 1

    hh, mm = _extract_start_hm(schedule)

    # Honour schedule's own start/end date boundaries
    eff_start = window_start
    start_date_str = _extract_start_date(schedule)
    if start_date_str:
        try:
            sd = datetime.strptime(start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            eff_start = max(window_start, sd)
        except ValueError:
            pass

    eff_end = window_end
    end_date_str = _extract_end_date(schedule)
    if end_date_str:
        try:
            ed = datetime.strptime(end_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            eff_end = min(window_end, ed)
        except ValueError:
            pass

    if eff_start >= eff_end:
        return []

    results: list[datetime] = []

    # ── Minutes ────────────────────────────────────────────────────────────
    if freq in ("minutes", "minute"):
        # anchor to midnight of eff_start day, step by interval minutes
        anchor = eff_start.replace(hour=0, minute=0, second=0, microsecond=0)
        elapsed = int((eff_start - anchor).total_seconds() // 60)
        first_n = (elapsed // interval + 1) * interval
        t = anchor + timedelta(minutes=first_n)
        while t <= eff_end and len(results) < max_results:
            results.append(t)
            t += timedelta(minutes=interval)

    # ── Hourly ─────────────────────────────────────────────────────────────
    elif freq in ("hourly", "hours", "hour"):
        anchor = eff_start.replace(hour=0, minute=0, second=0, microsecond=0)
        elapsed_h = int((eff_start - anchor).total_seconds() // 3600)
        first_n = (elapsed_h // interval + 1) * interval
        t = anchor + timedelta(hours=first_n)
        while t <= eff_end and len(results) < max_results:
            results.append(t)
            t += timedelta(hours=interval)

    # ── Daily ──────────────────────────────────────────────────────────────
    elif freq in ("daily", "day"):
        t = eff_start.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if t < eff_start:
            t += timedelta(days=interval)
        while t <= eff_end and len(results) < max_results:
            results.append(t)
            t += timedelta(days=interval)

    # ── Weekly ─────────────────────────────────────────────────────────────
    elif freq in ("weekly", "week"):
        raw_days = schedule.get("days") or [1]
        # Informatica: 1=Mon … 7=Sun  →  Python weekday: 0=Mon … 6=Sun
        py_days = sorted(set((d - 1) % 7 for d in raw_days))

        if interval == 1:
            # Every week — just hit every matching weekday in window
            t = eff_start.replace(hour=hh, minute=mm, second=0, microsecond=0)
            if t < eff_start:
                t += timedelta(days=1)
            while t <= eff_end and len(results) < max_results:
                if t.weekday() in py_days:
                    results.append(t)
                t += timedelta(days=1)
        else:
            # Biweekly / N-weekly: anchor on startDate (or eff_start) and step N weeks
            anchor_date = eff_start
            if start_date_str:  # already computed above
                try:
                    anchor_date = datetime.strptime(start_date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
                except ValueError:
                    pass
            # Find the first occurrence of each day on/after anchor_date
            for py_day in py_days:
                delta = (py_day - anchor_date.weekday()) % 7
                first = (anchor_date + timedelta(days=delta)).replace(
                    hour=hh, minute=mm, second=0, microsecond=0)
                t = first
                while t <= eff_end:
                    if t >= eff_start and len(results) < max_results:
                        results.append(t)
                    t += timedelta(weeks=interval)

    # ── Monthly ────────────────────────────────────────────────────────────
    elif freq in ("monthly", "month"):
        raw_days = schedule.get("days") or [1]
        dom = _safe_int(raw_days[0], 1)
        year, month = eff_start.year, eff_start.month
        for _ in range(14):  # up to 14 months
            try:
                t = datetime(year, month, dom, hh, mm, 0, tzinfo=timezone.utc)
                if t > eff_end:
                    break
                if t >= eff_start:
                    results.append(t)
            except ValueError:
                pass  # day > days-in-month (e.g. Feb 30)
            month += interval
            while month > 12:
                month -= 12
                year += 1

    # ── Once ───────────────────────────────────────────────────────────────
    elif freq == "once":
        if start_date_str:  # already computed above
            try:
                t = datetime.strptime(
                    f"{start_date_str} {hh:02d}:{mm:02d}", "%Y-%m-%d %H:%M"
                ).replace(tzinfo=timezone.utc)
                if eff_start <= t <= eff_end:
                    results.append(t)
            except ValueError:
                pass

    return sorted(results)
