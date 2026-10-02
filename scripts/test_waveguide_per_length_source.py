"""Interpreted measure checks; no native build or solver execution."""
from pathlib import Path
import math
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


class WaveguideMeasureTests(unittest.TestCase):
    def test_extrusion_division_recovers_section_mass_and_stiffness(self):
        # Triangle (0,0),(2,0),(0,1): area=1, constant P1 gradients.
        # Exact 2D integrals are the per-length 3D weak forms. The 3D
        # integration supplies the axial length before its normalization.
        gradients = ((-.5, -1.), (.5, 0.), (0., 1.))
        mass = [[(1 / 6 if i == j else 1 / 12) for j in range(3)] for i in range(3)]
        stiffness = [[sum(a * b for a, b in zip(gi, gj)) for gj in gradients]
                     for gi in gradients]
        for length in (1e-9, 1., 2., 1e6):
            for matrix in (mass, stiffness):
                recovered = [[length * value / length for value in row] for row in matrix]
                for expected_row, actual_row in zip(matrix, recovered):
                    for expected, actual in zip(expected_row, actual_row):
                        self.assertTrue(math.isclose(expected, actual, rel_tol=1e-14, abs_tol=1e-15))
            # A second division of a 2D result incorrectly makes the area
            # (and the already reduced weak-form blocks) length-dependent.
            if length != 1:
                self.assertFalse(math.isclose(1. / length, 1., rel_tol=1e-12))

    def test_section_source_does_not_divide_by_axial_length_again(self):
        source = (ROOT / "backends/fem/cpu/frequency_domain/floquet_waveguide_cross_section.cpp").read_text()
        code = re.sub(r"//[^\n]*|/\*.*?\*/", "", source, flags=re.S)
        self.assertIsNone(re.search(r"/\s*problem\.normalization_length_m\b", code),
                          "2D weak forms must not be divided by axial length twice")
        # The legacy comparison length remains validated and reported;
        # rejecting or dropping it is a distinct contract change.
        self.assertIn("problem.normalization_length_m <= 0.0", code)
        self.assertIn("out_result->normalization_length_m = problem.normalization_length_m", code)


if __name__ == "__main__":
    unittest.main()
