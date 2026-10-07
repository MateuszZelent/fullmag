"""Cache freshness boundary checks; no Rust compilation or solver execution."""
import unittest

from test_command_result_identity_source import rust_block, source


OWNER = "crates/fullmag-runner/src/antenna_stage.rs"


class AntennaCacheExpectationSourceTests(unittest.TestCase):
    def test_ready_cache_uses_current_expectation_before_returning_asset(self):
        body = rust_block(source(OWNER), "fn inspect_cached_antenna_field_solution(")
        self.assertIn("ExpectedAntennaSolution::new(reference.clone(), signatures)", body)
        self.assertIn(".with_source_revisions(", body)
        for revision in ("request.geometry_revision.clone()",
                         "request.material_revision.clone()",
                         "request.mesh_digest.clone()"):
            self.assertIn(revision, body)
        gate = "load_expected_antenna_field_solution(output_root, &expected)?"
        self.assertIn(gate, body)
        self.assertLess(body.index(gate),
                        body.index("Ok(AntennaFieldSolutionCacheState::Ready("))
        self.assertNotIn("load_published_antenna_field_solution(output_root, &reference)?", body)

    def test_source_currency_still_does_not_compare_target_projections(self):
        body = rust_block(source("crates/fullmag-runner/src/antenna_field_solution.rs"),
                          "fn verify_antenna_field_solution_signatures_with_revisions(")
        self.assertNotIn("target_projection_signatures", body)
        for revision in ("manifest.geometry_revision", "manifest.material_revision",
                         "manifest.mesh_digest"):
            self.assertIn(revision, body)

    def test_cache_classification_and_snapshot_race_guard_are_preserved(self):
        body = rust_block(source(OWNER), "fn inspect_cached_antenna_field_solution(")
        self.assertLess(body.index("AntennaFieldSolutionCacheState::Stale {"),
                        body.index("ExpectedAntennaSolution::new("))
        self.assertIn("cached_asset_id != asset_id", body)
        self.assertNotIn("cached_signatures.target_projection_signatures !=", body)
        self.assertIn("if asset.manifest_bytes != manifest_bytes", body)
        self.assertLess(body.index("if asset.manifest_bytes != manifest_bytes"),
                        body.index("Ok(AntennaFieldSolutionCacheState::Ready("))


if __name__ == "__main__":
    unittest.main()
