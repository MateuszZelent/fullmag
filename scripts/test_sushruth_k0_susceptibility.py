"""Exact A5 checks for the k=0 RF control; no solver execution."""
import unittest
import numpy as np

from reference_sushruth_2020_response import film_susceptibility


class SushruthK0SusceptibilityTests(unittest.TestCase):
    def test_matches_independent_two_by_two_A5_solve_in_hz(self):
        from reference_sushruth_2020_a8_diagnostic import uniform_susceptibility
        for alpha in (.01,.03,.07,.1):
            for f in (6e9,7.5e9,9e9):
                matrix = np.array([[30e9*.25+1j*alpha*f,-1j*f],
                                   [1j*f,30e9*.25+1j*alpha*f]])
                expected = np.linalg.solve(matrix,np.array([30e9*.89,0.]))
                measured = uniform_susceptibility(f,alpha=alpha)
                np.testing.assert_allclose(measured,expected,rtol=2e-13,atol=2e-13)

    def test_static_limit_and_negative_frequency_symmetry(self):
        from reference_sushruth_2020_a8_diagnostic import uniform_susceptibility
        xx,yx=uniform_susceptibility(0.,alpha=.01)
        self.assertEqual(xx,.89/.25+0j)
        self.assertEqual(yx,0j)
        positive=uniform_susceptibility(9e9,alpha=.03)
        self.assertEqual(uniform_susceptibility(-9e9,alpha=.03),tuple(z.conjugate() for z in positive))
        self.assertLess(positive[0].imag,0.)

    def test_keeps_alpha_squared_distinct_from_weak_damping_Eq1(self):
        from reference_sushruth_2020_a8_diagnostic import uniform_susceptibility
        exact,_=uniform_susceptibility(7.5e9,alpha=.01)
        approximate=film_susceptibility(0.,7.5e9,alpha=.01)
        self.assertGreater(abs(exact-approximate),.5)

    def test_invalid_inputs_refuse_instead_of_returning_nonfinite(self):
        from reference_sushruth_2020_a8_diagnostic import uniform_susceptibility
        for overrides in ({'frequency_hz':True},{'frequency_hz':float('nan')},
                          {'alpha':0.},{'alpha':-1.},{'alpha':True},
                          {'mu0_ms_t':0.},{'mu0_h_eff_t':0.},
                          {'gamma_hz_per_t':float('inf')},
                          {'mu0_ms_t':1e308,'mu0_h_eff_t':1e-308}):
            with self.subTest(overrides=overrides),self.assertRaises(ValueError):
                uniform_susceptibility(**({'frequency_hz':7.5e9,'alpha':.01}|overrides))


if __name__=='__main__':unittest.main()
