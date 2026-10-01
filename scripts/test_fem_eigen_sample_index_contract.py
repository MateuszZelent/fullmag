"""Source-only regressions for modal sample identity and final-state forwarding.

These checks deliberately do not compile Rust or execute a native FEM solver.
The prepared Rust regression is inspected here so a future caller change cannot
silently restore the old hard-coded sample zero.
"""

from __future__ import annotations

import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
EXECUTION = ROOT / "crates/fullmag-runner/src/fem/eigen_execution.rs"
PATH = ROOT / "crates/fullmag-runner/src/fem/eigen_path.rs"
RUST_TESTS = ROOT / "crates/fullmag-runner/src/fem/eigen_tests.rs"


class FemEigenSampleIdentityContractTests(unittest.TestCase):
    def test_modal_bundle_caller_forwards_runtime_sample_index(self) -> None:
        source = EXECUTION.read_text(encoding="utf-8")
        call = re.search(
            r"write_eigen_v2_bundle\(\s*.*?\n\s*\)\?;",
            source,
            flags=re.DOTALL,
        )
        self.assertIsNotNone(call, "production modal bundle call is missing")
        body = call.group(0)
        self.assertRegex(body, r"\bartifact_sample_index,\s*\)\?;\s*$")
        self.assertNotRegex(body, r"\n\s*0,\s*\)\?;\s*$")

    def test_path_publishes_last_real_executed_magnetization(self) -> None:
        source = PATH.read_text(encoding="utf-8")
        executed = source.index("let executed = if bias_field_sweep_requested(plan)")
        recorded = source.index(
            "let final_magnetization = &executed.result.final_magnetization;",
            executed,
        )
        persisted = source.index(
            "*self.previous_accepted_magnetization.borrow_mut() =",
            recorded,
        )
        self.assertLess(executed, recorded)
        self.assertLess(recorded, persisted)
        self.assertIn(
            "let last_accepted_magnetization = adapter.previous_accepted_magnetization.into_inner();",
            source,
        )
        self.assertIn("last_accepted_magnetization.unwrap_or_else", source)
        self.assertIn("let final_magnetization = &executed.result.final_magnetization;", source)
        self.assertIn(
            "*self.previous_accepted_magnetization.borrow_mut() =",
            source,
        )

    def test_prepared_bundle_regression_exercises_sample_seven(self) -> None:
        source = RUST_TESTS.read_text(encoding="utf-8")
        marker = "fn native_eigen_v2_bundle_preserves_nonzero_sample_index"
        self.assertIn(marker, source)
        body = source.split(marker, 1)[1].split("\n#[test]", 1)[0]
        self.assertIn("write_eigen_v2_bundle", body)
        self.assertIn("        7,", body)
        self.assertIn('payload["samples"][0]["sample_index"]', body)
        self.assertIn('payload["samples"][0]["sample_id"]', body)


if __name__ == "__main__":
    unittest.main()
