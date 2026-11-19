"""Interpreted verification of the paper reference; no native solver claims."""
import cmath
import math
import unittest

from reference_sushruth_2020_antenna_spectrum import antenna_spectra, figure1_reference


class AntennaSpectrumReferenceTests(unittest.TestCase):
    def test_zero_and_published_width_zero(self):
        self.assertEqual(antenna_spectra(0), {"S": 1+0j, "GS": 0j, "GSG": 0j})
        for value in antenna_spectra(2 * math.pi / 200e-9).values():
            self.assertLess(abs(value), 1e-14)

    def test_known_value_preserves_phase_and_current_split(self):
        # k*L/2=pi/4 and k*(L+g)/2=pi/2.
        result = antenna_spectra(math.pi / (2 * 200e-9))
        amplitude = 2 * math.sqrt(2) / math.pi
        self.assertAlmostEqual(result["S"].real, amplitude)
        self.assertAlmostEqual(result["GS"].imag, 2 * amplitude)
        self.assertEqual(result["GS"].real, 0)
        self.assertAlmostEqual(result["GSG"].real, 2 * amplitude)

    def test_direct_strip_fourier_integral_independent_of_closed_form(self):
        width, gap, spacing = 180e-9, 250e-9, 30e-9
        distance = width + gap
        strips = {"S": [(0, 1)], "GS": [(distance / 2, 1), (-distance / 2, -1)],
                  "GSG": [(0, 1), (-distance, -0.5), (distance, -0.5)]}
        # Integrate each rectangle directly, without sinc or the array factors.
        for k in (-17.3e6, -4.7e6, 0, 4.7e6, 17.3e6):
            expected = antenna_spectra(k, width_m=width, gap_m=gap, spacing_m=spacing)
            for name, conductors in strips.items():
                estimates = []
                for count in (256, 512):
                    total = 0j
                    for center, current in conductors:
                        total += current * sum(
                            cmath.exp(1j * k * (center + width * ((i + 0.5) / count - 0.5)))
                            for i in range(count)) / count
                    estimates.append(total * math.exp(-abs(k) * spacing))
                error = abs(estimates[1] - expected[name])
                self.assertLess(error, 4e-6, (name, k))
                if k != 0:
                    self.assertGreater(abs(estimates[0] - expected[name]) / error, 3.9)

    def test_real_profile_hermitian_symmetry_and_spacing_attenuation(self):
        positive, negative = antenna_spectra(7e6), antenna_spectra(-7e6)
        shifted = antenna_spectra(7e6, spacing_m=30e-9)
        for name in positive:
            self.assertEqual(negative[name], positive[name].conjugate())
            self.assertAlmostEqual(abs(shifted[name] / positive[name]), math.exp(-0.21))

    def test_caption_scale_applies_only_to_power(self):
        result = figure1_reference()
        self.assertEqual(len(result["samples"]), 1201)
        first = result["samples"][0]
        self.assertEqual(first["h_normalized"]["S"], [1, 0])
        self.assertEqual(first["power_normalized"]["S"], 1)
        self.assertEqual(first["figure1_display_power"]["S"], 4)
        for flag in ("fullmag_solver_executed", "boris_solver_executed", "physics_qualified"):
            self.assertFalse(result[flag])

    def test_invalid_dimensions_and_nonfinite_values_are_rejected(self):
        for arguments in ({"k_rad_per_m": float("nan")}, {"k_rad_per_m": True},
                          {"k_rad_per_m": 0, "width_m": 0},
                          {"k_rad_per_m": 0, "gap_m": -1},
                          {"k_rad_per_m": 0, "spacing_m": float("inf")},
                          {"k_rad_per_m": 0, "spacing_m": -1}):
            with self.subTest(arguments=arguments), self.assertRaises(ValueError):
                antenna_spectra(**arguments)


if __name__ == "__main__":
    unittest.main()
