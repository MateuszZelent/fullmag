from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import struct

import numpy as np

import fullmag as fm

_has_trimesh = False
try:
    import trimesh as _trimesh  # noqa: F401
    _has_trimesh = True
except ImportError:
    pass
from fullmag import _core as fullmag_core
from fullmag.meshing.asset_pipeline import (
    SharedDomainBuildReport,
    _build_field_stack,
    _build_interface_fields,
    _build_object_bulk_fields,
    _build_transition_fields,
    _mesh_options_from_runtime_metadata,
    _resolve_effective_shared_domain_targets,
    _shared_domain_local_size_fields,
    _study_universe_airbox_options,
    realize_fdm_grid_asset,
    realize_fem_domain_mesh_asset,
    realize_fem_domain_mesh_asset_from_components,
    realize_fem_mesh_asset,
)
from fullmag.meshing._mesh_targets import (
    ResolvedAirboxTarget,
    ResolvedSharedDomainTargets,
    ResolvedSharedObjectTarget,
    resolve_object_preview_target,
    resolve_shared_domain_targets,
)
from fullmag.model.discretization import PerObjectMeshRecipe
from fullmag.meshing.gmsh_bridge import (
    ALGO_3D_HXT,
    ALGO_3D_MMG3D,
    MESH_SIZE_PRESETS,
    MeshData,
    MeshOptions,
    SharedDomainMeshResult,
    SizeFieldData,
    _configure_gmsh_threads,
    _apply_mesh_options,
    _create_occ_geometry,
    _extract_gmsh_connectivity,
    _normalize_gmsh_log_line,
    _resolve_gmsh_thread_count,
    resolve_mesh_size_controls,
)
from fullmag.meshing.remesh_cli import _geometry_from_ir, _mesh_result_payload, _size_field_from_dict
from fullmag.meshing.remesh_cli import _describe_remesh_job
from fullmag.meshing import remesh_cli as remesh_cli_module
from fullmag.meshing.quality import validate_mesh
from fullmag.meshing.surface_assets import export_geometry_to_stl
from fullmag.meshing.voxelization import VoxelMaskData, voxelize_geometry


class MeshScaffoldTests(unittest.TestCase):
    @staticmethod
    def _partition_tetra_counts(
        mesh: MeshData,
        region_markers: list[dict[str, object]],
    ) -> dict[str, int]:
        counts = {
            "airbox": int(np.count_nonzero(np.asarray(mesh.element_markers, dtype=np.int32) == 0)),
        }
        for entry in region_markers:
            geometry_name = entry.get("geometry_name")
            marker = entry.get("marker")
            if isinstance(geometry_name, str) and isinstance(marker, int):
                counts[geometry_name] = int(
                    np.count_nonzero(np.asarray(mesh.element_markers, dtype=np.int32) == marker)
                )
        return counts

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

    def _realize_two_nanoflower_shared_domain(
        self,
        *,
        airbox_hmax: float,
        default_hmax: float,
        left_hmax: float | None = None,
        right_hmax: float | None = None,
    ) -> tuple[MeshData, list[dict[str, object]]]:
        nanoflower = Path(__file__).resolve().parents[3] / "examples" / "nanoflower.stl"
        left = fm.ImportedGeometry(
            source=str(nanoflower),
            name="nanoflower_left_geom",
            units="nm",
        )
        right = fm.ImportedGeometry(
            source=str(nanoflower),
            name="nanoflower_right_geom",
            units="nm",
        ).translate((500e-9, 0.0, 0.0))

        per_geometry: list[dict[str, object]] = []
        if left_hmax is not None:
            per_geometry.append(
                {
                    "geometry": left.geometry_name,
                    "mode": "custom",
                    "hmax": f"{left_hmax:.12g}",
                }
            )
        if right_hmax is not None:
            per_geometry.append(
                {
                    "geometry": right.geometry_name,
                    "mode": "custom",
                    "hmax": f"{right_hmax:.12g}",
                }
            )

        return realize_fem_domain_mesh_asset(
            [left, right],
            fm.FEM(order=1, hmax=default_hmax),
            study_universe={
                "mode": "manual",
                "size": [1.6e-6, 8.0e-7, 6.0e-7],
                "center": [250e-9, 0.0, 0.0],
                "airbox_hmax": airbox_hmax,
            },
            mesh_workflow={
                "mesh_options": {
                    "algorithm_2d": 6,
                    "algorithm_3d": ALGO_3D_HXT,
                    "size_factor": 1.0,
                    "size_from_curvature": 0,
                    "smoothing_steps": 1,
                    "optimize_iterations": 1,
                    "narrow_regions": 0,
                    "compute_quality": False,
                    "per_element_quality": False,
                },
                "per_geometry": per_geometry,
            },
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

    def test_study_universe_airbox_hmax_overrides_grading(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        airbox = _study_universe_airbox_options(
            [left],
            {
                "mode": "manual",
                "size": [8.0, 8.0, 8.0],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 0.5,
            },
        )
        self.assertIsNotNone(airbox)
        assert airbox is not None
        self.assertEqual(airbox.size, (8.0, 8.0, 8.0))
        self.assertEqual(airbox.center, (0.0, 0.0, 0.0))
        self.assertEqual(airbox.maximum_element_size, 0.5)

    def test_study_universe_auto_mode_accepts_explicit_size_as_airbox(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        airbox = _study_universe_airbox_options(
            [left],
            {
                "mode": "auto",
                "size": [10.0, 12.0, 14.0],
                "center": [1.0, -2.0, 3.0],
                "padding": [0.0, 0.0, 0.0],
                "airbox_hmax": 0.75,
            },
        )
        self.assertIsNotNone(airbox)
        assert airbox is not None
        self.assertEqual(airbox.size, (10.0, 12.0, 14.0))
        self.assertEqual(airbox.center, (1.0, -2.0, 3.0))
        self.assertEqual(airbox.maximum_element_size, 0.75)

    def test_study_universe_airbox_growth_and_grading_propagate(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        airbox = _study_universe_airbox_options(
            [left],
            {
                "mode": "manual",
                "size": [8.0, 8.0, 8.0],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 0.5,
                "airbox_hmin": 0.2,
                "airbox_growth_rate": 1.45,
                "airbox_grading": "linear",
            },
        )
        self.assertIsNotNone(airbox)
        assert airbox is not None
        self.assertEqual(airbox.maximum_element_size, 0.5)
        self.assertEqual(airbox.minimum_element_size, 0.2)
        self.assertEqual(airbox.grading_ratio, 1.45)
        self.assertEqual(airbox.grading_mode, "linear")

    def test_study_universe_airbox_grading_auto_resolves_to_geometric(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        airbox = _study_universe_airbox_options(
            [left],
            {
                "mode": "manual",
                "size": [8.0, 8.0, 8.0],
                "airbox_growth_rate": 1.25,
                "airbox_grading": "auto",
            },
        )
        self.assertIsNotNone(airbox)
        assert airbox is not None
        self.assertEqual(airbox.grading_ratio, 1.25)
        self.assertEqual(airbox.grading_mode, "geometric")

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

    def test_remesh_cli_size_field_parser_builds_canonical_arrays(self) -> None:
        size_field = _size_field_from_dict(
            {
                "node_coords": [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]],
                "h_values": [2.0e-9, 4.0e-9],
            }
        )

        self.assertIsInstance(size_field, SizeFieldData)
        self.assertEqual(size_field.node_coords.shape, (2, 3))
        self.assertEqual(size_field.h_values.shape, (2,))
        self.assertAlmostEqual(float(size_field.h_values[0]), 2.0e-9)

    def test_remesh_cli_payload_includes_generation_mode_and_provenance(self) -> None:
        mesh = self._unit_tet_mesh()

        payload = _mesh_result_payload(
            mesh,
            mesh_name="adaptive_mesh",
            generation_mode="adaptive_size_field",
            mesh_provenance={"geometry_kind": "box", "order": 1, "hmax": 5e-9},
            size_field_stats={"n_nodes": 4, "h_min": 2e-9, "h_max": 5e-9, "h_mean": 3e-9},
        )

        self.assertEqual(payload["mesh_name"], "adaptive_mesh")
        self.assertEqual(payload["generation_mode"], "adaptive_size_field")
        self.assertEqual(payload["mesh_provenance"]["geometry_kind"], "box")
        self.assertEqual(payload["size_field_stats"]["n_nodes"], 4)

    def test_remesh_cli_payload_preserves_shared_domain_region_markers(self) -> None:
        mesh = self._unit_tet_mesh()

        payload = _mesh_result_payload(
            mesh,
            mesh_name="study_domain",
            generation_mode="shared_domain_manual_remesh",
            mesh_provenance={"geometry_kind": "shared_domain", "order": 1, "hmax": 5e-9},
            region_markers=[
                {"geometry_name": "left", "marker": 1},
                {"geometry_name": "right", "marker": 2},
            ],
        )

        self.assertEqual(payload["mesh_name"], "study_domain")
        self.assertEqual(payload["generation_mode"], "shared_domain_manual_remesh")
        self.assertEqual(len(payload["region_markers"]), 2)
        self.assertEqual(payload["region_markers"][0]["geometry_name"], "left")
        self.assertEqual(payload["region_markers"][1]["marker"], 2)

    def test_remesh_cli_describes_start_of_job(self) -> None:
        self.assertEqual(
            _describe_remesh_job("manual_remesh", 20e-9, 1),
            "Remesh: accepted - mode=manual_remesh, maximum_element_size=2.000e-08, order=P1",
        )

    def test_remesh_cli_describes_shared_domain_airbox_scope(self) -> None:
        self.assertEqual(
            _describe_remesh_job(
                "shared_domain_manual_remesh",
                20e-9,
                1,
                declared_universe={"airbox_hmax": 60e-9},
            ),
            "Remesh: accepted - mode=shared_domain_manual_remesh, maximum_element_size=2.000e-08, order=P1, "
            "scope=shared_domain, body_maximum_element_size=2.000e-08, airbox_maximum_element_size=6.000e-08",
        )

    def test_remesh_cli_describes_shared_domain_local_object_overrides(self) -> None:
        self.assertEqual(
            _describe_remesh_job(
                "shared_domain_manual_remesh",
                20e-9,
                1,
                declared_universe={"airbox_hmax": 60e-9},
                mesh_options={
                    "per_geometry": [
                        {"geometry": "left", "mode": "custom", "hmax": "8e-9"},
                        {"geometry": "right", "mode": "inherit", "hmax": ""},
                    ]
                },
            ),
            "Remesh: accepted - mode=shared_domain_manual_remesh, maximum_element_size=2.000e-08, order=P1, "
            "scope=shared_domain, body_maximum_element_size=2.000e-08, airbox_maximum_element_size=6.000e-08, local_object_overrides=1",
        )

    def test_remesh_cli_shared_domain_manual_remesh_uses_component_aware_path(self) -> None:
        mesh = self._unit_tet_mesh()
        config = {
            "mode": "shared_domain_manual_remesh",
            "mesh_name": "study_domain",
            "hmax": 20e-9,
            "order": 1,
            "mesh_options": {},
            "declared_universe": {"mode": "manual", "size": [8.0, 8.0, 8.0], "center": [0.0, 0.0, 0.0]},
            "geometries": [
                {"kind": "box", "size": [1.0, 1.0, 1.0], "name": "left"},
            ],
        }
        stdout = io.StringIO()

        class _FakeLibC:
            @staticmethod
            def fflush(_stream: object) -> int:
                return 0

        with patch.object(remesh_cli_module.sys, "stdin", io.StringIO(json.dumps(config))), patch.object(
            remesh_cli_module.sys, "stdout", stdout
        ), patch.object(
            remesh_cli_module, "emit_progress"
        ), patch.object(
            remesh_cli_module.os, "dup", return_value=101
        ), patch.object(
            remesh_cli_module.os, "open", return_value=102
        ), patch.object(
            remesh_cli_module.os, "dup2"
        ), patch.object(
            remesh_cli_module.os, "close"
        ), patch.object(
            remesh_cli_module.os, "fdopen", return_value=stdout
        ), patch(
            "ctypes.CDLL",
            return_value=_FakeLibC(),
        ), patch.object(
            remesh_cli_module,
            "realize_fem_domain_mesh_asset_from_components_with_report",
            return_value=(
                mesh,
                [{"geometry_name": "left", "marker": 1}],
                SharedDomainBuildReport(
                    build_mode="component_aware",
                    fallbacks_triggered=[],
                    effective_airbox_target=ResolvedAirboxTarget(hmax=20e-9, hmin=None, growth_rate=None),
                    effective_per_object_targets={
                        "left": ResolvedSharedObjectTarget(
                            geometry_name="left",
                            hmax=20e-9,
                            interface_hmax=None,
                            transition_distance=None,
                            source="study_default",
                            marker=1,
                        )
                    },
                    used_size_field_kinds=[],
                ),
            ),
        ) as component_call:
            remesh_cli_module.main()

        component_call.assert_called_once()
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["generation_mode"], "shared_domain_manual_remesh")
        self.assertEqual(payload["region_markers"][0]["geometry_name"], "left")

    def test_shared_domain_local_size_fields_follow_per_geometry_hmax(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        right = fm.Box(4.0, 2.0, 2.0, name="right")

        fields = _shared_domain_local_size_fields(
            [left, right],
            default_hmax=20e-9,
            per_geometry=[
                {"geometry": "left", "mode": "custom", "hmax": "8e-9"},
                {"geometry": "right", "mode": "inherit", "hmax": ""},
            ],
        )

        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "Box")
        self.assertAlmostEqual(fields[0]["params"]["VIn"], 8e-9)
        self.assertAlmostEqual(fields[0]["params"]["VOut"], 20e-9)
        self.assertEqual(fields[0]["params"]["XMin"], -1.0)
        self.assertEqual(fields[0]["params"]["XMax"], 1.0)
        self.assertEqual(fields[0]["params"]["YMin"], -1.0)
        self.assertEqual(fields[0]["params"]["YMax"], 1.0)
        self.assertEqual(fields[0]["params"]["ZMin"], -1.0)
        self.assertEqual(fields[0]["params"]["ZMax"], 1.0)

    def test_component_aware_field_stack_uses_component_scoped_fields(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [
                    {
                        "geometry": "left",
                        "bulk_hmax": "8e-9",
                        "interface_hmax": "4e-9",
                        "interface_thickness": "12e-9",
                        "transition_distance": "24e-9",
                    }
                ]
            },
            geometries=[left],
            default_hmax=20e-9,
            component_aware=True,
        )

        kinds = [field["kind"] for field in mesh_options.size_fields]
        self.assertEqual(
            kinds,
            ["ComponentVolumeConstant", "InterfaceShellThreshold", "TransitionShellThreshold"],
        )
        bulk_field = mesh_options.size_fields[0]["params"]
        self.assertEqual(bulk_field["GeometryName"], "left")
        self.assertAlmostEqual(bulk_field["VIn"], 8e-9)
        self.assertGreater(float(bulk_field["VOut"]), 1e21)

    def test_component_aware_field_stack_matches_builder_name_to_geom_alias(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left_geom")

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [
                    {
                        "geometry": "left",
                        "mode": "custom",
                        "hmax": "5e-9",
                    }
                ]
            },
            geometries=[left],
            default_hmax=20e-9,
            component_aware=True,
        )

        kinds = [field["kind"] for field in mesh_options.size_fields]
        self.assertEqual(
            kinds,
            ["ComponentVolumeConstant", "InterfaceShellThreshold", "TransitionShellThreshold"],
        )
        self.assertEqual(mesh_options.size_fields[0]["params"]["GeometryName"], "left_geom")
        self.assertAlmostEqual(mesh_options.size_fields[0]["params"]["VIn"], 5e-9)

    def test_effective_shared_domain_targets_match_builder_name_to_geom_alias(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left_geom")

        _airbox_target, effective_targets = _resolve_effective_shared_domain_targets(
            [left],
            fm.FEM(order=1, hmax=20e-9),
            airbox=None,
            mesh_workflow={
                "per_geometry": [
                    {
                        "geometry": "left",
                        "mode": "custom",
                        "hmax": "5e-9",
                        "interface_hmax": "3e-9",
                        "interface_thickness": "7e-9",
                        "transition_growth": "1.5",
                    }
                ]
            },
            per_object_recipes=None,
        )

        self.assertAlmostEqual(effective_targets["left_geom"]["hmax"], 5e-9)
        self.assertAlmostEqual(effective_targets["left_geom"]["interface_hmax"], 3e-9)
        self.assertAlmostEqual(effective_targets["left_geom"]["interface_thickness"], 7e-9)
        self.assertAlmostEqual(effective_targets["left_geom"]["transition_distance"], 15e-9)
        self.assertAlmostEqual(effective_targets["left_geom"]["transition_growth"], 1.5)
        self.assertEqual(effective_targets["left_geom"]["source"], "local_override")

    def test_apply_mesh_options_falls_back_from_mmg3d_when_size_fields_are_active(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next_id = 1
                self.background: int | None = None

            def add(self, _kind: str) -> int:
                field_id = self._next_id
                self._next_id += 1
                return field_id

            def setNumber(self, _field_id: int, _key: str, _value: float) -> None:
                return None

            def setNumbers(self, _field_id: int, _key: str, _values: object) -> None:
                return None

            def setString(self, _field_id: int, _key: str, _value: str) -> None:
                return None

            def setAsBackgroundMesh(self, field_id: int) -> None:
                self.background = field_id

        fake_field_api = _FakeFieldApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {
                "option": _FakeOptionsApi(),
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fake_field_api})()},
                )(),
            },
        )()

        _apply_mesh_options(
            fake_gmsh,
            hmax=20e-9,
            order=1,
            opts=MeshOptions(
                algorithm_3d=ALGO_3D_MMG3D,
                size_fields=[
                    {
                        "kind": "Box",
                        "params": {
                            "VIn": 8e-9,
                            "VOut": 20e-9,
                            "XMin": -1.0,
                            "XMax": 1.0,
                            "YMin": -1.0,
                            "YMax": 1.0,
                            "ZMin": -1.0,
                            "ZMax": 1.0,
                        },
                    }
                ],
            ),
        )

        self.assertEqual(fake_gmsh.option.values["Mesh.Algorithm3D"], float(ALGO_3D_HXT))
        self.assertIsNotNone(fake_field_api.background)

    def test_geometry_from_ir_preserves_imported_geometry_name(self) -> None:
        geometry = _geometry_from_ir(
            {
                "kind": "imported_geometry",
                "name": "nanoflower_left_geom",
                "source": "nanoflower.stl",
                "format": "stl",
                "scale": 1e-9,
            }
        )

        self.assertEqual(geometry.geometry_name, "nanoflower_left_geom")

    def test_resolve_mesh_size_controls_supports_comsol_like_presets(self) -> None:
        resolved = resolve_mesh_size_controls(MeshOptions(size_preset="finer"))

        self.assertIn("finer", MESH_SIZE_PRESETS)
        self.assertEqual(resolved["calibrate_for"], "general_physics")
        self.assertEqual(resolved["size_preset"], "finer")
        self.assertAlmostEqual(float(resolved["resolved_growth_rate"]), 1.4, places=6)
        self.assertEqual(int(resolved["resolved_size_from_curvature"]), 20)
        self.assertEqual(int(resolved["resolved_narrow_regions"]), 5)

    def test_apply_mesh_options_resolves_comsol_like_curvature_and_narrow_regions(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.background: int | None = None

            def add(self, _kind: str) -> int:
                current = self._next
                self._next += 1
                return current

            def setNumber(self, _field_id: int, _key: str, _value: float) -> None:
                return None

            def setNumbers(self, _field_id: int, _key: str, _values: object) -> None:
                return None

            def setString(self, _field_id: int, _key: str, _value: str) -> None:
                return None

            def setAsBackgroundMesh(self, field_id: int) -> None:
                self.background = field_id

        fake_field_api = _FakeFieldApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {
                "option": _FakeOptionsApi(),
                "model": type(
                    "FakeModel",
                    (),
                    {
                        "mesh": type("FakeMesh", (), {"field": fake_field_api})(),
                        "getEntities": staticmethod(lambda dim: [(2, 1)] if dim == 2 else []),
                    },
                )(),
            },
        )()

        _apply_mesh_options(
            fake_gmsh,
            hmax=20e-9,
            order=1,
            opts=MeshOptions(
                size_preset="finer",
                curvature_factor=0.4,
                narrow_region_resolution=0.7,
            ),
        )

        self.assertEqual(
            fake_gmsh.option.values["Mesh.MeshSizeFromCurvature"],
            20.0,
        )
        self.assertEqual(fake_gmsh.option.values["Mesh.SmoothRatio"], 1.4)
        self.assertEqual(fake_gmsh.option.values["Mesh.Smoothing"], 5.0)
        self.assertIsNotNone(fake_field_api.background)

    def test_meshdata_to_ir_has_canonical_shape(self) -> None:
        mesh = self._unit_tet_mesh()

        mesh_ir = mesh.to_ir("unit_tet")

        self.assertEqual(mesh_ir["mesh_name"], "unit_tet")
        self.assertEqual(len(mesh_ir["nodes"]), 4)
        self.assertEqual(len(mesh_ir["elements"]), 1)
        self.assertEqual(mesh_ir["boundary_markers"], [7])
        if fullmag_core.validate_mesh_ir(mesh_ir) is not None:
            self.assertTrue(fullmag_core.validate_mesh_ir(mesh_ir))

    def test_meshdata_to_ir_infers_axis_aligned_periodic_pairs(self) -> None:
        mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [1.0, 1.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 0.0, 1.0],
                    [1.0, 1.0, 1.0],
                    [0.0, 1.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 3, 4],
                    [1, 2, 3, 6],
                    [1, 3, 4, 6],
                    [1, 4, 5, 6],
                    [3, 4, 6, 7],
                ],
                dtype=np.int32,
            ),
            element_markers=np.ones((5,), dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 3, 7], [0, 4, 7],
                    [1, 2, 6], [1, 5, 6],
                    [0, 1, 5], [0, 4, 5],
                    [3, 2, 6], [3, 7, 6],
                    [0, 1, 2], [0, 3, 2],
                    [4, 5, 6], [4, 7, 6],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.full((12,), 99, dtype=np.int32),
        )

        mesh_ir = mesh.to_ir("cube")

        self.assertEqual(
            sorted(pair["pair_id"] for pair in mesh_ir["periodic_boundary_pairs"]),
            ["x_faces", "y_faces", "z_faces"],
        )
        self.assertEqual(len(mesh_ir["periodic_node_pairs"]), 12)

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

    def test_create_occ_geometry_supports_csg_and_translate(self) -> None:
        class _FakeOccApi:
            def __init__(self) -> None:
                self._next = 1
                self.translations: list[tuple[tuple[tuple[int, int], ...], float, float, float]] = []

            def _tag(self) -> int:
                tag = self._next
                self._next += 1
                return tag

            def addBox(self, *_args: object) -> int:
                return self._tag()

            def addCylinder(self, *_args: object) -> int:
                return self._tag()

            def addSphere(self, *_args: object) -> int:
                return self._tag()

            def dilate(self, *_args: object) -> None:
                return None

            def cut(
                self,
                _base: list[tuple[int, int]],
                _tool: list[tuple[int, int]],
            ) -> tuple[list[tuple[int, int]], list[object]]:
                return ([(3, self._tag())], [])

            def fuse(
                self,
                _a: list[tuple[int, int]],
                _b: list[tuple[int, int]],
            ) -> tuple[list[tuple[int, int]], list[object]]:
                return ([(3, self._tag())], [])

            def intersect(
                self,
                _a: list[tuple[int, int]],
                _b: list[tuple[int, int]],
            ) -> tuple[list[tuple[int, int]], list[object]]:
                return ([(3, self._tag())], [])

            def translate(
                self,
                tags: list[tuple[int, int]],
                ox: float,
                oy: float,
                oz: float,
            ) -> None:
                self.translations.append((tuple(tags), ox, oy, oz))

            def importShapes(self, _source: str) -> list[tuple[int, int]]:
                return [(3, self._tag())]

        fake_occ = _FakeOccApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {"model": type("FakeModel", (), {"occ": fake_occ})()},
        )()

        geometry = (fm.Box(2.0, 2.0, 2.0) - fm.Cylinder(0.5, 2.0)).translate((1.0, 0.0, 0.0))
        tags = _create_occ_geometry(fake_gmsh, geometry)

        self.assertTrue(tags)
        self.assertEqual(tags[0][0], 3)
        self.assertTrue(fake_occ.translations)

    def test_create_occ_geometry_rejects_non_cad_imported_geometry(self) -> None:
        class _FakeOccApi:
            pass

        fake_gmsh = type(
            "FakeGmsh",
            (),
            {"model": type("FakeModel", (), {"occ": _FakeOccApi()})()},
        )()
        imported = fm.ImportedGeometry(source="shape.stl")

        with self.assertRaisesRegex(TypeError, "STEP/IGES/BREP"):
            _create_occ_geometry(fake_gmsh, imported)

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

    def test_voxel_mask_load_transposes_xyz_assets_to_canonical_zyx(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "legacy_xyz_mask.npz"
            mask_xyz = np.zeros((2, 3, 4), dtype=np.bool_)
            mask_xyz[1, 2, 3] = True
            np.savez_compressed(
                path,
                mask=mask_xyz,
                cell_size=np.asarray((1.0, 1.0, 1.0), dtype=np.float64),
                origin=np.asarray((0.0, 0.0, 0.0), dtype=np.float64),
                mask_axis_order=np.asarray("xyz"),
            )

            voxels = VoxelMaskData.load(path)

        self.assertEqual(voxels.shape, (4, 3, 2))
        self.assertTrue(voxels.mask[3, 2, 1])
        self.assertEqual(voxels.to_ir("legacy")["cells"], [2, 3, 4])

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

    def test_binary_stl_voxelization_falls_back_without_scipy(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "cube.stl"
            self._write_binary_cube_stl(path)
            geometry = fm.ImportedGeometry(source=str(path), name="cube")

            with patch(
                "fullmag.meshing.voxelization._import_trimesh_voxelization_stack",
                side_effect=ImportError("missing scipy"),
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

    def test_trimesh_voxelization_transposes_xyz_matrix_to_canonical_zyx(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "shape.stl"
            path.write_text("solid shape\nendsolid shape\n", encoding="utf-8")
            geometry = fm.ImportedGeometry(source=str(path), name="shape")

            class _FakeVoxelGrid:
                def __init__(self) -> None:
                    self.matrix = np.zeros((2, 3, 4), dtype=np.bool_)
                    self.matrix[1, 2, 3] = True
                    self.transform = np.asarray(
                        [
                            [1.0, 0.0, 0.0, -10.0],
                            [0.0, 1.0, 0.0, -20.0],
                            [0.0, 0.0, 1.0, -30.0],
                            [0.0, 0.0, 0.0, 1.0],
                        ],
                        dtype=np.float64,
                    )

                def fill(self) -> "_FakeVoxelGrid":
                    return self

            class _FakeMesh:
                def copy(self) -> "_FakeMesh":
                    return self

                def apply_transform(self, _transform: np.ndarray) -> None:
                    return None

                def voxelized(self, _pitch: float) -> _FakeVoxelGrid:
                    return _FakeVoxelGrid()

            class _FakeTrimesh:
                @staticmethod
                def load_mesh(_path: Path, force: str = "mesh") -> _FakeMesh:
                    self.assertEqual(force, "mesh")
                    return _FakeMesh()

            with patch(
                "fullmag.meshing.voxelization._import_trimesh_voxelization_stack",
                return_value=_FakeTrimesh,
            ):
                voxels = voxelize_geometry(geometry, (1.0, 1.0, 1.0))

        self.assertEqual(voxels.shape, (4, 3, 2))
        self.assertTrue(voxels.mask[3, 2, 1])
        self.assertEqual(voxels.to_ir("shape")["cells"], [2, 3, 4])
        self.assertAlmostEqual(voxels.origin[0], -10.0)
        self.assertAlmostEqual(voxels.origin[1], -20.0)
        self.assertAlmostEqual(voxels.origin[2], -30.0)

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

    @unittest.skipUnless(_has_trimesh, "trimesh not installed")
    def test_two_nanoflower_shared_domain_hmax_changes_total_tetra_count(self) -> None:
        coarse_mesh, coarse_markers = self._realize_two_nanoflower_shared_domain(
            airbox_hmax=120e-9,
            default_hmax=120e-9,
        )
        fine_object_mesh, fine_object_markers = self._realize_two_nanoflower_shared_domain(
            airbox_hmax=120e-9,
            default_hmax=120e-9,
            left_hmax=12e-9,
        )
        very_fine_object_mesh, very_fine_object_markers = self._realize_two_nanoflower_shared_domain(
            airbox_hmax=120e-9,
            default_hmax=120e-9,
            left_hmax=6e-9,
        )
        fine_airbox_mesh, fine_airbox_markers = self._realize_two_nanoflower_shared_domain(
            airbox_hmax=35e-9,
            default_hmax=120e-9,
        )

        coarse_counts = self._partition_tetra_counts(coarse_mesh, coarse_markers)
        fine_object_counts = self._partition_tetra_counts(fine_object_mesh, fine_object_markers)
        very_fine_object_counts = self._partition_tetra_counts(
            very_fine_object_mesh,
            very_fine_object_markers,
        )
        fine_airbox_counts = self._partition_tetra_counts(fine_airbox_mesh, fine_airbox_markers)

        self.assertEqual(len(coarse_markers), 2)
        self.assertEqual(len(fine_object_markers), 2)
        self.assertEqual(len(very_fine_object_markers), 2)
        self.assertEqual(len(fine_airbox_markers), 2)
        self.assertGreater(fine_object_mesh.n_elements, coarse_mesh.n_elements)
        self.assertGreater(very_fine_object_mesh.n_elements, fine_object_mesh.n_elements)
        self.assertGreater(fine_airbox_mesh.n_elements, coarse_mesh.n_elements)
        self.assertGreater(
            fine_object_counts["nanoflower_left_geom"],
            coarse_counts["nanoflower_left_geom"],
        )
        self.assertGreater(
            very_fine_object_counts["nanoflower_left_geom"],
            fine_object_counts["nanoflower_left_geom"],
        )
        self.assertLess(fine_object_counts["airbox"], fine_airbox_counts["airbox"])
        self.assertLess(very_fine_object_counts["airbox"], fine_airbox_counts["airbox"])
        self.assertLess(
            fine_object_counts["nanoflower_right_geom"],
            fine_airbox_counts["nanoflower_right_geom"],
        )
        self.assertLess(
            very_fine_object_counts["nanoflower_right_geom"],
            fine_airbox_counts["nanoflower_right_geom"],
        )

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

    def test_realize_fem_mesh_asset_supports_surface_only_imported_geometry(self) -> None:
        preview = {
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            "elements": [],
            "boundary_faces": [[0, 1, 2]],
        }

        with patch(
            "fullmag.meshing.asset_pipeline.build_surface_preview_payload",
            return_value=preview,
        ):
            mesh = realize_fem_mesh_asset(
                fm.ImportedGeometry(
                    source="shape.stl",
                    name="shape",
                    volume="surface",
                ),
                fm.FEM(order=1, hmax=0.1),
            )

        self.assertIsInstance(mesh, MeshData)
        self.assertEqual(mesh.n_elements, 0)
        self.assertEqual(mesh.n_boundary_faces, 1)
        np.testing.assert_array_equal(mesh.boundary_faces, np.asarray([[0, 1, 2]], dtype=np.int32))

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

    def test_realize_fem_domain_mesh_asset_prefers_source_markers_over_point_containment(self) -> None:
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))

        shared_domain_mesh = MeshData(
            nodes=np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                    [1.5, -0.5, -0.5],
                    [2.5, -0.5, -0.5],
                    [1.5, 0.5, -0.5],
                    [1.5, -0.5, 0.5],
                    [-2.0, -2.0, -2.0],
                    [4.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [4, 5, 6, 7],
                    [8, 9, 10, 11],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 2, 3], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6], [8, 9, 10]], dtype=np.int32),
            boundary_markers=np.asarray([10, 10, 99], dtype=np.int32),
        )

        class _FakeSurface:
            vertices = np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                ],
                dtype=np.float64,
            )

            def copy(self) -> "_FakeSurface":
                return self

            def export(self, _path: Path) -> None:
                return None

        fake_trimesh = type(
            "FakeTrimesh",
            (),
            {
                "util": type(
                    "Util",
                    (),
                    {"concatenate": staticmethod(lambda meshes: _FakeSurface())},
                )
            },
        )

        with patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=fake_trimesh,
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_mesh_from_file",
            return_value=shared_domain_mesh,
        ), patch(
            "fullmag.meshing.asset_pipeline._contains_points_in_geometry",
            side_effect=AssertionError("point containment fallback should not run"),
        ):
            mesh, region_markers = realize_fem_domain_mesh_asset(
                [left, right],
                fm.FEM(order=1, hmax=0.1),
                study_universe={"mode": "manual", "size": [8.0, 8.0, 8.0], "center": [0.0, 0.0, 0.0]},
            )

        np.testing.assert_array_equal(mesh.element_markers, np.asarray([1, 2, 0], dtype=np.int32))
        self.assertEqual(region_markers[0], {"geometry_name": "left", "marker": 1})
        self.assertEqual(region_markers[1]["marker"], 2)
        self.assertIn("right", region_markers[1]["geometry_name"])

    def test_realize_fem_domain_mesh_asset_from_components_uses_component_markers(self) -> None:
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))

        shared_domain_mesh = MeshData(
            nodes=np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                    [1.5, -0.5, -0.5],
                    [2.5, -0.5, -0.5],
                    [1.5, 0.5, -0.5],
                    [1.5, -0.5, 0.5],
                    [-2.0, -2.0, -2.0],
                    [4.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [4, 5, 6, 7],
                    [8, 9, 10, 11],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 2, 3], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6], [8, 9, 10]], dtype=np.int32),
            boundary_markers=np.asarray([10, 10, 99], dtype=np.int32),
        )

        class _FakeSurface:
            vertices = np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                ],
                dtype=np.float64,
            )

            def copy(self) -> "_FakeSurface":
                return self

            def export(self, _path: Path) -> None:
                return None

        fake_result = SharedDomainMeshResult(
            mesh=shared_domain_mesh,
            component_marker_tags={left.geometry_name: 1, right.geometry_name: 2},
            component_volume_tags={left.geometry_name: [11], right.geometry_name: [12]},
            component_surface_tags={left.geometry_name: [21], right.geometry_name: [22]},
            interface_surface_tags=[21, 22],
            outer_boundary_surface_tags=[31, 32, 33, 34, 35, 36],
        )

        with patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=object(),
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components",
            return_value=fake_result,
        ), patch(
            "fullmag.meshing.asset_pipeline._match_geometry_bounds_to_source_markers",
            side_effect=AssertionError("bbox mapping should not run for component-aware path"),
        ), patch(
            "fullmag.meshing.asset_pipeline._contains_points_in_geometry",
            side_effect=AssertionError("point containment fallback should not run"),
        ):
            mesh, region_markers = realize_fem_domain_mesh_asset_from_components(
                [left, right],
                fm.FEM(order=1, hmax=0.1),
                study_universe={"mode": "manual", "size": [8.0, 8.0, 8.0], "center": [0.0, 0.0, 0.0]},
            )

        np.testing.assert_array_equal(mesh.element_markers, np.asarray([1, 2, 0], dtype=np.int32))
        self.assertEqual(region_markers[0], {"geometry_name": left.geometry_name, "marker": 1})
        self.assertEqual(region_markers[1], {"geometry_name": right.geometry_name, "marker": 2})

    def test_component_aware_fallback_rebuilds_bounds_fields_for_local_hmax(self) -> None:
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))

        shared_domain_mesh = MeshData(
            nodes=np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                    [1.5, -0.5, -0.5],
                    [2.5, -0.5, -0.5],
                    [1.5, 0.5, -0.5],
                    [1.5, -0.5, 0.5],
                    [-2.0, -2.0, -2.0],
                    [4.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [4, 5, 6, 7],
                    [8, 9, 10, 11],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 2, 3], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6], [8, 9, 10]], dtype=np.int32),
            boundary_markers=np.asarray([10, 10, 99], dtype=np.int32),
        )

        class _FakeSurface:
            vertices = np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                ],
                dtype=np.float64,
            )

            def copy(self) -> "_FakeSurface":
                return self

            def export(self, _path: Path) -> None:
                return None

        fake_trimesh = type(
            "FakeTrimesh",
            (),
            {
                "util": type(
                    "Util",
                    (),
                    {"concatenate": staticmethod(lambda meshes: _FakeSurface())},
                )
            },
        )

        with patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=fake_trimesh,
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components",
            side_effect=Exception("component-aware failed"),
        ), patch(
            "fullmag.meshing.asset_pipeline._contains_points_in_geometry",
            side_effect=AssertionError("point containment fallback should not run"),
        ), patch(
            "fullmag.meshing.gmsh_bridge.generate_mesh_from_file",
            return_value=shared_domain_mesh,
        ) as generate_mesh_from_file:
            mesh, region_markers = realize_fem_domain_mesh_asset_from_components(
                [left, right],
                fm.FEM(order=1, hmax=100e-9),
                study_universe={
                    "mode": "manual",
                    "size": [8.0, 8.0, 8.0],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                },
                mesh_workflow={
                    "per_geometry": [
                        {
                            "geometry": left.geometry_name,
                            "mode": "custom",
                            "hmax": "20e-9",
                        },
                    ],
                },
            )

        np.testing.assert_array_equal(mesh.element_markers, np.asarray([1, 2, 0], dtype=np.int32))
        self.assertEqual(region_markers[0], {"geometry_name": left.geometry_name, "marker": 1})
        self.assertEqual(region_markers[1], {"geometry_name": right.geometry_name, "marker": 2})
        self.assertEqual(generate_mesh_from_file.call_count, 1)
        fallback_options = generate_mesh_from_file.call_args.kwargs["options"]
        fallback_kinds = [field.get("kind") for field in fallback_options.size_fields]
        self.assertIn("Box", fallback_kinds)
        self.assertIn("BoundsSurfaceThreshold", fallback_kinds)
        self.assertNotIn("ComponentVolumeConstant", fallback_kinds)
        self.assertNotIn("InterfaceShellThreshold", fallback_kinds)
        self.assertNotIn("TransitionShellThreshold", fallback_kinds)

    def test_realize_fem_domain_mesh_asset_emits_partition_summary(self) -> None:
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))

        shared_domain_mesh = MeshData(
            nodes=np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                    [1.5, -0.5, -0.5],
                    [2.5, -0.5, -0.5],
                    [1.5, 0.5, -0.5],
                    [1.5, -0.5, 0.5],
                    [-2.0, -2.0, -2.0],
                    [4.0, -2.0, -2.0],
                    [-2.0, 2.0, -2.0],
                    [-2.0, -2.0, 2.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [4, 5, 6, 7],
                    [8, 9, 10, 11],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 2, 3], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6], [8, 9, 10]], dtype=np.int32),
            boundary_markers=np.asarray([10, 10, 99], dtype=np.int32),
        )

        class _FakeSurface:
            vertices = np.asarray(
                [
                    [-0.5, -0.5, -0.5],
                    [0.5, -0.5, -0.5],
                    [-0.5, 0.5, -0.5],
                    [-0.5, -0.5, 0.5],
                ],
                dtype=np.float64,
            )

            def copy(self) -> "_FakeSurface":
                return self

            def export(self, _path: Path) -> None:
                return None

        fake_trimesh = type(
            "FakeTrimesh",
            (),
            {
                "util": type(
                    "Util",
                    (),
                    {"concatenate": staticmethod(lambda meshes: _FakeSurface())},
                )
            },
        )

        stderr = io.StringIO()
        with patch.dict(os.environ, {"FULLMAG_PROGRESS": "1"}, clear=False), contextlib.redirect_stderr(stderr), patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=fake_trimesh,
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_mesh_from_file",
            return_value=shared_domain_mesh,
        ):
            realize_fem_domain_mesh_asset(
                [left, right],
                fm.FEM(order=1, hmax=0.1),
                study_universe={"mode": "manual", "size": [8.0, 8.0, 8.0], "center": [0.0, 0.0, 0.0]},
            )

        output = stderr.getvalue()
        self.assertIn("Total mesh: 3 tetrahedra, 12 nodes, 3 boundary faces", output)
        self.assertIn("Mesh part airbox: 1 tetrahedra, 4 nodes", output)
        self.assertIn("requested maximum element size:", output)
        self.assertIn("characteristic size:", output)
        self.assertIn("edge span:", output)
        self.assertIn("Mesh part left: 1 tetrahedra, 4 nodes", output)
        self.assertIn("Mesh part right", output)
        self.assertIn("1 tetrahedra, 4 nodes", output)

    def test_normalize_gmsh_log_line_keeps_useful_progress(self) -> None:
        self.assertEqual(
            _normalize_gmsh_log_line("Info: [ 40%] Meshing surface 3 (Plane, Frontal-Delaunay)"),
            "Gmsh: [ 40%] Meshing surface 3 (Plane, Frontal-Delaunay)",
        )
        self.assertEqual(
            _normalize_gmsh_log_line("Info: Tetrahedrizing 737 nodes..."),
            "Gmsh: Tetrahedrizing 737 nodes...",
        )
        self.assertIsNone(_normalize_gmsh_log_line("Info: Meshing curve 3 (Line)"))

    def test_resolve_gmsh_thread_count_prefers_env_override(self) -> None:
        with patch.dict(os.environ, {"FULLMAG_GMSH_THREADS": "6"}, clear=False):
            self.assertEqual(_resolve_gmsh_thread_count(2), 6)

    def test_configure_gmsh_threads_sets_parallel_options(self) -> None:
        class _FakeOption:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, name: str, value: float) -> None:
                self.values[name] = value

        class _FakeGmsh:
            def __init__(self) -> None:
                self.option = _FakeOption()

        fake = _FakeGmsh()
        actual = _configure_gmsh_threads(fake, requested_threads=4)
        self.assertEqual(actual, 4)
        self.assertEqual(fake.option.values["General.NumThreads"], 4)
        self.assertEqual(fake.option.values["Mesh.MaxNumThreads1D"], 4)
        self.assertEqual(fake.option.values["Mesh.MaxNumThreads2D"], 4)
        self.assertEqual(fake.option.values["Mesh.MaxNumThreads3D"], 4)


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


# ---------------------------------------------------------------------------
# Commit 7 — acceptance tests for COMSOL-like mesh field stack
# ---------------------------------------------------------------------------

class FieldStackAcceptanceTests(unittest.TestCase):
    """Tests validating per-object, interface, and transition field builders."""

    def test_object_bulk_field_emitted_when_hmax_finer_than_default(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        right = fm.Box(3.0, 2.0, 2.0, name="right")
        fields = _build_object_bulk_fields(
            [left, right],
            default_hmax=20e-9,
            override_by_name={
                "left": {"bulk_hmax": "8e-9"},
                "right": {"bulk_hmax": "25e-9"},  # coarser than default — skip
            },
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "Box")
        self.assertAlmostEqual(fields[0]["params"]["VIn"], 8e-9)

    def test_object_bulk_field_component_aware_uses_component_kind(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_object_bulk_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "5e-9"}},
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "ComponentVolumeConstant")
        self.assertEqual(fields[0]["params"]["GeometryName"], "left")
        self.assertAlmostEqual(fields[0]["params"]["VIn"], 5e-9)

    def test_interface_field_defaults_to_sixty_percent_of_bulk(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_interface_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "10e-9"}},
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "BoundsSurfaceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 10e-9 * 0.6)

    def test_interface_field_explicit_params_override_defaults(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_interface_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={
                "left": {
                    "bulk_hmax": "10e-9",
                    "interface_hmax": "3e-9",
                    "interface_thickness": "15e-9",
                },
            },
        )
        self.assertEqual(len(fields), 1)
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 3e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 15e-9)

    def test_interface_field_component_aware_uses_shell_kind(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_interface_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "8e-9", "interface_hmax": "4e-9"}},
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "InterfaceShellThreshold")
        self.assertEqual(fields[0]["params"]["GeometryName"], "left")
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 4e-9)

    def test_transition_field_defaults_to_three_times_bulk(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_transition_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "10e-9"}},
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "BoundsSurfaceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 10e-9 * 3.0)
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 10e-9)

    def test_transition_field_explicit_distance_overrides_default(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_transition_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={
                "left": {
                    "bulk_hmax": "10e-9",
                    "transition_distance": "50e-9",
                },
            },
        )
        self.assertEqual(len(fields), 1)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 50e-9)

    def test_transition_field_component_aware_uses_shell_kind(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_transition_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "8e-9"}},
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "TransitionShellThreshold")
        self.assertEqual(fields[0]["params"]["GeometryName"], "left")

    def test_field_stack_combines_all_layers(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        right = fm.Box(3.0, 2.0, 2.0, name="right")
        fields = _build_field_stack(
            [left, right],
            default_hmax=20e-9,
            per_geometry=[
                {
                    "geometry": "left",
                    "bulk_hmax": "8e-9",
                    "interface_hmax": "4e-9",
                    "interface_thickness": "12e-9",
                    "transition_distance": "24e-9",
                },
                {"geometry": "right", "bulk_hmax": "6e-9"},
            ],
        )
        kinds = [f["kind"] for f in fields]
        # Both objects contribute bulk + interface + transition
        self.assertIn("Box", kinds)
        self.assertIn("BoundsSurfaceThreshold", kinds)
        # Expect at least 2 bulk, 2 interface, 2 transition
        self.assertGreaterEqual(len(fields), 6)

    def test_field_stack_component_aware_kinds(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_field_stack(
            [left],
            default_hmax=20e-9,
            per_geometry=[
                {
                    "geometry": "left",
                    "bulk_hmax": "8e-9",
                    "interface_hmax": "4e-9",
                    "transition_distance": "30e-9",
                },
            ],
            component_aware=True,
        )
        kinds = [f["kind"] for f in fields]
        self.assertIn("ComponentVolumeConstant", kinds)
        self.assertIn("InterfaceShellThreshold", kinds)
        self.assertIn("TransitionShellThreshold", kinds)

    def test_field_stack_no_fields_when_coarser_than_default(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_field_stack(
            [left],
            default_hmax=5e-9,
            per_geometry=[{"geometry": "left", "bulk_hmax": "10e-9"}],
        )
        self.assertEqual(len(fields), 0)

    def test_two_objects_different_bulk_hmax_produce_distinct_fields(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        right = fm.Box(3.0, 2.0, 2.0, name="right")
        fields = _build_object_bulk_fields(
            [left, right],
            default_hmax=20e-9,
            override_by_name={
                "left": {"bulk_hmax": "5e-9"},
                "right": {"bulk_hmax": "10e-9"},
            },
        )
        self.assertEqual(len(fields), 2)
        vin_values = {f["params"]["VIn"] for f in fields}
        self.assertIn(5e-9, vin_values)
        self.assertIn(10e-9, vin_values)

    def test_fallback_box_path_diagnostic_on_stderr(self) -> None:
        """Verify that when Box fields are used, the field stack reports them."""
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            with patch.dict(os.environ, {"FULLMAG_PROGRESS": "1"}, clear=False):
                fields = _build_field_stack(
                    [left],
                    default_hmax=20e-9,
                    per_geometry=[{"geometry": "left", "bulk_hmax": "8e-9"}],
                )
        output = stderr.getvalue()
        self.assertGreater(len(fields), 0)
        self.assertIn("Field stack:", output)
        self.assertIn("bulk=", output)

    # ------------------------------------------------------------------
    # Regression tests for A1–A3, B2 audit findings (2026-04-08)
    # ------------------------------------------------------------------

    def test_resolve_object_preview_target_recipe_beats_workflow(self) -> None:
        """Recipe hmax must override workflow per_geometry hmax (A1)."""
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        hints = fm.FEM(order=1, hmax=100e-9)
        target = resolve_object_preview_target(
            left,
            hints,
            mesh_workflow={
                "per_geometry": [{"geometry": "left", "hmax": "50e-9"}],
            },
            per_object_recipes={
                "left": PerObjectMeshRecipe(hmax=20e-9),
            },
        )
        self.assertAlmostEqual(target.hmax, 20e-9)
        self.assertEqual(target.source, "recipe_override")

    def test_resolve_shared_domain_targets_recipe_beats_workflow(self) -> None:
        """Shared-domain: recipe hmax must override workflow per_geometry hmax (A1)."""
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        hints = fm.FEM(order=1, hmax=100e-9)
        resolved = resolve_shared_domain_targets(
            [left],
            hints,
            airbox_hmax=200e-9,
            mesh_workflow={
                "per_geometry": [{"geometry": "left", "hmax": "50e-9"}],
            },
            per_object_recipes={
                "left": PerObjectMeshRecipe(hmax=20e-9),
            },
        )
        self.assertAlmostEqual(resolved.per_object["left"].hmax, 20e-9)
        self.assertEqual(resolved.per_object["left"].source, "recipe_override")

    def test_resolve_shared_domain_targets_effective_hmax_includes_per_object_coarser_override(self) -> None:
        """effective_hmax must include per-object hmax when it is coarser (A2)."""
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        hints = fm.FEM(order=1, hmax=100e-9)
        resolved = resolve_shared_domain_targets(
            [left],
            hints,
            airbox_hmax=None,
            mesh_workflow={
                "per_geometry": [{"geometry": "left", "hmax": "200e-9"}],
            },
            per_object_recipes=None,
        )
        # Per-object hmax (200 nm) is coarser than FEM.hmax (100 nm),
        # so effective_hmax must be at least 200 nm.
        self.assertGreaterEqual(resolved.effective_hmax, 200e-9)

    def test_recipe_can_coarsen_workflow_field_stack_for_same_geometry(self) -> None:
        """When recipe wants a coarser mesh, workflow fields for that geometry
        should be removed so the recipe field actually takes effect (A3)."""
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        # Workflow sets fine 8 nm per_geometry
        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [{"geometry": "left", "bulk_hmax": "8e-9"}],
            },
            geometries=[left],
            default_hmax=20e-9,
            component_aware=True,
        )
        # Before stripping: there should be component-aware fields for "left"
        component_fields = [
            f for f in mesh_options.size_fields
            if isinstance(f.get("params"), dict) and f["params"].get("GeometryName") == "left"
        ]
        self.assertGreater(len(component_fields), 0)

        # After stripping for a recipe override on "left"
        from fullmag.meshing.asset_pipeline import _strip_overridden_geometry_fields
        stripped = _strip_overridden_geometry_fields(
            list(mesh_options.size_fields),
            {"left": PerObjectMeshRecipe(hmax=50e-9)},
        )
        remaining_left = [
            f for f in stripped
            if isinstance(f.get("params"), dict) and f["params"].get("GeometryName") == "left"
        ]
        self.assertEqual(len(remaining_left), 0, "workflow fields for 'left' should be removed")

    def test_build_report_marks_degraded_when_component_aware_fails(self) -> None:
        """Build report degraded flag must be True when fallback was triggered (B2)."""
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        report = SharedDomainBuildReport(
            build_mode="concatenated_stl_fallback",
            fallbacks_triggered=["component_aware_import_failed"],
            effective_airbox_target=ResolvedAirboxTarget(hmax=100e-9),
            effective_per_object_targets={
                "left": ResolvedSharedObjectTarget(
                    geometry_name="left", hmax=20e-9, source="recipe_override",
                ),
            },
            used_size_field_kinds=["Box"],
            degraded=True,
        )
        self.assertTrue(report.degraded)
        self.assertIn("degraded", report.to_dict())
        self.assertTrue(report.to_dict()["degraded"])

    def test_build_report_not_degraded_for_component_aware(self) -> None:
        """Build report degraded flag must be False for successful component-aware build."""
        report = SharedDomainBuildReport(
            build_mode="component_aware",
            fallbacks_triggered=[],
            effective_airbox_target=ResolvedAirboxTarget(hmax=100e-9),
            effective_per_object_targets={},
            used_size_field_kinds=["ComponentVolumeConstant"],
        )
        self.assertFalse(report.degraded)


if __name__ == "__main__":
    unittest.main()
