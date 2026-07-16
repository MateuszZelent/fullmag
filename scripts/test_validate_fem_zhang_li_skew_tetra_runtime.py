#!/usr/bin/env python3
"""Unit tests for the Zhang-Li managed-runtime artifact validator."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_zhang_li_skew_tetra_runtime.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_fem_zhang_li", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_runtime_artifacts(artifact_dir: Path) -> None:
    artifact_dir.mkdir()
    (artifact_dir / "m_final.json").write_text(
        json.dumps(
            {
                "layout": {"mesh_source": str(REPO_ROOT / "examples/assets/zhang_li_skew_tetra_r0.mesh.json")},
                "provenance": {
                    "execution_engine": "fem_cpu_native",
                    "execution_mode": "strict",
                    "precision": "double",
                },
            }
        )
    )
    (artifact_dir / "metadata.json").write_text(
        json.dumps(
            {
                "execution_plan": {
                    "backend_plan": {
                        "precision": "double",
                        "integrator": "heun",
                        "fixed_timestep": 1.0e-15,
                        "material": {"saturation_magnetisation": 800000.0, "damping": 0.02},
                    }
                },
                "execution_provenance": {
                    "execution_engine": "fem_cpu_native",
                    "precision": "double",
                    "lossy_fallback_used": False,
                },
            }
        )
    )


class ZhangLiRuntimeProvenanceTests(unittest.TestCase):
    def test_rejects_forged_cli_requested_execution_without_matching_artifact_intent(self) -> None:
        validator = load_validator()
        with tempfile.TemporaryDirectory() as temporary_directory:
            artifact_dir = Path(temporary_directory) / "artifacts"
            write_runtime_artifacts(artifact_dir)
            result = {
                "artifact_dir": str(artifact_dir),
                "backend": "fem",
                "mode": "strict",
                "precision": "double",
                "requested_execution": {
                    "backend": "fem",
                    "device": "cpu",
                    "precision": "double",
                    "mode": "strict",
                    "fallback_policy": "forbidden",
                },
            }
            mesh = REPO_ROOT / "examples/assets/zhang_li_skew_tetra_r0.mesh.json"

            with self.assertRaisesRegex(ValueError, "artifact.*requested execution"):
                validator.check_runtime_provenance("cpu", result, "fem_cpu_native", mesh, "cpu")

            metadata_path = artifact_dir / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["requested_execution"] = {
                "backend": "fem",
                "device": "gpu",
                "precision": "double",
                "mode": "strict",
                "fallback_policy": "forbidden",
            }
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "requested execution.*disagrees"):
                validator.check_runtime_provenance("cpu", result, "fem_cpu_native", mesh, "cpu")


if __name__ == "__main__":
    unittest.main()
