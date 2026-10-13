"""Source and Python authoring checks; no Rust compilation, API writes or solver."""
import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest

from test_command_result_identity_source import rust_block, source


class GeneratedSceneSyncSourceTests(unittest.TestCase):
    def test_rust_fixture_scene_renders_and_captures_updated_run_in_python(self):
        test = rust_block(source("crates/fullmag-api/src/script.rs"),
                          "fn generated_scene_sync_reexports_new_run_stage_and_preserves_explicit_rewrite(")
        fixture = test.split("snapshot.scene_document = Some", 1)[1]
        fixture = fixture.split("serde_json::json!", 1)[1]
        scene, _ = json.JSONDecoder().raw_decode(fixture[fixture.index("{"):])
        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"))
        from fullmag.runtime.loader import load_problem_from_script
        from fullmag.runtime.script_builder import render_scene_document_as_script, export_builder_draft

        self.assertEqual(scene["study"]["requested_device"], "cpu")
        self.assertEqual(scene["study"]["requested_precision"], "double")
        self.assertEqual(scene["study"]["fdm"]["default_cell"], [1e-8] * 3)
        with tempfile.TemporaryDirectory(prefix="fullmag-generated-sync-fixture-") as directory:
            path = Path(directory) / "scene_document.py"
            path.write_text(render_scene_document_as_script(scene), encoding="utf-8")
            first = export_builder_draft(load_problem_from_script(path, lightweight_assets=True))
            self.assertEqual(len(first["geometries"]), 1)
            self.assertEqual(first["stages"], [])
            updated = copy.deepcopy(scene)
            updated["revision"] += 1
            updated["study"]["stages"] = [{
                "kind": "run", "entrypoint_kind": "flat_run",
                "until_seconds": "1e-12", "fixed_timestep": "1e-13",
            }]
            rendered = render_scene_document_as_script(updated)
            self.assertIn("study.stages.add_run(", rendered)
            path.write_text(rendered, encoding="utf-8")
            second = export_builder_draft(load_problem_from_script(path, lightweight_assets=True))
            self.assertEqual(second["stages"][0]["kind"], "run")
            self.assertAlmostEqual(float(second["stages"][0]["until_seconds"]), 1e-12)

    def test_current_generated_scene_wins_over_previous_script_without_overrides(self):
        sync = rust_block(source("crates/fullmag-api/src/script.rs"),
                          "fn sync_current_live_script_with_request(")
        self.assertIn("script_origin(&workspace_root, authored_script_path)", sync)
        self.assertIn("snapshot.scene_document.clone()", sync)
        self.assertIn("let render_scene = scene_document.is_some()", sync)
        self.assertIn("matches!(origin, SCRIPT_ORIGIN_GENERATED | SCRIPT_ORIGIN_NONE)", sync)
        self.assertIn("&& req.overrides.is_none()", sync)
        self.assertIn("if has_input_script && !render_scene", sync)
        render = sync.split("render_scene_document_via_python_helper_bounded(", 1)[1]
        self.assertIn("&script_path_for_helper", render)
        self.assertIn("&scene_document", render)

    def test_user_file_and_explicit_overrides_keep_rewrite_copy_contract(self):
        sync = rust_block(source("crates/fullmag-api/src/script.rs"),
                          "fn sync_current_live_script_with_request(")
        self.assertIn("let user_file = origin == SCRIPT_ORIGIN_USER_FILE", sync)
        self.assertIn("user_file.then(|| managed_export_copy_path", sync)
        self.assertIn("if let Some(overrides) = req.overrides.clone()", sync)
        self.assertIn("overrides.as_ref()", sync)
        self.assertIn("managed_copy_for_helper.as_deref()", sync)
        self.assertIn("response.source_script_modified = false", sync)
        self.assertIn("if !has_input_script && req.overrides.is_some()", sync)
        self.assertIn("explicit script overrides require an existing input script", sync)

    def test_existing_transition_lock_and_request_identity_bracket_sync(self):
        handler = rust_block(source("crates/fullmag-api/src/router_v2/handlers/model/authoring.rs"),
                             "fn sync_authoring_script(")
        self.assertIn("current_live_session_transition.lock().await", handler)
        self.assertEqual(handler.count("validate_current_live_request_context("), 2)
        first, second = [i for i in range(len(handler))
                         if handler.startswith("crate::validate_current_live_request_context", i)]
        sync = handler.index("sync_current_live_script_with_request(")
        self.assertLess(first, sync)
        self.assertGreater(second, sync)


if __name__ == "__main__":
    unittest.main()
