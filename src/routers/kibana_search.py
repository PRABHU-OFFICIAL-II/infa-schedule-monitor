import httpx
from fastapi import APIRouter, HTTPException, Header
from pydantic import BaseModel

KIBANA_BASE  = "https://kibana.ext.prod.elk.cloudtrust.rocks"
KIBANA_SPACE = "/s/gcs"
KBN_VERSION  = "8.19.13"
DEFAULT_INDEX = "filebeat-*-intcloud-*"

router = APIRouter()


class SearchReq(BaseModel):
    kql: str
    time_from: str   # ISO-8601
    time_to:   str   # ISO-8601
    index: str = DEFAULT_INDEX
    size:  int = 50


def _kbn_headers(sid: str) -> dict:
    return {
        "kbn-version":               KBN_VERSION,
        "elastic-api-version":       "1",
        "x-elastic-internal-origin": "Kibana",
        "Content-Type":              "application/json",
        "Cookie":                    f"sid={sid}",
    }


@router.post("/search")
async def kibana_search(req: SearchReq, x_kibana_sid: str = Header(...)):
    """
    Search Kibana logs using the ES _search endpoint proxied through Kibana.
    We try three strategies in order:

      1. POST /internal/search/es  — Kibana's synchronous search proxy (fastest)
      2. POST /api/console/proxy   — raw ES proxy (bypasses Kibana search layer)
      3. POST /internal/bsearch    — async bsearch with short-circuit polling

    The first that returns 200 with hits wins.
    """
    es_query = {
        "query": {
            "bool": {
                "filter": [
                    {
                        "range": {
                            "@timestamp": {
                                "gte":    req.time_from,
                                "lte":    req.time_to,
                                "format": "strict_date_optional_time",
                            }
                        }
                    },
                    {
                        "query_string": {
                            "query":            req.kql,
                            "analyze_wildcard": True,
                        }
                    },
                ]
            }
        },
        "size":             req.size,
        "sort":             [{"@timestamp": {"order": "desc"}}],
        "track_total_hits": True,
        "timeout":          "25s",   # ES-level timeout so slow shards don't hang us
    }

    hdrs = _kbn_headers(x_kibana_sid)

    async with httpx.AsyncClient(verify=False, timeout=httpx.Timeout(35.0)) as c:

        # ── Strategy 1: /internal/search/es ──────────────────────────────
        try:
            r1 = await c.post(
                f"{KIBANA_BASE}{KIBANA_SPACE}/internal/search/es",
                json={"params": {"index": req.index, "body": es_query}},
                headers=hdrs,
            )
            if r1.status_code == 200:
                return _parse_search_es(r1.json())
            if r1.status_code == 401:
                raise HTTPException(401, "Kibana session expired — re-login as support user")
        except httpx.ReadTimeout:
            pass
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Could not reach Kibana: {exc}")

        # ── Strategy 2: /api/console/proxy → ES _search ──────────────────
        try:
            r2 = await c.post(
                f"{KIBANA_BASE}{KIBANA_SPACE}/api/console/proxy",
                params={"path": f"{req.index}/_search", "method": "POST"},
                json=es_query,
                headers=hdrs,
            )
            if r2.status_code == 200:
                return _parse_raw_es(r2.json())
            if r2.status_code == 401:
                raise HTTPException(401, "Kibana session expired — re-login as support user")
        except httpx.ReadTimeout:
            pass
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Could not reach Kibana: {exc}")

        # ── Strategy 3: /internal/bsearch (first chunk only) ─────────────
        bsearch_body = {
            "batch": [
                {
                    "request": {
                        "params": {"index": req.index, "body": es_query}
                    },
                    "options": {"strategy": "es"},
                }
            ]
        }
        try:
            r3 = await c.post(
                f"{KIBANA_BASE}{KIBANA_SPACE}/internal/bsearch",
                json=bsearch_body,
                headers=hdrs,
            )
            if r3.status_code == 401:
                raise HTTPException(401, "Kibana session expired — re-login as support user")
            if r3.status_code == 200:
                return _parse_bsearch(r3.text)
        except httpx.ReadTimeout:
            pass
        except httpx.RequestError as exc:
            raise HTTPException(502, f"Could not reach Kibana: {exc}")

    raise HTTPException(
        504,
        "All Kibana search strategies timed out. "
        "Try: shorter time range (e.g. Last 6h), more specific schedule name, or check Kibana connectivity."
    )


# ── Response parsers ──────────────────────────────────────────────────────

def _format_hits(hits: list) -> list:
    return [
        {
            "id":        h.get("_id"),
            "index":     h.get("_index"),
            "timestamp": h.get("_source", {}).get("@timestamp"),
            "message":   h.get("_source", {}).get("message", ""),
            "source":    h.get("_source", {}),
        }
        for h in hits
    ]


def _parse_search_es(data: dict) -> dict:
    """Parse /internal/search/es response."""
    try:
        raw = data.get("rawResponse") or data
        hits_data = raw.get("hits", {})
        hits      = hits_data.get("hits", [])
        total_val = hits_data.get("total", {})
        total = total_val.get("value", len(hits)) if isinstance(total_val, dict) else int(total_val or 0)
        return {"total": total, "hits": _format_hits(hits)}
    except (KeyError, TypeError):
        return {"total": 0, "hits": [], "_raw": data}


def _parse_raw_es(data: dict) -> dict:
    """Parse raw Elasticsearch _search response."""
    try:
        hits_data = data.get("hits", {})
        hits      = hits_data.get("hits", [])
        total_val = hits_data.get("total", {})
        total = total_val.get("value", len(hits)) if isinstance(total_val, dict) else int(total_val or 0)
        return {"total": total, "hits": _format_hits(hits)}
    except (KeyError, TypeError):
        return {"total": 0, "hits": [], "_raw": data}


def _parse_bsearch(text: str) -> dict:
    """
    bsearch returns NDJSON — each line is a JSON object.
    We take the first line that has hits data.
    """
    import json
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        # Could be wrapped in result/results
        result = obj.get("result") or obj
        if isinstance(result, list):
            result = result[0].get("result", {}) if result else {}
        raw = result.get("rawResponse") or result
        hits_data = raw.get("hits", {})
        if hits_data:
            hits      = hits_data.get("hits", [])
            total_val = hits_data.get("total", {})
            total = total_val.get("value", len(hits)) if isinstance(total_val, dict) else int(total_val or 0)
            return {"total": total, "hits": _format_hits(hits)}
    return {"total": 0, "hits": []}
