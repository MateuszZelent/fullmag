import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("fdm_gpu_strict_residency_evidence.py")


class EvidencePublicationTests(unittest.TestCase):
    def run_script(self, *args: object) -> None:
        subprocess.run(
            [sys.executable, str(SCRIPT), *(str(arg) for arg in args)],
            check=True,
        )

    def test_candidate_is_never_the_final_evidence_before_publish(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "execution-receipt.v1.json"
            candidate = root / "candidate.json"
            self.run_script("init", "--final", final, "--candidate", candidate)
            candidate.write_text(
                json.dumps(
                    {
                        "schema_version": "fdm_gpu_execution_receipt_evidence.v1",
                        "validation_state": "validated",
                        "runtime_check": "passed",
                    }
                ),
                encoding="utf-8",
            )

            # Simulate a CTest/Rust gate failing after the native fixture wrote
            # its candidate: publish is deliberately never invoked.
            payload = json.loads(final.read_text(encoding="utf-8"))
            self.assertEqual(payload["validation_state"], "unvalidated")
            self.assertEqual(payload["runtime_check"], "unavailable")
            self.assertNotEqual(final.read_bytes(), candidate.read_bytes())

    def test_publish_atomically_replaces_final_only_for_validated_candidate(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            final = root / "execution-receipt.v1.json"
            candidate = root / "candidate.json"
            self.run_script("init", "--final", final, "--candidate", candidate)
            candidate.write_text(
                json.dumps(
                    {
                        "schema_version": "fdm_gpu_execution_receipt_evidence.v1",
                        "validation_state": "validated",
                        "runtime_check": "passed",
                    }
                ),
                encoding="utf-8",
            )
            self.run_script("publish", "--final", final, "--candidate", candidate)
            payload = json.loads(final.read_text(encoding="utf-8"))
            self.assertEqual(payload["validation_state"], "validated")
            self.assertFalse(candidate.exists())


if __name__ == "__main__":
    unittest.main()
