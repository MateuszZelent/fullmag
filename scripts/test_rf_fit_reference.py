"""Tests for the Cartesian finite-integration Maxwell reference."""

import unittest

import numpy as np
from scipy.constants import epsilon_0, mu_0

from rf_fit_reference import assemble


class FitReferenceTest(unittest.TestCase):
    def test_incidence_complex_and_uniform_material_weights(self):
        axes = tuple(np.arange(4) * spacing for spacing in (0.2, 0.3, 0.4))
        fit = assemble(axes, conductivity_spm=2., relative_permittivity=3., frequency_hz=1e6)
        self.assertEqual((fit.curl @ fit.gradient).nnz, 0)
        self.assertEqual((fit.divergence @ fit.curl).nnz, 0)
        edge = fit.edge_ids[0][1, 1, 1]
        face = fit.face_ids[0][1, 1, 1]
        self.assertAlmostEqual(fit.sigma_s[edge], 2 * .3 * .4 / .2)
        self.assertAlmostEqual(fit.epsilon_f[edge] / epsilon_0, 3 * .3 * .4 / .2)
        self.assertAlmostEqual(fit.nu_per_h[face] * mu_0, .2 / (.3 * .4))
        corner = fit.edge_ids[0][1, 0, 0]
        self.assertAlmostEqual(fit.sigma_s[corner], fit.sigma_s[edge] / 4)

    def test_dual_area_resolves_an_aligned_dielectric_interface(self):
        axes = (np.array([0., 2., 3.]), np.array([0., 1., 3.]), np.array([0., .25, 1.]))
        epsilon = np.ones((2, 2, 2))
        epsilon[:, 1, :] = 7.
        fit = assemble(axes, 0., epsilon, 1e6)
        edge = fit.edge_ids[0][0, 1, 1]
        expected = (.5 * 1. + 1. * 7.) * (.125 + .375) / 2.
        self.assertAlmostEqual(fit.epsilon_f[edge] / epsilon_0, expected)

    def test_tangential_pec_cavity_discrete_eigenmode(self):
        cells = np.array([7, 5, 4])
        size = np.array([.23, .17, .09])
        axes = tuple(np.linspace(0., length, n+1) for length, n in zip(size, cells, strict=True))
        dx, dy, _ = size / cells
        kx = 2 * np.sin(np.pi / (2*cells[0])) / dx
        ky = 2 * np.sin(np.pi / (2*cells[1])) / dy
        f = np.hypot(kx, ky) / (2 * np.pi * np.sqrt(mu_0*epsilon_0))
        fit = assemble(axes, 0., 1., f)
        e = np.zeros(len(fit.edges))
        ez = (np.sin(np.pi * axes[0] / size[0])[:, None, None]
              * np.sin(np.pi * axes[1] / size[1])[None, :, None] * size[2]/cells[2])
        e[fit.edge_ids[2]] = np.broadcast_to(ez, fit.edge_ids[2].shape)
        e[fit.boundary_edges] = 0.
        free = np.setdiff1d(np.arange(len(e)), fit.boundary_edges)
        lhs = (fit.curl_matrix @ e)[free]
        rhs = (fit.omega**2 * fit.epsilon_f * e)[free]
        np.testing.assert_allclose(lhs, rhs, atol=5e-8, rtol=2e-13)

    def test_sampling_preserves_constant_e_and_faraday_sign(self):
        axes = tuple(np.array([0., .3, 1.]) for _ in range(3))
        f = 1e6
        fit = assemble(axes, 0., 1., f)
        x, y, z = np.meshgrid(*axes, indexing="ij")
        e = fit.gradient @ (3*x + 5*y - 2*z).ravel()
        # Add E_y = 4*x so curl E is +4 e_z.
        e[fit.edge_ids[1]] += 4*x[:, :-1, :] * np.diff(axes[1])[None, :, None]
        points = np.array([[.1, .2, .4], [.4, .3, .3]])
        electric, magnetic = fit.sample(e, points, curl_edge_v=e)
        np.testing.assert_allclose(electric, [[3., 5.4, -2.], [3., 6.6, -2.]])
        expected_hz = -4 / (1j * fit.omega * mu_0)
        np.testing.assert_allclose(magnetic, [[0, 0, expected_hz]] * 2, atol=1e-13)

    def test_driven_ece_current_balance_and_local_passive_load(self):
        axes = tuple(np.linspace(0., length, 7) for length in (.008, .005, .004))
        fit = assemble(axes, 3., 2., 8e8)
        nodes = np.arange(len(fit.points_m)).reshape(7, 7, 7)
        terminals = {
            "in": nodes[0, 2:4, 2:4].ravel(),
            "ground": nodes[0, 4:6, 2:4].ravel(),
            "out": nodes[-1, 2:4, 2:4].ravel(),
            "out_gnd_left": nodes[-1, :2, 2:4].ravel(),
            "out_gnd_right": nodes[-1, 4:6, 2:4].ravel(),
        }
        returns = ("out_gnd_left", "out_gnd_right")
        impedance = 50 + 10j
        solution = fit.solve_ece(terminals, {"in": 1., "ground": 0.}, {},
                                 floating_load=("out", returns, impedance))
        self.assertLess(solution.relative_residual, 1e-9)
        currents, volts = solution.terminal_currents_a, solution.terminal_voltages_v
        self.assertGreater(abs(currents["in"]), 1e-5)
        self.assertLess(abs(sum(currents.values())), 1e-10)
        self.assertEqual(volts[returns[0]], volts[returns[1]])
        load_current = (volts["out"] - volts[returns[0]]) / impedance
        self.assertLess(abs(currents["out"] + load_current), 1e-10)
        self.assertLess(abs(sum(currents[name] for name in returns) - load_current), 1e-10)
        self.assertGreater(solution.power_joule_w, 0.)
        self.assertAlmostEqual(solution.power_in_w, solution.power_joule_w, places=11)

    def test_cpw_metallization_defaults_and_measured_override(self):
        from run_rf_fit_cpw import metal_conductivity

        self.assertEqual(metal_conductivity("copper", None)[0], 5.88e7)
        self.assertAlmostEqual(metal_conductivity("gold", None)[0], 1 / 2.44e-8)
        self.assertEqual(metal_conductivity("gold", 1.8e7), (1.8e7, "explicit"))
        for invalid in (0, -1, np.nan, np.inf):
            with self.assertRaises(ValueError):
                metal_conductivity("gold", invalid)

    def test_local_refinement_preserves_cpw_interfaces_and_terminals(self):
        from rf_cpw_reference import make_case
        from run_rf_fit_cpw import refine_gap_edges

        base = make_case(2, refinement=2, output_return="local-gsg")
        refined = refine_gap_edges(base)
        np.testing.assert_array_equal(base.axes_m[0], refined.axes_m[0])
        self.assertEqual(base.strips_m, refined.strips_m)
        self.assertEqual(base.floating_load, refined.floating_load)
        for axis, fine in zip(base.axes_m[1:], refined.axes_m[1:], strict=True):
            np.testing.assert_array_equal(fine[np.searchsorted(fine, axis)], axis)
            self.assertGreater(len(fine), len(axis))
        for name, indices in base.terminals.items():
            first, after = base.points_m[indices], refined.points_m[refined.terminals[name]]
            np.testing.assert_array_equal(first.min(axis=0), after.min(axis=0))
            np.testing.assert_array_equal(first.max(axis=0), after.max(axis=0))
        def metal_volume(case):
            widths = np.meshgrid(*(np.diff(a) for a in case.axes_m), indexing="ij")
            return np.prod(widths, axis=0).ravel() @ (case.material_id[::6] == 1)
        np.testing.assert_allclose(metal_volume(refined), metal_volume(base), rtol=1e-13, atol=0)


if __name__ == "__main__":
    unittest.main()
