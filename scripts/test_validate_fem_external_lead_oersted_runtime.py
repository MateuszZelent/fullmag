#!/usr/bin/env python3
"""Focused tests for the public FEM external-lead runtime validator."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
VALIDATOR = REPO_ROOT / "scripts" / "validate_fem_external_lead_oersted_runtime.py"


def load_validator():
    spec = importlib.util.spec_from_file_location("validate_external_lead", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def write_fixture(root: Path) -> Path:
    artifact_dir = root / "artifacts"
    transport_dir = artifact_dir / "transport"
    transport_dir.mkdir(parents=True, exist_ok=True)
    initial = [[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]]
    final = [[0.0, 1.0e-6, 0.9999999999995], [0.0, 2.0e-6, 0.999999999998]]
    (artifact_dir / "m_initial.json").write_text(
        json.dumps({"values": initial}), encoding="utf-8"
    )
    (artifact_dir / "m_final.json").write_text(
        json.dumps(
            {
                "values": final,
                "provenance": {
                    "execution_engine": "fem_cpu_native",
                    "execution_mode": "strict",
                    "precision": "double",
                },
            }
        ),
        encoding="utf-8",
    )
    (artifact_dir / "metadata.json").write_text(
        json.dumps(
            {
                "requested_execution": {
                    "backend": "fem",
                    "device": "cpu",
                    "precision": "double",
                    "mode": "strict",
                    "fallback_policy": "forbidden",
                },
                "execution_provenance": {
                    "execution_engine": "fem_cpu_native",
                    "precision": "double",
                    "lossy_fallback_used": False,
                },
                "execution_plan": {
                    "backend_plan": {
                        "spin_transport_plans": [
                            {
                                "fem_cpu_double": {
                                    "stage_coupling": "fem_stage_oersted_callback.v1",
                                    "conservative_current_view": {
                                        "closure": {"kind": "external_lead"}
                                    },
                                }
                            }
                        ]
                    }
                },
            }
        ),
        encoding="utf-8",
    )
    (transport_dir / "fem_stage_oersted_callback.v1.json").write_text(
        json.dumps(
            {
                "schema": "fem_stage_oersted_callback.v1",
                "policy": "fem_stage_oersted_callback.v1",
                "device_lane": "cpu_native",
                "begin_count": 3,
                "commit_count": 3,
                "rollback_count": 0,
                "evaluate_count": 6,
                "accepted_observation": {
                    "stage_identity": 6,
                    "evaluation_time_s": 3.0e-13,
                    "envelope_multiplier": 1.0,
                    "source_state_revision": 7,
                    "source_view_identity_digest": "sha256:" + "1" * 64,
                    "field_sha256": "sha256:" + "2" * 64,
                },
            }
        ),
        encoding="utf-8",
    )
    summary = {
        "status": "completed",
        "artifact_dir": str(artifact_dir),
        "backend": "fem",
        "mode": "strict",
        "precision": "double",
        "total_steps": 3,
        "final_time": 3.0e-13,
        "requested_execution": {
            "backend": "fem",
            "device": "cpu",
            "precision": "double",
            "mode": "strict",
            "fallback_policy": "forbidden",
        },
    }
    log = root / "runtime.log"
    log.write_text("runtime preamble\n" + json.dumps(summary) + "\n", encoding="utf-8")
    return log


class ExternalLeadRuntimeValidatorTests(unittest.TestCase):
    def test_accepts_complete_external_lead_callback_artifacts(self) -> None:
        validator = load_validator()
        with tempfile.TemporaryDirectory() as temporary_directory:
            summary = validator.validate_runtime_log(
                write_fixture(Path(temporary_directory))
            )
        self.assertEqual(summary["callback"]["commit_count"], 3)
        self.assertGreater(summary["magnetization_delta_l2"], 0.0)

    def test_rejects_missing_callback_and_unchanged_magnetization(self) -> None:
        validator = load_validator()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            log = write_fixture(root)
            artifact_dir = root / "artifacts"
            (artifact_dir / "transport/fem_stage_oersted_callback.v1.json").unlink()
            with self.assertRaisesRegex(ValueError, "callback artifact is missing"):
                validator.validate_runtime_log(log)

            write_fixture(root)
            initial = json.loads(
                (artifact_dir / "m_initial.json").read_text(encoding="utf-8")
            )
            (artifact_dir / "m_final.json").write_text(
                json.dumps(
                    {
                        "values": initial["values"],
                        "provenance": {
                            "execution_engine": "fem_cpu_native",
                            "execution_mode": "strict",
                            "precision": "double",
                        },
                    }
                ),
                encoding="utf-8",
            )
            with self.assertRaisesRegex(ValueError, "did not change magnetization"):
                validator.validate_runtime_log(log)

    def test_rejects_uncommitted_or_mismatched_execution(self) -> None:
        validator = load_validator()
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            log = write_fixture(root)
            artifact_dir = root / "artifacts"
            callback_path = artifact_dir / "transport/fem_stage_oersted_callback.v1.json"
            callback = json.loads(callback_path.read_text(encoding="utf-8"))
            callback["commit_count"] = 0
            callback_path.write_text(json.dumps(callback), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "no accepted callback commit"):
                validator.validate_runtime_log(log)

            write_fixture(root)
            metadata_path = artifact_dir / "metadata.json"
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            metadata["requested_execution"]["device"] = "gpu"
            metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "requested execution disagrees"):
                validator.validate_runtime_log(log)


if __name__ == "__main__":
    unittest.main()
