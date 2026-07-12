#!/usr/bin/env python3
"""Focused tests for the managed FEM Oersted RK convergence validator."""

from __future__ import annotations

import unittest

from validate_fem_oersted_rk_time_convergence import observed_order, validate_errors


class OerstedRkConvergenceValidatorTests(unittest.TestCase):
    def test_accepts_second_order_error_sequence(self) -> None:
        errors = [4.0e-4, 1.0e-4, 2.5e-5]
        self.assertAlmostEqual(observed_order(errors), 2.0)
        validate_errors("heun/cpu", errors, minimum_order=1.8)

    def test_rejects_nonconvergent_error_sequence(self) -> None:
        with self.assertRaisesRegex(ValueError, "below required"):
            validate_errors("rk4/gpu", [4.0e-4, 3.0e-4, 2.5e-4], minimum_order=2.5)


if __name__ == "__main__":
    unittest.main()
