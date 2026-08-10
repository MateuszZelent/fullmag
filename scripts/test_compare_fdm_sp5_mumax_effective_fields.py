from __future__ import annotations

import importlib.util
import math
from pathlib import Path
import unittest


SCRIPT = Path(__file__).with_name("compare_fdm_sp5_mumax_effective_fields.py")


def load_module():
    spec = importlib.util.spec_from_file_location(
        "compare_fdm_sp5_mumax_effective_fields", SCRIPT
    )
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load SP5 effective-field comparator")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CompareFdmSp5MumaxEffectiveFieldsTests(unittest.TestCase):
    def test_converts_mumax_b_to_h_before_comparison(self) -> None:
        module = load_module()
        report = module.compare_effective_fields(
            mumax_b_demag=[(module.MU0, 0.0, 0.0)],
            mumax_b_exchange=[(0.0, 2.0 * module.MU0, 0.0)],
            fullmag_h_demag=[(1.0, 0.0, 0.0)],
            fullmag_h_exchange=[(0.0, 2.0, 0.0)],
        )

        self.assertEqual(report["H_demag"]["max_abs_component_error"], 0.0)
        self.assertEqual(report["H_ex"]["max_abs_component_error"], 0.0)

    def test_reports_relative_rms(self) -> None:
        module = load_module()
        report = module.compare_effective_fields(
            mumax_b_demag=[(module.MU0, 0.0, 0.0)],
            mumax_b_exchange=[(module.MU0, 0.0, 0.0)],
            fullmag_h_demag=[(1.1, 0.0, 0.0)],
            fullmag_h_exchange=[(1.0, 0.0, 0.0)],
        )

        self.assertTrue(math.isclose(report["H_demag"]["relative_rms_error"], 0.1))
        self.assertEqual(report["H_ex"]["relative_rms_error"], 0.0)

    def test_demag_accuracy_sweep_preserves_requested_levels(self) -> None:
        module = load_module()
        sweep = module.compare_demag_sweep(
            fullmag_h_demag=[(1.0, 0.0, 0.0)],
            mumax_b_by_accuracy={
                6: [(0.9 * module.MU0, 0.0, 0.0)],
                12: [(0.95 * module.MU0, 0.0, 0.0)],
            },
        )

        self.assertEqual(list(sweep), ["6", "12"])
        self.assertGreater(
            sweep["6"]["relative_rms_error"],
            sweep["12"]["relative_rms_error"],
        )


if __name__ == "__main__":
    unittest.main()
