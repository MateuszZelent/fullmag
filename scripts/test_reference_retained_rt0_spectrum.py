"""Independent physical invariants for retained-current spectrum postprocessing."""
import importlib
import itertools
import math
import unittest
import numpy as np
from scipy.integrate import quad
from scipy.special import k1

try:
    audit = importlib.import_module("reference_retained_rt0_spectrum")
except ModuleNotFoundError:
    audit = None

# Catch missing 1/6, factor 2/pi, RT0 orientation, dropped Jz and Fourier sign.
def box_source(lo, hi, current, divisions=(4, 12, 2)):
    vertices, coefficients = [], []
    axes = [np.linspace(lo[i], hi[i], divisions[i]+1) for i in range(3)]
    winding = ((1,2,3),(0,3,2),(0,1,3),(0,2,1))
    for index in itertools.product(*(range(n) for n in divisions)):
        base = np.array([axes[i][index[i]] for i in range(3)])
        step = np.array([axes[i][index[i]+1]-base[i] for i in range(3)])
        for permutation in itertools.permutations(range(3)):
            points = [base.copy()]
            for axis in permutation:
                point = points[-1].copy()
                point[axis] += step[axis]
                points.append(point)
            points = np.array(points)
            if np.linalg.det((points[1:]-points[0]).T) < 0:
                points[[1,2]] = points[[2,1]]
            flux = []
            for a,b,c in winding:
                flux.append(np.dot(current,np.cross(points[b]-points[a],points[c]-points[a])))
            vertices.append(points)
            coefficients.append(flux)
    return np.array(vertices), np.array(coefficients)

class RetainedSpectrumTests(unittest.TestCase):
    def implementation(self):
        self.assertIsNotNone(audit, "Retained 3D-current Fourier postprocessor is not implemented")
        return audit

    def test_duffy_reference_volume_and_linear_moments(self):
        module = self.implementation()
        for order in (2,3,4):
            bary, weights = module.tetra_rule(order)
            self.assertAlmostEqual(float(np.sum(weights)),1/6,places=14)
            np.testing.assert_allclose(weights @ bary,np.full(4,1/24),rtol=1e-14)
            np.testing.assert_allclose(bary.sum(axis=1),1,atol=2e-16)

    def test_rt0_integrated_constant_current_has_physical_volume(self):
        module = self.implementation()
        length = 1e-6
        vertices = length*np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        coefficients = length**2*np.array([[9.,-2.,-3.,-4.]])
        bary, weights = module.tetra_rule(2)
        total = np.zeros((1,3),dtype=np.longdouble)
        for point, weight in zip(bary,weights):
            position, numerator = module.rt0_sample_moment(vertices,coefficients,point)
            total += weight*numerator
            np.testing.assert_allclose(position[0],point @ vertices[0],rtol=1e-14,atol=1e-22)
        np.testing.assert_allclose(total[0],[2e-18/6,3e-18/6,4e-18/6],rtol=1e-14)

    def test_bessel_kernel_matches_independent_cosine_integral(self):
        module = self.implementation()
        a = 43.7e-9
        for eta in (0.,.5,2.,5.):
            expected = (1. if eta==0 else quad(lambda t:(1+t*t)**(-1.5),0,np.inf,
                weight="cos",wvar=eta,epsabs=1e-12,limit=300)[0])/a**2
            actual = module.line_kernel(np.array([eta/a,-eta/a]),np.array([a]))
            np.testing.assert_allclose(actual,expected,rtol=1e-10)

    def test_finite_prism_zero_mode_against_elementary_antiderivative(self):
        module = self.implementation()
        lo,hi = np.array([-.1,-.3,.15])*1e-6,np.array([.1,.3,.25])*1e-6
        vertices,coeff = box_source(lo,hi,np.array([0.,3.,0.]))
        value,bound = module.field_spectrum(vertices,coeff,np.array([0.]),y_m=0.,z_m=0.,order=6)
        b,a0,a1 = hi[1],lo[2],hi[2]
        integral = a1*math.atan(b/a1)-a0*math.atan(b/a0)+b/2*math.log((a1*a1+b*b)/(a0*a0+b*b))
        expected = -integral/(math.pi*(a1-a0))
        current = 3*(hi[0]-lo[0])*(hi[2]-lo[2])
        np.testing.assert_allclose(value/current,[expected],rtol=1e-7,atol=1e-9)
        self.assertGreaterEqual(bound[0],abs(value[0]))

    def test_prism_complex_spectrum_translation_and_current_reversal(self):
        module = self.implementation()
        lo,hi = np.array([-.1,-.3,.15])*1e-6,np.array([.1,.3,.25])*1e-6
        vertices,coeff = box_source(lo,hi,np.array([0.,3.,0.]))
        k = np.array([-9e6,3e6,9e6])
        coarse,_ = module.field_spectrum(vertices,coeff,k,y_m=0.,z_m=0.,order=2)
        fine,_ = module.field_spectrum(vertices,coeff,k,y_m=0.,z_m=0.,order=6)
        current = 3*(hi[0]-lo[0])*(hi[2]-lo[2])
        expected = []
        for wave in k:
            q = abs(wave)
            inner = lambda a: quad(lambda v:k1(q*a*math.cosh(v)),
                    -math.asinh(hi[1]/a),math.asinh(hi[1]/a),epsabs=1e-11)[0]*a*q
            result = quad(inner,lo[2],hi[2],epsabs=1e-18)[0]
            expected.append(-np.sinc(wave*(hi[0]-lo[0])/(2*math.pi))*result/(2*math.pi*(hi[2]-lo[2])))
        expected = np.array(expected)
        np.testing.assert_allclose(fine/current,expected,rtol=1e-7,atol=1e-9)
        self.assertLess(np.linalg.norm(fine/current-expected),np.linalg.norm(coarse/current-expected))
        delta = 157e-9
        shifted = vertices.copy()
        shifted[:,:,0] += delta
        moved,_ = module.field_spectrum(shifted,-coeff,k,y_m=0.,z_m=0.,order=6)
        np.testing.assert_allclose(moved,-fine*np.exp(1j*k*delta),rtol=1e-12,atol=1e-24)
        np.testing.assert_allclose(fine[0],fine[-1].conjugate(),rtol=1e-12,atol=1e-24)

    def test_vertical_current_component_and_y_offset(self):
        module = self.implementation()
        lo,hi = np.array([-.1,-.3,.15])*1e-6,np.array([.1,.3,.25])*1e-6
        vertices,coeff = box_source(lo,hi,np.array([0.,0.,2.]))
        k = np.array([3e6])
        value,_ = module.field_spectrum(vertices,coeff,k,y_m=.4e-6,z_m=0.,order=6)
        roots,weights = np.polynomial.legendre.leggauss(100)
        y = (lo[1]+hi[1])/2+(hi[1]-lo[1])*roots[:,None]/2
        z = (lo[2]+hi[2])/2+(hi[2]-lo[2])*roots[None,:]/2
        dy,dz = .4e-6-y,-z
        radius = np.hypot(dy,dz)
        yz = np.sum(weights[:,None]*weights[None,:]*(-2*dy)*(k[0]/radius)*k1(k[0]*radius))
        expected = yz*(hi[1]-lo[1])*(hi[2]-lo[2])/4*(hi[0]-lo[0])*np.sinc(k[0]*(hi[0]-lo[0])/(2*math.pi))/(2*math.pi)
        np.testing.assert_allclose(value,[expected],rtol=1e-7,atol=1e-24)

    def test_nonseparated_or_nonfinite_source_is_rejected(self):
        module = self.implementation()
        vertices=np.array([[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]]])
        for z,k in ((0.,[1.]),(.5,[1.]),(-1.,[float("nan")])):
            with self.assertRaises(ValueError):
                module.field_spectrum(vertices,np.ones((1,4)),np.array(k),y_m=0.,z_m=z,order=2)

if __name__=="__main__":
    unittest.main()
