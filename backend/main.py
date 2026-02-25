"""EIWYG - EPICS Is What You Get: Main FastAPI application."""
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException, APIRouter
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse

from backend.database import (
    init_db, close_db, save_dashboard, get_dashboard, list_dashboards,
    get_all_dashboards_with_config, get_dashboard_pw, delete_dashboard,
)
from backend.models import DashboardCreate, DashboardResponse, ChatRequest, ChatResponse
from backend.epics_manager import EPICSManager
from backend.ws_manager import ConnectionManager
from backend.llm import chat_generate, search_dashboards, LLM_ENABLED

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")
BASE_PATH = os.environ.get("EIWYG_BASE_PATH", "").rstrip("/")

epics_mgr = EPICSManager()
ws_mgr = ConnectionManager(epics_mgr)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await epics_mgr.start()
    yield
    await epics_mgr.stop()
    await close_db()


app = FastAPI(title="EIWYG - EPICS Is What You Get", lifespan=lifespan)
router = APIRouter()

# Serve static frontend files
app.mount(f"{BASE_PATH}/static", StaticFiles(directory=FRONTEND_DIR), name="static")


def _serve_html(filename: str) -> HTMLResponse:
    """Read an HTML file and inject the base path configuration."""
    path = os.path.join(FRONTEND_DIR, filename)
    with open(path, "r") as f:
        content = f.read()
    # Inject EIWYG_BASE into <head> so frontend JS can use it
    llm_enabled_js = "true" if LLM_ENABLED else "false"
    base_script = f'<script>window.EIWYG_BASE="{BASE_PATH}";window.EIWYG_LLM_ENABLED={llm_enabled_js};</script>'
    content = content.replace("<head>", f"<head>\n    {base_script}", 1)
    if BASE_PATH:
        # Prefix absolute static references
        content = content.replace('href="/static/', f'href="{BASE_PATH}/static/')
        content = content.replace('src="/static/', f'src="{BASE_PATH}/static/')
        # Prefix absolute navigation links
        content = content.replace('href="/"', f'href="{BASE_PATH}/"')
        content = content.replace('href="/editor"', f'href="{BASE_PATH}/editor"')
        content = content.replace('href="/load"', f'href="{BASE_PATH}/load"')
        content = content.replace('href="/view/', f'href="{BASE_PATH}/view/')
    return HTMLResponse(content)


# ── Health Check ─────────────────────────────────────────────────────────

@router.get("/health")
async def health_check():
    return {"status": "ok"}


# ── Page Routes ──────────────────────────────────────────────────────────

@router.get("/", response_class=HTMLResponse)
async def landing_page():
    return _serve_html("index.html")


@router.get("/editor", response_class=HTMLResponse)
async def editor_page():
    return _serve_html("editor.html")


@router.get("/editor/{slug}", response_class=HTMLResponse)
async def editor_page_edit(slug: str):
    return _serve_html("editor.html")


@router.get("/view/{slug}", response_class=HTMLResponse)
async def view_page(slug: str):
    return _serve_html("view.html")


@router.get("/load", response_class=HTMLResponse)
async def load_page():
    return _serve_html("load.html")


# ── REST API ─────────────────────────────────────────────────────────────

@router.post("/api/dashboards")
async def api_save_dashboard(dashboard: DashboardCreate):
    result = await save_dashboard(
        slug=dashboard.slug,
        title=dashboard.title,
        description=dashboard.description,
        username=dashboard.username,
        config=dashboard.config.model_dump(),
        pw=dashboard.pw,
    )
    return result


@router.get("/api/dashboards")
async def api_list_dashboards(username: str = None):
    return await list_dashboards(username=username)


@router.post("/api/dashboards/verify-pw")
async def api_verify_pw(request: Request):
    body = await request.json()
    slug = body.get("slug", "")
    pw = body.get("pw", "")
    stored_pw = await get_dashboard_pw(slug)
    if stored_pw is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return {"valid": stored_pw == pw}


@router.get("/api/dashboard-exists/{slug}")
async def api_dashboard_exists(slug: str):
    d = await get_dashboard(slug)
    return {"exists": d is not None}


@router.delete("/api/dashboards/{slug}")
async def api_delete_dashboard(slug: str, request: Request):
    body = await request.json()
    pw = body.get("pw", "")
    stored_pw = await get_dashboard_pw(slug)
    if stored_pw is None:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    if stored_pw != pw:
        raise HTTPException(status_code=403, detail="Incorrect pw")
    await delete_dashboard(slug)
    return {"status": "deleted"}


@router.get("/api/dashboards/{slug}")
async def api_get_dashboard(slug: str):
    result = await get_dashboard(slug)
    if not result:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return result


# ── PV History ──────────────────────────────────────────────────────────

@router.get("/api/pv-history/{pv_name:path}")
async def api_pv_history(pv_name: str, window: float = 3600, max_points: int = 1000):
    """Get cached time-series history for a PV.

    Args:
        pv_name: EPICS PV name (e.g. SIM:TEMP:1)
        window: Time window in seconds (default 3600 = 1 hour)
        max_points: Max data points to return (default 1000)
    """
    max_points = min(max(1, max_points), 10_000)
    window = max(1.0, window)
    data = epics_mgr.pv_cache.get_history(pv_name, window, max_points)
    return {"pv": pv_name, "window": window, "max_points": max_points, "data": data}


# ── WebSocket ────────────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await ws_mgr.connect(websocket)
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            msg_type = msg.get("type")

            if msg_type == "subscribe":
                pvs = msg.get("pvs", [])
                for pv in pvs:
                    await ws_mgr.subscribe(websocket, pv)

            elif msg_type == "unsubscribe":
                pvs = msg.get("pvs", [])
                for pv in pvs:
                    await ws_mgr.unsubscribe(websocket, pv)

            elif msg_type == "put":
                pv = msg.get("pv")
                value = msg.get("value")
                if pv is not None and value is not None:
                    await epics_mgr.put_pv(pv, value)

    except WebSocketDisconnect:
        await ws_mgr.disconnect(websocket)
    except Exception:
        await ws_mgr.disconnect(websocket)


# ── LLM Chat ────────────────────────────────────────────────────────────

@router.post("/api/chat")
async def api_chat(req: ChatRequest):
    current = req.current_config.model_dump() if req.current_config else None
    result = await chat_generate(req.message, current)
    return result


@router.post("/api/search-dashboards")
async def api_search_dashboards(request: Request):
    body = await request.json()
    query = body.get("query", "")
    all_dashboards = await get_all_dashboards_with_config()
    matched_slugs = await search_dashboards(query, all_dashboards)
    # Return full dashboard info for matched slugs
    result = []
    for slug in matched_slugs:
        for d in all_dashboards:
            if d["slug"] == slug:
                result.append({
                    "slug": d["slug"],
                    "title": d["title"],
                    "description": d["description"],
                    "username": d["username"],
                    "created_at": d["created_at"],
                    "updated_at": d["updated_at"]
                })
                break
    return result


app.include_router(router, prefix=BASE_PATH)
