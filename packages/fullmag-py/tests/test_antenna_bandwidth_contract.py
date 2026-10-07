import unittest

import fullmag as fm
from fullmag.runtime.script_builder import _render_solved_antenna_drive_expr


class AntennaBandwidthContractTests(unittest.TestCase):
    def drive(self, waveform, declaration=None):
        return fm.SolvedAntennaDrive(
            id="drive", name="RF drive", projection_ref="projection",
            port_mode_id="port", peak_current_a=0.01, waveform=waveform,
            bandwidth_declaration=declaration,
        )

    def test_analytic_waveforms_reject_band_override_at_construction(self):
        for waveform in (fm.Constant(), fm.Sinusoidal(frequency_hz=1e9),
                         fm.SincPulse(cutoff_hz=2e9)):
            with self.subTest(waveform=waveform.to_ir()["kind"]):
                with self.assertRaisesRegex(ValueError, "only valid for pulse or piecewise_linear"):
                    self.drive(waveform, fm.AntennaWaveformBandwidthDeclaration(6e9))

    def test_undeclared_pulse_does_not_invent_inverse_duration_band(self):
        for duration in (1e-12, 1e-9, 1.0):
            with self.subTest(duration=duration):
                payload = self.drive(fm.Pulse(t_on=0.0, t_off=duration)).to_ir()
                self.assertNotIn("bandwidth_declaration", payload)

    def test_declared_pulse_and_piecewise_round_trip_through_script(self):
        for waveform in (fm.Pulse(t_on=0.0, t_off=1e-9),
                         fm.PiecewiseLinear([(0.0, 0.0), (1e-9, 1.0)])):
            with self.subTest(waveform=waveform.to_ir()["kind"]):
                payload = self.drive(waveform, fm.AntennaWaveformBandwidthDeclaration(6e9)).to_ir()
                reconstructed = eval(_render_solved_antenna_drive_expr(payload), {"fm": fm})
                self.assertEqual(reconstructed.to_ir(), payload)

    def test_analytic_waveforms_without_override_remain_supported(self):
        for waveform in (fm.Constant(), fm.Sinusoidal(frequency_hz=1e9),
                         fm.SincPulse(cutoff_hz=2e9)):
            with self.subTest(waveform=waveform.to_ir()["kind"]):
                payload = self.drive(waveform).to_ir()
                self.assertEqual(payload["waveform"], waveform.to_ir())
                self.assertNotIn("bandwidth_declaration", payload)


if __name__ == "__main__":
    unittest.main()
