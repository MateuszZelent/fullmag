"""Physical signs, units and Fourier-origin regressions for the reference-only audit."""
import importlib
import math
import unittest

import numpy as np

try:
    audit = importlib.import_module("verify_sushruth_2020_field_fft")
except ModuleNotFoundError:
    audit = None


class FieldFftTests(unittest.TestCase):
    def implementation(self):
        self.assertIsNotNone(audit, "The spatial-field FFT audit is not implemented")
        return audit

    def test_physical_origin_units_and_negative_exponent(self):
        module = self.implementation()
        x = np.array([-1.5, -0.5, 0.5, 1.5]) * 1e-6
        k, value = module.fourier_minus(x, np.array([0., 0., 1e6, 0.]))
        np.testing.assert_allclose(k, np.array([-math.pi, -math.pi/2, 0, math.pi/2])*1e6)
        q = math.sqrt(0.5)
        np.testing.assert_allclose(value, [1j, q+1j*q, 1, q-1j*q], atol=1e-14)

    def test_right_hand_field_sign_and_sheet_trace(self):
        module = self.implementation()
        observed = module.strip_field_per_ampere(np.array([0.]), width_m=200e-9,
                                                 spacing_m=100e-9, thickness_m=0.)
        np.testing.assert_allclose(observed, [-1.25e6], rtol=1e-14)
        trace = module.strip_field_per_ampere(np.array([-200e-9, 0., 200e-9]),
                                              width_m=200e-9, spacing_m=0., thickness_m=0.)
        np.testing.assert_allclose(trace, [0, -2.5e6, 0], atol=1e-10)

    def test_signed_currents_and_branch_positions(self):
        module = self.implementation()
        x = np.array([-400., -200., 0., 200., 400.]) * 1e-9
        fields = module.antenna_fields(x, width_m=200e-9, gap_m=200e-9,
                                       spacing_m=0., thickness_m=0.)
        np.testing.assert_allclose(fields["S"], [0, 0, -2.5e6, 0, 0], atol=1e-9)
        np.testing.assert_allclose(fields["GS"], [0, 2.5e6, 0, -2.5e6, 0], atol=1e-9)
        np.testing.assert_allclose(fields["GSG"], [1.25e6, 0, -2.5e6, 0, 1.25e6], atol=1e-9)

    def test_finite_metal_against_direct_biot_savart_cross_section(self):
        module = self.implementation()
        roots, weights = np.polynomial.legendre.leggauss(80)
        width, spacing, thickness = 200e-9, 43.7e-9, 90e-9
        u = width*roots[:, None]/2
        z = spacing+thickness*(1+roots[None, :])/2
        expected = []
        for x in [0., 100e-9, 450e-9]:
            expected.append(-np.sum(weights[:, None]*weights[None, :]*z/((x-u)**2+z*z))/(8*math.pi))
        actual = module.strip_field_per_ampere(np.array([0., 100e-9, 450e-9]),
            width_m=width, spacing_m=spacing, thickness_m=thickness, layer_order=16)
        np.testing.assert_allclose(actual, expected, rtol=1e-10, atol=1e-6)

    def test_gs_phase_is_reversed_only_by_fourier_convention(self):
        module = self.implementation()
        x = (np.arange(640)-319.5)*25e-9
        fields = module.antenna_fields(x, width_m=200e-9, gap_m=200e-9,
                                       spacing_m=0., thickness_m=0.)
        k, raw = module.fourier_minus(x, fields["GS"])
        index = np.flatnonzero(k > 0)[0]
        amplitude_minus = -2*raw[index]
        self.assertLess(amplitude_minus.imag, 0)
        kp = k[index]
        expected_plus = 2j*math.sin(kp*400e-9/2)*math.sin(kp*200e-9/2)/(kp*200e-9/2)
        self.assertLess(abs(amplitude_minus.conjugate()-expected_plus), 1e-4)
        self.assertGreater(abs(amplitude_minus-expected_plus), 0.1)
        self.assertAlmostEqual(abs(amplitude_minus)**2, abs(amplitude_minus.conjugate())**2)

    def test_nonuniform_missing_or_nonfinite_profiles_are_rejected(self):
        module = self.implementation()
        for x, h in [
            ([-1., 0., 2., 3.], [1., 1., 1., 1.]),
            ([0., 1., 2., 3.], [1., 1., 1.]),
            ([0., 1., 2., 3.], [1., float("nan"), 1., 1.]),
            ([0., 1.], [1., 1.]),
            ([3., 2., 1., 0.], [1., 1., 1., 1.])]:
            with self.assertRaises(ValueError):
                module.fourier_minus(np.array(x), np.array(h))


if __name__ == "__main__":
    unittest.main()
