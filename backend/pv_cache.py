"""Time-series PV value cache with automatic compaction.

Stores timestamped PV values and compacts them using bin-averaging
when the buffer exceeds a threshold. Queries return downsampled data
for a given time window and max point count.
"""
import bisect
import math
import time
import threading


class PVHistory:
    """Rolling time-series buffer for a single PV with auto-compaction.

    Each point is (mean_timestamp, mean_value, sample_count). Raw samples
    have count 1; compacted points carry the number of samples they
    average so later averaging stays correctly weighted.
    """

    def __init__(self, max_raw_points: int = 20_000):
        self.points: list[tuple[float, float, int]] = []
        self.max_raw_points = max_raw_points
        self._lock = threading.Lock()

    def add(self, value, timestamp: float | None = None):
        ts = timestamp or time.time()
        try:
            v = float(value)
        except (TypeError, ValueError):
            return
        with self._lock:
            # Monitor updates normally arrive in time order; keep the
            # buffer sorted if one doesn't.
            if self.points and ts < self.points[-1][0]:
                bisect.insort(self.points, (ts, v, 1))
            else:
                self.points.append((ts, v, 1))
            if len(self.points) > self.max_raw_points:
                self._compact()

    # (max_age_seconds, bin_width_seconds): when compacting, points are
    # bin-averaged at a width set by their age. Bins are aligned to
    # absolute time, so re-compacting an already-binned point is a no-op.
    COMPACT_TIERS = [(3600, 1.0), (6 * 3600, 10.0), (86400, 60.0),
                     (float("inf"), 600.0)]

    def _compact(self):
        """Bin-average the older half of the buffer by age tier, keeping
        recent points at full resolution. Data from the last hour keeps
        1 s resolution; older data is coarsened progressively."""
        half = len(self.points) // 2
        now = time.time()
        older = self.points[:half]
        compacted = []
        start = 0
        # Points are sorted oldest first; walk tiers from coarsest to finest
        for max_age, width in reversed(self.COMPACT_TIERS):
            end = start
            while end < len(older) and now - older[end][0] > self._tier_floor(max_age):
                end += 1
            if end > start:
                compacted += _bin_average(older[start:end], width)
            start = end
        self.points = compacted + self.points[half:]
        # Leave headroom so the next compaction is max/4 samples away; if
        # binning alone can't get there (e.g. a very fast PV), drop the
        # oldest points.
        limit = self.max_raw_points * 3 // 4
        if len(self.points) > limit:
            del self.points[:len(self.points) - limit]

    def _tier_floor(self, max_age: float) -> float:
        """Lower age bound of the tier whose upper bound is max_age."""
        ages = [a for a, _ in self.COMPACT_TIERS]
        i = ages.index(max_age)
        return ages[i - 1] if i > 0 else 0.0

    def get_history(self, time_window_seconds: float, max_points: int) -> list[dict]:
        """Return points within time_window, bin-averaged into bins of
        time_window / max_points seconds aligned to absolute time
        (bin = floor(t / width)), matching the client's plot bins."""
        now = time.time()
        cutoff = now - time_window_seconds

        with self._lock:
            i = bisect.bisect_left(self.points, (cutoff,))
            filtered = self.points[i:]

        if len(filtered) > max_points:
            filtered = _bin_average(filtered, time_window_seconds / max_points)
        return [{"t": t, "v": v, "n": n} for t, v, n in filtered]

    @property
    def size(self) -> int:
        return len(self.points)


def _bin_average(points: list[tuple[float, float, int]],
                 bin_width: float) -> list[tuple[float, float, int]]:
    """Count-weighted average of sorted (t, v, n) points into fixed-width
    bins aligned to absolute time. Each output point sits at the mean
    timestamp of the samples it contains."""
    binned = []
    cur_idx = None
    t_sum = v_sum = 0.0
    count = 0
    for t, v, n in points:
        idx = math.floor(t / bin_width)
        if idx != cur_idx and count > 0:
            binned.append((t_sum / count, v_sum / count, count))
            t_sum = v_sum = 0.0
            count = 0
        cur_idx = idx
        t_sum += t * n
        v_sum += v * n
        count += n
    if count > 0:
        binned.append((t_sum / count, v_sum / count, count))
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
