"""Regression tests for artifact-backed STNO reporting."""

from __future__ import annotations

import csv
import json
from pathlib import Path
import tempfile
import unittest

import numpy as np

from fullmag.analysis import analyze_stno_artifacts, write_stno_report
from fullmag.analysis.stno_report import _snapshot_coordinates


def _write_scalars_csv(path: Path, t: np.ndarray, mx: np.ndarray, my: np.ndarray, mz: np.ndarray) -> None:
    header = [
        "step",
        "time",
        "solver_dt",
        "mx",
        "my",
        "mz",
        "E_ex",
        "E_demag",
        "E_ext",
        "E_ani",
        "E_dmi",
        "E_total",
        "max_dm_dt",
        "max_h_eff",
        "max_h_demag",
        "max_torque_Apm",
        "max_torque_T",
    ]
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(header)
        dt = float(t[1] - t[0])
        for step, (time_s, mx_i, my_i, mz_i) in enumerate(zip(t, mx, my, mz, strict=True)):
            writer.writerow(
                [
                    step,
                    f"{time_s:.15e}",
                    f"{dt:.15e}",
                    f"{mx_i:.15e}",
                    f"{my_i:.15e}",
                    f"{mz_i:.15e}",
                    "0.0",
                    "0.0",
                    "0.0",
                    "0.0",
                    "0.0",
                    "1.0",
                    "1.0",
                    "1.0",
                    "1.0",
                    "1.0",
                    "1.2566370614e-6",
                ]
            )


def _write_vortex_snapshots(path: Path, *, f_hz: float, orbit_radius_m: float) -> None:
    nx = 21
    ny = 21
    nz = 1
    dx = 5e-9
    dy = 5e-9
    dz = 5e-9
    times = np.linspace(0.0, 40e-9, 41)
    x1 = np.linspace(-50e-9, 50e-9, nx)
    y1 = np.linspace(-50e-9, 50e-9, ny)
    xx, yy = np.meshgrid(x1, y1)
    fields_dir = path / "fields" / "m"
    fields_dir.mkdir(parents=True, exist_ok=True)

    for step, time_s in enumerate(times):
        ramp = min(1.0, float(time_s / 10e-9)) if time_s > 0.0 else 0.0
        phase = 2.0 * np.pi * f_hz * time_s
        cx = ramp * orbit_radius_m * np.cos(phase)
        cy = ramp * orbit_radius_m * np.sin(phase)
        r2 = (xx - cx) ** 2 + (yy - cy) ** 2
        mz = np.exp(-r2 / (2.0 * (6e-9 ** 2)))
        values = np.column_stack(
            [
                np.zeros(nx * ny, dtype=np.float64),
                np.zeros(nx * ny, dtype=np.float64),
                mz.ravel(),
            ]
        )
        payload = {
            "observable": "m",
            "unit": "dimensionless",
            "step": step,
            "time": float(time_s),
            "solver_dt": 1.0e-9,
            "layout": {
                "backend": "fdm",
                "grid_cells": [nx, ny, nz],
                "cell_size": [dx, dy, dz],
                "total_cell_count": nx * ny * nz,
                "active_mask_present": False,
            },
            "provenance": {
                "problem_name": "synthetic_stno",
                "ir_version": "0.2.0",
                "execution_mode": "strict",
                "execution_engine": "fdm_cpu_reference",
                "precision": "double",
            },
            "values": values.tolist(),
        }
        (fields_dir / f"step_{step:06}.json").write_text(
            json.dumps(payload, indent=2),
            encoding="utf-8",
        )


class TestStnoArtifactReport(unittest.TestCase):
    def test_snapshot_coordinates_prefer_resolved_origin_m(self) -> None:
        payload = {
            "layout": {
                "backend": "fdm",
                "grid_cells": [1, 1, 1],
                "cell_size": [2.0, 3.0, 4.0],
                "origin_m": [10.0, 20.0, 30.0],
                "origin": [-1.0, -1.0, -1.0],
            }
        }
        x, y, z = _snapshot_coordinates(payload)
        np.testing.assert_allclose([x[0], y[0], z[0]], [11.0, 21.5, 32.0])

    def test_analyze_realistic_artifact_bundle(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_dir = Path(tmp)
            f_hz = 500e6
            orbit_radius_m = 12e-9
            t = np.arange(0.0, 40e-9, 20e-12)
            ramp = np.clip(t / 10e-9, 0.0, 1.0)
            mx = ramp * np.cos(2.0 * np.pi * f_hz * t)
            my = 0.9 * ramp * np.sin(2.0 * np.pi * f_hz * t)
            mz = 0.85 + 0.02 * ramp * np.cos(2.0 * np.pi * f_hz * t)

            _write_scalars_csv(artifact_dir / "scalars.csv", t, mx, my, mz)
            _write_vortex_snapshots(artifact_dir, f_hz=f_hz, orbit_radius_m=orbit_radius_m)

            report = analyze_stno_artifacts(
                artifact_dir,
                discard_transient_s=5e-9,
            )

            self.assertAlmostEqual(report.spectrum.peak_frequency_hz, f_hz, delta=30e6)
            self.assertGreater(report.steady_state.score, 0.6)
            self.assertGreater(report.steady_state.start_time_s, 5e-9)
            self.assertIsNotNone(report.orbit)
            assert report.orbit is not None
            self.assertAlmostEqual(report.orbit.mean_radius_m, orbit_radius_m, delta=3e-9)
            self.assertGreater(report.orbit.sample_count, 10)

    def test_write_report_outputs_json_and_markdown(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            artifact_dir = Path(tmp)
            f_hz = 350e6
            t = np.arange(0.0, 20e-9, 20e-12)
            mx = np.sin(2.0 * np.pi * f_hz * t)
            my = np.cos(2.0 * np.pi * f_hz * t)
            mz = np.full_like(t, 0.9)
            _write_scalars_csv(artifact_dir / "scalars.csv", t, mx, my, mz)

            json_path, markdown_path = write_stno_report(artifact_dir)

            self.assertTrue(json_path.is_file())
            self.assertTrue(markdown_path.is_file())
            payload = json.loads(json_path.read_text(encoding="utf-8"))
            self.assertIn("spectrum", payload)
            self.assertIn("steady_state", payload)
            markdown = markdown_path.read_text(encoding="utf-8")
            self.assertIn("Peak frequency", markdown)


if __name__ == "__main__":
    unittest.main()
