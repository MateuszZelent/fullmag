"""Temporary frozen-boundary STL must represent the volume-cell exterior."""
import tempfile
import unittest
from pathlib import Path

import numpy as np

from fullmag.meshing.asset_pipeline import _write_frozen_boundary_ascii_stl
from fullmag.meshing._gmsh_types import MeshData
from fullmag.meshing._stl_shells import ShellInput, classify_closed_shells


def triangles(path):
    vertices = [list(map(float, line.split()[1:]))
                for line in path.read_text().splitlines() if line.strip().startswith("vertex ")]
    return np.asarray(vertices).reshape(-1,3,3)


class FrozenBoundaryStlTests(unittest.TestCase):
    def assert_closed_volume(self, mesh, expected_volume, expected_triangles):
        before = [array.copy() for array in (mesh.nodes,mesh.cell_nodes,mesh.facet_nodes)]
        with tempfile.TemporaryDirectory() as directory:
            path = _write_frozen_boundary_ascii_stl(mesh,Path(directory)/"boundary.stl")
            surface = triangles(path)
            self.assertEqual(len(surface),expected_triangles)
            topology = classify_closed_shells([ShellInput("frozen",(1,),surface)])
            self.assertAlmostEqual(sum(topology.signed_volumes),expected_volume,places=13)
            self.assertTrue(all(volume > 0 for volume in topology.signed_volumes))
        for old, current in zip(before,(mesh.nodes,mesh.cell_nodes,mesh.facet_nodes)):
            np.testing.assert_array_equal(old,current)

    def test_wrong_winding_or_partial_metadata_does_not_open_the_exported_volume(self):
        for faces in ([[0,1,2],[0,1,3],[0,2,3],[1,2,3]], [[0,1,2]]):
            with self.subTest(faces=faces):
                mesh=MeshData.from_legacy_tet4(
                    nodes=[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.]],
                    elements=[[0,1,2,3]],element_markers=[1],
                    boundary_faces=faces,boundary_markers=[10]*len(faces))
                self.assert_closed_volume(mesh,1/6,4)

    def test_internal_material_face_is_removed_from_the_exported_union(self):
        mesh=MeshData.from_legacy_tet4(
            nodes=[[0.,0.,0.],[1.,0.,0.],[0.,1.,0.],[0.,0.,1.],[0.,0.,-1.]],
            elements=[[0,1,2,3],[0,2,1,4]],element_markers=[1,2],
            boundary_faces=[[0,1,2]],boundary_markers=[10])
        self.assert_closed_volume(mesh,1/3,6)

    def test_quadrilateral_cell_faces_are_closed_and_triangulated_outward(self):
        mesh=MeshData(
            nodes=[[0.,0.,0.],[1.,0.,0.],[1.,1.,0.],[0.,1.,0.],
                   [0.,0.,1.],[1.,0.,1.],[1.,1.,1.],[0.,1.,1.]],
            cell_types=["hex8"],cell_offsets=[0,8],cell_nodes=list(range(8)),element_markers=[1],
            facet_types=[],facet_roles=[],facet_offsets=[0],facet_nodes=[],boundary_markers=[],
            cell_global_ordinals=[0],facet_global_ordinals=[])
        self.assert_closed_volume(mesh,1.,12)
