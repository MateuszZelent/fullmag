"""Independent constrained-energy checks; these do not execute native FEM."""
import unittest
import numpy as np


def sphere_energy(q, axis, field_coefficient, total_parallel):
    m = np.array([q[0], q[1], np.sqrt(1.0 - np.dot(q, q))])
    # Bias balances the transverse anisotropy field at the accepted m0=z.
    bias = np.array([0.0, 0.0, total_parallel]) - field_coefficient * axis[2] * axis
    return -np.dot(bias, m) - 0.5 * field_coefficient * np.dot(axis, m) ** 2


class ConstrainedUniaxialEnergyTests(unittest.TestCase):
    def test_signed_coefficients_and_oblique_axes(self):
        for axis in ([1., 0., 0.], [0., 0., 1.], [.6, 0., .8], [.3, -.4, np.sqrt(.75)]):
            axis = np.asarray(axis)
            for ha in (3., -3., 0.):
                with self.subTest(axis=axis, ha=ha):
                    h, eps = 7., 2e-4
                    energy = lambda q: sphere_energy(np.asarray(q), axis, ha, h)
                    center = energy([0., 0.])
                    actual = np.zeros((2, 2))
                    for a in range(2):
                        delta = np.eye(2)[a] * eps
                        actual[a, a] = (energy(delta) - 2*center + energy(-delta))/eps**2
                    actual[0, 1] = actual[1, 0] = (
                        energy([eps, eps]) - energy([eps, -eps])
                        - energy([-eps, eps]) + energy([-eps, -eps]))/(4*eps**2)
                    expected = h*np.eye(2) - ha*np.outer(axis[:2], axis[:2])
                    np.testing.assert_allclose(actual, expected, rtol=2e-7, atol=2e-7)

    def test_anisotropy_energy_gradient_and_frozen_zeeman_misclassification(self):
        axis = np.array([.6, 0., .8])
        m0 = np.array([0., 0., 1.])
        for ha in (3., -3.):
            energy = lambda m: -.5*ha*np.dot(axis, m)**2
            field = lambda m: ha*np.dot(axis, m)*axis
            eps = 1e-5
            gradient = np.array([(energy(m0 + eps*e)-energy(m0 - eps*e))/(2*eps)
                                 for e in np.eye(3)])
            np.testing.assert_allclose(-gradient, field(m0), rtol=1e-10, atol=1e-10)
            # Treating H_K(m0) as an external field doubles its equilibrium
            # energy and loses its derivative even when H_eff(m0) agrees.
            frozen_zeeman_energy = -np.dot(field(m0), m0)
            self.assertAlmostEqual(frozen_zeeman_energy, 2*energy(m0))
            physical_derivative = (field(m0 + eps*axis)-field(m0 - eps*axis))/(2*eps)
            np.testing.assert_allclose(physical_derivative, ha*axis, rtol=1e-10, atol=1e-10)

    def test_zero_static_field_retains_easy_plane_and_exchange_curvature(self):
        # m0=z lies in the easy plane with u=x and signed Ha<0. The static
        # anisotropy field vanishes, but its derivative does not. Exchange
        # contributes H_ex(k)>0 to both directions of a Fourier perturbation.
        axis, m0, ha = np.array([1., 0., 0.]), np.array([0., 0., 1.]), -3.
        np.testing.assert_array_equal(ha*np.dot(axis, m0)*axis, np.zeros(3))
        for exchange_curvature in (0., 2.):
            energy = lambda q: (sphere_energy(np.asarray(q), axis, ha, 0.)
                                + .5*exchange_curvature*np.dot(q, q))
            eps = 2e-4
            gradient = np.array([(energy(eps*e)-energy(-eps*e))/(2*eps)
                                 for e in np.eye(2)])
            np.testing.assert_allclose(gradient, np.zeros(2), atol=1e-12)
            actual = np.array([(energy(eps*e)-2*energy([0., 0.])+energy(-eps*e))/eps**2
                               for e in np.eye(2)])
            expected = np.array([exchange_curvature-ha, exchange_curvature])
            np.testing.assert_allclose(actual, expected, rtol=1e-10, atol=1e-10)
            self.assertGreater(actual[0], 0.)
            if exchange_curvature > 0.:
                self.assertGreater(np.prod(actual), 0.)
            else:
                self.assertEqual(actual[1], 0.)  # Gamma retains a Goldstone direction.

    def test_easy_axis_has_curvature_without_external_field(self):
        eps, ha = 2e-4, 3.
        axis = np.array([0., 0., 1.])
        energy = lambda q: sphere_energy(np.asarray(q), axis, ha, ha)
        curvature = (energy([eps, 0.])-2*energy([0., 0.])+energy([-eps, 0.]))/eps**2
        self.assertAlmostEqual(curvature, ha, places=7)


if __name__ == '__main__':
    unittest.main()
