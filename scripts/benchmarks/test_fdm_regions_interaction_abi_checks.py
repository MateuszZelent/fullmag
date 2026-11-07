"""Independent checks of the finite-difference measurement itself."""
import math
import unittest

from fdm_regions_interaction_abi_checks import check_gradient, constant_field_solution


class GradientMeasurementTests(unittest.TestCase):
    def setUp(self):
        self.m = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]
        self.ms = [400000.0, 800000.0]
        self.h = [[0.0, 2.0, 3.0], [3.0, 0.0, 1.0]]
        self.volume = 8e-27

    def energy(self, values, ms=None):
        return -4e-7 * math.pi * self.volume * sum(
            weight * sum(x * h for x, h in zip(m, field))
            for weight, m, field in zip(self.ms if ms is None else ms, values, self.h))

    def check(self, energy=None, field=None):
        return check_gradient(self.m, self.ms, self.volume,
            self.h if field is None else field, self.energy if energy is None else energy,
            epsilon=1e-5, tolerance=1e-7)

    def test_exact_zeeman_energy_uses_distinct_local_ms_and_tangent_directions(self):
        result = self.check()
        self.assertGreaterEqual(len(result["probes"]), 4)
        self.assertLess(result["max_relative_error"], 1e-7)

    def test_wrong_global_ms_and_factor_two_are_detected(self):
        with self.assertRaises(AssertionError):
            self.check(energy=lambda m: self.energy(m, [600000.0, 600000.0]))
        with self.assertRaises(AssertionError):
            self.check(field=[[2*x for x in row] for row in self.h])

    def test_nonfinite_and_uninformative_zero_measurements_are_rejected(self):
        with self.assertRaises(ValueError):
            self.check(energy=lambda _: float("nan"))
        with self.assertRaises(ValueError):
            self.check(field=[[float("nan"), 0, 0], [0, 0, 0]])
        with self.assertRaises(ValueError):
            self.check(energy=lambda _: 0.0, field=[[0.0]*3 for _ in range(2)])


class ConstantFieldOracleTests(unittest.TestCase):
    def test_zero_time_and_undamped_quarter_turn(self):
        self.assertEqual(constant_field_solution(0.4, 2e4, 0), [1., 0., 0.])
        m = constant_field_solution(0, 2e4, math.pi/(2*2.211e5*2e4))
        self.assertAlmostEqual(m[0], 0.)
        self.assertAlmostEqual(m[1], 1.)
        self.assertEqual(m[2], 0.)

    def test_damping_preserves_norm_and_aligns_with_field(self):
        low = constant_field_solution(0.1, 2e4, 1e-10)
        high = constant_field_solution(0.4, 2e4, 1e-10)
        for m in (low, high):
            self.assertAlmostEqual(sum(x*x for x in m), 1.)
        self.assertGreater(high[2], low[2])


if __name__ == "__main__":
    unittest.main()
