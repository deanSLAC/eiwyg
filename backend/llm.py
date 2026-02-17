"""LLM chatbot for dashboard generation and search.

Uses any OpenAI-compatible API (OpenAI, Anthropic via proxy, Ollama, vLLM,
LiteLLM, Stanford AI Gateway, etc.). Configure via LLM_API_URL and LLM_API_KEY.
"""
import os
import json
import re

import httpx
from dotenv import load_dotenv

load_dotenv()

DEFAULT_API_URL = "https://aiapi-prod.stanford.edu/v1"
DEFAULT_MODEL = "claude-4-sonnet"

LLM_ENABLED = os.environ.get("EIWYG_LLM_ENABLED", "true").lower() != "false"

COMPONENT_TYPES = """
Available component types:
- "text-display": Read-only text showing PV value. Good for labels, status text.
- "numeric-display": Number with units and optional color ranges. Good for temperatures, pressures, counts.
- "numeric-input": Editable number field with +/- buttons. Good for setpoints, step sizes.
- "text-input": Editable text field to write string values to a PV.
- "slider": Horizontal slider for setting values within a range.
- "toggle": On/off switch for binary PVs (shutters, valves).
- "led": Color-coded circle indicator for status PVs.
- "gauge": Semicircular gauge for showing values as percentage of range.
- "progress-bar": Horizontal bar showing value as percentage of range.
- "motor-control": Specialized motor widget with readback, setpoint, jog buttons, STOP.
- "enum-selector": Dropdown for enum PVs.
- "label": Static text label (no PV needed).
- "detector-display": Shows detector counts, count rate, and status.
- "plot": Time-series line chart tracking a PV over time. Config: maxPoints (default 500), timeWindow in seconds (default 3600), lineColor, fillArea, yMin, yMax.
"""

SYSTEM_PROMPT = f"""You are an assistant that helps users build EPICS control system dashboards.
You understand EPICS PV naming conventions and synchrotron beamline instrumentation.

When a user describes a dashboard they want, you should generate a dashboard configuration.
Respond with a JSON object containing:
- "reply": A brief description of what you created
- "suggested_config": A dashboard config object

The dashboard config has this structure:
{{
    "widgets": [
        {{
            "id": "unique-string",
            "type": "<component-type>",
            "x": <column 0-11>,
            "y": <row>,
            "w": <width in columns, 1-12>,
            "h": <height in rows, 1-6>,
            "pv": "PV:NAME" or null for labels,
            "config": {{
                "label": "Display Label",
                "units": "unit string",
                "precision": <decimal places>,
                "fontSize": <pixels>,
                "fontColor": "#hex",
                "colorRanges": [{{"min": null|number, "max": null|number, "color": "#hex"}}],
                "step": <increment for numeric-input>,
                "min": <min value>,
                "max": <max value>,
                "minValue": <gauge/progress min>,
                "maxValue": <gauge/progress max>,
                "onColor": "#hex for LED on",
                "offColor": "#hex for LED off",
                "showStop": true/false for motor
            }}
        }}
    ],
    "columns": 12
}}

{COMPONENT_TYPES}

Grid is 12 columns wide. Widgets can be 1-12 columns wide and 1-6 rows tall.
Use realistic PV naming conventions (e.g., BL:SECTION:SIGNAL for beamline PVs).
For test/demo PVs, use the SIM: prefix (e.g., SIM:TEMP:1).

If the user asks a question rather than requesting a dashboard, just respond with helpful text (set suggested_config to null).

Always return valid JSON with "reply" and "suggested_config" keys."""


def _get_api_url() -> str:
    return os.environ.get("EIWYG_LLM_API_URL", DEFAULT_API_URL).rstrip("/")


def _get_api_key() -> str | None:
    return os.environ.get("EIWYG_LLM_API_KEY", "") or None


def _get_model() -> str:
    return os.environ.get("EIWYG_LLM_MODEL", DEFAULT_MODEL)


def _get_headers(api_key: str) -> dict:
    return {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }


def _parse_json_response(text: str) -> dict:
    """Try to parse JSON from LLM response text, handling markdown code blocks."""
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
        if match:
            return json.loads(match.group(1))
        return {"reply": text, "suggested_config": None}


async def chat_generate(message: str, current_config: dict | None = None) -> dict:
    """Generate or modify a dashboard via LLM."""
    if not LLM_ENABLED:
        return {"reply": "AI assistant is disabled.", "suggested_config": None}
    api_key = _get_api_key()
    if not api_key:
        return {
            "reply": "No EIWYG_LLM_API_KEY set. Configure EIWYG_LLM_API_URL and EIWYG_LLM_API_KEY to use the AI assistant.",
            "suggested_config": None,
        }

    user_msg = message
    if current_config:
        user_msg += f"\n\nCurrent dashboard config:\n{json.dumps(current_config, indent=2)}"

    payload = {
        "model": _get_model(),
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_msg},
        ],
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{_get_api_url()}/chat/completions",
                headers=_get_headers(api_key),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            return _parse_json_response(text)
    except Exception as e:
        return {"reply": f"Error communicating with AI: {str(e)}", "suggested_config": None}


async def search_dashboards(query: str, dashboards: list[dict]) -> list[str]:
    """Use LLM to find dashboards matching a description."""
    if not LLM_ENABLED:
        return []
    api_key = _get_api_key()
    if not api_key:
        return []

    summaries = []
    for d in dashboards:
        widget_types = [w.get("type", "unknown") for w in d["config"].get("widgets", [])]
        pvs = [w.get("pv", "") for w in d["config"].get("widgets", []) if w.get("pv")]
        summaries.append({
            "slug": d["slug"],
            "title": d["title"],
            "description": d["description"],
            "username": d["username"],
            "widget_types": widget_types,
            "pvs": pvs[:10],
        })

    prompt = f"""Given this user search query: "{query}"

And these available dashboards:
{json.dumps(summaries, indent=2)}

Return a JSON array of slug strings for dashboards that best match the query, ordered by relevance.
Only return the JSON array, nothing else."""

    payload = {
        "model": _get_model(),
        "messages": [{"role": "user", "content": prompt}],
    }

    try:
        async with httpx.AsyncClient(timeout=60) as client:
            resp = await client.post(
                f"{_get_api_url()}/chat/completions",
                headers=_get_headers(api_key),
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            text = data["choices"][0]["message"]["content"]
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                match = re.search(r'\[.*?\]', text, re.DOTALL)
                if match:
                    return json.loads(match.group(0))
                return []
    except Exception:
        return []
