"""LLM chatbot for dashboard generation and search."""
import os
import json
from anthropic import AsyncAnthropic

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


async def chat_generate(message: str, current_config: dict | None = None) -> dict:
    """Generate or modify a dashboard via LLM."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return {
            "reply": "No ANTHROPIC_API_KEY environment variable set. Please set it to use the AI assistant.",
            "suggested_config": None
        }

    client = AsyncAnthropic(api_key=api_key)

    user_msg = message
    if current_config:
        user_msg += f"\n\nCurrent dashboard config:\n{json.dumps(current_config, indent=2)}"

    try:
        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=4096,
            system=SYSTEM_PROMPT,
            messages=[{"role": "user", "content": user_msg}]
        )
        text = response.content[0].text
        # Try to parse JSON from the response
        try:
            result = json.loads(text)
            return result
        except json.JSONDecodeError:
            # Try to extract JSON from markdown code blocks
            import re
            match = re.search(r'```(?:json)?\s*(\{.*?\})\s*```', text, re.DOTALL)
            if match:
                result = json.loads(match.group(1))
                return result
            return {"reply": text, "suggested_config": None}
    except Exception as e:
        return {"reply": f"Error communicating with AI: {str(e)}", "suggested_config": None}


async def search_dashboards(query: str, dashboards: list[dict]) -> list[str]:
    """Use LLM to find dashboards matching a description."""
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        return []

    client = AsyncAnthropic(api_key=api_key)

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
            "pvs": pvs[:10]
        })

    prompt = f"""Given this user search query: "{query}"

And these available dashboards:
{json.dumps(summaries, indent=2)}

Return a JSON array of slug strings for dashboards that best match the query, ordered by relevance.
Only return the JSON array, nothing else."""

    try:
        response = await client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1024,
            messages=[{"role": "user", "content": prompt}]
        )
        text = response.content[0].text
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            import re
            match = re.search(r'\[.*?\]', text, re.DOTALL)
            if match:
                return json.loads(match.group(0))
            return []
    except Exception:
        return []
