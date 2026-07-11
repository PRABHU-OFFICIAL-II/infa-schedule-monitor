"""
Kibana SAML login via Okta IDX API (the flow observed in HAR):

  1. POST Kibana /internal/security/login  → get Okta IdP URL
  2. GET  Okta IdP SSO URL                 → parse stateToken from HTML
  3. POST /idp/idx/introspect              → stateHandle
  4. POST /idp/idx/identify                → next stateHandle (password step)
  5. POST /idp/idx/challenge/answer        → next stateHandle (MFA step)
  6. POST /idp/idx/challenge               → trigger Okta Verify push
  7. Poll /idp/idx/authenticators/poll     → wait for push approval
  8. GET  login/token/redirect?stateToken= → HTML with SAML assertion form
  9. POST SAMLResponse → Kibana ACS        → 302 + Set-Cookie: sid=...
"""
import re
import asyncio
import httpx
from html.parser import HTMLParser
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

OKTA_DOMAIN   = "https://informatica.okta.com"
KIBANA_BASE   = "https://kibana.ext.prod.elk.cloudtrust.rocks"
KIBANA_SPACE  = "/s/gcs"
KBN_VERSION   = "8.19.13"

# Authenticator ID for Okta Verify push (observed in HAR)
PUSH_AUTHN_ID = "aut1x1yz0hvcDMeLB1d8"

router = APIRouter()

# In-process state for pending MFA sessions (keyed by stateHandle)
_pending: dict[str, dict] = {}


# ── Pydantic models ───────────────────────────────────────────────────────
class LoginReq(BaseModel):
    username: str
    password: str


class VerifyReq(BaseModel):
    state_handle: str


# ── HTML form parser ──────────────────────────────────────────────────────
class _FormParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.form_action: str | None = None
        self.inputs: dict[str, str] = {}

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        if tag == "form" and "action" in d:
            self.form_action = d["action"]
        if tag == "input" and d.get("name"):
            self.inputs[d["name"]] = d.get("value", "")


def _extract_state_token(html: str) -> str | None:
    patterns = [
        r'"stateToken"\s*:\s*"([^"]+)"',
        r"stateToken\s*=\s*['\"]([^'\"]+)['\"]",
        r"'stateToken'\s*:\s*'([^']+)'",
    ]
    for p in patterns:
        m = re.search(p, html)
        if m:
            return m.group(1).replace("\\x2D", "-").replace("\\u002D", "-")
    return None


# ── Step helpers ──────────────────────────────────────────────────────────

async def _kibana_saml_init(client: httpx.AsyncClient) -> str:
    r = await client.post(
        f"{KIBANA_BASE}/internal/security/login",
        headers={
            "kbn-version": KBN_VERSION,
            "elastic-api-version": "1",
            "x-elastic-internal-origin": "Kibana",
            "Content-Type": "application/json",
        },
        json={
            "providerType": "saml",
            "providerName": "saml1",
            "currentURL": f"{KIBANA_BASE}/login?next=%2F",
        },
    )
    if not r.is_success:
        raise HTTPException(502, f"Kibana SAML init failed ({r.status_code}): {r.text[:200]}")
    data = r.json()
    location = data.get("location") or r.headers.get("location")
    if not location:
        raise HTTPException(502, f"Kibana did not return an IdP URL. Response: {str(data)[:200]}")
    return location


async def _get_state_token(client: httpx.AsyncClient, idp_url: str) -> str:
    r = await client.get(idp_url)
    if not r.is_success:
        raise HTTPException(502, f"Okta SSO GET failed ({r.status_code})")
    token = _extract_state_token(r.text)
    if not token:
        raise HTTPException(502, "Could not extract stateToken from Okta login page")
    return token


async def _idx_introspect(client: httpx.AsyncClient, state_token: str) -> str:
    r = await client.post(
        f"{OKTA_DOMAIN}/idp/idx/introspect",
        json={"stateToken": state_token},
        headers={"Content-Type": "application/ion+json; okta-version=1.0.0",
                 "Accept": "application/ion+json; okta-version=1.0.0"},
    )
    if not r.is_success:
        raise HTTPException(502, f"IDX introspect failed ({r.status_code})")
    return _extract_state_handle(r.json())


async def _idx_identify(client: httpx.AsyncClient, username: str, state_handle: str) -> str:
    r = await client.post(
        f"{OKTA_DOMAIN}/idp/idx/identify",
        json={"identifier": username, "rememberMe": False, "stateHandle": state_handle},
        headers={"Content-Type": "application/ion+json; okta-version=1.0.0",
                 "Accept": "application/ion+json; okta-version=1.0.0"},
    )
    if not r.is_success:
        raise HTTPException(401 if r.status_code == 401 else 502,
                            f"IDX identify failed ({r.status_code})")
    return _extract_state_handle(r.json())


async def _idx_answer_password(client: httpx.AsyncClient, password: str, state_handle: str) -> str:
    r = await client.post(
        f"{OKTA_DOMAIN}/idp/idx/challenge/answer",
        json={"credentials": {"passcode": password}, "stateHandle": state_handle},
        headers={"Content-Type": "application/ion+json; okta-version=1.0.0",
                 "Accept": "application/ion+json; okta-version=1.0.0"},
    )
    if not r.is_success:
        raise HTTPException(401 if r.status_code == 401 else 502,
                            f"IDX password answer failed ({r.status_code})")
    data = r.json()
    msgs = data.get("messages", {}).get("value", [])
    for m in msgs:
        if m.get("class") == "ERROR":
            raise HTTPException(401, m.get("message", "Invalid password"))
    return _extract_state_handle(data)


async def _idx_trigger_push(client: httpx.AsyncClient, state_handle: str) -> str:
    r = await client.post(
        f"{OKTA_DOMAIN}/idp/idx/challenge",
        json={
            "authenticator": {"id": PUSH_AUTHN_ID, "methodType": "push"},
            "stateHandle": state_handle,
        },
        headers={"Content-Type": "application/ion+json; okta-version=1.0.0",
                 "Accept": "application/ion+json; okta-version=1.0.0"},
    )
    if not r.is_success:
        raise HTTPException(502, f"IDX push challenge failed ({r.status_code})")
    return _extract_state_handle(r.json())


def _extract_state_handle(data: dict) -> str:
    if "stateHandle" in data:
        return data["stateHandle"]
    for key in ("remediation", "currentAuthenticator", "authenticators"):
        val = data.get(key)
        if isinstance(val, dict):
            nested = val.get("value", [])
            if isinstance(nested, list):
                for item in nested:
                    if isinstance(item, dict) and "stateHandle" in item:
                        return item["stateHandle"]
    raise HTTPException(502, f"Could not extract stateHandle from IDX response: {str(data)[:200]}")


def _extract_success_redirect(data: dict) -> str | None:
    swic = data.get("successWithInteractionCode")
    if isinstance(swic, dict) and "href" in swic:
        return swic["href"]
    for item in data.get("terminal", []):
        val = item.get("value", {})
        if isinstance(val, dict):
            url = val.get("url", "")
            if "login/token/redirect" in url or "login/sessionCookieRedirect" in url:
                return url
    success = data.get("success")
    if isinstance(success, dict) and success.get("href"):
        return success["href"]
    return None


async def _poll_push(client: httpx.AsyncClient, state_handle: str, max_polls: int = 30) -> str:
    for _ in range(max_polls):
        await asyncio.sleep(3)
        r = await client.post(
            f"{OKTA_DOMAIN}/idp/idx/authenticators/poll",
            json={"autoChallenge": True, "stateHandle": state_handle},
            headers={"Content-Type": "application/ion+json; okta-version=1.0.0",
                     "Accept": "application/ion+json; okta-version=1.0.0"},
        )
        data = r.json()
        msgs = data.get("messages", {}).get("value", [])
        for m in msgs:
            if "reject" in m.get("message", "").lower() or "denied" in m.get("message", "").lower():
                raise HTTPException(401, "Push notification was rejected — please try again")
        redirect_url = _extract_success_redirect(data)
        if redirect_url:
            return redirect_url
        try:
            state_handle = _extract_state_handle(data)
        except HTTPException:
            pass
    raise HTTPException(408, "MFA push timed out (90 s) — approve the Okta Verify notification and retry")


async def _complete_saml(client: httpx.AsyncClient, redirect_url: str) -> str:
    """GET token-redirect page → POST SAMLResponse to Kibana ACS → return sid."""
    r = await client.get(redirect_url, follow_redirects=True)
    if not r.is_success:
        raise HTTPException(502, f"GET login/token/redirect failed ({r.status_code})")
    parser = _FormParser()
    parser.feed(r.text)
    if not parser.form_action:
        raise HTTPException(502, "No form action found in Okta SAML redirect page")
    if "SAMLResponse" not in parser.inputs:
        raise HTTPException(502, "SAMLResponse not found in Okta redirect page form")
    acs_r = await client.post(
        parser.form_action,
        data=parser.inputs,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        follow_redirects=False,
    )
    sid = _find_sid(acs_r)
    if not sid:
        loc = acs_r.headers.get("location")
        if loc:
            next_url = loc if loc.startswith("http") else f"{KIBANA_BASE}{loc}"
            r2 = await client.get(next_url, follow_redirects=False)
            sid = _find_sid(r2)
    if not sid:
        raise HTTPException(502,
            "SAML flow completed but no Kibana session cookie received. "
            f"ACS status: {acs_r.status_code}")
    return sid


def _find_sid(r: httpx.Response) -> str | None:
    for name, value in r.cookies.items():
        if name.lower() in ("sid", "kibana.sid", "kbn.sid"):
            return value
    for header_name, header_val in r.headers.multi_items():
        if header_name.lower() == "set-cookie":
            parts = header_val.split(";")
            for part in parts:
                part = part.strip()
                if "=" in part:
                    name, _, value = part.partition("=")
                    if name.strip().lower() in ("sid", "kibana.sid", "kbn.sid"):
                        return value.strip()
    return None


def _get_cookie(client: httpx.AsyncClient, name: str) -> str | None:
    """Case-insensitive cookie lookup across the client jar."""
    for c in client.cookies.jar:
        if c.name.upper() == name.upper():
            return c.value
    return None


async def _establish_idmc_session(client: httpx.AsyncClient) -> dict | None:
    """
    Trigger IDMC SP-initiated SSO using the live Okta session in the client.

    After Kibana SAML the client has Okta session cookies.  IDMC's SP uses the
    same Okta tenant, so:
      1. GET IDMC SAML entry → Okta sees session → returns HTML page with a
         SAMLResponse form (same pattern as Kibana's ACS flow).
      2. We parse that form and POST the SAMLResponse to IDMC's ACS.
      3. IDMC ACS sets USER_SESSION + XSRF_TOKEN cookies.

    Returns {"userSession": "...", "xsrfToken": "..."} on success, None on failure.
    """
    IDMC_BASE = "https://dm-us.informaticacloud.com"
    entry_url = (
        f"{IDMC_BASE}/identity-service/api/v1/Saml/Login"
        "?RelayState=%2Fma%2F"
    )
    browser_hdrs = {
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
    }
    try:
        r = await client.get(entry_url, follow_redirects=True, headers=browser_hdrs)

        # Fast path: IDMC set cookies without requiring a form POST (rare but possible)
        user_session = _get_cookie(client, "USER_SESSION")
        xsrf_token   = _get_cookie(client, "XSRF_TOKEN")
        if user_session and xsrf_token:
            return {"userSession": user_session, "xsrfToken": xsrf_token}

        # Normal path: Okta returned an HTML page with a SAMLResponse form.
        # httpx follow_redirects only follows HTTP redirects, not form-based ones —
        # we must parse the form and POST it manually (same as _complete_saml for Kibana).
        if r.is_success and r.text:
            parser = _FormParser()
            parser.feed(r.text)
            if parser.form_action and "SAMLResponse" in parser.inputs:
                acs_r = await client.post(
                    parser.form_action,
                    data=parser.inputs,
                    headers={"Content-Type": "application/x-www-form-urlencoded"},
                    follow_redirects=True,
                )
                # Cookies may be on the ACS response or already in the jar
                user_session = _get_cookie(client, "USER_SESSION")
                xsrf_token   = _get_cookie(client, "XSRF_TOKEN")
                if not user_session:
                    user_session = acs_r.cookies.get("USER_SESSION")
                if not xsrf_token:
                    xsrf_token = acs_r.cookies.get("XSRF_TOKEN")
                if user_session and xsrf_token:
                    return {"userSession": user_session, "xsrfToken": xsrf_token}

        return None
    except Exception:
        return None


# ── Endpoints ─────────────────────────────────────────────────────────────

@router.post("/login")
async def kibana_login(req: LoginReq):
    client = httpx.AsyncClient(verify=False, timeout=30, follow_redirects=True)
    try:
        idp_url     = await _kibana_saml_init(client)
        state_token = await _get_state_token(client, idp_url)
        sh0         = await _idx_introspect(client, state_token)
        sh1         = await _idx_identify(client, req.username, sh0)
        sh2         = await _idx_answer_password(client, req.password, sh1)
        sh3         = await _idx_trigger_push(client, sh2)
    except HTTPException:
        await client.aclose()
        raise
    except Exception as exc:
        await client.aclose()
        raise HTTPException(502, f"Unexpected error during Okta login: {exc}") from exc

    _pending[sh3] = {"client": client, "state_handle": sh3}
    return {"status": "push_sent", "stateHandle": sh3}


@router.post("/verify-push")
async def verify_push(req: VerifyReq):
    ctx = _pending.get(req.state_handle)
    if not ctx:
        raise HTTPException(400, "No pending login for this token — restart the login flow")

    client: httpx.AsyncClient = ctx["client"]
    state_handle: str = ctx["state_handle"]

    try:
        redirect_url = await _poll_push(client, state_handle)
        sid = await _complete_saml(client, redirect_url)

        # Attempt automatic IDMC session establishment using the live Okta session.
        # If this succeeds the user skips the manual cookie-paste step entirely.
        idmc = await _establish_idmc_session(client)

        return {
            "status": "done",
            "sid": sid,
            "kibanaUrl": KIBANA_BASE,
            "kibanaSpace": KIBANA_SPACE,
            # Present when auto-SSO worked; absent/null when user must paste manually
            "userSession": idmc["userSession"] if idmc else None,
            "xsrfToken":   idmc["xsrfToken"]   if idmc else None,
            "idmcAutoAuth": idmc is not None,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(502, f"Unexpected error during SAML completion: {exc}") from exc
    finally:
        _pending.pop(req.state_handle, None)
        await client.aclose()
