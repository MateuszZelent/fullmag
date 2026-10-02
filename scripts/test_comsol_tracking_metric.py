"""Analytic fixtures only: these tests are not FEM runtime evidence."""
import unittest
import numpy as np
from comsol_tracking_metric import Tet4TrackingMetric


class TrackingMetricTests(unittest.TestCase):
    def setUp(self):
        self.nodes = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1.]])
        self.metric = Tet4TrackingMetric(self.nodes, [[0, 1, 2, 3]], [0])
        self.x = np.tile([1., 0, 0], (4, 1)).astype(complex)
        self.y = np.tile([0., 1, 0], (4, 1)).astype(complex)

    def test_consistent_mass_off_diagonal(self):
        a, b = np.zeros((4, 3)), np.zeros((4, 3))
        a[0, 0], b[1, 0] = 1, 1
        self.assertAlmostEqual(self.metric.overlap(a, b), .5)

    def test_amplitude_not_squared(self):
        self.assertAlmostEqual(self.metric.overlap(self.x, self.x + self.y), 2 ** -.5)

    def test_signed_bloch_demodulation(self):
        for k in ([2, -3, 5], [-2, 3, -5], [0, 0, 0]):
            physical = self.x * np.exp(-1j * (self.nodes @ k))[:, None]
            np.testing.assert_allclose(self.metric.envelope(physical, k), self.x, atol=1e-14)

    def test_rotated_degenerate_basis(self):
        rotated = [(self.x + 1j * self.y) / np.sqrt(2),
                   (1j * self.x + self.y) / np.sqrt(2)]
        np.testing.assert_allclose(self.metric.principal_cosines([self.x, self.y], rotated), [1, 1])

    def test_rank_deficiency_rejected(self):
        with self.assertRaisesRegex(ValueError, "rank-deficient"):
            self.metric.principal_cosines([self.x, self.x], [self.x, self.y])

    def test_large_small_amplitudes(self):
        self.assertAlmostEqual(self.metric.overlap(self.x * 1e300, self.x * 1e-300), 1)

    def test_air_nodes_do_not_change_overlap(self):
        nodes = np.vstack([self.nodes, [3, 3, 3]])
        metric = Tet4TrackingMetric(nodes, [[0, 1, 2, 3]], [0])
        a = np.vstack([self.x, [1e200, 0, 0]])
        b = np.vstack([self.y, [1e200, 0, 0]])
        self.assertEqual(metric.overlap(a, b), 0)

    def test_invalid_k_and_zero_field(self):
        for k in ([True, 0, 0], ["1", "0", "0"], [float("nan"), 0, 0]):
            with self.assertRaises(ValueError):
                self.metric.envelope(self.x, k)
        with self.assertRaisesRegex(ValueError, "zero magnetic"):
            self.metric.overlap(self.x * 0, self.y)

    def test_disjoint_subspaces(self):
        z = np.tile([0., 0, 1], (4, 1)).astype(complex)
        np.testing.assert_allclose(
            self.metric.principal_cosines([self.x, self.y], [self.x, z]), [0, 1]
        )


if __name__ == "__main__":
    unittest.main()
