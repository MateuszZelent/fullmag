"""Lightweight checks for the exploratory DE-100 nm reference."""
import importlib.util
import math
from pathlib import Path
import unittest

import numpy as np


_SCRIPT = Path(__file__).with_name("de100_coupled_reference_diagnostic.py")
_SPEC = importlib.util.spec_from_file_location("de100_reference", _SCRIPT)
_MODULE = importlib.util.module_from_spec(_SPEC)
assert _SPEC.loader is not None
_SPEC.loader.exec_module(_MODULE)


def _ks_n0_open_ghz(k):
    """Diagonal KS n=0 in the open-film limit, in GHz."""

    q=abs(k)*_MODULE.thickness
    P=1.0 if q == 0 else -math.expm1(-q)/q
    a=_MODULE.field+_MODULE.lex2*q*q
    omega=math.sqrt((a+1-P)*(a+P))
    return omega*_MODULE._FREQUENCY_SCALE_GHZ


class De100CoupledReferenceTests(unittest.TestCase):
    def test_gamma_and_first_thickness_mode(self):
        modes=_MODULE._positive_modes(0.0, 4, 320)
        self.assertEqual(len(modes), 4)
        nz=1-1/(2*_MODULE.h)
        gamma=math.sqrt(_MODULE.field*(_MODULE.field+nz))
        n1_exchange=_MODULE.field+_MODULE.lex2*math.pi**2
        n1=math.sqrt(n1_exchange*(n1_exchange+1))
        self.assertAlmostEqual(modes[0].frequency_ghz, gamma*_MODULE._FREQUENCY_SCALE_GHZ, places=10)
        self.assertAlmostEqual(modes[1].frequency_ghz, n1*_MODULE._FREQUENCY_SCALE_GHZ, places=10)

    def test_one_mode_matches_open_ks_n0(self):
        # Finite Dirichlet padding is 20 thicknesses on each side, so the
        # remaining difference from the open KS expression is quadrature error.
        for k in (20e6, 40e6):
            computed=_MODULE.spectrum(k, 1, 1280)[0]
            expected=_ks_n0_open_ghz(k)
            self.assertLess(abs(computed-expected), 5e-5)

    def test_modes_are_l2_normalized_and_have_ll_residuals(self):
        for convention in (_MODULE.CODE_CONVENTION, _MODULE.FULLMAG_CONVENTION):
            modes=_MODULE._positive_modes(20e6, 8, 320, convention=convention)
            self.assertEqual(len(modes), 8)
            for mode in modes:
                self.assertEqual(len(mode.my), 8)
                self.assertEqual(len(mode.mz), 8)
                self.assertAlmostEqual(np.linalg.norm(mode.coefficients), 1.0, places=12)
                self.assertLess(mode.relative_residual, 1e-10)

    def test_reciprocal_plus_minus_k_spectrum(self):
        positive=_MODULE.spectrum(20e6, 8, 320)
        negative=_MODULE.spectrum(-20e6, 8, 320)
        np.testing.assert_allclose(positive, negative, rtol=2e-13, atol=2e-13)

    def test_phase_change_flips_coupling_and_conjugates_profiles(self):
        k=20e6
        N=8
        Q=320
        code=_MODULE._assemble_stiffness(k, N, Q, convention=_MODULE.CODE_CONVENTION)
        fullmag=_MODULE._assemble_stiffness(k, N, Q, convention=_MODULE.FULLMAG_CONVENTION)
        np.testing.assert_allclose(fullmag, code.conj(), rtol=0, atol=1e-13)
        self.assertGreater(float(np.max(np.abs(code[:N, N:]))), 1e-10)
        np.testing.assert_allclose(fullmag[:N, N:], -code[:N, N:], rtol=0, atol=1e-13)

        code_modes=_MODULE._positive_modes(k, N, Q, convention=_MODULE.CODE_CONVENTION)
        fullmag_modes=_MODULE._positive_modes(k, N, Q, convention=_MODULE.FULLMAG_CONVENTION)
        for code_mode, fullmag_mode in zip(code_modes, fullmag_modes):
            target=code_mode.coefficients.conj()
            overlap=np.vdot(target, fullmag_mode.coefficients)
            self.assertGreater(abs(overlap), 1-1e-11)
            aligned=fullmag_mode.coefficients*np.exp(-1j*np.angle(overlap))
            np.testing.assert_allclose(aligned, target, rtol=0, atol=1e-10)


if __name__ == "__main__":
    unittest.main()
