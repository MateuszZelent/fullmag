from __future__ import annotations

import hashlib
import unittest

from scripts.build_frozen_spins_fdm_multilayer_evidence import (
    EvidenceError,
    PLANNER_TEST,
    REQUIRED_TESTS,
    build_evidence,
)


class BuildFdmMultilayerEvidenceTests(unittest.TestCase):
    def _log(self) -> bytes:
        lines = [f"test {name} ... ok" for name in sorted(REQUIRED_TESTS)]
        lines.append(f"test {PLANNER_TEST} ... ok")
        lines.append("test result: ok. 29 passed; 0 failed; 0 ignored;")
        lines.append("test result: ok. 1 passed; 0 failed; 0 ignored;")
        return ("\n".join(lines) + "\n").encode()

    def test_builds_pass_evidence_with_log_digest(self) -> None:
        log = self._log()
        evidence = build_evidence(log)
        self.assertEqual(evidence["status"], "PASS")
        self.assertEqual(evidence["implementation_status"], "RUNTIME_CONFIRMED")
        self.assertEqual(evidence["qualification_status"], "UNQUALIFIED")
        self.assertEqual(evidence["artifact"]["sha256"], hashlib.sha256(log).hexdigest())

    def test_rejects_missing_planner_or_runtime_test(self) -> None:
        log = self._log().decode().replace(f"test {PLANNER_TEST} ... ok\n", "")
        with self.assertRaisesRegex(EvidenceError, "missing passing multilayer tests"):
            build_evidence(log.encode())


if __name__ == "__main__":
    unittest.main()
