from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from src.routers import auth, schedules, activity, missed_runs, kibana_auth, kibana_search, support, frs

app = FastAPI(title="INFA Schedule Monitor")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "https://*.vercel.app",
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth.router,           prefix="/api/auth",           tags=["auth"])
app.include_router(schedules.router,      prefix="/api/schedules",      tags=["schedules"])
app.include_router(activity.router,       prefix="/api/activity",       tags=["activity"])
app.include_router(missed_runs.router,    prefix="/api/missed-runs",    tags=["missed-runs"])
app.include_router(kibana_auth.router,    prefix="/api/kibana",         tags=["kibana"])
app.include_router(kibana_search.router,  prefix="/api/kibana",         tags=["kibana"])
app.include_router(support.router,        prefix="/api/support",         tags=["support"])
app.include_router(frs.router,            prefix="/api/frs",             tags=["frs"])


@app.get("/api/health")
def health():
    return {"status": "ok"}
