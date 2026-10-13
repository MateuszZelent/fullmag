"""Source arithmetic regression, not compiled Rust or solver qualification."""
import math
import re
import unittest

from test_command_result_identity_source import rust_block, source


class GammaWaveformOriginSourceTests(unittest.TestCase):
    def evaluation_time(self, kind, time, start, origin):
        body = rust_block(
            source("crates/fullmag-runner/src/spin_wave_response.rs"),
            "fn append_requested_spin_wave_artifacts(",
        )
        match = re.search(
            r"let evaluation_time = match drive.time_origin\s*\{(.*?)\};",
            body,
            re.S,
        )
        self.assertIsNotNone(match, "collector clock match must remain explicit")
        branch = re.search(rf"FieldTimeOriginIR::{kind}\s*=>\s*([^,]+),", match[1])
        self.assertIsNotNone(branch)
        expression = branch[1].strip()
        if expression == "*time":
            return time
        if expression == "*time - time_stage.start_time_s":
            return time - start
        if expression == "*time - time_stage.waveform_origin_time_s()":
            context = rust_block(
                source("crates/fullmag-ir/src/plan.rs"),
                "fn waveform_origin_time_s(",
            )
            self.assertIn("self.waveform_origin_time_s.unwrap_or(self.start_time_s)", context)
            return time - (start if origin is None else origin)
        self.fail(f"unrecognized collector arithmetic: {expression}")

    def test_resumed_sinusoid_keeps_original_phase(self):
        time, start, origin = 11.25, 11.0, 10.0
        argument = self.evaluation_time("StageLocal", time, start, origin)
        # A half-Hz signal distinguishes a one-second origin shift by pi.
        actual = math.sin(math.pi * argument)
        expected = math.sin(math.pi * (time - origin))
        self.assertAlmostEqual(actual, expected, places=14)

    def test_resumed_pulse_does_not_restart_its_edges(self):
        argument = self.evaluation_time("StageLocal", 11.25, 11.0, 10.0)
        self.assertTrue(1.0 <= argument < 2.0)

    def test_legacy_plan_uses_segment_start(self):
        self.assertEqual(self.evaluation_time("StageLocal", 11.25, 11.0, None), 0.25)

    def test_absolute_clock_ignores_both_origins(self):
        self.assertEqual(self.evaluation_time("Absolute", 11.25, 11.0, 10.0), 11.25)


if __name__ == "__main__":
    unittest.main()
