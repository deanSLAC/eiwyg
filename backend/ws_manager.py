"""WebSocket connection manager for EIWYG.

Bridges EPICS PV updates from EPICSManager to connected WebSocket clients.
Each client can subscribe to an arbitrary set of PVs.  Updates are sent as
JSON messages with the format:

    {"type": "pv_update", "pv": "SIM:TEMP:1", "value": 25.3,
     "timestamp": 1234567890.123, "severity": 0}
"""
import asyncio
import json
import logging
import time
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

from backend.epics_manager import EPICSManager, PVCallback

logger = logging.getLogger(__name__)


class ConnectionManager:
    """Manages WebSocket connections and their PV subscriptions."""

    def __init__(self, epics_manager: EPICSManager):
        self._epics = epics_manager

        # Set of all active websockets
        self._connections: set[WebSocket] = set()

        # Which PVs each websocket is subscribed to:
        #   websocket -> set[pv_name]
        self._ws_pvs: dict[WebSocket, set[str]] = defaultdict(set)

        # The callback registered with EPICSManager for each (ws, pv) pair.
        # Keyed by (id(websocket), pv_name) so we can remove it later.
        self._callbacks: dict[tuple[int, str], PVCallback] = {}

        # Lock to protect subscription mutations (thread safety for caproto
        # callbacks coming from a different thread)
        self._lock = asyncio.Lock()

        # Reference to the running event loop (set on first connect)
        self._loop: asyncio.AbstractEventLoop | None = None

    # ── Public API ───────────────────────────────────────────────────────

    async def connect(self, websocket: WebSocket):
        """Accept and track a new WebSocket connection."""
        await websocket.accept()
        self._loop = asyncio.get_running_loop()
        async with self._lock:
            self._connections.add(websocket)
        logger.info("WebSocket connected: %s", id(websocket))

    async def disconnect(self, websocket: WebSocket):
        """Remove a WebSocket and clean up all its subscriptions."""
        async with self._lock:
            # Unsubscribe from every PV this websocket was watching
            pv_names = list(self._ws_pvs.get(websocket, set()))
            for pv_name in pv_names:
                self._remove_subscription(websocket, pv_name)

            self._ws_pvs.pop(websocket, None)
            self._connections.discard(websocket)

        logger.info("WebSocket disconnected: %s", id(websocket))

    async def subscribe(self, websocket: WebSocket, pv_name: str):
        """Subscribe a WebSocket client to a PV."""
        async with self._lock:
            if pv_name in self._ws_pvs[websocket]:
                # Already subscribed
                return

            self._ws_pvs[websocket].add(pv_name)

            # Build a callback that sends updates to this specific websocket
            cb = self._make_callback(websocket, pv_name)
            self._callbacks[(id(websocket), pv_name)] = cb

            self._epics.subscribe(pv_name, cb)

        logger.debug("WS %s subscribed to %s", id(websocket), pv_name)

    async def unsubscribe(self, websocket: WebSocket, pv_name: str):
        """Unsubscribe a WebSocket client from a PV."""
        async with self._lock:
            self._remove_subscription(websocket, pv_name)
            self._ws_pvs[websocket].discard(pv_name)

        logger.debug("WS %s unsubscribed from %s", id(websocket), pv_name)

    # ── Internal helpers ─────────────────────────────────────────────────

    def _remove_subscription(self, websocket: WebSocket, pv_name: str):
        """Remove the EPICS subscription callback for a (ws, pv) pair.

        Must be called while holding self._lock.
        """
        key = (id(websocket), pv_name)
        cb = self._callbacks.pop(key, None)
        if cb is not None:
            self._epics.unsubscribe(pv_name, cb)

    def _make_callback(self, websocket: WebSocket,
                       pv_name: str) -> PVCallback:
        """Create a PV callback function bound to a specific websocket.

        The callback may be invoked from a caproto thread (in real mode) or
        from an asyncio task (in sim mode), so it schedules the actual send
        on the event loop to be thread-safe.
        """

        def _on_update(name: str, value: Any, timestamp: float,
                       severity: int):
            msg = json.dumps({
                "type": "pv_update",
                "pv": name,
                "value": value,
                "timestamp": round(timestamp, 3),
                "severity": severity,
            })

            if self._loop is not None and self._loop.is_running():
                self._loop.call_soon_threadsafe(
                    asyncio.ensure_future,
                    self._safe_send(websocket, msg)
                )
            else:
                # Fallback: try direct send if we're already in the loop
                try:
                    asyncio.ensure_future(self._safe_send(websocket, msg))
                except RuntimeError:
                    pass

        return _on_update

    async def _safe_send(self, websocket: WebSocket, text: str):
        """Send text to a websocket, handling disconnection gracefully."""
        if websocket not in self._connections:
            return
        try:
            await websocket.send_text(text)
        except Exception:
            # Client disconnected -- clean up will happen via the
            # WebSocketDisconnect handler in main.py
            logger.debug("Failed to send to WS %s, likely disconnected",
                         id(websocket))
