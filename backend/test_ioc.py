"""Standalone caproto IOC for testing EIWYG without sim mode.

Run with:
    python -m backend.test_ioc

This creates a full set of SIM: PVs matching those defined in
epics_manager.py, with periodic noise updates and motor move support.
"""
import random
import time
import threading

from caproto.server import PVGroup, ioc_arg_parser, pvproperty, run


class SimIOC(PVGroup):
    """Simulated beamline IOC providing SIM:* PVs."""

    # ── Temperature sensors ──────────────────────────────────────────────
    temp1 = pvproperty(name="SIM:TEMP:1", value=28.0, dtype=float,
                       precision=2, units="C",
                       lower_ctrl_limit=20.0, upper_ctrl_limit=40.0)
    temp2 = pvproperty(name="SIM:TEMP:2", value=26.5, dtype=float,
                       precision=2, units="C",
                       lower_ctrl_limit=20.0, upper_ctrl_limit=40.0)
    temp3 = pvproperty(name="SIM:TEMP:3", value=30.2, dtype=float,
                       precision=2, units="C",
                       lower_ctrl_limit=20.0, upper_ctrl_limit=40.0)
    temp4 = pvproperty(name="SIM:TEMP:4", value=27.8, dtype=float,
                       precision=2, units="C",
                       lower_ctrl_limit=20.0, upper_ctrl_limit=40.0)

    # ── Pressure sensors ─────────────────────────────────────────────────
    pressure1 = pvproperty(name="SIM:PRESSURE:1", value=3e-7, dtype=float,
                           precision=2, units="Torr")
    pressure2 = pvproperty(name="SIM:PRESSURE:2", value=2e-7, dtype=float,
                           precision=2, units="Torr")

    # ── Flow ─────────────────────────────────────────────────────────────
    flow1 = pvproperty(name="SIM:FLOW:1", value=5.0, dtype=float,
                       precision=1, units="L/min",
                       lower_ctrl_limit=0.0, upper_ctrl_limit=20.0)

    # ── Beam ─────────────────────────────────────────────────────────────
    beam_intensity = pvproperty(name="SIM:BEAM:INTENSITY", value=1e5,
                                dtype=float, precision=0, units="counts")
    beam_energy = pvproperty(name="SIM:BEAM:ENERGY", value=12.0,
                             dtype=float, precision=3, units="keV")

    # ── Detector ─────────────────────────────────────────────────────────
    det_counts = pvproperty(name="SIM:DET:COUNTS", value=100000,
                            dtype=int, units="counts")
    det_rate = pvproperty(name="SIM:DET:RATE", value=3000.0,
                          dtype=float, precision=1, units="Hz")

    # ── Motor 1 (linear, mm) ────────────────────────────────────────────
    mtr1_rbv = pvproperty(name="SIM:MTR:1:RBV", value=50.0, dtype=float,
                          precision=3, units="mm", read_only=True)
    mtr1_val = pvproperty(name="SIM:MTR:1:VAL", value=50.0, dtype=float,
                          precision=3, units="mm")
    mtr1_movn = pvproperty(name="SIM:MTR:1:MOVN", value=0, dtype=int,
                           read_only=True)

    # ── Motor 2 (rotary, degrees) ───────────────────────────────────────
    mtr2_rbv = pvproperty(name="SIM:MTR:2:RBV", value=180.0, dtype=float,
                          precision=3, units="deg", read_only=True)
    mtr2_val = pvproperty(name="SIM:MTR:2:VAL", value=180.0, dtype=float,
                          precision=3, units="deg")
    mtr2_movn = pvproperty(name="SIM:MTR:2:MOVN", value=0, dtype=int,
                           read_only=True)

    # ── Shutter ──────────────────────────────────────────────────────────
    shutter_status = pvproperty(name="SIM:SHUTTER:STATUS", value=0,
                                dtype=int, units="")

    # ── Valve ────────────────────────────────────────────────────────────
    valve1 = pvproperty(name="SIM:VALVE:1", value=0, dtype=int, units="")

    # ── Motor put handlers ───────────────────────────────────────────────

    @mtr1_val.putter
    async def mtr1_val(self, instance, value):
        """When motor 1 VAL is set, simulate a move."""
        await self._move_motor(
            rbv_prop=self.mtr1_rbv,
            movn_prop=self.mtr1_movn,
            target=value,
            speed=5.0  # mm/s
        )
        return value

    @mtr2_val.putter
    async def mtr2_val(self, instance, value):
        """When motor 2 VAL is set, simulate a move."""
        await self._move_motor(
            rbv_prop=self.mtr2_rbv,
            movn_prop=self.mtr2_movn,
            target=value,
            speed=20.0  # deg/s
        )
        return value

    async def _move_motor(self, rbv_prop, movn_prop, target, speed):
        """Gradually move RBV toward target, toggling MOVN."""
        import asyncio

        await movn_prop.write(1)

        step_interval = 0.05
        while True:
            current = rbv_prop.value
            distance = target - current
            if abs(distance) < 0.01:
                await rbv_prop.write(target)
                break
            step = speed * step_interval
            if abs(distance) < step:
                step = abs(distance)
            new_val = current + (step if distance > 0 else -step)
            await rbv_prop.write(round(new_val, 4))
            await asyncio.sleep(step_interval)

        await movn_prop.write(0)

    # ── Periodic noise updates ───────────────────────────────────────────

    @temp1.scan(period=1.0)
    async def temp1(self, instance, async_lib):
        await instance.write(instance.value + random.gauss(0, 0.05))

    @temp2.scan(period=1.0)
    async def temp2(self, instance, async_lib):
        await instance.write(instance.value + random.gauss(0, 0.05))

    @temp3.scan(period=1.0)
    async def temp3(self, instance, async_lib):
        await instance.write(instance.value + random.gauss(0, 0.05))

    @temp4.scan(period=1.0)
    async def temp4(self, instance, async_lib):
        await instance.write(instance.value + random.gauss(0, 0.05))

    @pressure1.scan(period=1.5)
    async def pressure1(self, instance, async_lib):
        noise = random.gauss(0, 1e-8)
        val = max(1e-8, instance.value + noise)
        await instance.write(val)

    @pressure2.scan(period=1.5)
    async def pressure2(self, instance, async_lib):
        noise = random.gauss(0, 1e-8)
        val = max(1e-8, instance.value + noise)
        await instance.write(val)

    @flow1.scan(period=1.0)
    async def flow1(self, instance, async_lib):
        val = max(0.0, instance.value + random.gauss(0, 0.1))
        await instance.write(val)

    @beam_intensity.scan(period=0.5)
    async def beam_intensity(self, instance, async_lib):
        val = max(0.0, instance.value + random.gauss(0, 5e3))
        await instance.write(val)

    @beam_energy.scan(period=2.0)
    async def beam_energy(self, instance, async_lib):
        val = instance.value + random.gauss(0, 0.001)
        await instance.write(val)

    @det_counts.scan(period=0.5)
    async def det_counts(self, instance, async_lib):
        val = random.randint(50000, 200000)
        await instance.write(val)

    @det_rate.scan(period=0.5)
    async def det_rate(self, instance, async_lib):
        val = max(1000.0, instance.value + random.gauss(0, 200))
        val = min(val, 5000.0)
        await instance.write(val)


def main():
    """Entry point for running the test IOC."""
    ioc_options, run_options = ioc_arg_parser(
        default_prefix="",
        desc="EIWYG Simulated Beamline IOC"
    )
    ioc = SimIOC(**ioc_options)
    run(ioc.pvdb, **run_options)


if __name__ == "__main__":
    main()
