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
- **AI chatbot** (optional) -- generate dashboard layouts from natural language via Stanford AI API Gateway

## Tech Stack

- **Backend:** Python, FastAPI, WebSocket, SQLite (aiosqlite), caproto
- **Frontend:** Vanilla JS, Gridstack.js 10, Chart.js 4 (all via CDN, no build step)
- **LLM:** Stanford AI API Gateway (optional, requires `STANFORD_API_KEY`)

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `STANFORD_API_KEY` | *(none)* | Stanford Playground API key for the AI assistant |
| `STANFORD_MODEL` | `claude-4-sonnet` | LLM model to use via the Stanford gateway |
| `EIWYG_SIM_MODE` | `true` | Set to `false` to connect to real EPICS IOCs |
| `EIWYG_HOST` | `0.0.0.0` | Server bind address (used by run.sh) |
| `EIWYG_PORT` | `8080` | Server port (used by run.sh) |

## Local Development

```bash
# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Configure your API key
cp .env.example .env
# Edit .env and add your STANFORD_API_KEY

# Run the server (simulated EPICS mode, no real IOC needed)
uvicorn backend.main:app --host 0.0.0.0 --port 8080

# Open in browser
open http://localhost:8080
```

The `.env` file is gitignored and will not be committed.

## Deployment

### Docker

Build the image:

```bash
docker build -t eiwyg .
```

Run with the API key passed as an environment variable (never bake it into the image):

```bash
# Pass key directly
docker run -e STANFORD_API_KEY=your_key_here -p 8080:8080 eiwyg

# Or use an env file
docker run --env-file .env -p 8080:8080 eiwyg
```

Override additional settings as needed:

```bash
docker run \
  -e STANFORD_API_KEY=your_key_here \
  -e STANFORD_MODEL=claude-4-sonnet \
  -e EIWYG_SIM_MODE=false \
  -p 8080:8080 \
  eiwyg
```

The `.env` file is excluded from the Docker image via `.dockerignore`.

### Kubernetes

The `k8s/` directory contains deployment manifests.

**1. Create the secret** (do this directly in the cluster -- do not commit real keys):

```bash
kubectl create secret generic eiwyg-secrets \
  --from-literal=STANFORD_API_KEY=your_key_here
```

**2. Apply the configmap** (optional, to override the default model):

```bash
kubectl apply -f k8s/configmap.yaml
```

**3. Deploy:**

```bash
kubectl apply -f k8s/deployment.yaml
kubectl apply -f k8s/service.yaml
kubectl apply -f k8s/ingress.yaml
```

The deployment references `STANFORD_API_KEY` from the `eiwyg-secrets` Secret and `STANFORD_MODEL` from the `eiwyg-config` ConfigMap (optional).

**Note:** `k8s/secret.yaml` is a reference template and is gitignored. Always create secrets via `kubectl create secret` rather than committing them to the repo.

## Project Structure

```
backend/
  main.py            # FastAPI app, routes, WebSocket handler
  epics_manager.py   # EPICS PV manager (sim + real modes)
  ws_manager.py      # WebSocket connection manager
  pv_cache.py        # Time-series PV value cache with compaction
  database.py        # SQLite database layer
  models.py          # Pydantic models
  llm.py             # Stanford AI API Gateway integration
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

k8s/
  deployment.yaml    # Kubernetes Deployment
  service.yaml       # Kubernetes Service
  ingress.yaml       # Kubernetes Ingress
  configmap.yaml     # Non-secret configuration
  secret.yaml        # Secret template (gitignored)
```

## Running the Test IOC

To run a standalone caproto IOC that serves the same PVs as the simulated mode (useful for testing real-mode connections):

```bash
python -m backend.test_ioc
```

## License

MIT
