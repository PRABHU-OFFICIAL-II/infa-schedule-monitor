import httpx
from fastapi import APIRouter, Header, HTTPException, Query

router = APIRouter()

INFRA_ERROR_KEYWORDS = [
    "internal.infacloudops.net",
    "UnknownHostException",
    "infacloudops.net",
]


def classify_error(error_msg: str | None) -> str:
    if not error_msg:
        return "other"
    low = error_msg.lower()
    for kw in INFRA_ERROR_KEYWORDS:
        if kw.lower() in low:
            return "infra"
    return "other"


def _collect_errors(node: dict, found: list) -> None:
    """
    Recursively walk an activityLogEntry tree and collect every non-empty
    errorMsg along with its task name, so callers get the deepest real error.
    Walks: entries[], subTaskEntries[], items[], children[].
    """
    msg = node.get("errorMsg") or ""
    if msg.strip():
        found.append({
            "taskName": node.get("objectName") or node.get("taskName") or "",
            "errorMsg": msg.strip(),
        })
    for child_key in ("entries", "subTaskEntries", "items", "children"):
        for child in node.get(child_key) or []:
            if isinstance(child, dict):
                _collect_errors(child, found)


def _best_error(entry: dict) -> tuple[str, str]:
    """
    Return (errorMsg, source_task_name) for the deepest/most meaningful error
    found anywhere in the entry tree.
    Priority: infra error anywhere > deepest child error > top-level error.
    """
    collected: list[dict] = []
    _collect_errors(entry, collected)

    if not collected:
        return "", ""

    # prefer any infra error — that's the root cause we care about most
    for item in collected:
        if classify_error(item["errorMsg"]) == "infra":
            return item["errorMsg"], item["taskName"]

    # otherwise return the deepest (last) child error — closest to the actual failure
    return collected[-1]["errorMsg"], collected[-1]["taskName"]


async def _infa_get(url: str, session_id: str) -> list | dict:
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    "icSessionId": session_id,
                },
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach Informatica: {e}")
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


PAGE_SIZE = 200  # max rows per Informatica API call


async def _fetch_all_activity(server_url: str, session_id: str) -> list:
    """
    Paginate through activityLog using offset+rowLimit until Informatica
    returns fewer rows than PAGE_SIZE (signals last page).
    """
    all_entries = []
    offset = 0
    while True:
        url = (
            f"{server_url}/api/v2/activity/activityLog"
            f"?rowLimit={PAGE_SIZE}&offset={offset}"
        )
        page = await _infa_get(url, session_id)
        rows = page if isinstance(page, list) else []
        all_entries.extend(rows)
        if len(rows) < PAGE_SIZE:
            break
        offset += PAGE_SIZE
    return all_entries


def _process_batch(rows: list) -> dict:
    """Process one batch of activityLog rows into counts + failures list."""
    success_count = 0
    failed_infra  = 0
    failed_other  = 0
    failures      = []

    for entry in rows:
        state = entry.get("state")
        if state == 1:
            success_count += 1
        elif state in (2, 3):
            real_error, error_source = _best_error(entry)
            kind = classify_error(real_error)
            if kind == "infra":
                failed_infra += 1
            else:
                failed_other += 1
            failures.append({
                "id":             entry.get("id"),
                "taskName":       entry.get("objectName"),
                "taskType":       entry.get("type"),
                "scheduleName":   entry.get("scheduleName"),
                "startTime":      entry.get("startTimeUtc"),
                "endTime":        entry.get("endTimeUtc"),
                "state":          state,
                "errorMsg":       real_error,
                "errorSource":    error_source,
                "errorKind":      kind,
                "runContextType": entry.get("runContextType"),
            })

    failures.sort(key=lambda x: x.get("startTime") or "", reverse=True)
    return {
        "successCount": success_count,
        "failedInfra":  failed_infra,
        "failedOther":  failed_other,
        "failures":     failures,
    }


@router.get("/failures")
async def get_failures(
    offset: int = Query(0, ge=0),
    x_session_id: str = Header(...),
    x_server_url: str = Header(...),
):
    """
    Fetches ONE Informatica activityLog page (max 200 rows) at the given offset.
    Returns failures + counts for that batch + hasMore so the frontend can
    lazy-load the next batch only when the user navigates there.
    """
    url = (
        f"{x_server_url}/api/v2/activity/activityLog"
        f"?rowLimit={PAGE_SIZE}&offset={offset}"
    )
    rows = await _infa_get(url, x_session_id)
    rows = rows if isinstance(rows, list) else []

    result = _process_batch(rows)
    return {
        **result,
        "offset":      offset,
        "batchSize":   len(rows),
        "hasMore":     len(rows) == PAGE_SIZE,
        "nextOffset":  offset + PAGE_SIZE if len(rows) == PAGE_SIZE else None,
    }


@router.get("/dashboard-summary")
async def dashboard_summary(
    x_session_id: str = Header(...),
    x_server_url: str = Header(...),
):
    """First page only — gives tiles their initial counts instantly."""
    rows = await _infa_get(
        f"{x_server_url}/api/v2/activity/activityLog?rowLimit={PAGE_SIZE}&offset=0",
        x_session_id,
    )
    rows = rows if isinstance(rows, list) else []
    result = _process_batch(rows)
    return {
        "successCount": result["successCount"],
        "failedInfra":  result["failedInfra"],
        "failedOther":  result["failedOther"],
        "totalFailed":  result["failedInfra"] + result["failedOther"],
        "batchSize":    len(rows),
        "hasMore":      len(rows) == PAGE_SIZE,
    }


@router.get("/running")
async def running_jobs(
    x_session_id: str = Header(...),
    x_server_url: str = Header(...),
):
    from datetime import datetime, timezone
    data = await _infa_get(
        f"{x_server_url}/api/v2/activity/activityMonitor?details=false",
        x_session_id,
    )
    entries = data if isinstance(data, list) else []
    now = datetime.now(timezone.utc)

    enriched = []
    for job in entries:
        ts_str = job.get("startTimeUtc") or job.get("startTime") or ""
        elapsed_secs = None
        if ts_str:
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                elapsed_secs = int((now - ts).total_seconds())
            except ValueError:
                pass
        enriched.append({**job, "elapsedSecs": elapsed_secs})

    return {"count": len(enriched), "jobs": enriched, "fetchedAt": now.isoformat()}
