"""Catalog-to-asset boundary source checks; no Rust compilation or solve."""
import unittest

from test_command_result_identity_source import rust_block, source


class AntennaCatalogAssetSourceTests(unittest.TestCase):
    def test_catalog_opens_verified_port_asset_before_returning_reference(self):
        body = rust_block(source("crates/fullmag-cli/src/orchestrator.rs"),
                          "fn read_ready_antenna_stage_outputs(")
        gate = "fullmag_runner::load_published_antenna_field_solution_for_port("
        self.assertTrue(gate in body, "ready catalog must load the verified port asset")
        self.assertIn("expected_port_mode_id,", body.split(gate, 1)[1])
        self.assertIn("asset.manifest_bytes != fs::read(&manifest_path)?", body)
        self.assertLess(body.index(gate), body.index("Ok(reference)"))

    def test_port_loader_preserves_integrity_and_checks_solution_and_port(self):
        text = source("crates/fullmag-runner/src/antenna_stage.rs")
        self.assertTrue("fn load_published_antenna_field_solution_for_port(" in text,
                        "runner must own the shared port-asset integrity gate")
        body = rust_block(text, "fn load_published_antenna_field_solution_for_port(")
        self.assertIn("load_published_antenna_field_solution(output_root, reference)?", body)
        self.assertIn('manifest.get("solution_id")', body)
        self.assertIn("Some(reference.output_id.as_str())", body)
        self.assertIn('basis.get("port_mode_id")', body)
        self.assertIn("Some(port_mode_id)", body)
        self.assertLess(body.index("load_published_antenna_field_solution("),
                        body.index('manifest.get("solution_id")'))
        self.assertIn("load_published_antenna_field_solution_for_port,",
                      source("crates/fullmag-runner/src/lib.rs"))


if __name__ == "__main__":
    unittest.main()
