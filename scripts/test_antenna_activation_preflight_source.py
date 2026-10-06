"""Activation-boundary source checks; no Rust compilation or solver execution."""
import unittest

from test_command_result_identity_source import rust_block, source


OWNER = "crates/fullmag-cli/src/orchestrator.rs"


class AntennaActivationPreflightSourceTests(unittest.TestCase):
    def preflight(self):
        text = source(OWNER)
        self.assertTrue("fn prepare_solved_antenna_drive_activation(" in text,
                        "activation needs a shared fallible preflight")
        return rust_block(text, "fn prepare_solved_antenna_drive_activation(")

    def test_context_validation_precedes_activation_without_storage_or_clock_mutation(self):
        body = self.preflight()
        for guard in ("stage.study_kind != problem.study.kind()",
                      "stage.active_stage_id.as_deref() != active_stage_id"):
            self.assertIn(guard, body)
        self.assertLess(body.index("activation context differs"),
                        body.index("if !problem.solved_antenna_drives.iter().any("))
        for forbidden in ("artifact_dir", "load_", "execute_", "waveform_origin_time_s",
                          "start_time_s", "study =", "activation ="):
            self.assertNotIn(forbidden, body)

    def test_absent_or_inactive_drives_clear_both_lanes_before_returning_false(self):
        body = self.preflight()
        inactive = body.split("if !problem.solved_antenna_drives.iter().any(", 1)[1]
        inactive = inactive.split("return Ok(false);", 1)[0]
        self.assertIn(".is_active_for(problem.study.kind(), active_stage_id)", inactive)
        for lane in ("Fem", "Fdm"):
            self.assertIn(f"BackendPlanIR::{lane}(plan) => plan.solved_antenna_drive_bases.clear()",
                          inactive)
        self.assertNotIn("return Ok(", body.split("if !problem.solved_antenna_drives.iter().any(", 1)[0])
        self.assertIn("return Ok(false);", body)
        self.assertLess(body.index("return Ok(false);"),
                        body.index("solved antenna drives are not supported by the FDM multilayer lane"))
        self.assertIn("Ok(true)", body)

    def test_attachment_uses_preflight_before_materialization_without_own_activation_policy(self):
        body = rust_block(source(OWNER), "fn attach_solved_antenna_drive_bases(")
        gate = "if !prepare_solved_antenna_drive_activation(problem, execution_plan)?"
        self.assertTrue(gate in body, "attachment must delegate activation to the common preflight")
        self.assertIn("return Ok(());", body.split(gate, 1)[1].split("let time_stage", 1)[0])
        self.assertNotIn("solved_antenna_drive_bases.clear()", body)
        self.assertNotIn("if problem.solved_antenna_drives.is_empty()", body)
        for projection in ("materialize_fdm_solved_antenna_drives_v03",
                           "materialize_fem_solved_antenna_drives_v03"):
            self.assertIn(projection, body)
            self.assertLess(body.index(gate), body.index(projection))


if __name__ == "__main__":
    unittest.main()
