"""Source contracts, independent SI algebra and artifact validation for modal gamma.

Rust/native fixtures are not executed by these checks.
"""
import math
from pathlib import Path
import re
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from verify_fem_frequency_domain_eigen_artifacts import validate_mode_gamma_matches_constants

MU0 = 4 * math.pi * 1e-7


def code(path):
    return re.sub(r"//[^\n]*|/\*.*?\*/", "", (ROOT / path).read_text(encoding="utf-8"), flags=re.S)


class ModalGammaProvenanceTests(unittest.TestCase):
    def test_actual_plan_parameter_is_required_on_the_common_result(self):
        types = code("crates/fullmag-runner/src/eigen/types.rs")
        result = types[types.index("pub struct PathSolveResult {"):]
        self.assertIn("pub gamma0_rad_s_per_a_m: f64", result)
        owner = code("crates/fullmag-runner/src/eigen/orchestrator.rs")
        self.assertIn("gamma0_rad_s_per_a_m: plan.gyromagnetic_ratio", owner)

    def test_spectrum_and_fields_do_not_publish_reference_gamma(self):
        for path in ("modal_manifest.rs", "mode_bundle.rs"):
            source = code("crates/fullmag-runner/src/eigen/artifacts/" + path)
            self.assertIn("validated_modal_gamma0(result.gamma0_rad_s_per_a_m)?", source)
            self.assertIn("gamma_rad_s_t: gamma0_rad_s_per_a_m / crate::MU0", source)
            self.assertNotIn("REFERENCE_MODAL_GAMMA", source)
            self.assertNotIn("reference_modal_gamma", source)
        common = code("crates/fullmag-runner/src/eigen/artifacts/common.rs")
        self.assertRegex(common, r"#\[cfg\(test\)\]\s*pub\(super\) const REFERENCE_MODAL_GAMMA")
        self.assertIn("!gamma0_rad_s_per_a_m.is_finite()", common)
        self.assertIn("gamma0_rad_s_per_a_m <= 0.0", common)
        self.assertIn("!(gamma0_rad_s_per_a_m / crate::MU0).is_finite()", common)

    def test_kittel_oracle_and_physical_adapter_share_actual_gamma(self):
        oracle = code("crates/fullmag-runner/src/eigen/artifacts/kittel.rs")
        self.assertNotIn("REFERENCE_MODAL_GAMMA", oracle)
        self.assertIn("k0_kittel_expected_points(validation, result.gamma0_rad_s_per_a_m)?", oracle)
        self.assertIn("value: validated_modal_gamma0(result.gamma0_rad_s_per_a_m)?", oracle)
        sweep = code("crates/fullmag-runner/src/fem/eigen_sweep.rs")
        self.assertRegex(sweep, r"k0_kittel_validation_auxiliary_artifacts_from_bias_field_sweep\(\s*"
                               r"validation,\s*plan\.gyromagnetic_ratio,")
        self.assertIn("gamma0_rad_s_per_a_m,\n        samples: path_samples", oracle)

    def test_fem_publisher_validates_before_json_and_kittel_checks_overflow(self):
        owner = code("crates/fullmag-runner/src/fem/eigen_path.rs")
        self.assertIn("validated_modal_gamma0(plan.gyromagnetic_ratio)", owner)
        self.assertLess(owner.index("eigen_path_publication_gamma0(plan, &path_result)?"),
                        owner.index("let v2_samples:"))
        publisher = code("crates/fullmag-runner/src/fem/eigen_path_artifacts.rs")
        guard = publisher[publisher.index("fn eigen_path_publication_gamma0("):
                          publisher.index("fn eigen_path_mode_publication_json(")]
        self.assertIn("validated_modal_gamma0(value)", guard)
        self.assertIn("validate(result.gamma0_rad_s_per_a_m)?", guard)
        self.assertIn("validate(plan.gyromagnetic_ratio)?", guard)
        self.assertIn("gamma0 != plan_gamma0", guard)
        oracle = code("crates/fullmag-runner/src/eigen/artifacts/kittel.rs")
        self.assertIn("!frequency.is_finite() || frequency <= 0.0", oracle)

    def test_nonreference_gamma_preserves_h_and_b_kittel_units(self):
        ms, b = 8e5, .1
        for gamma0 in (1.7e5, 2.8e5):
            h = b / MU0
            gamma = gamma0 / MU0
            for normal_factor in (0., 1.):  # Larmor and thin-film in-plane
                f_h = gamma0 * math.sqrt(h * (h + normal_factor * ms)) / math.tau
                f_b = gamma * math.sqrt(b * (b + normal_factor * MU0 * ms)) / math.tau
                self.assertAlmostEqual(f_h / f_b, 1., places=14)
                reference = 2.211e5 * math.sqrt(h * (h + normal_factor * ms)) / math.tau
                self.assertAlmostEqual(f_h / reference, gamma0 / 2.211e5, places=14)

    def test_single_k_execution_and_native_publisher_share_guard(self):
        execution = code("crates/fullmag-runner/src/fem/eigen_execution.rs")
        execution = execution[execution.index("fn execute_fem_eigen_inner("):]
        native = code("crates/fullmag-runner/src/fem/eigen_native_artifacts.rs")
        native = native[native.index("fn native_modal_artifacts("):]
        for source in (execution, native):
            self.assertIn("validated_modal_gamma0(plan.gyromagnetic_ratio)", source)
            self.assertIn("let gamma_rad_s_t = gamma0_rad_s_per_a_m / MU0", source)
            self.assertLess(source.index("validated_modal_gamma0(plan.gyromagnetic_ratio)"),
                            source.index("let gamma_rad_s_t ="))
            self.assertNotIn("let gamma_rad_s_t = plan.gyromagnetic_ratio / MU0", source)

    def test_reader_rejects_coherent_but_wrong_material_gamma(self):
        constants = dict(gamma0_rad_s_per_A_m=1.7e5, gamma_rad_s_T=1.7e5/MU0, mu0_T_m_per_A=MU0)
        validate_mode_gamma_matches_constants(constants.copy(), constants, "mode")
        # The old reference fields obey gamma0=mu0*gamma but are not this execution's parameters.
        reference = dict(gamma0_rad_s_per_A_m=2.211e5, gamma_rad_s_T=2.211e5/MU0, mu0_T_m_per_A=MU0)
        with self.assertRaises(SystemExit):
            validate_mode_gamma_matches_constants(reference, constants, "mode")
        for invalid in (0., -1., float("nan"), float("inf")):
            broken = constants.copy()
            broken["gamma0_rad_s_per_A_m"] = invalid
            with self.subTest(invalid=invalid), self.assertRaises(SystemExit):
                validate_mode_gamma_matches_constants(broken, constants, "mode")


if __name__ == "__main__":
    unittest.main()
