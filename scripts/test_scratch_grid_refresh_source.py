"""Scratch grid-refresh source regression; no Rust compilation or runtime execution."""
import re
import unittest

from test_command_result_identity_source import rust_block, source


OWNER = "crates/fullmag-cli/src/scratch_runtime.rs"


class ScratchGridRefreshSourceTests(unittest.TestCase):
    def test_first_grid_refresh_is_in_the_supervisor_compute_allowlist(self):
        body = rust_block(source(OWNER), "fn pending_compute_command(")
        allowlist = re.search(r"matches!\(\s*kind,\s*Some\(([^)]+)\)\s*\)", body)
        self.assertIsNotNone(allowlist)
        kinds = set(re.findall(r'"([a-z_]+)"', allowlist.group(1)))
        self.assertEqual(kinds, {"remesh", "fdm_grid_refresh", "relax", "run", "solve"})
        self.assertIn('Some("queued" | "pending" | "accepted" | "dispatched")', body)
        self.assertRegex(body, r'command\s*\.get\("command_id"\)')

    def test_bootstrap_still_syncs_the_current_scene_before_spawning(self):
        body = rust_block(source(OWNER), "fn run(")
        start = body.index("if let Some(command_id) = pending_compute_command(")
        bootstrap = body[start:body.index("handled_command_id = Some(command_id)", start)]
        self.assertEqual(bootstrap.count("current_session_matches("), 2)
        self.assertLess(bootstrap.index("render_current_scene("),
                        bootstrap.index("spawn_attached_runtime("))
        spawn = rust_block(source(OWNER), "fn spawn_attached_runtime(")
        self.assertIn('.env("FULLMAG_ATTACHED_WAIT_FOR_SOLVE", "1")', spawn)

    def test_grid_refresh_keeps_the_materialized_stage_and_fdm_plan_gates(self):
        body = rust_block(source("crates/fullmag-cli/src/orchestrator/manual_remesh.rs"),
                          "fn prepare_fdm_grid_refresh(")
        self.assertIn("if candidate_stages.is_empty()", body)
        self.assertIn('bail!("fdm_grid_refresh requires at least one materialized stage")', body)
        self.assertIn("validate_ir(&stage.ir)?", body)
        self.assertIn("BackendPlanIR::Fdm(_) | BackendPlanIR::FdmMultilayer(_)", body)


if __name__ == "__main__":
    unittest.main()
