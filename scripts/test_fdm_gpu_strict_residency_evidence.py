from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("fdm_gpu_strict_residency_evidence.py")


class EvidencePublicationTests(unittest.TestCase):
    @staticmethod
    def complete_candidate() -> dict[str, object]:
        return {
            "schema_version": "fdm_gpu_execution_receipt_evidence.v2",
            "validation_state": "validated",
            "runtime_check": "passed",
            "source_commit": "a" * 40,
            "source_diff_sha256": "b" * 64,
            "requested": "gpu",
            "resolved": "device_resident",
            "executed": "cuda_fdm",
            "device_ordinal": 0,
            "precision": "double",
            "integrator": "heun",
            "required_operator_mask": 35,
            "resolved_device_operator_mask": 35,
            "resolved_host_operator_mask": 0,
            "resolved_unknown_operator_mask": 0,
            "executed_device_operator_mask": 35,
            "executed_host_operator_mask": 0,
            "executed_unknown_operator_mask": 0,
            "fallback_count": 0,
            "accounting_valid": True,
            "transfer_counts": {
                "setup_full_vector_h2d_count": 1,
                "setup_full_vector_h2d_bytes": 24,
                "setup_full_vector_d2h_count": 0,
                "setup_full_vector_d2h_bytes": 0,
                "hot_loop_full_vector_h2d_count": 0,
                "hot_loop_full_vector_h2d_bytes": 0,
                "hot_loop_full_vector_d2h_count": 0,
                "hot_loop_full_vector_d2h_bytes": 0,
                "hot_loop_host_compute_count": 0,
                "hot_loop_host_sync_count": 1,
                "hot_loop_control_scalar_d2h_bytes": 8,
                "hot_loop_control_scalar_host_sync_count": 1,
                "observation_full_vector_h2d_count": 0,
                "observation_full_vector_h2d_bytes": 0,
                "observation_full_vector_d2h_count": 0,
                "observation_full_vector_d2h_bytes": 0,
            },
        }

    def run_script(self, *args: object) -> None:
        subprocess.run(
            [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
            check=True,
        )

    def test_candidate_is_never_the_final_evidence_before_publish(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "execution-receipt.v2.json"
            candidate = root / "candidate.json"
            self.run_script("init", "--final", final, "--candidate", candidate)
            candidate.write_text(json.dumps(self.complete_candidate()), encoding="utf-8")

            # Simulate a CTest/Rust gate failing after the native fixture wrote
            # its candidate: publish is deliberately never invoked.
            payload = json.loads(final.read_text(encoding="utf-8"))
            self.assertEqual(payload["validation_state"], "unvalidated")
            self.assertEqual(payload["runtime_check"], "unavailable")
            self.assertNotEqual(final.read_bytes(), candidate.read_bytes())

    def test_publish_atomically_replaces_final_only_for_validated_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "execution-receipt.v2.json"
            candidate = root / "candidate.json"
            self.run_script("init", "--final", final, "--candidate", candidate)
            candidate.write_text(json.dumps(self.complete_candidate()), encoding="utf-8")
            self.run_script("publish", "--final", final, "--candidate", candidate)
            payload = json.loads(final.read_text(encoding="utf-8"))
            self.assertEqual(payload["validation_state"], "validated")
            self.assertFalse(candidate.exists())

    def test_publish_rejects_incomplete_stale_and_contradictory_candidates(self) -> None:
        mutations = {
            "minimal": {
                "schema_version": "fdm_gpu_execution_receipt_evidence.v2",
                "validation_state": "validated",
                "runtime_check": "passed",
            },
            "stale_schema": {**self.complete_candidate(), "schema_version": "stale.v0"},
            "invalid_source_commit": {
                **self.complete_candidate(),
                "source_commit": "a010f27d8",
            },
            "invalid_source_diff": {
                **self.complete_candidate(),
                "source_diff_sha256": "unknown",
            },
            "unknown_resolved": {
                **self.complete_candidate(),
                "resolved_unknown_operator_mask": 1,
            },
            "unknown_executed": {
                **self.complete_candidate(),
                "executed_unknown_operator_mask": 1,
            },
            "host_execution": {
                **self.complete_candidate(),
                "executed_host_operator_mask": 1,
            },
            "missing_execution": {
                **self.complete_candidate(),
                "executed_device_operator_mask": 33,
            },
            "fallback": {**self.complete_candidate(), "fallback_count": 1},
            "invalid_accounting": {**self.complete_candidate(), "accounting_valid": False},
            "hot_loop_transfer": {
                **self.complete_candidate(),
                "transfer_counts": {
                    **self.complete_candidate()["transfer_counts"],
                    "hot_loop_full_vector_d2h_count": 1,
                    "hot_loop_full_vector_d2h_bytes": 24,
                },
            },
            "unclassified_sync": {
                **self.complete_candidate(),
                "transfer_counts": {
                    **self.complete_candidate()["transfer_counts"],
                    "hot_loop_host_sync_count": 2,
                },
            },
        }
        for name, document in mutations.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                final = root / "execution-receipt.v2.json"
                candidate = root / "candidate.json"
                self.run_script("init", "--final", final, "--candidate", candidate)
                before = final.read_bytes()
                candidate.write_text(json.dumps(document), encoding="utf-8")
                result = subprocess.run(
                    [
                        sys.executable,
                        str(SCRIPT),
                        "publish",
                        "--final",
                        str(final),
                        "--candidate",
                        str(candidate),
                    ],
                    check=False,
                    capture_output=True,
                    text=True,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(final.read_bytes(), before)
                self.assertTrue(candidate.exists())


if __name__ == "__main__":
    unittest.main()
