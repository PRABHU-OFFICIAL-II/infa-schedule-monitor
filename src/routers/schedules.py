import httpx
from fastapi import APIRouter, Header, HTTPException, Query
from src.utils.schedule_utils import interval_label, next_run_utc

router = APIRouter()


async def _infa_get(url: str, session_id: str, use_v3: bool = False) -> dict | list:
    header_key = "INFA-SESSION-ID" if use_v3 else "icSessionId"
    async with httpx.AsyncClient(timeout=20) as client:
        try:
            resp = await client.get(
                url,
                headers={
                    "Content-Type": "application/json",
                    "Accept": "application/json",
                    header_key: session_id,
                },
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach Informatica: {e}")
    if resp.status_code == 401:
        raise HTTPException(status_code=401, detail="Session expired. Please log in again.")
    if resp.status_code != 200:
        raise HTTPException(status_code=resp.status_code, detail=resp.text)
    return resp.json()


def _enrich(s: dict) -> dict:
    """Add computed fields to a raw schedule object."""
    return {
        **s,
        "intervalLabel": interval_label(s),
        "nextRunUtc":    next_run_utc(s),
    }


@router.get("/summary")
async def schedules_summary(
    x_session_id: str = Header(...),
    x_server_url: str = Header(...),
):
    data = await _infa_get(
        f"{x_server_url}/public/core/v3/schedule",
        x_session_id,
        use_v3=True,
    )
    items = data if isinstance(data, list) else data.get("schedules", data.get("value", []))

    total   = len(items)
    enabled = sum(1 for s in items if str(s.get("status", "")).lower() == "enabled")
    return {
        "total":    total,
        "enabled":  enabled,
        "disabled": total - enabled,
        "schedules": items,
    }


@router.get("/all")
async def schedules_all(
    x_session_id: str = Header(...),
    x_server_url: str = Header(...),
    q: str = Query(""),
    status: str = Query(""),
):
    """
    Returns all schedules enriched with intervalLabel and nextRunUtc.
    Optional query params:
      q       - case-insensitive name search
      status  - "enabled" | "disabled"
    """
    data = await _infa_get(
        f"{x_server_url}/public/core/v3/schedule",
        x_session_id,
        use_v3=True,
    )
    items = data if isinstance(data, list) else data.get("schedules", data.get("value", []))

    enriched = [_enrich(s) for s in items]

    # server-side filter (also done client-side, but handy for future direct API use)
    if q:
        ql = q.lower()
        enriched = [s for s in enriched if ql in (s.get("name") or "").lower()]
    if status:
        enriched = [s for s in enriched
                    if str(s.get("status", "")).lower() == status.lower()]

    total   = len(items)
    enabled = sum(1 for s in items if str(s.get("status", "")).lower() == "enabled")

    return {
        "total":     total,
        "enabled":   enabled,
        "disabled":  total - enabled,
        "filtered":  len(enriched),
        "schedules": enriched,
    }


@router.get("/linked-tasks")
async def linked_tasks(
    schedule_name: str = Query(...),
    x_session_id: str = Header(...),
    x_server_url: str = Header(...),
):
    """
    Scan the most-recent activityLog page for entries whose scheduleName
    matches the given schedule, and return the distinct tasks.
    """
    url = (
        f"{x_server_url}/api/v2/activity/activityLog"
        f"?rowLimit=200&offset=0"
    )
    rows = await _infa_get(url, x_session_id, use_v3=False)
    rows = rows if isinstance(rows, list) else []

    seen: dict[str, dict] = {}
    for entry in rows:
        if (entry.get("scheduleName") or "").lower() != schedule_name.lower():
            continue
        task_name = entry.get("objectName") or ""
        if task_name and task_name not in seen:
            seen[task_name] = {
                "taskName":    task_name,
                "taskType":    entry.get("type"),
                "lastRunUtc":  entry.get("startTimeUtc"),
                "lastState":   entry.get("state"),
            }

    return {"scheduleName": schedule_name, "tasks": list(seen.values())}
