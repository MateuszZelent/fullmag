"""Source-only contract checks for exact final native diagnostics wiring."""

from __future__ import annotations

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
DOMAIN = ROOT / "crates/fullmag-runner/src/fem/eigen_nonshared_domain.rs"
WINDOW = ROOT / "crates/fullmag-runner/src/fem/eigen_native_window.rs"
ARTIFACTS = ROOT / "crates/fullmag-runner/src/fem/eigen_native_artifacts.rs"


class NonSharedNativeInputDiagnosticsSourceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.domain = DOMAIN.read_text(encoding="utf-8")
        cls.window = WINDOW.read_text(encoding="utf-8")
        cls.artifacts = ARTIFACTS.read_text(encoding="utf-8")

    def test_finalizer_is_additive_and_keeps_historical_digest_namespace(self) -> None:
        self.assertIn(
            'shared_domain_content_digest("nonshared_operator_diagnostics", operator_diagnostics)',
            self.domain,
        )
        self.assertIn(
            'operator_diagnostics.get("schema_version")',
            self.domain,
        )
        self.assertIn(
            '"operator_diagnostics_schema".to_string()',
            self.domain,
        )
        self.assertIn(
            '"operator_diagnostics_sha256".to_string()',
            self.domain,
        )
        self.assertIn("finalize_native_input_diagnostics", self.domain)
        self.assertIn("operator_diagnostics_sha256", self.domain)
        self.assertIn("exact_replay_refs", self.domain)
        self.assertIn("native_input_diagnostics_refs: Option<Value>", self.domain)
        self.assertIn("native_input_diagnostics_exact_refs", self.domain)

    def test_both_cabi_paths_finalize_before_passing_the_same_string(self) -> None:
        self.assertEqual(
            self.window.count("provenance.finalize_native_input_diagnostics("),
            2,
        )
        for marker in (
            "operator_diagnostics_json.as_str()",
            "solve_native_modal_eigen",
            "native_input_operator_diagnostics.v1.json",
            "native_input_operator_diagnostics_preimage.v1.json",
        ):
            self.assertIn(marker, self.domain + self.window)
        for call_marker in (
            "operator_diagnostics_json = if let Some(provenance)",
            "operator_diagnostics_json: Some(operator_diagnostics_json.as_str())",
        ):
            self.assertIn(call_marker, self.window)

    def test_complex_provenance_digest_uses_the_actual_cabi_base_object(self) -> None:
        self.assertIn(
            "let diagnostics = complex_bloch_floquet_operator_diagnostics();",
            self.window,
        )
        self.assertIn(
            "let mut operator_diagnostics_value = complex_bloch_floquet_operator_diagnostics();",
            self.window,
        )
        self.assertIn('"stiffness_units": "rad_s_inv"', self.window)
        self.assertIn('"gyrotropic_form": "pencil_B=-G=[[0,-M],[M,0]]"', self.window)

    def test_raw_final_and_preimage_bytes_are_published_as_sidecars(self) -> None:
        self.assertIn("serde_json::to_vec(&*operator_diagnostics)", self.domain)
        self.assertIn("raw_sha256(&final_bytes)", self.domain)
        self.assertIn("raw_sha256(&preimage_bytes)", self.domain)
        self.assertIn("self.sidecars.extend([", self.domain)
        self.assertIn("for sidecar in &provenance.sidecars", self.artifacts)

    def test_nonshared_structural_manifest_remains_separate(self) -> None:
        self.assertNotIn("native_input_operator_diagnostics.v1.json", self.artifacts)
        self.assertNotIn("native_input_operator_diagnostics_preimage.v1.json", self.artifacts)


if __name__ == "__main__":
    unittest.main()
