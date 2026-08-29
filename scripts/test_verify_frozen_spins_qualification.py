from __future__ import annotations

import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "verify_frozen_spins_qualification.py"
SPEC = importlib.util.spec_from_file_location("verify_frozen_spins_qualification", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def scope_document() -> dict:
    return MODULE.load_scope(ROOT / "docs" / "validation" / "frozen-spins-v1-scope.yaml")


def make_receipt(directory: Path, evidence_id: str = "FS-EV-TEST-001") -> tuple[Path, dict]:
    artifact = directory / f"{evidence_id}.log"
    artifact.write_text("qualified runtime evidence\n", encoding="utf-8")
    artifact_sha = hashlib.sha256(artifact.read_bytes()).hexdigest()
    receipt = {
        "schema": MODULE.RECEIPT_SCHEMA,
        "status": "PASS",
        "timestamp_utc": "2026-08-29T12:00:00Z",
        "evidence_id": evidence_id,
        "source_snapshot_id": "sha256:source-snapshot",
        "source": {
            "git_sha": "a" * 40,
            "tree_sha": "b" * 40,
            "tracked_diff_sha256": "0" * 64,
            "staged_diff_sha256": "0" * 64,
            "untracked_manifest_sha256": "0" * 64,
            "git_dirty": False,
            "submodule_identities": {},
        },
        "runtime": {
            "recipe": "just verify-frozen-spins-test",
            "image_digest": "sha256:" + "c" * 64,
            "build_manifest": "sha256:" + "d" * 64,
        },
        "execution_evidence": {
            "cwd": "/workspace",
            "started_at_utc": "2026-08-29T11:59:00Z",
            "finished_at_utc": "2026-08-29T12:00:00Z",
            "exit_code": 0,
            "stdout_sha256": "1" * 64,
            "stderr_sha256": "2" * 64,
            "environment": {"FULLMAG_FDM_EXECUTION": "gpu"},
        },
        "hardware": {
            "device_type": "gpu",
            "device_name": "Test GPU",
            "driver": "999.1",
            "pci_bus_id": "0000:65:00.0",
        },
        "qualification_tuple": {
            "backend": "fdm",
            "execution": "gpu",
            "precision": "fp64",
            "mesh_mode": "single_grid",
            "algorithm": "rk4",
            "active_physics": ["exchange"],
            "membership_policy": "static",
            "reference_policy": "capture_current_at_activation",
        },
        "contract": {
            "membership_policy": "static",
            "reference_policy": "capture_current_at_activation",
            "constraint_activation_epochs": {"constraint-1": 1},
            "resolved_constraint_set_revision": 1,
            "fallback_used": False,
        },
        "results": {
            "frozen_max_ulp_drift": 0,
            "frozen_max_abs_drift": 0.0,
            "free_max_displacement": 1.0,
            "max_torque_free": 1.0,
            "max_torque_all": 1.0,
            "energy_finite": True,
            "fallback_count": 0,
            "host_transfer_bytes_per_step": 0,
            "checkpoint_continuity_error": 0.0,
            "oracle_result": "PASS",
            "test_case_ids": sorted(MODULE.required_test_case_ids(scope_document())),
        },
        "command": "just verify-frozen-spins-test",
        "binary_sha256": "e" * 64,
        "toolchain": "test-toolchain-1",
        "artifacts": [{"path": artifact.name, "sha256": artifact_sha}],
    }
    receipt["receipt_sha256"] = MODULE.receipt_payload_sha256(receipt)
    path = directory / f"{evidence_id}.json"
    path.write_text(json.dumps(receipt), encoding="utf-8")
    return path, receipt


def source_identity_for(receipt: dict) -> dict:
    return {
        "schema": MODULE.SOURCE_IDENTITY_SCHEMA,
        "source_snapshot_id": receipt["source_snapshot_id"],
        "source": receipt["source"],
    }


class FrozenSpinsQualificationAggregatorTests(unittest.TestCase):
    def test_valid_receipt_covering_scope_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path, receipt = make_receipt(Path(temp))
            errors, covered = MODULE.aggregate(
                scope_document(), [(path, receipt)], source_identity_for(receipt)
            )
            self.assertEqual(errors, [])
            self.assertEqual(covered, MODULE.required_test_case_ids(scope_document()))

    def test_missing_required_receipt_fails_closed(self) -> None:
        errors, covered = MODULE.aggregate(scope_document(), [])
        self.assertEqual(covered, set())
        self.assertTrue(any("no qualification receipts" in error for error in errors))
        self.assertTrue(any("missing required test case" in error for error in errors))

    def test_dirty_fallback_unknown_driver_skip_and_bad_artifact_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path, receipt = make_receipt(Path(temp))
            receipt["status"] = "SKIP"
            receipt["source"]["git_dirty"] = True
            receipt["contract"]["fallback_used"] = True
            receipt["hardware"]["driver"] = "unknown"
            receipt["artifacts"][0]["sha256"] = "f" * 64
            receipt["receipt_sha256"] = MODULE.receipt_payload_sha256(receipt)
            errors = MODULE.validate_receipt(receipt, path)
            for expected in ("status", "git_dirty", "fallback_used", "driver", "artifact content"):
                self.assertTrue(any(expected in error for error in errors), expected)

    def test_mixed_tree_and_duplicate_evidence_id_fail(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            first_path, first = make_receipt(directory)
            second_path, second = make_receipt(directory, evidence_id="FS-EV-TEST-002")
            second["evidence_id"] = first["evidence_id"]
            second["source"]["tree_sha"] = "f" * 40
            second["receipt_sha256"] = MODULE.receipt_payload_sha256(second)
            errors, _ = MODULE.aggregate(scope_document(), [(first_path, first), (second_path, second)])
            self.assertTrue(any("duplicate evidence_id" in error for error in errors))
            self.assertTrue(any("different source.tree_sha" in error for error in errors))

    def test_receipt_must_match_clean_captured_source_identity(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            path, receipt = make_receipt(Path(temp))
            expected = source_identity_for(receipt)
            expected["source"] = dict(expected["source"])
            expected["source"]["tree_sha"] = "f" * 40
            errors, _ = MODULE.aggregate(scope_document(), [(path, receipt)], expected)
            self.assertTrue(any("source object does not match" in error for error in errors))
            expected["source"]["git_dirty"] = True
            errors, _ = MODULE.aggregate(scope_document(), [(path, receipt)], expected)
            self.assertTrue(any("clean qualification tree" in error for error in errors))

    def test_evidence_ledger_is_append_only_and_idempotent(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            directory = Path(temp)
            path, receipt = make_receipt(directory)
            ledger = directory / "evidence-ledger.jsonl"
            self.assertEqual(MODULE.append_evidence_ledger(ledger, [(path, receipt)]), [])
            original = ledger.read_text(encoding="utf-8")
            self.assertEqual(MODULE.append_evidence_ledger(ledger, [(path, receipt)]), [])
            self.assertEqual(ledger.read_text(encoding="utf-8"), original)
            changed = dict(receipt)
            changed["command"] = "different command"
            errors = MODULE.append_evidence_ledger(ledger, [(path, changed)])
            self.assertTrue(any("immutable" in error for error in errors))
            self.assertEqual(ledger.read_text(encoding="utf-8"), original)


if __name__ == "__main__":
    unittest.main()
