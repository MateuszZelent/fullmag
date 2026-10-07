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

    def test_transport_recovers_previous_frame_for_next_edge(self):
        rotated = [(self.x + 1j * self.y) / np.sqrt(2),
                   (1j * self.x + self.y) / np.sqrt(2)]
        cosines, frames = self.metric.transport([self.x, self.y], rotated)
        np.testing.assert_allclose(cosines, [1, 1])
        self.assertAlmostEqual(self.metric.overlap(frames[0], self.x), 1)
        self.assertAlmostEqual(self.metric.overlap(frames[1], self.y), 1)
        self.assertAlmostEqual(self.metric.overlap(rotated[0], self.x), 2 ** -.5)

    def test_complex_three_cycle_distinguishes_assignment_transpose(self):
        from comsol_tracking_assignment import maximum_weight_assignment
        z = np.tile([0., 0, 1.], (4, 1)).astype(complex)
        previous = [self.x, self.y, z]
        current = [1j * self.y, np.exp(.4j) * z, self.x]
        cosines, frames, weights = self.metric.transport_with_assignment_weights(previous, current)
        # Previous rows x,y,z map to current columns 2,0,1. Transposing
        # these nonsymmetric moduli would incorrectly select 1,2,0.
        expected = np.array([[0., 0, 1], [1., 0, 0], [0., 1, 0]])
        np.testing.assert_allclose(weights, expected, atol=1e-14)
        np.testing.assert_allclose(cosines, [1., 1, 1])
        assignment, weight = maximum_weight_assignment(weights)
        self.assertEqual(assignment, [2, 0, 1])
        self.assertAlmostEqual(weight, 3.)
        for frame, target in zip(frames, previous, strict=True):
            self.assertAlmostEqual(self.metric.overlap(frame, target), 1.)

    def test_persisted_metric_matches_geometry(self):
        record = {"schema": "fullmag.tracking_consistent_p1_metric.v1",
                  "definition_id": "consistent_p1_tet4_cartesian_nodal_envelope.v1",
                  "source_mesh_topology_sha256": "sha256:test",
                  "physical_node_indices": [0, 1, 2, 3],
                  "tetra": [[0, 1, 2, 3]], "volumes_m3": [1/6]}
        self.metric.validate_persisted_metric(record, "sha256:test")
        for key, value in (("volumes_m3", [1/3]), ("tetra", [[0, 1, 3, 2]]),
                           ("physical_node_indices", [0, 1, 2, True]),
                           ("source_mesh_topology_sha256", "sha256:other")):
            with self.subTest(key=key), self.assertRaises(ValueError):
                self.metric.validate_persisted_metric({**record, key: value}, "sha256:test")


if __name__ == "__main__":
    unittest.main()
