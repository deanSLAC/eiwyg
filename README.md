# EIWYG - EPICS Is What You Get

A web-based WYSIWYG editor for building [EPICS](https://epics-controls.org/) control system dashboards.

## Features

- **Drag-and-drop dashboard builder** — place, resize, and configure widgets on a 12-column grid (Gridstack.js)
- **14 widget types** for instrumentation: text/numeric displays, inputs, sliders, toggles, LEDs, gauges, progress bars, motor controls, enum selectors, detector displays, labels, and time-series plots
- **Live PV updates** via WebSocket — widgets display real-time EPICS Process Variable values
- **Time-series plots** with configurable windows, max points, and automatic bin-averaging for long-duration trends
- **Simulated EPICS mode** (default) — 20+ realistic PVs for development without a real EPICS network
- **Real EPICS mode** via [caproto](https://caproto.github.io/caproto/) — connect to live IOCs by setting `EIWYG_SIM_MODE=false`
- **Save/load dashboards** with custom URL slugs, usernames, and descriptions
- **View mode** — publish a dashboard to a unique URL for read-only monitoring
- **AI assistant** (optional) — generate dashboard layouts from natural language using any OpenAI-compatible LLM API

## Quick Start

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt

uvicorn backend.main:app --host 0.0.0.0 --port 8080
# Open http://localhost:8080
```

This starts EIWYG in simulated EPICS mode with SQLite storage. No external services required.

To enable the AI assistant, copy `.env.example` to `.env` and configure `EIWYG_LLM_API_KEY` (see [LLM Configuration](#llm-configuration)).

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EIWYG_SIM_MODE` | `true` | `false` to connect to real EPICS IOCs via Channel Access |
| `EIWYG_BASE_PATH` | *(empty)* | Serve all routes under a subpath (e.g., `/eiwyg`) |
| `EIWYG_ENV` | `dev` | Set to `production` to require PostgreSQL (prevents SQLite fallback) |
| `EIWYG_LLM_ENABLED` | `true` | Set to `false` to disable AI features and hide the chat UI |
| `EIWYG_LLM_API_URL` | Stanford AI Gateway | Base URL of any OpenAI-compatible API |
| `EIWYG_LLM_API_KEY` | *(none)* | API key for the LLM service |
| `EIWYG_LLM_MODEL` | `claude-4-sonnet` | Model name to request from the API |
| `PGHOST` | *(none)* | PostgreSQL host (enables Postgres instead of SQLite) |
| `PGPORT` | `5432` | PostgreSQL port |
| `PGUSER` | *(none)* | PostgreSQL username |
| `PGPASSWORD` | *(none)* | PostgreSQL password |
| `PGDATABASE` | `eiwyg` | PostgreSQL database name |

## LLM Configuration

The AI assistant defaults to the [Stanford AI API Gateway](https://aiapi.stanford.edu/) but works with any service that implements the OpenAI `/v1/chat/completions` endpoint. To use a different provider, override `EIWYG_LLM_API_URL` and `EIWYG_LLM_MODEL`:

| Provider | `EIWYG_LLM_API_URL` | `EIWYG_LLM_MODEL` example |
|---|---|---|
| Stanford AI Gateway | `https://aiapi-prod.stanford.edu/v1` *(default)* | `claude-4-sonnet` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` |
| Ollama (local) | `http://localhost:11434/v1` | `llama3` |
| vLLM | `http://localhost:8000/v1` | *(your model)* |
| LiteLLM | `http://localhost:4000/v1` | *(your model)* |

Set `EIWYG_LLM_ENABLED=false` to fully disable AI features — the chat panel and LLM-powered search will be hidden from the UI. When enabled (default), the AI features are available if `EIWYG_LLM_API_KEY` is configured. Everything else works without it.

## Database

EIWYG uses **SQLite** by default (zero config, stored in `eiwyg.db`). Set the `PG*` environment variables to use **PostgreSQL** instead.

When `EIWYG_ENV=production`, PostgreSQL is required. The app will refuse to start without it, preventing silent data loss from ephemeral SQLite inside a container.

## Deployment

### Docker

```bash
docker build -t eiwyg .
docker run -p 8080:8080 eiwyg
```

Pass configuration as environment variables:

```bash
docker run -p 8080:8080 \
  -e EIWYG_LLM_API_KEY=your_key_here \
  eiwyg
```

### Subpath Deployment

To serve behind a reverse proxy at a subpath (e.g., `https://example.com/eiwyg`):

```bash
EIWYG_BASE_PATH=/eiwyg uvicorn backend.main:app --host 0.0.0.0 --port 8080
```

The app handles its own path prefixing — no `rewrite-target` or path stripping in the reverse proxy. Just forward `/eiwyg` traffic to the app as-is.

### Production (Kubernetes)

Set `EIWYG_ENV=production` and provide PostgreSQL credentials. A CI/CD workflow (`.github/workflows/build-push.yml`) builds and pushes Docker images to GHCR on each push to `main`.

## Project Structure

```
backend/
  main.py            FastAPI app, routes, WebSocket handler
  database.py        Database layer (SQLite or PostgreSQL)
  epics_manager.py   EPICS PV manager (sim + real modes)
  ws_manager.py      WebSocket connection manager
  pv_cache.py        Time-series PV value cache with compaction
  models.py          Pydantic request/response models
  llm.py             LLM integration (OpenAI-compatible API)
  test_ioc.py        Standalone caproto test IOC

frontend/
  index.html         Landing page
  editor.html        Dashboard editor
  view.html          Read-only dashboard viewer
  load.html          Dashboard search/load
  js/                Editor, viewer, loader, and widget logic
  css/               Styles
```

## Tech Stack

- **Backend:** Python, FastAPI, WebSocket, caproto
- **Database:** SQLite (aiosqlite) or PostgreSQL (asyncpg)
- **Frontend:** Vanilla JS, [Gridstack.js](https://gridstackjs.com/) 10, [Chart.js](https://www.chartjs.org/) 4 (CDN, no build step)
- **LLM:** Any OpenAI-compatible API (optional)
