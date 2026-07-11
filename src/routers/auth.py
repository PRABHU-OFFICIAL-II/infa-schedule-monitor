import asyncio
import base64
import json
from urllib.parse import urlparse
import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

router = APIRouter()


# ── request models ──────────────────────────────────────────────

class StandardLoginRequest(BaseModel):
    username: str
    password: str
    loginUrl: str

class SamlLoginRequest(BaseModel):
    samlToken: str
    orgId: str
    loginUrl: str

class OAuthLoginRequest(BaseModel):
    oauthToken: str
    orgId: str
    loginUrl: str

class SalesforceLoginRequest(BaseModel):
    sfSessionId: str
    sfServerUrl: str
    loginUrl: str


# ── shared response ──────────────────────────────────────────────

class LoginResponse(BaseModel):
    icSessionId: str
    serverUrl: str
    orgId: str
    orgUuid: str
    name: str
    firstName: str
    lastName: str
    userSession: str = ""
    xsrfToken: str = ""


# ── helpers ──────────────────────────────────────────────────────

async def _post_infa(url: str, payload: dict) -> tuple[dict, dict]:
    """POST to Informatica v2 API. Returns (json_body, cookies_dict)."""
    async with httpx.AsyncClient(timeout=15) as client:
        try:
            resp = await client.post(
                url,
                json=payload,
                headers={"Content-Type": "application/json", "Accept": "application/json"},
            )
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"Could not reach Informatica: {e}")

    if resp.status_code != 200:
        try:
            err = resp.json()
            msg = err.get("error", {}).get("message") or err.get("message") or resp.text
        except Exception:
            msg = resp.text
        raise HTTPException(status_code=resp.status_code, detail=msg)

    return resp.json(), dict(resp.cookies)


async def _fetch_ids_cookies(base_url: str, username: str, password: str) -> tuple[str, str]:
    """
    Run the full identity-service → OAuth → pod flow to obtain USER_SESSION and
    XSRF_TOKEN that belong to the same pod session.

    HAR-confirmed flow:
      1. GET  /identity-service/home           → sets IDS-CSRF-TOKEN cookie
      2. POST /identity-service/login           → sets IDS-SESSION cookie (200, not a redirect)
      3. GET  /ma/home                          → triggers OAuth chain:
               → /identity-service/authorize
               → /ma/postAuthorize?code=...
               → https://<pod>/cloudshell/afterLogin  (cross-domain, sets pod cookies)
      4. Pod sets USER_SESSION + XSRF_TOKEN on its domain

    Returns (user_session, xsrf_token). Both "" on any failure.
    """
    ids_base = base_url.rstrip("/")
    try:
        async with httpx.AsyncClient(
            verify=True,
            timeout=httpx.Timeout(30.0),
            follow_redirects=True,
        ) as client:

            # Step 1: pre-login GET → IDS-CSRF-TOKEN
            pre = await client.get(
                f"{ids_base}/identity-service/home",
                headers={"Accept": "text/html,application/xhtml+xml,*/*"},
            )
            csrf = client.cookies.get("IDS-CSRF-TOKEN", "")
            if not csrf:
                for val in pre.headers.get_list("set-cookie"):
                    for part in val.split(";"):
                        part = part.strip()
                        if part.upper().startswith("IDS-CSRF-TOKEN="):
                            csrf = part.split("=", 1)[1]
                            break
                    if csrf:
                        break
            if not csrf:
                print("[ids] no IDS-CSRF-TOKEN from pre-login GET")
                return "", ""
            print(f"[ids] step1 csrf prefix={csrf[:8]}")

            # Step 2: POST credentials → IDS-SESSION (returns 200, not a redirect)
            login_resp = await client.post(
                f"{ids_base}/identity-service/login",
                json={"username": username, "password": password},
                headers={
                    "Content-Type":     "application/json",
                    "Accept":           "application/json",
                    "IDS-CSRF-TOKEN":   csrf,
                    "X-Requested-With": "XMLHttpRequest",
                },
            )
            print(f"[ids] step2 login status={login_resp.status_code} cookies={list({c.name for c in client.cookies.jar})}")

            # Step 3: GET /ma/home — triggers authorize → postAuthorize →
            # cloudshell/afterLogin redirect chain; follow_redirects handles it all
            ma_resp = await client.get(
                f"{ids_base}/ma/home",
                headers={"Accept": "text/html,application/xhtml+xml,*/*"},
            )
            print(f"[ids] step3 final_url={ma_resp.url} status={ma_resp.status_code}")

            all_cookies = {c.name: c.value for c in client.cookies.jar}
            print(f"[ids] all cookie names after chain: {list(all_cookies.keys())}")

            user_session = all_cookies.get("USER_SESSION", "")
            xsrf_token   = all_cookies.get("XSRF_TOKEN", "")
            if not xsrf_token:
                xsrf_token = all_cookies.get("IDS-CSRF-TOKEN", csrf)

            print(f"[ids] USER_SESSION={bool(user_session)} XSRF_TOKEN={bool(xsrf_token)} xsrf prefix={xsrf_token[:8] if xsrf_token else 'none'}")
            return user_session, xsrf_token

    except Exception as exc:
        print(f"[ids] exception: {exc}")
        return "", ""


def _build_response(data: dict, cookies: dict | None = None) -> LoginResponse:
    cookies = cookies or {}
    xsrf = cookies.get("XSRF_TOKEN", "")
    if not xsrf:
        ids_token = cookies.get("IDS_TOKEN", "")
        if ids_token:
            try:
                segment = ids_token.split(".")[1]
                segment += "=" * (-len(segment) % 4)
                xsrf = json.loads(base64.urlsafe_b64decode(segment)).get("xid", "")
            except Exception:
                pass
    return LoginResponse(
        icSessionId=data["icSessionId"],
        serverUrl=data["serverUrl"],
        orgId=data["orgId"],
        orgUuid=data.get("orgUuid", ""),
        name=data["name"],
        firstName=data.get("firstName", ""),
        lastName=data.get("lastName", ""),
        userSession=cookies.get("USER_SESSION") or data.get("icSessionId", ""),
        xsrfToken=xsrf,
    )


# ── endpoints ────────────────────────────────────────────────────

@router.post("/login", response_model=LoginResponse)
async def login_standard(body: StandardLoginRequest):
    parsed   = urlparse(body.loginUrl)
    ids_base = f"{parsed.scheme}://{parsed.netloc}"

    # Run v2 API login and identity-service browser flow concurrently
    (data, cookies), (user_session, xsrf_token) = await asyncio.gather(
        _post_infa(body.loginUrl, {
            "@type":    "login",
            "username": body.username,
            "password": body.password,
        }),
        _fetch_ids_cookies(ids_base, body.username, body.password),
    )

    # Merge: IDS cookies take priority (they're the browser-equivalent values)
    if user_session:
        cookies["USER_SESSION"] = user_session
    if xsrf_token:
        cookies["XSRF_TOKEN"] = xsrf_token

    return _build_response(data, cookies)


@router.post("/login/saml", response_model=LoginResponse)
async def login_saml(body: SamlLoginRequest):
    saml_url = body.loginUrl.rstrip("/").replace("/login", "") + "/loginSaml"
    data, cookies = await _post_infa(saml_url, {
        "@type":     "login",
        "samlToken": body.samlToken,
        "orgId":     body.orgId,
    })
    return _build_response(data, cookies)


@router.post("/login/oauth", response_model=LoginResponse)
async def login_oauth(body: OAuthLoginRequest):
    oauth_url = body.loginUrl.rstrip("/").replace("/login", "") + "/loginOAuth"
    data, cookies = await _post_infa(oauth_url, {
        "orgId":      body.orgId,
        "oauthToken": body.oauthToken,
    })
    return _build_response(data, cookies)


@router.post("/login/salesforce", response_model=LoginResponse)
async def login_salesforce(body: SalesforceLoginRequest):
    sf_url = body.loginUrl.rstrip("/").replace("/login", "") + "/loginSf"
    data, cookies = await _post_infa(sf_url, {
        "@type":       "loginSf",
        "sfSessionId": body.sfSessionId,
        "sfServerUrl": body.sfServerUrl,
    })
    return _build_response(data, cookies)


@router.post("/logout")
async def logout(server_url: str, session_id: str):
    async with httpx.AsyncClient(timeout=10) as client:
        try:
            await client.post(
                f"{server_url}/api/v2/user/logout",
                headers={
                    "Content-Type": "application/json",
                    "Accept":       "application/json",
                    "icSessionId":  session_id,
                },
            )
        except httpx.RequestError:
            pass
    return {"status": "logged_out"}
