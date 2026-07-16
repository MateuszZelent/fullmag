#!/usr/bin/env python3
"""Focused tests for the FEM-TD-OBS-003 durable artifact validator."""

from __future__ import annotations

import csv
import hashlib
import json
import struct
import tempfile
import unittest
from pathlib import Path

from validate_fem_oersted_observable_artifacts import validate_runs


class OerstedObservableArtifactValidatorTests(unittest.TestCase):
    def _write_run(self, root: Path, *, device: str, current: float, mismatch: bool = False) -> Path:
        artifact_dir = root / f"{device}-{current}" / "artifacts"
        fields = artifact_dir / "fields"
        fields.mkdir(parents=True)
        time = "2.273736754430000e-13"
        step = "8"
        h_oe = [2.0 * current, -current, 0.5 * current, 3.0 * current]
        h_eff = [10.0 + value for value in h_oe]
        if mismatch:
            h_eff[1] += 1.0e-3
        for name, values in (("H_oe", h_oe), ("H_eff", h_eff)):
            field_dir = fields / f"{name}.zarr"
            field_dir.mkdir()
            (field_dir / ".zattrs").write_text(
                json.dumps({"observable": name, "unit": "A/m", "provenance": {"execution_engine": "fem_cpu_native" if device == "cpu" else "fem_native_gpu"}}),
                encoding="utf-8",
            )
            (field_dir / ".zarray").write_text(
                json.dumps({"shape": [1, 1, 4], "dtype": "<f8"}), encoding="utf-8"
            )
            with (field_dir / "samples.csv").open("w", newline="", encoding="utf-8") as handle:
                writer = csv.DictWriter(handle, fieldnames=("sample", "step", "time", "solver_dt", "chunk_key", "dtype", "scalar_bytes", "cell_count"))
                writer.writeheader()
                writer.writerow({"sample": "0", "step": step, "time": time, "solver_dt": "2.842170943020001e-14", "chunk_key": "0.0.0", "dtype": "<f8", "scalar_bytes": "8", "cell_count": "4"})
            (field_dir / "0.0.0").write_bytes(struct.pack("<4d", *values))
        metadata = {"execution_provenance": {"execution_engine": "fem_cpu_native" if device == "cpu" else "fem_native_gpu", "lossy_fallback_used": False}}
        (artifact_dir / "metadata.json").write_text(json.dumps(metadata), encoding="utf-8")
        result = {"artifact_dir": str(artifact_dir), "status": "completed", "backend": "fem", "mode": "strict", "precision": "double", "total_steps": 8, "final_time": float(time), "requested_execution": {"backend": "fem", "device": device}}
        log = root / f"{device}-{current}.log"
        log.write_text(json.dumps(result), encoding="utf-8")
        return log

    def test_accepts_same_accepted_sample_and_realized_decomposition(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            summary = validate_runs(
                cpu_driven=self._write_run(root, device="cpu", current=1.0),
                cpu_zero=self._write_run(root, device="cpu", current=0.0),
                gpu_driven=self._write_run(root, device="gpu", current=1.0),
                gpu_zero=self._write_run(root, device="gpu", current=0.0),
            )
        self.assertEqual(summary["status"], "pass")
        self.assertEqual(summary["lanes"]["cpu"]["tolerance"], 1.0e-12)
        self.assertEqual(summary["lanes"]["gpu"]["tolerance"], 1.0e-10)
        self.assertEqual(len(summary["lanes"]["cpu"]["artifact_refs"]), 8)

    def test_rejects_non_oersted_effective_field_delta(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
        with self.assertRaisesRegex(ValueError, r"H_eff\(driven\)-H_eff\(zero\)"):
                validate_runs(
                    cpu_driven=self._write_run(root, device="cpu", current=1.0, mismatch=True),
                    cpu_zero=self._write_run(root, device="cpu", current=0.0),
                    gpu_driven=self._write_run(root, device="gpu", current=1.0),
                    gpu_zero=self._write_run(root, device="gpu", current=0.0),
                )


if __name__ == "__main__":
    unittest.main()
