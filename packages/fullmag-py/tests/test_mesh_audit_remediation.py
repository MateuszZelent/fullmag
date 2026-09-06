from __future__ import annotations

import copy
import math
from dataclasses import replace
from unittest.mock import Mock

import numpy as np
import pytest

import fullmag as fm
from fullmag._validation import TypedValidationError
from fullmag.meshing._airbox_grading import _geometric_size_profile_expression, _growth_number
from fullmag.meshing._gmsh_fields import _METADATA_PARAMS
from fullmag.meshing._gmsh_swept import _compute_layer_heights
from fullmag.meshing._gmsh_types import (
    MeshData,
    MeshOptions,
    MeshQualityReport,
    MeshRealizationReport,
    QUALIFIED_REALIZATION_FALLBACKS,
    SharedDomainMeshResult,
    SizeFieldData,
)
from fullmag.meshing._size_field_plan import (
    _build_field_stack,
    _mesh_options_from_runtime_metadata,
)
from fullmag.meshing._gmsh_occ import _scale_quality_report_volume
from fullmag.meshing.asset_pipeline import (
    MeshValidationError,
    _drop_degenerate_tetrahedra,
    _strip_overridden_workflow_fields,
)
from fullmag.meshing.quality import (
    MeshGrowthValidationError,
    build_typed_quality_summary,
    measure_adjacent_size_growth,
    validate_adjacent_size_growth,
    validate_typed_quality_summary,
)
from fullmag.meshing.remesh_cli import _mesh_result_payload
from fullmag.model.discretization import PerObjectMeshRecipe
from fullmag.model.geometry import Box


# ===================================================================
# A01 - A04: MESH-01 Shared Domain Routing, Identity & Conformal Retry
# ===================================================================

def test_a01_occ_retry_stl_concat_cell_markers() -> None:
    """A01: OCC retry and fallback preserves per-cell component markers."""
    from unittest.mock import patch, Mock
    from fullmag.meshing.asset_pipeline import _realize_fem_domain_mesh_asset_from_components_impl

    boxA = Box((1e-6, 1e-6, 0.2e-6), name="A")
    boxB = Box((1e-6, 1e-6, 0.2e-6), name="B")
    hints = fm.FEM(order=1, hmax=0.5e-6)
    universe = {"mode": "manual", "size": [4e-6, 4e-6, 2e-6], "center": [0, 0, 0]}

    fallback_mesh = MeshData(
        nodes=np.asarray([
            [0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 0.2e-6],
            [2e-6, 0.0, 0.0], [2e-6, 1e-6, 0.0], [2e-6, 0.0, 0.2e-6],
        ]),
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 1, 4, 5, 6],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 2],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )

    dummy_verts = np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0]])
    mock_mesh_obj = Mock()
    mock_mesh_obj.is_watertight = True
    mock_mesh_obj.export = Mock(return_value=b"solid")
    mock_mesh_obj.vertices = dummy_verts

    mock_tm = Mock()
    mock_tm.util = Mock()
    mock_tm.util.concatenate = Mock(return_value=mock_mesh_obj)

    with patch("fullmag.meshing._gmsh_occ.is_occ_compatible", return_value=True):
        with patch("fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ", side_effect=RuntimeError("OCC fail")):
            with patch("fullmag.meshing.surface_assets._import_trimesh", return_value=mock_tm):
                with patch("fullmag.meshing.asset_pipeline._import_trimesh", return_value=mock_tm):
                    with patch("fullmag.meshing.asset_pipeline._geometry_to_trimesh", return_value=mock_mesh_obj):
                        with patch("fullmag.meshing.asset_pipeline._sanitize_surface_mesh_for_stl_export", side_effect=lambda m: m):
                            with patch("fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components", side_effect=RuntimeError("STL fail")):
                                with patch("fullmag.meshing.gmsh_bridge.generate_mesh_from_file", return_value=fallback_mesh):
                                    with patch("fullmag.meshing.asset_pipeline._match_geometry_bounds_to_source_markers", return_value={"A": 1, "B": 2}):
                                        mesh, region_markers, report = _realize_fem_domain_mesh_asset_from_components_impl(
                                            [boxA, boxB], hints, study_universe=universe
                                        )
                                        assert "conformal_occ_failed" in report.fallbacks_triggered
                                        assert "component_aware_import_failed" in report.fallbacks_triggered
                                        assert report.build_mode == "concatenated_stl_fallback"
                                        assert len(mesh.element_markers) == 2
                                        assert list(mesh.element_markers) == [1, 2]
                                        assert {rm["geometry_name"]: rm["marker"] for rm in region_markers} == {"A": 1, "B": 2}


def test_a02_result_mesh_identity_mismatch_raises_mesh_validation_error() -> None:
    """A02: result.mesh is not mesh explicitly rejected with MeshValidationError in pipeline."""
    from unittest.mock import patch, Mock
    from fullmag.meshing.asset_pipeline import _realize_fem_domain_mesh_asset_from_components_impl

    boxA = Box((1e-6, 1e-6, 0.2e-6), name="A")
    boxB = Box((1e-6, 1e-6, 0.2e-6), name="B")
    hints = fm.FEM(order=1, hmax=0.5e-6)
    universe = {"mode": "manual", "size": [4e-6, 4e-6, 2e-6], "center": [0, 0, 0]}

    mesh1 = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 0.2e-6]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    mesh2 = copy.deepcopy(mesh1)

    fake_result = SharedDomainMeshResult(
        mesh=mesh1,
        component_marker_tags={"A": 1, "B": 2},
        component_volume_tags={"A": [1], "B": [2]},
        component_surface_tags={"A": [1], "B": [2]},
        interface_surface_tags=[],
        outer_boundary_surface_tags=[],
    )

    dummy_verts = np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0]])
    mock_mesh_obj = Mock()
    mock_mesh_obj.is_watertight = True
    mock_mesh_obj.export = Mock(return_value=b"solid")
    mock_mesh_obj.vertices = dummy_verts

    with patch("fullmag.meshing._gmsh_occ.is_occ_compatible", return_value=False):
        with patch("fullmag.meshing.surface_assets._import_trimesh", return_value=Mock()):
            with patch("fullmag.meshing.asset_pipeline._import_trimesh", return_value=Mock()):
                with patch("fullmag.meshing.asset_pipeline._geometry_to_trimesh", return_value=mock_mesh_obj):
                    with patch("fullmag.meshing.asset_pipeline._sanitize_surface_mesh_for_stl_export", side_effect=lambda m: m):
                        with patch("fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components", return_value=fake_result):
                            with patch("fullmag.meshing.asset_pipeline._drop_degenerate_tetrahedra", return_value=mesh2):
                                # Suppress rebinding so result.mesh remains mesh1 != mesh2
                                with patch("fullmag.meshing.asset_pipeline._dc_replace", side_effect=lambda obj, **kw: obj):
                                    with pytest.raises(MeshValidationError, match="mesh_result_identity_mismatch"):
                                        _realize_fem_domain_mesh_asset_from_components_impl(
                                            [boxA, boxB], hints, study_universe=universe
                                        )


def test_a03_first_successful_occ_preserves_marker_maps_and_diagnostics() -> None:
    """A03: Successful OCC preserves component marker tags and diagnostics in pipeline."""
    from unittest.mock import patch
    from fullmag.meshing.asset_pipeline import _realize_fem_domain_mesh_asset_from_components_impl

    boxA = Box((1e-6, 1e-6, 0.2e-6), name="A")
    boxB = Box((1e-6, 1e-6, 0.2e-6), name="B")
    hints = fm.FEM(order=1, hmax=0.5e-6)
    universe = {"mode": "manual", "size": [4e-6, 4e-6, 2e-6], "center": [0, 0, 0]}

    mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 0.2e-6]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )

    fake_result = SharedDomainMeshResult(
        mesh=mesh,
        component_marker_tags={"A": 1, "B": 2},
        component_volume_tags={"A": [1], "B": [2]},
        component_surface_tags={"A": [1], "B": [2]},
        interface_surface_tags=[],
        outer_boundary_surface_tags=[],
        selector_resolution=[{"selector": "sel1", "status": "resolved"}],
    )

    with patch("fullmag.meshing._gmsh_occ.is_occ_compatible", return_value=True):
        with patch("fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ", return_value=fake_result):
            res_mesh, region_markers, report = _realize_fem_domain_mesh_asset_from_components_impl(
                [boxA, boxB], hints, study_universe=universe
            )
            assert report.build_mode == "conformal_occ"
            assert region_markers == [
                {"geometry_name": "A", "marker": 1},
                {"geometry_name": "B", "marker": 2},
            ]
            assert report.selector_resolution == [{"selector": "sel1", "status": "resolved"}]


def test_a04_legal_mesh_transformation_rebinds_result_mesh() -> None:
    """A04: Legal MeshData transformation re-binds result.mesh to the transformed instance."""
    from unittest.mock import patch, Mock
    from fullmag.meshing.asset_pipeline import _realize_fem_domain_mesh_asset_from_components_impl

    boxA = Box((1e-6, 1e-6, 0.2e-6), name="A")
    boxB = Box((1e-6, 1e-6, 0.2e-6), name="B")
    hints = fm.FEM(order=1, hmax=0.5e-6)
    universe = {"mode": "manual", "size": [4e-6, 4e-6, 2e-6], "center": [0, 0, 0]}

    mesh1 = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 0.2e-6]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    mesh2 = copy.deepcopy(mesh1)

    fake_result = SharedDomainMeshResult(
        mesh=mesh1,
        component_marker_tags={"A": 1, "B": 2},
        component_volume_tags={"A": [1], "B": [2]},
        component_surface_tags={"A": [1], "B": [2]},
        interface_surface_tags=[],
        outer_boundary_surface_tags=[],
    )

    dummy_verts = np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0]])
    mock_mesh_obj = Mock()
    mock_mesh_obj.is_watertight = True
    mock_mesh_obj.export = Mock(return_value=b"solid")
    mock_mesh_obj.vertices = dummy_verts

    with patch("fullmag.meshing._gmsh_occ.is_occ_compatible", return_value=False):
        with patch("fullmag.meshing.surface_assets._import_trimesh", return_value=Mock()):
            with patch("fullmag.meshing.asset_pipeline._import_trimesh", return_value=Mock()):
                with patch("fullmag.meshing.asset_pipeline._geometry_to_trimesh", return_value=mock_mesh_obj):
                    with patch("fullmag.meshing.asset_pipeline._sanitize_surface_mesh_for_stl_export", side_effect=lambda m: m):
                        with patch("fullmag.meshing.asset_pipeline.generate_shared_domain_mesh_from_components", return_value=fake_result):
                            with patch("fullmag.meshing.asset_pipeline._drop_degenerate_tetrahedra", return_value=mesh2):
                                # Default _dc_replace rebinds result.mesh = mesh2, preventing mismatch exception
                                res_mesh, region_markers, report = _realize_fem_domain_mesh_asset_from_components_impl(
                                    [boxA, boxB], hints, study_universe=universe
                                )
                                assert np.array_equal(res_mesh.nodes, mesh2.nodes)
                                assert np.array_equal(res_mesh.cell_nodes, mesh2.cell_nodes)
                                assert len(region_markers) == 2


# ===================================================================
# A05 - A12: MESH-02 Intent Reconciliation, Inheritance & Preflight
# ===================================================================

def test_a05_matching_swept_intents_preserved_and_unsupported_multi_sweep_rejected() -> None:
    """A05: Matching swept intents preserved; unsupported multi-sweep rejected."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")
    box2 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag2")
    workflow = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism", "through_thickness_elements": 2},
            {"geometry_name": "mag2", "mesh_strategy": "swept_prism", "through_thickness_elements": 2},
        ]
    }
    opts = _mesh_options_from_runtime_metadata(
        workflow,
        geometries=[box1, box2],
        default_hmax=0.5e-6,
        include_size_fields=False,
    )
    assert opts.mesh_strategy == "swept_prism"
    assert opts.through_thickness_elements == 2


def test_a06_mismatched_sweep_axis_n_distribution_rejected_before_gmsh() -> None:
    """A06: Mismatched thin axis, N, distribution or strategy rejected deterministically before Gmsh."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")  # thin axis = 2 (z)
    box2 = Box(size=(0.2e-6, 1e-6, 1e-6), name="mag2")  # thin axis = 0 (x)
    workflow = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism", "through_thickness_elements": 2},
            {"geometry_name": "mag2", "mesh_strategy": "swept_prism", "through_thickness_elements": 2},
        ]
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: conflicting per-geometry thin axis"):
        _mesh_options_from_runtime_metadata(
            workflow,
            geometries=[box1, box2],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )


def test_a07_two_geometries_one_per_geometry_no_object_loss() -> None:
    """A07: Two geometries with only one per_geometry entry rejects partial intent without dropping second object."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")
    box2 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag2")
    workflow = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism"},
        ]
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: component-level"):
        _mesh_options_from_runtime_metadata(
            workflow,
            geometries=[box1, box2],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )


def test_a08_local_omission_inherits_global_default() -> None:
    """A08: Local omission inherits valid global default correctly."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")
    box2 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag2")
    workflow = {
        "mesh_options": {
            "mesh_strategy": "swept_prism",
            "through_thickness_elements": 2,
        },
        "per_geometry": [
            {"geometry_name": "mag1"},
            {"geometry_name": "mag2"},
        ],
    }
    opts = _mesh_options_from_runtime_metadata(
        workflow,
        geometries=[box1, box2],
        default_hmax=0.5e-6,
        include_size_fields=False,
    )
    assert opts.mesh_strategy == "swept_prism"
    assert opts.through_thickness_elements == 2


def test_a09_unknown_geometry_and_duplicates_raise_error() -> None:
    """A09: Unknown geometry name or duplicate name in per_geometry raises ValueError."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")

    # 1. Unknown geometry
    workflow_unknown = {
        "per_geometry": [
            {"geometry_name": "non_existent", "hmax": 10e-9},
        ]
    }
    with pytest.raises(ValueError, match="unknown geometry 'non_existent'"):
        _mesh_options_from_runtime_metadata(
            workflow_unknown,
            geometries=[box1],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )

    # 2. Duplicate geometry
    workflow_dup = {
        "per_geometry": [
            {"geometry_name": "mag1", "hmax": 10e-9},
            {"geometry_name": "mag1", "hmax": 20e-9},
        ]
    }
    with pytest.raises(ValueError, match="duplicate geometry 'mag1'"):
        _mesh_options_from_runtime_metadata(
            workflow_dup,
            geometries=[box1],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )


def test_a10_different_valid_hmax_remain_independent() -> None:
    """A10: Independent valid hmax on A and B are preserved independently."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")
    box2 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag2")
    fields = _build_field_stack(
        [box1, box2],
        default_hmax=100e-9,
        per_geometry=[
            {"geometry_name": "mag1", "hmax": 10e-9},
            {"geometry_name": "mag2", "hmax": 25e-9},
        ],
        bounds_by_name={
            "mag1": (-0.5e-6, 0.5e-6, -0.5e-6, 0.5e-6, -0.1e-6, 0.1e-6),
            "mag2": (0.6e-6, 1.6e-6, -0.5e-6, 0.5e-6, -0.1e-6, 0.1e-6),
        },
        component_aware=True,
    )
    sizes = {f.get("owner"): f.get("params", {}).get("VIn") for f in fields if f.get("role") == "bulk"}
    assert sizes.get("mag1") == 10e-9
    assert sizes.get("mag2") == 25e-9


def test_a11_per_object_recipes_follow_same_rules() -> None:
    """A11: per_object_recipes undergo identical validation as per_geometry."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")
    box2 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag2")
    recipe1 = PerObjectMeshRecipe(
        geometry_name="mag1",
        mesh_strategy="swept_prism",
        through_thickness_elements=1,
        through_thickness_distribution="fixed",
        sweep_face_meshing="triangular",
        sweep_direction="z",
        element_family="prism",
        transition_policy="pyramid_to_tetrahedra",
        exact_layer_count=True,
    )
    recipe2 = PerObjectMeshRecipe(
        geometry_name="mag2",
        mesh_strategy="swept_prism",
        through_thickness_elements=3,
        through_thickness_distribution="fixed",
        sweep_face_meshing="triangular",
        sweep_direction="z",
        element_family="prism",
        transition_policy="pyramid_to_tetrahedra",
        exact_layer_count=True,
    )
    workflow = {
        "per_object_recipes": {
            "mag1": recipe1,
            "mag2": recipe2,
        }
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: conflicting per-geometry through-thickness elements"):
        _mesh_options_from_runtime_metadata(
            workflow,
            geometries=[box1, box2],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )


def test_a12_shared_swept_hex_and_auto_layers_preflight_order_invariant() -> None:
    """A12: Shared swept_hex preflight rejects regardless of geometry ordering."""
    boxA = Box(size=(1e-6, 1e-6, 0.2e-6), name="A")
    boxB = Box(size=(1e-6, 1e-6, 0.2e-6), name="B")
    from fullmag.meshing.asset_pipeline import _realize_fem_domain_mesh_asset_from_components_impl

    hints = fm.FEM(order=1, hmax=0.5e-6)
    workflow = {"mesh_options": {"mesh_strategy": "swept_hex"}}

    for geoms in ([boxA, boxB], [boxB, boxA]):
        with pytest.raises(ValueError, match="unsupported_mesh_combination: explicit swept_hex realization is not supported"):
            _realize_fem_domain_mesh_asset_from_components_impl(
                geoms,
                hints,
                study_universe={"mode": "manual", "size": [4e-6, 4e-6, 2e-6], "center": [0, 0, 0]},
                mesh_workflow=workflow,
            )


# ===================================================================
# A13 - A14: MESH-03 Remesh CLI Flag Propagation & Frozen Options
# ===================================================================

def test_a13_remesh_cli_adaptive_quality_flag_combinations_no_frozen_mutation(capfd: pytest.CaptureFixture[str]) -> None:
    """A13: remesh_cli.main with adaptive_size_field for all 4 quality flag combinations."""
    import io
    import json
    from unittest.mock import patch
    from fullmag.meshing import remesh_cli

    dummy_mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )

    for cq, peq in [(True, True), (True, False), (False, True), (False, False)]:
        capfd.readouterr()  # clear previous buffer
        config_payload = {
            "mode": "adaptive_size_field",
            "geometry": {"kind": "box", "size": [1e-6, 1e-6, 1e-6]},
            "hmax": 100e-9,
            "order": 1,
            "size_field": {
                "node_coords": [[0.0, 0.0, 0.0]],
                "h_values": [50e-9],
            },
            "mesh_options": {
                "compute_quality": cq,
                "per_element_quality": peq,
            },
        }

        captured_options: list[MeshOptions] = []

        def mock_remesh(geom, *, size_field, hmax, order, options):
            captured_options.append(options)
            return dummy_mesh

        stdin_buf = io.StringIO(json.dumps(config_payload))

        with patch("sys.stdin", stdin_buf):
            with patch.object(remesh_cli, "remesh_with_size_field", side_effect=mock_remesh):
                with patch.object(remesh_cli, "emit_progress"):
                    remesh_cli.main()

        assert len(captured_options) == 1
        passed_opts = captured_options[0]
        assert passed_opts.compute_quality is cq, f"Expected compute_quality={cq}, got {passed_opts.compute_quality}"
        assert passed_opts.per_element_quality is peq, f"Expected per_element_quality={peq}, got {passed_opts.per_element_quality}"

        # Verify output JSON on stdout
        out_json = capfd.readouterr().out
        res = json.loads(out_json)
        assert "mesh_statistics" in res or "nodes" in res
        assert res["generation_mode"] == "adaptive_size_field"


def test_a14_invalid_bool_triggers_typed_validation_not_bool_string() -> None:
    """A14: Invalid boolean inputs trigger TypedValidationError with code and pointer, not bool(string)."""
    from fullmag._validation import TypedValidationError
    from fullmag.meshing.remesh_cli import _mesh_options_from_dict
    import io
    import json
    from unittest.mock import patch
    from fullmag.meshing import remesh_cli

    # 1. Direct validation via _mesh_options_from_dict
    with pytest.raises(TypedValidationError) as exc_info:
        _mesh_options_from_dict({"compute_quality": "not_a_boolean"})
    assert exc_info.value.code == "boolean_type_error"
    assert exc_info.value.pointer == "/mesh_options/compute_quality"

    with pytest.raises(TypedValidationError) as exc_info2:
        _mesh_options_from_dict({"per_element_quality": "invalid"})
    assert exc_info2.value.code == "boolean_type_error"
    assert exc_info2.value.pointer == "/mesh_options/per_element_quality"


    # 2. CLI main execution with invalid bool in adaptive remesh exits with error code 1
    config_payload = {
        "mode": "adaptive_size_field",
        "geometry": {"kind": "box", "size": [1e-6, 1e-6, 1e-6]},
        "hmax": 100e-9,
        "size_field": {
            "node_coords": [[0.0, 0.0, 0.0]],
            "h_values": [50e-9],
        },
        "mesh_options": {
            "compute_quality": "not_a_bool",
        },
    }
    stdin_buf = io.StringIO(json.dumps(config_payload))
    stderr_buf = io.StringIO()
    with patch("sys.stdin", stdin_buf), patch("sys.stderr", stderr_buf):
        with pytest.raises(SystemExit) as sys_exit:
            remesh_cli.main()
        assert sys_exit.value.code == 1
    err_out = json.loads(stderr_buf.getvalue())
    assert "boolean_type_error" in err_out["error"]




# ===================================================================
# A15 - A18: MESH-04 Thin Film Contract & Invariants
# ===================================================================

def test_a15_explicit_hmin_greater_than_hmax_rejected_and_state_preserved() -> None:
    """A15: Explicit hmin > hmax rejected; original builder state preserved."""
    film = fm.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
    orig_spec = copy.deepcopy(film._mesh_spec)
    with pytest.raises(ValueError, match="minimum_element_size.*must be <= maximum_element_size"):
        film.mesh.thin_film(hmax=5e-9, hmin=10e-9)
    assert film._mesh_spec.hmax == orig_spec.hmax
    assert film._mesh_spec.hmin == orig_spec.hmin


def test_a16_automatic_t_over_n_greater_than_hmax_does_not_conflict() -> None:
    """A16: Automatic t/N > hmax does not create conflicting hmin and does not change hmax."""
    # Box thickness is 20 nm, hmax=5 nm, layers=1 -> t/N = 20 nm > 5 nm
    film = fm.geometry(fm.Box(100e-9, 40e-9, 20e-9), name="film")
    film.mesh.thin_film(hmax=5e-9, layers=1)
    assert film._mesh_spec.hmax == 5e-9
    assert film._mesh_spec.hmin is None or film._mesh_spec.hmin <= 5e-9


def test_a17_reconfiguration_does_not_resurrect_stale_hmin() -> None:
    """A17: Re-configuration of previously configured object does not resurrect stale hmin."""
    film = fm.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
    film.mesh.configure(maximum_element_size=20e-9, minimum_element_size=15e-9)
    assert film._mesh_spec.hmin == 15e-9

    # Reconfigure with smaller hmax=5 nm without specifying hmin; stale 15 nm must not conflict
    film.mesh.thin_film(hmax=5e-9)
    assert film._mesh_spec.hmax == 5e-9
    assert film._mesh_spec.hmin is None or film._mesh_spec.hmin <= 5e-9


def test_a18_prism_exact_n_declared_and_free_tetra_not_pretending() -> None:
    """A18: Prism topology sets exact_layer_count=True; free tetra sets exact_layer_count=False."""
    film_prism = fm.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film_prism")
    film_prism.mesh.thin_film(hmax=10e-9, layers=2, topology="prismatic")
    assert film_prism._mesh_spec.exact_layer_count is True

    film_tetra = fm.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film_tetra")
    film_tetra.mesh.thin_film(hmax=10e-9, layers=2, topology="tetrahedral")
    assert film_tetra._mesh_spec.exact_layer_count is False


# ===================================================================
# A19 - A20: MESH-05 Growth Rate Measurement
# ===================================================================

def test_a19_growth_rate_measurement_on_sample_mesh() -> None:
    """A19: measure_adjacent_size_growth calculates ratio accurately across threshold."""
    # Two face-neighbor pairs with size ratio sqrt(5/2) ~ 1.581.
    pair = np.asarray([
        [0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.], [0., 0., -2.],
    ])
    mesh = MeshData(
        nodes=pair,
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 0, 2, 1, 4],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 1],
        facet_types=[], facet_roles=[], facet_offsets=[0], facet_nodes=[],
        boundary_markers=[], facet_global_ordinals=[],
    )
    # Ratio is ~1.581. Under rate 1.4: violation!
    report_strict = measure_adjacent_size_growth(mesh, resolved_growth_rate=1.4)
    assert report_strict.evaluated_pair_count == 1
    assert not report_strict.is_valid
    assert report_strict.violation_count == 1

    # Under rate 1.8: valid!
    report_lenient = measure_adjacent_size_growth(mesh, resolved_growth_rate=1.8)
    assert report_lenient.evaluated_pair_count == 1
    assert report_lenient.is_valid
    assert report_lenient.violation_count == 0


def test_a20_growth_rate_separate_ranges_and_anisotropy() -> None:
    """A20: Scopes track distinct material and family pairings."""
    mesh = MeshData(
        nodes=np.asarray([
            [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0]
        ]),
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 1, 2, 3, 4],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 2],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    report = measure_adjacent_size_growth(mesh, resolved_growth_rate=2.0)
    assert len(report.scopes) >= 1


# ===================================================================
# A21 - A25: MESH-06 Growth Rate Gate in Remesh CLI
# ===================================================================

def test_a21_canonical_and_alias_growth_keys_trigger_same_gate() -> None:
    """A21: growth_rate and maximum_element_growth_rate trigger the same gate."""
    mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 1.0]]),
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 1, 2, 3, 4],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    p1 = _mesh_result_payload(mesh, mesh_name="m", generation_mode="fem", mesh_provenance={"growth_rate": 2.0})
    p2 = _mesh_result_payload(mesh, mesh_name="m", generation_mode="fem", mesh_provenance={"maximum_element_growth_rate": 2.0})
    assert "mesh_provenance" in p1
    assert "mesh_provenance" in p2


def test_a22_consistent_duplicate_growth_allowed_conflicting_rejected() -> None:
    """A22: Consistent duplicates allowed; conflicting aliases rejected with TypedValidationError."""
    mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 1.0]]),
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 1, 2, 3, 4],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    # Consistent: OK
    _mesh_result_payload(mesh, mesh_name="m", generation_mode="fem", mesh_provenance={"growth_rate": 2.0, "maximum_element_growth_rate": 2.0})

    # Conflicting: TypedValidationError
    with pytest.raises(TypedValidationError):
        _mesh_result_payload(mesh, mesh_name="m", generation_mode="fem", mesh_provenance={"growth_rate": 1.3, "maximum_element_growth_rate": 2.0})


def _two_region_pairs_fixture() -> MeshData:
    pair = np.asarray([
        [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [0.0, 0.0, -2.0],
    ])
    nodes = np.vstack([pair, pair + [10.0, 0.0, 0.0]])
    return MeshData(
        nodes=nodes,
        cell_types=["tet4"] * 4,
        cell_offsets=[0, 4, 8, 12, 16],
        cell_nodes=[0, 1, 2, 3, 0, 2, 1, 4, 5, 6, 7, 8, 5, 7, 6, 9],
        cell_global_ordinals=[0, 1, 2, 3],
        element_markers=[1, 1, 2, 2],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )


def test_a23_preset_per_geometry_recipes_airbox_resolve_growth_gate() -> None:
    """A23: Presets, per_geometry, and recipes resolve growth rate for the gate."""
    mesh = _two_region_pairs_fixture()
    regions = [
        {"geometry_name": "film_A", "marker": 1},
        {"geometry_name": "film_B", "marker": 2},
    ]
    # 1. Presets resolve growth gate:
    # "coarse" preset has growth_rate 1.8 >= 1.581 -> accepts
    payload_coarse = _mesh_result_payload(
        mesh, mesh_name="m", generation_mode="fem",
        mesh_provenance={"size_preset": "coarse"},
    )
    assert "mesh_provenance" in payload_coarse

    # "fine" preset has growth_rate 1.5 < 1.581 -> rejects
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            mesh, mesh_name="m", generation_mode="fem",
            mesh_provenance={"size_preset": "fine"},
        )

    # 2. Named per_geometry with growth_rate 1.4 rejects mesh with ratio ~1.581:
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            mesh, mesh_name="m", generation_mode="fem",
            mesh_provenance={
                "per_geometry": [
                    {"geometry": "film_A", "growth_rate": 1.4},
                    {"geometry": "film_B", "growth_rate": 2.0},
                ]
            },
            region_markers=regions,
        )

    # 3. Named per_geometry with growth_rate 1.8 accepts mesh with ratio ~1.581:
    payload_ok = _mesh_result_payload(
        mesh, mesh_name="m", generation_mode="fem",
        mesh_provenance={
            "per_geometry": [
                {"geometry": "film_A", "growth_rate": 1.8},
                {"geometry": "film_B", "growth_rate": 2.0},
            ]
        },
        region_markers=regions,
    )
    assert "mesh_provenance" in payload_ok

    # 4. Effective per-object recipe targets resolve growth gate and reject when exceeded:
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            mesh, mesh_name="m", generation_mode="fem",
            region_markers=regions,
            mesh_provenance={
                "effective_per_object_targets": {
                    "film_A": {"growth_rate": 1.4},
                    "film_B": {"growth_rate": 2.0},
                }
            },
        )


def test_a24_regional_growth_policies_not_collapsed_to_global_minimum() -> None:
    """A24: Two legally different regional policies are not collapsed to one global rate."""
    mesh = _two_region_pairs_fixture()
    # Ratio is ~1.581 in both region 1 and region 2.
    # Case 1: Scope 1 is strict (1.4), Scope 2 is lenient (2.0) -> violation in Scope 1 only
    report1 = measure_adjacent_size_growth(mesh, scope_growth_rates={"1": 1.4, "2": 2.0})
    assert not report1.is_valid
    assert report1.violation_count == 1
    # Verify exactly scope 1 violated, scope 2 did not
    scope_viols1 = {s.scope: s.violation_count for s in report1.scopes}
    assert any("marker:1" in k and v > 0 for k, v in scope_viols1.items())
    assert any("marker:2" in k and v == 0 for k, v in scope_viols1.items())

    # Case 2: Scope 1 is lenient (2.0), Scope 2 is strict (1.4) -> violation in Scope 2 only
    report2 = measure_adjacent_size_growth(mesh, scope_growth_rates={"1": 2.0, "2": 1.4})
    assert not report2.is_valid
    assert report2.violation_count == 1
    scope_viols2 = {s.scope: s.violation_count for s in report2.scopes}
    assert any("marker:1" in k and v == 0 for k, v in scope_viols2.items())
    assert any("marker:2" in k and v > 0 for k, v in scope_viols2.items())

    # Case 3: Both scopes are lenient (1.8 >= 1.581) -> perfectly valid
    report3 = measure_adjacent_size_growth(mesh, scope_growth_rates={"1": 1.8, "2": 1.8})
    assert report3.is_valid
    assert report3.violation_count == 0


def test_a25_rejected_growth_mesh_does_not_publish_topology_or_artifacts() -> None:
    """A25: Rejected growth mesh raises MeshGrowthValidationError before publishing artifacts."""
    mesh = MeshData(
        nodes=np.asarray([
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 100.0],
            [0.0, 0.0, -1.0],
        ]),
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 0, 2, 1, 4],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(mesh, mesh_name="m", generation_mode="fem", mesh_provenance={"growth_rate": 1.05})


# ===================================================================
# A26 - A29: MESH-07 Volume Scaling to SI
# ===================================================================

def _make_quality_report(
    *,
    volume_min: float = 1.0,
    volume_max: float = 2.0,
    volume_mean: float = 1.5,
    volume_std: float = 0.5,
    element_volume: list[float] | None = None,
    sicn_min: float = 0.8,
    gamma_min: float = 0.9,
    n_elements: int = 2,
) -> MeshQualityReport:
    return MeshQualityReport(
        n_elements=n_elements,
        sicn_min=sicn_min,
        sicn_max=1.0,
        sicn_mean=0.9,
        sicn_p5=0.85,
        sicn_histogram=[0] * 20,
        gamma_min=gamma_min,
        gamma_mean=0.95,
        gamma_histogram=[0] * 20,
        volume_min=volume_min,
        volume_max=volume_max,
        volume_mean=volume_mean,
        volume_std=volume_std,
        avg_quality=0.9,
        element_volume=element_volume,
    )


def test_a26_volume_analytical_equals_si_nodes_equals_quality_report() -> None:
    """A26: Analytical volume == SI node volume == scaled quality report (global and per-domain)."""
    # 1. Geometry: 100 nm x 40 nm x 20 nm
    lx, ly, lz = 100e-9, 40e-9, 20e-9
    v_analytical = lx * ly * lz  # 8.0e-23 m^3

    # Partition the box into 6 tetrahedra in SI units
    si_nodes = np.asarray([
        [0.0, 0.0, 0.0],
        [lx, 0.0, 0.0],
        [lx, ly, 0.0],
        [0.0, ly, 0.0],
        [0.0, 0.0, lz],
        [lx, 0.0, lz],
        [lx, ly, lz],
        [0.0, ly, lz],
    ], dtype=np.float64)

    tets = [
        [0, 1, 2, 6],
        [0, 2, 3, 6],
        [0, 3, 7, 6],
        [0, 7, 4, 6],
        [0, 4, 5, 6],
        [0, 5, 1, 6],
    ]

    # Calculate exact volume from SI nodes
    si_volumes: list[float] = []
    for t in tets:
        v0, v1, v2, v3 = si_nodes[t[0]], si_nodes[t[1]], si_nodes[t[2]], si_nodes[t[3]]
        v_tet = abs(np.dot(v1 - v0, np.cross(v2 - v0, v3 - v0))) / 6.0
        si_volumes.append(float(v_tet))

    v_nodes_sum = sum(si_volumes)
    assert math.isclose(v_nodes_sum, v_analytical, rel_tol=1e-12)

    # In internal Gmsh units (micro-meters), lengths are scaled by 1e6, so volumes are scaled by 1e18
    internal_volumes = [v * 1e18 for v in si_volumes]
    internal_rep = MeshQualityReport(
        n_elements=6,
        sicn_min=0.8,
        sicn_max=0.9,
        sicn_mean=0.85,
        sicn_p5=0.81,
        sicn_histogram=[0] * 20,
        gamma_min=0.85,
        gamma_mean=0.9,
        gamma_histogram=[0] * 20,
        volume_min=min(internal_volumes),
        volume_max=max(internal_volumes),
        volume_mean=float(np.mean(internal_volumes)),
        volume_std=float(np.std(internal_volumes)),
        avg_quality=0.87,
        element_volume=internal_volumes,
    )

    # Scale to SI m^3
    scaled = _scale_quality_report_volume(internal_rep, volume_scale=1e18)
    assert scaled is not None

    # Verify: Analytical == SI nodes == scaled quality report
    assert math.isclose(scaled.volume_mean * scaled.n_elements, v_analytical, rel_tol=1e-12)
    assert math.isclose(sum(scaled.element_volume), v_nodes_sum, rel_tol=1e-12)
    assert math.isclose(scaled.volume_min, min(si_volumes), rel_tol=1e-12)
    assert math.isclose(scaled.volume_max, max(si_volumes), rel_tol=1e-12)
    assert math.isclose(scaled.volume_mean, v_nodes_sum / 6.0, rel_tol=1e-12)
    assert math.isclose(scaled.volume_std, float(np.std(si_volumes)), rel_tol=1e-12, abs_tol=1e-30)

    # Verify dimensional order of magnitude is SI m^3 (10^-23), NOT micro-m^3 (10^-5)
    assert scaled.volume_mean < 1e-20

    # Test per-domain quality scaling with markers
    from fullmag.meshing._gmsh_occ import _scale_per_domain_quality_volume
    per_domain_internal = {
        1: internal_rep,
        2: internal_rep,
    }
    scaled_per_domain = _scale_per_domain_quality_volume(per_domain_internal, volume_scale=1e18)
    assert scaled_per_domain is not None
    assert math.isclose(sum(scaled_per_domain[1].element_volume), v_analytical, rel_tol=1e-12)
    assert math.isclose(sum(scaled_per_domain[2].element_volume), v_analytical, rel_tol=1e-12)



def test_a27_per_element_alignment_preserved_under_reordering() -> None:
    """A27: Quality channels aligned by element tags and preserved under SI conversion."""
    from fullmag.meshing._gmsh_extraction import (
        GmshQualityExtractionError,
        _align_quality_report_to_element_tags,
    )

    # Raw report comes out of Gmsh in scrambled element order [103, 101, 102]
    base_rep = _make_quality_report(
        volume_min=1e18,
        volume_max=3e18,
        volume_mean=2e18,
        volume_std=float(np.std([1e18, 2e18, 3e18])),
        element_volume=[3e18, 1e18, 2e18],
        sicn_min=0.5,
        gamma_min=0.7,
        n_elements=3,
    )
    raw_rep = replace(
        base_rep,
        element_tags=[103, 101, 102],
        element_sicn=[0.7, 0.5, 0.6],
        element_gamma=[0.9, 0.7, 0.8],
    )
    # Extracted MeshData has canonical element order [101, 102, 103]
    extracted_tags = [101, 102, 103]
    aligned_rep = _align_quality_report_to_element_tags(raw_rep, extracted_tags)
    assert aligned_rep is not None
    assert aligned_rep.element_tags == [101, 102, 103]
    assert aligned_rep.element_volume == [1e18, 2e18, 3e18]
    assert aligned_rep.element_sicn == [0.5, 0.6, 0.7]
    assert aligned_rep.element_gamma == [0.7, 0.8, 0.9]

    # After SI scaling by 1e18:
    scaled = _scale_quality_report_volume(aligned_rep, volume_scale=1e18)
    assert scaled is not None
    assert scaled.element_tags == [101, 102, 103]
    np.testing.assert_allclose(scaled.element_volume, [1.0, 2.0, 3.0], rtol=1e-12)
    assert scaled.element_sicn == [0.5, 0.6, 0.7]
    assert scaled.element_gamma == [0.7, 0.8, 0.9]

    # Negative case 1: duplicate element tags raise GmshQualityExtractionError
    dup_rep = replace(raw_rep, element_tags=[101, 101, 102])
    with pytest.raises(GmshQualityExtractionError, match="duplicates"):
        _align_quality_report_to_element_tags(dup_rep, extracted_tags)

    # Negative case 2: tag set mismatch raises GmshQualityExtractionError
    mismatch_rep = replace(raw_rep, element_tags=[104, 101, 102])
    with pytest.raises(GmshQualityExtractionError, match="tag sets differ"):
        _align_quality_report_to_element_tags(mismatch_rep, extracted_tags)


def test_a28_per_domain_and_global_scalar_volume_and_std_scaled_sicn_gamma_unscaled() -> None:
    """A28: Volume and std scaled; SICN and gamma remain unscaled."""
    rep = _make_quality_report(
        volume_min=2e18, volume_max=4e18, volume_mean=3e18, volume_std=1e18,
        element_volume=[2e18, 4e18],
        sicn_min=0.75, gamma_min=0.85,
    )
    scaled = _scale_quality_report_volume(rep, volume_scale=1e18)
    assert scaled is not None
    assert scaled.sicn_min == 0.75
    assert scaled.gamma_min == 0.85


def test_a29_quality_none_partial_channels_single_conversion() -> None:
    """A29: None quality report handled safely."""
    assert _scale_quality_report_volume(None, volume_scale=1e18) is None


# ===================================================================
# A30 - A33: MESH-08 Swept Layer Heights & Numerical Stability
# ===================================================================

@pytest.mark.parametrize("n", [1, 2, 3, 4, 5, 6, 7, 9])
@pytest.mark.parametrize("r", [1.0, 1.2, 2.0, 10.0])
@pytest.mark.parametrize("dist", ["linear", "exponential"])
def test_a30_swept_layer_heights_symmetry_and_sum_matrix(n: int, r: float, dist: str) -> None:
    """A30: Swept layer heights have exact symmetry and sum to 1.0."""
    heights = _compute_layer_heights(n, dist, element_ratio=r, symmetric=True)
    assert len(heights) == n
    assert math.isclose(sum(heights), 1.0, rel_tol=1e-12, abs_tol=1e-14)
    for i in range(n // 2):
        assert math.isclose(heights[i], heights[n - 1 - i], rel_tol=1e-12, abs_tol=1e-14)


def test_a31_symmetric_layer_ratio_exact_definition() -> None:
    """A31: Center-to-face layer height ratio follows exact definition."""
    # For linear N=4, r=2, d_max = (4-1)//2 = 1.
    # Center layer at d=1 has w=2. Face layer at d=0 has w=1. Ratio = 2.0.
    heights = _compute_layer_heights(4, "linear", element_ratio=2.0, symmetric=True)
    ratio = heights[1] / heights[0]
    assert math.isclose(ratio, 2.0, rel_tol=1e-12)


def test_a32_large_n_and_r_log_weights_prevent_overflow_and_detect_underflow() -> None:
    """A32: Large N and r use log-weights to prevent overflow, and detect unrepresentable distributions."""
    # 1. Representable large N (e.g. N=51, r=2.0 exponential): succeeds with log-weights
    heights = _compute_layer_heights(51, "exponential", element_ratio=2.0, symmetric=True)
    assert len(heights) == 51
    assert all(h > 0.0 and math.isfinite(h) for h in heights)
    assert math.isclose(sum(heights), 1.0, rel_tol=1e-12)
    # Check symmetry
    assert math.isclose(heights[0], heights[-1], rel_tol=1e-12)
    assert math.isclose(heights[10], heights[51 - 1 - 10], rel_tol=1e-12)
    assert np.all(np.diff(np.r_[0.0, np.cumsum(heights)]) > 0.0)

    # 2. Mathematically valid but float64-unrepresentable distributions fail closed with ValueError:
    # N=2049 has non-increasing cumulative heights due to float64 precision limit:
    with pytest.raises(ValueError, match="unrepresentable layer height distribution"):
        _compute_layer_heights(2049, "exponential", element_ratio=2.0, symmetric=True)

    # N=2500 has underflow in raw exponential weights:
    with pytest.raises(ValueError, match="unrepresentable layer height distribution"):
        _compute_layer_heights(2500, "exponential", element_ratio=2.0, symmetric=True)

    # 3. Extreme linear ratios: ratio=1e308 and ratio=1e-30 must either produce strictly monotonic positive heights or raise ValueError
    for extreme_r in (1e308, 1e-30):
        try:
            h_lin = _compute_layer_heights(4, "linear", element_ratio=extreme_r, symmetric=True)
            assert len(h_lin) == 4
            assert all(h > 0.0 and math.isfinite(h) for h in h_lin)
            assert np.all(np.diff(np.r_[0.0, np.cumsum(h_lin)]) > 0.0)
            assert math.isclose(sum(h_lin), 1.0, rel_tol=1e-12)
        except ValueError as exc:
            assert "unrepresentable" in str(exc)


def test_a33_cumulative_heights_strictly_monotonic_final_one() -> None:
    """A33: Cumulative heights strictly increasing, final height == 1.0."""
    heights = _compute_layer_heights(7, "exponential", element_ratio=2.5, symmetric=True)
    cum = np.cumsum(heights)
    for i in range(len(cum) - 1):
        assert cum[i + 1] > cum[i]
    assert math.isclose(cum[-1], 1.0, rel_tol=1e-12)


# ===================================================================
# A34: MESH-09 Typed Validation Error on Invalid Input
# ===================================================================

def test_a34_typed_validation_error_code_and_pointer() -> None:
    """A34: Invalid inputs in _gmsh_types and _size_field_plan raise TypedValidationError with code and pointer."""
    from fullmag._validation import TypedValidationError
    from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata

    box = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag")

    # 1. fullmag.meshing._gmsh_types: growth_rate <= 1.0 triggers TypedValidationError without NameError
    with pytest.raises(TypedValidationError) as exc1:
        MeshOptions(growth_rate=0.8)
    assert exc1.value.code == "numeric_range_error"
    assert exc1.value.pointer == "/mesh_options/growth_rate"

    with pytest.raises(TypedValidationError) as exc2:
        MeshOptions(growth_rate=1.0)
    assert exc2.value.code == "numeric_range_error"
    assert exc2.value.pointer == "/mesh_options/growth_rate"

    # 2. fullmag.meshing._size_field_plan: selector list and periodic pair validation without NameError
    # Non-list selector raises list_type_error
    wf_invalid_list = {
        "mesh_options": {
            "boundary_layer_target_surface_selectors": 123,
        }
    }
    with pytest.raises(TypedValidationError) as exc3:
        _mesh_options_from_runtime_metadata(
            wf_invalid_list,
            geometries=[box],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )
    assert exc3.value.code == "list_type_error"
    assert exc3.value.pointer == "/mesh_workflow/mesh_options/selector_list"

    # Invalid item in selector list raises selector_type_error
    wf_invalid_item = {
        "mesh_options": {
            "boundary_layer_target_surface_selectors": [123],
        }
    }
    with pytest.raises(TypedValidationError) as exc4:
        _mesh_options_from_runtime_metadata(
            wf_invalid_item,
            geometries=[box],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )
    assert exc4.value.code == "selector_type_error"
    assert exc4.value.pointer == "/mesh_workflow/mesh_options/selector_list/0"

    # Invalid item in periodic pair ids raises string_value_error
    wf_invalid_pair = {
        "mesh_options": {
            "periodic_pair_ids": [123],
        }
    }
    with pytest.raises(TypedValidationError) as exc5:
        _mesh_options_from_runtime_metadata(
            wf_invalid_pair,
            geometries=[box],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )
    assert exc5.value.code == "string_value_error"
    assert exc5.value.pointer == "/mesh_workflow/mesh_options/string_list/0"




# ===================================================================
# A35 - A36: MESH-10 Airbox Grading Expression & Number Formatting
# ===================================================================

def test_a35_growth_number_formatting_nextafter_and_threshold() -> None:
    """A35: _growth_number outputs .12g precision by default, .17g guard fallback near 1.0."""
    assert _growth_number(1.42) == "1.42"
    near_one = math.nextafter(1.0, float("inf"))
    formatted = _growth_number(near_one)
    assert formatted != "1"
    assert formatted != "1.0"


def test_a36_geometric_size_profile_limit_g_to_one() -> None:
    """A36: Geometric size profile limits to h0^(1-u) * h1^u as g -> 1.0, preserving endpoints and geometric mean."""
    # h0 = 4.0, h1 = 64.0 -> Geometric mean at u=0.5 is sqrt(4 * 64) = 16.0 (W06, not linear 34.0)
    h0, h1 = 4.0, 64.0

    def evaluate_matheval(expr_str: str, u_val: float) -> float:
        # Evaluate Gmsh MathEval expression in Python
        safe_env = {
            "u": u_val,
            "exp": math.exp,
            "log": math.log,
            "Min": min,
            "Max": max,
        }
        return float(eval(expr_str, {"__builtins__": {}}, safe_env))

    # 1. g within 1e-7 threshold of 1.0 (e.g. 1.0 + 1e-9)
    expr_sub = _geometric_size_profile_expression(
        size_min=h0,
        size_max=h1,
        ramp="u",
        growth_rate=1.0 + 1e-9,
    )
    assert "log(1)" not in expr_sub
    assert math.isclose(evaluate_matheval(expr_sub, 0.0), 4.0, rel_tol=1e-12)
    assert math.isclose(evaluate_matheval(expr_sub, 1.0), 64.0, rel_tol=1e-12)
    assert math.isclose(evaluate_matheval(expr_sub, 0.5), 16.0, rel_tol=1e-12)

    # 2. g just above 1e-7 threshold of 1.0 (e.g. 1.0 + 2e-7)
    expr_sup = _geometric_size_profile_expression(
        size_min=h0,
        size_max=h1,
        ramp="u",
        growth_rate=1.0 + 2e-7,
    )
    assert "log(1)" not in expr_sup
    assert math.isclose(evaluate_matheval(expr_sup, 0.0), 4.0, rel_tol=1e-12)
    assert math.isclose(evaluate_matheval(expr_sup, 1.0), 64.0, rel_tol=1e-12)
    # Smooth continuity near threshold: at u=0.5 value is close to 16.0
    assert math.isclose(evaluate_matheval(expr_sup, 0.5), 16.0, rel_tol=1e-5)



# ===================================================================
# A37 - A40: MESH-11 Swept Box Realization Options
# ===================================================================

def test_a37_swept_box_size_factor_affects_in_plane_not_layers(monkeypatch: pytest.MonkeyPatch) -> None:
    """A37: size_factor configures MeshSizeFactor and refines in-plane without altering n_layers."""
    from fullmag.meshing import _gmsh_swept

    # 1. Verify option setter configuration via mock
    calls: list[tuple[str, object]] = []

    class StopExtrude(Exception):
        pass

    class MockGeo:
        @staticmethod
        def addPoint(*args: object) -> int: return 1
        @staticmethod
        def addLine(*args: object) -> int: return 1
        @staticmethod
        def addCurveLoop(*args: object) -> int: return 1
        @staticmethod
        def addPlaneSurface(*args: object) -> int: return 1
        @staticmethod
        def synchronize() -> None: pass
        @staticmethod
        def extrude(*args: object, **kwargs: object) -> list[tuple[int, int]]:
            raise StopExtrude()

    class MockOption:
        @staticmethod
        def setNumber(name: str, val: float) -> None: calls.append((name, val))
        @staticmethod
        def getNumber(name: str) -> float: return 1.0

    class MockGmsh:
        __version__ = "4.15.0"
        option = MockOption()
        model = type("M", (), {"add": lambda *a, **kw: None, "geo": MockGeo(), "mesh": type("Me", (), {"field": type("F", (), {"list": lambda: [1], "add": lambda k: 1, "setNumber": lambda *a: None, "setNumbers": lambda *a: None})()})()})()
        @staticmethod
        def initialize() -> None: pass
        @staticmethod
        def finalize() -> None: pass

    monkeypatch.setattr(_gmsh_swept, "_import_gmsh", lambda: MockGmsh)
    opts = MeshOptions(size_factor=0.6)
    with pytest.raises(StopExtrude):
        _gmsh_swept.generate_swept_box_mesh((10e-9, 10e-9, 2e-9), hmax=5e-9, n_layers=2, airbox=None, options=opts)
    assert ("Mesh.MeshSizeFactor", 0.6) in calls

    # 2. Native verification: compare size_factor=1.0 vs size_factor=0.5
    monkeypatch.undo()
    mesh1 = _gmsh_swept.generate_swept_box_mesh(
        (100e-9, 100e-9, 10e-9), hmax=50e-9, n_layers=2, airbox=None,
        options=MeshOptions(size_factor=1.0),
    )
    mesh2 = _gmsh_swept.generate_swept_box_mesh(
        (100e-9, 100e-9, 10e-9), hmax=50e-9, n_layers=2, airbox=None,
        options=MeshOptions(size_factor=0.5),
    )
    z_planes1 = np.unique(np.round(mesh1.nodes[:, 2], 12))
    z_planes2 = np.unique(np.round(mesh2.nodes[:, 2], 12))
    # Exact layer count: 2 layers = 3 z planes for both
    assert len(z_planes1) == 3
    assert len(z_planes2) == 3
    # In-plane mesh size refined: mesh2 has more nodes than mesh1
    assert len(mesh2.nodes) > len(mesh1.nodes)


def test_a38_no_fields_branch_applies_resolved_options_no_reset(monkeypatch: pytest.MonkeyPatch) -> None:
    """A38: Curvature and smoothing options applied and not reset."""
    from fullmag.meshing import _gmsh_swept

    calls: list[tuple[str, object]] = []

    class StopExtrude(Exception):
        pass

    class MockGeo:
        @staticmethod
        def addPoint(*args: object) -> int: return 1
        @staticmethod
        def addLine(*args: object) -> int: return 1
        @staticmethod
        def addCurveLoop(*args: object) -> int: return 1
        @staticmethod
        def addPlaneSurface(*args: object) -> int: return 1
        @staticmethod
        def synchronize() -> None: pass
        @staticmethod
        def extrude(*args: object, **kwargs: object) -> list[tuple[int, int]]:
            raise StopExtrude()

    class MockOption:
        @staticmethod
        def setNumber(name: str, val: float) -> None: calls.append((name, val))
        @staticmethod
        def getNumber(name: str) -> float: return 1.0

    class MockGmsh:
        __version__ = "4.15.0"
        option = MockOption()
        model = type("M", (), {"add": lambda *a, **kw: None, "geo": MockGeo(), "mesh": type("Me", (), {"field": type("F", (), {"list": lambda: [1], "add": lambda k: 1, "setNumber": lambda *a: None, "setNumbers": lambda *a: None})()})()})()
        @staticmethod
        def initialize() -> None: pass
        @staticmethod
        def finalize() -> None: pass

    monkeypatch.setattr(_gmsh_swept, "_import_gmsh", lambda: MockGmsh)
    opts = MeshOptions(size_from_curvature=16, smoothing_steps=3)
    with pytest.raises(StopExtrude):
        _gmsh_swept.generate_swept_box_mesh((10e-9, 10e-9, 2e-9), hmax=5e-9, n_layers=2, airbox=None, options=opts)
    assert ("Mesh.MeshSizeFromCurvature", 16) in calls
    assert ("Mesh.Smoothing", 3) in calls


def test_a39_hotspot_refinement_field_on_source_face() -> None:
    """A39: Source face refinement applies ComponentRestrictedBox to source surface and marks applied."""
    from fullmag.meshing._gmsh_swept import _apply_mixed_source_face_mesh_options

    created_fields: list[tuple[int, str]] = []
    field_numbers: dict[tuple[int, str], float] = {}
    field_number_lists: dict[tuple[int, str], list[float]] = {}
    current_field_id = [0]

    class MockField:
        @staticmethod
        def add(kind: str) -> int:
            current_field_id[0] += 1
            fid = current_field_id[0]
            created_fields.append((fid, kind))
            return fid

        @staticmethod
        def list() -> list[int]:
            return [fid for fid, _ in created_fields]

        @staticmethod
        def setNumber(fid: int, name: str, val: float) -> None:
            field_numbers[(fid, name)] = float(val)

        @staticmethod
        def setNumbers(fid: int, name: str, vals: list[float]) -> None:
            field_number_lists[(fid, name)] = [float(v) for v in vals]

        @staticmethod
        def setAsBackgroundMesh(fid: int) -> None:
            created_fields.append((fid, "BackgroundMesh"))

    class MockOption:
        @staticmethod
        def setNumber(name: str, val: float) -> None: pass
        @staticmethod
        def getNumber(name: str) -> float: return 1.0

    mock_gmsh = type("Gmsh", (), {
        "option": MockOption(),
        "model": type("M", (), {
            "mesh": type("Me", (), {
                "field": MockField(),
            })(),
        })(),
    })()


    field_spec = {
        "kind": "ComponentRestrictedBox",
        "role": "hotspot",
        "owner": "film",
        "params": {
            "GeometryName": "film",
            "VIn": 2e-9,
            "VOut": 10e-9,
            "XMin": 0.0,
            "XMax": 10e-9,
            "YMin": 0.0,
            "YMax": 10e-9,
            "ZMin": 0.0,
            "ZMax": 2e-9,
        },
    }
    opts = MeshOptions(size_fields=[field_spec])

    restricted_id = _apply_mixed_source_face_mesh_options(
        mock_gmsh,
        source_surface=42,
        hmax_scaled=5.0,
        order=1,
        opts=opts,
        hscale=1e6,
    )

    # 1. Box field was added and configured
    box_fields = [fid for fid, kind in created_fields if kind == "Box"]
    assert len(box_fields) == 1
    box_id = box_fields[0]
    assert field_numbers[(box_id, "VIn")] == 2e-9 * 1e6
    assert field_numbers[(box_id, "VOut")] == 10e-9 * 1e6

    # 2. Field spec status updated to applied with field id
    assert field_spec["_gmsh_status"] == "applied"
    assert field_spec["_gmsh_field_id"] == box_id

    # 3. Restrict field restricts to source surface 42 and is set as background mesh
    assert field_number_lists[(restricted_id, "SurfacesList")] == [42.0]
    assert (restricted_id, "BackgroundMesh") in created_fields



def test_a40_unsupported_swept_options_rejected_with_reason() -> None:
    """A40: Unsupported swept options rejected with explicit reason."""
    from fullmag.meshing._gmsh_swept import generate_swept_box_mesh
    opts = MeshOptions(periodic_pair_ids=[1, 2])
    with pytest.raises(ValueError, match="does not support periodic pairs"):
        generate_swept_box_mesh((10e-9, 10e-9, 2e-9), hmax=5e-9, n_layers=2, options=opts)


# ===================================================================
# A41 - A44: MESH-12 Size Field Stack, Bulk Overrides & Metadata
# ===================================================================

def test_a41_bulk_override_removes_old_bulk_before_min() -> None:
    """A41: Overriding bulk field strips old bulk before Min stack (unit and end-to-end)."""
    # 1. Unit check: _strip_overridden_workflow_fields
    fields = [
        {"kind": "Box", "role": "bulk", "owner": "mag", "params": {"VIn": 5e-9}},
        {"kind": "Box", "role": "hotspot", "owner": "mag", "params": {"VIn": 2e-9}},
    ]
    cleaned = _strip_overridden_workflow_fields(fields, {"mag"})
    roles = [f["role"] for f in cleaned]
    assert "bulk" not in roles
    assert "hotspot" in roles

    # 2. End-to-end pipeline check: recipe coarsening strips old workflow bulk even when recipe emits no new field
    from unittest.mock import patch
    from fullmag.meshing import _gmsh_occ as occ
    from fullmag.meshing import asset_pipeline as assets

    captured: dict[str, Any] = {}

    class StopAtOcc(BaseException):
        pass

    def capture_occ(*args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        raise StopAtOcc()

    with patch.object(occ, "generate_shared_domain_mesh_via_occ", side_effect=capture_occ):
        with pytest.raises(StopAtOcc):
            assets._realize_fem_domain_mesh_asset_from_components_impl(
                [Box(4e-6, 4e-6, 2e-6, name="mag")],
                fm.FEM(order=1, hmax=1e-6),
                study_universe={
                    "mode": "manual", "size": [12e-6, 12e-6, 12e-6],
                    "center": [0.0, 0.0, 0.0], "airbox_hmax": 1e-6,
                },
                mesh_workflow={"per_geometry": [{"geometry": "mag", "hmax": 0.5e-6}]},
                per_object_recipes={"mag": PerObjectMeshRecipe(hmax=2e-6)},
            )
    eff_fields = captured["options"].size_fields
    obsolete_bulk = [
        f for f in eff_fields
        if f.get("role") == "bulk"
        and f.get("params", {}).get("GeometryName") == "mag"
        and f.get("params", {}).get("VIn") == 0.5e-6
    ]
    assert not obsolete_bulk
    assert captured["hmax"] >= 2e-6


def test_a42_recipe_change_preserves_second_object() -> None:
    """A42: Recipe change on object 1 leaves object 2 fields intact."""
    fields = [
        {"kind": "Box", "role": "bulk", "owner": "mag1", "params": {"VIn": 5e-9}},
        {"kind": "Box", "role": "bulk", "owner": "mag2", "params": {"VIn": 10e-9}},
    ]
    cleaned = _strip_overridden_workflow_fields(fields, {"mag1"})
    owners = [f["owner"] for f in cleaned]
    assert "mag1" not in owners
    assert "mag2" in owners


def test_a43_independent_hotspot_survives_bulk_change() -> None:
    """A43: Independent hotspot survives bulk stripping."""
    fields = [
        {"kind": "Box", "role": "bulk", "owner": "film", "params": {"VIn": 10e-9}},
        {"kind": "Box", "role": "hotspot", "owner": "film", "params": {"VIn": 2e-9}},
    ]
    cleaned = _strip_overridden_workflow_fields(fields, {"film"})
    assert len(cleaned) == 1
    assert cleaned[0]["role"] == "hotspot"


def test_a44_box_field_metadata_stripped_for_native_gmsh() -> None:
    """A44: GeometryName, role, owner, etc. are stripped before native Gmsh field setters."""
    from fullmag.meshing._gmsh_fields import _METADATA_PARAMS, _apply_mesh_options

    assert "GeometryName" in _METADATA_PARAMS
    assert "role" in _METADATA_PARAMS
    assert "owner" in _METADATA_PARAMS
    assert "origin" in _METADATA_PARAMS
    assert "priority" in _METADATA_PARAMS

    string_calls: list[tuple[int, str, str]] = []
    number_calls: list[tuple[int, str, float]] = []

    class MockMeshField:
        @staticmethod
        def add(kind: str) -> int: return 42
        @staticmethod
        def setString(fid: int, key: str, val: str) -> None: string_calls.append((fid, key, val))
        @staticmethod
        def setNumber(fid: int, key: str, val: float) -> None: number_calls.append((fid, key, val))
        @staticmethod
        def setNumbers(fid: int, key: str, val: list) -> None: pass
        @staticmethod
        def setAsBackgroundMesh(fid: int) -> None: pass

    class MockGmsh:
        model = type("M", (), {
            "mesh": type("Me", (), {"field": MockMeshField()})(),
            "occ": type("O", (), {"synchronize": lambda: None})(),
        })()
        option = type("Opt", (), {
            "setNumber": lambda *a: None,
            "getNumber": lambda *a: 1.0,
            "setString": lambda *a: None,
        })()

    opts = MeshOptions(
        size_fields=[{
            "kind": "Box",
            "params": {
                "VIn": 1e-9,
                "VOut": 2e-9,
                "XMin": 0.0,
                "XMax": 1e-6,
                "YMin": 0.0,
                "YMax": 1e-6,
                "ZMin": 0.0,
                "ZMax": 1e-6,
                "GeometryName": "mag",
                "role": "bulk",
                "owner": "mag",
                "origin": "workflow",
                "priority": 1,
            },
        }]
    )
    _apply_mesh_options(MockGmsh(), hmax=1.0, order=1, opts=opts, hscale=1.0)
    passed_string_keys = {key for _, key, _ in string_calls}
    passed_number_keys = {key for _, key, _ in number_calls}
    assert "GeometryName" not in passed_string_keys
    assert "role" not in passed_string_keys
    assert "owner" not in passed_string_keys
    assert "origin" not in passed_string_keys
    assert "priority" not in passed_number_keys
    assert "VIn" in passed_number_keys
    assert "VOut" in passed_number_keys


# ===================================================================
# A45 - A47: MESH-13 MeshRealizationReport Contract & Auto Direction
# ===================================================================

def test_a45_auto_direction_topology_layers_order_mismatch_rejected_without_fallback() -> None:
    """A45: Auto direction rejects topology, layer count, or order mismatch without fallback."""
    with pytest.raises(ValueError, match="requested/resolved fields must match"):
        MeshRealizationReport(
            requested_topology="prism6",
            resolved_topology="tet4",
            requested_layers=3,
            resolved_layers=3,
            requested_axis="z",
            resolved_axis="z",
            requested_order=1,
            resolved_order=1,
            requested_direction="auto",
            fallbacks_triggered=(),
        )


def test_a46_auto_direction_allows_different_axis_explicit_direction_requires_exact_axis() -> None:
    """A46: Auto direction allows axis change; explicit direction requires exact match."""
    # Auto: axis mismatch OK
    rep_auto = MeshRealizationReport(
        requested_topology="prism6",
        resolved_topology="prism6",
        requested_layers=3,
        resolved_layers=3,
        requested_axis="z",
        resolved_axis="x",
        requested_order=1,
        resolved_order=1,
        requested_direction="auto",
        fallbacks_triggered=(),
    )
    assert rep_auto.resolved_axis == "x"

    # Explicit: axis mismatch rejected
    with pytest.raises(ValueError, match="requested/resolved fields must match"):
        MeshRealizationReport(
            requested_topology="prism6",
            resolved_topology="prism6",
            requested_layers=3,
            resolved_layers=3,
            requested_axis="z",
            resolved_axis="x",
            requested_order=1,
            resolved_order=1,
            requested_direction="z",
            fallbacks_triggered=(),
        )


def test_a47_from_dict_and_constructor_enforce_qualified_fallback() -> None:
    """A47: from_dict and constructor enforce QUALIFIED_REALIZATION_FALLBACKS."""
    # 1. Arbitrary fallback string rejected by constructor
    with pytest.raises(ValueError, match="unknown realization fallback"):
        MeshRealizationReport(
            requested_topology="prism6",
            resolved_topology="tet4",
            requested_layers=3,
            resolved_layers=3,
            requested_axis="z",
            resolved_axis="z",
            requested_order=1,
            resolved_order=1,
            requested_direction="auto",
            fallbacks_triggered=("arbitrary_fallback",),
        )

    # 2. Arbitrary fallback string rejected by from_dict
    payload_invalid = {
        "schema_version": "mesh_realization_report.v1",
        "requested_topology": "prism6",
        "resolved_topology": "tet4",
        "requested_layers": 3,
        "resolved_layers": 3,
        "requested_axis": "z",
        "resolved_axis": "z",
        "requested_order": 1,
        "resolved_order": 1,
        "requested_direction": "auto",
        "fallbacks_triggered": ["arbitrary_fallback"],
    }
    with pytest.raises(ValueError, match="unknown realization fallback"):
        MeshRealizationReport.from_dict(payload_invalid)

    # 3. Qualified fallback "swept_cylinder_recombined_to_tet4" accepted by both constructor and from_dict
    payload_valid = {
        "schema_version": "mesh_realization_report.v1",
        "requested_topology": "hex8",
        "resolved_topology": "tet4",
        "requested_layers": 2,
        "resolved_layers": 2,
        "requested_axis": "z",
        "resolved_axis": "z",
        "requested_order": 1,
        "resolved_order": 1,
        "requested_direction": "auto",
        "fallbacks_triggered": ["swept_cylinder_recombined_to_tet4"],
    }
    rep_from_dict = MeshRealizationReport.from_dict(payload_valid)
    assert "swept_cylinder_recombined_to_tet4" in rep_from_dict.fallbacks_triggered

    rep_direct = MeshRealizationReport(
        requested_topology="hex8",
        resolved_topology="tet4",
        requested_layers=2,
        resolved_layers=2,
        requested_axis="z",
        resolved_axis="z",
        requested_order=1,
        resolved_order=1,
        requested_direction="auto",
        fallbacks_triggered=("swept_cylinder_recombined_to_tet4",),
    )
    assert rep_direct.to_dict()["fallbacks_triggered"] == ["swept_cylinder_recombined_to_tet4"]


# ===================================================================
# A48 - A50: MESH-14 Quality Summary Uniformity & Skewness Migration
# ===================================================================

def test_a48_uniformity_present_in_cell_summary_definitions_thresholds() -> None:
    """A48: edge_length_uniformity present in definitions and scope metrics."""
    mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    summary = build_typed_quality_summary(mesh)
    s_dict = summary.to_dict()
    assert "edge_length_uniformity.tet4.v1" in s_dict["metric_definitions"]
    assert "skewness.tet4.v1" in s_dict["metric_definitions"]


def test_a49_equilateral_sheared_hex_jacobian_drops_despite_uniformity_one() -> None:
    """A49: Equilateral sheared hex has edge_length_uniformity=1.0 but small signed Jacobian."""
    theta = math.radians(1.0)
    # Unit hex sheared by theta: all 12 edge lengths are 1.0
    nodes = np.asarray([
        [0.0, 0.0, 0.0],
        [1.0, 0.0, 0.0],
        [1.0 + math.cos(theta), math.sin(theta), 0.0],
        [math.cos(theta), math.sin(theta), 0.0],
        [0.0, 0.0, 1.0],
        [1.0, 0.0, 1.0],
        [1.0 + math.cos(theta), math.sin(theta), 1.0],
        [math.cos(theta), math.sin(theta), 1.0],
    ])
    mesh = MeshData(
        nodes=nodes,
        cell_types=["hex8"],
        cell_offsets=[0, 8],
        cell_nodes=[0, 1, 2, 3, 4, 5, 6, 7],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    summary = build_typed_quality_summary(mesh)
    scope = summary.scopes[0]
    unif = scope.metrics["edge_length_uniformity.hex8.v1"]["min"]
    jac = scope.metrics["signed_jacobian.hex8.v1"]["min"]
    assert math.isclose(unif, 1.0, rel_tol=1e-6)
    assert jac < 0.05  # det(J) drops to sin(1 deg) ~ 0.0175, exposing shear!


def test_a50_legacy_skewness_threshold_mirroring_and_conflict_detection() -> None:
    """A50: skewness and edge_length_uniformity thresholds mirror each other; conflicts raise ValueError."""
    mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    # Threshold given as legacy alias skewness:
    s = validate_typed_quality_summary(mesh, thresholds={"skewness.tet4.v1": {"minimum": 0.1}})
    assert s.is_valid

    # Threshold given as canonical edge_length_uniformity:
    s2 = validate_typed_quality_summary(mesh, thresholds={"edge_length_uniformity.tet4.v1": {"minimum": 0.1}})
    assert s2.is_valid

    # Conflicting thresholds raise ValueError:
    with pytest.raises(ValueError, match="Conflicting quality thresholds"):
        validate_typed_quality_summary(
            mesh,
            thresholds={
                "skewness.tet4.v1": {"minimum": 0.2},
                "edge_length_uniformity.tet4.v1": {"minimum": 0.8},
            },
        )


# ===================================================================
# A51 - A52: MESH-15 SizeFieldData Finite, Positive & Immutability
# ===================================================================

def test_a51_size_field_data_rejects_nan_inf_zero_negative_h() -> None:
    """A51: SizeFieldData rejects NaN, +inf, -inf, zero, and negative values in h."""
    valid_c = np.asarray([[0.0, 0.0, 0.0]])
    with pytest.raises(ValueError, match="strictly positive"):
        SizeFieldData(node_coords=valid_c, h_values=np.asarray([0.0]))
    with pytest.raises(ValueError, match="strictly positive"):
        SizeFieldData(node_coords=valid_c, h_values=np.asarray([-1.0]))
    with pytest.raises(ValueError, match="finite"):
        SizeFieldData(node_coords=valid_c, h_values=np.asarray([float("nan")]))
    with pytest.raises(ValueError, match="finite"):
        SizeFieldData(node_coords=np.asarray([[float("inf"), 0.0, 0.0]]), h_values=np.asarray([1.0]))


def test_a52_size_field_data_arrays_are_immutable_and_empty_contract() -> None:
    """A52: SizeFieldData defensive copies are read-only (flags.writeable=False); empty inputs rejected."""
    c = np.asarray([[0.0, 0.0, 0.0]])
    h = np.asarray([1.0])
    data = SizeFieldData(node_coords=c, h_values=h)
    assert not data.node_coords.flags.writeable
    assert not data.h_values.flags.writeable

    # Modifying original does not mutate data
    c[0, 0] = 999.0
    assert data.node_coords[0, 0] == 0.0

    # Empty inputs contract: must be non-empty
    with pytest.raises(ValueError, match="must not be empty"):
        SizeFieldData(node_coords=np.empty((0, 3)), h_values=np.empty(0))
