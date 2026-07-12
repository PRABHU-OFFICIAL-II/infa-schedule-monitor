import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from src.routers import auth, schedules, activity, missed_runs, kibana_auth, kibana_search, support, frs

app = FastAPI(title="INFA Schedule Monitor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,           prefix="/api/auth",           tags=["auth"])
app.include_router(schedules.router,      prefix="/api/schedules",      tags=["schedules"])
app.include_router(activity.router,       prefix="/api/activity",       tags=["activity"])
app.include_router(missed_runs.router,    prefix="/api/missed-runs",    tags=["missed-runs"])
app.include_router(kibana_auth.router,    prefix="/api/kibana",         tags=["kibana"])
app.include_router(kibana_search.router,  prefix="/api/kibana",         tags=["kibana"])
app.include_router(support.router,        prefix="/api/support",        tags=["support"])
app.include_router(frs.router,            prefix="/api/frs",            tags=["frs"])


@app.get("/api/health")
def health():
    return {"status": "ok"}


# Serve the React build in production — frontend/dist must exist
_dist = os.path.join(os.path.dirname(os.path.dirname(__file__)), "frontend", "dist")
if os.path.isdir(_dist):
    app.mount("/assets", StaticFiles(directory=os.path.join(_dist, "assets")), name="assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    def serve_spa(full_path: str):
        return FileResponse(os.path.join(_dist, "index.html"))
