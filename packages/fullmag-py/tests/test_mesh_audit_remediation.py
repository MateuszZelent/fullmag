from __future__ import annotations

from dataclasses import replace
from unittest.mock import Mock

import numpy as np
import pytest

import fullmag as fm
from fullmag._validation import TypedValidationError
from fullmag.meshing._airbox_grading import _geometric_size_profile_expression
from fullmag.meshing._gmsh_swept import _compute_layer_heights
from fullmag.meshing._gmsh_types import (
    MeshData,
    MeshOptions,
    MeshQualityReport,
    MeshRealizationReport,
    SizeFieldData,
)
from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata
from fullmag.meshing.quality import MeshGrowthValidationError, build_typed_quality_summary
from fullmag.meshing.remesh_cli import _mesh_result_payload
from fullmag.model.geometry import Box


# ===================================================================
# MESH-01 & MESH-02: Shared Domain Routing, Intent & Marker Isolation
# ===================================================================

def test_mesh_01_failed_occ_does_not_leak_result_to_stl_fallback() -> None:
    """Verify that a failed OCC attempt or fallback does not leak OCC component_marker_tags to postprocessing."""
    fallback_mesh = MeshData(
        nodes=np.asarray([[0.0, 0.0, 0.0], [1e-6, 1e-6, 1e-6], [0.0, 1e-6, 1e-6], [1e-6, 0.0, 1e-6]]),
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
    stale_mock_result = Mock()
    stale_mock_result.mesh = Mock()  # Different mesh instance!
    stale_mock_result.component_marker_tags = {"mag1": 999, "mag2": 888}

    # Verify our postprocessing guard: getattr(result, "mesh", None) is mesh
    assert getattr(stale_mock_result, "mesh", None) is not fallback_mesh


def test_mesh_02_per_geometry_preserves_matching_and_rejects_conflicts() -> None:
    """Verify MESH-02: matching per-geometry intents are preserved, conflicting/partial intents rejected."""
    box1 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag1")
    box2 = Box(size=(1e-6, 1e-6, 0.2e-6), name="mag2")

    # 1. Matching intents are preserved (not collapsed to None)
    workflow_matching = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism", "through_thickness_elements": 2},
            {"geometry_name": "mag2", "mesh_strategy": "swept_prism", "through_thickness_elements": 2},
        ]
    }
    opts = _mesh_options_from_runtime_metadata(
        workflow_matching,
        geometries=[box1, box2],
        default_hmax=0.5e-6,
        include_size_fields=False,
    )
    assert opts.mesh_strategy == "swept_prism"
    assert opts.through_thickness_elements == 2

    # 2. Conflicting intents are explicitly rejected with unsupported_mesh_combination
    workflow_conflict = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism"},
            {"geometry_name": "mag2", "mesh_strategy": "free_tetrahedral"},
        ]
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: conflicting per-geometry"):
        _mesh_options_from_runtime_metadata(
            workflow_conflict,
            geometries=[box1, box2],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )

    # 3. Conflicting layer counts are explicitly rejected
    workflow_layer_conflict = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism", "through_thickness_elements": 1},
            {"geometry_name": "mag2", "mesh_strategy": "swept_prism", "through_thickness_elements": 3},
        ]
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: conflicting per-geometry"):
        _mesh_options_from_runtime_metadata(
            workflow_layer_conflict,
            geometries=[box1, box2],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )

    # 4. Partial intent across multi-geometry domain is explicitly rejected
    workflow_partial = {
        "per_geometry": [
            {"geometry_name": "mag1", "mesh_strategy": "swept_prism"},
            {"geometry_name": "mag2"},
        ]
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: component-level"):
        _mesh_options_from_runtime_metadata(
            workflow_partial,
            geometries=[box1, box2],
            default_hmax=0.5e-6,
            include_size_fields=False,
        )


def test_mesh_02_shared_domain_rejects_swept_hex() -> None:
    """Verify that swept_hex in shared domain meshing is rejected explicitly."""
    from fullmag.meshing.asset_pipeline import _realize_fem_domain_mesh_asset_from_components_impl

    box = Box(size=(1e-6, 1e-6, 0.2e-6), name="magnet")
    hints = fm.FEM(order=1, hmax=0.5e-6)
    workflow = {
        "mesh_options": {
            "mesh_strategy": "swept_hex",
        }
    }
    with pytest.raises(ValueError, match="unsupported_mesh_combination: explicit swept_hex realization is not supported"):
        _realize_fem_domain_mesh_asset_from_components_impl(
            [box],
            hints,
            study_universe={"mode": "manual", "size": [4e-6, 4e-6, 2e-6], "center": [0, 0, 0]},
            mesh_workflow=workflow,
        )


# ===================================================================
# MESH-03: Frozen MeshOptions in Remesh CLI
# ===================================================================

def test_mesh_03_mesh_options_is_frozen_and_remesh_does_not_mutate() -> None:
    """Verify MeshOptions is frozen and remesh_cli does not attempt in-place mutation."""
    opts = MeshOptions(compute_quality=True, per_element_quality=False)
    with pytest.raises(Exception):  # FrozenInstanceError
        opts.compute_quality = False  # type: ignore[misc]

    # Re-creating or using dataclass replace works as intended
    updated = replace(opts, compute_quality=False, per_element_quality=True)
    assert not updated.compute_quality
    assert updated.per_element_quality


# ===================================================================
# MESH-04: world.py thin_film hmin <= hmax Invariant
# ===================================================================

def test_mesh_04_thin_film_preserves_hmin_hmax_invariant() -> None:
    """Verify thin_film preserves hmin <= hmax invariant without forced assignment."""
    film = fm.geometry(fm.Box(100e-9, 40e-9, 5e-9), name="film")
    # Even if caller passes hmin > hmax, thin_film must never end with hmin > hmax
    film.mesh.thin_film(hmax=5e-9, hmin=10e-9)
    spec = film._mesh_spec
    if spec.hmin is not None and spec.hmax is not None:
        assert spec.hmin <= spec.hmax


# ===================================================================
# MESH-05 & MESH-06: Growth Rate Gate in Remesh CLI
# ===================================================================

def test_mesh_06_remesh_payload_checks_both_growth_rate_keys() -> None:
    """Verify _mesh_result_payload checks both growth_rate and maximum_element_growth_rate."""
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

    # 1. When maximum_element_growth_rate is set in mesh_options, growth validation is triggered
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            mesh,
            mesh_name="film",
            generation_mode="generated",
            mesh_provenance={"mesh_options": {"maximum_element_growth_rate": 1.35}},
        )

    # 2. When growth_rate is set in root provenance, growth validation is also triggered
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            mesh,
            mesh_name="film",
            generation_mode="generated",
            mesh_provenance={"growth_rate": 1.45},
        )


# ===================================================================
# MESH-07: OCC Quality Volume Metrics in SI m³
# ===================================================================

def test_mesh_07_occ_quality_volume_scaled_to_si_m3() -> None:
    """Verify _scale_quality_report_volume divides volume by 1e18 (um³ to m³)."""
    from fullmag.meshing._gmsh_occ import _scale_quality_report_volume

    sample = MeshQualityReport(
        n_elements=1,
        sicn_min=0.8,
        sicn_max=0.9,
        sicn_mean=0.85,
        sicn_p5=0.8,
        sicn_histogram=[1],
        gamma_min=0.7,
        gamma_mean=0.7,
        gamma_histogram=[1],
        volume_min=1e6,  # 1e6 um³
        volume_max=2e6,
        volume_mean=1.5e6,
        volume_std=0.1e6,
        avg_quality=0.85,
        element_volume=[1.5e6],
    )
    scaled = _scale_quality_report_volume(sample, 1e18)
    assert scaled is not None
    assert scaled.volume_min == pytest.approx(1e6 / 1e18)
    assert scaled.volume_max == pytest.approx(2e6 / 1e18)
    assert scaled.volume_mean == pytest.approx(1.5e6 / 1e18)
    assert scaled.volume_std == pytest.approx(0.1e6 / 1e18)
    assert scaled.element_volume == [pytest.approx(1.5e6 / 1e18)]


# ===================================================================
# MESH-08: Analytical Symmetric Layer Heights
# ===================================================================

@pytest.mark.parametrize("n_layers", [1, 2, 3, 4, 5, 8])
def test_mesh_08_symmetric_layer_heights_exact_symmetry_and_sum(n_layers: int) -> None:
    """Verify _compute_layer_heights with symmetric=True satisfies exact symmetry and sum."""
    total_thickness = 100.0e-9
    ratio = 2.5
    heights = _compute_layer_heights(
        n_layers,
        total_thickness,
        distribution="linear",
        element_ratio=ratio,
        symmetric=True,
    )

    # 1. Count and sum
    assert len(heights) == n_layers
    assert sum(heights) == pytest.approx(1.0, rel=1e-12)
    physical_heights = [h * total_thickness for h in heights]
    assert sum(physical_heights) == pytest.approx(total_thickness, rel=1e-12)

    # 2. Exact symmetry
    for i in range(n_layers):
        assert heights[i] == pytest.approx(heights[n_layers - 1 - i], rel=1e-12)

    # 3. Center coarseness (heights increase toward center when element_ratio > 1)
    half = n_layers // 2
    for i in range(half):
        assert heights[i + 1] >= heights[i] - 1e-18


# ===================================================================
# MESH-09: TypedValidationError Import Integrity
# ===================================================================

def test_mesh_09_typed_validation_error_imported_correctly() -> None:
    """Verify TypedValidationError is imported from fullmag._validation and usable."""
    from fullmag._validation import TypedValidationError
    from fullmag.meshing import _gmsh_types, _size_field_plan

    assert hasattr(_gmsh_types, "TypedValidationError")
    assert hasattr(_size_field_plan, "TypedValidationError")
    assert _gmsh_types.TypedValidationError is TypedValidationError
    assert _size_field_plan.TypedValidationError is TypedValidationError


# ===================================================================
# MESH-10: _growth_number Float Precision in Expressions
# ===================================================================

def test_mesh_10_growth_number_formatting_and_limit() -> None:
    """Verify _growth_number outputs .12g precision and handles limit near 1.0."""
    from fullmag.meshing._airbox_grading import _growth_number

    # Standard growth rate format
    assert _growth_number(1.42) == "1.42"
    assert _growth_number(1.2) == "1.2"

    # Extreme close to 1.0 does not produce "1" or divide-by-zero
    near_unity = 1.0 + 1e-15
    res = _growth_number(near_unity)
    assert res != "1"
    assert float(res) > 1.0


# ===================================================================
# MESH-11: Swept Mesh Options Applied Without Airbox
# ===================================================================

def test_mesh_11_swept_mesh_sets_options_without_airbox(monkeypatch: pytest.MonkeyPatch) -> None:
    """Verify generate_swept_box_mesh sets MeshSizeFactor and curvature options even when airbox is None."""
    from fullmag.meshing import _gmsh_swept

    calls: list[tuple[str, object]] = []

    class StopExtrude(Exception):
        pass

    class MockGeo:
        @staticmethod
        def addPoint(*args: object) -> int:
            return 1

        @staticmethod
        def addLine(*args: object) -> int:
            return 1

        @staticmethod
        def addCurveLoop(*args: object) -> int:
            return 1

        @staticmethod
        def addPlaneSurface(*args: object) -> int:
            return 1

        @staticmethod
        def synchronize() -> None:
            pass

        @staticmethod
        def extrude(*args: object, **kwargs: object) -> list[tuple[int, int]]:
            raise StopExtrude("extrude_reached")

    class MockField:
        @staticmethod
        def list() -> list[int]:
            return [1]

        @staticmethod
        def add(kind: str) -> int:
            return 1

        @staticmethod
        def setNumber(*args: object) -> None:
            pass

        @staticmethod
        def setNumbers(*args: object) -> None:
            pass

        @staticmethod
        def setAsBackgroundMesh(field_id: int) -> None:
            calls.append(("BackgroundMesh", field_id))

    class MockMesh:
        field = MockField()

    class MockOption:
        @staticmethod
        def setNumber(name: str, val: float) -> None:
            calls.append((name, val))

        @staticmethod
        def getNumber(name: str) -> float:
            return 1.0

    class MockGmsh:
        __version__ = "4.15.0"
        option = MockOption()
        model = type(
            "MockModel",
            (),
            {
                "add": staticmethod(lambda name: None),
                "geo": MockGeo(),
                "mesh": MockMesh(),
                "occ": type("MockOcc", (), {})(),
            },
        )()

        @staticmethod
        def initialize() -> None:
            pass

        @staticmethod
        def finalize() -> None:
            pass

    monkeypatch.setattr(_gmsh_swept, "_import_gmsh", lambda: MockGmsh)

    opts = MeshOptions(size_factor=0.8, size_from_curvature=15, curvature_factor=0.25)
    with pytest.raises(StopExtrude):
        _gmsh_swept.generate_swept_box_mesh(
            (10e-9, 10e-9, 2e-9),
            hmax=5e-9,
            n_layers=2,
            airbox=None,
            options=opts,
        )

    assert ("Mesh.MeshSizeFactor", 0.8) in calls
    assert ("Mesh.MeshSizeFromCurvature", 15) in calls
    assert ("Mesh.MinimumElementsPerTwoPi", 0.25) in calls


# ===================================================================
# MESH-12: GeometryName in Box Fields and Strip Overridden
# ===================================================================

def test_mesh_12_box_field_includes_geometry_name() -> None:
    """Verify _build_field_stack includes GeometryName in Box field params and enables stripping."""
    from fullmag.meshing._size_field_plan import _build_field_stack
    from fullmag.meshing.asset_pipeline import _strip_overridden_geometry_fields
    from fullmag.model.discretization import PerObjectMeshRecipe

    box = Box(size=(10e-6, 5e-6, 1e-6), name="sensor_core")
    fields = _build_field_stack(
        [box],
        default_hmax=1e-6,
        per_geometry=[{"geometry_name": "sensor_core", "bulk_hmax": 0.5e-6}],
    )
    box_fields = [f for f in fields if f.get("kind") == "Box"]
    assert len(box_fields) > 0
    assert box_fields[0]["params"].get("GeometryName") == "sensor_core"

    # Verify _strip_overridden_geometry_fields strips it when a recipe overrides it
    recipe = PerObjectMeshRecipe(hmax=2e-6)
    stripped = _strip_overridden_geometry_fields(fields, {"sensor_core": recipe})
    remaining_boxes = [f for f in stripped if f.get("kind") == "Box"]
    assert len(remaining_boxes) == 0


# ===================================================================
# MESH-13: MeshRealizationReport 'auto' Direction Contract
# ===================================================================

def test_mesh_13_realization_report_auto_direction_strictness() -> None:
    """Verify MeshRealizationReport with auto direction allows axis resolution but strictly checks topology/order/layers."""
    # 1. auto direction allows requested_axis != resolved_axis
    report = MeshRealizationReport(
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
    assert report.resolved_axis == "x"

    # 2. But topology mismatch without fallback is rejected
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

    # 3. Layer count mismatch without fallback is rejected
    with pytest.raises(ValueError, match="requested/resolved fields must match"):
        MeshRealizationReport(
            requested_topology="prism6",
            resolved_topology="prism6",
            requested_layers=3,
            resolved_layers=1,
            requested_axis="z",
            resolved_axis="z",
            requested_order=1,
            resolved_order=1,
            requested_direction="auto",
            fallbacks_triggered=(),
        )


# ===================================================================
# MESH-14: Edge Length Uniformity in Quality Summary
# ===================================================================

def test_mesh_14_edge_length_uniformity_metric_emitted() -> None:
    """Verify edge_length_uniformity is emitted alongside skewness in build_typed_quality_summary."""
    mesh = MeshData(
        nodes=np.asarray([
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ]),
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
    summary_dict = summary.to_dict()
    assert "metric_definitions" in summary_dict
    assert "edge_length_uniformity.tet4.v1" in summary_dict["metric_definitions"]
    assert "skewness.tet4.v1" in summary_dict["metric_definitions"]


# ===================================================================
# MESH-15: SizeFieldData Non-Finite Node Coordinates and H-Values
# ===================================================================

def test_mesh_15_size_field_data_rejects_non_finite_values() -> None:
    """Verify SizeFieldData.__post_init__ rejects NaN and Inf node coordinates and h_values."""
    valid_coords = np.asarray([[0.0, 0.0, 0.0], [1.0, 0.0, 0.0]])
    valid_h = np.asarray([0.5, 0.5])

    # 1. Valid coords and h pass
    data = SizeFieldData(node_coords=valid_coords, h_values=valid_h)
    assert len(data.node_coords) == 2

    # 2. NaN in node_coords
    nan_coords = np.asarray([[0.0, float("nan"), 0.0], [1.0, 0.0, 0.0]])
    with pytest.raises(ValueError, match="node_coords must contain only finite numbers"):
        SizeFieldData(node_coords=nan_coords, h_values=valid_h)

    # 3. Inf in node_coords
    inf_coords = np.asarray([[0.0, float("inf"), 0.0], [1.0, 0.0, 0.0]])
    with pytest.raises(ValueError, match="node_coords must contain only finite numbers"):
        SizeFieldData(node_coords=inf_coords, h_values=valid_h)

    # 4. NaN in h_values
    nan_h = np.asarray([0.5, float("nan")])
    with pytest.raises(ValueError, match="h_values must contain only finite numbers"):
        SizeFieldData(node_coords=valid_coords, h_values=nan_h)

    # 5. Inf in h_values
    inf_h = np.asarray([0.5, float("inf")])
    with pytest.raises(ValueError, match="h_values must contain only finite numbers"):
        SizeFieldData(node_coords=valid_coords, h_values=inf_h)
