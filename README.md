# INFA Schedule Monitor

A web application for monitoring Informatica Intelligent Cloud Services (IICS) schedules, detecting missed job runs, and diagnosing scheduler failures.

Built after a real-world incident where an internal Informatica DNS failure (`UnknownHostException: cdi.*.internal.infacloudops.net`) silently caused scheduled tasks to stop executing — with no alert surfaced in the IICS UI.

---

## What it does

- **Schedule overview** — lists all enabled schedules in your org with their recurrence, linked assets, and next expected run
- **Missed run detection** — compares expected fire times (computed from schedule config) against the actual activity log; classifies each slot as OK, Missed, POD/Infra failure, or Other failure
- **Asset map** — maps every schedulable asset (Mapping Task, Taskflow, Workflow) to the schedule(s) assigned to it
- **Live monitor** — shows currently running jobs
- **Investigate** — deep-dive into a specific job's activity history
- **Kibana integration** — for orgs running the Informatica ELK stack, check raw logs for a missed slot directly from the UI

---

## Architecture

```
frontend/          React 19 + Vite (SPA)
src/               FastAPI backend (Python)
  routers/
    auth.py          IICS login (Standard / SAML / OAuth / Salesforce)
    schedules.py     Schedule list + details
    activity.py      Activity log queries
    missed_runs.py   Missed-run detection engine
    frs.py           Asset inventory (v3 public API + support FRS)
    kibana_*.py      Kibana proxy (auth + search)
    support.py       Support-user endpoints (internal, not documented here)
```

The frontend is a Vite SPA served statically. In production the React app calls the FastAPI backend — both need to be deployed separately (see [Deployment](#deployment) below).

---

## Public Informatica APIs used

All APIs below are part of the **Informatica Intelligent Cloud Services (IICS) public API** and require a valid IICS session obtained by logging in through the standard login endpoint.

### Authentication

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `https://{pod}/ma/api/v2/user/login` | Standard username/password login. Returns `icSessionId` and `serverUrl`. |

### Schedules (v3 Public API)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `{serverUrl}/public/core/v3/schedule` | List all schedules in the org. Returns name, status, recurrence config, startTime. |

### Activity Log (v2 API)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `{serverUrl}/api/v2/activity/activityLog` | Paginated list of completed job runs. Key fields: `scheduleName`, `startTimeUtc`, `state`, `errorMsg`. Max 200 per page, newest-first. |
| `GET` | `{serverUrl}/api/v2/activity/activityMonitor` | Currently running jobs. |

### Assets (v3 Public API)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `{serverUrl}/public/core/v3/objects` | Flat list of all org assets filterable by type (`MTT`, `TASKFLOW`, `WORKFLOW`). Paginated with `limit`/`skip`. |

### Mapping Tasks (v2 API)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `{serverUrl}/api/v2/mttask/{id}` | Details for a specific Mapping Task, including its assigned `scheduleId`. |

### Notes on API behaviour

- All list endpoints cap responses at **200 entries per page** — this app paginates every request.
- The v3 API uses the header `INFA-SESSION-ID`; the v2 API uses `icSessionId`.
- Schedule recurrence fields in v3: `interval` = type string (`"Minutely"`, `"Daily"`, `"Weekly"`, …), `frequency` = integer count, `startTime` = full ISO-8601 datetime.
- Activity log timestamps use the format `2026-07-08T11:28:01.000+0000` (note: `+0000` not `+00:00`).

---

## Local development

### Prerequisites

- Python 3.11+
- Node.js 20+

### Backend

```bash
# from project root
python -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install fastapi uvicorn httpx python-dotenv

uvicorn src.main:app --reload --port 8000
```

### Frontend

```bash
cd frontend
npm install
npm run dev        # starts on http://localhost:5173
```

Vite proxies all `/api` requests to `http://localhost:8000` during development.

---

## Deployment

This app has two parts — a **React SPA** (static files) and a **FastAPI backend** (Python server). They need to be deployed separately.

### Option A — Vercel (frontend) + Railway / Render (backend) [Recommended]

#### 1. Deploy the backend (Railway)

1. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
2. Select this repository
3. Set the **Root Directory** to `/` (project root)
4. Set the **Start Command**:
   ```
   uvicorn src.main:app --host 0.0.0.0 --port $PORT
   ```
5. Add environment variable:
   ```
   INFA_LOGIN_URL=https://dm-us.informaticacloud.com/ma/api/v2/user/login
   ```
6. Railway will give you a URL like `https://infa-schedule-monitor.up.railway.app` — copy it.

#### 2. Update CORS in the backend

Before deploying, edit `src/main.py` and add your Vercel frontend URL to `allow_origins`:

```python
allow_origins=[
    "http://localhost:5173",
    "https://your-app.vercel.app",   # add this
],
```

Commit and push this change.

#### 3. Deploy the frontend (Vercel)

1. Go to [vercel.com](https://vercel.com) → New Project → Import `infa-schedule-monitor` from GitHub
2. Set **Framework Preset** to `Vite`
3. Set **Root Directory** to `frontend`
4. Add an environment variable:
   ```
   VITE_API_BASE_URL=https://your-railway-backend-url.up.railway.app
   ```
5. Click Deploy

#### 4. Point the frontend at the backend

In `frontend/vite.config.js`, the `/api` proxy only works in local dev. For production, update your fetch calls to use `VITE_API_BASE_URL` — or configure Vercel [rewrites](https://vercel.com/docs/edge-network/rewrites) in a `vercel.json`:

```json
{
  "rewrites": [
    {
      "source": "/api/:path*",
      "destination": "https://your-railway-backend-url.up.railway.app/api/:path*"
    }
  ]
}
```

Place this `vercel.json` inside the `frontend/` folder.

---

### Option B — Single server (VPS / EC2)

Run both on the same machine:

```bash
# Build frontend
cd frontend && npm run build    # outputs to frontend/dist/

# Serve static files via FastAPI
# add to src/main.py:
from fastapi.staticfiles import StaticFiles
app.mount("/", StaticFiles(directory="frontend/dist", html=True), name="static")

# Then run:
uvicorn src.main:app --host 0.0.0.0 --port 8000
```

---

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `INFA_LOGIN_URL` | Backend | IICS login endpoint (default: `https://dm-us.informaticacloud.com/ma/api/v2/user/login`) |

---

## Limitations

- The activity log API retains data for approximately **33 days** — analysis windows longer than this will not find older runs.
- The missed-run detector uses **server-UTC timestamps**; schedules configured in non-UTC timezones may show small drift on DST boundaries.
- Taskflow → schedule resolution requires the user to also provide their `USER_SESSION` + `XSRF_TOKEN` cookies (obtained from the browser after login) because the scheduler-service API is not part of the standard public API.

---

## License

MIT
