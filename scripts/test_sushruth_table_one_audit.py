"""Unit and independent differentiation checks; no native solver is run."""
import math
import unittest

from reference_sushruth_2020_table_one import audit_table_one, _dispersion


class SushruthTableOneAuditTests(unittest.TestCase):
    def test_same_k_table_identity_keeps_hz_and_radians_distinct(self):
        result = audit_table_one()
        first, second = result["same_k_identity"]
        self.assertAlmostEqual(first["length_from_velocity_linewidth_m"] * 1e6,
                               0.1453153828230349, places=12)
        self.assertAlmostEqual(second["length_from_velocity_linewidth_m"] * 1e6,
                               0.01453153828230349, places=13)
        self.assertAlmostEqual(first["velocity_from_length_linewidth_m_per_s"],
                               867.0795723907829, places=10)
        self.assertAlmostEqual(first["length_ratio_table_to_identity"],
                               second["length_ratio_table_to_identity"], places=12)
        self.assertFalse(result["fullmag_solver_executed"])
        self.assertFalse(result["physics_qualified"])
        self.assertIn("unspecified", result["table_wavevector"])

    def test_exact_derivative_matches_independent_frequency_differences(self):
        def omega(k):
            x = abs(k) * 20e-9
            n = 1 + math.expm1(-x) / x
            return 2 * math.pi * 30e9 * math.sqrt(.25 * (.25 + .89 * n))
        for k in (1e6, 1e7, 3.8e7):
            analytic = _dispersion(k)["group_velocity_m_per_s"]
            errors = []
            for divisor in (1000, 2000, 4000):
                h = k / divisor
                numerical = (omega(k + h) - omega(k - h)) / (2 * h)
                errors.append(abs(numerical - analytic) / analytic)
            with self.subTest(k=k):
                self.assertLess(errors[-1], 1e-7)
                self.assertLess(errors[-1], errors[0])
                self.assertAlmostEqual(_dispersion(-k)["frequency_hz"],
                                       _dispersion(k)["frequency_hz"])
                self.assertAlmostEqual(_dispersion(-k)["group_velocity_m_per_s"],
                                       -analytic)

    def test_small_k_limit_and_existing_susceptibility_use_same_parameters(self):
        from reference_sushruth_2020_response import film_susceptibility
        zero = _dispersion(0)
        self.assertEqual(zero["frequency_hz"], 7.5e9)
        self.assertAlmostEqual(zero["group_velocity_m_per_s"],
                               838.8052385084748, places=10)
        for k in (0, 1e6, 1e7, 3.8e7):
            static_chi = film_susceptibility(k, 0)
            omega_squared = (2 * math.pi * 30e9)**2 * .25 * .89 / static_chi.real
            measured = (2 * math.pi * _dispersion(k)["frequency_hz"])**2
            self.assertTrue(math.isclose(measured, omega_squared, rel_tol=2e-15))
        self.assertEqual(audit_table_one()["k_zero_positive_limit"]["linewidth_hz"],
                         [150e6, 1.5e9])


if __name__ == "__main__":
    unittest.main()
