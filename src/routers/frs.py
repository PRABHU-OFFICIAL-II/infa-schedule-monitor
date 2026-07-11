"""
Asset inventory endpoints:

  Support-user side (USER_SESSION / XSRF_TOKEN cookies):
    POST /api/frs/projects          → list all FRS projects
    POST /api/frs/project-assets    → assets for ONE project (recursive)

  Normal IICS user side (icSessionId header):
    POST /api/frs/iics/assets       → all schedulable assets via v3 public API
                                      (GET /saas/public/core/v3/objects?q=type==...)

Only MCT, TASKFLOW, SAAS_LINEAR_TASKFLOW are returned — the only types
Informatica's scheduler can run.
"""
import asyncio
from urllib.parse import quote as url_quote
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()

PAGE_SIZE = 200

# The only asset types a schedule can trigger
SCHEDULABLE_TYPES = {"MCT", "TASKFLOW", "SAAS_LINEAR_TASKFLOW"}

FOLDER_TYPES = {"Folder"}


class BaseReq(BaseModel):
    orgId:       str
    podHost:     str
    userSession: str
    xsrfToken:   str


class ProjectAssetsReq(BaseModel):
    projectId:   str
    projectName: str
    podHost:     str
    userSession: str
    xsrfToken:   str


# ── Normal IICS user request models (icSessionId + serverUrl) ─────────────

class IICSAssetsReq(BaseModel):
    serverUrl:   str   # e.g. https://usw3.dm-us.informaticacloud.com
    icSessionId: str


class IICSAssetSchedulesReq(BaseModel):
    serverUrl:   str
    icSessionId: str
    userSession: str = ""
    xsrfToken:   str = ""
    assets:      list  # [{"id": "...", "name": "...", "documentType": "..."}]


def _pod_base(pod_host: str) -> str:
    host = pod_host.strip().rstrip("/")
    if not host.endswith(".informaticacloud.com"):
        host = f"{host}.informaticacloud.com"
    return f"https://{host}"


def _make_client(user_session: str, xsrf_token: str) -> httpx.AsyncClient:
    return httpx.AsyncClient(
        verify=False,
        timeout=httpx.Timeout(60.0),
        cookies={"USER_SESSION": user_session, "XSRF_TOKEN": xsrf_token},
        headers={
            "Accept": "application/json, text/plain, */*",
            "X-Requested-With": "XMLHttpRequest",
            "XSRF_TOKEN": xsrf_token,
        },
    )


def _make_iics_client(ic_session_id: str) -> httpx.AsyncClient:
    """Client for normal IICS users — v3 public API uses INFA-SESSION-ID header."""
    return httpx.AsyncClient(
        verify=True,
        timeout=httpx.Timeout(60.0),
        headers={
            "Content-Type":    "application/json",
            "Accept":          "application/json",
            "INFA-SESSION-ID": ic_session_id,
        },
    )


def _split_items(items: list) -> tuple[list, list]:
    """Separate a BaseEntities page into (schedulable_assets, folder_ids)."""
    assets: list = []
    folder_ids: list = []
    for item in items:
        doc_type = item.get("documentType", "")
        if doc_type in FOLDER_TYPES:
            fid = item.get("id")
            if fid:
                folder_ids.append(fid)
        elif doc_type in SCHEDULABLE_TYPES:
            assets.append({
                "id":           item.get("id"),
                "name":         item.get("name", ""),
                "documentType": doc_type,
                "path":         item.get("path", ""),
                "projectId":    item.get("projectId") or item.get("containerId"),
                "frsId":        item.get("frsId") or item.get("id"),
            })
    return assets, folder_ids


async def _paginate(
    client: httpx.AsyncClient,
    url: str,
    extra_params: dict | None = None,
) -> tuple[list, list]:
    """Page through a BaseEntities URL.  Returns (assets, folder_ids)."""
    all_assets: list = []
    all_folders: list = []
    skip = 0
    while True:
        params = {
            "$count": "true",
            "$top": PAGE_SIZE,
            "$skip": skip,
            "recurseContainer": "false",
            **(extra_params or {}),
        }
        try:
            r = await client.get(url, params=params)
        except httpx.RequestError as exc:
            raise HTTPException(502, f"FRS request error: {exc}") from exc

        if r.status_code == 401:
            raise HTTPException(401, "IDMC session expired — re-login as support user")
        if r.status_code != 200:
            raise HTTPException(r.status_code, f"FRS error {r.status_code}: {r.text[:300]}")

        data  = r.json()
        items = data.get("value", [])
        print(f"[frs] {url} skip={skip} → {len(items)} items")
        assets, folders = _split_items(items)
        all_assets.extend(assets)
        all_folders.extend(folders)

        fetched = skip + len(items)
        total   = data.get("@odata.count")
        skip   += PAGE_SIZE
        if not items or (total is not None and fetched >= int(total)):
            break

    return all_assets, all_folders


async def _crawl_folder(
    client: httpx.AsyncClient,
    pod_base: str,
    folder_id: str,
) -> tuple[list, int]:
    """Recursively fetch all schedulable assets under a folder.
    Returns (assets, folder_count)."""
    url = f"{pod_base}/frs/api/v1/Folders('{folder_id}')/BaseEntities"
    assets, child_ids = await _paginate(client, url)
    folders_found = len(child_ids)
    if child_ids:
        sub = await asyncio.gather(
            *[_crawl_folder(client, pod_base, fid) for fid in child_ids],
            return_exceptions=True,
        )
        for result in sub:
            if isinstance(result, tuple):
                sub_assets, sub_count = result
                assets.extend(sub_assets)
                folders_found += sub_count
    return assets, folders_found


# ── Endpoints ──────────────────────────────────────────────────────────────

@router.post("/projects")
async def list_projects(req: BaseReq):
    """Return all FRS projects for the org."""
    pod_base  = _pod_base(req.podHost)
    projects: list = []
    skip = 0

    async with _make_client(req.userSession, req.xsrfToken) as client:
        while True:
            try:
                r = await client.get(
                    f"{pod_base}/frs/api/v1/Projects",
                    params={"$count": "true", "$top": PAGE_SIZE, "$skip": skip},
                )
            except httpx.RequestError as exc:
                raise HTTPException(502, f"FRS projects error: {exc}") from exc

            if r.status_code == 401:
                raise HTTPException(401, "IDMC session expired — re-login as support user")
            if r.status_code != 200:
                raise HTTPException(r.status_code, f"FRS projects {r.status_code}: {r.text[:300]}")

            data = r.json()
            page = data.get("value", [])
            print(f"[frs] Projects skip={skip} → {len(page)}")
            projects.extend(page)

            fetched = skip + len(page)
            total   = data.get("@odata.count")
            skip   += PAGE_SIZE
            if not page or (total is not None and fetched >= int(total)):
                break

    return {
        "projects": [{"id": p.get("id"), "name": p.get("name", "")} for p in projects],
        "total":    len(projects),
    }


@router.post("/project-assets")
async def get_project_assets(req: ProjectAssetsReq):
    """
    Return all schedulable assets (MCT / TASKFLOW / SAAS_LINEAR_TASKFLOW) for
    one project, recursing into any Folders found.
    """
    pod_base = _pod_base(req.podHost)
    url      = f"{pod_base}/frs/api/v1/Projects('{req.projectId}')/BaseEntities"

    async with _make_client(req.userSession, req.xsrfToken) as client:
        assets, folder_ids = await _paginate(client, url)

        folders_scanned = 0
        if folder_ids:
            folder_results = await asyncio.gather(
                *[_crawl_folder(client, pod_base, fid) for fid in folder_ids],
                return_exceptions=True,
            )
            for result in folder_results:
                if isinstance(result, tuple):
                    sub_assets, sub_count = result
                    for a in sub_assets:
                        a.setdefault("projectName", req.projectName)
                    assets.extend(sub_assets)
                    folders_scanned += sub_count
            folders_scanned += len(folder_ids)

    for a in assets:
        a.setdefault("projectName", req.projectName)

    return {
        "projectId":      req.projectId,
        "projectName":    req.projectName,
        "assets":         assets,
        "assetCount":     len(assets),
        "foldersScanned": folders_scanned,
    }


# ── Normal IICS user endpoint — v3 public API ─────────────────────────────
#
# GET /saas/public/core/v3/objects?q=type=='MCT' OR type=='TASKFLOW' OR ...
#
# The v3 API is a flat paginated list — no project/folder tree to walk.
# Pagination uses `limit` + `skip`; total is in the `count` field.

# v3 type names for schedulable assets (v3 uses MTT/TASKFLOW/WORKFLOW — confirmed from API responses)
V3_SCHEDULABLE_TYPES = ["MTT", "TASKFLOW", "WORKFLOW"]
V3_TYPE_FILTER = ",".join(f"type=='{t}'" for t in V3_SCHEDULABLE_TYPES)
V3_PAGE_SIZE   = 200


@router.post("/iics/assets")
async def iics_get_all_assets(req: IICSAssetsReq):
    """
    Return all schedulable assets (MCT / TASKFLOW / SAAS_LINEAR_TASKFLOW) for
    the authenticated org using the v3 public API.

    The v3 API is a single flat endpoint — no project listing or folder recursion
    needed.  We page through using limit + skip until exhausted.
    """
    base = req.serverUrl.rstrip("/")
    url  = f"{base}/public/core/v3/objects"

    all_assets: list = []
    skip = 0

    async with _make_iics_client(req.icSessionId) as client:
        while True:
            try:
                r = await client.get(
                    url,
                    params={
                        "q":      V3_TYPE_FILTER,
                        "limit":  V3_PAGE_SIZE,
                        "skip":   skip,
                    },
                )
            except httpx.RequestError as exc:
                raise HTTPException(502, f"v3 objects request error: {exc}") from exc

            if r.status_code == 401:
                raise HTTPException(401, "IICS session expired — please log in again")
            if r.status_code != 200:
                raise HTTPException(r.status_code, f"v3 objects error {r.status_code}: {r.text[:300]}")

            data    = r.json()
            page    = data.get("objects", [])
            total   = data.get("count", 0)

            for obj in page:
                all_assets.append({
                    "id":           obj.get("id"),
                    "name":         obj.get("path", "").rsplit("/", 1)[-1],
                    "documentType": obj.get("type", ""),
                    "path":         obj.get("path", ""),
                    "projectName":  obj.get("path", "").split("/")[0] if "/" in obj.get("path", "") else "",
                    "frsId":        obj.get("id"),
                    "updatedBy":    obj.get("updatedBy", ""),
                    "updateTime":   obj.get("updateTime", ""),
                    "scheduleId":   obj.get("scheduleId") or obj.get("scheduleid") or obj.get("schedule_id") or "",
                })

            skip += len(page)
            print(f"[frs/iics] skip={skip - len(page)} → {len(page)} objects (total={total})")

            if not page or skip >= total:
                break

    return {
        "assets":     all_assets,
        "assetCount": len(all_assets),
        "total":      len(all_assets),
    }


@router.post("/iics/asset-schedules")
async def iics_get_asset_schedules(req: IICSAssetSchedulesReq):
    """
    Resolve schedule assignments for all assets:

    - MTT      → GET /api/v2/mttask/{id} → .scheduleId  (direct v2 API)
    - TASKFLOW → GET /scheduler-service/api/v2/Jobs?$filter=externalId eq '{id}'
                 → job.name (the schedule name).  Requires userSession + xsrfToken.

    Returns { scheduleMap: { assetId: scheduleId },
              scheduleNameMap: { assetId: scheduleName } }
    """
    base = req.serverUrl.rstrip("/")
    sem  = asyncio.Semaphore(20)

    async def _fetch_mtt(client: httpx.AsyncClient, asset_id: str) -> tuple[str, str | None]:
        async with sem:
            try:
                r = await client.get(f"{base}/api/v2/mttask/{asset_id}")
                if r.status_code != 200:
                    return asset_id, None
                data = r.json()
                if isinstance(data, list):
                    data = data[0] if data else {}
                sched_id = data.get("scheduleId") or data.get("scheduleid") or data.get("schedule_id")
                return asset_id, sched_id or None
            except Exception:
                return asset_id, None

    mtt_assets      = [a for a in req.assets if a.get("documentType") in ("MCT", "MTT")]
    taskflow_assets = [a for a in req.assets if a.get("documentType") in ("TASKFLOW", "SAAS_LINEAR_TASKFLOW", "WORKFLOW")]

    # ── MTT: parallel v2 mttask lookups ──────────────────────────────────────
    async with httpx.AsyncClient(
        verify=True, timeout=httpx.Timeout(30.0),
        headers={"Content-Type": "application/json", "Accept": "application/json",
                 "icSessionId": req.icSessionId},
    ) as vc:
        mtt_results = await asyncio.gather(
            *[_fetch_mtt(vc, a["id"]) for a in mtt_assets],
            return_exceptions=True,
        )

    schedule_map: dict[str, str] = {}
    for item in mtt_results:
        if isinstance(item, tuple):
            asset_id, sched_id = item
            if sched_id:
                schedule_map[asset_id] = sched_id

    # ── TASKFLOW: scheduler-service lookup via externalId filter ─────────────
    # Browser confirms: GET /scheduler-service/api/v2/Jobs?$filter=externalId eq '{id}'
    # We pass the $filter as a raw URL query string — NOT via httpx params={} — because
    # httpx would percent-encode '$' to '%24', which breaks the OData endpoint.
    schedule_name_map: dict[str, str] = {}
    if taskflow_assets and req.userSession and req.xsrfToken:
        pod_base = base.removesuffix("/saas")

        async def _fetch_jobs_for_asset(
            client: httpx.AsyncClient, asset_id: str
        ) -> tuple[str, list[dict]]:
            """Return (asset_id, [job_objects]) for jobs whose externalId == asset_id."""
            async with sem:
                try:
                    flt = f"externalId eq '{asset_id}'"
                    url = f"{pod_base}/scheduler-service/api/v2/Jobs?$filter={url_quote(flt)}"
                    r = await client.get(url)
                    if r.status_code != 200:
                        return asset_id, []
                    body = r.json()
                    jobs = body if isinstance(body, list) else body.get("value", body.get("jobs", []))
                    if not isinstance(jobs, list):
                        jobs = [jobs] if jobs else []
                    return asset_id, jobs
                except Exception as exc:
                    print(f"[sched] jobs fetch {asset_id} exception: {exc}")
                    return asset_id, []

        async def _build_job_to_schedule_map(client: httpx.AsyncClient) -> tuple[dict[str, str], dict[str, str]]:
            """
            Fetch all scheduler-service Schedules, then for each schedule fetch its
            linked jobs via GET /Schedules/{id}/Jobs.
            Returns (job_id→sched_id, job_id→sched_name).
            """
            try:
                r = await client.get(f"{pod_base}/scheduler-service/api/v2/Schedules")
                print(f"[sched] Schedules → {r.status_code}")
                if r.status_code != 200:
                    return {}, {}
                body = r.json()
                schedules = body if isinstance(body, list) else body.get("value", body.get("schedules", []))
                if not isinstance(schedules, list):
                    schedules = [schedules] if schedules else []
            except Exception as exc:
                print(f"[sched] Schedules fetch exception: {exc}")
                return {}, {}

            job_to_id:   dict[str, str] = {}
            job_to_name: dict[str, str] = {}

            async def _fetch_sched_jobs(s: dict) -> None:
                sched_id   = s.get("id")   or ""
                sched_name = s.get("name") or ""
                if not sched_id:
                    return
                try:
                    rj = await client.get(
                        f"{pod_base}/scheduler-service/api/v2/Schedules('{sched_id}')/Jobs"
                    )
                    print(f"[sched] Schedule/{sched_name}/Jobs → {rj.status_code}")
                    if rj.status_code != 200:
                        return
                    jbody = rj.json()
                    jobs = jbody if isinstance(jbody, list) else jbody.get("value", jbody.get("jobs", []))
                    if not isinstance(jobs, list):
                        jobs = [jobs] if jobs else []
                    print(f"[sched] {sched_name}: {len(jobs)} linked jobs")
                    for job in jobs:
                        jid = job.get("id") if isinstance(job, dict) else str(job)
                        if jid:
                            job_to_id[jid]   = sched_id
                            job_to_name[jid] = sched_name
                except Exception as exc:
                    print(f"[sched] Schedule/{sched_id}/Jobs exception: {exc}")

            await asyncio.gather(*[_fetch_sched_jobs(s) for s in schedules])
            print(f"[sched] job_to_sched entries={len(job_to_id)}")
            return job_to_id, job_to_name

        async with httpx.AsyncClient(
            verify=True,
            timeout=httpx.Timeout(30.0),
            follow_redirects=False,
            cookies={"USER_SESSION": req.userSession, "XSRF_TOKEN": req.xsrfToken},
            headers={
                "Accept":           "application/json, text/plain, */*",
                "X-Requested-With": "XMLHttpRequest",
                "XSRF_TOKEN":       req.xsrfToken,
            },
        ) as sched_client:
            # Fetch per-asset jobs AND the job→schedule map concurrently
            job_results_raw, (job_to_sched_id, job_to_sched_name) = await asyncio.gather(
                asyncio.gather(
                    *[_fetch_jobs_for_asset(sched_client, a["id"]) for a in taskflow_assets],
                    return_exceptions=True,
                ),
                _build_job_to_schedule_map(sched_client),
            )

        # Map asset_id → schedule IDs using the job→schedule lookup
        for item in job_results_raw:
            if not isinstance(item, tuple):
                continue
            asset_id, jobs = item
            if not jobs:
                continue
            sched_ids:   list[str] = []
            sched_names: list[str] = []
            seen: set[str] = set()
            for job in jobs:
                job_id = job.get("id") or ""
                sid  = job_to_sched_id.get(job_id)
                sname = job_to_sched_name.get(job_id)
                if sid and sid not in seen:
                    seen.add(sid)
                    sched_ids.append(sid)
                    if sname:
                        sched_names.append(sname)

            print(f"[sched] {asset_id}: job_count={len(jobs)} resolved_ids={sched_ids} resolved_names={sched_names}")

            if sched_ids:
                # Store v3 schedule ID as primary ref (frontend resolves to name via schedById)
                schedule_name_map[asset_id] = sched_ids[0]
                if len(sched_ids) > 1:
                    schedule_name_map[f"{asset_id}__all"] = ",".join(sched_ids)

        print(f"[sched] taskflow schedule_name_map entries: {len(schedule_name_map)}")

    return {"scheduleMap": schedule_map, "scheduleNameMap": schedule_name_map}
