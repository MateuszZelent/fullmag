"""Source guard for exhaustive adaptive backend-plan admission."""

from __future__ import annotations

import re
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
RUNNER = ROOT / "crates/fullmag-runner/src/lib.rs"


def rust_block(source: str, marker: str) -> str:
    """Return the brace-delimited block following a Rust function or match."""

    start = source.index(marker)
    opening = source.index("{", start)
    depth = 1
    cursor = opening + 1
    while depth:
        depth += (source[cursor] == "{") - (source[cursor] == "}")
        cursor += 1
    return source[opening + 1 : cursor - 1]


class RunnerAdaptiveBackendPlanSourceTests(unittest.TestCase):
    def test_adaptive_admission_explicitly_rejects_every_non_eigen_lane(self):
        source = RUNNER.read_text(encoding="utf-8")
        function = rust_block(source, "fn validate_parallel_execution_workflow(")
        adaptive_match = rust_block(
            function,
            "fullmag_ir::ParallelExecutionModeIR::Adaptive => match &plan.backend_plan",
        )

        for variant in (
            "Fem(fem)",
            "FemEigen(fem)",
            "Fdm(_)",
            "FdmMultilayer(_)",
            "Fem(_)",
            "FemFrequencyResponse(_)",
            "AntennaExternalLeadInspection(_)",
        ):
            with self.subTest(variant=variant):
                self.assertIn(f"BackendPlanIR::{variant}", adaptive_match)

        antenna = adaptive_match.split(
            "BackendPlanIR::AntennaExternalLeadInspection(_)", 1
        )[1]
        self.assertIn(
            "return Err(antenna_plan_requires_dedicated_inspection());", antenna
        )
        self.assertNotRegex(
            antenna,
            r"=>\s*\{\s*Err\(antenna_plan_requires_dedicated_inspection\(\)\)",
        )
        self.assertNotIn("_ =>", adaptive_match)

    def test_adaptive_guard_is_the_runner_workflow_match(self):
        source = RUNNER.read_text(encoding="utf-8")
        self.assertEqual(
            len(re.findall(r"fn validate_parallel_execution_workflow\s*\(", source)),
            1,
        )
        function = rust_block(source, "fn validate_parallel_execution_workflow(")
        self.assertIn(
            "parallel_execution adaptive requires requested_backend='fem'",
            function,
        )
        self.assertIn(
            "parallel_execution adaptive requires runtime_selection.device='cpu'",
            function,
        )


if __name__ == "__main__":
    unittest.main()
