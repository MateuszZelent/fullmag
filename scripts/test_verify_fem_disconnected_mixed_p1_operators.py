#!/usr/bin/env python3
"""Lightweight contract tests for the disconnected mixed-P1 verifier.

These tests exercise fail-closed parsing and artifact binding only.  They do
not manufacture a physics receipt and do not replace a managed CPU/GPU run.
"""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest


_MODULE_PATH = Path(__file__).with_name("verify_fem_disconnected_mixed_p1_operators.py")
_SPEC = importlib.util.spec_from_file_location("mixed_p1_operator_verifier", _MODULE_PATH)
if _SPEC is None or _SPEC.loader is None:  # pragma: no cover - import setup failure
    raise RuntimeError(f"cannot load verifier module from {_MODULE_PATH}")
_VERIFIER = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_VERIFIER)


class MixedP1VerifierContractTests(unittest.TestCase):
    def test_missing_runtime_metadata_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "fem_disconnected_mixed_p1_operator_probe.py"
            source.write_text("# source identity for parser test\n", encoding="utf-8")
            artifacts = root / "artifacts"
            artifacts.mkdir()

            with self.assertRaisesRegex(_VERIFIER.ContractError, "runtime metadata"):
                _VERIFIER.validate_artifacts(source, artifacts, device="gpu")

    def test_missing_typed_mesh_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(_VERIFIER.ContractError, "backend_plan.mesh"):
                _VERIFIER._mesh_payload({
                    "execution_plan": {
                        "backend_plan": {"kind": "fem"},
                    }
                })

    def test_artifact_paths_cannot_escape_root(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(_VERIFIER.ContractError, "relative path inside"):
                _VERIFIER._safe_relative(root, "../outside.json", "artifact_path")

    def test_tet_and_prism_quadrature_is_independent(self) -> None:
        nodes = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
            [1.0, 0.0, 1.0],
            [0.0, 1.0, 1.0],
        ]
        self.assertAlmostEqual(_VERIFIER._cell_volume(nodes, "tet4", [0, 1, 2, 3]), 1.0 / 6.0)
        self.assertAlmostEqual(_VERIFIER._cell_volume(nodes, "prism6", [0, 1, 2, 3, 4, 5]), 0.5)

    def test_zarr_reader_decodes_component_major_payload(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            store = root / "fields" / "H_ex.zarr"
            store.mkdir(parents=True)
            source_hash = "sha256:" + "1" * 64
            (store / ".zattrs").write_text(
                json.dumps(
                    {
                        "observable": "H_ex",
                        "unit": "A/m",
                        "axes": ["sample", "component", "cell"],
                        "component_order": ["x", "y", "z"],
                        "provenance": {
                            "problem_name": _VERIFIER.EXPECTED_PROBLEM_NAME,
                            "source_hash": source_hash,
                            "execution_engine": "fem_cpu_native",
                            "precision": "double",
                        },
                    }
                ),
                encoding="utf-8",
            )
            (store / ".zarray").write_text(
                json.dumps(
                    {
                        "zarr_format": 2,
                        "shape": [1, 3, 2],
                        "dtype": "<f8",
                        "compressor": None,
                        "order": "C",
                        "dimension_separator": ".",
                    }
                ),
                encoding="utf-8",
            )
            (store / "samples.csv").write_text(
                "sample,step,time,solver_dt,chunk_key,dtype,scalar_bytes,cell_count\n"
                "0,0,0.0,0.0,0.0.0,<f8,8,2\n",
                encoding="utf-8",
            )
            # Writer order is x0,x1,y0,y1,z0,z1, not x0,y0,z0,x1,y1,z1.
            (store / "0.0.0").write_bytes(
                struct.pack("<6d", 1.0, 2.0, 10.0, 20.0, 100.0, 200.0)
            )
            vectors, _ = _VERIFIER._read_zarr_step0(
                root,
                "H_ex",
                source_hash,
                "fem_cpu_native",
                2,
            )
            self.assertEqual(vectors, [(1.0, 10.0, 100.0), (2.0, 20.0, 200.0)])


if __name__ == "__main__":
    unittest.main()
