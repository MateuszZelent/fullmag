"""Independent quadrature and analytic checks for the published response model."""
import cmath
import json
import math
import unittest
import warnings

import numpy as np
import scipy
from scipy.integrate import IntegrationWarning, quad
from scipy.optimize import brentq

from reference_sushruth_2020_response import (
    film_susceptibility, inductive_response, figure3_reference,
)


def independent_integral(antenna, alpha, frequency):
    """Signed-q adaptive integration; does not call the implementation integrand."""
    centers = {"S": [(0., 1.)], "GS": [(1.125, 1.), (-1.125, -1.)],
               "GSG": [(0., 1.), (-2.25, -.5), (2.25, -.5)]}[antenna]

    def power(q):
        rectangle = 1. if q == 0 else (cmath.exp(.5j*q)-cmath.exp(-.5j*q))/(1j*q)
        amplitude = rectangle * sum(current*cmath.exp(1j*q*center)
                                    for center, current in centers)
        return abs(amplitude)**2 * math.exp(-.3*abs(q))

    def resonance_squared(q):
        x = abs(q)*.1
        n = 0. if x == 0 else 1. + math.expm1(-x)/x
        return 30e9**2 * .25 * (.25 + .89*n), n

    def integrand(q, distance):
        natural_squared, n = resonance_squared(q)
        # Use cycles/s throughout, independent of the implementation's rad/s.
        chi = 30e9**2 * .89 * .25 / (
            natural_squared-frequency**2 + 1j*frequency*alpha*30e9*(.5+.89*n))
        return power(q)*chi*cmath.exp(-1j*q*distance/200e-9)

    points = set(float(q) for q in range(-78, 80, 2))
    if resonance_squared(0)[0] < frequency**2 < resonance_squared(80)[0]:
        root = brentq(lambda q: resonance_squared(q)[0]-frequency**2, 0, 80)
        points.update((root, -root))
    errors = []

    def integrate(function):
        with warnings.catch_warnings():
            warnings.simplefilter("error", IntegrationWarning)
            value, error = quad(function, -80, 80, points=sorted(points),
                                epsabs=2e-10, epsrel=2e-10, limit=1000)
        errors.append(error)
        return value

    denominator = integrate(power)
    values = []
    for distance in (0., 2e-6):
        real = integrate(lambda q: integrand(q, distance).real)
        imag = integrate(lambda q: integrand(q, distance).imag)
        values.append(complex(real, imag)/denominator)
    return values, max(errors), denominator/200e-9


class SushruthResponseReferenceTests(unittest.TestCase):
    def test_analytic_susceptibility_units_and_symmetries(self):
        self.assertAlmostEqual(film_susceptibility(0., 0.).real, .89/.25)
        for alpha in (.01, .03, .07, .1):
            self.assertAlmostEqual(film_susceptibility(0., 30e9*.25, alpha=alpha),
                                   -1j*.89/(2*alpha*.25), places=11)
        k = np.array([0., 1e-4, 1e6, 9e7])
        positive = film_susceptibility(k, 9e9)
        np.testing.assert_array_equal(positive, film_susceptibility(-k, 9e9))
        np.testing.assert_array_equal(positive.conjugate(), film_susceptibility(k, -9e9))
        self.assertTrue(np.all(positive.imag < 0))

    def test_zero_distance_reciprocity_and_frequency_conjugation(self):
        for antenna in ("S", "GS", "GSG"):
            zero = inductive_response([9e9], antenna=antenna, distance_m=0.)
            np.testing.assert_array_equal(zero["transmission"], zero["reflection"])
            positive = inductive_response([9e9, -9e9], antenna=antenna)
            negative = inductive_response([9e9], antenna=antenna, distance_m=-2e-6)
            np.testing.assert_array_equal(positive["transmission"][:1], negative["transmission"])
            for name in ("reflection", "transmission"):
                self.assertEqual(positive[name][0].conjugate(), positive[name][1])

    def test_zero_thickness_normalization(self):
        expected = film_susceptibility(0., 9e9, film_thickness_m=0)
        for antenna in ("S", "GS", "GSG"):
            result = inductive_response([9e9], antenna=antenna, film_thickness_m=0)
            self.assertLess(abs(result["reflection"][0]-expected), 2e-14)

    def test_independent_signed_quadrature_and_convergence(self):
        rows = []
        for antenna in ("S", "GS", "GSG"):
            for alpha in (.01, .03, .07, .1):
                frequencies = [7.5e9, 9e9, 12e9]
                grids = [inductive_response(frequencies, antenna=antenna, alpha=alpha,
                                            intervals=count, max_kl=cutoff)
                         for count, cutoff in ((8192, 80), (16384, 80),
                                               (32768, 80), (32768, 160))]
                for index, frequency in enumerate(frequencies):
                    expected, estimated_error, denominator = independent_integral(antenna, alpha, frequency)
                    errors, changes = [], []
                    for field, reference in zip(("reflection", "transmission"), expected):
                        threshold = 2e-6 + 2e-5*abs(reference)
                        for grid in grids:
                            error = abs(grid[field][index]-reference)
                            self.assertLessEqual(error, threshold, (antenna, alpha, frequency, field))
                            errors.append(error)
                        for left, right in ((0, 1), (1, 2), (1, 3)):
                            change = abs(grids[left][field][index]-grids[right][field][index])
                            self.assertLessEqual(change, threshold)
                            changes.append(change)
                    self.assertLess(abs(grids[1]["normalization_integral_per_m"]/denominator-1), 2e-6)
                    self.assertLess(estimated_error, 1e-7)
                    rows.append({"antenna": antenna, "alpha": alpha, "frequency_hz": frequency,
                                 "max_complex_error": max(errors),
                                 "max_grid_or_cutoff_change": max(changes),
                                 "quad_max_estimated_absolute_error": estimated_error})
        print(json.dumps({"comparison_cases": rows, "numpy": np.__version__,
                          "scipy": scipy.__version__}), flush=True)

    def test_invalid_inputs(self):
        for frequencies, options in (
            ([], {}), ([[1.]], {}), ([float("nan")], {}), ([True], {}),
            ([1., True], {}), ([1e9], {"alpha": 0}), ([1e9], {"alpha": True}),
            ([1e9], {"intervals": 3}), ([1e9], {"intervals": True}),
            ([1e9], {"width_m": 0}), ([1e9], {"spacing_m": -1}),
            ([1e9], {"max_kl": float("inf")}), ([1e9], {"antenna": "CPW"}),
        ):
            with self.subTest(frequencies=frequencies, options=options), self.assertRaises(ValueError):
                inductive_response(frequencies, **options)
        for k in (True, [0., False], [complex(1, 1)], [float("inf")]):
            with self.subTest(k=k), self.assertRaises(ValueError):
                film_susceptibility(k, 1e9)

    def test_reference_metadata_and_raw_values(self):
        result = figure3_reference()
        self.assertEqual(len(result["frequencies_hz"]), 141)
        self.assertEqual(len(result["cases"]), 12)
        self.assertEqual(result["fmr_hz_from_table_parameters"], 7.5e9)
        self.assertEqual(result["parameters_si"]["spacing_m"], 30e-9)
        for flag in ("fullmag_solver_executed", "boris_solver_executed", "physics_qualified"):
            self.assertIs(result[flag], False)
        scales = {.01: (1, 1), .03: (10, 30), .07: (30, 300), .1: (60, 600)}
        for case in result["cases"]:
            self.assertEqual(case["figure3_display_multiplier"],
                             scales[case["alpha"]][case["antenna"] != "S"])
            raw = inductive_response([9e9], antenna=case["antenna"], alpha=case["alpha"])
            for field in ("reflection", "transmission"):
                self.assertEqual(len(case[field]), 141)
                self.assertEqual(complex(*case[field][40]), raw[field][0])
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main(verbosity=2)
