#!/usr/bin/env python3
"""Contract test for the pure-Oersted FEM-TD-OBS-003 fixture mode."""

from __future__ import annotations

import unittest
from pathlib import Path


class OerstedObservableFixtureTests(unittest.TestCase):
    def test_pure_observable_mode_omits_exchange_without_changing_default(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "examples" / "fem_oersted_rk_time_convergence.py").read_text(encoding="utf-8")
        self.assertIn('FULLMAG_OERSTED_OBSERVABLE_PURE', source)
        self.assertIn('OBSERVABLE_PURE = os.environ.get("FULLMAG_OERSTED_OBSERVABLE_PURE", "0") == "1"', source)
        self.assertIn('energy.insert(0, fm.Exchange())', source)
        self.assertIn('if OBSERVABLE_PURE:', source)
        self.assertIn('energy.insert(0, fm.Zeeman(B=(0.0, 0.0, 0.0)))', source)

    def test_final_native_fem_field_snapshots_refresh_device_fields_first(self) -> None:
        source = (Path(__file__).resolve().parents[1] / "crates" / "fullmag-runner" / "src" / "fem" / "relax" / "finalize.rs").read_text(encoding="utf-8")
        refresh = source.find("backend.snapshot_step_stats(node_count)?")
        snapshots = source.find("for schedule in &mut field_schedules")
        self.assertNotEqual(refresh, -1)
        self.assertLess(refresh, snapshots)


if __name__ == "__main__":
    unittest.main()
