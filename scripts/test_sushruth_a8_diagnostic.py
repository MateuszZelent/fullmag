"""Independent equation checks; no new solver or fitted phase."""
import cmath
import math
import unittest

from reference_sushruth_2020_response import film_susceptibility


class SushruthA8DiagnosticTests(unittest.TestCase):
    def test_factor_matches_direct_published_a8_in_cycles_per_second(self):
        from reference_sushruth_2020_a8_diagnostic import a8_numerator_factor
        for alpha in (.01,.03,.07,.1):
            for frequency in (6e9,7.5e9,9e9):
                for k in (0.,1e6,5e6,1e7):
                    x=abs(k)*20e-9;n=0. if x==0 else 1+math.expm1(-x)/x
                    denominator=30e9**2*.25*(.25+n*.89)-frequency**2+1j*frequency*alpha*30e9*(.5+n*.89)
                    direct=30e9*.89*(30e9*.25+1j*alpha*frequency)/denominator
                    value=film_susceptibility(k,frequency,alpha=alpha)*a8_numerator_factor(frequency,alpha=alpha)
                    self.assertLess(abs(value-direct),2e-13*max(1.,abs(direct)))

    def test_zero_damping_factor_is_identity_but_integral_still_refuses_it(self):
        from reference_sushruth_2020_a8_diagnostic import a8_numerator_factor
        self.assertEqual(a8_numerator_factor(7.5e9,alpha=0.),1.+0j)
        with self.assertRaises(ValueError):film_susceptibility(0.,7.5e9,alpha=0.)

    def test_negative_frequency_and_zero_frequency_have_expected_symmetry(self):
        from reference_sushruth_2020_a8_diagnostic import a8_numerator_factor
        for alpha in (.01,.1):
            self.assertEqual(a8_numerator_factor(-9e9,alpha=alpha),a8_numerator_factor(9e9,alpha=alpha).conjugate())
            self.assertEqual(a8_numerator_factor(0.,alpha=alpha),1.+0j)

    def test_factors_commute_with_an_independent_complex_weighted_sum(self):
        from reference_sushruth_2020_a8_diagnostic import a8_numerator_factor
        factor=a8_numerator_factor(9e9,alpha=.03)
        weights=(.2,-.7,1.3);values=(2+3j,-1+.5j,.2-1.7j)
        self.assertLess(abs(factor*sum(w*z for w,z in zip(weights,values))-sum(w*(factor*z) for w,z in zip(weights,values))),1e-14)

    def test_uniform_free_pole_is_a_root_of_the_a5_matrix(self):
        from reference_sushruth_2020_a8_diagnostic import uniform_free_pole_hz
        for alpha in (0.,.01,.03,.07,.1):
            pole=uniform_free_pole_hz(alpha=alpha);z=pole/7.5e9
            self.assertLess(abs((1+1j*alpha*z)**2-z**2),2e-15)
            self.assertGreaterEqual(pole.imag,0.)
        self.assertEqual(uniform_free_pole_hz(alpha=0.),7.5e9+0j)

    def test_pole_units_scale_with_gamma_and_effective_field(self):
        from reference_sushruth_2020_a8_diagnostic import uniform_free_pole_hz
        a=uniform_free_pole_hz(alpha=.03)
        self.assertEqual(uniform_free_pole_hz(alpha=.03,gamma_hz_per_t=60e9),2*a)
        self.assertEqual(uniform_free_pole_hz(alpha=.03,mu0_h_eff_t=.5),2*a)

    def test_invalid_inputs_never_emit_nonfinite_diagnostics(self):
        from reference_sushruth_2020_a8_diagnostic import a8_numerator_factor,uniform_free_pole_hz
        for options in ({'alpha':-1.},{'alpha':True},{'alpha':float('nan')},
                        {'mu0_h_eff_t':0.},{'gamma_hz_per_t':0.},
                        {'mu0_h_eff_t':1e308,'gamma_hz_per_t':1e308}):
            for function in (a8_numerator_factor,uniform_free_pole_hz):
                with self.subTest(options=options,function=function.__name__),self.assertRaises(ValueError):
                    parameters={'alpha':.01}|options
                    if function is a8_numerator_factor:function(9e9,**parameters)
                    else:function(**parameters)
        for frequency in (True,float('nan'),float('inf')):
            with self.assertRaises(ValueError):a8_numerator_factor(frequency,alpha=.01)


if __name__=='__main__':unittest.main()
