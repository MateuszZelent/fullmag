import math
import unittest
import numpy as np
from thin_film_thickness_oracle import MU0, modal_matrices, solve_thickness_modes

PARAMETERS = dict(ms_a_m=800000., exchange_j_m=13e-12, bias_t=.1,
                  thickness_m=10e-9, gamma0_m_a_s=221100.)

class ThicknessOracleTests(unittest.TestCase):
    def solve(self, geometry, k, n=1, q=128, **overrides):
        return solve_thickness_modes(**{**PARAMETERS, **overrides}, geometry=geometry,
                                     k_rad_m=k, basis_size=n, quadrature_points=q)

    def test_single_basis_equals_uniform_P00_including_continuous_zero_limit(self):
        for k in (0., 1e-5, -2e6, 25e6):
            a = abs(k)*PARAMETERS['thickness_m']
            p = 0. if a == 0 else (a/2-a*a/6 if a < 1e-5 else 1+math.expm1(-a)/a)
            field = PARAMETERS['bias_t'] + 2*PARAMETERS['exchange_j_m']/PARAMETERS['ms_a_m']*k*k
            magnetization = MU0*PARAMETERS['ms_a_m']
            for geometry in ('DE', 'BV'):
                first = field + (magnetization*p if geometry == 'DE' else 0.)
                second = field + magnetization*(1-p)
                expected = PARAMETERS['gamma0_m_a_s']/MU0/(2*math.pi)*math.sqrt(first*second)
                actual = self.solve(geometry, k)['modes'][0]['frequency_hz']
                self.assertLess(abs(actual/expected-1), 2e-12)

    def test_demag_matches_independent_split_triangle_integral(self):
        n, k, t = 3, -25e6, PARAMETERS['thickness_m']
        energy, demag = modal_matrices(**{key:value for key,value in PARAMETERS.items() if key != 'gamma0_m_a_s'},
                                       geometry='DE', k_rad_m=k, basis_size=n)
        nodes, weights = np.polynomial.legendre.leggauss(40)
        u, wu = (nodes+1)/2, weights/2
        v_lower = u[:,None]*(nodes[None,:]+1)/2
        v_upper = u[:,None] + (1-u[:,None])*(nodes[None,:]+1)/2
        a = abs(k)*t
        expected_r, expected_s = np.zeros((n,n)), np.zeros((n,n))
        for i in range(n):
            ci = math.sqrt(2-(i==0))*np.cos(i*math.pi*u)
            for j in range(n):
                norm = math.sqrt(2-(j==0))
                lower = np.sum(norm*np.cos(j*math.pi*v_lower)*np.exp(-a*(u[:,None]-v_lower))*wu[None,:],axis=1)*u
                upper = np.sum(norm*np.cos(j*math.pi*v_upper)*np.exp(-a*(v_upper-u[:,None]))*wu[None,:],axis=1)*(1-u)
                expected_r[i,j] = a/2*np.sum(wu*ci*(lower+upper))
                expected_s[i,j] = a/2*np.sum(wu*ci*(lower-upper))
        np.testing.assert_allclose(demag[:n,:n],expected_r,atol=2e-14,rtol=0)
        np.testing.assert_allclose(demag[:n,n:],1j*np.sign(k)*expected_s,atol=2e-14,rtol=0)
        np.testing.assert_allclose(demag,demag.conj().T,atol=2e-14,rtol=0)
        self.assertGreater(np.linalg.eigvalsh(energy).min(),0)

    def test_symmetric_film_has_reciprocal_frequency_and_small_oracle_residual(self):
        for geometry in ('DE','BV'):
            positive = self.solve(geometry,25e6,8)
            negative = self.solve(geometry,-25e6,8)
            self.assertEqual(len(positive['modes']),8)
            for pos,neg in zip(positive['modes'],negative['modes']):
                self.assertLess(abs(pos['frequency_hz']/neg['frequency_hz']-1),1e-12)
                self.assertLess(pos['oracle_residual_relative_l2'],1e-12)
            self.assertEqual(positive['qualification'],'diagnostic_oracle_only_not_FEM')

    def test_thickness_and_quadrature_convergence_are_separate(self):
        for geometry in ('DE','BV'):
            f8 = self.solve(geometry,25e6,8)['modes'][0]['frequency_hz']
            f16 = self.solve(geometry,25e6,16)['modes'][0]['frequency_hz']
            f32 = self.solve(geometry,25e6,32)['modes'][0]['frequency_hz']
            self.assertLess(abs(f16-f32),abs(f8-f16))
            self.assertLess(abs(f16/f32-1),1e-8)
            f32q256 = self.solve(geometry,25e6,32,q=256)['modes'][0]['frequency_hz']
            self.assertLess(abs(f32/f32q256-1),1e-10)

    def test_exchange_free_surface_branch_converges_to_exact_damon_eshbach(self):
        # Magnetostatic open-film DE branch, not the lowest dipole-exchange band.
        field, magnetization = PARAMETERS["bias_t"], MU0 * PARAMETERS["ms_a_m"]
        conversion = PARAMETERS["gamma0_m_a_s"] / (2 * math.pi * MU0)
        for kt in (0.25, 1.0, 2.0):
            exact = conversion * math.sqrt(field * (field + magnetization)
                + magnetization**2 / 4 * (-math.expm1(-2 * kt)))
            errors = []
            for n in (8, 16, 32):
                report = self.solve("DE", kt / PARAMETERS["thickness_m"], n=n, q=256,
                                    exchange_j_m=0.)
                # At A=0 the isolated surface branch is the highest positive mode.
                surface = report["modes"][-1]
                errors.append(abs(surface["frequency_hz"] / exact - 1))
                self.assertLess(surface["oracle_residual_relative_l2"], 1e-12)
            with self.subTest(kt=kt):
                self.assertLess(errors[1], errors[0])
                self.assertLess(errors[2], errors[1])
                self.assertLess(errors[2], 2e-7)

    def test_exchange_free_gamma_limit_has_no_artificial_basis_splitting(self):
        expected = PARAMETERS["gamma0_m_a_s"] / (2 * math.pi * MU0) * math.sqrt(
            PARAMETERS["bias_t"] * (PARAMETERS["bias_t"] + MU0 * PARAMETERS["ms_a_m"]))
        for geometry in ("DE", "BV"):
            report = self.solve(geometry, 0., n=8, exchange_j_m=0.)
            for mode in report["modes"]:
                self.assertLess(abs(mode["frequency_hz"] / expected - 1), 2e-12)

    def test_rejects_invalid_parameters_without_silent_defaults(self):
        for key in PARAMETERS:
            for bad in (True,float('nan'),float('inf')):
                with self.subTest(key=key,bad=bad), self.assertRaises(ValueError):
                    self.solve('DE',25e6,**{key:bad})
        for n in (0,65,True,1.5):
            with self.assertRaises(ValueError): self.solve('DE',25e6,n=n)
        for q in (15,513,True,16):
            with self.assertRaises(ValueError): self.solve('DE',25e6,n=16,q=q)
        with self.assertRaises(ValueError): self.solve('unknown',25e6)
        with self.assertRaises(ValueError): self.solve('DE',float('nan'))
        with self.assertRaises(ValueError): self.solve('DE',25e6,gamma0_m_a_s=1e308)
        with self.assertRaises(ValueError): self.solve('DE',25e6,exchange_j_m=-1e-12)
        with self.assertRaises(ValueError): self.solve('DE',25e6,ms_a_m=0)

if __name__ == '__main__': unittest.main()
