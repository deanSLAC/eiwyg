# EIWYG - EPICS Is What You Get

A web-based WYSIWYG editor for building EPICS control system GUIs, targeting synchrotron beamline applications.

## Features

- **Drag-and-drop dashboard builder** using Gridstack.js -- place, resize, and configure widgets on a 12-column grid
- **14 widget types** for beamline instrumentation: text/numeric displays, inputs, sliders, toggles, LEDs, gauges, progress bars, motor controls, enum selectors, detector displays, labels, and time-series plots
- **Live PV updates** via WebSocket -- widgets display real-time EPICS Process Variable values
- **Time-series plot component** with configurable time windows, max point limits, and automatic bin-averaging compaction for long-duration trends
- **Simulated EPICS mode** (default) -- 20+ realistic beamline PVs for development without a real EPICS network
- **Real EPICS mode** via caproto -- connect to live IOCs by setting `EIWYG_SIM_MODE=false`
- **Save/load dashboards** with usernames, descriptions, and custom URL slugs
- **Frozen view mode** -- publish a dashboard to a unique URL for read-only monitoring
- **AI chatbot** (optional) -- generate dashboard layouts from natural language using Claude

## Tech Stack

- **Backend:** Python, FastAPI, WebSocket, SQLite (aiosqlite), caproto
- **Frontend:** Vanilla JS, Gridstack.js 10, Chart.js 4 (all via CDN, no build step)
- **LLM:** Anthropic API (optional, requires `ANTHROPIC_API_KEY`)

## Quick Start

```bash
# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the server (simulated EPICS mode, no real IOC needed)
uvicorn backend.main:app --host 0.0.0.0 --port 8080

# Open in browser
open http://localhost:8080
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `EIWYG_SIM_MODE` | `true` | Set to `false` to connect to real EPICS IOCs via Channel Access |
| `ANTHROPIC_API_KEY` | *(none)* | Anthropic API key for the AI chatbot feature |

## Project Structure

```
backend/
  main.py            # FastAPI app, routes, WebSocket handler
  epics_manager.py   # EPICS PV manager (sim + real modes)
  ws_manager.py      # WebSocket connection manager
  pv_cache.py        # Time-series PV value cache with compaction
  database.py        # SQLite database layer
  models.py          # Pydantic models
  llm.py             # Anthropic API integration
  test_ioc.py        # Standalone caproto test IOC

frontend/
  index.html         # Landing page
  editor.html        # WYSIWYG editor
  view.html          # Frozen dashboard view
  load.html          # Dashboard search/load
  js/
    editor.js        # Editor logic
    components.js    # Widget component registry (14 types)
    view.js          # Dashboard viewer
    load.js          # Load page logic
  css/
    editor.css       # Editor styles
    components.css   # Widget styles
    view.css         # View styles
    landing.css      # Landing page styles
    load.css         # Load page styles
```

## Running the Test IOC

To run a standalone caproto IOC that serves the same PVs as the simulated mode (useful for testing real-mode connections):

```bash
python -m backend.test_ioc
```

## License

MIT
