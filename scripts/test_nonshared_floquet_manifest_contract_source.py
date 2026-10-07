"""Source-level checks for non-shared Floquet manifest sidecar families."""

from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "crates/fullmag-runner/src/fem/eigen_output.rs"
PATH_MANIFEST = ROOT / "crates/fullmag-runner/src/fem/eigen_path_manifest.rs"


class NonsharedFloquetManifestContractSourceTests(unittest.TestCase):
    def test_single_and_multi_k_use_the_same_historical_and_native_selectors(self) -> None:
        output = OUTPUT.read_text(encoding="utf-8")
        path_manifest = PATH_MANIFEST.read_text(encoding="utf-8")

        self.assertIn(
            "NONSHARED_FLOQUET_SIDECAR_DEFINITIONS: [(&str, &str, &str); 3]",
            output,
        )
        self.assertIn(
            "NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS",
            output,
        )
        expected = (
            (
                "nonshared_floquet_native_input_diagnostics_v1_paths",
                "native_input_operator_diagnostics.v1.json",
                "nonshared_floquet_native_input_diagnostics_v1_path",
            ),
            (
                "nonshared_floquet_native_input_diagnostics_preimage_v1_paths",
                "native_input_operator_diagnostics_preimage.v1.json",
                "nonshared_floquet_native_input_diagnostics_preimage_v1_path",
            ),
        )
        for key, filename, alias in expected:
            self.assertIn(f'"{key}"', output)
            self.assertIn(f'"{filename}"', output)
            self.assertIn(f'"{alias}"', output)

        self.assertIn(
            "canonical_native_input_diagnostics_sample_scoped_index",
            output,
        )
        self.assertIn(
            '"eigen/metadata/sample_{sample_index:04}/nonshared_source/{filename}"',
            output,
        )

        self.assertIn(
            "NONSHARED_FLOQUET_SIDECAR_DEFINITIONS",
            path_manifest,
        )
        self.assertIn(
            "NONSHARED_FLOQUET_NATIVE_INPUT_DIAGNOSTICS_SIDECAR_DEFINITIONS",
            path_manifest,
        )
        for source in (output, path_manifest):
            self.assertIn('"nonshared_floquet_native_input_diagnostics_replay"', source)
            self.assertIn("nonshared_floquet_native_input_diagnostics_coverage", source)

    def test_structural_coverage_cannot_hide_duplicate_or_legacy_gaps(self) -> None:
        output = OUTPUT.read_text(encoding="utf-8")
        self.assertIn("duplicate non-shared Floquet native-input sidecar path", output)
        self.assertIn('"sidecar_paths_by_key"', output)
        self.assertIn("nonshared_floquet_legacy_three_sidecar_bundle_stays_unverified", output)
        self.assertIn(
            "inspect_nonshared_floquet_native_input_diagnostics_sidecars",
            output,
        )
        self.assertIn("let flattened = AuxiliaryArtifact", output)
        self.assertIn('"qualification": "NOT_VERIFIED"', output)


if __name__ == "__main__":
    unittest.main()
