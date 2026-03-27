from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import struct

import numpy as np

import fullmag as fm
from fullmag import _core as fullmag_core
from fullmag.meshing.asset_pipeline import realize_fdm_grid_asset, realize_fem_mesh_asset
from fullmag.meshing.gmsh_bridge import MeshData, SizeFieldData, _extract_gmsh_connectivity
from fullmag.meshing.quality import validate_mesh
from fullmag.meshing.surface_assets import export_geometry_to_stl
from fullmag.meshing.voxelization import VoxelMaskData, voxelize_geometry


class MeshScaffoldTests(unittest.TestCase):
    def _write_binary_cube_stl(self, path: Path) -> None:
        vertices = np.asarray(
            [
                [-1.0, -1.0, -1.0],
                [1.0, -1.0, -1.0],
                [1.0, 1.0, -1.0],
                [-1.0, 1.0, -1.0],
                [-1.0, -1.0, 1.0],
                [1.0, -1.0, 1.0],
                [1.0, 1.0, 1.0],
                [-1.0, 1.0, 1.0],
            ],
            dtype=np.float32,
        )
        faces = [
            (0, 1, 2), (0, 2, 3),
            (4, 6, 5), (4, 7, 6),
            (0, 4, 5), (0, 5, 1),
            (1, 5, 6), (1, 6, 2),
            (2, 6, 7), (2, 7, 3),
            (3, 7, 4), (3, 4, 0),
        ]
        with path.open("wb") as handle:
            header = b"fullmag cube".ljust(80, b"\0")
            handle.write(header)
            handle.write(struct.pack("<I", len(faces)))
            for i0, i1, i2 in faces:
                handle.write(struct.pack("<3f", 0.0, 0.0, 0.0))
                for index in (i0, i1, i2):
                    handle.write(struct.pack("<3f", *vertices[index]))
                handle.write(struct.pack("<H", 0))

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

    def test_extract_gmsh_connectivity_uses_primary_nodes_for_higher_order_elements(self) -> None:
        class _FakeMeshApi:
            @staticmethod
            def getElementProperties(element_type: int) -> tuple[str, int, int, int, list[float], int]:
                if element_type == 11:  # tetra10
                    return ("Tetrahedron 10", 3, 2, 10, [], 4)
                if element_type == 9:  # triangle6
                    return ("Triangle 6", 2, 2, 6, [], 3)
                raise AssertionError(f"unexpected element type {element_type}")

        class _FakeModel:
            mesh = _FakeMeshApi()

        class _FakeGmsh:
            model = _FakeModel()

        node_index = {tag: tag - 1 for tag in range(1, 17)}
        tet_blocks = ([11], [np.asarray([1], dtype=np.int32)], [np.asarray([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], dtype=np.int32)])
        tri_blocks = ([9], [np.asarray([1], dtype=np.int32)], [np.asarray([11, 12, 13, 14, 15, 16], dtype=np.int32)])

        elements = _extract_gmsh_connectivity(_FakeGmsh(), tet_blocks, node_index, nodes_per_element=4)
        faces = _extract_gmsh_connectivity(_FakeGmsh(), tri_blocks, node_index, nodes_per_element=3)

        np.testing.assert_array_equal(elements, np.asarray([[0, 1, 2, 3]], dtype=np.int32))
        np.testing.assert_array_equal(faces, np.asarray([[10, 11, 12]], dtype=np.int32))

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

    def test_binary_stl_voxelization_falls_back_without_trimesh(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "cube.stl"
            self._write_binary_cube_stl(path)
            geometry = fm.ImportedGeometry(source=str(path), name="cube")

            with patch(
                "fullmag.meshing.voxelization._import_trimesh",
                side_effect=ImportError("missing trimesh"),
            ):
                voxels = voxelize_geometry(geometry, (1.0, 1.0, 1.0))

        self.assertEqual(voxels.shape, (2, 2, 2))
        self.assertEqual(voxels.active_cell_count, 8)
        self.assertAlmostEqual(voxels.origin[0], -1.0)
        self.assertAlmostEqual(voxels.origin[1], -1.0)
        self.assertAlmostEqual(voxels.origin[2], -1.0)

    def test_binary_stl_voxelization_respects_anisotropic_import_scale(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "cube.stl"
            self._write_binary_cube_stl(path)
            geometry = fm.ImportedGeometry(
                source=str(path),
                name="cube",
                scale=(2.0, 2.0, 0.5),
            )

            with patch(
                "fullmag.meshing.voxelization._import_trimesh",
                side_effect=ImportError("missing trimesh"),
            ):
                voxels = voxelize_geometry(geometry, (1.0, 1.0, 1.0))

        self.assertEqual(voxels.shape, (1, 4, 4))
        self.assertEqual(voxels.active_cell_count, 16)
        self.assertAlmostEqual(voxels.origin[0], -2.0)
        self.assertAlmostEqual(voxels.origin[1], -2.0)
        self.assertAlmostEqual(voxels.origin[2], -0.5)

    def test_binary_stl_voxelization_accepts_units_shortcut(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "cube.stl"
            self._write_binary_cube_stl(path)
            geometry_with_units = fm.ImportedGeometry(
                source=str(path),
                name="cube",
                units="nm",
            )
            geometry_with_scale = fm.ImportedGeometry(
                source=str(path),
                name="cube",
                scale=1e-9,
            )

            with patch(
                "fullmag.meshing.voxelization._import_trimesh",
                side_effect=ImportError("missing trimesh"),
            ):
                voxels_with_units = voxelize_geometry(
                    geometry_with_units,
                    (1e-9, 1e-9, 1e-9),
                )
                voxels_with_scale = voxelize_geometry(
                    geometry_with_scale,
                    (1e-9, 1e-9, 1e-9),
                )

        self.assertEqual(voxels_with_units.shape, voxels_with_scale.shape)
        self.assertEqual(
            voxels_with_units.active_cell_count,
            voxels_with_scale.active_cell_count,
        )
        self.assertAlmostEqual(voxels_with_units.origin[0], voxels_with_scale.origin[0])
        self.assertAlmostEqual(voxels_with_units.origin[1], voxels_with_scale.origin[1])
        self.assertAlmostEqual(voxels_with_units.origin[2], voxels_with_scale.origin[2])

    def test_nanoflower_stl_fallback_keeps_nonempty_domain_at_nm_scale(self) -> None:
        nanoflower = Path(__file__).resolve().parents[3] / "examples" / "nanoflower.stl"
        geometry = fm.ImportedGeometry(
            source=str(nanoflower),
            name="nanoflower",
            units="nm",
        )

        with patch(
            "fullmag.meshing.voxelization._import_trimesh",
            side_effect=ImportError("missing trimesh"),
        ):
            voxels = voxelize_geometry(geometry, (5e-9, 5e-9, 5e-9))

        self.assertEqual(voxels.shape, (23, 66, 66))
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


class SizeFieldDataTests(unittest.TestCase):
    """Tests for the SizeFieldData dataclass (E5 adaptive remeshing)."""

    def test_valid_construction(self) -> None:
        coords = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
        h = np.array([0.1, 0.2, 0.15, 0.3], dtype=np.float64)
        sf = SizeFieldData(node_coords=coords, h_values=h)
        self.assertEqual(sf.node_coords.shape, (4, 3))
        self.assertEqual(sf.h_values.shape, (4,))

    def test_casts_to_float64(self) -> None:
        coords = np.array([[0, 0, 0]], dtype=np.float32)
        h = np.array([0.5], dtype=np.float32)
        sf = SizeFieldData(node_coords=coords, h_values=h)
        self.assertEqual(sf.node_coords.dtype, np.float64)
        self.assertEqual(sf.h_values.dtype, np.float64)

    def test_rejects_wrong_coords_shape(self) -> None:
        with self.assertRaisesRegex(ValueError, "node_coords"):
            SizeFieldData(
                node_coords=np.array([[0, 0], [1, 0]]),
                h_values=np.array([0.1, 0.2]),
            )

    def test_rejects_mismatched_lengths(self) -> None:
        with self.assertRaisesRegex(ValueError, "h_values"):
            SizeFieldData(
                node_coords=np.array([[0, 0, 0], [1, 0, 0]]),
                h_values=np.array([0.1]),
            )

    def test_rejects_nonpositive_h(self) -> None:
        with self.assertRaisesRegex(ValueError, "positive"):
            SizeFieldData(
                node_coords=np.array([[0, 0, 0]]),
                h_values=np.array([0.0]),
            )
        with self.assertRaisesRegex(ValueError, "positive"):
            SizeFieldData(
                node_coords=np.array([[0, 0, 0], [1, 0, 0]]),
                h_values=np.array([0.1, -0.5]),
            )


if __name__ == "__main__":
    unittest.main()
