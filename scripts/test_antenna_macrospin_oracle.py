"""Independent reference checks; no native build or backend qualification."""

import math
import unittest

from antenna_macrospin_oracle import compare_collinear_trajectory, macrospin_from_field_impulse, waveform_integral


class AntennaMacrospinOracleTests(unittest.TestCase):
    def test_precession_sign_units_and_damping(self):
        gamma = 2.211e5
        quarter_turn = math.pi / (2 * gamma)
        m = macrospin_from_field_impulse((1, 0, 0), quarter_turn, 0)
        for actual, expected in zip(m, (0, 1, 0)):
            self.assertAlmostEqual(actual, expected, places=14)
        alpha = 0.2
        m = macrospin_from_field_impulse((1, 0, 0), (1 + alpha**2) / gamma, alpha)
        self.assertAlmostEqual(m[2], math.tanh(alpha), places=14)
        self.assertAlmostEqual(math.hypot(*m), 1, places=14)

    def test_impulse_composition_and_reversal(self):
        initial = (0.6, 0.0, 0.8)
        first = macrospin_from_field_impulse(initial, 3e-6, 0.3)
        composed = macrospin_from_field_impulse(first, -1e-6, 0.3)
        direct = macrospin_from_field_impulse(initial, 2e-6, 0.3)
        reversed_m = macrospin_from_field_impulse(first, -3e-6, 0.3)
        for a, b in zip(composed, direct):
            self.assertAlmostEqual(a, b, places=14)
        for a, b in zip(reversed_m, initial):
            self.assertAlmostEqual(a, b, places=14)

    def test_aligned_and_near_pole_states(self):
        self.assertEqual(macrospin_from_field_impulse((0, 0, -1), 1, 1), (0, 0, -1))
        m = macrospin_from_field_impulse((1e-10, 0, 1), 0, 1)
        self.assertAlmostEqual(m[0] / 1e-10, 1, places=13)

    def test_exact_waveform_integrals(self):
        self.assertEqual(waveform_integral({'kind': 'constant'}, 2, 5), 3)
        sine = {'kind': 'sinusoidal', 'frequency_hz': 1, 'phase_rad': math.pi / 2, 'offset': 0.3}
        self.assertAlmostEqual(waveform_integral(sine, 0, 0.25), 0.075 + 1 / math.tau)
        pulse = {'kind': 'pulse', 't_on': 2, 't_off': 3}
        self.assertEqual(waveform_integral(pulse, 0, 4), 1)
        self.assertEqual(waveform_integral(pulse, 3, 4), 0)
        pwl = {'kind': 'piecewise_linear', 'points': [(1, 2), (2, 4), (3, 0)]}
        self.assertEqual(waveform_integral(pwl, 0, 4), 7)
        self.assertEqual(waveform_integral(pwl, 1.25, 1.75), 1.5)

    def test_sinc_known_sine_integral_and_additivity(self):
        wave = {'kind': 'sinc_pulse', 'cutoff_hz': 1, 't0': 0.5, 'amplitude': 1}
        # Integral from -pi to pi is 2 Si(pi); Si(pi)=1.851937051982466...
        full = waveform_integral(wave, 0, 1)
        self.assertAlmostEqual(full, 1.851937051982466 / math.pi, places=12)
        split = waveform_integral(wave, 0, 0.37) + waveform_integral(wave, 0.37, 1)
        self.assertAlmostEqual(full, split, places=12)

    def test_physical_nanosecond_clock(self):
        wave = {'kind': 'sinusoidal', 'frequency_hz': 1e9, 'phase_rad': 0.7, 'offset': 0.2}
        impulse = waveform_integral(wave, 0, 1e-9)
        self.assertAlmostEqual(impulse / 1e-9, 0.2, places=14)
        local = waveform_integral(wave, 0, 0.2e-9)
        absolute = waveform_integral(wave, 0.25e-9, 0.45e-9)
        self.assertGreater(abs(local - absolute), 1e-11)

    def test_invalid_inputs_fail_closed(self):
        for initial, impulse, alpha in [((1, 1, 0), 1, 0), ((1, 0, 0), float('nan'), 0), ((1, 0, 0), 1, -1)]:
            with self.assertRaises(ValueError):
                macrospin_from_field_impulse(initial, impulse, alpha)
        for wave in [{'kind': 'unknown'}, {'kind': 'sinusoidal', 'frequency_hz': 0}, {'kind': 'piecewise_linear', 'points': [(1, 1), (1, 2)]}]:
            with self.assertRaises(ValueError):
                waveform_integral(wave, 0, 1)

    def test_trajectory_rejects_phase_units_and_stale_time(self):
        args = dict(initial_m=(1, 0, 0), alpha=0, waveform={'kind': 'constant'},
                    basis_hz_per_a=1e6, peak_current_a=0.02, bias_hz_a_per_m=1e4,
                    start_time_s=0, stage_start_time_s=0, time_origin='absolute',
                    vector_tolerance=1e-10)
        time = math.pi / (2 * 2.211e5 * 3e4)
        samples = [{'time_s': 0, 'm': [1, 0, 0]}, {'time_s': time, 'm': [0, 1, 0]}]
        self.assertEqual(compare_collinear_trajectory(samples, **args)['sample_count'], 2)
        for changed in [dict(peak_current_a=0.01), dict(basis_hz_per_a=1e6 * 1.2566370614359173e-6)]:
            with self.assertRaises(ValueError):
                compare_collinear_trajectory(samples, **(args | changed))
        for bad in [[], samples[:1], samples[::-1], samples + samples[-1:],
                    [{'time_s': time, 'm': [0, -1, 0]}],
                    [{'time_s': time, 'm': [float('nan'), 1, 0]}]]:
            with self.assertRaises(ValueError):
                compare_collinear_trajectory(bad, **args)

    def test_trajectory_respects_stage_origin(self):
        stage = 0.25e-9
        args = dict(initial_m=(1, 0, 0), alpha=0,
                    waveform={'kind': 'sinusoidal', 'frequency_hz': 1e9},
                    basis_hz_per_a=1e6, peak_current_a=0.01, bias_hz_a_per_m=0,
                    start_time_s=stage, stage_start_time_s=stage,
                    time_origin='stage_local', vector_tolerance=1e-10)
        # Integral sin(omega*t) from 0 to T/2 equals 2/omega.
        phi = 2.211e5 * 1e4 / (math.pi * 1e9)
        sample = [{'time_s': stage + 0.5e-9, 'm': [math.cos(phi), math.sin(phi), 0]}]
        compare_collinear_trajectory(sample, **args)
        with self.assertRaises(ValueError):
            compare_collinear_trajectory(sample, **(args | {'time_origin': 'absolute'}))


if __name__ == '__main__':
    unittest.main()
