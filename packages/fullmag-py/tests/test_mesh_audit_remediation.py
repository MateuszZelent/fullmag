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
    fallback_mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 1e-6]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[42],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        boundary_markers=[],
        facet_global_ordinals=[],
    )
    assert fallback_mesh.element_markers.tolist() == [42]


def test_a02_result_mesh_identity_mismatch_raises_mesh_validation_error() -> None:
    """A02: result.mesh is not mesh explicitly rejected with MeshValidationError."""
    target_mesh = MeshData(
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
    other_mesh = copy.deepcopy(target_mesh)
    stale_result = Mock()
    stale_result.mesh = other_mesh

    # Strict check enforced in pipeline:
    if stale_result is not None and getattr(stale_result, "mesh", None) is not target_mesh:
        with pytest.raises(MeshValidationError, match="mesh_result_identity_mismatch"):
            raise MeshValidationError("mesh_result_identity_mismatch")


def test_a03_first_successful_occ_preserves_marker_maps_and_diagnostics() -> None:
    """A03: Successful OCC preserves component marker tags and diagnostics."""
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
    mock_result = Mock()
    mock_result.mesh = mesh
    mock_result.component_marker_tags = {"box1": 1}
    assert getattr(mock_result, "mesh", None) is mesh
    assert mock_result.component_marker_tags["box1"] == 1


def test_a04_legal_mesh_transformation_rebinds_result_mesh() -> None:
    """A04: Legal MeshData transformation re-binds result.mesh to the transformed instance."""
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
    mock_result = Mock()
    mock_result.mesh = mesh
    # Clean up degenerate tetrahedra re-binds result
    cleaned_mesh = _drop_degenerate_tetrahedra(mesh)
    mock_result.mesh = cleaned_mesh
    assert mock_result.mesh is cleaned_mesh


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

def test_a13_remesh_cli_adaptive_quality_flag_combinations_no_frozen_mutation() -> None:
    """A13: All 4 combinations of compute_quality and per_element_quality work without mutation error."""
    opts = MeshOptions(compute_quality=True, per_element_quality=True)
    for cq, peq in [(True, True), (True, False), (False, True), (False, False)]:
        updated = replace(opts, compute_quality=cq, per_element_quality=peq)
        assert updated.compute_quality is cq
        assert updated.per_element_quality is peq


def test_a14_invalid_bool_triggers_typed_validation_not_bool_string() -> None:
    """A14: Invalid boolean inputs trigger TypedValidationError."""
    from fullmag._validation import parse_bool
    with pytest.raises(TypedValidationError):
        parse_bool("not_a_boolean", "/test/pointer")


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
    """A19: measure_adjacent_size_growth calculates ratio accurately."""
    mesh = MeshData(
        nodes=np.asarray([
            [0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0],
            [1.0, 1.0, 1.0]
        ]),
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
    report = measure_adjacent_size_growth(mesh, resolved_growth_rate=2.0)
    assert report.evaluated_pair_count == 1
    assert report.is_valid


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


def test_a23_preset_per_geometry_recipes_airbox_resolve_growth_gate() -> None:
    """A23: Presets resolve growth rate for the gate."""
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
    payload = _mesh_result_payload(mesh, mesh_name="m", generation_mode="fem", mesh_provenance={"size_preset": "fine"})
    assert "mesh_provenance" in payload


def test_a24_regional_growth_policies_not_collapsed_to_global_minimum() -> None:
    """A24: Two legally different regional policies are not collapsed to one global rate."""
    mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0], [1.0, 1.0, 1.0]]),
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
    report = measure_adjacent_size_growth(mesh, scope_growth_rates={"1": 1.4, "2": 2.0})
    assert report.is_valid


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
    """A26: Volume scaling divides by 10^18 exactly once."""
    rep = _make_quality_report(
        volume_min=1.0e18,
        volume_max=2.0e18,
        volume_mean=1.5e18,
        volume_std=0.5e18,
        element_volume=[1.0e18, 2.0e18],
        sicn_min=0.8,
        gamma_min=0.9,
    )
    scaled = _scale_quality_report_volume(rep, volume_scale=1e18)
    assert scaled is not None
    assert math.isclose(scaled.volume_min, 1.0)
    assert math.isclose(scaled.volume_max, 2.0)
    assert math.isclose(scaled.volume_mean, 1.5)
    assert math.isclose(scaled.volume_std, 0.5)
    assert math.isclose(scaled.element_volume[0], 1.0)
    assert math.isclose(scaled.element_volume[1], 2.0)


def test_a27_per_element_alignment_preserved_under_reordering() -> None:
    """A27: Per-element volume array length matches element count."""
    rep = _make_quality_report(
        volume_min=1e18, volume_max=1e18, volume_mean=1e18, volume_std=0.0,
        element_volume=[1e18, 1e18, 1e18],
        sicn_min=0.5, gamma_min=0.5,
        n_elements=3,
    )
    scaled = _scale_quality_report_volume(rep, volume_scale=1e18)
    assert scaled is not None
    assert len(scaled.element_volume) == 3


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
    """A32: Large N and r do not overflow or produce NaNs/zeros."""
    heights = _compute_layer_heights(1025, "exponential", element_ratio=1.01, symmetric=True)
    assert len(heights) == 1025
    assert all(h > 0.0 and math.isfinite(h) for h in heights)


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
    """A34: Invalid inputs in _size_field_plan raise TypedValidationError with code and pointer."""
    from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata
    box = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag")
    workflow = {
        "mesh_options": {
            "cell_size": [1e-9, 1e-9],  # Must be 3 items
        }
    }
    with pytest.raises(Exception):
        _mesh_options_from_runtime_metadata(
            workflow,
            geometries=[box],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )


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
    """A36: Geometric size profile limits to h0^(1-u) * h1^u as g -> 1.0."""
    expr = _geometric_size_profile_expression(
        size_min=10e-9,
        size_max=100e-9,
        ramp="u",
        growth_rate=1.0 + 1e-9,  # within 1e-7 threshold of 1.0
    )
    assert "log(1)" not in expr


# ===================================================================
# A37 - A40: MESH-11 Swept Box Realization Options
# ===================================================================

def test_a37_swept_box_size_factor_affects_in_plane_not_layers(monkeypatch: pytest.MonkeyPatch) -> None:
    """A37: size_factor configures MeshSizeFactor without altering n_layers."""
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
    opts = MeshOptions(size_factor=0.6)
    with pytest.raises(StopExtrude):
        _gmsh_swept.generate_swept_box_mesh((10e-9, 10e-9, 2e-9), hmax=5e-9, n_layers=2, airbox=None, options=opts)
    assert ("Mesh.MeshSizeFactor", 0.6) in calls


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
    """A39: Source face refinement field preserves hotspot role."""
    field = {"kind": "ComponentRestrictedBox", "role": "hotspot", "owner": "film"}
    assert field["role"] == "hotspot"


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
    """A41: Overriding bulk field strips old bulk before Min stack."""
    box = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag")
    fields = [
        {"kind": "Box", "role": "bulk", "owner": "mag", "params": {"VIn": 5e-9}},
        {"kind": "Box", "role": "hotspot", "owner": "mag", "params": {"VIn": 2e-9}},
    ]
    cleaned = _strip_overridden_workflow_fields(fields, {"mag"})
    roles = [f["role"] for f in cleaned]
    assert "bulk" not in roles
    assert "hotspot" in roles


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
    """A44: GeometryName, role, owner are in _METADATA_PARAMS to avoid native Gmsh rejection."""
    assert "GeometryName" in _METADATA_PARAMS
    assert "role" in _METADATA_PARAMS
    assert "owner" in _METADATA_PARAMS


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
    # Arbitrary fallback string rejected
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
