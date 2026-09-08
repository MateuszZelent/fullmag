from __future__ import annotations

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


def _state(nx: int, ny: int, core_offset: int) -> dict[str, object]:
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
        "time": 0.0,
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
            (relax / "m_initial.json").write_text(json.dumps(_state(48, 24, 7)), encoding="utf-8")
            (relax / "m_final.json").write_text(json.dumps(_state(48, 24, 5)), encoding="utf-8")
            (hold / "m_final.json").write_text(json.dumps(_state(48, 24, 3)), encoding="utf-8")

            report = {
                "status": "passed",
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
                "checks": {f"check_{index}": True for index in range(15)},
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

    def test_rejects_failed_verification_report(self) -> None:
        renderer = _load_renderer()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            report_path = root / "verification.json"
            report_path.write_text(json.dumps({"status": "failed"}), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "passed verification report"):
                renderer.render_figure(root / "missing.zarr", report_path, root / "figure.png")


if __name__ == "__main__":
    unittest.main()
