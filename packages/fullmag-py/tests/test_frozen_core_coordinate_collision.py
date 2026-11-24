"""Frozen magnetic DOFs must not be selected by last-writer quantization."""
import unittest

import numpy as np

from fullmag.meshing import asset_pipeline
from fullmag.meshing._gmsh_types import MeshData


def frozen_payload():
    mesh = MeshData.from_legacy_tet4(
        nodes=np.asarray([[0., 0., 0.], [1e-13, 0., 0.], [1e-6, 0., 0.],
                          [0., 1e-6, 0.], [0., 0., 1e-6]]),
        elements=np.asarray([[0, 1, 3, 4], [1, 2, 3, 4]], dtype=np.int32),
        element_markers=np.asarray([1, 1], dtype=np.int32),
        boundary_faces=np.asarray([[0, 3, 4], [0, 4, 1], [0, 1, 3],
                                   [2, 4, 3], [1, 4, 2], [1, 2, 3]], dtype=np.int32),
        boundary_markers=np.full(6, 10, dtype=np.int32),
    )
    return asset_pipeline.FrozenMagneticSubmeshPayload(
        mesh=mesh, region_markers=[{"geometry_name": "film", "marker": 1}],
        interface_facet_ordinals=np.arange(6), magnetic_submesh_signatures=[],
    )


def air_mesh(origin_x=0.):
    return MeshData.from_legacy_tet4(
        nodes=np.asarray([[origin_x, 0., 0.], [0., 0., 1e-6],
                          [0., 1e-6, 0.], [-1e-6, 0., 0.]]),
        elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
        element_markers=np.asarray([0], dtype=np.int32),
        boundary_faces=np.asarray([[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
                                  dtype=np.int32),
        boundary_markers=np.asarray([10, 99, 99, 99], dtype=np.int32),
    )


class FrozenCoreCoordinateCollisionTests(unittest.TestCase):
    def test_exact_node_wins_over_different_node_in_same_quantization_bucket(self):
        frozen = frozen_payload()
        merged = asset_pipeline._merge_frozen_magnetic_submesh_with_air_mesh(
            frozen, air_mesh(),
        )
        np.testing.assert_array_equal(merged.elements[-1], [0, 4, 3, 5])
        self.assertEqual(merged.nodes[:5].tobytes(), frozen.mesh.nodes.tobytes())
        self.assertEqual(merged.elements[:2].tobytes(), frozen.mesh.elements.tobytes())
        np.testing.assert_array_equal(merged.element_markers, [1, 1, 0])

    def test_ambiguous_quantization_without_exact_match_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "ambiguous.*frozen.*node"):
            asset_pipeline._merge_frozen_magnetic_submesh_with_air_mesh(
                frozen_payload(), air_mesh(origin_x=2e-13),
            )

    def test_unique_legacy_quantization_match_is_unchanged(self):
        frozen = frozen_payload()
        # This bucket owns only core node 2; preserve the existing snap policy.
        air = MeshData.from_legacy_tet4(
            nodes=np.asarray([[1e-6 + 1e-13, 0., 0.], [0., 0., 1e-6],
                              [0., 1e-6, 0.], [-1e-6, 0., 0.]]),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([0], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [0, 3, 1], [0, 2, 3], [1, 3, 2]],
                                      dtype=np.int32),
            boundary_markers=np.asarray([10, 99, 99, 99], dtype=np.int32),
        )
        merged = asset_pipeline._merge_frozen_magnetic_submesh_with_air_mesh(frozen, air)
        np.testing.assert_array_equal(merged.elements[-1], [2, 4, 3, 5])


if __name__ == "__main__":
    unittest.main()
