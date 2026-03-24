from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import numpy as np

import fullmag as fm
from fullmag import _core as fullmag_core
from fullmag.meshing.asset_pipeline import realize_fdm_grid_asset, realize_fem_mesh_asset
from fullmag.meshing.gmsh_bridge import MeshData
from fullmag.meshing.quality import validate_mesh
from fullmag.meshing.surface_assets import export_geometry_to_stl
from fullmag.meshing.voxelization import VoxelMaskData, voxelize_geometry


class MeshScaffoldTests(unittest.TestCase):
    def _unit_tet_mesh(self) -> MeshData:
        return MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ]
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
            boundary_markers=np.asarray([7], dtype=np.int32),
        )

    def test_meshdata_roundtrip_npz(self) -> None:
        mesh = self._unit_tet_mesh()

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mesh.npz"
            mesh.save(path)
            loaded = MeshData.load(path)

        np.testing.assert_allclose(mesh.nodes, loaded.nodes)
        np.testing.assert_array_equal(mesh.elements, loaded.elements)
        np.testing.assert_array_equal(mesh.element_markers, loaded.element_markers)
        np.testing.assert_array_equal(mesh.boundary_faces, loaded.boundary_faces)
        np.testing.assert_array_equal(mesh.boundary_markers, loaded.boundary_markers)

    def test_meshdata_roundtrip_json(self) -> None:
        mesh = self._unit_tet_mesh()

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mesh.json"
            mesh.save(path)
            loaded = MeshData.load(path)

        np.testing.assert_allclose(mesh.nodes, loaded.nodes)
        np.testing.assert_array_equal(mesh.elements, loaded.elements)
        np.testing.assert_array_equal(mesh.element_markers, loaded.element_markers)
        np.testing.assert_array_equal(mesh.boundary_faces, loaded.boundary_faces)
        np.testing.assert_array_equal(mesh.boundary_markers, loaded.boundary_markers)

    def test_meshdata_to_ir_has_canonical_shape(self) -> None:
        mesh = self._unit_tet_mesh()

        mesh_ir = mesh.to_ir("unit_tet")

        self.assertEqual(mesh_ir["mesh_name"], "unit_tet")
        self.assertEqual(len(mesh_ir["nodes"]), 4)
        self.assertEqual(len(mesh_ir["elements"]), 1)
        self.assertEqual(mesh_ir["boundary_markers"], [7])
        if fullmag_core.validate_mesh_ir(mesh_ir) is not None:
            self.assertTrue(fullmag_core.validate_mesh_ir(mesh_ir))

    def test_validate_mesh_reports_basic_quality(self) -> None:
        mesh = self._unit_tet_mesh()

        report = validate_mesh(mesh)

        self.assertTrue(report.is_valid)
        self.assertEqual(report.n_inverted, 0)
        self.assertGreater(report.min_volume, 0.0)

    def test_box_voxelization_fills_domain(self) -> None:
        voxels = voxelize_geometry(fm.Box(size=(10.0, 6.0, 4.0)), (2.0, 2.0, 2.0))

        self.assertIsInstance(voxels, VoxelMaskData)
        self.assertEqual(voxels.shape, (2, 3, 5))
        self.assertEqual(voxels.active_cell_count, 30)
        self.assertAlmostEqual(voxels.active_fraction, 1.0)

    def test_cylinder_voxelization_creates_partial_mask(self) -> None:
        voxels = voxelize_geometry(fm.Cylinder(radius=3.0, height=6.0), (1.0, 1.0, 1.0))

        self.assertEqual(voxels.shape[0], 6)
        self.assertGreater(voxels.active_cell_count, 0)
        self.assertLess(voxels.active_fraction, 1.0)

    def test_voxel_mask_to_ir_uses_canonical_grid_order(self) -> None:
        voxels = voxelize_geometry(fm.Cylinder(radius=3.0, height=4.0), (1.0, 1.0, 1.0))

        ir = voxels.to_ir("pillar")

        self.assertEqual(ir["geometry_name"], "pillar")
        self.assertEqual(ir["cells"], [voxels.shape[2], voxels.shape[1], voxels.shape[0]])
        self.assertEqual(len(ir["active_mask"]), int(np.prod(voxels.shape)))

    def test_imported_stl_export_passthrough(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            src = Path(tmp_dir) / "shape.stl"
            dst = Path(tmp_dir) / "copied.stl"
            src.write_text("solid shape\nendsolid shape\n", encoding="utf-8")

            exported = export_geometry_to_stl(fm.ImportedGeometry(source=str(src)), dst)

            self.assertEqual(exported, dst)
            self.assertEqual(dst.read_text(encoding="utf-8"), src.read_text(encoding="utf-8"))

    def test_anisotropic_stl_voxelization_is_rejected_in_v0(self) -> None:
        geometry = fm.ImportedGeometry(source="sample.stl")

        with self.assertRaisesRegex(NotImplementedError, "isotropic"):
            voxelize_geometry(geometry, (1.0, 2.0, 1.0))

    def test_realize_fdm_grid_asset_uses_voxelization_contract(self) -> None:
        voxels = realize_fdm_grid_asset(
            fm.Cylinder(radius=3.0, height=4.0),
            fm.FDM(cell=(1.0, 1.0, 1.0)),
        )

        self.assertIsInstance(voxels, VoxelMaskData)
        self.assertGreater(voxels.active_cell_count, 0)

    def test_realize_fem_mesh_asset_prefers_prebuilt_mesh_when_given(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mesh.vtk"
            path.write_text("# vtk DataFile Version 2.0\nplaceholder\n", encoding="utf-8")

            with patch(
                "fullmag.meshing.asset_pipeline.generate_mesh_from_file",
                return_value=MeshData(
                    nodes=np.asarray(
                        [
                            [0.0, 0.0, 0.0],
                            [1.0, 0.0, 0.0],
                            [0.0, 1.0, 0.0],
                            [0.0, 0.0, 1.0],
                        ]
                    ),
                    elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
                    element_markers=np.asarray([1], dtype=np.int32),
                    boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
                    boundary_markers=np.asarray([1], dtype=np.int32),
                ),
            ) as mocked:
                mesh = realize_fem_mesh_asset(
                    fm.Box(size=(1.0, 1.0, 1.0)),
                    fm.FEM(order=1, hmax=0.1, mesh=str(path)),
                )

            mocked.assert_called_once()
            self.assertIsInstance(mesh, MeshData)

    def test_generate_mesh_from_json_works_without_optional_meshing_stack(self) -> None:
        mesh = self._unit_tet_mesh()

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mesh.json"
            mesh.save(path)
            loaded = realize_fem_mesh_asset(
                fm.Box(size=(1.0, 1.0, 1.0)),
                fm.FEM(order=1, hmax=0.1, mesh=str(path)),
            )

        self.assertIsInstance(loaded, MeshData)
        np.testing.assert_allclose(mesh.nodes, loaded.nodes)
        np.testing.assert_array_equal(mesh.elements, loaded.elements)


if __name__ == "__main__":
    unittest.main()
