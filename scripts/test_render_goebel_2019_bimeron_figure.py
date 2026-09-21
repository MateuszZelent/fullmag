from __future__ import annotations

import hashlib
import importlib.util
import json
import struct
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("render_goebel_2019_bimeron_figure.py")


def _load_renderer():
    spec = importlib.util.spec_from_file_location("goebel_figure", SCRIPT)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot import {SCRIPT}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _state(
    nx: int, ny: int, core_offset: int, *, time_s: float = 0.0
) -> dict[str, object]:
    values: list[list[float]] = []
    for y_index in range(ny):
        for x_index in range(nx):
            dx = x_index - nx // 2
            dy = y_index - ny // 2
            plus = max(0.0, 1.0 - ((dx - core_offset) ** 2 + dy**2) / 9.0)
            minus = max(0.0, 1.0 - ((dx + core_offset) ** 2 + dy**2) / 9.0)
            mz = plus - minus
            values.append([max(0.0, 1.0 - abs(mz)), 0.15 * mz, mz])
    return {
        "time": time_s,
        "layout": {
            "grid_cells": [nx, ny, 1],
            "cell_size": [0.5e-9, 0.5e-9, 0.5e-9],
            "origin_m": [-0.5 * nx * 0.5e-9, -0.5 * ny * 0.5e-9, 0.0],
        },
        "values": values,
    }


class GoebelFigureRendererTests(unittest.TestCase):
    def test_renders_reproducible_public_png_from_bundle_and_report(self) -> None:
        renderer = _load_renderer()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            bundle = root / "scenario.zarr"
            relax = bundle / "stages" / "stage_00_flat_relax"
            hold = bundle / "stages" / "stage_02_flat_run"
            relax.mkdir(parents=True)
            hold.mkdir(parents=True)
            state_paths = {
                "initial": relax / "m_initial.json",
                "relaxed": relax / "m_final.json",
                "held": hold / "m_final.json",
            }
            state_paths["initial"].write_text(
                json.dumps(_state(48, 24, 7, time_s=5e-12)), encoding="utf-8"
            )
            state_paths["relaxed"].write_text(
                json.dumps(_state(48, 24, 5, time_s=30e-12)), encoding="utf-8"
            )
            state_paths["held"].write_text(
                json.dumps(_state(48, 24, 3, time_s=140e-12)), encoding="utf-8"
            )

            report = {
                "schema_version": "goebel-bimeron-verification.v1",
                "status": "passed",
                "check_count": 19,
                "initial": {"topological_charge": -0.99, "core_separation_m": 7e-9},
                "relaxed": {"topological_charge": -0.98, "core_separation_m": 5e-9},
                "held": {
                    "topological_charge": -0.999,
                    "core_separation_m": 3e-9,
                    "mean_mx": 0.98,
                },
                "initial_energy_j": -7.7e-18,
                "relaxed_energy_j": -8.0e-18,
                "held_energy_j": -8.1e-18,
                "execution": {
                    "engine": "cuda_fdm",
                    "device": "Synthetic GPU",
                    "precision": "double",
                    "fallback_count": 0,
                    "required_operator_mask": 159,
                    "executed_device_operator_mask": 159,
                },
                "checks": {
                    name: True for name in renderer.VERIFICATION_CHECK_NAMES
                },
                "verified_state_sha256": {
                    key: hashlib.sha256(path.read_bytes()).hexdigest()
                    for key, path in state_paths.items()
                },
            }
            report_path = root / "verification.json"
            report_path.write_text(json.dumps(report), encoding="utf-8")
            output = root / "figure.png"

            renderer.render_figure(bundle, report_path, output)

            data = output.read_bytes()
            self.assertTrue(data.startswith(b"\x89PNG\r\n\x1a\n"))
            width, height = struct.unpack(">II", data[16:24])
            self.assertGreaterEqual(width, 2400)
            self.assertGreaterEqual(height, 1400)
            self.assertGreater(len(data), 100_000)

    def test_figure_labels_and_footer_durations_use_state_times(self) -> None:
        renderer = _load_renderer()
        states = [
            {"time_s": 5e-12},
            {"time_s": 30e-12},
            {"time_s": 140e-12},
        ]

        self.assertEqual(
            renderer._state_titles(states),
            ("Initial state · 5 ps", "Relaxed · 30 ps", "Held · 140 ps"),
        )
        self.assertEqual(renderer._stage_duration_ps(states[0], states[1]), "25")
        self.assertEqual(renderer._stage_duration_ps(states[1], states[2]), "110")

    def test_rejects_failed_verification_report(self) -> None:
        renderer = _load_renderer()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report_path = root / "verification.json"
            report_path.write_text(
                json.dumps(
                    {
                        "schema_version": renderer.VERIFICATION_SCHEMA_VERSION,
                        "status": "failed",
                        "check_count": 19,
                        "checks": {name: True for name in renderer.VERIFICATION_CHECK_NAMES},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "passed verification report"):
                renderer.render_figure(root / "missing.zarr", report_path, root / "figure.png")

    def test_rejects_reports_with_wrong_schema_or_check_set(self) -> None:
        renderer = _load_renderer()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report_path = root / "verification.json"
            report_path.write_text(
                json.dumps(
                    {
                        "schema_version": "goebel-bimeron-verification.v0",
                        "status": "passed",
                        "check_count": 19,
                        "checks": {name: True for name in renderer.VERIFICATION_CHECK_NAMES},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "schema"):
                renderer.render_figure(root / "missing.zarr", report_path, root / "figure.png")

            report_path.write_text(
                json.dumps(
                    {
                        "schema_version": renderer.VERIFICATION_SCHEMA_VERSION,
                        "status": "passed",
                        "check_count": 19,
                        "checks": {"unexpected": True},
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "check set"):
                renderer.render_figure(root / "missing.zarr", report_path, root / "figure.png")


if __name__ == "__main__":
    unittest.main()
