"""Independent strip integrals and aperture regressions for return diagnostics."""
import importlib
import math
import unittest
import numpy as np
from scipy.integrate import quad

try:
    analysis=importlib.import_module("diagnose_sushruth_single_strip_return")
except ModuleNotFoundError:
    analysis=None

class SingleReturnTests(unittest.TestCase):
    def implementation(self):
        self.assertIsNotNone(analysis,"Single-strip return diagnostic is not implemented")
        return analysis

    def test_zero_mode_and_hermitian_symmetry(self):
        module=self.implementation()
        k=np.array([0.,1e6,9e6])
        args=dict(width_m=200e-9,return_width_m=2e-6,gap_m=400e-9)
        positive=module.pair_spectrum(k,**args)
        negative=module.pair_spectrum(-k,**args)
        self.assertEqual(positive[0],0j)
        np.testing.assert_allclose(negative,positive.conjugate(),rtol=1e-14,atol=1e-15)

    def test_signed_strip_integral_independent_of_sinc_formula(self):
        module=self.implementation()
        width,return_width,gap=200e-9,2e-6,400e-9
        k=np.array([-13e6,-1e6,0.,2e6,9e6])
        expected=module.pair_spectrum(k,width_m=width,return_width_m=return_width,gap_m=gap)
        errors=[]
        for count in [256,512,1024]:
            actual=np.zeros(k.size,dtype=complex)
            for low,high,sign in [(-width/2,width/2,1.),(width/2+gap,width/2+gap+return_width,-1.)]:
                x=low+(np.arange(count)+.5)*(high-low)/count
                actual+=sign*np.mean(np.exp(1j*k[:,None]*x),axis=1)
            errors.append(np.max(abs(actual-expected)))
        self.assertLess(errors[-1],1e-4)
        self.assertGreater(errors[-2]/errors[-1],3.9)

    def test_aperture_changes_observable_without_renormalizing(self):
        module=self.implementation()
        k=np.array([0.,1e6,9e6])
        args=dict(width_m=200e-9,return_width_m=2e-6,gap_m=16e-6)
        local=module.pair_spectrum(k,half_window_m=8e-6,**args)
        np.testing.assert_allclose(local,np.sinc(k*args["width_m"]/(2*math.pi)),rtol=1e-14,atol=1e-15)
        clipped=module.pair_spectrum(k,half_window_m=args["width_m"]/4,**args)
        self.assertEqual(clipped[0],.5+0j)
        wide=module.pair_spectrum(k,half_window_m=1e-3,**args)
        np.testing.assert_allclose(wide,module.pair_spectrum(k,**args),rtol=0,atol=0)

    def test_finite_band_integral_against_independent_quadrature(self):
        module=self.implementation()
        for width in [200e-9,2e-6]:
            for maximum in [1.,1e6,30e6]:
                def integrand(u):
                    x=maximum*u*width/2
                    return 1. if x==0 else (math.sin(x)/x)**2
                expected=maximum*quad(integrand,0,1,epsabs=1e-13,epsrel=1e-13,limit=200)[0]
                self.assertAlmostEqual(module.strip_power_integral(width,maximum)/expected,1.,places=12)
        self.assertEqual(module.strip_power_integral(200e-9,0.),0.)

    def test_invalid_inputs_are_rejected(self):
        module=self.implementation()
        good=dict(width_m=200e-9,return_width_m=2e-6,gap_m=16e-6)
        for change in [dict(width_m=0.),dict(return_width_m=-1.),dict(gap_m=-1.),
                       dict(half_window_m=0.),dict(half_window_m=float("nan"))]:
            with self.assertRaises(ValueError):
                module.pair_spectrum(np.array([0.]),**{**good,**change})
        with self.assertRaises(ValueError):
            module.pair_spectrum(np.array([float("nan")]),**good)

if __name__=="__main__":
    unittest.main()
