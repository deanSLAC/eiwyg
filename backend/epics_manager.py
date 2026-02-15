"""EPICS PV connection manager for EIWYG.

Supports two modes:
- SIMULATED (default): Generates realistic beamline PV values internally.
- REAL: Uses caproto's threading client to connect to a live EPICS network.

Set env var EIWYG_SIM_MODE="false" to use real mode.
"""
import asyncio
import logging
import os
import random
import time
from collections import defaultdict
from typing import Any, Callable, Optional

from backend.pv_cache import PVCache

logger = logging.getLogger(__name__)

# Type alias for PV update callbacks
# callback(pv_name: str, value: Any, timestamp: float, severity: int)
PVCallback = Callable[[str, Any, float, int], None]


class _SimulatedPV:
    """Holds state for a single simulated PV."""

    def __init__(self, name: str, initial: Any, dtype: str = "float",
                 noise: float = 0.0, lo: Optional[float] = None,
                 hi: Optional[float] = None, drift: float = 0.0):
        self.name = name
        self.value = initial
        self.dtype = dtype          # "float" or "int"
        self.noise = noise          # std-dev of Gaussian noise per tick
        self.drift = drift          # slow drift per tick
        self.lo = lo                # clamp low
        self.hi = hi                # clamp high
        self.timestamp = time.time()
        self.severity = 0

    def tick(self):
        """Advance the simulated value by one time step."""
        if self.dtype == "float":
            delta = random.gauss(self.drift, self.noise)
            self.value += delta
            if self.lo is not None:
                self.value = max(self.lo, self.value)
            if self.hi is not None:
                self.value = min(self.hi, self.value)
            self.value = round(self.value, 6)
        elif self.dtype == "int":
            # For integer PVs with noise, occasionally flip/jump
            if self.noise > 0:
                self.value = random.randint(int(self.lo or 0), int(self.hi or 1))
        self.timestamp = time.time()


def _build_sim_pvs() -> dict[str, _SimulatedPV]:
    """Create the default set of simulated PVs."""
    pvs: dict[str, _SimulatedPV] = {}

    # Temperature sensors (25-35 C, slow drift)
    for i in range(1, 5):
        pvs[f"SIM:TEMP:{i}"] = _SimulatedPV(
            f"SIM:TEMP:{i}", initial=25.0 + random.uniform(0, 10),
            noise=0.05, drift=0.0, lo=20.0, hi=40.0)

    # Pressure gauges (1e-7 to 1e-6 Torr)
    for i in range(1, 3):
        base = random.uniform(1e-7, 5e-7)
        pvs[f"SIM:PRESSURE:{i}"] = _SimulatedPV(
            f"SIM:PRESSURE:{i}", initial=base,
            noise=1e-8, lo=1e-8, hi=5e-6)

    # Flow
    pvs["SIM:FLOW:1"] = _SimulatedPV(
        "SIM:FLOW:1", initial=5.0, noise=0.1, lo=0.0, hi=20.0)

    # Beam intensity
    pvs["SIM:BEAM:INTENSITY"] = _SimulatedPV(
        "SIM:BEAM:INTENSITY", initial=1e5, noise=5e3, lo=0.0, hi=1e7)

    # Beam energy (very stable)
    pvs["SIM:BEAM:ENERGY"] = _SimulatedPV(
        "SIM:BEAM:ENERGY", initial=12.0, noise=0.001, lo=5.0, hi=30.0)

    # Detector counts (random jumps)
    pvs["SIM:DET:COUNTS"] = _SimulatedPV(
        "SIM:DET:COUNTS", initial=100000, dtype="int",
        noise=1.0, lo=50000, hi=200000)

    # Detector rate
    pvs["SIM:DET:RATE"] = _SimulatedPV(
        "SIM:DET:RATE", initial=3000.0, noise=200.0, lo=1000.0, hi=5000.0)

    # Motor 1 (linear, mm)
    pvs["SIM:MTR:1:RBV"] = _SimulatedPV(
        "SIM:MTR:1:RBV", initial=50.0, noise=0.0, lo=0.0, hi=100.0)
    pvs["SIM:MTR:1:VAL"] = _SimulatedPV(
        "SIM:MTR:1:VAL", initial=50.0, noise=0.0, lo=0.0, hi=100.0)
    pvs["SIM:MTR:1:MOVN"] = _SimulatedPV(
        "SIM:MTR:1:MOVN", initial=0, dtype="int", lo=0, hi=1)

    # Motor 2 (rotary, degrees)
    pvs["SIM:MTR:2:RBV"] = _SimulatedPV(
        "SIM:MTR:2:RBV", initial=180.0, noise=0.0, lo=0.0, hi=360.0)
    pvs["SIM:MTR:2:VAL"] = _SimulatedPV(
        "SIM:MTR:2:VAL", initial=180.0, noise=0.0, lo=0.0, hi=360.0)
    pvs["SIM:MTR:2:MOVN"] = _SimulatedPV(
        "SIM:MTR:2:MOVN", initial=0, dtype="int", lo=0, hi=1)

    # Shutter status
    pvs["SIM:SHUTTER:STATUS"] = _SimulatedPV(
        "SIM:SHUTTER:STATUS", initial=0, dtype="int", lo=0, hi=1)

    # Valve
    pvs["SIM:VALVE:1"] = _SimulatedPV(
        "SIM:VALVE:1", initial=0, dtype="int", lo=0, hi=2)

    return pvs


class EPICSManager:
    """Manages EPICS PV connections and subscriptions.

    In simulated mode, runs an internal asyncio loop that produces
    realistic beamline data.  In real mode, uses caproto's threading
    client and bridges updates into asyncio.
    """

    def __init__(self):
        self._sim_mode: bool = True
        self._running: bool = False

        # Subscriptions: pv_name -> list[callback]
        self._subscriptions: dict[str, list[PVCallback]] = defaultdict(list)

        # Current cached values: pv_name -> (value, timestamp, severity)
        self._cache: dict[str, tuple[Any, float, int]] = {}

        # Time-series history cache for plot widgets
        self.pv_cache = PVCache(max_raw_points_per_pv=20_000)

        # Simulation state
        self._sim_pvs: dict[str, _SimulatedPV] = {}
        self._sim_task: Optional[asyncio.Task] = None
        self._motor_tasks: dict[str, asyncio.Task] = {}

        # Real-mode caproto state
        self._ctx = None  # caproto threading Context
        self._caproto_pvs: dict[str, Any] = {}  # name -> PV object
        self._caproto_subs: dict[str, Any] = {}  # name -> (subscription, callback)
        self._loop: Optional[asyncio.AbstractEventLoop] = None

    # ── Lifecycle ────────────────────────────────────────────────────────

    async def start(self):
        """Initialize the manager. Reads EIWYG_SIM_MODE env var."""
        sim_env = os.environ.get("EIWYG_SIM_MODE", "true").lower()
        self._sim_mode = sim_env in ("true", "1", "yes", "")
        self._loop = asyncio.get_running_loop()
        self._running = True

        if self._sim_mode:
            logger.info("EPICSManager starting in SIMULATED mode")
            self._sim_pvs = _build_sim_pvs()
            # Seed cache
            for name, pv in self._sim_pvs.items():
                self._cache[name] = (pv.value, pv.timestamp, pv.severity)
            self._sim_task = asyncio.create_task(self._sim_loop())
        else:
            logger.info("EPICSManager starting in REAL mode (caproto)")
            try:
                from caproto.threading.client import Context
                self._ctx = Context()
                logger.info("caproto Context created successfully")
            except Exception as exc:
                logger.error("Failed to create caproto Context: %s. "
                             "Falling back to simulated mode.", exc)
                self._sim_mode = True
                self._sim_pvs = _build_sim_pvs()
                for name, pv in self._sim_pvs.items():
                    self._cache[name] = (pv.value, pv.timestamp, pv.severity)
                self._sim_task = asyncio.create_task(self._sim_loop())

    async def stop(self):
        """Clean up all connections and tasks."""
        self._running = False

        # Cancel motor tasks
        for task in self._motor_tasks.values():
            task.cancel()
        self._motor_tasks.clear()

        if self._sim_task is not None:
            self._sim_task.cancel()
            try:
                await self._sim_task
            except asyncio.CancelledError:
                pass
            self._sim_task = None

        # Clean up caproto
        if self._ctx is not None:
            try:
                self._ctx.disconnect()
            except Exception:
                pass
            self._ctx = None

        self._subscriptions.clear()
        self._cache.clear()
        logger.info("EPICSManager stopped")

    # ── Public API ───────────────────────────────────────────────────────

    def subscribe(self, pv_name: str, callback: PVCallback):
        """Subscribe to updates for a PV.

        In sim mode, if the PV name starts with SIM: and is a known
        simulated PV, it will auto-register.  Otherwise it is tracked
        but will never fire until a real IOC provides data.
        """
        self._subscriptions[pv_name].append(callback)

        # Send the current cached value immediately if available
        if pv_name in self._cache:
            value, ts, sev = self._cache[pv_name]
            try:
                callback(pv_name, value, ts, sev)
            except Exception as exc:
                logger.error("Callback error on initial subscribe for %s: %s",
                             pv_name, exc)

        # In real mode, set up a caproto monitor if not already done
        if not self._sim_mode and pv_name not in self._caproto_pvs:
            self._real_subscribe(pv_name)

    def unsubscribe(self, pv_name: str, callback: PVCallback):
        """Remove a callback from a PV subscription."""
        if pv_name in self._subscriptions:
            try:
                self._subscriptions[pv_name].remove(callback)
            except ValueError:
                pass
            if not self._subscriptions[pv_name]:
                del self._subscriptions[pv_name]
                # In real mode, could cancel the monitor here
                if not self._sim_mode and pv_name in self._caproto_subs:
                    # caproto subscriptions are cleaned up via the PV object
                    pass

    async def put_pv(self, pv_name: str, value: Any):
        """Write a value to a PV."""
        if self._sim_mode:
            await self._sim_put(pv_name, value)
        else:
            await self._real_put(pv_name, value)

    def get_current_value(self, pv_name: str) -> Optional[Any]:
        """Return the most recently cached value for a PV, or None."""
        entry = self._cache.get(pv_name)
        if entry is not None:
            return entry[0]
        return None

    # ── Simulation internals ─────────────────────────────────────────────

    async def _sim_loop(self):
        """Main simulation loop.  Ticks PVs and fires callbacks."""
        try:
            while self._running:
                for name, pv in self._sim_pvs.items():
                    # Skip motor RBV/MOVN -- those are driven by motor tasks
                    if ":MTR:" in name and (name.endswith(":RBV") or
                                            name.endswith(":MOVN")):
                        continue
                    # Skip motor VAL -- set by user puts
                    if ":MTR:" in name and name.endswith(":VAL"):
                        continue
                    # Skip shutter and valve -- set by user puts
                    if name in ("SIM:SHUTTER:STATUS", "SIM:VALVE:1"):
                        continue

                    pv.tick()
                    self._cache[name] = (pv.value, pv.timestamp, pv.severity)
                    self._fire_callbacks(name, pv.value, pv.timestamp,
                                         pv.severity)

                # Vary the update interval slightly for realism
                await asyncio.sleep(random.uniform(0.5, 1.5))
        except asyncio.CancelledError:
            pass

    async def _sim_put(self, pv_name: str, value: Any):
        """Handle a put in simulated mode."""
        if pv_name not in self._sim_pvs:
            logger.warning("Put to unknown sim PV: %s", pv_name)
            return

        sim_pv = self._sim_pvs[pv_name]

        # Coerce type
        if sim_pv.dtype == "int":
            value = int(value)
        else:
            value = float(value)

        sim_pv.value = value
        sim_pv.timestamp = time.time()
        self._cache[pv_name] = (sim_pv.value, sim_pv.timestamp,
                                sim_pv.severity)
        self._fire_callbacks(pv_name, sim_pv.value, sim_pv.timestamp,
                             sim_pv.severity)

        # Motor logic: setting VAL starts a move
        if pv_name.endswith(":VAL") and ":MTR:" in pv_name:
            prefix = pv_name[:-4]  # e.g. SIM:MTR:1
            await self._start_motor_move(prefix, value)

    async def _start_motor_move(self, prefix: str, target: float):
        """Gradually move motor RBV toward target VAL."""
        rbv_name = f"{prefix}:RBV"
        movn_name = f"{prefix}:MOVN"

        # Cancel any existing move for this motor
        if prefix in self._motor_tasks:
            self._motor_tasks[prefix].cancel()
            try:
                await self._motor_tasks[prefix]
            except asyncio.CancelledError:
                pass

        async def _move():
            try:
                # Set moving flag
                self._sim_pvs[movn_name].value = 1
                self._sim_pvs[movn_name].timestamp = time.time()
                self._cache[movn_name] = (1, time.time(), 0)
                self._fire_callbacks(movn_name, 1, time.time(), 0)

                rbv_pv = self._sim_pvs[rbv_name]
                speed = 5.0  # units per second (mm/s or deg/s)
                step_interval = 0.05  # 50ms steps

                while self._running:
                    current = rbv_pv.value
                    distance = target - current
                    if abs(distance) < 0.01:
                        # Close enough -- snap to target
                        rbv_pv.value = target
                        rbv_pv.timestamp = time.time()
                        self._cache[rbv_name] = (target, rbv_pv.timestamp, 0)
                        self._fire_callbacks(rbv_name, target,
                                             rbv_pv.timestamp, 0)
                        break

                    step = speed * step_interval
                    if abs(distance) < step:
                        step = abs(distance)
                    rbv_pv.value = current + (step if distance > 0 else -step)
                    rbv_pv.value = round(rbv_pv.value, 4)
                    rbv_pv.timestamp = time.time()
                    self._cache[rbv_name] = (rbv_pv.value, rbv_pv.timestamp, 0)
                    self._fire_callbacks(rbv_name, rbv_pv.value,
                                         rbv_pv.timestamp, 0)
                    await asyncio.sleep(step_interval)

                # Move complete
                self._sim_pvs[movn_name].value = 0
                self._sim_pvs[movn_name].timestamp = time.time()
                self._cache[movn_name] = (0, time.time(), 0)
                self._fire_callbacks(movn_name, 0, time.time(), 0)
            except asyncio.CancelledError:
                # Move was interrupted -- leave RBV wherever it is, clear MOVN
                self._sim_pvs[movn_name].value = 0
                self._sim_pvs[movn_name].timestamp = time.time()
                self._cache[movn_name] = (0, time.time(), 0)
                self._fire_callbacks(movn_name, 0, time.time(), 0)

        self._motor_tasks[prefix] = asyncio.create_task(_move())

    def _fire_callbacks(self, pv_name: str, value: Any, timestamp: float,
                        severity: int):
        """Dispatch value to all registered callbacks for a PV."""
        # Record in time-series cache for plot widgets
        self.pv_cache.record(pv_name, value, timestamp)

        for cb in self._subscriptions.get(pv_name, []):
            try:
                cb(pv_name, value, timestamp, severity)
            except Exception as exc:
                logger.error("Callback error for %s: %s", pv_name, exc)

    # ── Real-mode (caproto) internals ────────────────────────────────────

    def _real_subscribe(self, pv_name: str):
        """Set up a caproto monitor for a PV (called from subscribe)."""
        if self._ctx is None:
            return
        try:
            (pv_obj,) = self._ctx.get_pvs(pv_name, timeout=5.0)
            self._caproto_pvs[pv_name] = pv_obj

            def _monitor_callback(sub, response):
                value = response.data[0] if len(response.data) == 1 \
                    else list(response.data)
                ts = time.time()
                severity = getattr(response.metadata, 'severity', 0) \
                    if response.metadata else 0

                self._cache[pv_name] = (value, ts, severity)

                # Schedule callback dispatch on the asyncio event loop
                if self._loop is not None and self._loop.is_running():
                    self._loop.call_soon_threadsafe(
                        self._fire_callbacks, pv_name, value, ts, severity
                    )

            sub = pv_obj.subscribe(data_type='time')
            sub.add_callback(_monitor_callback)
            # Store both the subscription AND the callback function;
            # caproto holds only a weakref to the callback, so without
            # a strong reference here it gets garbage-collected.
            self._caproto_subs[pv_name] = (sub, _monitor_callback)
            logger.info("Subscribed to real PV: %s", pv_name)

        except Exception as exc:
            logger.error("Failed to subscribe to real PV %s: %s",
                         pv_name, exc)

    async def _real_put(self, pv_name: str, value: Any):
        """Write to a real PV via caproto."""
        if self._ctx is None:
            logger.error("Cannot put -- no caproto context")
            return
        try:
            if pv_name not in self._caproto_pvs:
                (pv_obj,) = self._ctx.get_pvs(pv_name, timeout=5.0)
                self._caproto_pvs[pv_name] = pv_obj

            pv_obj = self._caproto_pvs[pv_name]
            # Run the blocking caproto put in a thread
            loop = asyncio.get_running_loop()
            await loop.run_in_executor(None, pv_obj.write, [value])
            logger.info("Put %s = %s", pv_name, value)
        except Exception as exc:
            logger.error("Failed to put %s: %s", pv_name, exc)
