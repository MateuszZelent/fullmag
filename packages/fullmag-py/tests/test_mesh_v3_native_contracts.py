"""Proposed regression tests against a REAL Fullmag checkout, not executed here.

Reviewed baseline: e1b61dd8be85942885b1f80a7b48ea8a19f8da44.
The two ``test_native_...`` tests require Gmsh; missing Gmsh is deliberately
not converted to a successful skip. Other tests exercise real Python modules,
with fault injection only at the named native generator boundary.

Example from a full checkout:
  PYTHONPATH=packages/fullmag-py/src python -m pytest /path/to/this/file.py -v
"""
from __future__ import annotations

import importlib
import math
from dataclasses import replace
from pathlib import Path
from typing import Any

import numpy as np
import pytest

from fullmag.meshing import asset_pipeline as assets
from fullmag.meshing import _gmsh_generators as generators
from fullmag.meshing import _gmsh_occ as occ
from fullmag.meshing import _gmsh_extraction as extraction
from fullmag.meshing._gmsh_swept import _compute_layer_heights
from fullmag.meshing._gmsh_types import (
    AirboxOptions, MeshData, MeshOptions, MeshRealizationReport, SizeFieldData,
)
from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata
from fullmag.meshing.quality import MeshGrowthValidationError
from fullmag.meshing.remesh_cli import _mesh_result_payload
from fullmag.meshing import fmmq
from fullmag.model.geometry import ArchWaveguide, Box
from fullmag.model.discretization import FEM, PerObjectMeshRecipe


class StopAtGenerator(BaseException):
    """Stop BEFORE native code, without triggering Exception-based fallback."""


def test_native_arch_occ_dispatch_preserves_the_supported_geometry() -> None:
    gmsh = importlib.import_module("gmsh")
    arch = ArchWaveguide(100e-9, 20e-9, 5e-9, 10e-9, name="audit_arch")
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("audit_arch_helper")
        dimtags = generators._add_geometry_to_occ(gmsh, arch, scale=1e6)
        gmsh.model.occ.synchronize()
        assert dimtags
        assert any(dim == 3 for dim, _tag in dimtags)
    finally:
        gmsh.finalize()


def test_native_occ_preserves_aligned_quality_after_si_conversion(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Reverse raw quality tags/channels together, then run actual OCC extraction.

    Reversing both tag and channel arrays preserves the raw report's correctness.
    The extractor must re-align it; the SI conversion must not undo that work.
    """
    importlib.import_module("gmsh")
    real_quality = generators._extract_quality_metrics
    real_extract = extraction._extract_mesh_data
    captured: dict[str, Any] = {}

    def reverse_quality(*args: Any, **kwargs: Any) -> Any:
        q, pdq = real_quality(*args, **kwargs)
        assert q is not None and q.element_tags
        assert len(q.element_tags) > 2
        updates = {}
        for name in ("element_tags", "element_sicn", "element_gamma", "element_volume"):
            values = getattr(q, name)
            updates[name] = None if values is None else list(reversed(values))
        return replace(q, **updates), pdq

    def capture_extract(*args: Any, **kwargs: Any) -> MeshData:
        mesh = real_extract(*args, **kwargs)
        captured["aligned_mesh"] = mesh
        return mesh

    monkeypatch.setattr(generators, "_extract_quality_metrics", reverse_quality)
    monkeypatch.setattr(extraction, "_extract_mesh_data", capture_extract)
    result = occ.generate_shared_domain_mesh_via_occ(
        [Box(40e-9, 30e-9, 20e-9, name="mag")],
        hmax=10e-9,
        order=1,
        options=MeshOptions(compute_quality=True, per_element_quality=True),
        airbox=AirboxOptions(
            size=(160e-9, 120e-9, 100e-9), center=(0., 0., 0.),
            maximum_element_size=25e-9, minimum_element_size=10e-9,
        ),
    )
    aligned = captured["aligned_mesh"]
    final = result.mesh
    assert final.quality is not None and aligned.quality is not None
    assert final.quality.element_tags == aligned.quality.element_tags
    np.testing.assert_array_equal(final.quality.element_sicn, aligned.quality.element_sicn)
    np.testing.assert_array_equal(final.quality.element_gamma, aligned.quality.element_gamma)
    np.testing.assert_allclose(
        final.quality.element_volume,
        np.asarray(aligned.quality.element_volume) / 1e18,
        rtol=1e-11, atol=0.,
    )
    assert final.per_domain_quality is not None and aligned.per_domain_quality is not None
    assert final.per_domain_quality.keys() == aligned.per_domain_quality.keys()
    assert 0 in final.per_domain_quality, "air must keep the semantic marker 0"
    for marker, q in aligned.per_domain_quality.items():
        assert math.isclose(
            final.per_domain_quality[marker].volume_mean,
            q.volume_mean / 1e18, rel_tol=1e-11, abs_tol=0.,
        )


def test_coarsening_runs_strip_even_when_recipe_emits_no_new_field(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}

    def at_generator(*args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        raise StopAtGenerator()

    monkeypatch.setattr(occ, "generate_shared_domain_mesh_via_occ", at_generator)
    geometry = Box(4e-6, 4e-6, 2e-6, name="mag")
    with pytest.raises(StopAtGenerator):
        assets._realize_fem_domain_mesh_asset_from_components_impl(
            [geometry], FEM(order=1, hmax=1e-6),
            study_universe={
                "mode": "manual", "size": [12e-6, 12e-6, 12e-6],
                "center": [0., 0., 0.], "airbox_hmax": 1e-6,
            },
            mesh_workflow={"per_geometry": [{"geometry": "mag", "hmax": 0.5e-6}]},
            per_object_recipes={"mag": PerObjectMeshRecipe(hmax=2e-6)},
        )
    fields = captured["options"].size_fields
    obsolete_bulk = [
        f for f in fields
        if f.get("role") == "bulk"
        and f.get("params", {}).get("GeometryName") == "mag"
        and f.get("params", {}).get("VIn") == 0.5e-6
    ]
    assert not obsolete_bulk
    assert captured["hmax"] >= 2e-6


def test_executor_receives_the_same_strategy_as_the_reported_plan(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, Any] = {}
    events: list[dict[str, Any]] = []

    def at_generator(*args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        raise StopAtGenerator()

    monkeypatch.setattr(assets, "generate_mesh", at_generator)
    monkeypatch.setattr(assets, "emit_progress_event", lambda event: events.append(event))
    with pytest.raises(StopAtGenerator):
        assets._realize_fem_domain_mesh_asset_from_components_impl(
            [Box(1e-6, 1e-6, 1e-6, name="cube")], FEM(order=1, hmax=0.5e-6),
            study_universe={"mode": "manual", "size": [4e-6]*3, "center": [0., 0., 0.]},
            mesh_workflow={"mesh_options": {
                "mesh_strategy": "auto", "through_thickness_elements": 2,
            }},
        )
    plans = [e for e in events if e.get("kind") == "mesh_build_started"]
    assert len(plans) == 1
    if plans[0].get("shared_domain_build_mode") == "single_geometry_geo_mixed":
        assert captured["options"].mesh_strategy == "swept_prism"


def _two_region_pairs() -> MeshData:
    # Two independent face-neighbor pairs with size ratio sqrt(5/2) ~ 1.581.
    pair = np.asarray([
        [0.,0.,0.], [1.,0.,0.], [0.,1.,0.], [0.,0.,1.], [0.,0.,-2.],
    ])
    nodes = np.vstack([pair, pair + [10.,0.,0.]])
    return MeshData(
        nodes=nodes,
        cell_types=["tet4"]*4,
        cell_offsets=[0,4,8,12,16],
        cell_nodes=[0,1,2,3, 0,2,1,4, 5,6,7,8, 5,7,6,9],
        cell_global_ordinals=[0,1,2,3],
        element_markers=[1,1,2,2],
        facet_types=[], facet_roles=[], facet_offsets=[0], facet_nodes=[],
        facet_global_ordinals=[], boundary_markers=[],
    )


@pytest.mark.parametrize("placement", ["root_named", "cli_provenance_shape"])
def test_named_regional_growth_cannot_be_bypassed(
    placement: str, tmp_path: Path,
) -> None:
    regions = [
        {"geometry_name": "film_A", "marker": 1},
        {"geometry_name": "film_B", "marker": 2},
    ]
    per_geometry = [
        {"geometry": "film_A", "growth_rate": 1.4},
        {"geometry": "film_B", "growth_rate": 2.0},
    ]
    provenance = (
        {"per_geometry": per_geometry}
        if placement == "root_named"
        else {"mesh_options": {"per_geometry": per_geometry}}
    )
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            _two_region_pairs(), mesh_name="regional_growth",
            generation_mode="shared_domain_manual_remesh",
            mesh_provenance=provenance, region_markers=regions,
            topology_artifact_dir=tmp_path,
        )
    assert not any(p.is_file() for p in tmp_path.rglob("*"))


@pytest.mark.parametrize("n,ratio,distribution", [
    (2049,2.,"exponential"), (4,1e308,"linear"), (4,1e-30,"linear"),
])
def test_layer_profile_is_valid_or_explicitly_rejected(
    n: int, ratio: float, distribution: str,
) -> None:
    try:
        h = _compute_layer_heights(
            n, 20e-9, distribution=distribution, element_ratio=ratio, symmetric=True,
        )
    except ValueError:
        # A mathematically valid but unrepresentable profile may fail closed.
        return
    h = np.asarray(h)
    assert len(h) == n and np.all(np.isfinite(h)) and np.all(h > 0.)
    assert np.all(np.diff(np.r_[0., np.cumsum(h)]) > 0.)
    assert math.isclose(float(np.sum(h)),1.,rel_tol=1e-12)


def test_current_cylinder_emitter_token_is_understood_by_report() -> None:
    MeshRealizationReport(
        requested_topology="hex8", resolved_topology="tet4",
        requested_layers=2, resolved_layers=2,
        requested_axis="z", resolved_axis="z",
        requested_order=1, resolved_order=1,
        requested_direction="auto",
        fallbacks_triggered=("swept_cylinder_recombined_to_tet4",),
    )


def test_conflicting_nanometre_aliases_are_rejected() -> None:
    with pytest.raises(ValueError, match="conflicting|Conflicting"):
        _mesh_options_from_runtime_metadata(
            {"mesh_options": {"hmin":0.1e-9,"minimum_element_size":0.9e-9}},
            geometries=[Box(10e-9,10e-9,5e-9,name="mag")],
            default_hmax=2e-9, include_size_fields=False,
        )


def test_canonical_uniformity_roundtrips_through_fmmq(tmp_path: Path) -> None:
    metric_id = "edge_length_uniformity.tet4.v1"
    assert fmmq._expected_metric_unit(metric_id) == "1"
    mesh = _two_region_pairs()
    count, identity, metrics = fmmq.build_fmmq_v2_spec(mesh, identity={})
    assert metric_id in metrics
    path = tmp_path / "quality.fmmq"
    fmmq.write_fmmq_v2(path, element_count=count, identity=identity, metrics=metrics)
    channel = fmmq.read_fmmq_v2_metric(path.read_bytes(), metric_id)
    assert channel.unit == "1"
    assert len(channel.values) == 4
    np.testing.assert_array_equal(channel.ordinals, np.arange(4))


def test_scalar_coordinates_produce_shape_validation_error() -> None:
    with pytest.raises(ValueError, match="shape"):
        SizeFieldData(np.asarray(1.), np.asarray([1.]))
