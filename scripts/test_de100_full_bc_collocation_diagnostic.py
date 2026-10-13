"""Lightweight checks for the exploratory full-BC collocation reference."""

import importlib.util
from pathlib import Path
import unittest

import numpy as np


_SCRIPT = Path(__file__).with_name("de100_full_bc_collocation_diagnostic.py")
_SPEC = importlib.util.spec_from_file_location("de100_full_bc_collocation", _SCRIPT)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_MODULE)


class De100FullBcCollocationTests(unittest.TestCase):
    def test_chebyshev_derivative_and_explicit_boundary_signs(self):
        nodes, derivative = _MODULE.chebyshev_lobatto(32)
        np.testing.assert_allclose(derivative @ nodes, 1.0, rtol=0.0, atol=2e-12)
        np.testing.assert_allclose(
            derivative @ (nodes**2), 2.0 * nodes, rtol=0.0, atol=2e-11
        )

        n = 12
        size = n + 1
        _, _, operator, mass = _MODULE.assemble_pencil(20e6, n)
        kappa = 20e6 * _MODULE.THICKNESS
        _, derivative = _MODULE.chebyshev_lobatto(n)
        np.testing.assert_allclose(
            operator[1 : size - 1, 2 * size : 3 * size],
            (-kappa * np.eye(size))[1:-1],
        )
        np.testing.assert_allclose(
            operator[2 * size + 1 : 3 * size - 1, :size],
            (kappa * np.eye(size))[1:-1],
        )
        np.testing.assert_allclose(
            operator[size + 1 : 2 * size - 1, 2 * size :], -derivative[1:-1]
        )
        np.testing.assert_allclose(
            operator[2 * size + 1 : 3 * size - 1, size : 2 * size],
            -derivative[1:-1],
        )
        self.assertEqual(np.count_nonzero(mass[:size]), size - 2)
        self.assertEqual(np.count_nonzero(mass[size : 2 * size]), size - 2)
        self.assertEqual(np.count_nonzero(mass[2 * size :]), 0)

        eta = _MODULE._air_boundary_eta(2.0)
        top = 2 * size
        bottom = 3 * size - 1
        self.assertAlmostEqual(operator[top, 2 * size] - derivative[0, 0], eta)
        self.assertAlmostEqual(
            operator[bottom, 2 * size + n] - derivative[n, n], -eta
        )
        self.assertEqual(operator[top, size], -1.0)
        self.assertEqual(operator[bottom, size + n], -1.0)

    def test_k0_matches_expected_modes_and_residuals(self):
        result = _MODULE.solve(0.0, n=32, count=3)
        expected = (9.2059719924, 10.8533855113, 14.8609413322)
        np.testing.assert_allclose(
            [mode.frequency_ghz for mode in result.modes], expected, rtol=0.0, atol=1e-6
        )
        for mode in result.modes:
            self.assertAlmostEqual(np.linalg.norm(mode.magnetic_profile), 1.0, places=12)
            self.assertLess(mode.relative_residual, 1e-8)

    def test_k20_matches_reference_and_reciprocity(self):
        positive = _MODULE.solve(20e6, n=32, count=3)
        negative = _MODULE.solve(-20e6, n=32, count=3)
        expected = (11.2321529865, 15.2050320243, 17.4347599683)
        np.testing.assert_allclose(
            [mode.frequency_ghz for mode in positive.modes], expected, rtol=0.0, atol=1e-6
        )
        np.testing.assert_allclose(
            [mode.frequency_ghz for mode in positive.modes],
            [mode.frequency_ghz for mode in negative.modes],
            rtol=0.0,
            atol=1e-8,
        )
        for mode in positive.modes:
            self.assertTrue(np.all(np.isfinite(mode.psi)))

    def test_singular_pencil_is_accounted_for(self):
        result = _MODULE.solve(20e6, n=32, count=3)
        diagnostics = result.diagnostics
        self.assertEqual(diagnostics.total_roots, 99)
        self.assertEqual(diagnostics.finite_roots, 62)
        self.assertEqual(diagnostics.infinite_roots, 37)
        self.assertEqual(diagnostics.algebraic_roots, 0)
        self.assertEqual(diagnostics.real_finite_roots, 62)
        self.assertEqual(diagnostics.nonreal_finite_roots, 0)
        self.assertEqual(diagnostics.positive_roots, 31)
        self.assertEqual(diagnostics.negative_roots, 31)
        self.assertEqual(diagnostics.zero_roots, 0)
        self.assertLess(diagnostics.max_positive_residual, 1e-8)

    def test_order_convergence_and_profile_back_transform(self):
        results = [_MODULE.solve(20e6, n=n, count=3) for n in (32, 48, 64)]
        spectra = np.asarray(
            [[mode.frequency_ghz for mode in result.modes] for result in results]
        )
        self.assertLess(float(np.max(np.ptp(spectra, axis=0))), 1e-6)
        for result in results:
            for mode in result.modes:
                np.testing.assert_allclose(mode.my, 1j * mode.u, rtol=0.0, atol=0.0)
                np.testing.assert_allclose(mode.mz, mode.v, rtol=0.0, atol=0.0)
                self.assertEqual(len(mode.nodes), result.n + 1)


if __name__ == "__main__":
    unittest.main()
