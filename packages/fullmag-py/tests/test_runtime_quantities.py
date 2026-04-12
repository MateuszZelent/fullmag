from __future__ import annotations

import unittest
import warnings

from fullmag.model import BackendTarget, ExecutionMode, ExecutionPrecision
from fullmag.model.structure import Material
from fullmag.runtime.simulation import Result, StepStats


class RuntimeQuantityTests(unittest.TestCase):
    def test_result_exposes_scalar_descriptors(self) -> None:
        result = Result(
            status="completed",
            backend=BackendTarget.FDM,
            mode=ExecutionMode.STRICT,
            precision=ExecutionPrecision.DOUBLE,
            steps=(
                StepStats(
                    step=1,
                    time=1.0e-12,
                    dt=1.0e-12,
                    e_ex=1.0,
                    e_demag=2.0,
                    e_ext=3.0,
                    e_total=6.0,
                    max_dm_dt=4.0,
                    max_h_eff=5.0,
                    wall_time_ns=10,
                ),
            ),
        )

        desc = result.scalar_descriptor("max_dm_dt")
        self.assertEqual(desc.quantity_id, "dm_dt")
        self.assertEqual(desc.unit, "1/s")
        self.assertEqual(desc.scalar_key, "max_dm_dt")
        self.assertTrue(any(item.scalar_key == "e_total" for item in result.scalar_descriptors()))

    def test_material_warns_for_suspicious_non_si_ranges(self) -> None:
        with warnings.catch_warnings(record=True) as captured:
            warnings.simplefilter("always")
            Material(name="Suspicious", Ms=1.0, A=1.0, alpha=0.01)

        messages = [str(item.message) for item in captured]
        self.assertTrue(any("SI units" in message for message in messages))


if __name__ == "__main__":
    unittest.main()
