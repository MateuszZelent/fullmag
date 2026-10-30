"""Analytic fixtures only: these tests are not FEM runtime evidence."""
import copy
import hashlib
import struct
import unittest

import numpy as np

from comsol_tracking_metric import Tet4TrackingMetric


def _typed_field(name, kind, value):
    encoded = name.encode("utf-8")
    return (
        struct.pack(">Q", len(encoded))
        + encoded
        + bytes([kind])
        + struct.pack(">Q", len(value))
        + value
    )


def _typed_digest(schema, fields):
    payload = _typed_field("schema", 1, schema.encode("utf-8"))
    payload += b"".join(_typed_field(name, kind, value) for name, kind, value in fields)
    return list(hashlib.sha256(payload).digest())


def _native_v2_record(metric, source):
    rows = len(metric.nodes)
    entries = [dict() for _ in range(rows)]
    for connectivity, volume in zip(metric.cells, metric.volumes_m3, strict=True):
        coefficient = float(volume) / 20.0
        for row in connectivity:
            for column in connectivity:
                row, column = int(row), int(column)
                entries[row][column] = entries[row].get(column, 0.0) \
                    + coefficient * (2.0 if row == column else 1.0)
    row_offsets = [0]
    columns = []
    values_m3 = []
    for row in entries:
        for column in sorted(row):
            columns.append(column)
            values_m3.append(row[column])
        row_offsets.append(len(columns))
    canonical_vertex_ids = list(range(rows))
    scalar_dof_ids = list(range(rows))
    be_u64 = lambda value: struct.pack(">Q", value)
    be_u32 = lambda value: struct.pack(">I", value)
    be_f64 = lambda value: struct.pack(">d", value if value != 0.0 else 0.0)
    csr_payload = b"".join(be_u64(value) for value in row_offsets)
    csr_payload += b"".join(be_u32(value) for value in columns)
    csr_payload += b"".join(be_f64(value) for value in values_m3)
    csr_sha256 = _typed_digest(
        "mfem_tracking_mass.csr.v1", [("payload_be", 3, csr_payload)]
    )
    map_sha256 = _typed_digest(
        "mfem_tracking_mass.canonical_dof_map.v1",
        [
            ("vertex_count", 2, be_u64(rows)),
            (
                "canonical_vertex_ids_be",
                3,
                b"".join(be_u32(value) for value in canonical_vertex_ids),
            ),
            (
                "scalar_dof_ids_be",
                3,
                b"".join(be_u32(value) for value in scalar_dof_ids),
            ),
        ],
    )
    hashes = {
        "topology_sha256": [1] * 32,
        "marker_map_sha256": [2] * 32,
        "element_mask_sha256": [3] * 32,
        "canonical_dof_map_sha256": map_sha256,
        "csr_sha256": csr_sha256,
        "source_snapshot_sha256": [4] * 32,
    }
    identity_fields = [
        ("generation", 2, be_u64(1)),
        ("canonical_vertex_count", 2, be_u64(rows)),
        ("nonzero_count", 2, be_u64(len(values_m3))),
        ("magnetic_volume_m3", 4, be_f64(float(np.sum(metric.volumes_m3)))),
    ]
    identity_fields.extend(
        (name, 3, bytes(hashes[name]))
        for name in (
            "topology_sha256", "marker_map_sha256", "element_mask_sha256",
            "canonical_dof_map_sha256", "csr_sha256", "source_snapshot_sha256",
        )
    )
    hashes["identity_sha256"] = _typed_digest(
        "mfem_tracking_mass.snapshot_identity.v1", identity_fields
    )
    native_snapshot = {
        "generation": 1,
        "magnetic_volume_m3": float(np.sum(metric.volumes_m3)),
        "row_offsets": row_offsets,
        "columns": columns,
        "values_m3": values_m3,
        "canonical_vertex_ids": canonical_vertex_ids,
        "scalar_dof_ids": scalar_dof_ids,
        **hashes,
    }
    return {
        "schema": "fullmag.tracking_consistent_p1_metric.v2",
        "definition_id": "consistent_p1_native_csr_cartesian_nodal_envelope.v2",
        "source_mesh_topology_sha256": source,
        "physical_node_indices": metric.support.tolist(),
        "native_snapshot": native_snapshot,
    }


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

    def test_persisted_native_v2_matches_analytic_tet4_mass_with_air_row(self):
        nodes = np.vstack([self.nodes, [3., 3., 3.]])
        metric = Tet4TrackingMetric(nodes, [[0, 1, 2, 3]], [0])
        record = _native_v2_record(metric, "sha256:native-test")
        metric.validate_persisted_metric(record, "sha256:native-test")

        snapshot = record["native_snapshot"]
        volume = 1.0 / 6.0
        coefficient = volume / 20.0
        self.assertEqual(snapshot["row_offsets"], [0, 4, 8, 12, 16, 16])
        self.assertEqual(snapshot["columns"], [0, 1, 2, 3] * 4)
        np.testing.assert_allclose(
            snapshot["values_m3"],
            [2.0 * coefficient, coefficient, coefficient, coefficient,
             coefficient, 2.0 * coefficient, coefficient, coefficient,
             coefficient, coefficient, 2.0 * coefficient, coefficient,
             coefficient, coefficient, coefficient, 2.0 * coefficient],
            rtol=1e-12,
            atol=0.0,
        )
        self.assertEqual(snapshot["magnetic_volume_m3"], volume)

    def test_native_v2_rejects_strict_types_layout_support_map_csr_identity_and_source(self):
        nodes = np.vstack([self.nodes, [3., 3., 3.]])
        metric = Tet4TrackingMetric(nodes, [[0, 1, 2, 3]], [0])
        record = _native_v2_record(metric, "sha256:native-test")

        boolean_cases = [
            ("generation", lambda snapshot: snapshot.__setitem__("generation", True)),
            (
                "magnetic_volume_m3",
                lambda snapshot: snapshot.__setitem__("magnetic_volume_m3", True),
            ),
            ("row_offsets", lambda snapshot: snapshot["row_offsets"].__setitem__(1, True)),
            ("columns", lambda snapshot: snapshot["columns"].__setitem__(0, True)),
            ("values_m3", lambda snapshot: snapshot["values_m3"].__setitem__(0, True)),
            (
                "canonical_vertex_ids",
                lambda snapshot: snapshot["canonical_vertex_ids"].__setitem__(0, True),
            ),
            (
                "identity_sha256",
                lambda snapshot: snapshot["identity_sha256"].__setitem__(0, True),
            ),
        ]
        for name, corrupt in boolean_cases:
            candidate = copy.deepcopy(record)
            corrupt(candidate["native_snapshot"])
            with self.subTest(case=f"boolean-{name}"), self.assertRaises(ValueError):
                metric.validate_persisted_metric(candidate, "sha256:native-test")

        invalid_cases = []
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["values_m3"][0] = float("nan")
        invalid_cases.append(("nan", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["row_offsets"] = [0, 4, 3, 12, 16, 16]
        invalid_cases.append(("offset-order", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["columns"][:2] = [1, 0]
        invalid_cases.append(("column-order", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["row_offsets"][-1] = 15
        invalid_cases.append(("offset-bound", candidate))
        candidate = copy.deepcopy(record)
        candidate["physical_node_indices"] = [0, 1, 2, 4]
        invalid_cases.append(("support", candidate))
        candidate = copy.deepcopy(record)
        candidate["physical_node_indices"] = [0, 1, 2, True]
        invalid_cases.append(("boolean-support", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["canonical_vertex_ids"] = [0, 1, 2, 4, 3]
        invalid_cases.append(("canonical-map", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["scalar_dof_ids"] = [0, 2, 1, 3, 4]
        invalid_cases.append(("dof-map", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["values_m3"][0] *= 2.0
        invalid_cases.append(("csr-coefficient", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["identity_sha256"][0] ^= 1
        invalid_cases.append(("identity", candidate))
        candidate = copy.deepcopy(record)
        candidate["source_mesh_topology_sha256"] = "sha256:other"
        invalid_cases.append(("source-mesh", candidate))
        candidate = copy.deepcopy(record)
        candidate["native_snapshot"]["source_snapshot_sha256"][0] ^= 1
        invalid_cases.append(("source-snapshot", candidate))
        for name, candidate in invalid_cases:
            with self.subTest(case=name), self.assertRaises(ValueError):
                metric.validate_persisted_metric(candidate, "sha256:native-test")


if __name__ == "__main__":
    unittest.main()
