"""Interactive observation readiness source checks; no solver/Rust execution."""
import re
import unittest

from test_command_result_identity_source import rust_block, source


HOST = "crates/fullmag-cli/src/interactive_runtime_host.rs"


class InteractiveObservationReadinessSourceTests(unittest.TestCase):
    def test_runtime_creation_and_resync_errors_are_fallible(self):
        text = source(HOST)
        self.assertIsNotNone(
            re.search(r"fn ensure_base_runtime_ready\([^)]*\) -> Result<\(\)>", text),
            "runtime readiness must return Result",
        )
        body = rust_block(text, "fn ensure_base_runtime_ready(")
        self.assertIn('.context("Idle live preview runtime unavailable")?', body)
        self.assertIn("self.runtime = None;", body)
        self.assertIn('return Err(anyhow!("Idle live preview runtime resync failed: {error}"));', body)
        self.assertNotIn("eprintln!", body)
        self.assertNotIn("live_workspace.push_log", body)

    def test_energy_requires_runtime_before_snapshot_and_publication(self):
        body = rust_block(source(HOST), "fn compute_current_energies(")
        self.assertRegex(body, r"self\.ensure_base_runtime_ready\([^;]*\)\?;")
        self.assertIn("self.runtime.as_mut().ok_or_else(", body)
        self.assertIn("Energy snapshots are unavailable for the current interactive backend", body)
        self.assertIn("runtime.snapshot_step_stats()?", body)
        self.assertLess(body.index(".ok_or_else("), body.index("runtime.snapshot_step_stats()?"))
        self.assertLess(body.index("runtime.snapshot_step_stats()?"), body.index("live_workspace.update("))
        for forbidden in ("if let Some(runtime)", ".advance(", ".run(", ".relax("):
            self.assertNotIn(forbidden, body)

    def test_explicit_fields_and_import_propagate_preparation_failures(self):
        text = source(HOST)
        for name in ("compute_current_fields", "load_state"):
            with self.subTest(name=name):
                body = rust_block(text, f"fn {name}(")
                self.assertRegex(body, r"self\.ensure_base_runtime_ready\([^;]*\)\?;")

    def test_import_preparation_precedes_continuation_and_generation_publication(self):
        body = rust_block(source(HOST), "fn load_state(")
        readiness = body.index("self.ensure_base_runtime_ready(")
        self.assertLess(body.index("validate_imported_magnetization("), readiness)
        for publication in ("self.preview_source.lock()", "live_workspace.update("):
            self.assertLess(readiness, body.index(publication))
        self.assertNotIn(".upload_magnetization(", body)

    def test_idle_warning_keeps_command_polling_enabled(self):
        body = rust_block(source(HOST), "fn enter_awaiting_command(")
        self.assertIn("if let Err(error) = self.ensure_base_runtime_ready(", body)
        self.assertIn('live_workspace.push_log("warn",', body)
        self.assertLess(body.index("self.ensure_base_runtime_ready("),
                        body.index("self.control.enable_command_polling();"))


if __name__ == "__main__":
    unittest.main()
