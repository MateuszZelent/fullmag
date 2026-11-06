"""Check the literal complex-square normalization independently of the reference.

This is an equation diagnostic, not a Fullmag, BORIS or RF port solve.
"""
import math
import unittest

import numpy as np

from reference_sushruth_2020_response import inductive_response


def signed_integrals(antenna, frequency_hz, alpha):
    """Use strip centers, signed q and cycles/s; no implementation integrand."""
    q = np.linspace(-80., 80., 65537)
    weights = np.ones(q.size)
    weights[1:-1:2] = 4.
    weights[2:-1:2] = 2.
    centers = {
        "S": [(0., 1.)],
        "GS": [(1.125, 1.), (-1.125, -1.)],
        "GSG": [(0., 1.), (-2.25, -.5), (2.25, -.5)],
    }[antenna]
    spectrum = np.sinc(q / (2 * math.pi)) * np.exp(-.15 * np.abs(q))
    spectrum = spectrum * sum(current * np.exp(1j * q * center)
                              for center, current in centers)
    x = np.abs(q) * .1
    n = 1. + np.divide(np.expm1(-x), x, out=np.full_like(x, -1.), where=x != 0)
    chi = 30e9**2 * .89 * .25 / (
        30e9**2 * .25 * (.25 + .89*n) - frequency_hz**2
        + 1j * frequency_hz * alpha * 30e9 * (.5 + .89*n))
    propagation = np.exp(-10j * q)

    def ratio(spectral_weight):
        weighted = weights * spectral_weight
        denominator = weighted.sum()
        return (np.sum(weighted * chi) / denominator,
                np.sum(weighted * chi * propagation) / denominator)

    return spectrum, ratio, weights, chi, propagation


class ResponseNormalizationTests(unittest.TestCase):
    def test_complex_square_with_its_own_normalizer_matches_power_reference(self):
        for antenna in ("S", "GS", "GSG"):
            for alpha in (.01, .1):
                for frequency in (7.8e9, 8.175e9, 8.355e9):
                    with self.subTest(antenna=antenna, alpha=alpha, frequency=frequency):
                        spectrum, ratio, weights, _, _ = signed_integrals(
                            antenna, frequency, alpha)
                        power = np.abs(spectrum)**2
                        square = spectrum**2
                        sign = -1 if antenna == "GS" else 1
                        np.testing.assert_allclose(square, sign * power,
                                                   rtol=1e-13, atol=1e-14)
                        self.assertLess(
                            abs(np.sum(weights * square) / np.sum(weights * power) - sign),
                            1e-13)
                        literal = ratio(square)
                        positive = ratio(power)
                        reference = inductive_response(
                            [frequency], antenna=antenna, alpha=alpha)
                        for actual, equivalent, field in zip(
                                literal, positive, ("reflection", "transmission")):
                            self.assertLess(abs(actual - equivalent), 1e-13)
                            expected = reference[field][0]
                            self.assertLessEqual(abs(actual - expected),
                                                 2e-6 + 2e-5 * abs(expected))

    def test_global_phase_cancels_but_mixed_gs_normalization_reverses_signal(self):
        spectrum, ratio, weights, chi, propagation = signed_integrals("GS", 8.175e9, .01)
        baseline = ratio(spectrum**2)
        for phase in (1., -1., 1j, -1j, np.exp(.37j)):
            with self.subTest(phase=phase):
                actual = ratio((phase * spectrum)**2)
                np.testing.assert_allclose(actual, baseline, rtol=1e-12, atol=1e-14)
        # This hybrid is deliberately inconsistent: signed numerator, positive D.
        hybrid = np.sum(weights * spectrum**2 * chi * propagation) / np.sum(
            weights * np.abs(spectrum)**2)
        self.assertGreater(abs(baseline[1]), 1e-6)
        self.assertLess(abs(hybrid + baseline[1]), 1e-13)
        self.assertGreater(abs(hybrid - baseline[1]), 1e-6)


if __name__ == "__main__":
    unittest.main(verbosity=2)
