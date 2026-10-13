"""Interpreted ownership/serialization checks; no solver or native test build."""
from __future__ import annotations

import argparse
from dataclasses import replace
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest

import numpy as np


class VertexIdentityChecks(unittest.TestCase):
    storage_root: Path
    with_gmsh = False

    @staticmethod
    def identity(ids=(107, 3, 900001, 45)):
        return {"schema_version": "mesh_vertex_identity.v1", "issuer": "gmsh_node_tags.v1", "vertex_ids": list(ids)}

    def mesh(self, identity=None):
        from fullmag.meshing._gmsh_types import MeshData
        return MeshData.from_legacy_tet4(
            nodes=[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]],
            elements=[[0, 1, 2, 3]], element_markers=[1],
            boundary_faces=[[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            boundary_markers=[1, 1, 1, 1], vertex_identity=identity,
        )

    def test_sparse_actual_get_nodes_order_is_retained(self):
        from fullmag.meshing._gmsh_extraction import _extract_mesh_data
        expected = (107, 3, 900001, 45)
        class GmshMesh:
            def getNodes(self):
                return np.array(expected, dtype=np.uint64), np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]).reshape(-1), []

            def getElements(self, dim=None, tag=-1):
                if dim == 3:
                    return [4], [np.array([51])], [np.array(expected)]
                return [2], [np.array([61, 62, 63, 64])], [np.array([107, 900001, 3, 107, 3, 45, 107, 45, 900001, 3, 900001, 45])]

            def getElementProperties(self, element_type):
                if element_type == 4:
                    return "Tetrahedron 4", 3, 1, 4, [], 4
                return "Triangle 3", 2, 1, 3, [], 3

        mesh = _extract_mesh_data(SimpleNamespace(model=SimpleNamespace(mesh=GmshMesh())))
        self.assertEqual(mesh.vertex_identity["vertex_ids"], expected)
        np.testing.assert_array_equal(mesh.elements, [[0, 1, 2, 3]])
        self.assertNotEqual(expected, (1, 2, 3, 4))

    def test_identity_is_owned_and_copies_preserve_vertex_order(self):
        from fullmag.meshing._gmsh_infra import _scale_mesh_nodes
        raw = self.identity()
        mesh = self.mesh(raw)
        raw["vertex_ids"][0] = 999
        self.assertEqual(mesh.vertex_identity["vertex_ids"], (107, 3, 900001, 45))
        with self.assertRaises(TypeError):
            mesh.vertex_identity["issuer"] = "changed"
        reversed_mesh = replace(mesh, cell_nodes=np.array([0, 2, 1, 3], dtype=np.int32))
        oriented = reversed_mesh.oriented_copy()
        self.assertIsNot(oriented, reversed_mesh)
        self.assertEqual(oriented.vertex_identity, mesh.vertex_identity)
        scaled = _scale_mesh_nodes(oriented, np.array([2., 3., 4.]))
        self.assertEqual(scaled.vertex_identity, mesh.vertex_identity)
        np.testing.assert_array_equal(scaled.nodes, mesh.nodes * [2., 3., 4.])
        self.assertNotIn("vertex_identity", scaled.to_ir("retained"))

    def test_exact_integer_validation_refuses_coercion_or_invented_defaults(self):
        self.assertIsNone(self.mesh().vertex_identity)
        invalid = [[True, 3, 900001, 45], [np.bool_(True), 3, 900001, 45], [107., 3, 900001, 45],
                   ["107", 3, 900001, 45], [107, 3, 3, 45], [0, 3, 900001, 45],
                   [-1, 3, 900001, 45], [1 << 64, 3, 900001, 45], [107, 3], [[107], [3], [900001], [45]]]
        for ids in invalid:
            with self.subTest(ids=ids), self.assertRaises(ValueError):
                self.mesh(self.identity(ids))
        for field, value in (("issuer", "generated"), ("schema_version", "mesh_vertex_identity.v0"), ("unknown", 1)):
            raw = self.identity()
            raw[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                self.mesh(raw)
        maximum = self.mesh(self.identity(((1 << 64) - 1, 3, 900001, 45)))
        self.assertEqual(maximum.vertex_identity["vertex_ids"][0], (1 << 64) - 1)

    def test_json_and_npz_round_trip_identity_and_legacy_absence(self):
        from fullmag.meshing._gmsh_types import MeshData
        with tempfile.TemporaryDirectory(prefix="antenna-vertex-identity-", dir=self.storage_root) as temporary:
            for extension in ("json", "npz"):
                for mesh in (self.mesh(self.identity()), self.mesh()):
                    path = Path(temporary) / f"mesh.{extension}"
                    mesh.save(path)
                    loaded = MeshData.load(path)
                    self.assertEqual(loaded.vertex_identity, mesh.vertex_identity)
                    np.testing.assert_array_equal(loaded.nodes, mesh.nodes)
                    np.testing.assert_array_equal(loaded.elements, mesh.elements)

    def test_degenerate_cleanup_preserves_actual_identity_without_inventing_ids(self):
        from fullmag.meshing._gmsh_types import MeshData
        from fullmag.meshing.asset_pipeline import MeshQualityUnavailableError, _drop_degenerate_tetrahedra
        for identity in (self.identity((107, 3, 900001, 45, 8007)), None):
            with self.subTest(identity=identity):
                mesh = MeshData.from_legacy_tet4(
                    nodes=[[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.], [0.25, 0.25, 0.]],
                    elements=[[0, 1, 2, 3], [0, 1, 2, 4]], element_markers=[7, 8],
                    boundary_faces=[[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3], [0, 1, 4]],
                    boundary_markers=[11, 12, 13, 14, 15], vertex_identity=identity,
                )
                fallbacks = []
                cleaned = _drop_degenerate_tetrahedra(mesh, context="identity cleanup", fallbacks_triggered=fallbacks)
                self.assertEqual(cleaned.vertex_identity, mesh.vertex_identity)
                np.testing.assert_array_equal(cleaned.nodes, mesh.nodes)
                np.testing.assert_array_equal(cleaned.elements, [[0, 1, 2, 3]])
                np.testing.assert_array_equal(cleaned.element_markers, [7])
                np.testing.assert_array_equal(cleaned.boundary_faces, mesh.boundary_faces[:4])
                np.testing.assert_array_equal(cleaned.boundary_markers, [11, 12, 13, 14])
                self.assertEqual(fallbacks, ["shared_domain_degenerate_tetra_cleanup"])
                self.assertIsNone(cleaned.quality)
                self.assertIsNone(cleaned.per_domain_quality)
                self.assertIs(_drop_degenerate_tetrahedra(cleaned, context="valid cleanup", fallbacks_triggered=[]), cleaned)
                with self.assertRaises(MeshQualityUnavailableError):
                    _drop_degenerate_tetrahedra(replace(mesh, quality=object()), context="stale quality", fallbacks_triggered=[])

    def test_optional_real_gmsh_antenna_scaling_keeps_identity(self):
        if not self.with_gmsh:
            self.skipTest("real Gmsh meshing is opt-in; use --with-gmsh")
        from fullmag.model.geometry import MicrostripAntennaLayout, MicrostripWidthStation
        from fullmag.meshing._gmsh_generators import _generate_csg_mesh
        layout = MicrostripAntennaLayout(name="identity-fixture", length_m=4e-6, thickness_m=0.5e-6,
            conductivity_s_per_m=4e7, stations=[MicrostripWidthStation(0., 1e-6), MicrostripWidthStation(1., 1e-6)],
            return_width_m=2e-6, return_offset_m=0.5e-6)
        mesh = _generate_csg_mesh(layout, hmax=0.5e-6, object_id="identity-fixture")
        self.assertIsNotNone(mesh.vertex_identity)
        self.assertEqual(len(mesh.vertex_identity["vertex_ids"]), mesh.n_nodes)
        self.assertEqual(len(set(mesh.vertex_identity["vertex_ids"])), mesh.n_nodes)
        self.assertGreater(np.count_nonzero(mesh.boundary_markers != 1), 0)
        self.assertLess(np.max(np.abs(mesh.nodes)), 1e-4)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument("--storage-root", type=Path, required=True)
    parser.add_argument("--with-gmsh", action="store_true")
    args = parser.parse_args()
    if not args.storage_root.is_absolute() or not args.storage_root.is_dir():
        parser.error("--storage-root must be an existing absolute configured storage directory")
    sys.path.insert(0, str(args.repo_root / "packages/fullmag-py/src"))
    VertexIdentityChecks.storage_root = args.storage_root.resolve(strict=True)
    VertexIdentityChecks.with_gmsh = args.with_gmsh
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(VertexIdentityChecks))
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
