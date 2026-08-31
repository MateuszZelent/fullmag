from __future__ import annotations

import unittest

from scripts.build_frozen_spins_fdm_cpu_scientific_evidence import (
    CHECKPOINT_TESTS,
    EvidenceError,
    REQUIRED_TESTS,
    SCIENTIFIC_TESTS,
    TEST_CASE_IDS,
    build_evidence,
)


def passing_log() -> bytes:
    lines = [
        f"test fdm_relaxation::{name} ... ok" for name in sorted(SCIENTIFIC_TESTS)
    ]
    lines.append(
        f"test result: ok. {len(SCIENTIFIC_TESTS)} passed; 0 failed; 0 ignored; 42 filtered out"
    )
    for name in sorted(CHECKPOINT_TESTS):
        lines.append(f"test {name} ... ok")
        lines.append("test result: ok. 1 passed; 0 failed; 0 ignored; 1048 filtered out")
    return ("\n".join(lines) + "\n").encode()


class FrozenSpinsFdmCpuScientificEvidenceTests(unittest.TestCase):
    def test_complete_log_builds_unqualified_runtime_evidence(self) -> None:
        evidence = build_evidence(passing_log())
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(evidence["implementation_status"], "RUNTIME_CONFIRMED")
        self.assertEqual(evidence["qualification_status"], "UNQUALIFIED")
        self.assertEqual(evidence["test_count"], 14)
        self.assertEqual(evidence["test_case_ids"], TEST_CASE_IDS)
        self.assertEqual(evidence["contracts"]["two_spin_exchange_independent_oracle"], "PASS")

    def test_missing_test_fails_closed(self) -> None:
        missing = sorted(SCIENTIFIC_TESTS)[0]
        log = passing_log().decode().replace(
            f"test fdm_relaxation::{missing} ... ok\n", ""
        )
        with self.assertRaisesRegex(EvidenceError, missing):
            build_evidence(log.encode())

    def test_incomplete_summary_fails_closed(self) -> None:
        log = passing_log().decode().replace("12 passed", "11 passed")
        with self.assertRaisesRegex(EvidenceError, "summary"):
            build_evidence(log.encode())

    def test_missing_checkpoint_summary_fails_closed(self) -> None:
        log = passing_log().decode().replace(
            "test result: ok. 1 passed; 0 failed; 0 ignored; 1048 filtered out\n",
            "",
            1,
        )
        with self.assertRaisesRegex(EvidenceError, "checkpoint"):
            build_evidence(log.encode())


if __name__ == "__main__":
    unittest.main()
