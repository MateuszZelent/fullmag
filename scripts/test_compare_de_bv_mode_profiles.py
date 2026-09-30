import unittest
from dataclasses import replace
from pathlib import Path

import numpy as np

from compare_de_bv_mode_profiles import (
    bind_mesh, contained, consistent_inner_product, normalized_overlap,
    pack_single_film_mesh, tetra_volumes,
)
from fullmag.meshing._gmsh_types import MeshData


class ProfileMetricTests(unittest.TestCase):
    def setUp(self):
        self.nodes = np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]])
        self.tetra = np.array([[0, 1, 2, 3]])
        self.volumes = tetra_volumes(self.nodes, self.tetra)

    def test_exact_p1_basis_mass_differs_from_lumping(self):
        basis = np.zeros((4, 3), dtype=complex)
        basis[0, 0] = 1
        other = np.zeros_like(basis)
        other[1, 0] = 1
        self.assertAlmostEqual(consistent_inner_product(self.tetra, self.volumes, basis, basis).real, 1/60)
        self.assertAlmostEqual(consistent_inner_product(self.tetra, self.volumes, basis, other).real, 1/120)

    def test_constant_integrates_exactly_and_global_phase_scale_cancel(self):
        a = np.tile([1+2j, -3j, 0], (4, 1))
        self.assertAlmostEqual(consistent_inner_product(self.tetra, self.volumes, a, a).real, 14/6)
        self.assertAlmostEqual(normalized_overlap(self.tetra, self.volumes, a, a*(2-5j)), 1)

    def test_orthogonal_components_and_hermitian_product(self):
        a = np.tile([1j, 0, 0], (4, 1)); b = np.tile([0, 1, 0], (4, 1))
        self.assertEqual(normalized_overlap(self.tetra, self.volumes, a, b), 0)
        b = a.copy(); b[0] *= 2-1j
        self.assertEqual(consistent_inner_product(self.tetra, self.volumes, a, b),
                         consistent_inner_product(self.tetra, self.volumes, b, a).conjugate())

    def test_zero_norm_nonfinite_and_degenerate_geometry_rejected(self):
        a = np.ones((4, 3), complex)
        with self.assertRaises(ValueError):
            normalized_overlap(self.tetra, self.volumes, np.zeros_like(a), a)
        a[0, 0] = np.nan
        with self.assertRaises(ValueError):
            consistent_inner_product(self.tetra, self.volumes, a, a)
        with self.assertRaises(ValueError):
            tetra_volumes(np.zeros((4, 3)), self.tetra)

    def fixture(self):
        nodes = np.array([[2.,0,0],[3.,0,0],[2.,1,0],[2.,0,1],
                          [0.,0,0],[1.,0,0],[0.,1,0],[0.,0,1]])
        return MeshData.from_legacy_tet4(nodes=nodes, elements=[[0,1,2,3],[4,5,6,7]],
            element_markers=[0,1], boundary_faces=[[0,1,2],[4,5,6]], boundary_markers=[99,10],
            periodic_node_pairs=[{"pair_id":"x", "node_a":0,"node_b":4}])

    def test_packing_updates_all_indices_and_immutable_ordinals(self):
        packed = pack_single_film_mesh(self.fixture())
        np.testing.assert_array_equal(packed.nodes[:4], self.nodes)
        np.testing.assert_array_equal(packed.elements, [[0,1,2,3],[4,5,6,7]])
        np.testing.assert_array_equal(packed.cell_global_ordinals, [1,0])
        np.testing.assert_array_equal(packed.facet_global_ordinals, [1,0])
        self.assertEqual(packed.periodic_node_pairs[0], {"pair_id":"x","node_a":4,"node_b":0})

    def test_wrong_topology_and_multimaterial_rejected(self):
        mesh = self.fixture()
        with self.assertRaises(ValueError):
            bind_mesh(mesh, "sha256:"+"0"*64)
        fp = pack_single_film_mesh(mesh).topology_fingerprint_v3()
        self.assertEqual(bind_mesh(mesh, fp).topology_fingerprint_v3(), fp)
        with self.assertRaises(ValueError):
            pack_single_film_mesh(replace(mesh, element_markers=np.array([2,1])))

    def test_artifact_path_cannot_leave_case(self):
        root = Path.cwd()
        with self.assertRaises(ValueError):
            contained(root, "../other-case/vector.bin")


if __name__ == "__main__":
    unittest.main()
