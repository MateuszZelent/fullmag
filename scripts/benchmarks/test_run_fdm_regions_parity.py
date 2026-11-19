#!/usr/bin/env python3
"""Exit-status contract of ``run_fdm_regions_parity.py`` on synthetic lane records."""

from __future__ import annotations

import array
import json
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
FIELD = {10: [1.0e5, -2.0e5, 0.0, 3.0e5, 0.0, 1.0e4]}


def fake_run(gpu_scalars=None, cpu_scalars=None, gpu_m=None, gpu_returncode=0,
             single_scalars=None, single_m=None, single_fields=None):
    def run(case, device, precision, steps, output, fullmag_bin, save_fields=False):
        is_cpu = device == "cpu"
        is_single = precision == "single"
        if is_single:
            scalars, m_final = single_scalars or ENERGIES, single_m or M_FINAL
        elif is_cpu:
            scalars, m_final = cpu_scalars or ENERGIES, M_FINAL
        else:
            scalars, m_final = gpu_scalars or ENERGIES, gpu_m or M_FINAL
        fields = None
        if save_fields:
            fields = single_fields if is_single and single_fields is not None else \
                {name: FIELD for name in parity.FIELDS}
        return {
            "case": case, "device": device, "precision": precision, "steps": steps,
            "returncode": 0 if is_cpu else gpu_returncode, "wall_s": 1.0, "stderr_tail": "",
            "m_final": m_final, "scalars": dict(scalars), "fields": fields,
            "m_final_sha256": "0" * 64,
        }
    return run


class ParityExitStatusTests(unittest.TestCase):
    def main_with(self, run, *extra) -> int:
        with tempfile.TemporaryDirectory() as output, \
                mock.patch.object(parity, "run", side_effect=run), \
                mock.patch.object(sys, "argv",
                                  ["run_fdm_regions_parity.py", "--output", output,
                                   "--case", "uniform", *extra]), \
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


class Fp32QualificationTests(unittest.TestCase):
    main_with = ParityExitStatusTests.main_with

    def test_fp32_within_tolerance_passes(self):
        m = [[1.0 - 1e-7, 0.0, 0.0], [0.0, 1.0, 1e-7]]
        energies = dict(ENERGIES, E_total=ENERGIES["E_total"] * (1 + 1e-6))
        fields = {name: {10: [value * (1 + 1e-7) for value in FIELD[10]]} for name in parity.FIELDS}
        run = fake_run(single_m=m, single_scalars=energies, single_fields=fields)
        self.assertEqual(self.main_with(run, "--with-fp32"), 0)

    def test_fp32_magnetization_above_tolerance_fails(self):
        m = [[1.0 - 1e-3, 0.0, 0.0], [0.0, 1.0, 0.0]]
        self.assertEqual(self.main_with(fake_run(single_m=m), "--with-fp32"), 1)

    def test_fp32_energy_above_tolerance_fails(self):
        energies = dict(ENERGIES, E_exchange=ENERGIES["E_exchange"] * 1.01)
        self.assertEqual(self.main_with(fake_run(single_scalars=energies), "--with-fp32"), 1)

    def test_fp32_nan_energy_fails(self):
        energies = dict(ENERGIES, E_exchange=math.nan)
        self.assertEqual(self.main_with(fake_run(single_scalars=energies), "--with-fp32"), 1)

    def test_fp32_field_above_tolerance_fails(self):
        fields = {"H_ex": FIELD, "H_eff": {10: [value * 1.01 for value in FIELD[10]]}}
        self.assertEqual(self.main_with(fake_run(single_fields=fields), "--with-fp32"), 1)

    def test_fp32_nan_field_fails(self):
        fields = {"H_ex": {10: [math.nan] + FIELD[10][1:]}, "H_eff": FIELD}
        self.assertEqual(self.main_with(fake_run(single_fields=fields), "--with-fp32"), 1)

    def test_fp32_missing_field_fails(self):
        fields = {"H_ex": FIELD, "H_eff": "unreadable: no samples"}
        self.assertEqual(self.main_with(fake_run(single_fields=fields), "--with-fp32"), 1)

    def test_fp32_field_final_step_mismatch_fails(self):
        fields = {"H_ex": {**FIELD, 20: FIELD[10]}, "H_eff": FIELD}
        self.assertEqual(self.main_with(fake_run(single_fields=fields), "--with-fp32"), 1)


class FieldReaderTests(unittest.TestCase):
    # Two cells per sample, AoS: [x0, y0, z0, x1, y1, z1].
    SAMPLES = {0: [1.0, 2.0, 3.0, 4.0, 5.0, 6.0], 10: [-1.0, -2.0, -3.0, 7.5, 8.5, 9.5]}

    def write_cuda_store(self, artifacts: Path, chunk_cells: int, index_rows=None):
        root = artifacts / "fields" / "H_ex.zarr"
        root.mkdir(parents=True)
        cells = 2
        (root / ".zarray").write_text(json.dumps({
            "shape": [len(self.SAMPLES), 3, cells], "chunks": [1, 3, chunk_cells], "dtype": "<f4",
            "compressor": None, "filters": None, "dimension_separator": ".",
        }))
        (root / ".zattrs").write_text(json.dumps({
            "axes": ["sample", "component", "cell"], "component_order": ["x", "y", "z"],
            "sample_index_file": "samples.csv",
        }))
        rows = ["sample,step"]
        for sample, (step, aos) in enumerate(sorted(self.SAMPLES.items())):
            rows.append(f"{sample},{step}")
            for chunk in range(-(-cells // chunk_cells)):
                values = array.array("f")
                for component in range(3):
                    part = [aos[3 * cell + component]
                            for cell in range(chunk * chunk_cells, min(cells, (chunk + 1) * chunk_cells))]
                    values.extend(part + [0.0] * (chunk_cells - len(part)))
                if sys.byteorder != "little":
                    values.byteswap()
                (root / f"{sample}.0.{chunk}").write_bytes(values.tobytes())
        (root / "samples.csv").write_text("\n".join(index_rows or rows) + "\n")

    def test_cuda_component_major_store_is_returned_as_aos(self):
        for chunk_cells in (2, 1):
            with tempfile.TemporaryDirectory() as directory:
                artifacts = Path(directory)
                self.write_cuda_store(artifacts, chunk_cells)
                self.assertEqual(parity.read_field_samples(artifacts, "H_ex"), self.SAMPLES)

    def test_cuda_sample_index_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory)
            self.write_cuda_store(artifacts, 2, index_rows=["sample,step", "0,0"])
            with self.assertRaises(ValueError):
                parity.read_field_samples(artifacts, "H_ex")

    def test_cpu_step_json_triples_are_flattened(self):
        with tempfile.TemporaryDirectory() as directory:
            artifacts = Path(directory)
            (artifacts / "fields" / "H_ex").mkdir(parents=True)
            for step, aos in self.SAMPLES.items():
                document = {"step": step, "component_order": "xyz",
                            "values": [aos[0:3], aos[3:6]]}
                (artifacts / "fields" / "H_ex" / f"step_{step:06d}.json").write_text(json.dumps(document))
            self.assertEqual(parity.read_field_samples(artifacts, "H_ex"), self.SAMPLES)

    def test_missing_field_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            with self.assertRaises(ValueError):
                parity.read_field_samples(Path(directory), "H_ex")

    def test_lanes_with_different_first_step_compare_common_steps(self):
        reference = {1: [1.0, 2.0], 10: [3.0, 4.0]}
        lane = {0: [9.0, 9.0], 10: [3.0, 4.0 + 4e-6]}
        value, steps = parity.field_rel(reference, lane)
        self.assertEqual(steps, [10])
        self.assertAlmostEqual(value, 1e-6)

    def test_different_final_step_is_rejected(self):
        with self.assertRaises(ValueError):
            parity.field_rel({10: [1.0]}, {10: [1.0], 20: [1.0]})


if __name__ == "__main__":
    unittest.main()
