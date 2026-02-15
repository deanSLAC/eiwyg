"""EIWYG - EPICS Is What You Get: Main FastAPI application."""
import json
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, FileResponse, JSONResponse

from backend.database import init_db, save_dashboard, get_dashboard, list_dashboards, get_all_dashboards_with_config
from backend.models import DashboardCreate, DashboardResponse, ChatRequest, ChatResponse
from backend.epics_manager import EPICSManager
from backend.ws_manager import ConnectionManager
from backend.llm import chat_generate, search_dashboards

FRONTEND_DIR = os.path.join(os.path.dirname(__file__), "..", "frontend")

epics_mgr = EPICSManager()
ws_mgr = ConnectionManager(epics_mgr)


@asynccontextmanager
async def lifespan(app: FastAPI):
    await init_db()
    await epics_mgr.start()
    yield
    await epics_mgr.stop()


app = FastAPI(title="EIWYG - EPICS Is What You Get", lifespan=lifespan)

# Serve static frontend files
app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")


# ── Page Routes ──────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def landing_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "index.html"))


@app.get("/editor", response_class=HTMLResponse)
async def editor_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "editor.html"))


@app.get("/editor/{slug}", response_class=HTMLResponse)
async def editor_page_edit(slug: str):
    return FileResponse(os.path.join(FRONTEND_DIR, "editor.html"))


@app.get("/view/{slug}", response_class=HTMLResponse)
async def view_page(slug: str):
    return FileResponse(os.path.join(FRONTEND_DIR, "view.html"))


@app.get("/load", response_class=HTMLResponse)
async def load_page():
    return FileResponse(os.path.join(FRONTEND_DIR, "load.html"))


# ── REST API ─────────────────────────────────────────────────────────────

@app.post("/api/dashboards")
async def api_save_dashboard(dashboard: DashboardCreate):
    result = await save_dashboard(
        slug=dashboard.slug,
        title=dashboard.title,
        description=dashboard.description,
        username=dashboard.username,
        config=dashboard.config.model_dump()
    )
    return result


@app.get("/api/dashboards")
async def api_list_dashboards(username: str = None):
    return await list_dashboards(username=username)


@app.get("/api/dashboards/{slug}")
async def api_get_dashboard(slug: str):
    result = await get_dashboard(slug)
    if not result:
        raise HTTPException(status_code=404, detail="Dashboard not found")
    return result


# ── PV History ──────────────────────────────────────────────────────────

@app.get("/api/pv-history/{pv_name:path}")
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

@app.websocket("/ws")
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

@app.post("/api/chat")
async def api_chat(req: ChatRequest):
    current = req.current_config.model_dump() if req.current_config else None
    result = await chat_generate(req.message, current)
    return result


@app.post("/api/search-dashboards")
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
