"""Source contract checks for accepted relaxation to multi-k continuation.

The checks are intentionally independent of Cargo and the native FEM runtime.
They make the two source-marker phases explicit: the authored relaxation target
is validated before conversion, and the resulting ``Provided`` continuation is
validated again after conversion.  A bias-field sweep remains a separate
equilibrium problem and must not reuse this handoff.
"""

from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
CONTRACT = ROOT / "crates/fullmag-runner/src/fem/eigen_equilibrium_contract.rs"
PREPARATION = ROOT / "crates/fullmag-runner/src/fem/eigen_equilibrium.rs"
CERTIFICATE = ROOT / "crates/fullmag-runner/src/fem/eigen_shared_domain.rs"


class RelaxedProvidedContinuationContractTests(unittest.TestCase):
    def test_binding_has_separate_pre_and_post_conversion_validators(self) -> None:
        source = CONTRACT.read_text(encoding="utf-8")

        self.assertIn(
            "pub(super) fn validate_target_plan(&self, plan: &FemEigenPlanIR)",
            source,
        )
        self.assertIn(
            "self.validate_plan_binding(plan, false)",
            source,
        )
        self.assertIn(
            "pub(super) fn validate_provided_continuation_plan",
            source,
        )
        self.assertIn(
            "self.validate_plan_binding(plan, true)",
            source,
        )
        self.assertIn(
            "relax_stage_handoff_requires_relaxed_initial_state_target",
            source,
        )
        self.assertIn(
            "relax_stage_handoff_requires_provided_equilibrium_continuation_target",
            source,
        )
        self.assertIn(
            "relax_stage_handoff_provided_continuation_rejects_bias_field_sweep",
            source,
        )

        # The post-conversion branch must not silently fall through to the
        # pre-conversion source marker or permit a sweep by omission.
        provided_branch = source.split("if provided_continuation", 1)[1].split(
            "} else {", 1
        )[0]
        self.assertIn("EquilibriumSourceIR::Provided", provided_branch)
        self.assertIn("!plan.bias_field_samples.is_empty()", provided_branch)

    def test_conversion_revalidates_the_resulting_provided_plan(self) -> None:
        source = PREPARATION.read_text(encoding="utf-8")
        conversion = source.split(
            "pub(super) fn prepare_single_k_stage_continuation", 1
        )[1].split("\n}", 1)[0]
        provided_assignment = conversion.index("prepared.equilibrium = EquilibriumSourceIR::Provided")
        revalidation = conversion.index(
            "handoff.validate_provided_continuation_plan(&prepared)"
        )
        self.assertLess(
            provided_assignment,
            revalidation,
            "the converted source marker must be checked by the post-conversion validator",
        )

    def test_shared_certificate_validator_checks_source_handoff_after_marker_change(self) -> None:
        source = CERTIFICATE.read_text(encoding="utf-8")
        validator = source.split(
            "pub(super) fn validate_eigen_equilibrium_certificate", 1
        )[1].split("\n}\n\n/// Explicit validation-only", 1)[0]
        self.assertIn("if let Some(handoff) = source_relax_handoff", validator)
        self.assertIn("EquilibriumSourceIR::RelaxedInitialState", validator)
        self.assertIn("handoff.validate_target_plan(plan)?", validator)
        self.assertIn("EquilibriumSourceIR::Provided", validator)
        self.assertIn(
            "handoff.validate_provided_continuation_plan(plan)?",
            validator,
        )
        self.assertIn("relax_stage_handoff_requires_relaxed_or_provided_equilibrium_target", validator)


if __name__ == "__main__":
    unittest.main()
