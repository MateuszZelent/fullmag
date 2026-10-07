"""Cross-consumer source guards; native runtime remains a separate gate."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class AllModesOutputSourceTests(unittest.TestCase):
    def test_native_publishers_bind_export_to_returned_vectors(self):
        fem = ROOT / "crates/fullmag-runner/src/fem"
        for name, count in (("eigen_native_artifacts.rs", "modes.len()"),
                            ("eigen_native_window.rs", "modes.len()"),
                            ("eigen_execution.rs", "total_modes")):
            source = (fem / name).read_text()
            self.assertIn(f"requested_mode_indices_for_result(outputs, {count})", source)
            self.assertNotIn("requested_mode_indices(outputs)", source)

    def test_path_retains_actual_sparse_ids_after_spectrum_validation(self):
        fem = ROOT / "crates/fullmag-runner/src/fem"
        source = (fem / "eigen_path.rs").read_text()
        validated = source.index("eigen_path_native_mode_identities(modes_array, sample.sample_index)?")
        retained = source.index("&available_mode_indices,", validated)
        self.assertLess(validated, retained)
        artifacts = (fem / "eigen_path_artifacts.rs").read_text()
        selector = artifacts[artifacts.index("pub(super) fn eigen_path_candidate_mode_indices("):
                             artifacts.index("pub(super) fn remap_single_k_mode_artifacts(")]
        self.assertIn("available_mode_indices.iter().copied()", selector)
        self.assertNotIn("0..mode_count", selector)
        tracking = artifacts[artifacts.index("pub(super) fn eigen_path_tracking_outputs("):
                             artifacts.index("pub(super) fn eigen_path_mode_tracking_vector(")]
        self.assertIn("all_modes: true", tracking)
        self.assertNotIn("0..mode_count", tracking)

    def test_legacy_rust_constructors_explicitly_preserve_default(self):
        # Inspect exhaustive constructors, not wildcard enum patterns. This
        # prevents an added enum field from leaving obvious compile failures.
        for path in (ROOT / "crates").rglob("*.rs"):
            source = path.read_text(encoding="utf-8")
            for match in re.finditer(r"OutputIR::EigenMode\s*\{", source):
                offset, depth = match.end(), 1
                end = offset
                while depth:
                    depth += (source[end] == "{") - (source[end] == "}")
                    end += 1
                body = source[offset:end - 1]
                if ".." not in body:
                    self.assertRegex(body, r"\ball_modes\b", str(path))

    def test_planner_validates_all_mode_intent(self):
        source = (ROOT / "crates/fullmag-plan/src/validate.rs").read_text()
        body = source[source.index("pub(crate) fn validate_eigen_outputs("):
                      source.index("pub(crate) fn validate_frequency_response_outputs(")]
        self.assertIn("if !all_modes && indices.is_empty() && branches.is_empty()", body)
        self.assertIn("all_modes cannot be combined with indices or branches", body)


if __name__ == "__main__":
    unittest.main()
