"""Time-series PV value cache with automatic compaction.

Stores timestamped PV values and compacts them using bin-averaging
when the buffer exceeds a threshold. Queries return downsampled data
for a given time window and max point count.
"""
import time
import threading


class PVHistory:
    """Rolling time-series buffer for a single PV with auto-compaction."""

    def __init__(self, max_raw_points: int = 20_000):
        self.points: list[tuple[float, float]] = []  # (timestamp, value)
        self.max_raw_points = max_raw_points
        self._lock = threading.Lock()

    def add(self, value, timestamp: float | None = None):
        ts = timestamp or time.time()
        try:
            v = float(value)
        except (TypeError, ValueError):
            return
        with self._lock:
            self.points.append((ts, v))
            if len(self.points) > self.max_raw_points:
                self._compact()

    def _compact(self):
        """Bin-average down to half capacity, preserving time range."""
        target = self.max_raw_points // 2
        if len(self.points) <= target:
            return
        self.points = _downsample(self.points, target)

    def get_history(self, time_window_seconds: float, max_points: int) -> list[dict]:
        """Return points within time_window, downsampled to max_points."""
        now = time.time()
        cutoff = now - time_window_seconds

        with self._lock:
            filtered = [(t, v) for t, v in self.points if t >= cutoff]

        if len(filtered) <= max_points:
            return [{"t": t, "v": v} for t, v in filtered]

        downsampled = _downsample(filtered, max_points)
        return [{"t": t, "v": v} for t, v in downsampled]

    @property
    def size(self) -> int:
        return len(self.points)


def _downsample(points: list[tuple[float, float]], max_points: int) -> list[tuple[float, float]]:
    """Downsample a sorted list of (timestamp, value) pairs via bin averaging."""
    n = len(points)
    if n <= max_points or max_points < 1:
        return list(points)

    t_min = points[0][0]
    t_max = points[-1][0]
    t_range = t_max - t_min
    if t_range <= 0:
        # All same timestamp — just take evenly spaced samples
        step = max(1, n // max_points)
        return [points[i] for i in range(0, n, step)][:max_points]

    bin_width = t_range / max_points
    binned = []
    bin_start = t_min
    bin_t_sum = 0.0
    bin_v_sum = 0.0
    bin_count = 0

    for t, v in points:
        # If this point belongs to a new bin, flush the current bin
        while t >= bin_start + bin_width and bin_count > 0:
            binned.append((bin_t_sum / bin_count, bin_v_sum / bin_count))
            bin_t_sum = 0.0
            bin_v_sum = 0.0
            bin_count = 0
            bin_start += bin_width
            # Skip empty bins
            while t >= bin_start + bin_width:
                bin_start += bin_width

        bin_t_sum += t
        bin_v_sum += v
        bin_count += 1

    # Flush last bin
    if bin_count > 0:
        binned.append((bin_t_sum / bin_count, bin_v_sum / bin_count))

    return binned


class PVCache:
    """Global cache holding PVHistory instances for all tracked PVs."""

    def __init__(self, max_raw_points_per_pv: int = 20_000):
        self._histories: dict[str, PVHistory] = {}
        self._lock = threading.Lock()
        self.max_raw_points_per_pv = max_raw_points_per_pv

    def record(self, pv_name: str, value, timestamp: float | None = None):
        """Record a value for a PV. Creates history buffer if needed."""
        hist = self._get_or_create(pv_name)
        hist.add(value, timestamp)

    def get_history(self, pv_name: str, time_window_seconds: float,
                    max_points: int = 1000) -> list[dict]:
        """Get cached history for a PV, downsampled to max_points."""
        hist = self._histories.get(pv_name)
        if not hist:
            return []
        return hist.get_history(time_window_seconds, max_points)

    def get_pvs(self) -> list[str]:
        """Return list of PVs that have cached data."""
        return list(self._histories.keys())

    def _get_or_create(self, pv_name: str) -> PVHistory:
        hist = self._histories.get(pv_name)
        if hist:
            return hist
        with self._lock:
            # Double-check after acquiring lock
            hist = self._histories.get(pv_name)
            if hist:
                return hist
            hist = PVHistory(max_raw_points=self.max_raw_points_per_pv)
            self._histories[pv_name] = hist
            return hist
