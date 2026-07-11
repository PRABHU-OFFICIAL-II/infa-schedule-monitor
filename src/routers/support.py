"""
Support engineer endpoints.

Authentication uses two IDMC session cookies that the support user
copies from their browser (DevTools → Application → Cookies):

  USER_SESSION  – HttpOnly session token for dm-us.informaticacloud.com
  XSRF_TOKEN    – CSRF token; sent as both a cookie and a request header

The pod URL from the HAR shows the scheduler-service lives at:
  https://{pod}.informaticacloud.com/scheduler-service/api/v2/...

No selectOrg call is needed — after the support user navigates to the
customer org in their browser the USER_SESSION is already scoped to it.
"""
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from src.utils.schedule_utils import interval_label, next_run_utc

router = APIRouter()


class SchedulesReq(BaseModel):
    orgId: str
    podHost: str      # e.g. "use4.dm-us" or "na1.dm-us"
    userSession: str  # value of USER_SESSION cookie
    xsrfToken: str    # value of XSRF_TOKEN cookie


def _pod_base(pod_host: str) -> str:
    host = pod_host.strip().rstrip("/")
    if not host.endswith(".informaticacloud.com"):
        host = f"{host}.informaticacloud.com"
    return f"https://{host}"


def _enrich(s: dict) -> dict:
    return {
        **s,
        "intervalLabel": interval_label(s),
        "nextRunUtc":    next_run_utc(s),
    }


@router.post("/schedules")
async def support_schedules(req: SchedulesReq):
    """
    Fetch all schedules for a customer org using the support engineer's
    browser session cookies.
    """
    pod_base = _pod_base(req.podHost)
    url = (
        f"{pod_base}/scheduler-service/api/v2"
        f"/Organizations('{req.orgId}')/Schedules"
    )

    headers = {
        "Accept": "application/json, text/plain, */*",
        "X-Requested-With": "XMLHttpRequest",
        "XSRF_TOKEN": req.xsrfToken,
        "X_INFA_LOG_CTX": "req_id=infa-monitor-support",
    }
    # Must match the browser's cookie jar for the pod domain exactly.
    # SELECTED_ORG_ID tells the scheduler-service which org context to use.
    cookies = {
        "USER_SESSION":    req.userSession,
        "XSRF_TOKEN":      req.xsrfToken,
        "SELECTED_ORG_ID": req.orgId,
    }

    all_schedules: list[dict] = []
    skip = 0
    top  = 100

    async with httpx.AsyncClient(verify=False, timeout=30) as client:
        while True:
            try:
                r = await client.get(
                    url,
                    params={"$count": "true", "$top": top, "$skip": skip},
                    headers=headers,
                    cookies=cookies,
                )
            except httpx.RequestError as exc:
                raise HTTPException(502, f"Could not reach scheduler-service at {pod_base}: {exc}") from exc

            if r.status_code == 401:
                raise HTTPException(
                    401,
                    "IDMC session rejected (401) — your USER_SESSION or XSRF_TOKEN may have expired. "
                    "Copy fresh values from browser DevTools and try again."
                )
            if r.status_code == 403:
                raise HTTPException(
                    403,
                    "Access denied (403) — make sure your support account has access to this org "
                    "and the XSRF_TOKEN matches the USER_SESSION."
                )
            if r.status_code != 200:
                raise HTTPException(
                    r.status_code,
                    f"scheduler-service error ({r.status_code}): {r.text[:300]}"
                )

            data = r.json()
            page = data.get("value", [])
            all_schedules.extend(page)

            total = data.get("@odata.count", len(all_schedules))
            skip += top
            if skip >= total or not page:
                break

    enriched = [_enrich(s) for s in all_schedules]
    enabled  = sum(1 for s in all_schedules if str(s.get("status", "")).lower() == "enabled")

    return {
        "orgId":     req.orgId,
        "total":     len(all_schedules),
        "enabled":   enabled,
        "disabled":  len(all_schedules) - enabled,
        "schedules": enriched,
    }
