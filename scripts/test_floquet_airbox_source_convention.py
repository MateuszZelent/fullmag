"""Dense bridge sign regression: independent algebra plus source binding only."""
from pathlib import Path
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]


def code(path):
    return re.sub(r"//[^\n]*|/\*.*?\*/", "", (ROOT / path).read_text(), flags=re.S)


class AirboxSourceConventionTests(unittest.TestCase):
    def test_dense_shared_domain_marks_weak_rhs_and_converts_once(self):
        owner = code("backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp")
        bridge = code("backends/fem/cpu/frequency_domain/floquet_airbox_operator.cpp")
        self.assertIsNotNone(re.search(r"floquet_problem\.tangent_source_convention\s*=\s*"
                                      r"FloquetAirboxTangentSourceConvention::weak_poisson_rhs", owner),
                             "shared-domain owner must declare the physical RHS convention")
        self.assertIn("FloquetAirboxTangentSourceConvention::descriptor_block", bridge)
        self.assertIn("FloquetAirboxTangentSourceConvention::weak_poisson_rhs", bridge)
        self.assertIsNotNone(re.search(r"source_to_descriptor_sign\s*=.*?weak_poisson_rhs\s*\?\s*-1\.0\s*:\s*1\.0",
                                      bridge, re.S), "weak RHS must be negated once for descriptor")
        self.assertIn("value *= source_to_descriptor_sign", bridge)
        self.assertLess(bridge.index("value *= source_to_descriptor_sign"),
                        bridge.index("a_phiq[static_cast<std::size_t>(reduced_row * q + column)] = value"))

    def test_physical_potential_requires_conversion_while_schur_is_invariant(self):
        # Two full phi and q nodes, both C=[1,-i]. P_full=I, S is diagonal
        # with entries 1+2i and 3-i. Thus Cphi^H S Cq=4+i, P_red=2.
        constraint = (1.+0j, -1j)
        full_source_diagonal = (1.+2j, 3.-1j)
        p = sum(abs(c)**2 for c in constraint)
        s = sum(c.conjugate() * entry * c for c, entry in zip(constraint, full_source_diagonal))
        self.assertEqual((p, s), (2., 4.+1j))
        q = .7-.3j
        descriptor = -s
        phi = -descriptor * q / p
        self.assertAlmostEqual(abs(p * phi - s * q), 0., places=14)
        wrong_phi = -s * q / p
        self.assertGreater(abs(p * wrong_phi - s * q), 1.)
        # The energy Schur with physical feedback -mu0 is invariant to the
        # simultaneous sign change, so a frequency-only test misses this bug.
        mu0 = 1.25663706212e-6
        dense = mu0 * descriptor.conjugate() * descriptor / p
        wrong_dense = mu0 * s.conjugate() * s / p
        self.assertEqual(dense, wrong_dense)

    def test_full_field_residual_keeps_the_physical_rhs(self):
        residual = code("backends/fem/cpu/frequency_domain/modal/floquet_modal_solver.cpp")
        self.assertIn("potential_residual_full[index] = p_phi[index] - source_q[index]", residual)


if __name__ == "__main__":
    unittest.main()
