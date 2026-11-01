#!/usr/bin/env python3
"""Exit-status contract of ``run_fdm_regions_parity.py`` on synthetic lane records."""

from __future__ import annotations

import math
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import run_fdm_regions_parity as parity  # noqa: E402

M_FINAL = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
ENERGIES = {"E_total": -1.0e-18, "E_exchange": 2.0e-19}


def fake_run(gpu_scalars=None, cpu_scalars=None, gpu_m=None, gpu_returncode=0):
    def run(case, device, precision, steps, output, fullmag_bin):
        is_cpu = device == "cpu"
        scalars = dict(cpu_scalars if is_cpu and cpu_scalars else
                       gpu_scalars if not is_cpu and gpu_scalars else ENERGIES)
        return {
            "case": case, "device": device, "precision": precision, "steps": steps,
            "returncode": 0 if is_cpu else gpu_returncode, "wall_s": 1.0, "stderr_tail": "",
            "m_final": M_FINAL if is_cpu or gpu_m is None else gpu_m,
            "scalars": scalars, "m_final_sha256": "0" * 64,
        }
    return run


class ParityExitStatusTests(unittest.TestCase):
    def main_with(self, run) -> int:
        with tempfile.TemporaryDirectory() as output, \
                mock.patch.object(parity, "run", side_effect=run), \
                mock.patch.object(sys, "argv",
                                  ["run_fdm_regions_parity.py", "--output", output,
                                   "--case", "uniform"]), \
                mock.patch("sys.stdout"), mock.patch("sys.stderr"):
            return parity.main()

    def test_matching_lanes_pass(self):
        self.assertEqual(self.main_with(fake_run()), 0)

    def test_nan_in_second_gpu_energy_fails(self):
        gpu = dict(ENERGIES, E_exchange=math.nan)
        self.assertEqual(self.main_with(fake_run(gpu_scalars=gpu)), 1)

    def test_nan_in_second_cpu_energy_fails(self):
        cpu = dict(ENERGIES, E_exchange=math.nan)
        self.assertEqual(self.main_with(fake_run(cpu_scalars=cpu)), 1)

    def test_non_finite_magnetization_fails(self):
        self.assertEqual(self.main_with(fake_run(gpu_m=[[math.nan, 0.0, 0.0], [0.0, 1.0, 0.0]])), 1)

    def test_truncated_magnetization_fails(self):
        self.assertEqual(self.main_with(fake_run(gpu_m=M_FINAL[:1])), 1)

    def test_solver_failure_fails(self):
        self.assertEqual(self.main_with(fake_run(gpu_returncode=2)), 1)


if __name__ == "__main__":
    unittest.main()
