"""Independent extruded weak-source oracle; does not execute native FEM."""
import cmath
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
GRADIENTS = ((-.5, -1.), (.5, 0.), (0., 1.))
BARYCENTRIC = ((2/3, 1/6, 1/6), (1/6, 2/3, 1/6), (1/6, 1/6, 2/3))
MX = (1+.2j, -.7+.4j, .3-.9j)
MY = (-.5+.7j, .6-.2j, .9+.1j)
MZ = (.4-.8j, 1.1+.5j, -.2+.6j)


def extruded_weak_source(k, length):
    """Integrate grad(conj(N_i exp(-ikz))) dot M over volume / length.

    Three-point triangle quadrature is exact for the degree-two integrand.
    Axial phase cancellation is evaluated in physical 3D rather than copying
    the section block expression. The triangle has area one square metre.
    """
    values = [0j] * 3
    for bary in BARYCENTRIC:
        mx = sum(n * m for n, m in zip(bary, MX))
        my = sum(n * m for n, m in zip(bary, MY))
        mz = sum(n * m for n, m in zip(bary, MZ))
        for axial_sample in range(7):
            z = length * (axial_sample + .5) / 7
            phase = cmath.exp(-1j * k * z)
            for i, gradient in enumerate(GRADIENTS):
                conjugate_test_dx = gradient[0] * phase.conjugate()
                conjugate_test_dy = gradient[1] * phase.conjugate()
                conjugate_test_dz = 1j * k * bary[i] * phase.conjugate()
                values[i] += (conjugate_test_dx * mx * phase + conjugate_test_dy * my * phase +
                              conjugate_test_dz * mz * phase) * length / 21 / length
    return values


def section_source(k, axial_sign, transverse_sign=1):
    return [transverse_sign * (gradient[0] * sum(MX) + gradient[1] * sum(MY)) / 3 +
            1j * k * axial_sign * sum((1/6 if i == j else 1/12) * MZ[j]
                                      for j in range(3))
            for i, gradient in enumerate(GRADIENTS)]


class WaveguideAxialSignTests(unittest.TestCase):
    def test_mixed_source_matches_extruded_weak_form_for_signed_k(self):
        source = (ROOT / "backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp").read_text()
        code = re.sub(r"//[^\n]*|/\*.*?\*/", "", source, flags=re.S)
        match = re.search(r"const double axial\s*=\s*([+-]?)frame\[2\]\s*;", code)
        self.assertIsNotNone(match, "update the oracle binding if axial assembly changes")
        actual_sign = -1 if match.group(1) == "-" else 1
        self.assertRegex(code, r"const double transverse\s*=\s*-\(gradients\[local_test\]\[0\]")
        self.assertRegex(code, r"gradients\[local_test\]\[1\]\s*\*\s*frame\[1\]\)")
        for k in (-3., 0., 3.):
            for length in (.1, 1., 4.):
                expected = extruded_weak_source(k, length)
                actual = section_source(k, actual_sign, transverse_sign=-1)
                for a, b in zip(actual, expected):
                    self.assertAlmostEqual(abs(a + b), 0., places=13,
                                           msg="descriptor must be negative physical source")

    def test_oracle_detects_relative_sign_even_when_k_conjugacy_passes(self):
        # Both signs conjugate correctly for real inputs. The mixed physical
        # weak-source comparison, not conjugacy alone, distinguishes them.
        for axial_sign in (-1, 1):
            for i, gradient in enumerate(GRADIENTS):
                transverse = (gradient[0] * sum(m.real for m in MX) +
                              gradient[1] * sum(m.real for m in MY)) / 3
                axial = sum((1/6 if i == j else 1/12) * MZ[j].real for j in range(3))
                plus = transverse + 3j * axial_sign * axial
                minus = transverse - 3j * axial_sign * axial
                self.assertEqual(minus, plus.conjugate())
        for k in (-3., 3.):
            expected = extruded_weak_source(k, 1.)
            wrong = section_source(k, -1)
            self.assertGreater(max(abs(a-b) for a, b in zip(wrong, expected)), .1)


if __name__ == "__main__":
    unittest.main()
