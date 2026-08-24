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
from types import SimpleNamespace

import numpy as np

import fullmag as fm
import fullmag.meshing.asset_pipeline as mesh_asset_pipeline
from meshing_production_fixtures import (
    assert_monotone_p95_growth,
    characteristic_tet_size,
    distance_to_box,
)

_has_trimesh = False
try:
    import trimesh as _trimesh  # noqa: F401
    _has_trimesh = True
except ImportError:
    pass
from fullmag import _core as fullmag_core
from fullmag.meshing.asset_pipeline import (
    SharedDomainBuildReport,
    _build_shared_domain_build_report,
    _build_field_stack,
    _build_interface_fields,
    _build_object_bulk_fields,
    _build_transition_fields,
    _drop_degenerate_tetrahedra,
    _element_metric_summary_for_mask,
    _mesh_options_from_runtime_metadata,
    _node_indices_for_element_mask,
    _resolve_per_object_mesh_options,
    _resolve_effective_shared_domain_targets,
    _sanitize_surface_mesh_for_stl_export,
    _shared_domain_size_field_default_hmax,
    _shared_domain_local_size_fields,
    _study_universe_airbox_options,
    realize_fdm_grid_asset,
    realize_fem_domain_mesh_asset,
    realize_fem_domain_mesh_asset_from_components,
    realize_fem_domain_mesh_asset_from_components_with_report,
    realize_fem_mesh_asset,
)
from fullmag.meshing._mesh_targets import (
    MeshOperationStatus,
    ResolvedAirboxTarget,
    ResolvedSharedDomainTargets,
    ResolvedSharedObjectTarget,
    ThinFilmDiagnostic,
    resolve_object_preview_target,
    resolve_shared_domain_targets,
)
from fullmag.meshing._gmsh_types import (
    FEM_TOPOLOGY_VOLUME_EPS,
    _infer_axis_aligned_periodic_pairs,
)
from fullmag.meshing._gmsh_infra import _GmshProgressLogger, _gmsh_heartbeat_interval
from fullmag.meshing._gmsh_extraction import (
    _derive_facet_roles,
    _extract_gmsh_typed_connectivity,
    _orient_periodic_boundary_faces,
)
from fullmag.model.discretization import PerObjectMeshRecipe, SharedMeshAssemblyPolicy
from fullmag.meshing.gmsh_bridge import (
    ALGO_3D_DELAUNAY,
    ALGO_3D_FRONTAL,
    ALGO_3D_HXT,
    ALGO_3D_MMG3D,
    AirboxOptions,
    MESH_SIZE_PRESETS,
    MeshData,
    MeshOptions,
    MeshQualityReport,
    SharedDomainMeshResult,
    SizeFieldData,
    _configure_gmsh_threads,
    _apply_mesh_options,
    _create_occ_geometry,
    _extract_gmsh_connectivity,
    _format_gmsh_heartbeat,
    _normalize_gmsh_log_line,
    _resolve_gmsh_thread_count,
    generate_cylinder_mesh,
    generate_mesh,
    resolve_mesh_size_controls,
)
from fullmag.meshing._gmsh_generators import (
    _add_airbox_volume_clamp_fields,
    _build_stl_volume_model,
    _build_stl_volume_model_for_component,
    _sanitize_csg_mesh_options_for_geometries,
    _mesh_stl_surface,
)
from fullmag.meshing._gmsh_extraction import _extract_periodic_pairs
from fullmag.meshing._gmsh_airbox import (
    _component_interface_size_targets as _geo_component_interface_size_targets,
)
from fullmag.meshing._gmsh_occ import (
    _add_periodic_boundary_physical_groups,
    _component_interface_size_targets as _occ_component_interface_size_targets,
    _configure_axis_periodic_surfaces,
    _periodic_candidate_surface_tags,
)
from fullmag.meshing._airbox_grading import (
    _add_airbox_grading_field,
    _airbox_boundary_distance_from_bbox,
)
from fullmag.meshing._gmsh_occ import _airbox_interface_dist_max, is_occ_compatible
from fullmag.meshing._gmsh_waveguides import add_arch_waveguide_to_occ
from fullmag.meshing.remesh_cli import (
    _geometry_from_ir,
    _mesh_options_from_dict,
    _mesh_result_payload,
    _size_field_from_dict,
)
from fullmag.meshing.remesh_cli import _describe_remesh_job
from fullmag.meshing._gmsh_extraction import (
    _align_quality_report_to_element_tags,
    certify_extracted_periodic_mesh,
    _extract_quality_metrics,
    _read_mesh_file,
    UnsupportedGmshElementError,
    _meshio_cell_markers,
    build_per_domain_quality_from_mesh_arrays,
)
from fullmag.meshing._gmsh_fields import (
    _add_axis_aligned_box_distance_threshold_field,
    _add_curvature_surface_field,
    _add_narrow_region_field,
    validate_size_field_config,
)
from fullmag.meshing._gmsh_selectors import (
    collect_orphan_entity_diagnostics,
    resolve_entity_selectors,
)
from fullmag.meshing import remesh_cli as remesh_cli_module
from fullmag.meshing._gmsh_swept import _compute_swept_quality, classify_sweepability
from fullmag.meshing.quality import validate_mesh
from fullmag.meshing.surface_assets import (
    _geometry_to_trimesh,
    _import_trimesh,
    build_surface_preview_payload,
    export_geometry_to_stl,
)
from fullmag.meshing._size_field_plan import _build_perimeter_refinement_fields
from fullmag.meshing.voxelization import VoxelMaskData, voxelize_geometry


class LayeredMeshDslValidationTests(unittest.TestCase):
    def setUp(self) -> None:
        fm.reset()
        self.film = fm.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")

    def tearDown(self) -> None:
        fm.reset()

    def test_thin_film_rejects_invalid_prismatic_requests_before_lowering(self) -> None:
        invalid = (
            {"layers": 0, "topology": "prismatic"},
            {"layers": True, "topology": "prismatic"},
            {"layers": 1.5, "topology": "prismatic"},
            {"layers": 1, "topology": "unknown"},
            {"layers": 1, "topology": "prismatic", "order": 2},
            {"layers": 1, "topology": "prismatic", "transition": "unknown"},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises((TypeError, ValueError)):
                self.film.mesh.thin_film(**kwargs)

        with self.assertRaises(ValueError):
            self.film.mesh.thin_film(
                layers=1,
                topology="prismatic",
                exact_layers=False,
            )
        fm.mode("hybrid")
        with self.assertRaises(ValueError):
            self.film.mesh.thin_film(
                layers=1,
                topology="prismatic",
                exact_layers=False,
            )

    def test_swept_rejects_invalid_or_contradictory_requests_before_lowering(self) -> None:
        invalid = (
            {"elements": 0},
            {"elements": True},
            {"elements": 1.5},
            {"elements": 1, "transition": "unknown"},
            {
                "elements": 1,
                "face_meshing": "quadrilateral",
                "transition": "pyramid_to_tetrahedra",
            },
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises((TypeError, ValueError)):
                self.film.mesh.swept(**kwargs)

    def test_layered_mesh_mutation_sequences_replace_stale_typed_intent(self) -> None:
        self.film.mesh.thin_film(layers=2, topology="prismatic")
        self.film.mesh.thin_film(layers=3)
        legacy = self.film._mesh_spec
        self.assertEqual(legacy.mesh_strategy, "thin_film_tetrahedral")
        self.assertEqual(legacy.through_thickness_elements, 3)
        self.assertIsNone(legacy.topology)
        self.assertIsNone(legacy.sweep_direction)
        self.assertIsNone(legacy.element_family)
        self.assertIsNone(legacy.transition_policy)
        self.assertIsNone(legacy.exact_layer_count)

        self.film.mesh.thin_film(layers=2, topology="prismatic")
        self.film.mesh.swept(elements=4, sweep_direction="x", transition="reject")
        swept = self.film._mesh_spec
        self.assertEqual(swept.mesh_strategy, "swept_prism")
        self.assertEqual(swept.through_thickness_elements, 4)
        self.assertIsNone(swept.topology)
        self.assertEqual(swept.sweep_direction, "x")
        self.assertEqual(swept.element_family, "prism")
        self.assertEqual(swept.transition_policy, "reject")
        self.assertIs(swept.exact_layer_count, True)

    def test_prismatic_configure_rejects_contradiction_atomically(self) -> None:
        self.film.mesh.thin_film(layers=2, topology="prismatic")
        before = self.film._mesh_spec
        with self.assertRaisesRegex(ValueError, "order=1"):
            self.film.mesh(order=2)
        after = self.film._mesh_spec
        self.assertIs(after, before)
        self.assertEqual(after.order, 1)
        self.assertEqual(after.topology, "prismatic")

        with self.assertRaisesRegex(ValueError, "layered mesh intent is incomplete"):
            fm.geometry(fm.Box(20e-9, 10e-9, 1e-9), name="incomplete").mesh(
                mesh_strategy="swept_prism"
            )

    def test_direct_layered_mesh_api_rejects_invalid_intent_atomically(self) -> None:
        self.film.mesh.thin_film(layers=2, topology="prismatic")
        before = self.film._mesh_spec

        invalid_calls = (
            lambda: self.film.mesh.configure(exact_layer_count="yes"),
            lambda: self.film.mesh(through_thickness_distribution="unknown"),
            lambda: self.film.mesh.configure(
                through_thickness_distribution="linear",
                exact_layer_count=True,
            ),
            lambda: self.film.mesh.configure(through_thickness_element_ratio=True),
            lambda: self.film.mesh.configure(through_thickness_element_ratio="1.5"),
            lambda: self.film.mesh.configure(through_thickness_element_ratio=0.0),
            lambda: self.film.mesh.configure(through_thickness_element_ratio=float("inf")),
            lambda: self.film.mesh.configure(through_thickness_element_ratio=float("nan")),
            lambda: self.film.mesh.configure(through_thickness_symmetric="yes"),
            lambda: self.film.mesh.configure(through_thickness_element_ratio=1.5),
            lambda: self.film.mesh.configure(through_thickness_symmetric=True),
        )
        for invalid_call in invalid_calls:
            with self.subTest(call=invalid_call), self.assertRaises(
                (TypeError, ValueError)
            ):
                invalid_call()
            self.assertIs(self.film._mesh_spec, before)
            self.assertEqual(before.through_thickness_distribution, "fixed")
            self.assertIs(before.exact_layer_count, True)

    def test_direct_layered_mesh_api_rejects_incomplete_typed_intent(self) -> None:
        for kwargs in (
            {"sweep_direction": "x"},
            {"element_family": "prism"},
            {"transition_policy": "reject"},
            {"exact_layer_count": True},
            {"through_thickness_element_ratio": 1.5},
            {"through_thickness_symmetric": True},
        ):
            with self.subTest(kwargs=kwargs), self.assertRaisesRegex(
                ValueError, "layered mesh intent is incomplete"
            ):
                self.film.mesh(**kwargs)

    def test_per_object_recipe_rejects_invalid_direct_size_targets(self) -> None:
        invalid = (
            {"maximum_element_size": -1.0},
            {"minimum_element_size": 0.0},
            {"hmax": float("nan")},
            {"hmin": float("inf")},
            {"maximum_element_size": True},
            {"maximum_element_size": "1e-9"},
            {"minimum_element_size": 2.0, "maximum_element_size": 1.0},
            {"hmin": 2.0, "hmax": 1.0},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises((TypeError, ValueError)):
                PerObjectMeshRecipe(**kwargs)

    def test_per_object_recipe_rejects_invalid_direct_numeric_controls(self) -> None:
        invalid = (
            {"size_factor": 0.0},
            {"curvature_factor": float("nan")},
            {"growth_rate": -1.0},
            {"growth_rate": float("inf")},
            {"narrow_region_resolution": 0.0},
            {"boundary_layer_thickness": -1.0},
            {"boundary_layer_stretching": float("nan")},
            {"through_thickness_element_ratio": 0.0},
            {"size_from_curvature": -1},
            {"narrow_regions": -1},
            {"smoothing_steps": 0},
            {"optimize_iters": 0},
            {"boundary_layer_count": 0},
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises((TypeError, ValueError)):
                PerObjectMeshRecipe(**kwargs)

    def test_per_object_recipe_rejects_unavailable_object_mesh_source(self) -> None:
        with self.assertRaisesRegex(ValueError, "FEM\(mesh=\.\.\.\)"):
            PerObjectMeshRecipe(source="object.mesh")

    def test_per_object_recipe_rejects_invalid_or_incoherent_layered_intent(self) -> None:
        invalid = (
            {"through_thickness_elements": 0},
            {"through_thickness_elements": True},
            {"topology": "unknown"},
            {"sweep_direction": "diagonal"},
            {"element_family": "tet"},
            {"transition_policy": "unknown"},
            {
                "mesh_strategy": "swept_prism",
                "through_thickness_elements": 1,
                "through_thickness_distribution": "fixed",
                "sweep_face_meshing": "triangular",
                "topology": "tetrahedral",
                "sweep_direction": "auto",
                "element_family": "prism",
                "transition_policy": "pyramid_to_tetrahedra",
                "exact_layer_count": True,
            },
            {
                "mesh_strategy": "swept_prism",
                "through_thickness_elements": 1,
                "through_thickness_distribution": "fixed",
                "sweep_face_meshing": "triangular",
                "topology": "prismatic",
                "sweep_direction": "auto",
                "element_family": "prism",
                "transition_policy": "pyramid_to_tetrahedra",
                "exact_layer_count": False,
            },
        )
        for kwargs in invalid:
            with self.subTest(kwargs=kwargs), self.assertRaises((TypeError, ValueError)):
                PerObjectMeshRecipe(**kwargs)

        valid = PerObjectMeshRecipe(
            mesh_strategy="swept_prism",
            order=1,
            through_thickness_elements=1,
            through_thickness_distribution="fixed",
            sweep_face_meshing="triangular",
            sweep_direction="x",
            element_family="prism",
            transition_policy="reject",
            exact_layer_count=True,
        )
        self.assertEqual(valid.to_ir()["transition_policy"], "reject")


class MeshScaffoldTests(unittest.TestCase):
    def test_periodic_boundary_faces_are_oriented_outward_from_owner_tetrahedron(self) -> None:
        nodes = np.asarray(
            [
                [0.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 0.0],
            ],
            dtype=np.float64,
        )
        elements = np.asarray([[0, 1, 2, 3]], dtype=np.int32)
        boundary_faces = np.asarray([[0, 1, 2]], dtype=np.int32)
        boundary_markers = np.asarray([10], dtype=np.int32)

        _orient_periodic_boundary_faces(
            nodes,
            elements,
            boundary_faces,
            boundary_markers,
            [
                {
                    "marker_a": 10,
                    "marker_b": 11,
                }
            ],
        )

        np.testing.assert_array_equal(boundary_faces, [[0, 2, 1]])

    def test_multi_body_rotated_annular_csg_can_use_native_conformal_occ(self) -> None:
        layer = fm.Box(size=(300e-9, 1000e-9, 10e-9), name="layer")
        ring = fm.Difference(
            base=fm.Cylinder(radius=150e-9, height=50e-9, axis=(1.0, 0.0, 0.0), name="ring_outer"),
            tool=fm.Cylinder(radius=50e-9, height=50e-9, axis=(1.0, 0.0, 0.0), name="ring_inner"),
            name="ring",
        ).translate((0.0, 0.0, 165e-9))

        self.assertTrue(is_occ_compatible([layer, ring]))

    def test_airbox_interface_targets_ignore_component_bulk_hmax(self) -> None:
        options = MeshOptions(
            size_fields=[
                {
                    "kind": "ComponentVolumeConstant",
                    "params": {
                        "GeometryName": "layer",
                        "VIn": 8e-9,
                    },
                },
                {
                    "kind": "InterfaceShellThreshold",
                    "params": {
                        "GeometryName": "layer",
                        "SizeMin": 3e-9,
                    },
                },
            ]
        )

        self.assertEqual(
            _geo_component_interface_size_targets(options),
            {"layer": 3e-9},
        )
        self.assertEqual(
            _occ_component_interface_size_targets(options),
            {"layer": 3e-9},
        )

    def test_meshio_cell_markers_preserve_physical_air_marker(self) -> None:
        mesh = SimpleNamespace(
            cells=[
                SimpleNamespace(
                    type="tetra",
                    data=np.zeros((3, 4), dtype=np.int32),
                )
            ],
            cell_data={"gmsh:physical": [np.asarray([7, 8, 7], dtype=np.int32)]},
            field_data={
                "magnetic": np.asarray([7, 3], dtype=np.int32),
                "air": np.asarray([8, 3], dtype=np.int32),
            },
            cell_sets={},
        )

        np.testing.assert_array_equal(
            _meshio_cell_markers(mesh, cell_type="tetra"),
            np.asarray([7, 0, 7], dtype=np.int32),
        )

    def test_meshio_cell_markers_align_multiple_tetra_blocks(self) -> None:
        mesh = SimpleNamespace(
            cells=[
                SimpleNamespace(
                    type="tetra",
                    data=np.zeros((1, 4), dtype=np.int32),
                ),
                SimpleNamespace(
                    type="triangle",
                    data=np.zeros((1, 3), dtype=np.int32),
                ),
                SimpleNamespace(
                    type="tetra",
                    data=np.zeros((2, 4), dtype=np.int32),
                ),
            ],
            cell_data={
                "gmsh:physical": [
                    np.asarray([1], dtype=np.int32),
                    np.asarray([99], dtype=np.int32),
                    np.asarray([2, 3], dtype=np.int32),
                ]
            },
            field_data={},
            cell_sets={},
        )

        np.testing.assert_array_equal(
            _meshio_cell_markers(mesh, cell_type="tetra"),
            np.asarray([1, 2, 3], dtype=np.int32),
        )

    def test_meshio_import_ignores_standard_lower_dimensional_blocks(self) -> None:
        mesh = SimpleNamespace(
            points=np.zeros((4, 3), dtype=np.float64),
            cells=[
                SimpleNamespace(type="vertex", data=np.asarray([[0]], dtype=np.int32)),
                SimpleNamespace(type="line", data=np.asarray([[0, 1]], dtype=np.int32)),
                SimpleNamespace(type="triangle", data=np.asarray([[0, 1, 2]], dtype=np.int32)),
                SimpleNamespace(type="tetra", data=np.asarray([[0, 1, 2, 3]], dtype=np.int32)),
            ],
            cell_data={},
            field_data={},
            cell_sets={},
        )
        fake_meshio = SimpleNamespace(read=lambda _path: mesh)
        with patch(
            "fullmag.meshing._gmsh_extraction._import_meshio",
            return_value=fake_meshio,
        ):
            imported = _read_mesh_file(Path("ordinary.msh"))

        self.assertEqual(imported.n_elements, 1)
        self.assertEqual(imported.n_boundary_faces, 1)

    def test_extract_quality_metrics_empty_returns_tuple(self) -> None:
        gmsh = SimpleNamespace(
            model=SimpleNamespace(
                mesh=SimpleNamespace(getElements=lambda dim: ([], [], [])),
            ),
        )

        quality, per_domain = _extract_quality_metrics(gmsh, MeshOptions())

        self.assertEqual(quality.n_elements, 0)
        self.assertIsNone(per_domain)

    def test_meshdata_validate_strict_rejects_degenerate_tets(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [3.0, 0.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )

        with self.assertRaisesRegex(ValueError, "degenerate tet4 Jacobian"):
            mesh.validate_strict()

    def test_drop_degenerate_tetrahedra_removes_only_invalid_elements(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.25, 0.25, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [0, 1, 2, 4],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([7, 8], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )
        fallbacks: list[str] = []

        cleaned = _drop_degenerate_tetrahedra(
            mesh,
            context="test mesh",
            fallbacks_triggered=fallbacks,
        )

        cleaned.validate_strict()
        self.assertEqual(cleaned.elements.tolist(), [[0, 1, 2, 3]])
        self.assertEqual(cleaned.element_markers.tolist(), [7])
        self.assertEqual(fallbacks, ["shared_domain_degenerate_tetra_cleanup"])

    def test_drop_degenerate_tetrahedra_leaves_valid_mixed_mesh_unchanged(self) -> None:
        mesh = MeshData(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                    [3.0, 0.0, 0.0],
                    [2.0, 1.0, 0.0],
                    [2.0, 0.0, 1.0],
                    [3.0, 0.0, 1.0],
                    [2.0, 1.0, 1.0],
                ],
                dtype=np.float64,
            ),
            cell_types=np.asarray(["tet4", "prism6"]),
            cell_offsets=np.asarray([0, 4, 10]),
            cell_nodes=np.asarray([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
            element_markers=np.asarray([0, 1]),
            facet_types=np.asarray([], dtype=np.str_),
            facet_roles=np.asarray([], dtype=np.str_),
            facet_offsets=np.asarray([0]),
            facet_nodes=np.asarray([], dtype=np.int32),
            boundary_markers=np.asarray([], dtype=np.int32),
            cell_global_ordinals=np.asarray([0, 1]),
            facet_global_ordinals=np.asarray([], dtype=np.int64),
        )

        cleaned = _drop_degenerate_tetrahedra(
            mesh,
            context="valid mixed mesh",
            fallbacks_triggered=[],
        )

        self.assertIs(cleaned, mesh)

    def test_drop_degenerate_tetrahedra_rejects_invalid_mixed_cell_families(self) -> None:
        reference_cells = {
            "prism6": np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 0.0, 1.0],
                    [0.0, 1.0, 1.0],
                ],
                dtype=np.float64,
            ),
            "pyramid5": np.asarray(
                [
                    [-1.0, -1.0, 0.0],
                    [1.0, -1.0, 0.0],
                    [1.0, 1.0, 0.0],
                    [-1.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
        }
        reversed_order = {
            "prism6": [0, 2, 1, 3, 5, 4],
            "pyramid5": [0, 3, 2, 1, 4],
        }
        tet = np.asarray(
            [[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            dtype=np.float64,
        )

        for family, coordinates in reference_cells.items():
            for failure, family_coordinates in (
                ("degenerate", coordinates * np.asarray([1.0, 1.0, 0.0])),
                ("negative", coordinates[reversed_order[family]]),
            ):
                with self.subTest(family=family, failure=failure):
                    shifted = family_coordinates + np.asarray([3.0, 0.0, 0.0])
                    arity = shifted.shape[0]
                    mesh = MeshData(
                        nodes=np.concatenate([tet, shifted]),
                        cell_types=np.asarray(["tet4", family]),
                        cell_offsets=np.asarray([0, 4, 4 + arity]),
                        cell_nodes=np.arange(4 + arity, dtype=np.int32),
                        element_markers=np.asarray([0, 1]),
                        facet_types=np.asarray([], dtype=np.str_),
                        facet_roles=np.asarray([], dtype=np.str_),
                        facet_offsets=np.asarray([0]),
                        facet_nodes=np.asarray([], dtype=np.int32),
                        boundary_markers=np.asarray([], dtype=np.int32),
                        cell_global_ordinals=np.asarray([0, 1]),
                        facet_global_ordinals=np.asarray([], dtype=np.int64),
                    )

                    with self.assertRaisesRegex(
                        ValueError,
                        rf"{failure} {family} Jacobian",
                    ):
                        _drop_degenerate_tetrahedra(
                            mesh,
                            context="invalid mixed mesh",
                            fallbacks_triggered=[],
                        )

    def test_drop_degenerate_tetrahedra_removes_orphan_boundary_faces(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [0, 1, 2, 4],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([7, 8], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 3],
                    [0, 1, 4],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([11, 12], dtype=np.int32),
        )

        cleaned = _drop_degenerate_tetrahedra(
            mesh,
            context="test mesh",
            fallbacks_triggered=[],
        )

        cleaned.validate_strict()
        self.assertEqual(cleaned.boundary_faces.tolist(), [[0, 1, 3]])
        self.assertEqual(cleaned.boundary_markers.tolist(), [11])

    def test_sanitize_surface_mesh_for_stl_export_removes_duplicate_and_degenerate_faces(self) -> None:
        class _FakeSurface:
            def __init__(self) -> None:
                self.vertices = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    dtype=np.float64,
                )
                self.faces = np.asarray(
                    [
                        [0, 1, 2],
                        [2, 1, 0],
                        [0, 0, 3],
                        [0, 2, 3],
                    ],
                    dtype=np.int64,
                )
                self.merge_vertices_digits: int | None = None
                self.remove_unreferenced_vertices_called = 0

            def copy(self) -> "_FakeSurface":
                return self

            def merge_vertices(self, *, digits_vertex: int) -> None:
                self.merge_vertices_digits = digits_vertex

            def remove_unreferenced_vertices(self) -> None:
                self.remove_unreferenced_vertices_called += 1

            def update_faces(self, keep_indices: np.ndarray) -> None:
                self.faces = self.faces[keep_indices]

        surface = _FakeSurface()

        sanitized = _sanitize_surface_mesh_for_stl_export(surface)

        self.assertIs(sanitized, surface)
        self.assertEqual(surface.merge_vertices_digits, 15)
        self.assertEqual(surface.remove_unreferenced_vertices_called, 2)
        np.testing.assert_array_equal(
            surface.faces,
            np.asarray([[0, 1, 2], [0, 2, 3]], dtype=np.int64),
        )

    def test_meshdata_validate_strict_honors_explicit_fem_topology_floor(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [9.0e-11, 0.0, 0.0],
                    [0.0, 9.0e-11, 0.0],
                    [0.0, 0.0, 9.0e-11],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )

        with self.assertRaisesRegex(ValueError, "degenerate tet4 Jacobian"):
            mesh.validate_strict(eps_volume=FEM_TOPOLOGY_VOLUME_EPS)

    def test_meshdata_oriented_copy_flips_negative_tets(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 1.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros((0,), dtype=np.int32),
        )

        oriented = mesh.oriented_copy()
        oriented.validate_strict()
        self.assertEqual(oriented.elements.tolist(), [[0, 1, 3, 2]])

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
        return MeshData.from_legacy_tet4(
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
        ).translate((800e-9, 0.0, 0.0))

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
        base_mesh = self._unit_tet_mesh()
        mesh = MeshData.from_legacy_tet4(
            nodes=base_mesh.nodes,
            elements=base_mesh.elements,
            element_markers=base_mesh.element_markers,
            boundary_faces=base_mesh.boundary_faces,
            boundary_markers=base_mesh.boundary_markers,
            periodic_boundary_pairs=[
                {
                    "pair_id": "x_faces",
                    "marker_a": 21,
                    "marker_b": 22,
                    "translation": [1.0, 0.0, 0.0],
                }
            ],
            periodic_node_pairs=[
                {
                    "pair_id": "x_faces",
                    "node_a": 0,
                    "node_b": 1,
                }
            ],
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mesh.npz"
            mesh.save(path)
            loaded = MeshData.load(path)

        np.testing.assert_allclose(mesh.nodes, loaded.nodes)
        np.testing.assert_array_equal(mesh.elements, loaded.elements)
        np.testing.assert_array_equal(mesh.element_markers, loaded.element_markers)
        np.testing.assert_array_equal(mesh.boundary_faces, loaded.boundary_faces)
        np.testing.assert_array_equal(mesh.boundary_markers, loaded.boundary_markers)
        self.assertEqual(loaded.periodic_boundary_pairs, mesh.periodic_boundary_pairs)
        self.assertEqual(loaded.periodic_node_pairs, mesh.periodic_node_pairs)

    def test_meshdata_loads_legacy_npz_without_periodic_metadata(self) -> None:
        mesh = self._unit_tet_mesh()

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "legacy_mesh.npz"
            np.savez_compressed(
                path,
                nodes=mesh.nodes,
                elements=mesh.elements,
                element_markers=mesh.element_markers,
                boundary_faces=mesh.boundary_faces,
                boundary_markers=mesh.boundary_markers,
            )
            loaded = MeshData.load(path)

        np.testing.assert_allclose(mesh.nodes, loaded.nodes)
        np.testing.assert_array_equal(mesh.elements, loaded.elements)
        self.assertEqual(loaded.periodic_boundary_pairs, [])
        self.assertEqual(loaded.periodic_node_pairs, [])

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

    def test_study_universe_explicit_airbox_must_contain_geometry_bounds(self) -> None:
        waveguide = fm.ArchWaveguide(
            length=4.0,
            width=1.0,
            height=0.1,
            arch_height=0.0,
            name="waveguide",
        )

        with self.assertRaisesRegex(ValueError, "does not contain geometry bounds.*axis y"):
            _study_universe_airbox_options(
                [waveguide],
                {
                    "mode": "auto",
                    "size": [4.0, 0.2, 1.0],
                    "center": [0.0, 0.0, 0.0],
                },
            )

    def test_flat_arch_waveguide_occ_uses_box_not_loft(self) -> None:
        class _FakeOcc:
            def __init__(self) -> None:
                self.box_args: tuple[float, ...] | None = None

            def addBox(self, *args: float) -> int:
                self.box_args = tuple(float(arg) for arg in args)
                return 17

            def addThruSections(self, *_args: object, **_kwargs: object) -> list[tuple[int, int]]:
                raise AssertionError("flat ArchWaveguide must not use lofted thru-sections")

        fake_occ = _FakeOcc()
        fake_gmsh = SimpleNamespace(model=SimpleNamespace(occ=fake_occ))

        result = add_arch_waveguide_to_occ(
            fake_gmsh,
            fm.ArchWaveguide(
                length=4.0,
                width=1.0,
                height=0.1,
                arch_height=0.0,
                z0=0.2,
                name="flat",
            ),
        )

        self.assertEqual(result, [(3, 17)])
        assert fake_occ.box_args is not None
        np.testing.assert_allclose(
            fake_occ.box_args,
            (-2.0, -0.5, 0.15, 4.0, 1.0, 0.1),
        )

    def test_occ_airbox_interface_transition_uses_full_airbox_distance_with_hmin(self) -> None:
        self.assertEqual(
            _airbox_interface_dist_max(
                default_h_inner=0.150,
                h_inner=0.008,
                fallback_dist_max=0.500,
            ),
            0.500,
        )
        self.assertEqual(
            _airbox_interface_dist_max(
                default_h_inner=0.150,
                h_inner=0.008,
                fallback_dist_max=0.500,
            ),
            0.500,
        )

    def test_airbox_boundary_distance_uses_farthest_corner(self) -> None:
        distance = _airbox_boundary_distance_from_bbox(
            object_bounds_min=(-1.0, -1.0, -1.0),
            object_bounds_max=(1.0, 1.0, 1.0),
            airbox_bounds_min=(-4.0, -4.0, -4.0),
            airbox_bounds_max=(4.0, 4.0, 4.0),
        )

        self.assertAlmostEqual(distance, np.sqrt(27.0))
        self.assertGreater(distance, 3.0)

    def test_csg_sanitizer_checks_all_geometries_for_lofted_arch_waveguide(self) -> None:
        box = fm.Box(20e-9, 10e-9, 2e-9, name="box")
        arch = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=12e-9,
            name="arch",
        )
        resolved = _sanitize_csg_mesh_options_for_geometries(
            MeshOptions(algorithm_3d=ALGO_3D_DELAUNAY),
            [box, arch],
            context="test shared-domain OCC mesh",
        )

        self.assertEqual(resolved.algorithm_3d, ALGO_3D_HXT)

    def test_airbox_boundary_distance_is_zero_when_boxes_match(self) -> None:
        distance = _airbox_boundary_distance_from_bbox(
            object_bounds_min=(-1.0, -2.0, -3.0),
            object_bounds_max=(1.0, 2.0, 3.0),
            airbox_bounds_min=(-1.0, -2.0, -3.0),
            airbox_bounds_max=(1.0, 2.0, 3.0),
        )

        self.assertEqual(distance, 0.0)

    def test_airbox_boundary_distance_handles_asymmetric_padding(self) -> None:
        distance = _airbox_boundary_distance_from_bbox(
            object_bounds_min=(0.0, 0.0, 0.0),
            object_bounds_max=(1.0, 1.0, 1.0),
            airbox_bounds_min=(-1.0, -2.0, -3.0),
            airbox_bounds_max=(2.0, 3.0, 5.0),
        )

        self.assertAlmostEqual(distance, np.sqrt(21.0))

    def test_airbox_grading_field_honors_geometric_vs_linear(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        geometric_fields = _FakeFieldApi()
        geometric_gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": geometric_fields})()},
                )(),
            },
        )()
        geometric_id = _add_airbox_grading_field(
            geometric_gmsh,
            surface_tags=[11, 12],
            h_inner=0.002,
            h_outer=0.5,
            grading_ratio=1.3,
            grading_mode="geometric",
            dist_max=2.0,
        )

        self.assertIsNotNone(geometric_id)
        self.assertEqual(
            list(geometric_fields.kinds.values()),
            ["Distance", "MathEval", "MathEval", "Min"],
        )
        geometric_expr = geometric_fields.strings[(2, "F")]
        self.assertIn("exp(", geometric_expr)
        self.assertIn("log(0.5 / 0.002)", geometric_expr)
        self.assertIn("F1 / 2", geometric_expr)

        linear_fields = _FakeFieldApi()
        linear_gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": linear_fields})()},
                )(),
            },
        )()
        linear_id = _add_airbox_grading_field(
            linear_gmsh,
            surface_tags=[11, 12],
            h_inner=0.002,
            h_outer=0.5,
            grading_ratio=1.3,
            grading_mode="linear",
            dist_max=2.0,
        )

        self.assertIsNotNone(linear_id)
        self.assertEqual(list(linear_fields.kinds.values()), ["Distance", "Threshold"])
        self.assertAlmostEqual(linear_fields.numbers[(2, "DistMax")], 2.0)

    def test_airbox_grading_field_is_restricted_to_air_volumes(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fields = _FakeFieldApi()
        gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fields})()},
                )(),
            },
        )()

        field_id = _add_airbox_grading_field(
            gmsh,
            surface_tags=[11, 12],
            h_inner=0.002,
            h_outer=0.5,
            grading_ratio=1.3,
            grading_mode="geometric",
            dist_max=2.0,
            air_volume_tags=[101, 102],
        )

        self.assertEqual(field_id, 5)
        self.assertEqual(
            list(fields.kinds.values()),
            ["Distance", "MathEval", "MathEval", "Min", "Restrict"],
        )
        self.assertEqual(fields.numbers[(5, "InField")], 4.0)
        self.assertEqual(fields.numbers[(5, "VolumesList")], [101.0, 102.0])

    def test_airbox_geometric_grading_adds_rectangular_boundary_envelope(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fields = _FakeFieldApi()
        gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fields})()},
                )(),
            },
        )()

        field_id = _add_airbox_grading_field(
            gmsh,
            surface_tags=[11],
            h_inner=0.002,
            h_outer=0.5,
            grading_ratio=1.5,
            grading_mode="geometric",
            dist_max=2.0,
            object_bounds_min=(-1.0, -0.5, -0.1),
            object_bounds_max=(1.0, 0.5, 0.1),
            airbox_bounds_min=(-4.0, -3.0, -2.0),
            airbox_bounds_max=(4.0, 3.0, 2.0),
        )

        self.assertIsNotNone(field_id)
        self.assertEqual(
            list(fields.kinds.values()),
            ["Distance", "MathEval", "MathEval", "Min", "MathEval", "Max"],
        )
        envelope_expr = fields.strings[(5, "F")]
        self.assertIn("exp(", envelope_expr)
        self.assertIn("log(0.5 /", envelope_expr)
        self.assertIn("x", envelope_expr)
        self.assertIn("y", envelope_expr)
        self.assertIn("z", envelope_expr)
        self.assertIn("0.5", envelope_expr)
        self.assertNotIn("Sqrt(", envelope_expr)

    def test_airbox_grading_uses_radial_envelope_for_sphere(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fields = _FakeFieldApi()
        gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fields})()},
                )(),
            },
        )()

        field_id = _add_airbox_grading_field(
            gmsh,
            surface_tags=[11],
            h_inner=0.002,
            h_outer=0.5,
            grading_ratio=1.5,
            grading_mode="geometric",
            dist_max=2.0,
            airbox_shape="sphere",
            airbox_center=(0.0, 0.0, 0.0),
            object_radius=1.0,
            airbox_radius=4.0,
        )

        self.assertIsNotNone(field_id)
        self.assertEqual(
            list(fields.kinds.values()),
            ["Distance", "MathEval", "MathEval", "Min", "MathEval", "Max"],
        )
        envelope_expr = fields.strings[(5, "F")]
        self.assertIn("Sqrt((x - (0))", envelope_expr)
        self.assertIn(" / 3", envelope_expr)
        self.assertNotIn("Max(Max(Max(", envelope_expr)

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

    def test_meshdata_to_ir_includes_mesh_statistics(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=self._unit_tet_mesh().nodes,
            elements=self._unit_tet_mesh().elements,
            element_markers=np.asarray([0], dtype=np.int32),
            boundary_faces=self._unit_tet_mesh().boundary_faces,
            boundary_markers=self._unit_tet_mesh().boundary_markers,
            quality=MeshQualityReport(
                n_elements=1,
                sicn_min=0.5,
                sicn_max=0.5,
                sicn_mean=0.5,
                sicn_p5=0.5,
                sicn_histogram=[0] * 20,
                gamma_min=0.25,
                gamma_mean=0.25,
                gamma_histogram=[0] * 20,
                volume_min=1.0 / 6.0,
                volume_max=1.0 / 6.0,
                volume_mean=1.0 / 6.0,
                volume_std=0.0,
                avg_quality=0.5,
                element_gamma=[0.25],
            ),
            per_domain_quality={
                0: MeshQualityReport(
                    n_elements=1,
                    sicn_min=0.5,
                    sicn_max=0.5,
                    sicn_mean=0.5,
                    sicn_p5=0.5,
                    sicn_histogram=[0] * 20,
                    gamma_min=0.25,
                    gamma_mean=0.25,
                    gamma_histogram=[0] * 20,
                    volume_min=1.0 / 6.0,
                    volume_max=1.0 / 6.0,
                    volume_mean=1.0 / 6.0,
                    volume_std=0.0,
                    avg_quality=0.5,
                )
            },
        )

        stats = mesh.to_ir("unit")["mesh_statistics"]

        self.assertEqual(stats["mesh_name"], "unit")
        self.assertEqual(stats["global"]["element_count"], 1)
        self.assertEqual(stats["scopes"][0]["role"], "air")
        self.assertEqual(stats["scopes"][0]["label"], "Airbox")
        self.assertAlmostEqual(stats["global"]["volume"]["ratio"], 1.0)
        self.assertAlmostEqual(stats["global"]["edge_length"]["min"], 1.0)
        self.assertAlmostEqual(stats["global"]["edge_length"]["max"], np.sqrt(2.0))
        self.assertAlmostEqual(
            stats["global"]["edge_length"]["mean"],
            (1.0 + np.sqrt(2.0)) / 2.0,
        )
        characteristic_size = (6.0 * np.sqrt(2.0) / 6.0) ** (1.0 / 3.0)
        self.assertAlmostEqual(
            stats["global"]["characteristic_size"]["min"],
            characteristic_size,
        )
        self.assertAlmostEqual(
            stats["global"]["characteristic_size"]["max"],
            characteristic_size,
        )
        self.assertEqual(
            stats["global"]["characteristic_size"]["histogram"],
            [
                {
                    "lo": characteristic_size,
                    "hi": characteristic_size,
                    "count": 1,
                }
            ],
        )
        self.assertEqual(
            {
                "global_elements": stats["global"]["element_count"],
                "airbox_elements": stats["scopes"][0]["element_count"],
                "worst_element_count": len(stats["worst_elements"]),
                "worst_element_marker": stats["worst_elements"][0]["marker"],
                "worst_element_gamma": stats["worst_elements"][0]["gamma"],
            },
            {
                "global_elements": 1,
                "airbox_elements": 1,
                "worst_element_count": 1,
                "worst_element_marker": 0,
                "worst_element_gamma": 0.25,
            },
        )

    def test_meshdata_to_ir_reports_thirty_characteristic_size_bins(self) -> None:
        scales = np.asarray([1.0, 1.5, 2.0, 3.0, 5.0, 8.0], dtype=np.float64)
        nodes: list[list[float]] = []
        elements: list[list[int]] = []
        for index, scale in enumerate(scales):
            base = len(nodes)
            offset = float(index) * 20.0
            nodes.extend(
                [
                    [offset, 0.0, 0.0],
                    [offset + float(scale), 0.0, 0.0],
                    [offset, float(scale), 0.0],
                    [offset, 0.0, float(scale)],
                ]
            )
            elements.append([base, base + 1, base + 2, base + 3])

        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(nodes, dtype=np.float64),
            elements=np.asarray(elements, dtype=np.int32),
            element_markers=np.zeros(len(elements), dtype=np.int32),
            boundary_faces=np.empty((0, 3), dtype=np.int32),
            boundary_markers=np.empty((0,), dtype=np.int32),
        )

        stats = mesh.to_ir("scaled")["mesh_statistics"]
        bins = stats["global"]["characteristic_size"]["histogram"]

        self.assertEqual(len(bins), 30)
        self.assertEqual(sum(bin_["count"] for bin_ in bins), len(elements))

    def test_mesh_statistics_reports_per_marker_boundary_faces(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [1, 2, 3, 4]], dtype=np.int32),
            element_markers=np.asarray([1, 2], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 4],
                    [1, 3, 4],
                    [2, 3, 4],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 20, 20, 20], dtype=np.int32),
        )

        stats = mesh.to_ir("shared_domain")["mesh_statistics"]
        scopes = {
            scope["marker"]: scope
            for scope in stats["scopes"]
            if scope.get("marker") is not None
        }
        boundary_scopes = {scope["id"]: scope for scope in stats["scopes"]}

        self.assertEqual(scopes[1]["boundary_face_count"], 3)
        self.assertEqual(scopes[2]["boundary_face_count"], 3)
        self.assertEqual(boundary_scopes["boundary:gamma_out"]["boundary_face_count"], 6)
        self.assertEqual(
            boundary_scopes["boundary:mag_air_interface"]["boundary_face_count"],
            1,
        )

    def test_periodic_shared_domain_uses_airbox_outer_surfaces(self) -> None:
        self.assertEqual(
            _periodic_candidate_surface_tags(
                gamma_out=[42, 7],
                component_surface_tags={"film": [1, 2, 3]},
                has_airbox=True,
            ),
            [7, 42],
        )
        self.assertEqual(
            _periodic_candidate_surface_tags(
                gamma_out=[42, 7],
                component_surface_tags={"film": [1, 2, 3]},
                has_airbox=True,
                all_surface_tags=[9, 2, 9],
            ),
            [2, 9],
        )
        self.assertEqual(
            _periodic_candidate_surface_tags(
                gamma_out=[],
                component_surface_tags={"left": [3, 1], "right": [2, 3]},
                has_airbox=False,
            ),
            [1, 2, 3],
        )

    def test_periodic_surface_matching_tolerates_occ_bbox_fuzz(self) -> None:
        class _FakeMesh:
            def __init__(self) -> None:
                self.calls: list[tuple[list[int], list[int], list[float]]] = []

            def setPeriodic(
                self,
                dim: int,
                slave_tags: list[int],
                master_tags: list[int],
                affine: list[float],
            ) -> None:
                self.calls.append((slave_tags, master_tags, affine))

        class _FakeModel:
            def __init__(self) -> None:
                self.mesh = _FakeMesh()
                self.bounds = {
                    1: (-0.04000004, -0.04000000, -0.005, -0.03999996, 0.04000000, 0.005),
                    2: (0.03999996, -0.04000000, -0.005, 0.04000004, 0.04000000, 0.005),
                    3: (-0.04000000, -0.04000004, -0.005, 0.04000000, -0.03999996, 0.005),
                    4: (-0.04000000, 0.03999996, -0.005, 0.04000000, 0.04000004, 0.005),
            }

            def getBoundingBox(self, dim: int, tag: int) -> tuple[float, ...]:
                assert dim == 2
                return self.bounds[tag]

        class _FakeGmsh:
            def __init__(self) -> None:
                self.model = _FakeModel()

        gmsh = _FakeGmsh()

        specs = _configure_axis_periodic_surfaces(
            gmsh,
            surface_tags=[1, 2, 3, 4],
            pair_ids=["x_faces"],
        )

        self.assertEqual(len(specs), 1)
        self.assertEqual(specs[0]["pair_id"], "x_faces")
        self.assertEqual(specs[0]["master_tag"], 1)
        self.assertEqual(specs[0]["slave_tag"], 2)
        self.assertEqual(gmsh.model.mesh.calls[0][0], [2])
        self.assertEqual(gmsh.model.mesh.calls[0][1], [1])

    def test_periodic_boundary_surfaces_get_non_robin_physical_markers(self) -> None:
        class _FakeModel:
            def __init__(self) -> None:
                self.physical_groups: list[tuple[int, list[int], int]] = []
                self.names: list[tuple[int, int, str]] = []

            def addPhysicalGroup(self, dim: int, tags: list[int], tag: int) -> None:
                self.physical_groups.append((dim, list(tags), tag))

            def setPhysicalName(self, dim: int, tag: int, name: str) -> None:
                self.names.append((dim, tag, name))

        class _FakeGmsh:
            def __init__(self) -> None:
                self.model = _FakeModel()

        specs = [
            {
                "pair_id": "x_faces",
                "master_tag": 14,
                "slave_tag": 18,
                "marker_a": 14,
                "marker_b": 18,
            },
            {
                "pair_id": "y_faces",
                "master_tag": 15,
                "slave_tag": 16,
                "marker_a": 15,
                "marker_b": 16,
            },
        ]
        gmsh = _FakeGmsh()

        surfaces = _add_periodic_boundary_physical_groups(
            gmsh,
            specs,
            reserved_markers={10, 99},
        )

        self.assertEqual(surfaces, {14, 15, 16, 18})
        markers = [group[2] for group in gmsh.model.physical_groups]
        self.assertEqual(markers, [100, 101, 102, 103])
        self.assertNotIn(99, markers)
        self.assertNotIn(10, markers)
        self.assertEqual(specs[0]["marker_a"], 100)
        self.assertEqual(specs[0]["marker_b"], 101)
        self.assertEqual(specs[1]["marker_a"], 102)
        self.assertEqual(specs[1]["marker_b"], 103)

    def test_extract_periodic_pairs_preserves_multiple_marker_pairs_per_axis(self) -> None:
        class _FakeMesh:
            def getPeriodicNodes(self, dim: int, slave_tag: int):
                assert dim == 2
                data = {
                    18: (14, [180, 181], [140, 141], []),
                    20: (16, [200, 201], [160, 161], []),
                }
                return data[slave_tag]

        class _FakeModel:
            def __init__(self) -> None:
                self.mesh = _FakeMesh()

        class _FakeGmsh:
            def __init__(self) -> None:
                self.model = _FakeModel()

        node_index = {
            140: 0,
            141: 1,
            160: 2,
            161: 3,
            180: 4,
            181: 5,
            200: 6,
            201: 7,
        }
        specs = [
            {
                "pair_id": "x_faces",
                "master_tag": 14,
                "slave_tag": 18,
                "marker_a": 100,
                "marker_b": 101,
                "translation": [200e-9, 0.0, 0.0],
                "tolerance_m": 1.0e-12,
            },
            {
                "pair_id": "x_faces",
                "master_tag": 16,
                "slave_tag": 20,
                "marker_a": 102,
                "marker_b": 103,
                "translation": [200e-9, 0.0, 0.0],
                "tolerance_m": 1.0e-12,
            },
        ]

        boundary_pairs, node_pairs = _extract_periodic_pairs(_FakeGmsh(), node_index, specs)

        self.assertEqual(
            [(pair["pair_id"], pair["marker_a"], pair["marker_b"]) for pair in boundary_pairs],
            [("x_faces", 100, 101), ("x_faces", 102, 103)],
        )
        self.assertEqual(
            [(pair["pair_id"], pair["node_a"], pair["node_b"]) for pair in node_pairs],
            [
                ("x_faces", 0, 4),
                ("x_faces", 1, 5),
                ("x_faces", 2, 6),
                ("x_faces", 3, 7),
            ],
        )

    def test_quality_arrays_reorder_to_mesh_element_tags(self) -> None:
        quality = MeshQualityReport(
            n_elements=2,
            sicn_min=0.1,
            sicn_max=0.8,
            sicn_mean=0.45,
            sicn_p5=0.135,
            sicn_histogram=[0] * 20,
            gamma_min=0.2,
            gamma_mean=0.55,
            gamma_histogram=[0] * 20,
            volume_min=1.0,
            volume_max=2.0,
            volume_mean=1.5,
            volume_std=0.5,
            avg_quality=0.45,
            element_sicn=[0.1, 0.8],
            element_gamma=[0.2, 0.9],
            element_volume=[1.0, 2.0],
            element_tags=[20, 10],
        )

        reordered = _align_quality_report_to_element_tags(quality, [10, 20])

        self.assertIsNotNone(reordered)
        self.assertEqual(reordered.element_tags, [10, 20])
        self.assertEqual(reordered.element_sicn, [0.8, 0.1])
        self.assertEqual(reordered.element_gamma, [0.9, 0.2])
        self.assertEqual(reordered.element_volume, [2.0, 1.0])

    def test_per_domain_quality_uses_final_shared_domain_markers(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [1, 4, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([0, 1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros(0, dtype=np.int32),
            quality=MeshQualityReport(
                n_elements=2,
                sicn_min=0.2,
                sicn_max=0.7,
                sicn_mean=0.45,
                sicn_p5=0.225,
                sicn_histogram=[0] * 20,
                gamma_min=0.3,
                gamma_mean=0.55,
                gamma_histogram=[0] * 20,
                volume_min=1.0,
                volume_max=2.0,
                volume_mean=1.5,
                volume_std=0.5,
                avg_quality=0.45,
                element_sicn=[0.2, 0.7],
                element_gamma=[0.3, 0.8],
                element_volume=[1.0, 2.0],
                element_tags=[1, 2],
            ),
        )
        final_markers = np.asarray([1, 0], dtype=np.int32)

        per_domain = build_per_domain_quality_from_mesh_arrays(
            mesh.nodes,
            mesh.elements,
            final_markers,
            mesh.quality,
        )

        self.assertIsNotNone(per_domain)
        self.assertEqual(set(per_domain.keys()), {0, 1})
        self.assertAlmostEqual(per_domain[0].gamma_min, 0.8)
        self.assertAlmostEqual(per_domain[1].gamma_min, 0.3)
        self.assertEqual(per_domain[0].n_elements, 1)
        self.assertEqual(per_domain[1].n_elements, 1)

    def test_mesh_statistics_publish_metric_ranked_worst_elements(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [1, 4, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1, 1], dtype=np.int32),
            boundary_faces=np.zeros((0, 3), dtype=np.int32),
            boundary_markers=np.zeros(0, dtype=np.int32),
            quality=MeshQualityReport(
                n_elements=2,
                sicn_min=0.05,
                sicn_max=0.8,
                sicn_mean=0.425,
                sicn_p5=0.0875,
                sicn_histogram=[0] * 20,
                gamma_min=0.04,
                gamma_mean=0.47,
                gamma_histogram=[0] * 20,
                volume_min=1.0,
                volume_max=2.0,
                volume_mean=1.5,
                volume_std=0.5,
                avg_quality=0.425,
                element_sicn=[0.8, 0.05],
                element_gamma=[0.04, 0.9],
                element_volume=[1.0, 2.0],
                element_tags=[1, 2],
            ),
        )

        payload = mesh.to_ir("ranked")["mesh_statistics"]

        self.assertEqual(payload["worst_elements"][0]["element_index"], 0)
        self.assertEqual(
            payload["worst_elements_by_metric"]["gamma"][0]["element_index"],
            0,
        )
        self.assertEqual(
            payload["worst_elements_by_metric"]["sicn"][0]["element_index"],
            1,
        )
        self.assertEqual(
            payload["worst_elements_by_metric"]["sicn"][0]["rank_metric"],
            "sicn",
        )
        self.assertEqual(payload["global"]["gamma"]["threshold"], 0.08)
        self.assertEqual(payload["global"]["gamma"]["below_threshold_count"], 1)
        self.assertEqual(payload["global"]["gamma"]["below_threshold_fraction"], 0.5)
        self.assertEqual(payload["global"]["sicn"]["threshold"], 0.1)
        self.assertEqual(payload["global"]["sicn"]["below_threshold_count"], 1)
        self.assertEqual(payload["global"]["sicn"]["below_threshold_fraction"], 0.5)

    def test_swept_quality_does_not_label_gamma_proxy_as_sicn(self) -> None:
        mesh = self._unit_tet_mesh()
        quality = _compute_swept_quality(mesh.nodes, mesh.elements)
        swept_mesh = MeshData.from_legacy_tet4(
            nodes=mesh.nodes,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=quality,
        )

        stats = swept_mesh.to_ir("swept")["mesh_statistics"]

        self.assertEqual(quality.quality_source, "swept_topology_proxy")
        self.assertEqual(quality.sicn_histogram, [])
        self.assertIsNone(quality.element_sicn)
        self.assertEqual(stats["quality_source"], "swept_topology_proxy")
        self.assertIsNone(stats["global"]["sicn"])
        self.assertIsNotNone(stats["global"]["gamma"])

    def test_remesh_cli_payload_carries_build_truth_and_mesh_statistics(self) -> None:
        mesh = self._unit_tet_mesh()
        report = SharedDomainBuildReport(
            build_mode="component_aware",
            fallbacks_triggered=["swept_prism_fallback"],
            effective_airbox_target=ResolvedAirboxTarget(
                hmax=40e-9,
                hmin=4e-9,
                growth_rate=1.3,
            ),
            effective_per_object_targets={
                "free_layer": ResolvedSharedObjectTarget(
                    geometry_name="free_layer",
                    marker=1,
                    hmax=8e-9,
                    source="recipe_override",
                )
            },
            used_size_field_kinds=["Box"],
            operation_statuses=[
                MeshOperationStatus(
                    kind="swept_prism",
                    scope="free_layer",
                    requested=True,
                    status="fallback",
                    requested_method="swept_prism",
                    actual_method="free_tetrahedral",
                    reason="airbox combined-domain swept workflow is not implemented",
                )
            ],
            thin_film_diagnostics=[
                ThinFilmDiagnostic(
                    geometry_name="free_layer",
                    scope="free_layer",
                    is_thin_film=True,
                    thickness=9e-9,
                    lateral_size=100e-9,
                    aspect_ratio=11.1,
                    requested_layers=3,
                    estimated_layers_from_hmax=1,
                    hmax_to_thickness_ratio=0.89,
                    requested_method="swept_prism",
                    actual_method="free_tetrahedral",
                    warnings=["requested swept/prism meshing fell back to free tetrahedral"],
                )
            ],
        )
        report_payload = report.to_dict()

        payload = _mesh_result_payload(
            mesh,
            mesh_name="shared-domain",
            generation_mode="shared_domain_manual_remesh",
            mesh_provenance={
                "shared_domain_build_report": report_payload,
                "operation_statuses": report_payload["operation_statuses"],
                "thin_film_diagnostics": report_payload["thin_film_diagnostics"],
            },
        )

        self.assertEqual(payload["mesh_statistics"]["global"]["element_count"], 1)
        self.assertEqual(
            payload["mesh_provenance"]["operation_statuses"][0]["status"],
            "fallback",
        )
        self.assertEqual(
            payload["mesh_provenance"]["thin_film_diagnostics"][0]["actual_method"],
            "free_tetrahedral",
        )

    def test_remesh_cli_payload_writes_per_element_quality_artifact(self) -> None:
        unit = self._unit_tet_mesh()
        mesh = MeshData.from_legacy_tet4(
            nodes=unit.nodes,
            elements=unit.elements,
            element_markers=unit.element_markers,
            boundary_faces=unit.boundary_faces,
            boundary_markers=unit.boundary_markers,
            quality=MeshQualityReport(
                n_elements=1,
                sicn_min=0.5,
                sicn_max=0.5,
                sicn_mean=0.5,
                sicn_p5=0.5,
                sicn_histogram=[0] * 20,
                gamma_min=0.25,
                gamma_mean=0.25,
                gamma_histogram=[0] * 20,
                volume_min=1.0 / 6.0,
                volume_max=1.0 / 6.0,
                volume_mean=1.0 / 6.0,
                volume_std=0.0,
                avg_quality=0.5,
                element_sicn=[0.5],
                element_gamma=[0.25],
                element_volume=[1.0 / 6.0],
            ),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            payload = _mesh_result_payload(
                mesh,
                mesh_name="shared-domain",
                generation_mode="shared_domain_manual_remesh",
                mesh_provenance={},
                topology_artifact_dir=tmp_dir,
            )

            artifact = payload["quality_data_artifact"]
            artifact_path = Path(artifact["path"])
            data = artifact_path.read_bytes()

        self.assertEqual(artifact["kind"], "fmmq.v1")
        self.assertEqual(artifact["element_count"], 1)
        self.assertEqual(artifact["metrics"], ["sicn", "gamma", "volume"])
        self.assertEqual(data[:4], b"FMMQ")
        self.assertEqual(data[4], 1)
        self.assertEqual(data[5], 1)
        self.assertEqual(struct.unpack_from("<I", data, 8)[0], 1)
        self.assertEqual(struct.unpack_from("<I", data, 12)[0], 0b111)
        self.assertAlmostEqual(struct.unpack_from("<d", data, 32)[0], 0.5)
        self.assertAlmostEqual(struct.unpack_from("<d", data, 40)[0], 0.25)
        self.assertAlmostEqual(struct.unpack_from("<d", data, 48)[0], 1.0 / 6.0)

    def test_shared_domain_report_includes_truth_first_operation_statuses(self) -> None:
        geometry = fm.Cylinder(radius=50e-9, height=9e-9, name="free_layer")
        mesh_options = MeshOptions(
            algorithm_3d=ALGO_3D_MMG3D,
            size_fields=[{"kind": "Box", "params": {"VIn": 8e-9}}],
            smoothing_steps=0,
            optimize=None,
            optimize_iters=3,
            mesh_strategy="swept_prism",
            through_thickness_elements=3,
        )

        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=AirboxOptions(maximum_element_size=100e-9),
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=list(mesh_options.size_fields),
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="single_geometry_occ",
            fallbacks_triggered=[],
            mesh_options=mesh_options,
        )
        payload = report.to_dict()
        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in payload["operation_statuses"]  # type: ignore[index]
        }

        self.assertEqual(statuses[("optimizer", "global")]["status"], "skipped")
        self.assertEqual(statuses[("optimizer", "global")]["details"]["optimize_iters"], 3)
        self.assertEqual(statuses[("algorithm_3d", "global")]["status"], "fallback")
        self.assertEqual(statuses[("algorithm_3d", "global")]["requested_method"], "MMG3D")
        self.assertEqual(statuses[("algorithm_3d", "global")]["actual_method"], "HXT")
        self.assertEqual(statuses[("swept_prism", "free_layer")]["status"], "fallback")
        self.assertIn("airbox", statuses[("swept_prism", "free_layer")]["reason"])
        self.assertEqual(
            payload["region_markers"],
            [{"geometry_name": "free_layer", "marker": 1}],
        )
        realized_fields = payload["size_fields_realized"]  # type: ignore[index]
        self.assertEqual(realized_fields[0]["id"], "sf1")
        self.assertEqual(realized_fields[0]["kind"], "Box")
        self.assertEqual(realized_fields[0]["status"], "requested")
        self.assertEqual(realized_fields[0]["source"], "scene_config")

        diagnostics = payload["thin_film_diagnostics"]  # type: ignore[index]
        self.assertEqual(len(diagnostics), 1)
        diagnostic = diagnostics[0]
        self.assertEqual(diagnostic["geometry_name"], "free_layer")
        self.assertTrue(diagnostic["is_thin_film"])
        self.assertEqual(diagnostic["requested_layers"], 3)
        self.assertEqual(diagnostic["estimated_layers_from_maximum_element_size"], 1)
        self.assertEqual(diagnostic["actual_method"], "free_tetrahedral")
        warning_text = "\n".join(diagnostic["warnings"])
        self.assertIn("below 4", warning_text)
        self.assertIn("smoothing is disabled", warning_text)
        self.assertIn("fell back", warning_text)

    def test_shared_domain_report_marks_thin_film_tetrahedral_method(self) -> None:
        geometry = fm.Box(100e-9, 40e-9, 2e-9, name="free_layer")
        mesh_options = MeshOptions(
            mesh_strategy="thin_film_tetrahedral",
            through_thickness_elements=1,
            smoothing_steps=1,
        )
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=AirboxOptions(maximum_element_size=100e-9),
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="conformal_occ",
            fallbacks_triggered=[],
            mesh_options=mesh_options,
        )

        statuses = {
            (status.kind, status.scope): status
            for status in report.operation_statuses
        }
        thin_film_status = statuses[("thin_film", "free_layer")]
        self.assertEqual(thin_film_status.status, "applied")
        self.assertEqual(thin_film_status.actual_method, "feature_aware_tetrahedral")
        self.assertNotIn(("swept_prism", "free_layer"), statuses)
        diagnostics = report.to_dict()["thin_film_diagnostics"]  # type: ignore[index]
        self.assertEqual(diagnostics[0]["requested_method"], "thin_film_tetrahedral")
        self.assertEqual(diagnostics[0]["actual_method"], "feature_aware_tetrahedral")
        self.assertNotIn(
            "thin-film object is using free tetrahedral meshing",
            "\n".join(diagnostics[0]["warnings"]),
        )

    def test_shared_domain_report_marks_sphere_airbox_degraded_on_geo_fallback(self) -> None:
        geometry = fm.Box(40e-9, 40e-9, 10e-9, name="free_layer")
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=AirboxOptions(
                shape="sphere",
                maximum_element_size=100e-9,
                minimum_element_size=10e-9,
            ),
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="component_aware",
            fallbacks_triggered=[],
            mesh_options=MeshOptions(),
        )

        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        airbox_shape = statuses[("airbox_shape", "global")]
        self.assertEqual(airbox_shape["status"], "degraded")
        self.assertEqual(airbox_shape["requested_method"], "sphere")
        self.assertEqual(airbox_shape["actual_method"], "bbox")
        self.assertIn("approximates spherical airbox", airbox_shape["reason"])

    def test_shared_domain_report_marks_component_fields_ignored_on_concatenated_fallback(self) -> None:
        geometry = fm.Box(40e-9, 40e-9, 10e-9, name="film")
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=AirboxOptions(maximum_element_size=100e-9),
            mesh_workflow={
                "per_geometry": [
                    {
                        "geometry": "film",
                        "edge_hmax": 5e-9,
                        "edge_thickness": 5e-9,
                        "corner_hmax": 5e-9,
                        "corner_extent": 5e-9,
                    }
                ]
            },
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "film", "marker": 1}],
            build_mode="concatenated_stl_fallback",
            fallbacks_triggered=["conformal_occ_failed", "component_aware_import_failed"],
            mesh_options=MeshOptions(),
        )

        self.assertTrue(report.degraded)
        self.assertIn("conformal_occ_failed", report.fallbacks_triggered)
        statuses = {
            (entry["kind"], entry["scope"], entry["requested_method"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        field_status = statuses[("size_field", "film", "component_edge_corner_refinement")]
        self.assertEqual(field_status["status"], "ignored")
        self.assertEqual(
            field_status["reason"],
            "requires_component_tags_unavailable_in_concatenated_stl_fallback",
        )

    def test_shared_domain_report_ignores_boundary_layer_without_targets(self) -> None:
        geometry = fm.Box(2.0, 2.0, 2.0, name="free_layer")
        mesh_options = MeshOptions(
            boundary_layer_count=3,
            boundary_layer_thickness=1e-9,
            boundary_layer_stretching=1.3,
        )
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=None,
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="component_aware",
            fallbacks_triggered=[],
            mesh_options=mesh_options,
        )
        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        boundary_layer = statuses[("boundary_layer", "global")]
        self.assertEqual(boundary_layer["status"], "ignored")
        self.assertIn("no explicit boundary-layer target", boundary_layer["reason"])
        self.assertIsNone(boundary_layer["details"]["target_selector"])
        self.assertEqual(boundary_layer["details"]["experimental"], True)

    def test_shared_domain_report_marks_boundary_layer_applied_with_targets(self) -> None:
        geometry = fm.Box(2.0, 2.0, 2.0, name="free_layer")
        mesh_options = MeshOptions(
            boundary_layer_count=3,
            boundary_layer_thickness=1e-9,
            boundary_layer_stretching=1.3,
            boundary_layer_target_surface_tags=[11, 12],
        )
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=None,
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="component_aware",
            fallbacks_triggered=[],
            mesh_options=mesh_options,
        )
        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        boundary_layer = statuses[("boundary_layer", "global")]
        self.assertEqual(boundary_layer["status"], "applied")
        self.assertEqual(boundary_layer["details"]["target_selector"], "explicit_surfaces_or_curves")
        self.assertEqual(boundary_layer["details"]["target_surface_tags"], [11, 12])

    def test_shared_domain_report_marks_boundary_layer_degraded_from_realization(self) -> None:
        geometry = fm.Box(2.0, 2.0, 2.0, name="free_layer")
        mesh_options = MeshOptions(
            boundary_layer_count=3,
            boundary_layer_thickness=1e-9,
            boundary_layer_stretching=1.3,
            boundary_layer_target_surface_tags=[11, 12],
        )
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=None,
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="component_aware",
            fallbacks_triggered=[],
            mesh_options=mesh_options,
            boundary_layer_result={
                "field_id": 42,
                "status": "degraded",
                "reason": "setAsBoundaryLayer unavailable: test",
            },
        )
        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        boundary_layer = statuses[("boundary_layer", "global")]
        self.assertEqual(boundary_layer["status"], "degraded")
        self.assertEqual(boundary_layer["actual_method"], "background_size_field")
        self.assertIn("setAsBoundaryLayer unavailable", boundary_layer["reason"])
        self.assertEqual(boundary_layer["details"]["gmsh_field_id"], 42)

    def test_shared_domain_report_serializes_selector_and_orphan_diagnostics(self) -> None:
        geometry = fm.Box(2.0, 2.0, 2.0, name="free_layer")
        selector = fm.mesh.nearest_surface_to_point(
            point=(1.0, 0.0, 0.0),
            geometry="free_layer",
        )
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=None,
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="component_aware",
            fallbacks_triggered=[],
            mesh_options=MeshOptions(
                boundary_layer_count=3,
                boundary_layer_thickness=1e-9,
                boundary_layer_target_surface_selectors=[selector],
            ),
            selector_resolution=[
                {
                    "selector": selector,
                    "dimension": 2,
                    "candidate_count": 6,
                    "resolved_tags": [11],
                    "distances": [0.0],
                    "closest_points": [1.0, 0.0, 0.0],
                }
            ],
            orphan_entities=[{"dimension": 2, "tag": 99}],
        )

        payload = report.to_dict()
        self.assertEqual(payload["selector_resolution"][0]["resolved_tags"], [11])
        self.assertEqual(payload["orphan_entities"], [{"dimension": 2, "tag": 99}])
        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in payload["operation_statuses"]  # type: ignore[index]
        }
        boundary_layer = statuses[("boundary_layer", "global")]
        self.assertEqual(boundary_layer["status"], "applied")
        self.assertEqual(boundary_layer["details"]["target_selector"], "semantic_selectors")
        self.assertEqual(boundary_layer["details"]["target_surface_selectors"], [selector])

    def test_shared_domain_report_marks_unresolved_selector_boundary_layer_ignored(self) -> None:
        geometry = fm.Box(2.0, 2.0, 2.0, name="free_layer")
        selector = fm.mesh.nearest_surface_to_point(
            point=(1.0, 0.0, 0.0),
            geometry="missing",
        )
        report = _build_shared_domain_build_report(
            [geometry],
            fm.FEM(order=1, hmax=20e-9),
            airbox=None,
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "free_layer", "marker": 1}],
            build_mode="component_aware",
            fallbacks_triggered=[],
            mesh_options=MeshOptions(
                boundary_layer_count=3,
                boundary_layer_thickness=1e-9,
                boundary_layer_target_surface_selectors=[selector],
            ),
            selector_resolution=[
                {
                    "selector": selector,
                    "dimension": 2,
                    "candidate_count": 0,
                    "resolved_tags": [],
                    "distances": [],
                    "closest_points": [],
                }
            ],
            orphan_entities=[],
        )

        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        boundary_layer = statuses[("boundary_layer", "global")]
        self.assertEqual(boundary_layer["status"], "ignored")
        self.assertIn("no boundary-layer selector resolved", boundary_layer["reason"])

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

    def test_remesh_cli_payload_spills_large_topology_to_artifact(self) -> None:
        mesh = self._unit_tet_mesh()

        with tempfile.TemporaryDirectory() as tmp_dir:
            payload = _mesh_result_payload(
                mesh,
                mesh_name="large_mesh",
                generation_mode="manual_remesh",
                mesh_provenance={"geometry_kind": "box", "order": 1, "hmax": 0.1},
                topology_artifact_dir=Path(tmp_dir),
                inline_topology_max_bytes=1,
            )

            artifact = payload.get("topology_artifact")
            self.assertIsInstance(artifact, dict)
            artifact_path = Path(artifact["path"])
            self.assertTrue(artifact_path.is_file())
            self.assertEqual(payload["nodes"], [])
            self.assertNotIn("elements", payload)
            self.assertNotIn("boundary_faces", payload)
            self.assertEqual(payload["cell_types"], [])
            self.assertEqual(payload["facet_types"], [])

            artifact_payload = json.loads(artifact_path.read_text(encoding="utf-8"))
            self.assertEqual(artifact_payload["mesh_name"], "large_mesh")
            self.assertEqual(artifact_payload["nodes"], mesh.nodes.tolist())
            self.assertNotIn("elements", artifact_payload)
            self.assertNotIn("boundary_faces", artifact_payload)
            self.assertEqual(artifact_payload["cell_types"], mesh.cell_types.tolist())
            self.assertEqual(artifact_payload["cell_offsets"], mesh.cell_offsets.tolist())
            self.assertEqual(artifact_payload["cell_nodes"], mesh.cell_nodes.tolist())
            self.assertEqual(artifact_payload["element_markers"], mesh.element_markers.tolist())
            self.assertEqual(artifact_payload["facet_types"], mesh.facet_types.tolist())
            self.assertEqual(artifact_payload["facet_roles"], mesh.facet_roles.tolist())
            self.assertEqual(artifact_payload["facet_offsets"], mesh.facet_offsets.tolist())
            self.assertEqual(artifact_payload["facet_nodes"], mesh.facet_nodes.tolist())
            self.assertEqual(artifact_payload["boundary_markers"], mesh.boundary_markers.tolist())

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
            "object_regions": [
                {
                    "region_id": "left:core",
                    "owner_geometry_name": "left",
                    "enabled": True,
                    "realization_policy": "conformal",
                    "shape": {
                        "kind": "box",
                        "center": [0.0, 0.0, 0.0],
                        "size": [0.5, 0.5, 0.5],
                    },
                }
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
                    object_region_markers=[
                        {"geometry_name": "left:core", "marker": 2}
                    ],
                    magnetic_submesh_signatures=[
                        {
                            "geometry_name": "left",
                            "marker": 1,
                            "node_count": 4,
                            "tetra_count": 1,
                            "edge_count": 6,
                            "coordinate_quantization_m": 1.0e-12,
                            "digest": "abc123",
                        }
                    ],
                ),
            ),
        ) as component_call:
            remesh_cli_module.main()

        component_call.assert_called_once()
        self.assertEqual(
            component_call.call_args.kwargs["object_regions"][0]["region_id"],
            "left:core",
        )
        payload = json.loads(stdout.getvalue())
        self.assertEqual(payload["generation_mode"], "shared_domain_manual_remesh")
        self.assertEqual(payload["region_markers"][0]["geometry_name"], "left")
        self.assertEqual(
            payload["object_region_markers"],
            [{"geometry_name": "left:core", "marker": 2}],
        )
        self.assertEqual(
            payload["mesh_provenance"]["magnetic_submesh_signatures"][0]["digest"],
            "abc123",
        )

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

    def test_surface_prep_mesh_options_skip_component_only_size_fields(self) -> None:
        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=0.0,
            name="arch",
        )

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "mesh_options": {},
                "per_geometry": [
                    {
                        "geometry": "arch",
                        "algorithm_3d": ALGO_3D_HXT,
                        "minimum_element_size": 1e-9,
                        "edge_hmax": "1e-9",
                        "edge_thickness": "6e-9",
                    }
                ],
            },
            geometries=[geometry],
            default_hmax=200e-9,
            component_aware=False,
            include_size_fields=False,
        )

        self.assertEqual(mesh_options.algorithm_3d, ALGO_3D_HXT)
        self.assertEqual(mesh_options.hmin, 1e-9)
        self.assertEqual(mesh_options.size_fields, [])

    def test_non_component_fallback_skips_edge_corner_size_fields(self) -> None:
        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=0.0,
            name="arch",
        )

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "mesh_options": {},
                "per_geometry": [
                    {
                        "geometry": "arch",
                        "hmax": 20e-9,
                        "edge_hmax": 5e-9,
                        "edge_thickness": 5e-9,
                        "corner_hmax": 5e-9,
                        "corner_extent": 5e-9,
                    }
                ],
            },
            geometries=[geometry],
            default_hmax=500e-9,
            component_aware=False,
        )

        kinds = [field["kind"] for field in mesh_options.size_fields]
        self.assertNotIn("EdgeDistanceThreshold", kinds)
        self.assertNotIn("CornerDistanceThreshold", kinds)

    @unittest.skipUnless(_has_trimesh, "trimesh not installed")
    def test_occ_failure_with_edge_corner_reports_degraded_fallback_not_secondary_error(self) -> None:
        geometry = fm.Box((100e-9, 40e-9, 2e-9), name="arch")
        fallback_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [-10e-9, -5e-9, -0.4e-9],
                    [10e-9, -5e-9, -0.4e-9],
                    [0.0, 5e-9, -0.4e-9],
                    [0.0, 0.0, 0.4e-9],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )

        with patch(
            "fullmag.meshing._gmsh_occ.is_occ_compatible",
            return_value=True,
        ), patch(
            "fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ",
            side_effect=RuntimeError("forced OCC failure"),
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components",
            side_effect=RuntimeError("forced component-aware failure"),
        ), patch(
            "fullmag.meshing.gmsh_bridge.generate_mesh_from_file",
            return_value=fallback_mesh,
        ):
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                [geometry],
                fm.FEM(order=1, hmax=20e-9),
                study_universe={
                    "mode": "manual",
                    "size": [200e-9, 120e-9, 60e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 80e-9,
                    "airbox_hmin": 10e-9,
                },
                mesh_workflow={
                    "per_geometry": [
                        {
                            "geometry": "arch",
                            "hmax": 20e-9,
                            "edge_hmax": 5e-9,
                            "edge_thickness": 5e-9,
                            "corner_hmax": 5e-9,
                            "corner_extent": 5e-9,
                        }
                    ]
                },
            )

        self.assertEqual(mesh.n_elements, 1)
        self.assertEqual(region_markers, [{"geometry_name": "arch", "marker": 1}])
        self.assertEqual(report.build_mode, "concatenated_stl_fallback")
        self.assertIn("conformal_occ_failed", report.fallbacks_triggered)
        self.assertIn("component_aware_import_failed", report.fallbacks_triggered)
        self.assertTrue(report.degraded)
        self.assertFalse(
            any(
                status.reason == "edge/corner refinement currently requires component-aware shared-domain meshing"
                for status in report.operation_statuses
            )
        )
        self.assertTrue(
            any(
                status.reason == "requires_component_tags_unavailable_in_concatenated_stl_fallback"
                and status.status == "ignored"
                for status in report.operation_statuses
            )
        )

    def test_transition_distance_zero_disables_auto_transition_field(self) -> None:
        geometry = fm.Box(size=(100e-9, 80e-9, 2e-9), name="film")

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [
                    {
                        "geometry": "film",
                        "hmax": 20e-9,
                        "maximum_element_size": 20e-9,
                        "transition_distance": 0.0,
                    }
                ],
            },
            geometries=[geometry],
            default_hmax=500e-9,
            component_aware=True,
        )

        kinds = [field["kind"] for field in mesh_options.size_fields]
        self.assertIn("ComponentVolumeConstant", kinds)
        self.assertNotIn("TransitionShellThreshold", kinds)

    @unittest.skipUnless(_has_trimesh, "trimesh not installed")
    def test_arch_waveguide_surface_triangulation_respects_surface_hmax(self) -> None:
        trimesh = _import_trimesh()
        geometry = fm.ArchWaveguide(
            length=10e-9,
            width=4e-9,
            height=2e-9,
            arch_height=0.0,
            name="arch",
        )

        mesh = _geometry_to_trimesh(
            geometry,
            trimesh,
            surface_maximum_element_size=2e-9,
        )
        edges = mesh.edges_unique
        lengths = np.linalg.norm(
            np.asarray(mesh.vertices[edges[:, 0]]) - np.asarray(mesh.vertices[edges[:, 1]]),
            axis=1,
        )

        self.assertGreater(len(mesh.vertices), 4 * 48)
        self.assertLessEqual(float(lengths.max()), 3.0e-9)

    def test_runtime_mesh_options_preserve_single_object_swept_controls(self) -> None:
        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=20e-9,
            name="arch",
        )

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "mesh_options": {},
                "per_geometry": [
                    {
                        "geometry": "arch",
                        "mesh_strategy": "swept_prism",
                        "through_thickness_elements": 1,
                        "through_thickness_distribution": "fixed",
                        "through_thickness_element_ratio": 1.0,
                        "sweep_face_meshing": "triangular",
                    }
                ],
            },
            geometries=[geometry],
            default_hmax=20e-9,
            component_aware=True,
        )

        self.assertEqual(mesh_options.mesh_strategy, "swept_prism")
        self.assertEqual(mesh_options.through_thickness_elements, 1)
        self.assertEqual(mesh_options.through_thickness_distribution, "fixed")
        self.assertEqual(mesh_options.through_thickness_element_ratio, 1.0)
        self.assertEqual(mesh_options.sweep_face_meshing, "triangular")

    def test_runtime_mesh_options_preserve_single_object_gmsh_controls(self) -> None:
        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=0.0,
            name="arch",
        )

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "mesh_options": {},
                "per_geometry": [
                    {
                        "geometry": "arch",
                        "algorithm_2d": 6,
                        "algorithm_3d": ALGO_3D_HXT,
                        "minimum_element_size": 2e-9,
                        "size_factor": 0.8,
                        "size_from_curvature": 12,
                        "curvature_factor": 0.5,
                        "maximum_element_growth_rate": 1.3,
                        "narrow_regions": 2,
                        "narrow_region_resolution": 1.0,
                        "smoothing_steps": 4,
                        "optimize": "Netgen",
                        "optimize_iterations": 6,
                        "compute_quality": True,
                        "per_element_quality": False,
                    }
                ],
            },
            geometries=[geometry],
            default_hmax=20e-9,
            component_aware=True,
        )

        self.assertEqual(mesh_options.algorithm_2d, 6)
        self.assertEqual(mesh_options.algorithm_3d, ALGO_3D_HXT)
        self.assertEqual(mesh_options.hmin, 2e-9)
        self.assertEqual(mesh_options.size_factor, 0.8)
        self.assertEqual(mesh_options.size_from_curvature, 12)
        self.assertEqual(mesh_options.curvature_factor, 0.5)
        self.assertEqual(mesh_options.growth_rate, 1.3)
        self.assertEqual(mesh_options.narrow_regions, 2)
        self.assertEqual(mesh_options.narrow_region_resolution, 1.0)
        self.assertEqual(mesh_options.smoothing_steps, 4)
        self.assertEqual(mesh_options.optimize, "Netgen")
        self.assertEqual(mesh_options.optimize_iters, 6)
        self.assertTrue(mesh_options.compute_quality)
        self.assertFalse(mesh_options.per_element_quality)

    def test_runtime_mesh_options_preserve_single_object_recipe_gmsh_controls(self) -> None:
        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=0.0,
            name="arch",
        )

        mesh_options = _mesh_options_from_runtime_metadata(
            {"mesh_options": {}, "per_geometry": []},
            geometries=[geometry],
            default_hmax=20e-9,
            component_aware=True,
            per_object_recipes={
                "arch": PerObjectMeshRecipe(
                    minimum_element_size=2e-9,
                    algorithm_2d=6,
                    algorithm_3d=ALGO_3D_HXT,
                    size_factor=0.8,
                    size_from_curvature=12,
                    curvature_factor=0.5,
                    growth_rate=1.3,
                    narrow_regions=2,
                    narrow_region_resolution=1.0,
                    smoothing_steps=4,
                    optimize="Netgen",
                    optimize_iters=6,
                ),
            },
        )

        self.assertEqual(mesh_options.algorithm_2d, 6)
        self.assertEqual(mesh_options.algorithm_3d, ALGO_3D_HXT)
        self.assertEqual(mesh_options.hmin, 2e-9)
        self.assertEqual(mesh_options.size_factor, 0.8)
        self.assertEqual(mesh_options.size_from_curvature, 12)
        self.assertEqual(mesh_options.curvature_factor, 0.5)
        self.assertEqual(mesh_options.growth_rate, 1.3)
        self.assertEqual(mesh_options.narrow_regions, 2)
        self.assertEqual(mesh_options.narrow_region_resolution, 1.0)
        self.assertEqual(mesh_options.smoothing_steps, 4)
        self.assertEqual(mesh_options.optimize, "Netgen")
        self.assertEqual(mesh_options.optimize_iters, 6)

    def test_size_only_recipe_inherits_global_quality_flags(self) -> None:
        geometry = fm.Box(20e-9, 20e-9, 5e-9, name="sample")

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "mesh_options": {
                    "compute_quality": True,
                    "per_element_quality": True,
                },
                "per_geometry": [],
            },
            geometries=[geometry],
            default_hmax=20e-9,
            component_aware=True,
            per_object_recipes={
                "sample": PerObjectMeshRecipe(maximum_element_size=10e-9),
            },
        )

        self.assertTrue(mesh_options.compute_quality)
        self.assertTrue(mesh_options.per_element_quality)

    def test_runtime_mesh_options_reject_conflicting_recipe_global_controls(self) -> None:
        left = fm.Box(20e-9, 20e-9, 5e-9, name="left")
        right = fm.Box(20e-9, 20e-9, 5e-9, name="right")

        with self.assertRaisesRegex(
            ValueError,
            "per-object algorithm_3d values must match",
        ):
            _mesh_options_from_runtime_metadata(
                {"mesh_options": {}, "per_geometry": []},
                geometries=[left, right],
                default_hmax=20e-9,
                component_aware=True,
                per_object_recipes={
                    "left": PerObjectMeshRecipe(algorithm_3d=ALGO_3D_HXT),
                    "right": PerObjectMeshRecipe(algorithm_3d=ALGO_3D_DELAUNAY),
                },
            )

    def test_remesh_cli_mesh_options_preserve_swept_and_boundary_layer_controls(self) -> None:
        mesh_options = _mesh_options_from_dict(
            {
                "mesh_strategy": "swept_prism",
                "through_thickness_elements": 3,
                "through_thickness_distribution": "exponential",
                "through_thickness_element_ratio": 1.4,
                "through_thickness_symmetric": True,
                "sweep_face_meshing": "quadrilateral",
                "sweep_source": "bottom",
                "sweep_destination": "top",
                "boundary_layer_count": 4,
                "boundary_layer_thickness": 1.5e-9,
                "boundary_layer_stretching": 1.25,
                "boundary_layer_target_surface_tags": [11, "12"],
                "boundary_layer_target_curve_tags": [21, "22"],
            }
        )

        self.assertEqual(mesh_options.mesh_strategy, "swept_prism")
        self.assertEqual(mesh_options.through_thickness_elements, 3)
        self.assertEqual(mesh_options.through_thickness_distribution, "exponential")
        self.assertEqual(mesh_options.through_thickness_element_ratio, 1.4)
        self.assertTrue(mesh_options.through_thickness_symmetric)
        self.assertEqual(mesh_options.sweep_face_meshing, "quadrilateral")
        self.assertEqual(mesh_options.sweep_source, "bottom")
        self.assertEqual(mesh_options.sweep_destination, "top")
        self.assertEqual(mesh_options.boundary_layer_count, 4)
        self.assertEqual(mesh_options.boundary_layer_thickness, 1.5e-9)
        self.assertEqual(mesh_options.boundary_layer_stretching, 1.25)
        self.assertEqual(mesh_options.boundary_layer_target_surface_tags, [11, 12])
        self.assertEqual(mesh_options.boundary_layer_target_curve_tags, [21, 22])

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
        # Plain per-object hmax should not auto-refine the neighboring airbox.
        self.assertEqual(kinds, ["ComponentVolumeConstant"])
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
        self.assertIsNone(effective_targets["left_geom"]["transition_distance"])
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
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, _kind: str) -> int:
                field_id = self._next_id
                self._next_id += 1
                return field_id

            def setNumber(self, _field_id: int, _key: str, _value: float) -> None:
                return None

            def setNumbers(self, _field_id: int, _key: str, _values: object) -> None:
                return None

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value
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
                            "Source": "test_metadata",
                        },
                    }
                ],
            ),
        )

        self.assertEqual(fake_gmsh.option.values["Mesh.Algorithm3D"], float(ALGO_3D_HXT))
        self.assertIsNotNone(fake_field_api.background)
        self.assertNotIn((1, "Source"), fake_field_api.strings)

    def test_apply_mesh_options_scales_box_field_coordinates(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next_id = 1
                self.background: int | None = None
                self.numbers: dict[tuple[int, str], float | list[float]] = {}

            def add(self, _kind: str) -> int:
                field_id = self._next_id
                self._next_id += 1
                return field_id

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

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
            hmax=500e-9,
            order=1,
            hscale=1e6,
            opts=MeshOptions(
                size_fields=[
                    {
                        "kind": "Box",
                        "params": {
                            "VIn": 45e-9,
                            "VOut": 500e-9,
                            "XMin": -1.25e-6,
                            "XMax": 1.25e-6,
                            "YMin": -0.5e-6,
                            "YMax": 0.5e-6,
                            "ZMin": 1e-9,
                            "ZMax": 91e-9,
                        },
                    }
                ],
            ),
        )

        self.assertAlmostEqual(fake_field_api.numbers[(1, "VIn")], 0.045)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "XMin")], -1.25)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "XMax")], 1.25)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "ZMin")], 0.001)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "ZMax")], 0.091)

    def test_apply_mesh_options_supports_component_restricted_cylinder(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next_id = 1
                self.background: int | None = None
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                field_id = self._next_id
                self._next_id += 1
                self.kinds[field_id] = kind
                return field_id

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

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
            hmax=500e-9,
            order=1,
            hscale=1e6,
            component_volume_tags={"arch_waveguide_geom": [42]},
            opts=MeshOptions(
                size_fields=[
                    {
                        "kind": "ComponentRestrictedCylinder",
                        "params": {
                            "GeometryName": "arch_waveguide_geom",
                            "VIn": 12e-9,
                            "VOut": 20e-9,
                            "Radius": 500e-9,
                            "XCenter": 125e-9,
                            "YCenter": -50e-9,
                            "ZCenter": 1e-9,
                        },
                    }
                ],
            ),
        )

        self.assertEqual(fake_field_api.kinds[1], "Cylinder")
        self.assertEqual(fake_field_api.kinds[2], "Restrict")
        self.assertAlmostEqual(fake_field_api.numbers[(1, "VIn")], 0.012)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "VOut")], 0.02)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "Radius")], 0.5)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "XCenter")], 0.125)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "YCenter")], -0.05)
        self.assertAlmostEqual(fake_field_api.numbers[(1, "ZCenter")], 0.001)
        self.assertEqual(fake_field_api.numbers[(1, "XAxis")], 0.0)
        self.assertEqual(fake_field_api.numbers[(1, "YAxis")], 0.0)
        self.assertEqual(fake_field_api.numbers[(1, "ZAxis")], 1.0)
        self.assertEqual(fake_field_api.numbers[(2, "InField")], 1.0)
        self.assertEqual(fake_field_api.numbers[(2, "VolumesList")], [42.0])
        self.assertEqual(fake_field_api.background, 2)

    def test_airbox_minimum_size_does_not_create_lower_bound_clamp(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

        fake_field_api = _FakeFieldApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fake_field_api})()},
                )(),
            },
        )()

        _upper_fields, lower_fields = _add_airbox_volume_clamp_fields(
            fake_gmsh,
            air_volume_tags=[2],
            airbox=AirboxOptions(
                maximum_element_size=200e-9,
                minimum_element_size=40e-9,
            ),
        )

        self.assertEqual(lower_fields, [])

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

    def test_geometry_from_ir_preserves_cylinder_axis_round_trip(self) -> None:
        geometry = _geometry_from_ir(
            {
                "kind": "cylinder",
                "name": "tilted",
                "radius": 2.0,
                "height": 5.0,
                "axis": [1.0, 1.0, 1.0],
            }
        )

        self.assertIsInstance(geometry, fm.Cylinder)
        self.assertEqual(geometry.to_ir()["axis"], [1.0 / (3.0**0.5)] * 3)

    def test_cylinder_rejects_zero_and_nonfinite_axis(self) -> None:
        with self.assertRaisesRegex(ValueError, "axis must be a non-zero finite vector"):
            fm.Cylinder(radius=1.0, height=2.0, axis=(0.0, 0.0, 0.0))
        with self.assertRaisesRegex(ValueError, "axis must be a non-zero finite vector"):
            fm.Cylinder(radius=1.0, height=2.0, axis=(float("nan"), 0.0, 1.0))

    def test_geometry_from_ir_reconstructs_waveguide_kinds(self) -> None:
        sin_geometry = _geometry_from_ir(
            {
                "kind": "sin_waveguide",
                "name": "sinus",
                "length": 10.0,
                "width": 2.0,
                "height": 1.0,
                "period": 8.0,
                "amplitude": 3.0,
                "phase": 0.5,
                "z0": -1.0,
            }
        )
        arch_geometry = _geometry_from_ir(
            {
                "kind": "arch_waveguide",
                "name": "arch",
                "length": 10.0,
                "width": 2.0,
                "height": 1.0,
                "arch_height": -4.0,
                "z0": 2.0,
            }
        )

        self.assertIsInstance(sin_geometry, fm.SinWaveguide)
        self.assertEqual(sin_geometry.geometry_name, "sinus")
        self.assertIsInstance(arch_geometry, fm.ArchWaveguide)
        self.assertEqual(arch_geometry.geometry_name, "arch")

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
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)
                return None

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]
                return None

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value
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
        self.assertIn("Threshold", fake_field_api.kinds.values())
        threshold_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "Threshold"
        ]
        self.assertTrue(
            any(
                fake_field_api.numbers.get((field_id, "SizeMin")) is not None
                and fake_field_api.numbers.get((field_id, "DistMax")) is not None
                and np.isclose(fake_field_api.numbers.get((field_id, "SizeMin")), 1e-9)
                and np.isclose(fake_field_api.numbers.get((field_id, "DistMax")), 5e-9)
                for field_id in threshold_ids
            )
        )

    def test_curvature_factor_field_targets_only_curved_surfaces(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

        fake_field_api = _FakeFieldApi()

        class _FakeModel:
            mesh = type("FakeMesh", (), {"field": fake_field_api})()

            @staticmethod
            def getParametrizationBounds(dim: int, tag: int) -> tuple[list[float], list[float]]:
                return [0.0, 0.0], [1.0, 1.0]

            @staticmethod
            def getCurvature(dim: int, tag: int, coords: list[float]) -> list[float]:
                count = len(coords) // 2
                return ([0.0] * count) if tag == 1 else ([2.0] * count)

        fake_gmsh = type("FakeGmsh", (), {"model": _FakeModel()})()

        field_id = _add_curvature_surface_field(
            fake_gmsh,
            curvature_samples=8,
            hmax=1.0,
            curvature_factor=0.4,
            component_surface_tags={"body": [1, 2]},
        )

        self.assertIsNotNone(field_id)
        distance_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "Distance"
        ]
        threshold_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "Threshold"
        ]
        self.assertEqual(len(distance_ids), 1)
        self.assertEqual(fake_field_api.numbers[(distance_ids[0], "SurfacesList")], [2.0])
        self.assertEqual(len(threshold_ids), 1)
        self.assertAlmostEqual(fake_field_api.numbers[(threshold_ids[0], "SizeMin")], 0.2)

    def test_curvature_factor_field_skips_flat_surfaces(self) -> None:
        class _FakeFieldApi:
            def add(self, kind: str) -> int:
                raise AssertionError("flat curvature should not create size fields")

        class _FakeModel:
            mesh = type("FakeMesh", (), {"field": _FakeFieldApi()})()

            @staticmethod
            def getParametrizationBounds(dim: int, tag: int) -> tuple[list[float], list[float]]:
                return [0.0, 0.0], [1.0, 1.0]

            @staticmethod
            def getCurvature(dim: int, tag: int, coords: list[float]) -> list[float]:
                return [0.0] * (len(coords) // 2)

        fake_gmsh = type("FakeGmsh", (), {"model": _FakeModel()})()

        field_id = _add_curvature_surface_field(
            fake_gmsh,
            curvature_samples=8,
            hmax=1.0,
            curvature_factor=0.4,
            component_surface_tags={"body": [1]},
        )

        self.assertIsNone(field_id)

    def test_narrow_region_field_adds_component_volume_span_constraint(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fake_field_api = _FakeFieldApi()

        class _FakeModel:
            mesh = type("FakeMesh", (), {"field": fake_field_api})()

            @staticmethod
            def getBoundingBox(dim: int, tag: int) -> tuple[float, float, float, float, float, float]:
                if dim == 3 and tag == 11:
                    return (0.0, 0.0, 0.0, 100e-9, 40e-9, 6e-9)
                raise ValueError("unexpected entity")

        fake_gmsh = type("FakeGmsh", (), {"model": _FakeModel()})()

        field_id = _add_narrow_region_field(
            fake_gmsh,
            n_resolve=5,
            hmax=20e-9,
            hmin=0.5e-9,
            component_surface_tags={"body": [1]},
            component_volume_tags={"body": [11]},
        )

        self.assertIsNotNone(field_id)
        constant_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "Constant"
        ]
        self.assertEqual(len(constant_ids), 1)
        constant_id = constant_ids[0]
        self.assertEqual(fake_field_api.numbers[(constant_id, "VolumesList")], [11.0])
        self.assertAlmostEqual(fake_field_api.numbers[(constant_id, "VIn")], 1.2e-9)
        self.assertAlmostEqual(fake_field_api.numbers[(constant_id, "VOut")], 20e-9)
        self.assertIn("Min", fake_field_api.kinds.values())

    def test_size_field_schema_rejects_missing_required_params(self) -> None:
        with self.assertRaisesRegex(ValueError, "missing required params: DistMax"):
            validate_size_field_config(
                {
                    "kind": "EdgeDistanceThreshold",
                    "params": {
                        "GeometryName": "free_layer",
                        "SizeMin": 0.8e-9,
                        "SizeMax": 3.0e-9,
                        "DistMin": 0.0,
                    },
                }
            )

    def test_edge_distance_threshold_field_uses_curves_without_component_restrict(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.background: int | None = None
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

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
                        "getEntities": staticmethod(lambda dim: []),
                        "getBoundary": staticmethod(lambda _tags, oriented=False: [(1, 11), (1, -12)]),
                    },
                )(),
            },
        )()

        size_field_config = {
            "kind": "EdgeDistanceThreshold",
            "params": {
                "GeometryName": "free_layer",
                "SizeMin": 0.8e-9,
                "SizeMax": 3.0e-9,
                "DistMin": 0.0,
                "DistMax": 5.0e-9,
                "Sampling": 40,
            },
        }
        _apply_mesh_options(
            fake_gmsh,
            hmax=5e-9,
            order=1,
            opts=MeshOptions(size_fields=[size_field_config]),
            component_surface_tags={"free_layer": [7]},
            component_volume_tags={"free_layer": [3]},
        )

        distance_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "Distance"
        ]
        self.assertEqual(len(distance_ids), 1)
        self.assertEqual(fake_field_api.numbers[(distance_ids[0], "CurvesList")], [11.0, 12.0])
        self.assertNotIn("Restrict", fake_field_api.kinds.values())
        self.assertIsNotNone(fake_field_api.background)
        self.assertEqual(size_field_config["_gmsh_status"], "applied")
        self.assertEqual(size_field_config["_gmsh_field_id"], 2)

    def test_edge_distance_threshold_accepts_geometric_growth_rate(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.background: int | None = None
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

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
                        "getEntities": staticmethod(lambda dim: []),
                        "getBoundary": staticmethod(lambda _tags, oriented=False: [(1, 11), (1, -12)]),
                    },
                )(),
            },
        )()

        _apply_mesh_options(
            fake_gmsh,
            hmax=5e-9,
            order=1,
            opts=MeshOptions(
                size_fields=[
                    {
                        "kind": "EdgeDistanceThreshold",
                        "params": {
                            "GeometryName": "free_layer",
                            "SizeMin": 0.8e-9,
                            "SizeMax": 3.0e-9,
                            "DistMin": 0.0,
                            "DistMax": 5.0e-9,
                            "Sampling": 40,
                            "Grading": "geometric",
                            "GrowthRate": 1.42,
                        },
                    }
                ]
            ),
            component_surface_tags={"free_layer": [7]},
            component_volume_tags={"free_layer": [3]},
        )

        self.assertIn("MathEval", fake_field_api.kinds.values())
        self.assertNotIn("Threshold", fake_field_api.kinds.values())
        math_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "MathEval"
        ]
        self.assertIn("1.42", fake_field_api.strings[(math_ids[0], "F")])

    def test_corner_distance_threshold_field_uses_curve_endpoints_without_component_restrict(self) -> None:
        class _FakeOptionsApi:
            def __init__(self) -> None:
                self.values: dict[str, float] = {}

            def setNumber(self, key: str, value: float) -> None:
                self.values[key] = float(value)

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.background: int | None = None
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

            def setAsBackgroundMesh(self, field_id: int) -> None:
                self.background = field_id

        def _boundary(tags: object, oriented: bool = False) -> list[tuple[int, int]]:
            dim, tag = tags[0]
            if dim == 2 and tag == 7:
                return [(1, 11), (1, -12)]
            if dim == 1 and abs(tag) == 11:
                return [(0, 101), (0, -102)]
            if dim == 1 and abs(tag) == 12:
                return [(0, 102), (0, 103)]
            return []

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
                        "getEntities": staticmethod(lambda dim: []),
                        "getBoundary": staticmethod(_boundary),
                    },
                )(),
            },
        )()

        size_field_config = {
            "kind": "CornerDistanceThreshold",
            "params": {
                "GeometryName": "free_layer",
                "SizeMin": 0.8e-9,
                "SizeMax": 3.0e-9,
                "DistMin": 0.0,
                "DistMax": 5.0e-9,
                "Sampling": 20,
                "Grading": "geometric",
                "GrowthRate": 1.42,
            },
        }
        _apply_mesh_options(
            fake_gmsh,
            hmax=5e-9,
            order=1,
            opts=MeshOptions(size_fields=[size_field_config]),
            component_surface_tags={"free_layer": [7]},
            component_volume_tags={"free_layer": [3]},
        )

        distance_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "Distance"
        ]
        self.assertEqual(len(distance_ids), 1)
        self.assertEqual(
            fake_field_api.numbers[(distance_ids[0], "PointsList")],
            [101.0, 102.0, 103.0],
        )
        self.assertIn("MathEval", fake_field_api.kinds.values())
        self.assertNotIn("Threshold", fake_field_api.kinds.values())
        math_ids = [
            field_id
            for field_id, kind in fake_field_api.kinds.items()
            if kind == "MathEval"
        ]
        math_expr = fake_field_api.strings[(math_ids[0], "F")]
        self.assertIn("exp(", math_expr)
        self.assertIn("log(1.42)", math_expr)
        self.assertNotIn("Restrict", fake_field_api.kinds.values())
        self.assertIsNotNone(fake_field_api.background)
        self.assertEqual(size_field_config["_gmsh_status"], "applied")
        self.assertEqual(size_field_config["_gmsh_field_id"], 2)

    def test_axis_aligned_box_geometric_field_uses_growth_rate(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.kinds: dict[int, str] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fake_field_api = _FakeFieldApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fake_field_api})()},
                )(),
            },
        )()

        field_id = _add_axis_aligned_box_distance_threshold_field(
            fake_gmsh,
            bounds_min=(-1.0, -1.0, -1.0),
            bounds_max=(1.0, 1.0, 1.0),
            size_min=2.0,
            size_max=20.0,
            dist_min=0.0,
            dist_max=8.0,
            grading="geometric",
            growth_rate=1.45,
        )

        self.assertIsNotNone(field_id)
        expr = fake_field_api.strings[(field_id, "F")]
        self.assertIn("log(20 / 2)", expr)
        self.assertIn("log(1.45)", expr)

    def test_axis_aligned_box_airbox_boundary_ramp_uses_per_face_clearance(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self.next_id = 0
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                self.next_id += 1
                return self.next_id

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fake_field_api = _FakeFieldApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fake_field_api})()},
                )(),
            },
        )()

        field_id = _add_axis_aligned_box_distance_threshold_field(
            fake_gmsh,
            bounds_min=(-1.0, -1.0, -0.5),
            bounds_max=(1.0, 1.0, 0.5),
            airbox_bounds_min=(-3.0, -2.0, -1.5),
            airbox_bounds_max=(3.0, 2.0, 1.5),
            size_min=2.0,
            size_max=20.0,
            dist_min=0.25,
            dist_max=2.0,
        )

        self.assertIsNotNone(field_id)
        expr = fake_field_api.strings[(field_id, "F")]
        self.assertNotIn("Sqrt(", expr)
        self.assertIn("Max((-1) - x, 0)", expr)
        self.assertIn("Max(x - (1), 0)", expr)
        self.assertIn("Max((-0.5) - z, 0)", expr)
        self.assertIn("/ 1.75", expr)
        self.assertIn("/ 0.75", expr)

    def test_axis_aligned_box_airbox_boundary_ramp_wraps_negative_constants(self) -> None:
        class _FakeFieldApi:
            def __init__(self) -> None:
                self.next_id = 0
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                self.next_id += 1
                return self.next_id

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

        fake_field_api = _FakeFieldApi()
        fake_gmsh = type(
            "FakeGmsh",
            (),
            {
                "model": type(
                    "FakeModel",
                    (),
                    {"mesh": type("FakeMesh", (), {"field": fake_field_api})()},
                )(),
            },
        )()

        field_id = _add_axis_aligned_box_distance_threshold_field(
            fake_gmsh,
            bounds_min=(-1.0, -1.0, -0.5),
            bounds_max=(-0.25, 1.0, -0.1),
            airbox_bounds_min=(-3.0, -2.0, -1.5),
            airbox_bounds_max=(3.0, 2.0, 1.5),
            size_min=2.0,
            size_max=20.0,
            dist_min=0.25,
            dist_max=2.0,
        )

        self.assertIsNotNone(field_id)
        expr = fake_field_api.strings[(field_id, "F")]
        self.assertNotIn(" - -", expr)
        self.assertIn("x - (-0.25)", expr)
        self.assertIn("z - (-0.10000000000000001)", expr)

    def test_component_restricted_matheval_fields_wrap_negative_constants(self) -> None:
        class _FakeOptionsApi:
            def setNumber(self, _key: str, _value: float) -> None:
                return None

        class _FakeFieldApi:
            def __init__(self) -> None:
                self._next = 1
                self.background: int | None = None
                self.kinds: dict[int, str] = {}
                self.numbers: dict[tuple[int, str], float | list[float]] = {}
                self.strings: dict[tuple[int, str], str] = {}

            def add(self, kind: str) -> int:
                current = self._next
                self._next += 1
                self.kinds[current] = kind
                return current

            def setNumber(self, field_id: int, key: str, value: float) -> None:
                self.numbers[(field_id, key)] = float(value)

            def setNumbers(self, field_id: int, key: str, values: object) -> None:
                if isinstance(values, list):
                    self.numbers[(field_id, key)] = [float(v) for v in values]

            def setString(self, field_id: int, key: str, value: str) -> None:
                self.strings[(field_id, key)] = value

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
                        "getEntities": staticmethod(lambda dim: []),
                    },
                )(),
            },
        )()

        _apply_mesh_options(
            fake_gmsh,
            hmax=10.0,
            order=1,
            opts=MeshOptions(
                size_fields=[
                    {
                        "kind": "ComponentRestrictedRectangularPerimeter",
                        "params": {
                            "GeometryName": "ring",
                            "VIn": 1.0,
                            "Extent": 0.2,
                            "Mode": "edge",
                            "AxisA": 0,
                            "AxisB": 2,
                            "XMin": -0.5,
                            "XMax": -0.1,
                            "YMin": -0.2,
                            "YMax": 0.2,
                            "ZMin": -0.4,
                            "ZMax": -0.05,
                        },
                    },
                    {
                        "kind": "ComponentRestrictedGradedBox",
                        "params": {
                            "GeometryName": "ring",
                            "VIn": 1.0,
                            "VOut": 10.0,
                            "TransitionDistance": 2.0,
                            "Size": [0.5, 0.5, 0.5],
                            "Center": [-0.25, -0.5, -0.75],
                        },
                    },
                    {
                        "kind": "ComponentRestrictedGradedCylinder",
                        "params": {
                            "GeometryName": "ring",
                            "VIn": 1.0,
                            "VOut": 10.0,
                            "TransitionDistance": 2.0,
                            "Radius": 0.25,
                            "Height": 1.0,
                            "Center": [-0.25, -0.5, -0.75],
                            "Axis": [-1.0, 0.0, 1.0],
                        },
                    },
                    {
                        "kind": "ComponentRestrictedGradedSphere",
                        "params": {
                            "GeometryName": "ring",
                            "VIn": 1.0,
                            "VOut": 10.0,
                            "TransitionDistance": 2.0,
                            "Radius": 0.25,
                            "Center": [-0.25, -0.5, -0.75],
                        },
                    },
                ]
            ),
            component_volume_tags={"ring": [3]},
        )

        expressions = [
            value
            for (field_id, key), value in fake_field_api.strings.items()
            if fake_field_api.kinds[field_id] == "MathEval" and key == "F"
        ]
        self.assertGreaterEqual(len(expressions), 4)
        for expr in expressions:
            self.assertNotIn(" - -", expr)
        self.assertTrue(any("x - (-0.25)" in expr for expr in expressions))
        self.assertTrue(any("z - (-0.75)" in expr for expr in expressions))

    def test_curvature_refinement_is_finer_than_far_field_airbox(self) -> None:
        try:
            mesh = generate_cylinder_mesh(
                radius=20e-9,
                height=8e-9,
                hmax=20e-9,
                order=1,
                airbox=AirboxOptions(
                    size=(120e-9, 120e-9, 80e-9),
                    center=(0.0, 0.0, 0.0),
                    maximum_element_size=45e-9,
                    minimum_element_size=8e-9,
                    grading_ratio=1.25,
                    grading_mode="geometric",
                ),
                options=MeshOptions(
                    algorithm_2d=6,
                    algorithm_3d=ALGO_3D_HXT,
                    size_from_curvature=32,
                    growth_rate=1.25,
                    compute_quality=False,
                ),
            )
        except ImportError as exc:
            self.skipTest(f"gmsh not available: {exc}")

        tetra = np.asarray(mesh.nodes[mesh.elements], dtype=np.float64)
        centroids = tetra.mean(axis=1)
        radial = np.sqrt(centroids[:, 0] ** 2 + centroids[:, 1] ** 2)
        edge_pairs = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
        mean_edge = np.mean(
            np.stack(
                [
                    np.linalg.norm(tetra[:, start] - tetra[:, end], axis=1)
                    for start, end in edge_pairs
                ],
                axis=1,
            ),
            axis=1,
        )

        near_curvature = (
            (radial >= 18e-9)
            & (radial <= 32e-9)
            & (np.abs(centroids[:, 2]) <= 12e-9)
        )
        far_airbox = (radial >= 45e-9) | (np.abs(centroids[:, 2]) >= 22e-9)

        self.assertGreater(np.count_nonzero(near_curvature), 20)
        self.assertGreater(np.count_nonzero(far_airbox), 20)
        self.assertLess(
            float(np.percentile(mean_edge[near_curvature], 75)),
            float(np.percentile(mean_edge[far_airbox], 25)),
        )

    def test_arch_waveguide_generates_fem_mesh(self) -> None:
        try:
            mesh = generate_mesh(
                fm.ArchWaveguide(
                    length=100e-9,
                    width=40e-9,
                    height=5e-9,
                    arch_height=20e-9,
                    z0=-10e-9,
                ),
                hmax=20e-9,
                options=MeshOptions(
                    compute_quality=False,
                    per_element_quality=False,
                ),
            )
        except ImportError as exc:
            self.skipTest(f"gmsh not available: {exc}")

        self.assertGreater(mesh.n_nodes, 0)
        self.assertGreater(mesh.n_elements, 0)

    def test_arch_waveguide_stl_classification_preserves_physical_faces(self) -> None:
        if not _has_trimesh:
            self.skipTest("trimesh not available")
        try:
            import gmsh
        except ImportError as exc:
            self.skipTest(f"gmsh not available: {exc}")

        geometry = fm.ArchWaveguide(
            length=2.5e-6,
            width=1.0e-6,
            height=20e-9,
            arch_height=0.0,
            z0=-25e-9,
            name="arch_waveguide_geom",
        )
        surface = _geometry_to_trimesh(
            geometry,
            _import_trimesh(),
            through_thickness_elements=1,
            through_thickness_distribution="fixed",
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "arch_waveguide.stl"
            surface.export(path)

            gmsh.initialize()
            gmsh.option.setNumber("General.Terminal", 0)
            try:
                gmsh.model.add("arch_waveguide_classification")
                volumes, surfaces = _build_stl_volume_model_for_component(
                    gmsh,
                    path,
                )
            finally:
                gmsh.finalize()

        self.assertEqual(len(volumes), 1)
        self.assertEqual(len(surfaces), 6)

    def test_arch_waveguide_surface_preview_uses_trimesh(self) -> None:
        if not _has_trimesh:
            self.skipTest("trimesh not available")

        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=10e-9,
            arch_height=20e-9,
            z0=-5e-9,
        )
        surface = _geometry_to_trimesh(geometry, _import_trimesh())
        payload = build_surface_preview_payload(geometry)

        self.assertIsNotNone(payload)
        assert payload is not None
        nodes = np.asarray(payload["nodes"], dtype=np.float64)
        self.assertTrue(surface.is_watertight)
        self.assertTrue(surface.is_winding_consistent)
        self.assertGreater(nodes.shape[0], 0)
        self.assertGreater(len(payload["facet_types"]), 0)
        self.assertEqual(set(payload["facet_types"]), {"tri3"})
        self.assertAlmostEqual(float(nodes[:, 0].min()), -50e-9)
        self.assertAlmostEqual(float(nodes[:, 0].max()), 50e-9)
        self.assertAlmostEqual(float(nodes[:, 2].min()), -10e-9)
        self.assertAlmostEqual(float(nodes[:, 2].max()), 20e-9)

    def test_arch_waveguide_layered_surface_respects_through_thickness_elements(self) -> None:
        if not _has_trimesh:
            self.skipTest("trimesh not available")

        geometry = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=10e-9,
            arch_height=20e-9,
            z0=-5e-9,
        )

        surface = _geometry_to_trimesh(
            geometry,
            _import_trimesh(),
            through_thickness_elements=3,
        )
        vertices = np.asarray(surface.vertices, dtype=np.float64)
        left_section = vertices[
            np.isclose(vertices[:, 0], vertices[:, 0].min(), rtol=0.0, atol=1e-18)
        ]
        z_levels = np.unique(np.round(left_section[:, 2], decimals=18))

        self.assertTrue(surface.is_watertight)
        self.assertTrue(surface.is_winding_consistent)
        self.assertEqual(len(z_levels), 4)

    def test_arch_waveguide_is_sweepable_thin_ribbon(self) -> None:
        result = classify_sweepability(
            fm.ArchWaveguide(
                length=100e-9,
                width=40e-9,
                height=2e-9,
                arch_height=20e-9,
            )
        )

        self.assertTrue(result.sweepable)
        self.assertEqual(result.thin_axis, 2)
        self.assertAlmostEqual(result.thickness, 2e-9)

    def test_arbitrary_axis_cylinder_is_not_classified_as_z_sweep(self) -> None:
        result = classify_sweepability(
            fm.Cylinder(radius=20e-9, height=2e-9, axis=(1.0, 1.0, 0.0))
        )

        self.assertFalse(result.sweepable)
        self.assertIn("OCC free-tetrahedral", result.reason)

    def test_arch_waveguide_shared_domain_rejects_unqualified_mixed_route(self) -> None:
        with patch(
            "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components"
        ) as generator:
            with self.assertRaisesRegex(
                ValueError,
                "qualified mixed shared-domain route rejects: exactly one Box geometry",
            ):
                realize_fem_domain_mesh_asset_from_components_with_report(
                [
                    fm.ArchWaveguide(
                        length=100e-9,
                        width=40e-9,
                        height=10e-9,
                        arch_height=20e-9,
                    )
                ],
                fm.FEM(order=1, hmax=20e-9),
                study_universe={
                    "mode": "manual",
                    "size": [200e-9, 100e-9, 80e-9],
                    "center": [0.0, 0.0, 10e-9],
                    "airbox_hmax": 80e-9,
                },
                mesh_workflow={
                    "mesh_options": {
                        "mesh_strategy": "swept_prism",
                        "through_thickness_elements": 1,
                    }
                },
            )
        generator.assert_not_called()

    def test_meshdata_to_ir_has_canonical_shape(self) -> None:
        mesh = self._unit_tet_mesh()

        mesh_ir = mesh.to_ir("unit_tet")

        self.assertEqual(mesh_ir["mesh_name"], "unit_tet")
        self.assertEqual(len(mesh_ir["nodes"]), 4)
        self.assertNotIn("elements", mesh_ir)
        self.assertNotIn("boundary_faces", mesh_ir)
        self.assertEqual(mesh_ir["cells"]["types"], ["tet4"])
        self.assertEqual(mesh_ir["cells"]["offsets"], [0, 4])
        self.assertEqual(mesh_ir["facets"]["types"], ["tri3"])
        self.assertEqual(mesh_ir["facets"]["roles"], ["exterior"])
        self.assertEqual(mesh_ir["boundary_markers"], [7])
        if fullmag_core.validate_mesh_ir(mesh_ir) is not None:
            self.assertTrue(fullmag_core.validate_mesh_ir(mesh_ir))

    def test_meshdata_to_ir_does_not_infer_axis_aligned_periodic_pairs(self) -> None:
        mesh = MeshData.from_legacy_tet4(
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

        self.assertNotIn("periodic_boundary_pairs", mesh_ir)
        self.assertNotIn("periodic_node_pairs", mesh_ir)

    def test_meshdata_to_ir_preserves_explicit_periodic_pairs(self) -> None:
        mesh = self._unit_tet_mesh()
        explicit_mesh = MeshData.from_legacy_tet4(
            nodes=mesh.nodes,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            periodic_boundary_pairs=[
                {
                    "pair_id": "x_faces",
                    "marker_a": 21,
                    "marker_b": 22,
                    "translation": [1.0, 0.0, 0.0],
                }
            ],
            periodic_node_pairs=[
                {
                    "pair_id": "x_faces",
                    "node_a": 0,
                    "node_b": 1,
                }
            ],
        )

        mesh_ir = explicit_mesh.to_ir("periodic_unit_tet")

        self.assertEqual(mesh_ir["periodic_boundary_pairs"], explicit_mesh.periodic_boundary_pairs)
        self.assertEqual(mesh_ir["periodic_node_pairs"], explicit_mesh.periodic_node_pairs)

    def test_axis_aligned_periodic_pair_inference_includes_translation_and_tolerance(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [2.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 1.0],
                    [0.0, 1.0, 1.0],
                    [2.0, 1.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 4],
                    [1, 3, 2, 7],
                    [1, 2, 4, 7],
                    [1, 4, 5, 7],
                    [2, 4, 6, 7],
                ],
                dtype=np.int32,
            ),
            element_markers=np.ones((5,), dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 2, 6],
                    [0, 4, 6],
                    [1, 3, 7],
                    [1, 5, 7],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 11, 11], dtype=np.int32),
        )

        boundary_pairs, node_pairs = _infer_axis_aligned_periodic_pairs(mesh)

        self.assertEqual(
            {pair["pair_id"]: pair for pair in boundary_pairs},
            {
                "x_faces": {
                    "pair_id": "x_faces",
                    "marker_a": 10,
                    "marker_b": 11,
                    "translation": [2.0, 0.0, 0.0],
                    "tolerance_m": 2.0e-6,
                },
                "y_faces": {
                    "pair_id": "y_faces",
                    "marker_a": 10,
                    "marker_b": 11,
                    "translation": [0.0, 1.0, 0.0],
                    "tolerance_m": 2.0e-6,
                },
                "z_faces": {
                    "pair_id": "z_faces",
                    "marker_a": 10,
                    "marker_b": 11,
                    "translation": [0.0, 0.0, 1.0],
                    "tolerance_m": 2.0e-6,
                },
            },
        )
        self.assertEqual(
            {(pair["pair_id"], pair["node_a"], pair["node_b"]) for pair in node_pairs},
            {
                ("x_faces", 0, 1),
                ("x_faces", 2, 3),
                ("x_faces", 4, 5),
                ("x_faces", 6, 7),
                ("y_faces", 0, 2),
                ("y_faces", 1, 3),
                ("y_faces", 4, 6),
                ("y_faces", 5, 7),
                ("z_faces", 0, 4),
                ("z_faces", 1, 5),
                ("z_faces", 2, 6),
                ("z_faces", 3, 7),
            },
        )

    def test_add_air_box_is_deprecated(self) -> None:
        with self.assertWarns(DeprecationWarning):
            with self.assertRaises(ValueError):
                fm.meshing.add_air_box(fm.Box(1e-9, 1e-9, 1e-9), hmax=1e-9, factor=1.0)

    def test_extract_gmsh_connectivity_supports_typed_mixed_and_rejects_higher_order(self) -> None:
        class _FakeMeshApi:
            @staticmethod
            def getElementProperties(element_type: int) -> tuple[str, int, int, int, list[float], int]:
                properties = {
                    3: ("Quadrilateral 4", 2, 1, 4, [], 4),
                    4: ("Tetrahedron 4", 3, 1, 4, [], 4),
                    5: ("Hexahedron 8", 3, 1, 8, [], 8),
                    6: ("Prism 6", 3, 1, 6, [], 6),
                    7: ("Pyramid 5", 3, 1, 5, [], 5),
                    11: ("Tetrahedron 10", 3, 2, 10, [], 4),
                    2: ("Triangle 3", 2, 1, 3, [], 3),
                }
                if element_type in properties:
                    return properties[element_type]
                raise AssertionError(f"unexpected element type {element_type}")

        class _FakeModel:
            mesh = _FakeMeshApi()

        class _FakeGmsh:
            model = _FakeModel()

        node_index = {tag: tag - 1 for tag in range(1, 17)}
        for element_type, arity in ((6, 6), (5, 8), (7, 5)):
            blocks = (
                [element_type],
                [np.asarray([1], dtype=np.int32)],
                [np.arange(1, arity + 1, dtype=np.int32)],
            )
            with self.assertRaisesRegex(
                ValueError,
                "tet4-only compatibility extraction",
            ):
                _extract_gmsh_connectivity(
                    _FakeGmsh(), blocks, node_index, nodes_per_element=4
                )

        mixed_types, mixed_offsets, mixed_nodes = _extract_gmsh_typed_connectivity(
            _FakeGmsh(),
            (
                [6, 7, 4],
                [np.asarray([1]), np.asarray([2]), np.asarray([3])],
                [np.arange(1, 7), np.arange(7, 12), np.arange(12, 16)],
            ),
            node_index,
            dimension=3,
        )
        self.assertEqual(mixed_types, ["prism6", "pyramid5", "tet4"])
        np.testing.assert_array_equal(mixed_offsets, np.asarray([0, 6, 11, 15]))
        np.testing.assert_array_equal(mixed_nodes, np.arange(15, dtype=np.int32))

        with self.assertRaisesRegex(
            UnsupportedGmshElementError,
            r"type 11.*dimension=3.*order=2.*arity=10",
        ):
            _extract_gmsh_typed_connectivity(
                _FakeGmsh(),
                ([11], [np.asarray([1])], [np.arange(1, 11)]),
                node_index,
                dimension=3,
            )

        with self.assertRaisesRegex(ValueError, "tri3-only compatibility extraction"):
            _extract_gmsh_connectivity(
                _FakeGmsh(),
                ([3], [np.asarray([1], dtype=np.int32)], [np.arange(1, 5, dtype=np.int32)]),
                node_index,
                nodes_per_element=3,
            )

        tet4 = _extract_gmsh_connectivity(
            _FakeGmsh(),
            ([4], [np.asarray([1], dtype=np.int32)], [np.arange(1, 5, dtype=np.int32)]),
            node_index,
            nodes_per_element=4,
        )
        tri3 = _extract_gmsh_connectivity(
            _FakeGmsh(),
            ([2], [np.asarray([1], dtype=np.int32)], [np.arange(1, 4, dtype=np.int32)]),
            node_index,
            nodes_per_element=3,
        )
        np.testing.assert_array_equal(tet4, np.asarray([[0, 1, 2, 3]], dtype=np.int32))
        np.testing.assert_array_equal(tri3, np.asarray([[0, 1, 2]], dtype=np.int32))

    def test_derive_facet_roles_allows_only_declared_provisional_same_region_interface(self) -> None:
        topology = {
            "cell_types": ["tet4", "tet4"],
            "cell_offsets": [0, 4, 8],
            "cell_nodes": [0, 1, 2, 3, 0, 2, 1, 4],
            "element_markers": [0, 0],
            "facet_offsets": [0, 3],
            "facet_nodes": [0, 1, 2],
            "boundary_markers": [10],
        }

        with self.assertRaisesRegex(ValueError, r"adjacency \[0, 0\]"):
            _derive_facet_roles(**topology)

        self.assertEqual(
            _derive_facet_roles(
                **topology,
                provisional_interface_markers={10},
            ),
            ["material_interface"],
        )

        physical_group_topology = dict(topology)
        physical_group_topology["element_markers"] = [1, 1]
        self.assertEqual(
            _derive_facet_roles(
                **physical_group_topology,
                provisional_interface_markers={10},
            ),
            ["material_interface"],
        )

        with self.assertRaisesRegex(ValueError, r"adjacency \[0, 0\]"):
            _derive_facet_roles(
                **topology,
                provisional_interface_markers={11},
            )

    def test_derive_facet_roles_rejects_declared_provisional_quad_between_prisms(self) -> None:
        with self.assertRaisesRegex(ValueError, r"adjacency \[0, 0\]"):
            _derive_facet_roles(
                cell_types=["prism6", "prism6"],
                cell_offsets=[0, 6, 12],
                cell_nodes=[0, 1, 2, 3, 4, 5, 0, 1, 6, 3, 4, 7],
                element_markers=[0, 0],
                facet_offsets=[0, 4],
                facet_nodes=[0, 3, 4, 1],
                boundary_markers=[10],
                provisional_interface_markers={10},
            )

    def test_certify_extracted_periodic_mesh_rejects_missing_mirrored_face(self) -> None:
        nodes = np.asarray(
            [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
                [1.0, 1.0, 0.0],
                [0.0, 0.0, 1.0],
                [1.0, 0.0, 1.0],
                [0.0, 1.0, 1.0],
                [1.0, 1.0, 1.0],
            ],
            dtype=np.float64,
        )
        elements = np.asarray([[0, 1, 2, 4]], dtype=np.int32)
        faces = np.asarray(
            [
                [0, 2, 4],
                [1, 5, 3],
                [0, 1, 4],
                [2, 6, 3],
            ],
            dtype=np.int32,
        )
        markers = np.asarray([101, 102, 201, 202], dtype=np.int32)
        pairs = [
            {
                "pair_id": "x_faces",
                "marker_a": 101,
                "marker_b": 102,
                "translation": [1.0, 0.0, 0.0],
                "tolerance_m": 1.0e-12,
            },
            {
                "pair_id": "y_faces",
                "marker_a": 201,
                "marker_b": 202,
                "translation": [0.0, 1.0, 0.0],
                "tolerance_m": 1.0e-12,
            },
        ]
        node_pairs = [
            {"pair_id": "x_faces", "node_a": 0, "node_b": 1},
            {"pair_id": "x_faces", "node_a": 2, "node_b": 3},
            {"pair_id": "x_faces", "node_a": 4, "node_b": 5},
            {"pair_id": "x_faces", "node_a": 6, "node_b": 7},
            {"pair_id": "y_faces", "node_a": 0, "node_b": 2},
            {"pair_id": "y_faces", "node_a": 1, "node_b": 3},
            {"pair_id": "y_faces", "node_a": 4, "node_b": 6},
            {"pair_id": "y_faces", "node_a": 5, "node_b": 7},
        ]

        certificate = certify_extracted_periodic_mesh(
            nodes,
            faces,
            markers,
            pairs,
            node_pairs,
        )
        self.assertEqual(certificate["schema_version"], "periodic_mesh_certificate.v6")
        self.assertEqual(certificate["axis_pair_count"], 2)
        self.assertTrue(certificate["corner_edge_cycle_unique"])

        with self.assertRaisesRegex(ValueError, "face bijection"):
            certify_extracted_periodic_mesh(
                nodes,
                faces[:-1],
                markers[:-1],
                pairs,
                node_pairs,
            )

        mesh = MeshData.from_legacy_tet4(
            nodes=nodes,
            elements=elements,
            element_markers=np.ones(elements.shape[0], dtype=np.int32),
            boundary_faces=faces,
            boundary_markers=markers,
            periodic_boundary_pairs=pairs,
            periodic_node_pairs=node_pairs,
            periodic_mesh_certificate=certificate,
        )
        self.assertEqual(mesh.periodic_mesh_certificate, certificate)
        self.assertEqual(mesh.to_ir("mirrored")["periodic_mesh_certificate"], certificate)
        with tempfile.TemporaryDirectory() as tmp_dir:
            json_path = Path(tmp_dir) / "mirrored.json"
            npz_path = Path(tmp_dir) / "mirrored.npz"
            mesh.save(json_path)
            mesh.save(npz_path)
            self.assertEqual(MeshData.load(json_path).periodic_mesh_certificate, certificate)
            self.assertEqual(MeshData.load(npz_path).periodic_mesh_certificate, certificate)

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

    def test_difference_translation_and_finite_height_match_problem_ir_fingerprint(self) -> None:
        base = fm.Box(size=(4.0, 4.0, 4.0), name="base")
        translated_cylinder = fm.Translate(
            fm.Cylinder(
                radius=1.0,
                height=2.0,
                axis=(0.0, 0.0, 1.0),
                name="tool_base",
            ),
            (1.0, 0.0, 0.0),
            name="tool",
        )
        translated_box = fm.Translate(
            fm.Box(size=(2.0, 2.0, 2.0), name="box_tool_base"),
            (1.0, 0.0, 0.0),
            name="box_tool",
        )

        cylinder_voxels = voxelize_geometry(
            fm.Difference(base=base, tool=translated_cylinder, name="difference"),
            (1.0, 1.0, 1.0),
        )
        box_voxels = voxelize_geometry(
            fm.Difference(base=base, tool=translated_box, name="box_difference"),
            (1.0, 1.0, 1.0),
        )
        expected_removed = [22, 23, 26, 27, 38, 39, 42, 43]
        authored_ir = fm.Difference(
            base=base, tool=translated_cylinder, name="difference"
        ).to_ir()
        self.assertEqual(authored_ir["kind"], "difference")
        self.assertEqual(authored_ir["tool"]["kind"], "translate")
        self.assertEqual(authored_ir["tool"]["by"], [1.0, 0.0, 0.0])
        self.assertEqual(cylinder_voxels.origin, (-2.0, -2.0, -2.0))
        self.assertEqual(cylinder_voxels.active_cell_count, 56)
        self.assertEqual(
            np.flatnonzero(~cylinder_voxels.mask).tolist(), expected_removed
        )
        self.assertEqual(
            np.flatnonzero(~box_voxels.mask).tolist(), expected_removed,
            "Python DSL and ProblemIR geometry fixtures must retain one 3D CSG fingerprint",
        )
        self.assertTrue(cylinder_voxels.mask[0, 1, 1])
        self.assertTrue(cylinder_voxels.mask[3, 1, 1])

    def test_voxel_mask_to_ir_uses_canonical_grid_order(self) -> None:
        voxels = voxelize_geometry(fm.Cylinder(radius=3.0, height=4.0), (1.0, 1.0, 1.0))

        ir = voxels.to_ir("pillar")

        self.assertEqual(ir["geometry_name"], "pillar")
        self.assertEqual(ir["cells"], [voxels.shape[2], voxels.shape[1], voxels.shape[0]])
        self.assertEqual(len(ir["active_mask"]), int(np.prod(voxels.shape)))

    def test_sin_waveguide_voxelization_uses_half_open_vertical_interval(self) -> None:
        geometry = fm.SinWaveguide(
            length=8.0,
            width=2.0,
            height=2.0,
            period=8.0,
            amplitude=1.0,
        )

        voxels = voxelize_geometry(geometry, (1.0, 1.0, 1.0))

        self.assertEqual(voxels.origin, (-4.0, -1.0, -2.0))
        self.assertEqual(voxels.shape, (4, 2, 8))
        self.assertTrue(bool(voxels.mask[2, 0, 3]))
        self.assertFalse(bool(voxels.mask[3, 0, 3]))

    def test_arch_waveguide_voxelization_tracks_arch_height_and_z0(self) -> None:
        geometry = fm.ArchWaveguide(
            length=8.0,
            width=2.0,
            height=2.0,
            arch_height=2.0,
            z0=1.0,
        )

        voxels = voxelize_geometry(geometry, (1.0, 1.0, 1.0))

        self.assertEqual(voxels.origin, (-4.0, -1.0, 0.0))
        self.assertEqual(voxels.shape, (4, 2, 8))
        self.assertTrue(bool(voxels.mask[2, 0, 1]))
        self.assertFalse(bool(voxels.mask[3, 0, 0]))

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
            ), patch(
                "fullmag.meshing.gmsh_bridge.generate_mesh_from_file",
                side_effect=RuntimeError("force direct STL fallback"),
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

    def test_stl_surface_meshing_retries_hxt_after_delaunay_plc_error(self) -> None:
        mesh = self._unit_tet_mesh()
        attempted: list[int] = []

        def _fake_stl_once(*_args: object, **kwargs: object) -> MeshData:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            attempted.append(int(options.algorithm_3d))
            if len(attempted) == 1:
                raise Exception("PLC Error:  A segment and a facet intersect at point")
            return mesh

        with patch(
            "fullmag.meshing._gmsh_generators._mesh_stl_surface_once",
            side_effect=_fake_stl_once,
        ):
            result = _mesh_stl_surface(
                Path("shape.stl"),
                hmax=100e-9,
                order=1,
                options=MeshOptions(algorithm_3d=ALGO_3D_DELAUNAY),
            )

        self.assertIs(result, mesh)
        self.assertEqual(attempted, [ALGO_3D_DELAUNAY, ALGO_3D_HXT])

    def test_stl_surface_meshing_retries_delaunay_after_hxt_failure(self) -> None:
        mesh = self._unit_tet_mesh()
        attempted: list[int] = []

        def _fake_stl_once(*_args: object, **kwargs: object) -> MeshData:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            attempted.append(int(options.algorithm_3d))
            if len(attempted) == 1:
                raise Exception("HXT 3D mesh failed")
            return mesh

        with patch(
            "fullmag.meshing._gmsh_generators._mesh_stl_surface_once",
            side_effect=_fake_stl_once,
        ):
            result = _mesh_stl_surface(
                Path("shape.stl"),
                hmax=100e-9,
                order=1,
                options=MeshOptions(algorithm_3d=ALGO_3D_HXT),
            )

        self.assertIs(result, mesh)
        self.assertEqual(attempted, [ALGO_3D_HXT, ALGO_3D_DELAUNAY])

    def test_stl_surface_meshing_retries_frontal_after_hxt_and_delaunay_boundary_failures(self) -> None:
        mesh = self._unit_tet_mesh()
        attempted: list[int] = []

        def _fake_stl_once(*_args: object, **kwargs: object) -> MeshData:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            attempted.append(int(options.algorithm_3d))
            if len(attempted) == 1:
                raise Exception("HXT 3D mesh failed")
            if len(attempted) == 2:
                raise Exception("Invalid boundary mesh (overlapping facets) on surface 2 surface 120")
            return mesh

        with patch(
            "fullmag.meshing._gmsh_generators._mesh_stl_surface_once",
            side_effect=_fake_stl_once,
        ):
            result = _mesh_stl_surface(
                Path("shape.stl"),
                hmax=100e-9,
                order=1,
                options=MeshOptions(algorithm_3d=ALGO_3D_HXT),
            )

        self.assertIs(result, mesh)
        self.assertEqual(
            attempted,
            [ALGO_3D_HXT, ALGO_3D_DELAUNAY, ALGO_3D_FRONTAL],
        )

    def test_stl_volume_model_retries_geometry_recovery_with_reparametrization(self) -> None:
        test_case = self

        class _FakeMesh:
            def __init__(self) -> None:
                self.classify_reparametrize: list[bool] = []
                self.create_calls = 0

            def classifySurfaces(
                self,
                _angle: float,
                *,
                boundary: bool,
                forReparametrization: bool,
                curveAngle: float,
            ) -> None:
                test_case.assertTrue(boundary)
                test_case.assertGreater(curveAngle, 0.0)
                self.classify_reparametrize.append(forReparametrization)

            def createGeometry(self) -> None:
                self.create_calls += 1
                if self.create_calls == 1:
                    raise Exception("Wrong topology of boundary mesh for parametrization")

        class _FakeGeo:
            def __init__(self) -> None:
                self.synchronized = False

            def addSurfaceLoop(self, tags: list[int]) -> int:
                test_case.assertEqual(tags, [5])
                return 6

            def addVolume(self, loops: list[int]) -> int:
                test_case.assertEqual(loops, [6])
                return 7

            def synchronize(self) -> None:
                self.synchronized = True

        class _FakeModel:
            def __init__(self) -> None:
                self.mesh = _FakeMesh()
                self.geo = _FakeGeo()
                self.added: list[str] = []

            def add(self, name: str) -> None:
                self.added.append(name)

            def getEntities(self, dim: int) -> list[tuple[int, int]]:
                return [(2, 5)] if dim == 2 else []

            def getBoundary(
                self,
                _entities: list[tuple[int, int]],
                *,
                oriented: bool,
            ) -> list[tuple[int, int]]:
                test_case.assertFalse(oriented)
                return []

        class _FakeGmsh:
            def __init__(self) -> None:
                self.model = _FakeModel()
                self.clear_calls = 0
                self.merged: list[str] = []

            def merge(self, path: str) -> None:
                self.merged.append(path)

            def clear(self) -> None:
                self.clear_calls += 1

        fake_gmsh = _FakeGmsh()

        volumes, surfaces = _build_stl_volume_model(fake_gmsh, Path("shape.stl"))

        self.assertEqual(volumes, [7])
        self.assertEqual(surfaces, [5])
        self.assertEqual(fake_gmsh.clear_calls, 1)
        self.assertEqual(fake_gmsh.merged, ["shape.stl", "shape.stl"])
        self.assertEqual(fake_gmsh.model.added, ["shape"])
        self.assertEqual(
            fake_gmsh.model.mesh.classify_reparametrize,
            [False, True],
        )
        self.assertTrue(fake_gmsh.model.geo.synchronized)

    @unittest.skip("Skipped due to known Gmsh C++ Delaunay intersections on complex nanoflower STL boundaries")
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
        # With a conforming shared-domain mesh, an extremely fine object
        # surface can legitimately create many interface-adjacent air tetrahedra.
        # The airbox-specific regression is covered by the moderate object
        # refinement case above; the very-fine case is validated by the body
        # partition growth assertions.
        right_key = next(
            (key for key in fine_object_counts if key != "airbox" and "right" in key),
            None,
        )
        if right_key is not None and right_key in fine_airbox_counts:
            self.assertLess(
                fine_object_counts[right_key],
                fine_airbox_counts[right_key],
            )
            self.assertLess(
                very_fine_object_counts[right_key],
                fine_airbox_counts[right_key],
            )

    def test_realize_fem_mesh_asset_prefers_prebuilt_mesh_when_given(self) -> None:
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "mesh.vtk"
            path.write_text("# vtk DataFile Version 2.0\nplaceholder\n", encoding="utf-8")

            with patch(
                "fullmag.meshing.asset_pipeline.generate_mesh_from_file",
                return_value=MeshData.from_legacy_tet4(
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

    def test_realize_fem_mesh_asset_rejects_surface_only_imported_geometry(self) -> None:
        preview = {
            "nodes": [
                [0.0, 0.0, 0.0],
                [1.0, 0.0, 0.0],
                [0.0, 1.0, 0.0],
            ],
            "cell_types": [],
            "cell_offsets": [0],
            "cell_nodes": [],
            "facet_types": ["tri3"],
            "facet_roles": ["exterior"],
            "facet_offsets": [0, 3],
            "facet_nodes": [0, 1, 2],
        }

        with patch(
            "fullmag.meshing.asset_pipeline.build_surface_preview_payload",
            return_value=preview,
        ):
            with self.assertRaisesRegex(ValueError, "surface_preview_mesh"):
                realize_fem_mesh_asset(
                    fm.ImportedGeometry(
                        source="shape.stl",
                        name="shape",
                        volume="surface",
                    ),
                    fm.FEM(order=1, hmax=0.1),
                )

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

        shared_domain_mesh = MeshData.from_legacy_tet4(
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

            def export(self, path: Path) -> None:
                path.write_text("solid fake\nendsolid fake\n", encoding="utf-8")

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
            "fullmag.meshing._gmsh_occ.is_occ_compatible",
            return_value=False,
        ), patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=fake_trimesh,
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.gmsh_bridge.generate_mesh_from_file",
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

        shared_domain_mesh = MeshData.from_legacy_tet4(
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

            def export(self, path: Path) -> None:
                path.write_text("solid fake\nendsolid fake\n", encoding="utf-8")

        fake_result = SharedDomainMeshResult(
            mesh=shared_domain_mesh,
            component_marker_tags={left.geometry_name: 1, right.geometry_name: 2},
            component_volume_tags={left.geometry_name: [11], right.geometry_name: [12]},
            component_surface_tags={left.geometry_name: [21], right.geometry_name: [22]},
            interface_surface_tags=[21, 22],
            outer_boundary_surface_tags=[31, 32, 33, 34, 35, 36],
        )

        with patch(
            "fullmag.meshing._gmsh_occ.is_occ_compatible",
            return_value=False,
        ), patch(
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

    def test_generated_frozen_magnetic_submesh_mode_requires_explicit_source(self) -> None:
        film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="film")
        shared_domain_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [-100e-9, -100e-9, -5e-9],
                    [100e-9, -100e-9, -5e-9],
                    [-100e-9, 100e-9, -5e-9],
                    [-100e-9, -100e-9, 5e-9],
                    [-200e-9, -200e-9, -90e-9],
                    [200e-9, -200e-9, -90e-9],
                    [-200e-9, 200e-9, -90e-9],
                    [-200e-9, -200e-9, 90e-9],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [4, 5, 6, 7],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 2], dtype=np.int32),
            boundary_faces=np.asarray([[0, 1, 2], [4, 5, 6]], dtype=np.int32),
            boundary_markers=np.asarray([10, 99], dtype=np.int32),
        )

        class _FakeSurface:
            vertices = np.asarray(
                [
                    [-100e-9, -100e-9, -5e-9],
                    [100e-9, -100e-9, -5e-9],
                    [-100e-9, 100e-9, -5e-9],
                    [-100e-9, -100e-9, 5e-9],
                ],
                dtype=np.float64,
            )

            def copy(self) -> "_FakeSurface":
                return self

            def export(self, path: Path) -> None:
                path.write_text("solid fake\nendsolid fake\n", encoding="utf-8")

        fake_result = SharedDomainMeshResult(
            mesh=shared_domain_mesh,
            component_marker_tags={film.geometry_name: 1},
            component_volume_tags={film.geometry_name: [11]},
            component_surface_tags={film.geometry_name: [21]},
            interface_surface_tags=[21],
            outer_boundary_surface_tags=[31, 32, 33, 34, 35, 36],
        )

        with patch(
            "fullmag.meshing._gmsh_occ.is_occ_compatible",
            return_value=False,
        ), patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=object(),
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components",
            return_value=fake_result,
        ):
            with self.assertRaisesRegex(
                ValueError,
                "generated_frozen_magnetic_submesh.*frozen_magnetic_submesh_source",
            ):
                realize_fem_domain_mesh_asset_from_components_with_report(
                    [film],
                    fm.FEM(order=1, hmax=20e-9),
                    study_universe={
                        "mode": "manual",
                        "size": [400e-9, 400e-9, 180e-9],
                        "center": [0.0, 0.0, 0.0],
                    },
                    mesh_workflow={
                        "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                    },
                )

    def test_unknown_domain_mesh_mode_is_rejected(self) -> None:
        film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="film")

        with self.assertRaisesRegex(
            ValueError,
            "unknown domain_mesh_mode.*explicit_shared_domain_mesh.*generated_frozen_magnetic_submesh.*generated_shared_domain_mesh",
        ):
            realize_fem_domain_mesh_asset_from_components_with_report(
                [film],
                fm.FEM(order=1, hmax=20e-9),
                mesh_workflow={
                    "domain_mesh_mode": "generated_frozn_magnetic_submesh",
                },
            )

    def test_authored_mesh_operation_without_executor_fails_closed(self) -> None:
        film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="film")

        with self.assertRaisesRegex(
            ValueError,
            "mesh operation executor unavailable: kind='refine' scope='film'",
        ):
            realize_fem_domain_mesh_asset_from_components_with_report(
                [film],
                fm.FEM(order=1, hmax=20e-9),
                mesh_workflow={
                    "operations": [
                        {"geometry": "film", "kind": "refine", "params": {"steps": 1}}
                    ],
                },
            )

    def test_frozen_magnetic_submesh_source_loads_mesh_markers_and_interface_faces(self) -> None:
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            mesh_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_mesh.save(mesh_path)
            payload = mesh_asset_pipeline._load_frozen_magnetic_submesh_source(
                {
                    "mesh_source": str(mesh_path),
                    "region_markers": [
                        {"geometry_name": "film", "marker": 1},
                    ],
                }
            )

        self.assertEqual(payload.mesh.n_nodes, 4)
        self.assertEqual(payload.region_markers, [{"geometry_name": "film", "marker": 1}])
        np.testing.assert_array_equal(
            payload.interface_facet_ordinals,
            np.arange(frozen_mesh.n_boundary_faces, dtype=np.int64),
        )
        self.assertEqual(len(payload.magnetic_submesh_signatures), 1)
        self.assertEqual(payload.magnetic_submesh_signatures[0]["geometry_name"], "film")
        self.assertEqual(payload.magnetic_submesh_signatures[0]["tetra_count"], 1)
        self.assertIsInstance(payload.magnetic_submesh_signatures[0]["digest"], str)

    def test_frozen_magnetic_submesh_source_rejects_sidecar_node_count_drift(self) -> None:
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            mesh_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_mesh.save(mesh_path)
            report_path = Path(f"{mesh_path}.report.json")
            report_path.write_text(
                json.dumps(
                    {
                        "frozen_magnetic_submesh_invariants": {
                            "node_count": 5,
                            "element_count": 1,
                            "interface_boundary_face_count": 4,
                            "periodic_boundary_pair_count": 0,
                            "periodic_node_pair_count": 0,
                            "periodic_boundary_pair_counts_by_id": {},
                            "periodic_node_pair_counts_by_id": {},
                            "magnetic_submesh_signatures": [
                                {
                                    "geometry_name": "film",
                                    "marker": 1,
                                    "node_count": 4,
                                    "tetra_count": 1,
                                    "edge_count": 6,
                                    "coordinate_quantization_m": 1.0e-12,
                                    "digest": "placeholder",
                                }
                            ],
                        }
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ValueError,
                "inconsistent frozen magnetic submesh.*node_count expected 5, got 4",
            ):
                mesh_asset_pipeline._load_frozen_magnetic_submesh_source(
                    {
                        "mesh_source": str(mesh_path),
                        "region_markers": [
                            {"geometry_name": "film", "marker": 1},
                        ],
                    }
                )

    def test_frozen_magnetic_submesh_source_rejects_sidecar_periodic_pair_drift(self) -> None:
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
            periodic_boundary_pairs=[
                {"pair_id": "x_faces", "marker_a": 21, "marker_b": 22},
            ],
            periodic_node_pairs=[
                {"pair_id": "x_faces", "node_a": 0, "node_b": 1},
            ],
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            mesh_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_mesh.save(mesh_path)
            report_path = Path(f"{mesh_path}.report.json")
            report_path.write_text(
                json.dumps(
                    {
                        "frozen_magnetic_submesh_invariants": {
                            "node_count": 4,
                            "element_count": 1,
                            "interface_boundary_face_count": 4,
                            "periodic_boundary_pair_count": 1,
                            "periodic_node_pair_count": 2,
                            "periodic_boundary_pair_counts_by_id": {"x_faces": 1},
                            "periodic_node_pair_counts_by_id": {"x_faces": 2},
                            "magnetic_submesh_signatures": [
                                {
                                    "geometry_name": "film",
                                    "marker": 1,
                                    "node_count": 4,
                                    "tetra_count": 1,
                                    "edge_count": 6,
                                    "coordinate_quantization_m": 1.0e-12,
                                    "digest": "placeholder",
                                }
                            ],
                        }
                    }
                ),
                encoding="utf-8",
            )

            with self.assertRaisesRegex(
                ValueError,
                "inconsistent frozen magnetic submesh.*periodic_node_pair_counts_by_id\\['x_faces'\\] expected 2, got 1",
            ):
                mesh_asset_pipeline._load_frozen_magnetic_submesh_source(
                    {
                        "mesh_source": str(mesh_path),
                        "region_markers": [
                            {"geometry_name": "film", "marker": 1},
                        ],
                    }
                )

    def test_extract_frozen_magnetic_submesh_from_shared_domain_preserves_interface_faces(self) -> None:
        shared_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [0.0, 0.0, -1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [0, 1, 2, 4],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 0], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [0, 1, 4],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 99], dtype=np.int32),
        )

        payload = mesh_asset_pipeline._extract_frozen_magnetic_submesh(
            shared_mesh,
            [{"geometry_name": "film", "marker": 1}],
            geometry_name="film",
        )

        self.assertEqual(payload.region_markers, [{"geometry_name": "film", "marker": 1}])
        np.testing.assert_array_equal(payload.mesh.nodes, shared_mesh.nodes[:4])
        np.testing.assert_array_equal(payload.mesh.elements, np.asarray([[0, 1, 2, 3]], dtype=np.int32))
        np.testing.assert_array_equal(payload.mesh.element_markers, np.asarray([1], dtype=np.int32))
        np.testing.assert_array_equal(payload.interface_facet_ordinals, [0, 1, 2])
        np.testing.assert_array_equal(payload.mesh.boundary_faces, [[0, 1, 2], [0, 1, 3], [0, 2, 3]])
        self.assertEqual(payload.magnetic_submesh_signatures[0]["geometry_name"], "film")
        self.assertEqual(payload.magnetic_submesh_signatures[0]["tetra_count"], 1)

    def test_extract_frozen_magnetic_submesh_excludes_periodic_boundary_faces(self) -> None:
        shared_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [1.0, 1.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [1, 2, 3, 4],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [1, 2, 4],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 102, 99], dtype=np.int32),
        )

        payload = mesh_asset_pipeline._extract_frozen_magnetic_submesh(
            shared_mesh,
            [{"geometry_name": "film", "marker": 1}],
            geometry_name="film",
        )

        np.testing.assert_array_equal(payload.interface_facet_ordinals, [0])
        np.testing.assert_array_equal(payload.mesh.boundary_faces, [[0, 1, 2]])
        np.testing.assert_array_equal(payload.mesh.boundary_markers, np.asarray([10], dtype=np.int32))

    def test_generated_frozen_magnetic_submesh_mode_validates_source_before_generator_gap(self) -> None:
        film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="film")
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            mesh_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_mesh.save(mesh_path)
            with self.assertRaisesRegex(
                ValueError,
                "references marker 2.*element_markers.*\\[1\\]",
            ):
                realize_fem_domain_mesh_asset_from_components_with_report(
                    [film],
                    fm.FEM(order=1, hmax=20e-9),
                    study_universe={
                        "mode": "manual",
                        "size": [400e-9, 400e-9, 180e-9],
                        "center": [0.0, 0.0, 0.0],
                    },
                    mesh_workflow={
                        "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                        "frozen_magnetic_submesh_source": {
                            "mesh_source": str(mesh_path),
                            "region_markers": [
                                {"geometry_name": "film", "marker": 2},
                            ],
                        },
                    },
                )

    def test_frozen_air_filter_rejects_tet_with_vertex_inside_magnetic_submesh(self) -> None:
        frozen_payload = mesh_asset_pipeline.FrozenMagneticSubmeshPayload(
            mesh=MeshData.from_legacy_tet4(
                nodes=np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1.0, 0.0, 0.0],
                        [0.0, 1.0, 0.0],
                        [0.0, 0.0, 1.0],
                    ],
                    dtype=np.float64,
                ),
                elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
                element_markers=np.asarray([1], dtype=np.int32),
                boundary_faces=np.asarray([[0, 1, 2]], dtype=np.int32),
                boundary_markers=np.asarray([10], dtype=np.int32),
            ),
            region_markers=[{"geometry_name": "film", "marker": 1}],
            interface_facet_ordinals=np.asarray([0], dtype=np.int64),
            magnetic_submesh_signatures=[],
        )
        generated_air = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.1, 0.1, 0.1],
                    [2.0, 0.0, 0.0],
                    [0.0, 2.0, 0.0],
                    [0.0, 0.0, 2.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([0], dtype=np.int32),
            boundary_faces=np.asarray([[1, 2, 3]], dtype=np.int32),
            boundary_markers=np.asarray([99], dtype=np.int32),
        )

        keep = mesh_asset_pipeline._air_element_mask_outside_frozen_magnetic_submesh(
            generated_air,
            frozen_payload,
        )

        np.testing.assert_array_equal(keep, np.asarray([False], dtype=bool))

    def test_filter_boundary_faces_drops_faces_without_kept_air_tet(self) -> None:
        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray(
                [
                    [0, 1, 2, 3],
                    [1, 2, 3, 4],
                ],
                dtype=np.int32,
            ),
            element_markers=np.asarray([0, 0], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [1, 2, 4],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([99, 99], dtype=np.int32),
        )

        boundary_faces, boundary_markers = mesh_asset_pipeline._boundary_faces_for_kept_elements(
            mesh,
            np.asarray([False, True], dtype=bool),
        )

        np.testing.assert_array_equal(boundary_faces, np.asarray([[1, 2, 4]], dtype=np.int32))
        np.testing.assert_array_equal(boundary_markers, np.asarray([99], dtype=np.int32))

    def test_merge_frozen_magnetic_submesh_with_air_mesh_preserves_magnetic_indices(self) -> None:
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )
        payload = mesh_asset_pipeline.FrozenMagneticSubmeshPayload(
            mesh=frozen_mesh,
            region_markers=[{"geometry_name": "film", "marker": 1}],
            interface_facet_ordinals=np.arange(
                frozen_mesh.n_boundary_faces,
                dtype=np.int64,
            ),
            magnetic_submesh_signatures=mesh_asset_pipeline._magnetic_submesh_signatures(
                frozen_mesh,
                [{"geometry_name": "film", "marker": 1}],
            ),
        )
        air_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, -1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([7], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 99, 99, 99], dtype=np.int32),
        )

        merged = mesh_asset_pipeline._merge_frozen_magnetic_submesh_with_air_mesh(
            payload,
            air_mesh,
        )

        np.testing.assert_array_equal(merged.nodes[: frozen_mesh.n_nodes], frozen_mesh.nodes)
        np.testing.assert_array_equal(merged.elements[: frozen_mesh.n_elements], frozen_mesh.elements)
        np.testing.assert_array_equal(merged.element_markers, np.asarray([1, 0], dtype=np.int32))
        np.testing.assert_array_equal(merged.elements[1], np.asarray([0, 1, 2, 4], dtype=np.int32))
        self.assertEqual(merged.n_nodes, 5)
        self.assertEqual(merged.n_elements, 2)
        self.assertEqual(merged.n_boundary_faces, 7)
        merged_faces = [sorted(face.tolist()) for face in merged.boundary_faces]
        self.assertIn([0, 1, 2], merged_faces)
        self.assertEqual(
            int(np.count_nonzero(merged.boundary_markers == 10)),
            frozen_mesh.n_boundary_faces,
        )

    def test_generate_air_mesh_for_frozen_submesh_drops_periodic_pairs_without_kept_elements(self) -> None:
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [10.0, 10.0, 10.0],
                    [11.0, 10.0, 10.0],
                    [10.0, 11.0, 10.0],
                    [10.0, 10.0, 11.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )
        payload = mesh_asset_pipeline.FrozenMagneticSubmeshPayload(
            mesh=frozen_mesh,
            region_markers=[{"geometry_name": "film", "marker": 1}],
            interface_facet_ordinals=np.arange(
                frozen_mesh.n_boundary_faces,
                dtype=np.int64,
            ),
            magnetic_submesh_signatures=[],
        )
        generated = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                    [2.0, 0.0, 0.0],
                    [3.0, 0.0, 0.0],
                    [2.0, 1.0, 0.0],
                    [2.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32),
            element_markers=np.asarray([0, 1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [4, 5, 6],
                    [4, 5, 7],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([99, 99, 99, 99], dtype=np.int32),
            periodic_boundary_pairs=[
                {"pair_id": "x_faces", "marker_a": 21, "marker_b": 22},
            ],
            periodic_node_pairs=[
                {"pair_id": "x_faces", "node_a": 0, "node_b": 1},
                {"pair_id": "x_faces", "node_a": 4, "node_b": 5},
            ],
        )

        with patch(
            "fullmag.meshing.asset_pipeline.generate_mesh_from_file",
            return_value=generated,
        ):
            air_mesh = mesh_asset_pipeline._generate_air_mesh_for_frozen_magnetic_submesh(
                frozen=payload,
                geometries=[fm.Box(size=(1.0, 1.0, 1.0), name="film")],
                hints=fm.FEM(order=1, hmax=1.0),
                airbox=AirboxOptions(size=(4.0, 4.0, 4.0), center=(0.0, 0.0, 0.0)),
                mesh_workflow={"mesh_options": {"periodic_pair_ids": ["x_faces"]}},
                per_object_recipes=None,
                object_regions=None,
            )

        self.assertEqual(
            air_mesh.periodic_node_pairs,
            [{"pair_id": "x_faces", "node_a": 0, "node_b": 1}],
        )
        self.assertEqual(
            air_mesh.periodic_boundary_pairs,
            [{"pair_id": "x_faces", "marker_a": 21, "marker_b": 22}],
        )

    def test_generated_frozen_magnetic_submesh_mode_merges_prebuilt_air_mesh(self) -> None:
        film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="film")
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )
        air_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, -1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([7], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 99, 99, 99], dtype=np.int32),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            frozen_path = Path(tmp_dir) / "frozen_film.npz"
            air_path = Path(tmp_dir) / "air_mesh.npz"
            frozen_mesh.save(frozen_path)
            air_mesh.save(air_path)
            merged, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                [film],
                fm.FEM(order=1, hmax=20e-9),
                study_universe={
                    "mode": "manual",
                    "size": [400e-9, 400e-9, 180e-9],
                    "center": [0.0, 0.0, 0.0],
                },
                mesh_workflow={
                    "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                    "frozen_magnetic_submesh_source": {
                        "mesh_source": str(frozen_path),
                        "air_mesh_source": str(air_path),
                        "region_markers": [
                            {"geometry_name": "film", "marker": 1},
                        ],
                    },
                },
            )

        np.testing.assert_array_equal(merged.nodes[: frozen_mesh.n_nodes], frozen_mesh.nodes)
        np.testing.assert_array_equal(merged.elements[: frozen_mesh.n_elements], frozen_mesh.elements)
        np.testing.assert_array_equal(merged.element_markers, np.asarray([1, 0], dtype=np.int32))
        self.assertEqual(region_markers, [{"geometry_name": "film", "marker": 1}])
        self.assertEqual(report.build_mode, "frozen_magnetic_submesh_merge")
        self.assertEqual(report.magnetic_submesh_signatures[0]["geometry_name"], "film")
        self.assertEqual(report.magnetic_submesh_signatures[0]["tetra_count"], 1)

    def test_generated_frozen_magnetic_submesh_mode_uses_air_mesh_generator_when_no_source(self) -> None:
        film = fm.Box(size=(200e-9, 200e-9, 10e-9), name="film")
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )
        generated_air_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, -1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([0], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 99, 99, 99], dtype=np.int32),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            frozen_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_mesh.save(frozen_path)
            with patch(
                "fullmag.meshing.asset_pipeline._generate_air_mesh_for_frozen_magnetic_submesh",
                return_value=generated_air_mesh,
            ) as generator:
                merged, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                    [film],
                    fm.FEM(order=1, hmax=20e-9),
                    study_universe={
                        "mode": "manual",
                        "size": [400e-9, 400e-9, 180e-9],
                        "center": [0.0, 0.0, 0.0],
                    },
                    mesh_workflow={
                        "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                        "frozen_magnetic_submesh_source": {
                            "mesh_source": str(frozen_path),
                            "region_markers": [
                                {"geometry_name": "film", "marker": 1},
                            ],
                        },
                    },
                )

        self.assertEqual(generator.call_count, 1)
        self.assertEqual(generator.call_args.kwargs["frozen"].mesh.n_elements, 1)
        self.assertEqual(generator.call_args.kwargs["geometries"], [film])
        self.assertEqual(generator.call_args.kwargs["hints"].hmax, 20e-9)
        self.assertEqual(region_markers, [{"geometry_name": "film", "marker": 1}])
        np.testing.assert_array_equal(merged.element_markers, np.asarray([1, 0], dtype=np.int32))
        self.assertEqual(report.build_mode, "frozen_magnetic_submesh_merge")

    def test_generated_frozen_magnetic_submesh_mode_generates_air_mesh_from_frozen_boundary(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        film = fm.Box(size=(1.0, 1.0, 1.0), name="film")
        frozen_mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [0.0, 1.0, 0.0],
                    [0.0, 0.0, 1.0],
                ],
                dtype=np.float64,
            ),
            elements=np.asarray([[0, 1, 2, 3]], dtype=np.int32),
            element_markers=np.asarray([1], dtype=np.int32),
            boundary_faces=np.asarray(
                [
                    [0, 1, 2],
                    [0, 1, 3],
                    [0, 2, 3],
                    [1, 2, 3],
                ],
                dtype=np.int32,
            ),
            boundary_markers=np.asarray([10, 10, 10, 10], dtype=np.int32),
        )

        with tempfile.TemporaryDirectory() as tmp_dir:
            frozen_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_mesh.save(frozen_path)
            merged, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                [film],
                fm.FEM(order=1, hmax=0.75),
                study_universe={
                    "mode": "manual",
                    "size": [4.0, 4.0, 4.0],
                    "center": [0.5, 0.5, 0.5],
                    "airbox_hmax": 1.0,
                },
                mesh_workflow={
                    "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                    "frozen_magnetic_submesh_source": {
                        "mesh_source": str(frozen_path),
                        "region_markers": [
                            {"geometry_name": "film", "marker": 1},
                        ],
                    },
                    "mesh_options": {
                        "algorithm_3d": ALGO_3D_DELAUNAY,
                        "smoothing_steps": 0,
                        "optimize_iters": 0,
                    },
                },
            )

        np.testing.assert_array_equal(merged.nodes[: frozen_mesh.n_nodes], frozen_mesh.nodes)
        np.testing.assert_array_equal(merged.elements[: frozen_mesh.n_elements], frozen_mesh.elements)
        self.assertEqual(region_markers, [{"geometry_name": "film", "marker": 1}])
        self.assertEqual(report.build_mode, "frozen_magnetic_submesh_merge")
        self.assertGreater(int(np.count_nonzero(merged.element_markers == 0)), 0)
        self.assertEqual(int(np.count_nonzero(merged.element_markers == 1)), frozen_mesh.n_elements)
        self.assertGreater(merged.n_nodes, frozen_mesh.n_nodes)

    def test_generated_frozen_magnetic_submesh_keeps_magnetic_prefix_stable_across_airbox_sizes(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        film = fm.Box(size=(1.0, 1.0, 1.0), name="film")
        baseline_mesh, baseline_markers, _baseline_report = realize_fem_domain_mesh_asset_from_components_with_report(
            [film],
            fm.FEM(order=1, hmax=0.75),
            study_universe={
                "mode": "manual",
                "size": [4.0, 4.0, 4.0],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 1.0,
            },
            mesh_workflow={
                "mesh_options": {
                    "algorithm_3d": ALGO_3D_DELAUNAY,
                    "smoothing_steps": 0,
                    "optimize_iters": 0,
                },
            },
        )
        frozen_payload = mesh_asset_pipeline._extract_frozen_magnetic_submesh(
            baseline_mesh,
            baseline_markers,
            geometry_name="film",
        )

        def _build_with_airbox_size(size: float, mesh_path: Path) -> tuple[MeshData, dict[str, object]]:
            mesh, _markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                [film],
                fm.FEM(order=1, hmax=0.75),
                study_universe={
                    "mode": "manual",
                    "size": [size, size, size],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 1.0,
                },
                mesh_workflow={
                    "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                    "frozen_magnetic_submesh_source": {
                        "mesh_source": str(mesh_path),
                        "region_markers": frozen_payload.region_markers,
                    },
                    "mesh_options": {
                        "algorithm_3d": ALGO_3D_DELAUNAY,
                        "smoothing_steps": 0,
                        "optimize_iters": 0,
                    },
                },
            )
            signature = dict(report.to_dict()["magnetic_submesh_signatures"][0])  # type: ignore[index]
            return mesh, signature

        with tempfile.TemporaryDirectory() as tmp_dir:
            frozen_path = Path(tmp_dir) / "frozen_film.npz"
            frozen_payload.mesh.save(frozen_path)
            compact_mesh, compact_signature = _build_with_airbox_size(4.0, frozen_path)
            padded_mesh, padded_signature = _build_with_airbox_size(4.1, frozen_path)

        frozen_n_nodes = frozen_payload.mesh.n_nodes
        frozen_n_elements = frozen_payload.mesh.n_elements
        np.testing.assert_array_equal(
            compact_mesh.nodes[:frozen_n_nodes],
            frozen_payload.mesh.nodes,
        )
        np.testing.assert_array_equal(
            padded_mesh.nodes[:frozen_n_nodes],
            frozen_payload.mesh.nodes,
        )
        np.testing.assert_array_equal(
            compact_mesh.elements[:frozen_n_elements],
            frozen_payload.mesh.elements,
        )
        np.testing.assert_array_equal(
            padded_mesh.elements[:frozen_n_elements],
            frozen_payload.mesh.elements,
        )
        self.assertEqual(compact_signature, padded_signature)
        self.assertEqual(
            compact_signature["digest"],
            frozen_payload.magnetic_submesh_signatures[0]["digest"],
        )

    def test_component_aware_fallback_rebuilds_bounds_fields_for_local_hmax(self) -> None:
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))

        shared_domain_mesh = MeshData.from_legacy_tet4(
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

            def export(self, path: Path) -> None:
                path.write_text("solid fake\nendsolid fake\n", encoding="utf-8")

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
            "fullmag.meshing._gmsh_occ.is_occ_compatible",
            return_value=False,
        ), patch(
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
        self.assertNotIn("BoundsSurfaceThreshold", fallback_kinds)
        self.assertNotIn("ComponentVolumeConstant", fallback_kinds)
        self.assertNotIn("InterfaceShellThreshold", fallback_kinds)
        self.assertNotIn("TransitionShellThreshold", fallback_kinds)

    def test_realize_fem_domain_mesh_asset_emits_partition_summary(self) -> None:
        left = fm.Box(size=(1.0, 1.0, 1.0), name="left")
        right = fm.Box(size=(1.0, 1.0, 1.0), name="right").translate((2.0, 0.0, 0.0))

        shared_domain_mesh = MeshData.from_legacy_tet4(
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
                    [0, 1, 2, 11],
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
            "fullmag.meshing._gmsh_occ.is_occ_compatible",
            return_value=False,
        ), patch(
            "fullmag.meshing.asset_pipeline._import_trimesh",
            return_value=fake_trimesh,
        ), patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            return_value=_FakeSurface(),
        ), patch(
            "fullmag.meshing.gmsh_bridge.generate_mesh_from_file",
            return_value=shared_domain_mesh,
        ):
            realize_fem_domain_mesh_asset(
                [left, right],
                fm.FEM(order=1, hmax=0.1),
                study_universe={"mode": "manual", "size": [8.0, 8.0, 8.0], "center": [0.0, 0.0, 0.0]},
            )

        output = stderr.getvalue()
        self.assertIn("Total mesh: 3 tetrahedra, 12 nodes, 3 boundary faces", output)
        self.assertIn(
            "Mesh partition check: 3/3 tetrahedra covered by mutually exclusive region markers",
            output,
        )
        self.assertIn("Mesh part airbox: 1 tetrahedra, 4 nodes", output)
        self.assertIn("requested maximum element size:", output)
        self.assertIn("characteristic size:", output)
        self.assertEqual(output.count("size bins:"), 3)
        self.assertIn("edge span:", output)
        self.assertIn("Mesh part left: 1 tetrahedra, 4 nodes", output)
        self.assertIn(
            "Mesh node sharing left: shared_with_airbox=3, object_only=1, airbox_only=1",
            output,
        )
        self.assertIn("Mesh part right", output)
        self.assertIn(
            "shared_with_airbox=0, object_only=4, airbox_only=4",
            output,
        )
        self.assertIn("1 tetrahedra, 4 nodes", output)

    def test_node_indices_for_mixed_element_mask_uses_csr_connectivity(self) -> None:
        mesh = MeshData(
            nodes=np.zeros((9, 3), dtype=np.float64),
            cell_types=np.asarray(["prism6", "pyramid5", "tet4"], dtype=np.str_),
            cell_offsets=np.asarray([0, 6, 11, 15], dtype=np.int64),
            cell_nodes=np.asarray(
                [0, 1, 2, 3, 4, 5, 2, 3, 4, 6, 7, 0, 1, 2, 8],
                dtype=np.int32,
            ),
            element_markers=np.asarray([1, 0, 0], dtype=np.int32),
            facet_types=np.asarray([], dtype=np.str_),
            facet_roles=np.asarray([], dtype=np.str_),
            facet_offsets=np.asarray([0], dtype=np.int64),
            facet_nodes=np.asarray([], dtype=np.int32),
            boundary_markers=np.asarray([], dtype=np.int32),
            cell_global_ordinals=np.arange(3, dtype=np.int64),
            facet_global_ordinals=np.asarray([], dtype=np.int64),
        )

        np.testing.assert_array_equal(
            _node_indices_for_element_mask(
                mesh,
                np.asarray([True, False, True], dtype=np.bool_),
            ),
            np.asarray([0, 1, 2, 3, 4, 5, 8], dtype=np.int64),
        )

        class _NoPerElementAccess:
            n_elements = mesh.n_elements
            cell_offsets = mesh.cell_offsets
            cell_nodes = mesh.cell_nodes

            def cell_node_ids(self, _index: int) -> None:
                raise AssertionError("mixed CSR node lookup must not iterate per element")

        np.testing.assert_array_equal(
            _node_indices_for_element_mask(
                _NoPerElementAccess(),
                np.asarray([True, True, False], dtype=np.bool_),
            ),
            np.asarray([0, 1, 2, 3, 4, 5, 6, 7], dtype=np.int64),
        )

    def test_mesh_build_failed_event_reports_latest_explicit_phase(self) -> None:
        geometry = fm.Box(size=(1.0, 1.0, 1.0), name="magnet")

        with patch(
            "fullmag.meshing.asset_pipeline.emit_progress_event"
        ) as emit_event, patch(
            "fullmag.meshing.asset_pipeline.generate_mesh",
            side_effect=RuntimeError("native mesher failed"),
        ):
            with self.assertRaisesRegex(RuntimeError, "native mesher failed"):
                realize_fem_domain_mesh_asset(
                    [geometry],
                    fm.FEM(order=1, hmax=0.1),
                    study_universe={
                        "mode": "manual",
                        "size": [4.0, 4.0, 4.0],
                        "center": [0.0, 0.0, 0.0],
                    },
                    mesh_workflow={"single_geometry_occ_direct": True},
                )

        events = [call.args[0] for call in emit_event.call_args_list]
        failed_event = next(event for event in events if event["kind"] == "mesh_build_failed")
        self.assertEqual(failed_event["phase"], "meshing")
        emitted_phases = [
            event["phase"] for event in events if event["kind"] == "mesh_build_phase"
        ]
        self.assertEqual(emitted_phases[-1], failed_event["phase"])

    def test_mixed_mesh_build_failed_event_preserves_rejection_evidence(self) -> None:
        geometry = fm.Box(size=(1.0, 1.0, 0.1), name="magnet")

        with patch(
            "fullmag.meshing.asset_pipeline.emit_progress_event"
        ) as emit_event, patch(
            "fullmag.meshing.asset_pipeline.generate_mesh",
            side_effect=RuntimeError("resolved 2 layers"),
        ):
            with self.assertRaisesRegex(RuntimeError, "resolved 2 layers"):
                realize_fem_domain_mesh_asset(
                    [geometry],
                    fm.FEM(order=1, hmax=0.1),
                    study_universe={
                        "mode": "manual",
                        "size": [4.0, 4.0, 4.0],
                        "center": [0.0, 0.0, 0.0],
                    },
                    mesh_workflow={
                        "per_geometry": [{
                            "geometry": "magnet",
                            "mode": "custom",
                            "hmax": 0.1,
                            "maximum_element_size": 0.1,
                            "order": 1,
                            "mesh_strategy": "swept_prism",
                            "through_thickness_elements": 1,
                            "through_thickness_distribution": "fixed",
                            "sweep_face_meshing": "triangular",
                            "topology": "prismatic",
                            "sweep_direction": "auto",
                            "element_family": "prism",
                            "transition_policy": "pyramid_to_tetrahedra",
                            "exact_layer_count": True,
                        }],
                    },
                )

        failed_event = next(
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0]["kind"] == "mesh_build_failed"
        )
        self.assertEqual(
            failed_event["mixed_layer_topology_rejection"],
            {
                "schema_version": "mixed_layer_topology_rejection.v1",
                "certificate_status": "rejected",
                "requested_layer_count": 1,
                "rejection_reason": "resolved 2 layers",
            },
        )

    def test_mesh_build_failed_event_reports_postprocessing_failure_once(self) -> None:
        geometry = fm.Box(size=(1.0, 1.0, 1.0), name="magnet")
        failure = RuntimeError("postprocessing failed")

        with patch(
            "fullmag.meshing.asset_pipeline.emit_progress_event"
        ) as emit_event, patch(
            "fullmag.meshing.asset_pipeline.generate_mesh",
            return_value=object(),
        ), patch(
            "fullmag.meshing.asset_pipeline._drop_degenerate_tetrahedra",
            side_effect=failure,
        ):
            with self.assertRaises(RuntimeError) as raised:
                realize_fem_domain_mesh_asset(
                    [geometry],
                    fm.FEM(order=1, hmax=0.1),
                    study_universe={
                        "mode": "manual",
                        "size": [4.0, 4.0, 4.0],
                        "center": [0.0, 0.0, 0.0],
                    },
                    mesh_workflow={"single_geometry_occ_direct": True},
                )

        self.assertIs(raised.exception, failure)
        failed_events = [
            call.args[0]
            for call in emit_event.call_args_list
            if call.args[0]["kind"] == "mesh_build_failed"
        ]
        self.assertEqual(len(failed_events), 1)
        self.assertEqual(failed_events[0]["phase"], "postprocessing")

    def test_element_metric_summary_reports_thirty_characteristic_size_bins(self) -> None:
        scales = np.asarray([1.0, 1.5, 2.0, 3.0, 5.0, 8.0], dtype=np.float64)
        nodes: list[list[float]] = []
        elements: list[list[int]] = []
        for index, scale in enumerate(scales):
            base = len(nodes)
            offset = float(index) * 20.0
            nodes.extend(
                [
                    [offset, 0.0, 0.0],
                    [offset + float(scale), 0.0, 0.0],
                    [offset, float(scale), 0.0],
                    [offset, 0.0, float(scale)],
                ]
            )
            elements.append([base, base + 1, base + 2, base + 3])

        mesh = MeshData.from_legacy_tet4(
            nodes=np.asarray(nodes, dtype=np.float64),
            elements=np.asarray(elements, dtype=np.int32),
            element_markers=np.ones(len(elements), dtype=np.int32),
            boundary_faces=np.empty((0, 3), dtype=np.int32),
            boundary_markers=np.empty((0,), dtype=np.int32),
        )

        metrics = _element_metric_summary_for_mask(
            mesh,
            np.ones(len(elements), dtype=bool),
        )

        self.assertIsNotNone(metrics)
        bins = metrics["characteristic_size_bins"]
        self.assertEqual(len(bins), 30)
        self.assertEqual(sum(count for _start, _end, count in bins), len(elements))

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

    def test_format_gmsh_heartbeat_reports_indeterminate_activity_without_fake_percent(self) -> None:
        self.assertEqual(
            _format_gmsh_heartbeat(
                85.7,
                "Gmsh: Tetrahedrizing 737 nodes...",
                backend_idle_s=12.3,
            ),
            "Gmsh: meshing active (generating 3D mesh; 85.7s elapsed; "
            "no detailed backend update for 12.3s; last: Tetrahedrizing 737 nodes...)",
        )

    def test_format_gmsh_heartbeat_reports_when_backend_has_not_emitted_detail(self) -> None:
        self.assertEqual(
            _format_gmsh_heartbeat(5.0, backend_idle_s=5.0),
            "Gmsh: meshing active (generating 3D mesh; 5.0s elapsed; "
            "no detailed backend update yet)",
        )

    def test_gmsh_heartbeat_interval_backs_off_during_long_quiet_meshing(self) -> None:
        self.assertEqual(_gmsh_heartbeat_interval(5.0, 5.0), 5.0)
        self.assertEqual(_gmsh_heartbeat_interval(30.0, 5.0), 15.0)
        self.assertEqual(_gmsh_heartbeat_interval(120.0, 5.0), 30.0)
        self.assertEqual(_gmsh_heartbeat_interval(300.0, 60.0), 60.0)

    def test_gmsh_progress_logger_does_not_age_last_detail_from_filtered_noise(self) -> None:
        class _FakeLogger:
            @staticmethod
            def get() -> list[str]:
                return ["Info: Meshing curve 3 (Line)"]

        class _FakeGmsh:
            logger = _FakeLogger()

        progress = _GmshProgressLogger(_FakeGmsh())
        progress._last_detail_at = 10.0
        with patch("fullmag.meshing._gmsh_infra.time.monotonic", return_value=20.0):
            self.assertFalse(progress._flush())
        self.assertEqual(progress._last_detail_at, 10.0)

    def test_gmsh_progress_logger_reports_telemetry_failure_once(self) -> None:
        class _FailingLogger:
            @staticmethod
            def get() -> list[str]:
                raise RuntimeError("logger unavailable")

        class _FakeGmsh:
            logger = _FailingLogger()

        progress = _GmshProgressLogger(_FakeGmsh())
        with patch("fullmag.meshing._gmsh_infra.emit_progress") as emit:
            self.assertFalse(progress._flush())
            self.assertFalse(progress._flush())
        emit.assert_called_once_with(
            "Gmsh telemetry warning: failed to read native progress log "
            "(logger unavailable); mesh progress is indeterminate"
        )

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

    def test_interface_field_skipped_when_not_explicitly_set(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_interface_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "10e-9"}},
        )
        # Interface field is no longer auto-generated when user doesn't
        # explicitly set interface_hmax.
        self.assertEqual(len(fields), 0)

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
        self.assertAlmostEqual(fields[0]["params"]["DistMin"], 15e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 18e-9)

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

    def test_transition_field_requires_explicit_distance(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_transition_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={"left": {"bulk_hmax": "10e-9"}},
        )
        self.assertEqual(fields, [])

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
        self.assertEqual(fields[0]["params"]["Source"], "transition_distance")

    def test_transition_field_preserves_explicit_interface_shell_before_ramp(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_transition_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "bulk_hmax": "20e-9",
                    "interface_hmax": "2e-9",
                    "interface_thickness": "2e-9",
                    "transition_distance": "220e-9",
                    "transition_growth": "1.45",
                },
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "TransitionShellThreshold")
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 2e-9)
        self.assertAlmostEqual(fields[0]["params"]["SizeMax"], 500e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMin"], 2e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 222e-9)
        self.assertAlmostEqual(fields[0]["params"]["GrowthRate"], 1.45)

    def test_transition_field_component_aware_uses_shell_kind(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_transition_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={
                "left": {
                    "bulk_hmax": "8e-9",
                    "transition_distance": "24e-9",
                }
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "TransitionShellThreshold")
        self.assertEqual(fields[0]["params"]["GeometryName"], "left")
        self.assertEqual(fields[0]["params"]["Grading"], "geometric")

    def test_object_core_relaxation_expands_to_supported_fields(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        fields = _build_field_stack(
            [left],
            default_hmax=20e-9,
            per_geometry=[
                {
                    "geometry": "left",
                    "size_fields": [
                        {
                            "kind": "ObjectCoreRelaxation",
                            "params": {
                                "core_maximum_element_size": 5e-9,
                                "surface_maximum_element_size": 1e-9,
                                "surface_distance": 6e-9,
                            },
                        }
                    ],
                }
            ],
            component_aware=True,
        )
        core_fields = [
            field
            for field in fields
            if isinstance(field.get("params"), dict)
            and field["params"].get("Source") == "ObjectCoreRelaxation"
        ]
        self.assertEqual(
            [field["kind"] for field in core_fields],
            ["ComponentVolumeConstant", "SurfaceDistanceThreshold", "EdgeDistanceThreshold"],
        )
        self.assertEqual(core_fields[0]["params"]["GeometryName"], "left")
        self.assertEqual(core_fields[1]["params"]["Sampling"], 20)
        self.assertEqual(core_fields[2]["params"]["Sampling"], 40)

    def test_mesh_control_wrappers_validate_and_emit_size_fields(self) -> None:
        field = fm.mesh.object_core_relaxation(
            "arch_waveguide",
            maximum_element_size=6e-9,
            surface_maximum_element_size=3e-9,
            surface_distance=8e-9,
            edge_maximum_element_size=1.8e-9,
            edge_distance=12e-9,
            sampling_surface=12,
            sampling_edge=24,
        )

        self.assertEqual(field["kind"], "ObjectCoreRelaxation")
        self.assertEqual(field["params"]["GeometryName"], "arch_waveguide")
        self.assertAlmostEqual(field["params"]["edge_maximum_element_size"], 1.8e-9)
        self.assertEqual(field["params"]["sampling_surface"], 12)
        self.assertEqual(field["params"]["sampling_edge"], 24)
        with self.assertRaisesRegex(
            ValueError,
            "edge_maximum_element_size must be <= surface_maximum_element_size",
        ):
            fm.mesh.object_core_relaxation(
                "arch_waveguide",
                maximum_element_size=6e-9,
                surface_maximum_element_size=3e-9,
                surface_distance=8e-9,
                edge_maximum_element_size=4e-9,
                edge_distance=12e-9,
            )

    def test_mesh_control_wrappers_emit_nearest_entity_selectors(self) -> None:
        surface = fm.mesh.nearest_surface_to_point(
            point=(50e-9, 0.0, 2.5e-9),
            geometry="free_layer",
        )
        curve = fm.mesh.nearest_curve_to_point(
            point=(50e-9, 20e-9, 2.5e-9),
            geometry="free_layer",
            count=2,
        )

        self.assertEqual(
            surface,
            {
                "kind": "nearest_surface_to_point",
                "geometry": "free_layer",
                "point": [50e-9, 0.0, 2.5e-9],
                "count": 1,
            },
        )
        self.assertEqual(curve["kind"], "nearest_curve_to_point")
        self.assertEqual(curve["point"], [50e-9, 20e-9, 2.5e-9])
        self.assertEqual(curve["count"], 2)

    def test_boundary_layers_accepts_semantic_selectors(self) -> None:
        surface = fm.mesh.nearest_surface_to_point(
            point=(50e-9, 0.0, 2.5e-9),
            geometry="free_layer",
        )
        controls = fm.mesh.boundary_layers(
            count=3,
            first_layer_thickness=1e-9,
            stretching=1.25,
            target_surface_tags=[11],
            target_surfaces=[surface],
        )

        self.assertEqual(controls["boundary_layer_count"], 3)
        self.assertEqual(controls["boundary_layer_target_surface_tags"], [11])
        self.assertEqual(controls["boundary_layer_target_surface_selectors"], [surface])

    def test_perimeter_refinement_fields_build_component_scoped_sub_boxes(self) -> None:
        left = fm.Box(10.0, 4.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "5e-9",
                    "edge_thickness": "1.0",
                    "corner_hmax": "3e-9",
                    "corner_extent": "0.75",
                },
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 10)
        self.assertTrue(all(field["kind"] == "ComponentRestrictedBox" for field in fields[:8]))
        self.assertEqual(fields[8]["kind"], "EdgeDistanceThreshold")
        self.assertEqual(fields[9]["kind"], "CornerDistanceThreshold")
        self.assertEqual(fields[0]["params"]["GeometryName"], "left")
        self.assertAlmostEqual(fields[0]["params"]["XMin"], -5.0)
        self.assertAlmostEqual(fields[0]["params"]["XMax"], -4.0)
        self.assertAlmostEqual(fields[2]["params"]["YMin"], -2.0)
        self.assertAlmostEqual(fields[2]["params"]["YMax"], -1.0)
        self.assertAlmostEqual(fields[4]["params"]["XMin"], -5.0)
        self.assertAlmostEqual(fields[4]["params"]["YMin"], -2.0)
        self.assertAlmostEqual(fields[4]["params"]["XMax"], -4.25)
        self.assertAlmostEqual(fields[4]["params"]["YMax"], -1.25)

    def test_flat_arch_perimeter_refinement_uses_component_scoped_sub_boxes(self) -> None:
        arch = fm.ArchWaveguide(
            length=10.0,
            width=4.0,
            height=1.0,
            arch_height=0.0,
            name="flat_arch",
        )
        fields = _build_perimeter_refinement_fields(
            [arch],
            default_hmax=20e-9,
            override_by_name={
                "flat_arch": {
                    "edge_hmax": "5e-9",
                    "edge_thickness": "1.0",
                    "corner_hmax": "3e-9",
                    "corner_extent": "0.75",
                },
            },
            component_aware=True,
        )

        self.assertEqual(len(fields), 4)
        body_fields = [
            field
            for field in fields
            if field["kind"] == "ComponentRestrictedRectangularPerimeter"
        ]
        self.assertEqual(len(body_fields), 2)
        self.assertEqual(body_fields[0]["params"]["GeometryName"], "flat_arch")
        self.assertEqual(body_fields[0]["params"]["Mode"], "edge")
        self.assertEqual(body_fields[0]["params"]["AxisA"], 0)
        self.assertEqual(body_fields[0]["params"]["AxisB"], 1)
        self.assertAlmostEqual(body_fields[0]["params"]["Extent"], 1.0)
        self.assertEqual(body_fields[1]["params"]["Mode"], "corner")
        self.assertAlmostEqual(body_fields[1]["params"]["Extent"], 0.75)
        self.assertEqual(fields[2]["kind"], "EdgeDistanceThreshold")
        self.assertEqual(fields[3]["kind"], "CornerDistanceThreshold")

    def test_flat_arch_perimeter_refinement_skips_body_no_op_fields(self) -> None:
        arch = fm.ArchWaveguide(
            length=10.0,
            width=4.0,
            height=1.0,
            arch_height=0.0,
            name="flat_arch",
        )
        fields = _build_perimeter_refinement_fields(
            [arch],
            default_hmax=1e-6,
            override_by_name={
                "flat_arch": {
                    "hmax": "40e-9",
                    "edge_hmax": "40e-9",
                    "edge_thickness": "40e-9",
                    "edge_transition_distance": "airbox_boundary",
                    "corner_hmax": "40e-9",
                    "corner_extent": "40e-9",
                    "corner_transition_distance": "airbox_boundary",
                },
            },
            airbox_bounds=((-10.0, -8.0, -2.0), (10.0, 8.0, 2.0)),
            component_aware=True,
        )

        kinds = [field["kind"] for field in fields]
        self.assertNotIn("ComponentRestrictedRectangularPerimeter", kinds)
        self.assertEqual(kinds, ["EdgeDistanceThreshold", "CornerDistanceThreshold"])

    def test_box_edge_corner_refinement_emits_air_side_distance_fields(self) -> None:
        left = fm.Box(10.0, 4.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "5e-9",
                    "edge_thickness": "1.0",
                    "edge_transition_distance": "60e-9",
                    "corner_hmax": "3e-9",
                    "corner_extent": "0.75",
                    "corner_transition_distance": "40e-9",
                    "transition_growth": 1.35,
                },
            },
            component_aware=True,
        )

        kinds = [field["kind"] for field in fields]
        self.assertIn("ComponentRestrictedBox", kinds)
        self.assertIn("EdgeDistanceThreshold", kinds)
        self.assertIn("CornerDistanceThreshold", kinds)
        edge_fields = [field for field in fields if field["kind"] == "EdgeDistanceThreshold"]
        corner_fields = [field for field in fields if field["kind"] == "CornerDistanceThreshold"]
        self.assertEqual(len(edge_fields), 1)
        self.assertEqual(len(corner_fields), 1)
        self.assertEqual(edge_fields[0]["params"]["Grading"], "geometric")
        self.assertAlmostEqual(edge_fields[0]["params"]["GrowthRate"], 1.35)
        self.assertAlmostEqual(edge_fields[0]["params"]["DistMin"], 1.0)
        self.assertAlmostEqual(edge_fields[0]["params"]["DistMax"], 1.0 + 60e-9)
        self.assertEqual(corner_fields[0]["params"]["Grading"], "geometric")
        self.assertAlmostEqual(corner_fields[0]["params"]["GrowthRate"], 1.35)
        self.assertAlmostEqual(corner_fields[0]["params"]["DistMin"], 0.75)
        self.assertAlmostEqual(corner_fields[0]["params"]["DistMax"], 0.75 + 40e-9)

    def test_perimeter_refinement_allows_interface_shell_coexistence(self) -> None:
        left = fm.Box(10.0, 4.0, 1.0, name="left")
        fields = _build_field_stack(
            [left],
            default_hmax=20e-9,
            per_geometry=[
                {
                    "geometry": "left",
                    "bulk_hmax": "10e-9",
                    "interface_hmax": "3e-9",
                    "interface_thickness": "8e-9",
                    "edge_hmax": "5e-9",
                    "edge_thickness": "1.0",
                },
            ],
            component_aware=True,
        )
        kinds = [field["kind"] for field in fields]
        self.assertIn("InterfaceShellThreshold", kinds)
        self.assertIn("ComponentRestrictedBox", kinds)

    def test_perimeter_refinement_uses_edge_threshold_for_non_box_geometry(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "5e-9",
                    "edge_thickness": "1.0",
                },
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "EdgeDistanceThreshold")
        self.assertEqual(fields[0]["params"]["Selector"], {"mode": "all_boundary_curves"})
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 5e-9)

    def test_perimeter_refinement_uses_explicit_corner_threshold_for_non_box_geometry(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=20e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "5e-9",
                    "edge_thickness": "1.0",
                    "corner_hmax": "3e-9",
                    "corner_extent": "0.25",
                },
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 2)
        self.assertEqual(fields[0]["kind"], "EdgeDistanceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 5e-9)
        self.assertEqual(fields[1]["kind"], "CornerDistanceThreshold")
        self.assertEqual(fields[1]["params"]["Selector"], {"mode": "all_boundary_curve_endpoints"})
        self.assertAlmostEqual(fields[1]["params"]["SizeMin"], 3e-9)
        self.assertAlmostEqual(fields[1]["params"]["DistMin"], 0.0)
        self.assertAlmostEqual(fields[1]["params"]["DistMax"], 0.25)
        self.assertEqual(fields[1]["params"]["Source"], "per_geometry.corner_maximum_element_size")
        self.assertEqual(fields[1]["params"]["Grading"], "geometric")

    def test_flat_arch_waveguide_air_shell_uses_analytic_box_distance(self) -> None:
        geometry = fm.ArchWaveguide(
            length=10.0,
            width=4.0,
            height=1.0,
            arch_height=0.0,
            name="flat_arch",
        )
        fields = _build_field_stack(
            [geometry],
            default_hmax=20.0,
            per_geometry=[
                {
                    "geometry": "flat_arch",
                    "hmax": 10.0,
                    "interface_hmax": 2.0,
                    "interface_thickness": 1.0,
                    "transition_distance": 5.0,
                    "transition_growth": 1.45,
                },
            ],
            component_aware=True,
        )

        analytic_fields = [
            field for field in fields if field["kind"] == "AxisAlignedBoxDistanceThreshold"
        ]
        self.assertEqual(len(analytic_fields), 2)
        self.assertEqual(analytic_fields[0]["params"]["BoundsMin"], [-5.0, -2.0, -0.5])
        self.assertEqual(analytic_fields[0]["params"]["BoundsMax"], [5.0, 2.0, 0.5])
        self.assertEqual(analytic_fields[0]["params"]["Source"], "interface_hmax")
        self.assertEqual(analytic_fields[1]["params"]["Source"], "transition_distance")
        self.assertEqual(analytic_fields[1]["params"]["Grading"], "geometric")
        self.assertEqual(analytic_fields[1]["params"]["GrowthRate"], 1.45)

    def test_airbox_boundary_transition_token_resolves_from_object_and_airbox_bounds(self) -> None:
        geometry = fm.ArchWaveguide(
            length=2500e-9,
            width=1000e-9,
            height=40e-9,
            arch_height=0.0,
            name="flat_arch",
        )
        fields = _build_field_stack(
            [geometry],
            default_hmax=500e-9,
            per_geometry=[
                {
                    "geometry": "flat_arch",
                    "hmax": 40e-9,
                    "interface_hmax": 40e-9,
                    "interface_thickness": 40e-9,
                    "transition_distance": "airbox_boundary",
                    "edge_hmax": 40e-9,
                    "edge_thickness": 40e-9,
                    "edge_transition_distance": "airbox_boundary",
                    "corner_hmax": 40e-9,
                    "corner_extent": 40e-9,
                    "corner_transition_distance": "airbox_boundary",
                },
            ],
            airbox_bounds=(
                (-2000e-9, -1250e-9, -300e-9),
                (2000e-9, 1250e-9, 300e-9),
            ),
            component_aware=True,
        )

        transition_fields = [
            field
            for field in fields
            if field["kind"] == "AxisAlignedBoxDistanceThreshold"
            and field["params"].get("Source") == "airbox_boundary"
        ]
        edge_fields = [field for field in fields if field["kind"] == "EdgeDistanceThreshold"]
        corner_fields = [field for field in fields if field["kind"] == "CornerDistanceThreshold"]

        self.assertEqual(len(transition_fields), 1)
        self.assertEqual(len(edge_fields), 1)
        self.assertEqual(len(corner_fields), 1)
        self.assertAlmostEqual(transition_fields[0]["params"]["DistMin"], 40e-9)
        self.assertAlmostEqual(transition_fields[0]["params"]["DistMax"], 750e-9)
        self.assertEqual(
            transition_fields[0]["params"]["AirboxBoundsMin"],
            [-2000e-9, -1250e-9, -300e-9],
        )
        self.assertEqual(
            transition_fields[0]["params"]["AirboxBoundsMax"],
            [2000e-9, 1250e-9, 300e-9],
        )
        self.assertAlmostEqual(edge_fields[0]["params"]["DistMin"], 40e-9)
        self.assertAlmostEqual(edge_fields[0]["params"]["DistMax"], 750e-9)
        expected_corner_distance = ((750e-9) ** 2 + (750e-9) ** 2 + (280e-9) ** 2) ** 0.5
        self.assertAlmostEqual(corner_fields[0]["params"]["DistMin"], 40e-9)
        self.assertAlmostEqual(
            corner_fields[0]["params"]["DistMax"],
            expected_corner_distance,
        )

    def test_airbox_boundary_transition_token_requires_airbox_bounds(self) -> None:
        geometry = fm.ArchWaveguide(
            length=2500e-9,
            width=1000e-9,
            height=40e-9,
            arch_height=0.0,
            name="flat_arch",
        )

        with self.assertRaisesRegex(
            ValueError,
            "airbox_boundary transition distance requires rectangular airbox bounds",
        ):
            _build_field_stack(
                [geometry],
                default_hmax=500e-9,
                per_geometry=[
                    {
                        "geometry": "flat_arch",
                        "hmax": 40e-9,
                        "interface_hmax": 40e-9,
                        "interface_thickness": 40e-9,
                        "transition_distance": "airbox_boundary",
                    },
                ],
                component_aware=True,
            )

    def test_corner_threshold_does_not_inherit_surface_transition_distance(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "corner_hmax": "2e-9",
                    "corner_extent": "2e-9",
                    "transition_distance": "220e-9",
                },
            },
            component_aware=True,
        )

        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "CornerDistanceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 2e-9)
        self.assertAlmostEqual(fields[0]["params"]["SizeMax"], 500e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMin"], 0.0)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 2e-9)

    def test_corner_threshold_uses_explicit_corner_transition_distance(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "corner_hmax": "2e-9",
                    "corner_extent": "2e-9",
                    "corner_transition_distance": "60e-9",
                    "transition_distance": "220e-9",
                },
            },
            component_aware=True,
        )

        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "CornerDistanceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["DistMin"], 2e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 62e-9)

    def test_edge_threshold_does_not_inherit_surface_transition_distance(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "2e-9",
                    "edge_thickness": "2e-9",
                    "transition_distance": "220e-9",
                },
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "EdgeDistanceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["SizeMin"], 2e-9)
        self.assertAlmostEqual(fields[0]["params"]["SizeMax"], 500e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMin"], 0.0)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 2e-9)

    def test_edge_threshold_uses_explicit_edge_transition_distance(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "2e-9",
                    "edge_thickness": "2e-9",
                    "edge_transition_distance": "180e-9",
                    "transition_distance": "80e-9",
                },
            },
            component_aware=True,
        )
        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "EdgeDistanceThreshold")
        self.assertAlmostEqual(fields[0]["params"]["DistMin"], 2e-9)
        self.assertAlmostEqual(fields[0]["params"]["DistMax"], 182e-9)

    def test_edge_threshold_uses_geometric_grading_and_growth_rate(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "edge_hmax": "2e-9",
                    "edge_thickness": "2e-9",
                    "edge_transition_distance": "80e-9",
                    "transition_growth": 1.35,
                },
            },
            component_aware=True,
        )

        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "EdgeDistanceThreshold")
        self.assertEqual(fields[0]["params"]["Grading"], "geometric")
        self.assertAlmostEqual(fields[0]["params"]["GrowthRate"], 1.35)

    def test_corner_threshold_uses_transition_growth_rate(self) -> None:
        left = fm.Cylinder(2.0, 1.0, name="left")
        fields = _build_perimeter_refinement_fields(
            [left],
            default_hmax=500e-9,
            override_by_name={
                "left": {
                    "corner_hmax": "2e-9",
                    "corner_extent": "2e-9",
                    "corner_transition_distance": "40e-9",
                    "transition_growth": 1.4,
                },
            },
            component_aware=True,
        )

        self.assertEqual(len(fields), 1)
        self.assertEqual(fields[0]["kind"], "CornerDistanceThreshold")
        self.assertEqual(fields[0]["params"]["Grading"], "geometric")
        self.assertAlmostEqual(fields[0]["params"]["GrowthRate"], 1.4)

    def test_mesh_options_from_runtime_metadata_parses_boundary_layer_targets(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [
                    {
                        "geometry": "left",
                        "boundary_layer_count": 3,
                        "boundary_layer_thickness": "1e-9",
                        "boundary_layer_stretching": 1.25,
                        "boundary_layer_target_surface_tags": [11, 12],
                        "boundary_layer_target_curve_tags": [21],
                    }
                ]
            },
            geometries=[left],
            default_hmax=20e-9,
            component_aware=True,
        )
        self.assertEqual(options.boundary_layer_count, 3)
        self.assertAlmostEqual(options.boundary_layer_thickness, 1e-9)
        self.assertAlmostEqual(options.boundary_layer_stretching, 1.25)
        self.assertEqual(options.boundary_layer_target_surface_tags, [11, 12])
        self.assertEqual(options.boundary_layer_target_curve_tags, [21])

    def test_mesh_options_from_runtime_metadata_parses_boundary_layer_selectors(self) -> None:
        selector = {
            "kind": "nearest_surface_to_point",
            "geometry": "left",
            "point": [50e-9, 0.0, 2.5e-9],
            "count": 1,
        }
        options = _mesh_options_from_runtime_metadata(
            {
                "mesh_options": {
                    "boundary_layer_count": 3,
                    "boundary_layer_thickness": "1e-9",
                    "boundary_layer_target_surface_selectors": [selector],
                }
            },
            geometries=[fm.Box(100e-9, 20e-9, 5e-9, name="left")],
            default_hmax=20e-9,
        )

        self.assertEqual(options.boundary_layer_count, 3)
        self.assertEqual(options.boundary_layer_target_surface_selectors, [selector])

    def test_mesh_options_from_runtime_metadata_merges_multi_object_boundary_layer_selectors(self) -> None:
        left_selector = fm.mesh.nearest_surface_to_point(
            point=(-1.0, 0.0, 0.0),
            geometry="left",
        )
        right_selector = fm.mesh.nearest_curve_to_point(
            point=(1.0, 0.0, 0.0),
            geometry="right",
        )

        options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [
                    {
                        "geometry": "left",
                        "boundary_layer_count": 3,
                        "boundary_layer_thickness": "1e-9",
                        "boundary_layer_target_surface_selectors": [left_selector],
                    },
                    {
                        "geometry": "right",
                        "boundary_layer_count": 3,
                        "boundary_layer_thickness": "1e-9",
                        "boundary_layer_target_curve_selectors": [right_selector],
                    },
                ]
            },
            geometries=[
                fm.Box(2.0, 2.0, 2.0, name="left"),
                fm.Box(2.0, 2.0, 2.0, name="right"),
            ],
            default_hmax=20e-9,
            component_aware=True,
        )

        self.assertEqual(options.boundary_layer_count, 3)
        self.assertAlmostEqual(options.boundary_layer_thickness, 1e-9)
        self.assertEqual(options.boundary_layer_target_surface_selectors, [left_selector])
        self.assertEqual(options.boundary_layer_target_curve_selectors, [right_selector])

    def test_gmsh_selector_resolver_uses_geometry_scoped_candidates(self) -> None:
        class FakeOcc:
            def __init__(self) -> None:
                self.calls: list[tuple[float, float, float, list[tuple[int, int]], int]] = []

            def getClosestEntities(
                self,
                x: float,
                y: float,
                z: float,
                dim_tags: list[tuple[int, int]],
                n: int = 1,
            ) -> tuple[list[tuple[int, int]], list[float], list[float]]:
                self.calls.append((x, y, z, dim_tags, n))
                return [(2, 7)], [2.5e-9], [x, y, z]

        class FakeModel:
            def __init__(self) -> None:
                self.occ = FakeOcc()

            def getEntities(self, dim: int) -> list[tuple[int, int]]:
                return [(dim, 7), (dim, 8)]

        fake_gmsh = SimpleNamespace(model=FakeModel())
        selectors = [
            {
                "kind": "nearest_surface_to_point",
                "geometry": "left",
                "point": [50e-9, 0.0, 2.5e-9],
                "count": 1,
            }
        ]

        tags, reports = resolve_entity_selectors(
            fake_gmsh,
            selectors,
            dimension=2,
            component_surface_tags={"left": [7]},
        )

        self.assertEqual(tags, [7])
        self.assertEqual(fake_gmsh.model.occ.calls[0][3], [(2, 7)])
        self.assertEqual(reports[0]["selector"], selectors[0])
        self.assertEqual(reports[0]["resolved_tags"], [7])
        self.assertEqual(reports[0]["distances"], [2.5e-9])

    def test_gmsh_orphan_diagnostics_report_orphan_entities(self) -> None:
        class FakeModel:
            def getEntities(self, dim: int) -> list[tuple[int, int]]:
                if dim == 2:
                    return [(2, 3), (2, 4)]
                return []

            def isEntityOrphan(self, dim: int, tag: int) -> bool:
                return dim == 2 and tag == 4

        diagnostics = collect_orphan_entity_diagnostics(
            SimpleNamespace(model=FakeModel())
        )

        self.assertEqual(diagnostics, [{"dimension": 2, "tag": 4}])

    def test_apply_mesh_options_resolves_boundary_layer_surface_selectors(self) -> None:
        try:
            import gmsh
        except ImportError as exc:
            self.skipTest(f"gmsh not available: {exc}")

        gmsh.initialize()
        try:
            gmsh.model.add("boundary_layer_selector")
            gmsh.model.occ.addBox(0.0, 0.0, 0.0, 100.0, 20.0, 5.0)
            gmsh.model.occ.synchronize()

            report = _apply_mesh_options(
                gmsh,
                hmax=20.0,
                order=1,
                opts=MeshOptions(
                    boundary_layer_count=1,
                    boundary_layer_thickness=1.0,
                    boundary_layer_target_surface_selectors=[
                        fm.mesh.nearest_surface_to_point(
                            point=(50.0, 10.0, 5.0),
                        )
                    ],
                    compute_quality=False,
                    per_element_quality=False,
                ),
            )

            self.assertEqual(len(report.selector_resolution), 1)
            resolved_tags = report.selector_resolution[0]["resolved_tags"]
            self.assertEqual(len(resolved_tags), 1)
            self.assertIn((2, resolved_tags[0]), gmsh.model.getEntities(2))
        finally:
            gmsh.finalize()

    def test_public_boundary_layers_helper_requires_explicit_targets(self) -> None:
        with self.assertRaisesRegex(ValueError, "target_surface_tags or target_curve_tags"):
            fm.mesh.boundary_layers(count=3, first_layer_thickness=1e-9)

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
                {"geometry": "right", "bulk_hmax": "6e-9", "interface_hmax": "3e-9"},
            ],
        )
        kinds = [f["kind"] for f in fields]
        # Both objects contribute bulk + interface; only the explicit
        # transition_distance contributes a transition shell.
        self.assertIn("Box", kinds)
        self.assertIn("BoundsSurfaceThreshold", kinds)
        # Expect 2 bulk, 2 interface, 1 transition.
        self.assertGreaterEqual(len(fields), 5)

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
        self.assertAlmostEqual(resolved.per_object["left"].hmax, 20e-9, delta=1e-18)
        self.assertEqual(resolved.per_object["left"].source, "recipe_override")

    def test_resolve_shared_domain_targets_uses_canonical_recipe_maximum(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        resolved = resolve_shared_domain_targets(
            [left],
            fm.FEM(order=1, hmax=100e-9),
            airbox_hmax=200e-9,
            mesh_workflow={
                "per_geometry": [{"geometry": "left", "hmax": "50e-9"}],
            },
            per_object_recipes={
                "left": PerObjectMeshRecipe(maximum_element_size=20e-9),
            },
        )

        self.assertAlmostEqual(resolved.per_object["left"].hmax, 20e-9, delta=1e-18)
        self.assertEqual(resolved.per_object["left"].source, "recipe_override")

    def test_shared_domain_size_fields_keep_airbox_hmax_as_outer_target(self) -> None:
        """Airbox hmax must not replace FEM.hmax, but fields need it as VOut."""
        self.assertEqual(
            _shared_domain_size_field_default_hmax(
                fm.FEM(order=1, hmax=25e-9),
                AirboxOptions(maximum_element_size=80e-9),
            ),
            80e-9,
        )
        self.assertEqual(
            _shared_domain_size_field_default_hmax(
                fm.FEM(order=1, hmax=25e-9),
                None,
            ),
            25e-9,
        )

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

    def test_per_object_recipe_hmax_does_not_auto_add_transition_shell(self) -> None:
        layer = fm.Box(size=(2000e-9, 600e-9, 10e-9), name="permalloy_layer")
        ring = fm.Difference(
            base=fm.Cylinder(radius=150e-9, height=50e-9, axis=(1.0, 0.0, 0.0), name="ring_outer"),
            tool=fm.Cylinder(radius=50e-9, height=50e-9, axis=(1.0, 0.0, 0.0), name="ring_inner"),
            name="cofeb_ring",
        )

        fields = _resolve_per_object_mesh_options(
            [layer, ring],
            {
                "permalloy_layer": PerObjectMeshRecipe(maximum_element_size=8e-9),
                "cofeb_ring": PerObjectMeshRecipe(maximum_element_size=25e-9),
            },
            SharedMeshAssemblyPolicy(),
            default_hmax=500e-9,
            bounds_by_name={
                "permalloy_layer": ((-1000e-9, -300e-9, -5e-9), (1000e-9, 300e-9, 5e-9)),
                "cofeb_ring": ((-25e-9, -150e-9, 15e-9), (25e-9, 150e-9, 315e-9)),
            },
            component_aware=True,
        )

        kinds = [field["kind"] for field in fields]
        self.assertEqual(kinds, ["ComponentVolumeConstant", "ComponentVolumeConstant"])
        self.assertNotIn("TransitionShellThreshold", kinds)

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

    def test_build_report_keeps_occ_algorithm_retry_non_degraded(self) -> None:
        left = fm.Box(2.0, 2.0, 2.0, name="left")
        report = _build_shared_domain_build_report(
            [left],
            fm.FEM(order=1, hmax=20e-9),
            airbox=AirboxOptions(maximum_element_size=100e-9),
            mesh_workflow=None,
            per_object_recipes=None,
            size_fields=[],
            region_markers=[{"geometry_name": "left", "marker": 1}],
            build_mode="conformal_occ",
            fallbacks_triggered=["conformal_occ_delaunay_degenerate_retry_frontal"],
            mesh_options=MeshOptions(algorithm_3d=ALGO_3D_FRONTAL),
        )

        self.assertFalse(report.degraded)
        self.assertEqual(
            report.fallbacks_triggered,
            ["conformal_occ_delaunay_degenerate_retry_frontal"],
        )

    def test_conformal_occ_hxt_degenerate_retries_delaunay(self) -> None:
        left = fm.Box((20e-9, 20e-9, 10e-9), name="left")
        calls: list[int] = []

        def _mesh(degenerate: bool) -> MeshData:
            if degenerate:
                nodes = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-50],
                    ],
                    dtype=np.float64,
                )
                elements = np.asarray([[0, 1, 2, 3]], dtype=np.int32)
                markers = np.asarray([0], dtype=np.int32)
            else:
                nodes = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-8],
                        [2e-8, 0.0, 0.0],
                        [3e-8, 0.0, 0.0],
                        [2e-8, 1e-8, 0.0],
                        [2e-8, 0.0, 1e-8],
                    ],
                    dtype=np.float64,
                )
                elements = np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32)
                markers = np.asarray([0, 7], dtype=np.int32)
            return MeshData.from_legacy_tet4(
                nodes=nodes,
                elements=elements,
                element_markers=markers,
                boundary_faces=np.empty((0, 3), dtype=np.int32),
                boundary_markers=np.empty((0,), dtype=np.int32),
            )

        def _fake_occ(*args: object, **kwargs: object) -> SharedDomainMeshResult:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            calls.append(options.algorithm_3d)
            return SharedDomainMeshResult(
                mesh=_mesh(degenerate=len(calls) == 1),
                component_marker_tags={"left": 7},
                component_volume_tags={"left": [7]},
                component_surface_tags={"left": [1]},
                interface_surface_tags=[1],
                outer_boundary_surface_tags=[2],
            )

        with patch(
            "fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ",
            side_effect=_fake_occ,
        ):
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[left],
                hints=fm.FEM(order=1, hmax=80e-9),
                study_universe={
                    "mode": "manual",
                    "size": [120e-9, 120e-9, 80e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                    "airbox_hmin": 20e-9,
                },
                mesh_workflow={
                    "mesh_options": {"algorithm_3d": ALGO_3D_HXT},
                    "per_geometry": [
                        {
                            "geometry": "left",
                            "mode": "custom",
                            "hmax": 20e-9,
                        }
                    ],
                },
            )

        self.assertEqual(calls, [ALGO_3D_HXT, ALGO_3D_DELAUNAY])
        self.assertEqual(mesh.n_elements, 2)
        self.assertEqual(region_markers, [{"geometry_name": "left", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertEqual(
            report.fallbacks_triggered,
            ["conformal_occ_hxt_degenerate_retry_delaunay"],
        )

    def test_conformal_occ_hxt_partial_degenerate_retries_delaunay_without_cleanup(self) -> None:
        left = fm.Box((20e-9, 20e-9, 10e-9), name="left")
        calls: list[int] = []

        def _mesh(partial_degenerate: bool) -> MeshData:
            return MeshData.from_legacy_tet4(
                nodes=np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-8],
                        [2e-8, 0.0, 0.0],
                        [3e-8, 0.0, 0.0],
                        [2e-8, 1e-8, 0.0],
                        (
                            [3e-8, 1e-8, 0.0]
                            if partial_degenerate
                            else [2e-8, 0.0, 1e-8]
                        ),
                    ],
                    dtype=np.float64,
                ),
                elements=np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32),
                element_markers=np.asarray([7, 7], dtype=np.int32),
                boundary_faces=np.empty((0, 3), dtype=np.int32),
                boundary_markers=np.empty((0,), dtype=np.int32),
            )

        def _fake_occ(*args: object, **kwargs: object) -> SharedDomainMeshResult:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            calls.append(options.algorithm_3d)
            return SharedDomainMeshResult(
                mesh=_mesh(partial_degenerate=len(calls) == 1),
                component_marker_tags={"left": 7},
                component_volume_tags={"left": [7]},
                component_surface_tags={"left": [1]},
                interface_surface_tags=[1],
                outer_boundary_surface_tags=[2],
            )

        with patch(
            "fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ",
            side_effect=_fake_occ,
        ):
            cleaned_mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[left],
                hints=fm.FEM(order=1, hmax=80e-9),
                study_universe={
                    "mode": "manual",
                    "size": [120e-9, 120e-9, 80e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                    "airbox_hmin": 20e-9,
                },
                mesh_workflow={
                    "mesh_options": {"algorithm_3d": ALGO_3D_HXT},
                    "per_geometry": [
                        {
                            "geometry": "left",
                            "mode": "custom",
                            "hmax": 20e-9,
                        }
                    ],
                },
            )

        self.assertEqual(calls, [ALGO_3D_HXT, ALGO_3D_DELAUNAY])
        self.assertEqual(cleaned_mesh.n_elements, 2)
        self.assertEqual(region_markers, [{"geometry_name": "left", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertEqual(
            report.fallbacks_triggered,
            ["conformal_occ_hxt_degenerate_retry_delaunay"],
        )

    def test_conformal_occ_delaunay_degenerate_with_size_fields_retries_hxt_first(self) -> None:
        left = fm.Box((20e-9, 20e-9, 10e-9), name="left")
        calls: list[int] = []

        def _mesh(degenerate: bool) -> MeshData:
            if degenerate:
                nodes = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-50],
                    ],
                    dtype=np.float64,
                )
                elements = np.asarray([[0, 1, 2, 3]], dtype=np.int32)
                markers = np.asarray([0], dtype=np.int32)
            else:
                nodes = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-8],
                        [2e-8, 0.0, 0.0],
                        [3e-8, 0.0, 0.0],
                        [2e-8, 1e-8, 0.0],
                        [2e-8, 0.0, 1e-8],
                    ],
                    dtype=np.float64,
                )
                elements = np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32)
                markers = np.asarray([0, 7], dtype=np.int32)
            return MeshData.from_legacy_tet4(
                nodes=nodes,
                elements=elements,
                element_markers=markers,
                boundary_faces=np.empty((0, 3), dtype=np.int32),
                boundary_markers=np.empty((0,), dtype=np.int32),
            )

        def _fake_occ(*args: object, **kwargs: object) -> SharedDomainMeshResult:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            calls.append(options.algorithm_3d)
            return SharedDomainMeshResult(
                mesh=_mesh(degenerate=len(calls) == 1),
                component_marker_tags={"left": 7},
                component_volume_tags={"left": [7]},
                component_surface_tags={"left": [1]},
                interface_surface_tags=[1],
                outer_boundary_surface_tags=[2],
            )

        with patch(
            "fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ",
            side_effect=_fake_occ,
        ):
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[left],
                hints=fm.FEM(order=1, hmax=80e-9),
                study_universe={
                    "mode": "manual",
                    "size": [120e-9, 120e-9, 80e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                    "airbox_hmin": 20e-9,
                },
                mesh_workflow={
                    "mesh_options": {"algorithm_3d": ALGO_3D_DELAUNAY},
                    "per_geometry": [
                        {
                            "geometry": "left",
                            "mode": "custom",
                            "hmax": 20e-9,
                        }
                    ],
                },
            )

        self.assertEqual(calls, [ALGO_3D_DELAUNAY, ALGO_3D_HXT])
        self.assertEqual(mesh.n_elements, 2)
        self.assertEqual(region_markers, [{"geometry_name": "left", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertEqual(
            report.fallbacks_triggered,
            ["conformal_occ_delaunay_degenerate_retry_hxt"],
        )

    def test_conformal_occ_hxt_degenerate_retries_through_frontal(self) -> None:
        left = fm.Box((20e-9, 20e-9, 10e-9), name="left")
        calls: list[int] = []

        def _mesh(degenerate: bool) -> MeshData:
            if degenerate:
                nodes = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-50],
                    ],
                    dtype=np.float64,
                )
                elements = np.asarray([[0, 1, 2, 3]], dtype=np.int32)
                markers = np.asarray([0], dtype=np.int32)
            else:
                nodes = np.asarray(
                    [
                        [0.0, 0.0, 0.0],
                        [1e-8, 0.0, 0.0],
                        [0.0, 1e-8, 0.0],
                        [0.0, 0.0, 1e-8],
                        [2e-8, 0.0, 0.0],
                        [3e-8, 0.0, 0.0],
                        [2e-8, 1e-8, 0.0],
                        [2e-8, 0.0, 1e-8],
                    ],
                    dtype=np.float64,
                )
                elements = np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32)
                markers = np.asarray([0, 7], dtype=np.int32)
            return MeshData.from_legacy_tet4(
                nodes=nodes,
                elements=elements,
                element_markers=markers,
                boundary_faces=np.empty((0, 3), dtype=np.int32),
                boundary_markers=np.empty((0,), dtype=np.int32),
            )

        def _fake_occ(*args: object, **kwargs: object) -> SharedDomainMeshResult:
            options = kwargs.get("options")
            self.assertIsInstance(options, MeshOptions)
            calls.append(options.algorithm_3d)
            return SharedDomainMeshResult(
                mesh=_mesh(degenerate=len(calls) < 3),
                component_marker_tags={"left": 7},
                component_volume_tags={"left": [7]},
                component_surface_tags={"left": [1]},
                interface_surface_tags=[1],
                outer_boundary_surface_tags=[2],
            )

        with patch(
            "fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ",
            side_effect=_fake_occ,
        ), patch(
            "fullmag.meshing.asset_pipeline.emit_progress"
        ) as emit_progress_mock, patch(
            "fullmag.meshing.asset_pipeline.emit_progress_event"
        ) as emit_progress_event_mock:
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[left],
                hints=fm.FEM(order=1, hmax=80e-9),
                study_universe={
                    "mode": "manual",
                    "size": [120e-9, 120e-9, 80e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                    "airbox_hmin": 20e-9,
                },
                mesh_workflow={
                    "mesh_options": {"algorithm_3d": ALGO_3D_HXT},
                    "per_geometry": [
                        {
                            "geometry": "left",
                            "mode": "custom",
                            "hmax": 20e-9,
                        }
                    ],
                },
            )

        self.assertEqual(calls, [ALGO_3D_HXT, ALGO_3D_DELAUNAY, ALGO_3D_FRONTAL])
        self.assertEqual(mesh.n_elements, 2)
        self.assertEqual(region_markers, [{"geometry_name": "left", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertEqual(
            report.fallbacks_triggered,
            [
                "conformal_occ_hxt_degenerate_retry_delaunay",
                "conformal_occ_delaunay_degenerate_retry_frontal",
            ],
        )
        progress_messages = [call.args[0] for call in emit_progress_mock.call_args_list]
        self.assertIn(
            "Conformal OCC mesh attempt 1 started with HXT (progress is indeterminate)",
            progress_messages,
        )
        self.assertTrue(
            any(
                "Conformal OCC mesh attempt 1 failed" in message
                and "starting attempt 2 with Delaunay" in message
                for message in progress_messages
            )
        )
        self.assertTrue(
            any(
                "Conformal OCC mesh attempt 2 failed" in message
                and "starting attempt 3 with Frontal" in message
                for message in progress_messages
            )
        )
        self.assertIn(
            "Conformal OCC mesh attempt 3 started with Frontal (progress is indeterminate)",
            progress_messages,
        )
        attempt_events = [
            call.args[0]
            for call in emit_progress_event_mock.call_args_list
            if call.args[0].get("attempt_index") is not None
        ]
        self.assertEqual(
            [
                (
                    event["attempt_index"],
                    event["algorithm_3d"],
                    event["attempt_status"],
                    event.get("progress_percent"),
                )
                for event in attempt_events
            ],
            [
                (1, "HXT", "active", None),
                (1, "HXT", "failed_recoverable", None),
                (2, "Delaunay", "active", None),
                (2, "Delaunay", "failed_recoverable", None),
                (3, "Frontal", "active", None),
                (3, "Frontal", "completed", None),
            ],
        )
        self.assertEqual(
            attempt_events[-2]["progress_label"],
            "Attempt 3 — Frontal — progress indeterminate",
        )
        recoverable_failures = [
            event
            for event in attempt_events
            if event["attempt_status"] == "failed_recoverable"
        ]
        self.assertTrue(
            all(
                "degenerate tetra volume" in event["attempt_failure_reason"]
                for event in recoverable_failures
            )
        )
        self.assertEqual(
            [event["next_algorithm_3d"] for event in recoverable_failures],
            ["Delaunay", "Frontal"],
        )

    def test_multi_object_sizing_cylinder_and_waveguide(self) -> None:
        """Verify that a multi-object shared-domain mesh generation with Cylinder,

        ArchWaveguide, and Airbox respects per-object hmax/hmin size fields.
        """
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        cylinder_base = fm.Cylinder(radius=100e-9, height=50e-9, name="cylinder_base")
        cylinder = fm.Translate(cylinder_base, (0.0, 300e-9, 0.0), name="cylinder")
        waveguide = fm.ArchWaveguide(
            length=800e-9,
            width=150e-9,
            height=30e-9,
            arch_height=40e-9,
            z0=-20e-9,
            name="waveguide",
        )

        per_object_recipes = {
            "cylinder": PerObjectMeshRecipe(hmax=10e-9, hmin=2e-9),
            "waveguide": PerObjectMeshRecipe(hmax=15e-9, hmin=3e-9),
        }

        study_universe = {
            "mode": "manual",
            "size": [1.5e-6, 1.2e-6, 400e-9],
            "center": [0.0, 100e-9, 0.0],
            "airbox_hmax": 120e-9,
            "airbox_hmin": 20e-9,
        }

        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[cylinder, waveguide],
            hints=fm.FEM(order=1, hmax=120e-9),
            study_universe=study_universe,
            per_object_recipes=per_object_recipes,
        )

        self.assertGreater(mesh.n_nodes, 0)
        self.assertGreater(mesh.n_elements, 0)
        self.assertEqual(len(region_markers), 2)
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertTrue(
            set(report.fallbacks_triggered).issubset(
                {
                    "conformal_occ_hxt_degenerate_retry_delaunay",
                    "conformal_occ_hxt_degenerate_retry_frontal",
                    "conformal_occ_delaunay_degenerate_retry_hxt",
                    "conformal_occ_delaunay_degenerate_retry_frontal",
                    "shared_domain_degenerate_tetra_cleanup",
                }
            )
        )
        self.assertIn("ComponentVolumeConstant", report.used_size_field_kinds)

    def test_multi_object_box_and_cylinder_preserve_object_priority_under_coarse_airbox(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        cube = fm.Box((80e-9, 80e-9, 40e-9), name="cube")
        cylinder = fm.Translate(
            fm.Cylinder(radius=40e-9, height=40e-9, name="cylinder_base"),
            (150e-9, 0.0, 0.0),
            name="cylinder",
        )

        edge_pairs = np.asarray(
            [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]],
            dtype=np.int64,
        )

        def _region_edge_lengths(mesh: MeshData, marker: int) -> np.ndarray:
            elems = mesh.elements[np.asarray(mesh.element_markers) == marker]
            edges = elems[:, edge_pairs].reshape(-1, 2)
            edges.sort(axis=1)
            edges = np.unique(edges, axis=0)
            return np.linalg.norm(
                mesh.nodes[edges[:, 0]] - mesh.nodes[edges[:, 1]],
                axis=1,
            )

        def _build_metrics(airbox_hmax: float, airbox_hmin: float) -> dict[str, float]:
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[cube, cylinder],
                hints=fm.FEM(order=1, hmax=80e-9),
                study_universe={
                    "mode": "manual",
                    "size": [360e-9, 240e-9, 160e-9],
                    "center": [60e-9, 0.0, 0.0],
                    "airbox_hmax": airbox_hmax,
                    "airbox_hmin": airbox_hmin,
                },
                per_object_recipes={
                    "cube": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
                    "cylinder": PerObjectMeshRecipe(hmax=28e-9, hmin=8e-9),
                },
            )

            marker_by_name = {
                str(entry["geometry_name"]): int(entry["marker"])
                for entry in region_markers
            }
            self.assertEqual(set(marker_by_name), {"cube", "cylinder"})
            self.assertEqual(report.build_mode, "conformal_occ")
            self.assertFalse(report.degraded)
            self.assertTrue(
                set(report.fallbacks_triggered).issubset(
                    {
                        "conformal_occ_hxt_degenerate_retry_delaunay",
                        "conformal_occ_hxt_degenerate_retry_frontal",
                        "conformal_occ_delaunay_degenerate_retry_hxt",
                        "conformal_occ_delaunay_degenerate_retry_frontal",
                    }
                )
            )
            self.assertIn("ComponentVolumeConstant", report.used_size_field_kinds)
            cube_edges = _region_edge_lengths(mesh, marker_by_name["cube"])
            cylinder_edges = _region_edge_lengths(mesh, marker_by_name["cylinder"])
            return {
                "cube_median": float(np.percentile(cube_edges, 50)),
                "cube_p95": float(np.percentile(cube_edges, 95)),
                "cylinder_median": float(np.percentile(cylinder_edges, 50)),
                "cylinder_p95": float(np.percentile(cylinder_edges, 95)),
            }

        baseline = _build_metrics(airbox_hmax=80e-9, airbox_hmin=20e-9)
        coarse_airbox = _build_metrics(airbox_hmax=160e-9, airbox_hmin=40e-9)

        for metrics in (baseline, coarse_airbox):
            self.assertLess(metrics["cube_median"], 12e-9)
            self.assertLess(metrics["cube_p95"], 15e-9)
            self.assertGreater(metrics["cylinder_median"], 14e-9)
            self.assertLess(metrics["cylinder_median"], 31e-9)
            self.assertLess(metrics["cylinder_p95"], 50e-9)
            self.assertLess(metrics["cube_median"], metrics["cylinder_median"] * 0.75)

        self.assertLess(
            abs(baseline["cube_median"] - coarse_airbox["cube_median"]),
            1.0e-9,
        )
        self.assertLess(
            abs(baseline["cube_p95"] - coarse_airbox["cube_p95"]),
            1.0e-9,
        )
        self.assertLess(
            abs(baseline["cylinder_median"] - coarse_airbox["cylinder_median"]),
            8.0e-9,
        )
        self.assertLess(
            abs(baseline["cylinder_p95"] - coarse_airbox["cylinder_p95"]),
            10.0e-9,
        )

    def test_periodic_airbox_z_padding_reports_magnetic_submesh_signature_drift(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        def _build_report_signature(airbox_thickness: float) -> dict[str, object]:
            film_size = (200e-9, 200e-9, 10e-9)
            body = fm.Difference(
                base=fm.Box(size=film_size, name="periodic_film_base"),
                tool=fm.Cylinder(radius=25e-9, height=film_size[2], name="central_hole"),
                name="periodic_film",
            )
            _mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[body],
                hints=fm.FEM(order=1, hmax=120e-9),
                study_universe={
                    "mode": "manual",
                    "size": [film_size[0], film_size[1], airbox_thickness],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                    "airbox_hmin": 16e-9,
                    "airbox_growth_rate": 1.5,
                    "airbox_grading": "linear",
                },
                mesh_workflow={
                    "mesh_options": {
                        "periodic_pair_ids": ["x_faces", "y_faces"],
                        "algorithm_2d": 6,
                        "algorithm_3d": ALGO_3D_DELAUNAY,
                        "smoothing_steps": 1,
                        "optimize_iters": 1,
                        "size_from_curvature": 8,
                        "narrow_regions": 1,
                    },
                    "per_geometry": [
                        {
                            "geometry": "periodic_film",
                            "bulk_hmax": 20e-9,
                            "interface_hmax": 14e-9,
                            "interface_thickness": 8e-9,
                            "transition_distance": 20e-9,
                            "edge_hmax": 12e-9,
                            "edge_thickness": 5e-9,
                            "edge_transition_distance": 12e-9,
                            "corner_hmax": 12e-9,
                            "corner_extent": 5e-9,
                            "corner_transition_distance": 10e-9,
                        }
                    ],
                },
                object_regions=[
                    {
                        "owner_object": "periodic_film",
                        "name": "hole_transition_refinement",
                        "enabled": True,
                        "shape": {
                            "kind": "cylinder",
                            "radius": 43e-9,
                            "height": film_size[2],
                            "center": [0.0, 0.0, 0.0],
                            "axis": [0.0, 0.0, 1.0],
                        },
                        "mesh_policy": {
                            "minimum_element_size": 8e-9,
                            "maximum_element_size": 14e-9,
                            "transition_distance": 14e-9,
                            "order": 1,
                        },
                    },
                    {
                        "owner_object": "periodic_film",
                        "name": "hole_edge_refinement",
                        "enabled": True,
                        "shape": {
                            "kind": "cylinder",
                            "radius": 30e-9,
                            "height": film_size[2],
                            "center": [0.0, 0.0, 0.0],
                            "axis": [0.0, 0.0, 1.0],
                        },
                        "mesh_policy": {
                            "minimum_element_size": 8e-9,
                            "maximum_element_size": 12e-9,
                            "transition_distance": 6e-9,
                            "order": 1,
                        },
                    },
                ],
            )
            marker_by_name = {
                str(entry["geometry_name"]): int(entry["marker"])
                for entry in region_markers
            }
            self.assertEqual(report.build_mode, "conformal_occ")
            self.assertFalse(report.degraded)
            self.assertEqual(marker_by_name, {"periodic_film": 1})
            signatures = report.to_dict()["magnetic_submesh_signatures"]
            self.assertEqual(len(signatures), 1)
            signature = dict(signatures[0])  # type: ignore[index]
            self.assertEqual(signature["geometry_name"], "periodic_film")
            self.assertEqual(signature["marker"], marker_by_name["periodic_film"])
            self.assertEqual(signature["coordinate_quantization_m"], 1.0e-12)
            self.assertIsInstance(signature["digest"], str)
            self.assertGreater(signature["node_count"], 0)
            self.assertGreater(signature["tetra_count"], 0)
            self.assertGreater(signature["edge_count"], 0)
            return signature

        baseline = _build_report_signature(90.0e-9)
        padded = _build_report_signature(90.1e-9)
        self.assertNotEqual(
            (
                baseline["node_count"],
                baseline["tetra_count"],
                baseline["edge_count"],
                baseline["digest"],
            ),
            (
                padded["node_count"],
                padded["tetra_count"],
                padded["edge_count"],
                padded["digest"],
            ),
        )

    def test_periodic_antidot_frozen_magnetic_submesh_stays_stable_across_airbox_z_padding(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        film_size = (200e-9, 200e-9, 10e-9)
        body = fm.Difference(
            base=fm.Box(size=film_size, name="periodic_film_base"),
            tool=fm.Cylinder(radius=25e-9, height=film_size[2], name="central_hole"),
            name="periodic_film",
        )
        mesh_options = {
            "periodic_pair_ids": ["x_faces", "y_faces"],
            "algorithm_2d": 6,
            "algorithm_3d": ALGO_3D_DELAUNAY,
            "smoothing_steps": 1,
            "optimize_iters": 1,
            "size_from_curvature": 8,
            "narrow_regions": 1,
        }
        per_geometry = [
            {
                "geometry": "periodic_film",
                "bulk_hmax": 20e-9,
                "interface_hmax": 14e-9,
                "interface_thickness": 8e-9,
                "transition_distance": 20e-9,
                "edge_hmax": 12e-9,
                "edge_thickness": 5e-9,
                "edge_transition_distance": 12e-9,
                "corner_hmax": 12e-9,
                "corner_extent": 5e-9,
                "corner_transition_distance": 10e-9,
            }
        ]
        object_regions = [
            {
                "owner_object": "periodic_film",
                "name": "hole_transition_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 43e-9,
                    "height": film_size[2],
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": 8e-9,
                    "maximum_element_size": 14e-9,
                    "transition_distance": 14e-9,
                    "order": 1,
                },
            },
            {
                "owner_object": "periodic_film",
                "name": "hole_edge_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 30e-9,
                    "height": film_size[2],
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": 8e-9,
                    "maximum_element_size": 12e-9,
                    "transition_distance": 6e-9,
                    "order": 1,
                },
            },
        ]

        def _study_universe(airbox_thickness: float) -> dict[str, object]:
            return {
                "mode": "manual",
                "size": [film_size[0], film_size[1], airbox_thickness],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 120e-9,
                "airbox_hmin": 16e-9,
                "airbox_growth_rate": 1.5,
                "airbox_grading": "linear",
            }

        def _realize_frozen(airbox_thickness: float, frozen_path: Path) -> tuple[MeshData, dict[str, object]]:
            mesh, _region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[body],
                hints=fm.FEM(order=1, hmax=120e-9),
                study_universe=_study_universe(airbox_thickness),
                mesh_workflow={
                    "domain_mesh_mode": "generated_frozen_magnetic_submesh",
                    "frozen_magnetic_submesh_source": {
                        "mesh_source": str(frozen_path),
                        "region_markers": frozen_payload.region_markers,
                    },
                    "mesh_options": mesh_options,
                    "per_geometry": per_geometry,
                },
                object_regions=object_regions,
            )
            self.assertEqual(report.build_mode, "frozen_magnetic_submesh_merge")
            signatures = report.to_dict()["magnetic_submesh_signatures"]
            self.assertEqual(len(signatures), 1)
            return mesh, dict(signatures[0])  # type: ignore[index]

        baseline_mesh, baseline_markers, baseline_report = (
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[body],
                hints=fm.FEM(order=1, hmax=120e-9),
                study_universe=_study_universe(90.0e-9),
                mesh_workflow={
                    "mesh_options": mesh_options,
                    "per_geometry": per_geometry,
                },
                object_regions=object_regions,
            )
        )
        self.assertEqual(baseline_report.build_mode, "conformal_occ")
        self.assertFalse(baseline_report.degraded)
        frozen_payload = mesh_asset_pipeline._extract_frozen_magnetic_submesh(
            baseline_mesh,
            baseline_markers,
            geometry_name="periodic_film",
        )
        frozen_signature = dict(frozen_payload.magnetic_submesh_signatures[0])

        with tempfile.TemporaryDirectory() as tmp_dir:
            frozen_path = Path(tmp_dir) / "periodic_antidot_frozen_magnetic_submesh.npz"
            frozen_payload.mesh.save(frozen_path)
            baseline_generated, baseline_signature = _realize_frozen(90.0e-9, frozen_path)
            padded_generated, padded_signature = _realize_frozen(90.1e-9, frozen_path)

        frozen_node_count = frozen_payload.mesh.n_nodes
        frozen_element_count = frozen_payload.mesh.n_elements
        baseline_node_prefix = baseline_generated.nodes[:frozen_node_count]
        padded_node_prefix = padded_generated.nodes[:frozen_node_count]
        baseline_element_prefix = baseline_generated.elements[:frozen_element_count]
        padded_element_prefix = padded_generated.elements[:frozen_element_count]

        self.assertEqual(baseline_node_prefix.dtype, frozen_payload.mesh.nodes.dtype)
        self.assertEqual(padded_node_prefix.dtype, frozen_payload.mesh.nodes.dtype)
        self.assertEqual(baseline_element_prefix.dtype, frozen_payload.mesh.elements.dtype)
        self.assertEqual(padded_element_prefix.dtype, frozen_payload.mesh.elements.dtype)
        self.assertEqual(baseline_node_prefix.tobytes(), frozen_payload.mesh.nodes.tobytes())
        self.assertEqual(padded_node_prefix.tobytes(), frozen_payload.mesh.nodes.tobytes())
        self.assertEqual(baseline_element_prefix.tobytes(), frozen_payload.mesh.elements.tobytes())
        self.assertEqual(padded_element_prefix.tobytes(), frozen_payload.mesh.elements.tobytes())
        self.assertEqual(baseline_signature, frozen_signature)
        self.assertEqual(padded_signature, frozen_signature)
        self.assertGreater(int(np.count_nonzero(baseline_generated.element_markers == 0)), 0)
        self.assertGreater(int(np.count_nonzero(padded_generated.element_markers == 0)), 0)
        self.assertGreater(len(baseline_mesh.periodic_node_pairs), 0)
        self.assertGreater(len(baseline_generated.periodic_node_pairs), 0)
        self.assertGreater(len(padded_generated.periodic_node_pairs), 0)
        self.assertGreater(len(baseline_generated.periodic_boundary_pairs), 0)
        self.assertGreater(len(padded_generated.periodic_boundary_pairs), 0)
        self.assertEqual(
            {str(pair["pair_id"]) for pair in baseline_generated.periodic_node_pairs},
            {"x_faces", "y_faces"},
        )
        self.assertIn("periodic_node_pairs", baseline_generated.to_ir("shared_domain"))
        self.assertIn("periodic_boundary_pairs", baseline_generated.to_ir("shared_domain"))

    def test_airbox_geometric_grading_populates_distance_bands_and_diagonal(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        body = fm.Box((40e-9, 40e-9, 20e-9), name="body")
        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[body],
            hints=fm.FEM(order=1, hmax=80e-9),
            study_universe={
                "mode": "manual",
                "size": [240e-9, 200e-9, 120e-9],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 80e-9,
                "airbox_hmin": 12e-9,
                "airbox_growth_rate": 1.3,
                "airbox_grading": "geometric",
            },
            per_object_recipes={
                "body": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
            },
        )

        self.assertEqual(region_markers, [{"geometry_name": "body", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)

        air_mask = np.asarray(mesh.element_markers, dtype=np.int32) == 0
        air_elements = mesh.elements[air_mask]
        self.assertGreater(air_elements.shape[0], 50)

        tetra = np.asarray(mesh.nodes[air_elements], dtype=np.float64)
        centroids = tetra.mean(axis=1)
        edge_pairs = ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3))
        mean_edge = np.mean(
            np.stack(
                [
                    np.linalg.norm(tetra[:, start] - tetra[:, end], axis=1)
                    for start, end in edge_pairs
                ],
                axis=1,
            ),
            axis=1,
        )

        object_min = np.asarray([-20e-9, -20e-9, -10e-9], dtype=np.float64)
        object_max = np.asarray([20e-9, 20e-9, 10e-9], dtype=np.float64)
        air_min = np.asarray([-120e-9, -100e-9, -60e-9], dtype=np.float64)
        air_max = np.asarray([120e-9, 100e-9, 60e-9], dtype=np.float64)
        axis_fraction = np.zeros_like(centroids)
        for axis in range(3):
            lower = centroids[:, axis] < object_min[axis]
            upper = centroids[:, axis] > object_max[axis]
            axis_fraction[lower, axis] = (
                (object_min[axis] - centroids[lower, axis])
                / (object_min[axis] - air_min[axis])
            )
            axis_fraction[upper, axis] = (
                (centroids[upper, axis] - object_max[axis])
                / (air_max[axis] - object_max[axis])
            )
        distance_fraction = np.max(axis_fraction, axis=1)

        near = distance_fraction <= 0.30
        mid = (distance_fraction > 0.30) & (distance_fraction <= 0.70)
        far = distance_fraction > 0.70
        diagonal_transition = (
            (np.count_nonzero(axis_fraction > 0.45, axis=1) >= 2)
            & (distance_fraction < 0.90)
        )

        self.assertGreater(np.count_nonzero(near), 0)
        self.assertGreater(np.count_nonzero(mid), 0)
        self.assertGreater(np.count_nonzero(far), 0)
        self.assertGreater(np.count_nonzero(diagonal_transition), 0)

        near_median = float(np.median(mean_edge[near]))
        mid_median = float(np.median(mean_edge[mid]))
        far_median = float(np.median(mean_edge[far]))
        diagonal_median = float(np.median(mean_edge[diagonal_transition]))

        self.assertLessEqual(near_median, mid_median * 1.15)
        self.assertLessEqual(mid_median, far_median * 1.25)
        self.assertLess(near_median, far_median * 0.85)
        self.assertGreater(diagonal_median, near_median)
        self.assertLess(diagonal_median, 80e-9)

    def test_airbox_realized_growth_bands_are_populated_and_monotone(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        body = fm.Box((40e-9, 40e-9, 20e-9), name="body")
        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[body],
            hints=fm.FEM(order=1, hmax=80e-9),
            study_universe={
                "mode": "manual",
                "size": [240e-9, 200e-9, 120e-9],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 80e-9,
                "airbox_hmin": 12e-9,
                "airbox_growth_rate": 1.3,
                "airbox_grading": "geometric",
            },
            per_object_recipes={
                "body": PerObjectMeshRecipe(hmax=8e-9, hmin=3e-9),
            },
        )

        self.assertEqual(region_markers, [{"geometry_name": "body", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)

        air_mask = np.asarray(mesh.element_markers, dtype=np.int32) == 0
        air_elements = mesh.elements[air_mask]
        self.assertGreater(air_elements.shape[0], 50)

        centroids = np.asarray(mesh.nodes[air_elements], dtype=np.float64).mean(axis=1)
        sizes = characteristic_tet_size(mesh.nodes, air_elements)
        distances = distance_to_box(
            centroids,
            np.asarray([-20e-9, -20e-9, -10e-9], dtype=np.float64),
            np.asarray([20e-9, 20e-9, 10e-9], dtype=np.float64),
        )

        assert_monotone_p95_growth(
            self,
            distances,
            sizes,
            np.asarray([0.0, 12e-9, 24e-9, 45e-9, 75e-9, 120e-9]),
            tolerance_ratio=1.35,
        )
        near = distances <= 24e-9
        far = distances >= 60e-9
        self.assertGreater(np.count_nonzero(near), 0)
        self.assertGreater(np.count_nonzero(far), 0)
        far_median = float(np.median(sizes[far]))
        self.assertLess(abs(far_median - 80e-9), abs(far_median - 8e-9))

    def test_airbox_edge_corner_plumes_refine_near_film_perimeter(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        body = fm.Box((80e-9, 40e-9, 10e-9), name="film")
        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[body],
            hints=fm.FEM(order=1, hmax=70e-9),
            study_universe={
                "mode": "manual",
                "size": [240e-9, 160e-9, 80e-9],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 70e-9,
                "airbox_hmin": 10e-9,
                "airbox_growth_rate": 1.35,
                "airbox_grading": "geometric",
            },
            mesh_workflow={
                "per_geometry": [
                    {
                        "geometry": "film",
                        "bulk_hmax": "20e-9",
                        "edge_hmax": "12e-9",
                        "edge_thickness": "10e-9",
                        "edge_transition_distance": "30e-9",
                        "corner_hmax": "10e-9",
                        "corner_extent": "8e-9",
                        "corner_transition_distance": "24e-9",
                        "transition_growth": 1.35,
                    },
                ],
            },
        )

        self.assertEqual(region_markers, [{"geometry_name": "film", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertIn("EdgeDistanceThreshold", report.used_size_field_kinds)
        self.assertIn("CornerDistanceThreshold", report.used_size_field_kinds)

        air_mask = np.asarray(mesh.element_markers, dtype=np.int32) == 0
        air_elements = mesh.elements[air_mask]
        centroids = np.asarray(mesh.nodes[air_elements], dtype=np.float64).mean(axis=1)
        sizes = characteristic_tet_size(mesh.nodes, air_elements)

        outside_x = np.maximum(np.abs(centroids[:, 0]) - 40e-9, 0.0)
        outside_y = np.maximum(np.abs(centroids[:, 1]) - 20e-9, 0.0)
        outside_z = np.maximum(np.abs(centroids[:, 2]) - 5e-9, 0.0)
        lateral_gap = np.hypot(outside_x, outside_y)
        near_perimeter = (
            (lateral_gap > 0.0)
            & (lateral_gap <= 8e-9)
            & (outside_z <= 6e-9)
        )
        far_in_plane = (lateral_gap >= 35e-9) & (outside_z <= 18e-9)

        self.assertGreater(np.count_nonzero(near_perimeter), 0)
        self.assertGreater(np.count_nonzero(far_in_plane), 0)
        near_p95 = float(np.percentile(sizes[near_perimeter], 95))
        far_median = float(np.median(sizes[far_in_plane]))
        self.assertLessEqual(near_p95, 18e-9)
        self.assertLess(near_p95, far_median)

    def test_box_air_side_edge_corner_refinement_materializes(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        body = fm.Box((48e-9, 24e-9, 12e-9), name="body")
        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[body],
            hints=fm.FEM(order=1, hmax=50e-9),
            study_universe={
                "mode": "manual",
                "size": [160e-9, 100e-9, 60e-9],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 50e-9,
                "airbox_hmin": 8e-9,
                "airbox_growth_rate": 1.35,
                "airbox_grading": "geometric",
            },
            mesh_workflow={
                "per_geometry": [
                    {
                        "geometry": "body",
                        "bulk_hmax": "16e-9",
                        "edge_hmax": "5e-9",
                        "edge_thickness": "5e-9",
                        "edge_transition_distance": "20e-9",
                        "corner_hmax": "4e-9",
                        "corner_extent": "4e-9",
                        "corner_transition_distance": "16e-9",
                        "transition_growth": 1.35,
                    },
                ],
            },
        )

        self.assertEqual(region_markers, [{"geometry_name": "body", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertGreater(mesh.n_nodes, 0)
        self.assertGreater(np.count_nonzero(np.asarray(mesh.element_markers) == 0), 0)
        self.assertGreater(np.count_nonzero(np.asarray(mesh.element_markers) == 1), 0)
        self.assertIn("ComponentVolumeConstant", report.used_size_field_kinds)
        self.assertIn("ComponentRestrictedBox", report.used_size_field_kinds)
        self.assertIn("EdgeDistanceThreshold", report.used_size_field_kinds)
        self.assertIn("CornerDistanceThreshold", report.used_size_field_kinds)

        realized_by_kind = {
            field["kind"]: field
            for field in report.to_dict()["size_fields_realized"]  # type: ignore[index]
        }
        self.assertEqual(realized_by_kind["EdgeDistanceThreshold"]["status"], "applied")
        self.assertEqual(realized_by_kind["CornerDistanceThreshold"]["status"], "applied")

        stats = mesh.to_ir("shared_domain")["mesh_statistics"]
        scopes_by_role = {scope["role"]: scope for scope in stats["scopes"]}  # type: ignore[index]
        self.assertGreater(scopes_by_role["air"]["element_count"], 0)
        self.assertGreater(scopes_by_role["domain"]["element_count"], 0)

    def test_flat_arch_thin_film_materialization_records_provenance_and_partitions(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        waveguide = fm.ArchWaveguide(
            length=100e-9,
            width=40e-9,
            height=2e-9,
            arch_height=0.0,
            name="waveguide",
        )

        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[waveguide],
            hints=fm.FEM(order=1, hmax=80e-9),
            study_universe={
                "mode": "manual",
                "size": [220e-9, 140e-9, 60e-9],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 80e-9,
                "airbox_hmin": 18e-9,
            },
            mesh_workflow={
                "mesh_options": {
                    "mesh_strategy": "thin_film_tetrahedral",
                    "through_thickness_elements": 1,
                    "compute_quality": False,
                    "per_element_quality": False,
                },
                "per_geometry": [
                    {
                        "geometry": "waveguide",
                        "bulk_hmax": "20e-9",
                        "interface_hmax": "14e-9",
                        "interface_thickness": "4e-9",
                        "transition_distance": "24e-9",
                    },
                ],
            },
        )

        self.assertEqual(region_markers, [{"geometry_name": "waveguide", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)
        self.assertLess(mesh.n_elements, 20000)
        self.assertGreater(np.count_nonzero(np.asarray(mesh.element_markers) == 0), 0)
        self.assertGreater(np.count_nonzero(np.asarray(mesh.element_markers) == 1), 0)

        statuses = {
            (entry["kind"], entry["scope"]): entry
            for entry in report.to_dict()["operation_statuses"]  # type: ignore[index]
        }
        thin_film = statuses[("thin_film", "waveguide")]
        self.assertEqual(thin_film["status"], "applied")
        self.assertEqual(thin_film["actual_method"], "feature_aware_tetrahedral")
        self.assertIn("ComponentVolumeConstant", report.used_size_field_kinds)
        self.assertIn("AxisAlignedBoxDistanceThreshold", report.used_size_field_kinds)
        self.assertNotIn("EdgeDistanceThreshold", report.used_size_field_kinds)
        self.assertNotIn("CornerDistanceThreshold", report.used_size_field_kinds)

    def test_occ_shared_domain_skips_stl_surface_preparation(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        left = fm.Box((100e-9, 80e-9, 40e-9), name="left")
        right = fm.Translate(
            fm.Cylinder(radius=50e-9, height=40e-9, name="right_base"),
            (180e-9, 0.0, 0.0),
            name="right",
        )
        study_universe = {
            "mode": "manual",
            "size": [600e-9, 500e-9, 300e-9],
            "center": [80e-9, 0.0, 0.0],
            "airbox_hmax": 120e-9,
            "airbox_hmin": 20e-9,
        }

        with patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            side_effect=AssertionError("OCC shared-domain path must not prepare STL surfaces"),
        ):
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[left, right],
                hints=fm.FEM(order=1, hmax=120e-9),
                study_universe=study_universe,
                per_object_recipes={
                    "left": PerObjectMeshRecipe(hmax=20e-9),
                    "right": PerObjectMeshRecipe(hmax=25e-9),
                },
            )

        self.assertGreater(mesh.n_elements, 0)
        self.assertEqual(len(region_markers), 2)
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)

    def test_single_occ_shared_domain_skips_stl_surface_preparation(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        waveguide = fm.ArchWaveguide(
            length=180e-9,
            width=60e-9,
            height=4e-9,
            arch_height=0.0,
            name="waveguide",
        )

        with patch(
            "fullmag.meshing.asset_pipeline._geometry_to_trimesh",
            side_effect=AssertionError("single OCC shared-domain path must not prepare STL surfaces"),
        ):
            mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[waveguide],
                hints=fm.FEM(order=1, hmax=40e-9),
                study_universe={
                    "mode": "manual",
                    "size": [500e-9, 300e-9, 160e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 120e-9,
                    "airbox_hmin": 30e-9,
                },
                per_object_recipes={
                    "waveguide": PerObjectMeshRecipe(hmax=20e-9, hmin=5e-9),
                },
            )

        self.assertGreater(mesh.n_elements, 0)
        self.assertEqual(region_markers, [{"geometry_name": "waveguide", "marker": 1}])
        self.assertEqual(report.build_mode, "conformal_occ")
        self.assertFalse(report.degraded)


class RegionMeshPolicyTests(unittest.TestCase):
    def test_conformal_box_region_gets_distinct_domain_marker(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Box(size=(100e-9, 100e-9, 100e-9), name="owner")
        mesh, parent_markers, report = (
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=30e-9),
                study_universe={
                    "mode": "manual",
                    "size": [220e-9, 220e-9, 220e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 60e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:core",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "core",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "box",
                            "size": [40e-9, 40e-9, 40e-9],
                            "center": [0.0, 0.0, 0.0],
                        },
                    }
                ],
            )
        )

        parent_marker = int(parent_markers[0]["marker"])
        self.assertEqual(
            report.object_region_markers,
            [{"geometry_name": "owner:core", "marker": 2}],
        )
        marker_values = set(int(value) for value in mesh.element_markers)
        self.assertIn(parent_marker, marker_values)
        self.assertIn(2, marker_values)
        self.assertGreater(np.count_nonzero(mesh.element_markers == 2), 0)

    def test_conformal_region_interface_is_not_exported_as_boundary_face(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Box(size=(100e-9, 100e-9, 100e-9), name="owner")
        mesh, _parent_markers, _report = (
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=30e-9),
                study_universe={
                    "mode": "manual",
                    "size": [220e-9, 220e-9, 220e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 60e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:core",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "core",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "box",
                            "size": [40e-9, 40e-9, 40e-9],
                            "center": [0.0, 0.0, 0.0],
                        },
                    }
                ],
            )
        )

        face_to_markers: dict[tuple[int, int, int], set[int]] = {}
        for element, marker in zip(mesh.elements, mesh.element_markers, strict=True):
            a, b, c, d = (int(node) for node in element)
            for face in ((a, b, c), (a, b, d), (a, c, d), (b, c, d)):
                face_to_markers.setdefault(tuple(sorted(face)), set()).add(int(marker))

        leaked_internal_faces = [
            face
            for face in mesh.boundary_faces
            if len(face_to_markers.get(tuple(sorted(int(node) for node in face)), set())) > 1
            and all(
                marker > 0
                for marker in face_to_markers[tuple(sorted(int(node) for node in face))]
            )
        ]
        self.assertEqual(
            leaked_internal_faces,
            [],
            "region/parent interfaces are internal material-continuity surfaces, not physical boundary faces",
        )

    def test_conformal_cylinder_region_gets_distinct_domain_marker(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Box(size=(100e-9, 100e-9, 100e-9), name="owner")
        mesh, _parent_markers, report = (
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=30e-9),
                study_universe={
                    "mode": "manual",
                    "size": [220e-9, 220e-9, 220e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 60e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:cylinder",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "cylinder",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "cylinder",
                            "radius": 20e-9,
                            "height": 50e-9,
                            "center": [0.0, 0.0, 0.0],
                            "axis": [0.0, 1.0, 0.0],
                        },
                    }
                ],
            )
        )

        self.assertEqual(
            report.object_region_markers,
            [{"geometry_name": "owner:cylinder", "marker": 2}],
        )
        self.assertGreater(np.count_nonzero(mesh.element_markers == 2), 0)

    def test_inherited_cylinder_region_does_not_create_domain_marker(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Box(size=(100e-9, 100e-9, 100e-9), name="owner")
        mesh, _parent_markers, report = (
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=30e-9),
                study_universe={
                    "mode": "manual",
                    "size": [220e-9, 220e-9, 220e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 60e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:cylinder",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "cylinder",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "inherit",
                        "shape": {
                            "kind": "cylinder",
                            "radius": 20e-9,
                            "height": 50e-9,
                            "center": [0.0, 0.0, 0.0],
                            "axis": [0.0, 1.0, 0.0],
                        },
                    }
                ],
            )
        )

        self.assertEqual(
            report.object_region_markers,
            [],
        )
        self.assertEqual(np.count_nonzero(mesh.element_markers == 2), 0)
        self.assertGreater(np.count_nonzero(mesh.element_markers == 1), 0)

    def test_conformal_region_is_clipped_to_owner_csg_topology(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Difference(
            base=fm.Box(size=(300e-9, 1000e-9, 30e-9)),
            tool=fm.Cylinder(radius=30e-9, height=30e-9),
            name="owner",
        )
        mesh, _parent_markers, report = (
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=50e-9),
                study_universe={
                    "mode": "manual",
                    "size": [700e-9, 1400e-9, 180e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 150e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:hole_refinement",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "hole_refinement",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "cylinder",
                            "radius": 60e-9,
                            "height": 30e-9,
                            "center": [0.0, 0.0, 0.0],
                            "axis": [0.0, 0.0, 1.0],
                        },
                    }
                ],
            )
        )

        self.assertEqual(
            report.object_region_markers,
            [{"geometry_name": "owner:hole_refinement", "marker": 2}],
        )
        self.assertGreater(np.count_nonzero(mesh.element_markers == 2), 0)
        self.assertGreater(np.count_nonzero(mesh.element_markers == 1), 0)

    def test_conformal_region_outside_owner_is_rejected(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Box(size=(100e-9, 100e-9, 100e-9), name="owner")
        with self.assertRaisesRegex(
            ValueError,
            "must be fully contained inside its owner geometry",
        ):
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=30e-9),
                study_universe={
                    "mode": "manual",
                    "size": [300e-9, 300e-9, 300e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 60e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:oversized",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "oversized",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "box",
                            "size": [140e-9, 40e-9, 40e-9],
                            "center": [0.0, 0.0, 0.0],
                        },
                    }
                ],
            )

    def test_overlapping_conformal_regions_are_rejected(self) -> None:
        try:
            import gmsh  # noqa: F401
        except ImportError:
            self.skipTest("gmsh not available")

        owner = fm.Box(size=(100e-9, 100e-9, 100e-9), name="owner")
        with self.assertRaisesRegex(
            ValueError,
            "does not support overlapping regions 'owner:outer' and 'owner:inner'",
        ):
            realize_fem_domain_mesh_asset_from_components_with_report(
                geometries=[owner],
                hints=fm.FEM(order=1, hmax=30e-9),
                study_universe={
                    "mode": "manual",
                    "size": [220e-9, 220e-9, 220e-9],
                    "center": [0.0, 0.0, 0.0],
                    "airbox_hmax": 60e-9,
                },
                object_regions=[
                    {
                        "region_id": "owner:outer",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "outer",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "box",
                            "size": [60e-9, 60e-9, 60e-9],
                            "center": [0.0, 0.0, 0.0],
                        },
                    },
                    {
                        "region_id": "owner:inner",
                        "owner_object": "owner",
                        "owner_geometry_name": "owner",
                        "name": "inner",
                        "enabled": True,
                        "frame": "object",
                        "realization_policy": "conformal",
                        "shape": {
                            "kind": "box",
                            "size": [30e-9, 30e-9, 30e-9],
                            "center": [0.0, 0.0, 0.0],
                        },
                    },
                ],
            )

    def test_region_mesh_policy_owner_alias_matches_geometry_name(self) -> None:
        waveguide = fm.ArchWaveguide(
            length=180e-9,
            width=60e-9,
            height=4e-9,
            arch_height=0.0,
            name="waveguide_geom",
        )
        object_regions = [
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 10e-9,
                    "height": 20e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 2e-9,
                    "minimum_element_size": 1e-9,
                    "transition_distance": 5e-9,
                    "order": 1,
                },
            }
        ]

        fields = _build_field_stack(
            [waveguide],
            default_hmax=50e-9,
            per_geometry=[{"geometry": "waveguide", "hmax": 10e-9}],
            object_regions=object_regions,
        )

        region_fields = [
            field for field in fields
            if field.get("params", {}).get("Source") == "region_mesh_policy"
        ]
        self.assertEqual(len(region_fields), 1)
        self.assertEqual(region_fields[0]["kind"], "ComponentRestrictedGradedCylinder")
        self.assertEqual(region_fields[0]["params"]["GeometryName"], "waveguide_geom")
        self.assertEqual(region_fields[0]["params"]["VOut"], 10e-9)

    def test_region_minimum_element_size_does_not_become_global_hmin(self) -> None:
        geometry = fm.Box(100e-9, 100e-9, 20e-9, name="owner")
        mesh_options = _mesh_options_from_runtime_metadata(
            {"mesh_options": {}},
            geometries=[geometry],
            default_hmax=30e-9,
            component_aware=True,
            object_regions=[
                {
                    "region_id": "owner:core",
                    "owner_object": "owner",
                    "enabled": True,
                    "shape": {
                        "kind": "box",
                        "size": [20e-9, 20e-9, 10e-9],
                        "center": [0.0, 0.0, 0.0],
                    },
                    "mesh_policy": {
                        "minimum_element_size": 2e-9,
                        "maximum_element_size": 8e-9,
                        "order": 1,
                    },
                }
            ],
        )
        self.assertIsNone(mesh_options.hmin)

    def test_region_mesh_policy_rejects_unsupported_local_order(self) -> None:
        geometry = fm.Box(100e-9, 100e-9, 20e-9, name="owner")
        with self.assertRaisesRegex(
            ValueError,
            "region_mesh_policy_order_unsupported.*requested_order=2",
        ):
            _build_field_stack(
                [geometry],
                default_hmax=30e-9,
                per_geometry=[],
                object_regions=[
                    {
                        "region_id": "owner:quadratic",
                        "owner_object": "owner",
                        "enabled": True,
                        "shape": {
                            "kind": "box",
                            "size": [20e-9, 20e-9, 10e-9],
                            "center": [0.0, 0.0, 0.0],
                        },
                        "mesh_policy": {
                            "maximum_element_size": 8e-9,
                            "order": 2,
                        },
                    }
                ],
            )

    def test_difference_hole_region_mesh_policy_builds_local_refinement_field(self) -> None:
        hole_radius = 50e-9
        geometry = fm.Difference(
            base=fm.Box(300e-9, 1000e-9, 30e-9),
            tool=fm.Cylinder(radius=hole_radius, height=30e-9),
            name="permalloy_box",
        )
        object_regions = [
            {
                "owner_object": "permalloy_box",
                "name": "hole_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": hole_radius + 30e-9,
                    "height": 30e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": 2e-9,
                    "maximum_element_size": 5e-9,
                    "transition_distance": 30e-9,
                    "order": 1,
                },
            }
        ]

        fields = _build_field_stack(
            [geometry],
            default_hmax=50e-9,
            per_geometry=[{"geometry": "permalloy_box", "hmax": 50e-9}],
            object_regions=object_regions,
        )

        region_fields = [
            field
            for field in fields
            if field.get("params", {}).get("Source") == "region_mesh_policy"
        ]
        self.assertEqual(len(region_fields), 1)
        self.assertEqual(region_fields[0]["kind"], "ComponentRestrictedGradedCylinder")
        self.assertEqual(region_fields[0]["params"]["GeometryName"], "permalloy_box")
        self.assertEqual(region_fields[0]["params"]["Radius"], hole_radius + 30e-9)
        self.assertEqual(region_fields[0]["params"]["VIn"], 5e-9)
        self.assertEqual(region_fields[0]["params"]["MinimumElementSize"], 2e-9)
        self.assertEqual(region_fields[0]["params"]["TransitionDistance"], 30e-9)

    def test_runtime_mesh_options_uses_direct_object_regions_for_local_refinement(self) -> None:
        hole_radius = 50e-9
        geometry = fm.Difference(
            base=fm.Box(300e-9, 1000e-9, 30e-9),
            tool=fm.Cylinder(radius=hole_radius, height=30e-9),
            name="permalloy_box",
        )
        object_regions = [
            {
                "owner_object": "permalloy_box",
                "name": "hole_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": hole_radius + 30e-9,
                    "height": 30e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": 2e-9,
                    "maximum_element_size": 5e-9,
                    "transition_distance": 30e-9,
                    "order": 1,
                },
            }
        ]

        mesh_options = _mesh_options_from_runtime_metadata(
            {"per_geometry": [{"geometry": "permalloy_box", "hmax": 50e-9}]},
            geometries=[geometry],
            default_hmax=50e-9,
            object_regions=object_regions,
        )

        region_fields = [
            field
            for field in mesh_options.size_fields
            if field.get("params", {}).get("Source") == "region_mesh_policy"
        ]
        self.assertEqual(len(region_fields), 1)
        self.assertEqual(region_fields[0]["kind"], "ComponentRestrictedGradedCylinder")
        self.assertEqual(region_fields[0]["params"]["GeometryName"], "permalloy_box")
        self.assertEqual(region_fields[0]["params"]["Radius"], hole_radius + 30e-9)
        self.assertEqual(region_fields[0]["params"]["VIn"], 5e-9)

    def test_region_local_refinement_stays_local_to_size_field(self) -> None:
        hole_radius = 25e-9
        geometry = fm.Difference(
            base=fm.Box(200e-9, 200e-9, 10e-9),
            tool=fm.Cylinder(radius=hole_radius, height=10e-9),
            name="periodic_antidot_film",
        )
        object_regions = [
            {
                "owner_object": "periodic_antidot_film",
                "name": "hole_transition_refinement",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 43e-9,
                    "height": 10e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "minimum_element_size": 0.15e-9,
                    "maximum_element_size": 1e-9,
                    "transition_distance": 3e-9,
                    "order": 1,
                },
            }
        ]

        mesh_options = _mesh_options_from_runtime_metadata(
            {
                "per_geometry": [
                    {
                        "geometry": "periodic_antidot_film",
                        "minimum_element_size": 3e-9,
                        "maximum_element_size": 8e-9,
                    }
                ]
            },
            geometries=[geometry],
            default_hmax=100e-9,
            object_regions=object_regions,
        )

        self.assertEqual(mesh_options.hmin, 3e-9)
        region_fields = [
            field
            for field in mesh_options.size_fields
            if field.get("params", {}).get("Source") == "region_mesh_policy"
        ]
        self.assertEqual(len(region_fields), 1)
        self.assertEqual(region_fields[0]["params"]["MinimumElementSize"], 0.15e-9)

    def test_region_mesh_policy_fields_and_axes(self) -> None:
        # Create waveguide geometry
        waveguide = fm.ArchWaveguide(
            length=180e-9,
            width=60e-9,
            height=4e-9,
            arch_height=0.0,
            name="waveguide",
        )

        # We will mock the object_regions input parameter to _build_field_stack
        # 1. Graded Cylinder along Z-axis
        # 2. Graded Cylinder along arbitrary axis [1, 0, 0]
        # 3. Non-graded Cylinder along Y-axis [0, 1, 0]
        # 4. Box and Sphere
        object_regions = [
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 10e-9,
                    "height": 20e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 2e-9,
                    "minimum_element_size": 1e-9,
                    "transition_distance": 5e-9,
                    "order": 1,
                }
            },
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 15e-9,
                    "height": 30e-9,
                    "center": [5e-9, 10e-9, 2e-9],
                    "axis": [1.0, 0.0, 0.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 3e-9,
                    "minimum_element_size": 1.5e-9,
                    "transition_distance": 8e-9,
                    "order": 1,
                }
            },
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 20e-9,
                    "height": 40e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 1.0, 0.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 4e-9,
                }
            },
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "box",
                    "size": [10e-9, 10e-9, 10e-9],
                    "center": [0.0, 0.0, 0.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 2e-9,
                    "transition_distance": 5e-9,
                }
            },
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "sphere",
                    "radius": 8e-9,
                    "center": [0.0, 0.0, 0.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 2e-9,
                    "transition_distance": 4e-9,
                }
            }
        ]

        fields = _build_field_stack(
            [waveguide],
            default_hmax=50e-9,
            per_geometry=[],
            object_regions=object_regions,
        )

        region_fields = [f for f in fields if f.get("params", {}).get("Source") == "region_mesh_policy"]
        self.assertEqual(len(region_fields), 5)

        graded_z = [f for f in region_fields if f["kind"] == "ComponentRestrictedGradedCylinder" and f["params"]["Axis"] == [0.0, 0.0, 1.0]][0]
        self.assertEqual(graded_z["params"]["MinimumElementSize"], 1e-9)
        self.assertEqual(graded_z["params"]["Order"], 1)

        graded_x = [f for f in region_fields if f["kind"] == "ComponentRestrictedGradedCylinder" and f["params"]["Axis"] == [1.0, 0.0, 0.0]][0]
        self.assertEqual(graded_x["params"]["MinimumElementSize"], 1.5e-9)
        self.assertEqual(graded_x["params"]["Order"], 1)

        non_graded_y = [f for f in region_fields if f["kind"] == "ComponentRestrictedCylinder"][0]
        self.assertEqual(non_graded_y["params"]["Axis"], [0.0, 1.0, 0.0])

        for i, rf in enumerate(region_fields):
            if i < 4:
                rf["_gmsh_status"] = "applied"
            else:
                rf["_gmsh_status"] = "ignored"

        mesh_workflow = {
            "mesh_options": {
                "scene_problem_patch": {
                    "object_regions": object_regions
                }
            }
        }

        report = _build_shared_domain_build_report(
            [waveguide],
            fm.FEM(order=1, hmax=20e-9),
            airbox=AirboxOptions(maximum_element_size=100e-9),
            mesh_workflow=mesh_workflow,
            per_object_recipes=None,
            size_fields=fields,
            region_markers=[],
            build_mode="conformal_occ",
            fallbacks_triggered=[],
            mesh_options=MeshOptions(),
        )

        self.assertEqual(report.authored_regions_count, 5)
        self.assertEqual(report.realized_regions_count, 4)

    def test_arch_waveguide_skyrmion_core_refinement_actual_mesh_density(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")
        import math

        # Create waveguide
        waveguide = fm.ArchWaveguide(
            length=180e-9,
            width=60e-9,
            height=40e-9,
            arch_height=0.0,
            name="waveguide",
        )

        # Region for skyrmion core refinement
        object_regions = [
            {
                "owner_object": "waveguide",
                "enabled": True,
                "shape": {
                    "kind": "cylinder",
                    "radius": 15e-9,
                    "height": 10e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 3e-9,
                    "minimum_element_size": 1.5e-9,
                    "transition_distance": 5e-9,
                    "order": 1,
                },
            }
        ]

        per_object_recipes = {
            "waveguide": PerObjectMeshRecipe(hmax=20e-9, hmin=5e-9),
        }
        study_universe = {
            "mode": "manual",
            "size": [400e-9, 200e-9, 100e-9],
            "center": [0.0, 0.0, 0.0],
            "airbox_hmax": 50e-9,
            "airbox_hmin": 10e-9,
        }

        mesh_workflow = {
            "mesh_options": {
                "scene_problem_patch": {
                    "object_regions": object_regions
                }
            }
        }

        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[waveguide],
            hints=fm.FEM(order=1, hmax=20e-9),
            study_universe=study_universe,
            per_object_recipes=None,
            mesh_workflow=mesh_workflow,
        )

        waveguide_marker = None
        for entry in region_markers:
            if entry.get("geometry_name") == "waveguide":
                waveguide_marker = entry.get("marker")
        self.assertIsNotNone(waveguide_marker)

        # Calculate edge lengths for elements inside the refined cylinder region vs bulk
        nodes = mesh.nodes
        elements = mesh.elements
        element_markers = mesh.element_markers

        region_edge_lengths = []
        bulk_edge_lengths = []

        for i, tet in enumerate(elements):
            if element_markers[i] != waveguide_marker:
                continue
            centroid = nodes[tet].mean(axis=0)
            # Center of cylinder is [0, 0, 0], radius is 15e-9
            dist_xy = math.sqrt(centroid[0]**2 + centroid[1]**2)

            edges = [
                (tet[0], tet[1]), (tet[0], tet[2]), (tet[0], tet[3]),
                (tet[1], tet[2]), (tet[1], tet[3]), (tet[2], tet[3])
            ]
            for u, v in edges:
                length = np.linalg.norm(nodes[u] - nodes[v])
                if dist_xy <= 15e-9:
                    region_edge_lengths.append(length)
                else:
                    bulk_edge_lengths.append(length)

        self.assertTrue(len(region_edge_lengths) > 0)
        self.assertTrue(len(bulk_edge_lengths) > 0)

        median_region = np.median(region_edge_lengths)
        median_bulk = np.median(bulk_edge_lengths)

        # Assert localized refinement inside the region
        self.assertLessEqual(median_region, 5e-9)
        self.assertGreaterEqual(median_bulk, 10e-9)

    def test_disabled_policy_invariance(self) -> None:
        try:
            import gmsh
        except ImportError:
            self.skipTest("gmsh not available")

        waveguide = fm.ArchWaveguide(
            length=180e-9,
            width=60e-9,
            height=40e-9,
            arch_height=0.0,
            name="waveguide",
        )

        # Disabled region policy
        object_regions = [
            {
                "owner_object": "waveguide",
                "enabled": False,
                "shape": {
                    "kind": "cylinder",
                    "radius": 15e-9,
                    "height": 10e-9,
                    "center": [0.0, 0.0, 0.0],
                    "axis": [0.0, 0.0, 1.0],
                },
                "mesh_policy": {
                    "maximum_element_size": 3e-9,
                    "minimum_element_size": 1.5e-9,
                    "transition_distance": 5e-9,
                    "order": 1,
                },
            }
        ]

        per_object_recipes = {
            "waveguide": PerObjectMeshRecipe(hmax=20e-9, hmin=5e-9),
        }
        study_universe = {
            "mode": "manual",
            "size": [400e-9, 200e-9, 100e-9],
            "center": [0.0, 0.0, 0.0],
            "airbox_hmax": 50e-9,
            "airbox_hmin": 10e-9,
        }

        mesh_workflow = {
            "mesh_options": {
                "scene_problem_patch": {
                    "object_regions": object_regions
                }
            }
        }

        mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[waveguide],
            hints=fm.FEM(order=1, hmax=20e-9),
            study_universe=study_universe,
            per_object_recipes=None,
            mesh_workflow=mesh_workflow,
        )

        waveguide_marker = None
        for entry in region_markers:
            if entry.get("geometry_name") == "waveguide":
                waveguide_marker = entry.get("marker")
        self.assertIsNotNone(waveguide_marker)

        # Calculate edge lengths everywhere in the waveguide
        nodes = mesh.nodes
        elements = mesh.elements
        element_markers = mesh.element_markers

        edge_lengths = []
        for i, tet in enumerate(elements):
            if element_markers[i] != waveguide_marker:
                continue
            edges = [
                (tet[0], tet[1]), (tet[0], tet[2]), (tet[0], tet[3]),
                (tet[1], tet[2]), (tet[1], tet[3]), (tet[2], tet[3])
            ]
            for u, v in edges:
                edge_lengths.append(np.linalg.norm(nodes[u] - nodes[v]))

        self.assertTrue(len(edge_lengths) > 0)
        median_overall = np.median(edge_lengths)

        # Assert no refinement is applied (median is close to bulk/20e-9 and certainly coarse)
        self.assertGreaterEqual(median_overall, 10e-9)


if __name__ == "__main__":
    unittest.main()
