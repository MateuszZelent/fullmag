"""Regression tests for audit v4 findings (8FD-01 through 8FD-05, OBS-02, OBS-03).

Run with PYTHONPATH=packages/fullmag-py/src.
"""
from __future__ import annotations

import importlib
import json
import math
import os
from pathlib import Path
import shutil
import subprocess
from typing import Any

import numpy as np
import pytest

from fullmag.meshing import asset_pipeline as assets, _gmsh_occ as occ, fmmq
from fullmag.meshing import _gmsh_generators as generators
from fullmag.meshing._gmsh_types import MeshData, AirboxOptions, MeshOptions
from fullmag.meshing._size_field_plan import _mesh_options_from_runtime_metadata
from fullmag.meshing.quality import (
    MeshGrowthValidationError,
    measure_adjacent_size_growth,
    validate_adjacent_size_growth,
)
from fullmag.meshing.remesh_cli import _mesh_result_payload
from fullmag.model.discretization import FEM, PerObjectMeshRecipe
from fullmag.model.geometry import Box, Translate, ArchWaveguide


class StopAtGenerator(BaseException):
    """Audit sentinel, not swallowed by the Exception-based fallback."""


def repo_root() -> Path:
    candidate = Path(os.environ.get("FULLMAG_REPO", Path.cwd())).resolve()
    if not (candidate / "packages/fullmag-py/src/fullmag").is_dir():
        raise RuntimeError("Run from the Fullmag repository root or set FULLMAG_REPO.")
    return candidate


def neighboring_tets() -> MeshData:
    return MeshData(
        nodes=np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.], [0., 0., -2.]]),
        cell_types=["tet4", "tet4"],
        cell_offsets=[0, 4, 8],
        cell_nodes=[0, 1, 2, 3, 0, 2, 1, 4],
        cell_global_ordinals=[0, 1],
        element_markers=[1, 1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        facet_global_ordinals=[],
        boundary_markers=[],
    )


def single_cell_tet() -> MeshData:
    return MeshData(
        nodes=np.array([[0., 0., 0.], [1., 0., 0.], [0., 1., 0.], [0., 0., 1.]]),
        cell_types=["tet4"],
        cell_offsets=[0, 4],
        cell_nodes=[0, 1, 2, 3],
        cell_global_ordinals=[0],
        element_markers=[1],
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        facet_global_ordinals=[],
        boundary_markers=[],
    )


# ---------------------------------------------------------------------------
# 8FD-01: FMMQ Python -> TypeScript & Rust codec contract
# ---------------------------------------------------------------------------

def test_python_fmmq_can_be_decoded_by_actual_typescript_codec(tmp_path: Path) -> None:
    """Unlike a Python->Python roundtrip, this checks the frontend consumer."""
    node = shutil.which("node")
    assert node, "Node.js is required for this cross-language contract test."
    mesh = neighboring_tets()
    count, identity, metrics = fmmq.build_fmmq_v2_spec(mesh, identity={})
    file_path = tmp_path / "new_metric.fmmq"
    fmmq.write_fmmq_v2(file_path, element_count=count, identity=identity, metrics=metrics)
    codec = repo_root() / "apps/control-room/src/kernel/api/codecs/meshQualityDataCodec.ts"
    driver = tmp_path / "decode.mjs"
    driver.write_text(
        """import {readFileSync} from "node:fs";
import {pathToFileURL} from "node:url";
const {decodeMeshQualityData}=await import(pathToFileURL(process.argv[2]).href);
const b=readFileSync(process.argv[3]);
const a=b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength);
const result=decodeMeshQualityData(a);
console.log(JSON.stringify(result.metrics.map(m=>m.id)));
""",
        encoding="utf-8",
    )
    proc = subprocess.run(
        [node, "--experimental-strip-types", str(driver), str(codec), str(file_path)],
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert proc.returncode == 0, proc.stdout + "\n" + proc.stderr
    metric_ids = json.loads(proc.stdout)
    assert "edge_length_uniformity.tet4.v1" in metric_ids


# ---------------------------------------------------------------------------
# 8FD-02: Preflight knows explicit recipes and does not overwrite intent
# ---------------------------------------------------------------------------

def test_recipe_swept_intent_is_not_downgraded_by_global_preflight(monkeypatch: pytest.MonkeyPatch) -> None:
    """This currently-unqualified combination must fail BEFORE native code."""
    def stop(*args: Any, **kwargs: Any) -> None:
        raise StopAtGenerator(f"Reached generator with {kwargs.get('options')!r}")

    monkeypatch.setattr(occ, "generate_shared_domain_mesh_via_occ", stop)
    monkeypatch.setattr(assets, "generate_mesh", stop)
    geometry = Box(100e-9, 40e-9, 5e-9, name="film")
    recipe = PerObjectMeshRecipe(
        mesh_strategy="swept_prism",
        through_thickness_elements=2,
        through_thickness_distribution="fixed",
        sweep_face_meshing="triangular",
        sweep_direction="z",
        element_family="prism",
        transition_policy="pyramid_to_tetrahedra",
        exact_layer_count=True,
    )
    with pytest.raises(ValueError, match="qualified|unsupported"):
        assets._realize_fem_domain_mesh_asset_from_components_impl(
            [geometry],
            FEM(order=1, hmax=10e-9),
            study_universe={"mode": "manual", "size": [400e-9, 200e-9, 100e-9], "center": [0., 0., 0.]},
            mesh_workflow={"mesh_options": {"mesh_strategy": "free_tetrahedral"}},
            per_object_recipes={"film": recipe},
        )


# ---------------------------------------------------------------------------
# 8FD-03: Coarsening: independent limits and inherited defaults preserved
# ---------------------------------------------------------------------------

def test_coarser_recipes_keep_independent_limits_at_executor(monkeypatch: pytest.MonkeyPatch) -> None:
    """Use no workflow bulk fields: neither recipe may disappear silently."""
    captured: dict[str, Any] = {}

    def stop(*args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        raise StopAtGenerator()

    monkeypatch.setattr(occ, "generate_shared_domain_mesh_via_occ", stop)
    a = Box(8e-6, 8e-6, 2e-6, name="A")
    b = Translate(geometry=Box(8e-6, 8e-6, 2e-6, name="B_base"), offset=(20e-6, 0., 0.), name="B")
    with pytest.raises(StopAtGenerator):
        assets._realize_fem_domain_mesh_asset_from_components_impl(
            [a, b],
            FEM(order=1, hmax=1e-6),
            study_universe={
                "mode": "manual",
                "size": [60e-6, 30e-6, 20e-6],
                "center": [10e-6, 0., 0.],
                "airbox_hmax": 1e-6,
            },
            per_object_recipes={
                "A": PerObjectMeshRecipe(hmax=2e-6),
                "B": PerObjectMeshRecipe(hmax=3e-6),
            },
        )
    fields = captured["options"].size_fields
    assert captured["hmax"] >= 3e-6
    assert any(
        f.get("params", {}).get("GeometryName") == "A" and f.get("params", {}).get("VIn") == 2e-6
        for f in fields
    ), fields


def test_coarser_recipe_preserves_default_limit_for_other_object(monkeypatch: pytest.MonkeyPatch) -> None:
    """When object A has a coarser recipe (2e-6) and object B inherits default (1e-6), B must retain cap."""
    captured: dict[str, Any] = {}

    def stop(*args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        raise StopAtGenerator()

    monkeypatch.setattr(occ, "generate_shared_domain_mesh_via_occ", stop)
    a = Box(8e-6, 8e-6, 2e-6, name="A")
    b = Translate(geometry=Box(8e-6, 8e-6, 2e-6, name="B_base"), offset=(20e-6, 0., 0.), name="B")
    with pytest.raises(StopAtGenerator):
        assets._realize_fem_domain_mesh_asset_from_components_impl(
            [a, b],
            FEM(order=1, hmax=1e-6),
            study_universe={
                "mode": "manual",
                "size": [60e-6, 30e-6, 20e-6],
                "center": [10e-6, 0., 0.],
                "airbox_hmax": 1e-6,
            },
            per_object_recipes={"A": PerObjectMeshRecipe(hmax=2e-6)},
        )
    fields = captured["options"].size_fields
    assert captured["hmax"] >= 2e-6
    assert any(
        f.get("params", {}).get("GeometryName") == "B" and f.get("params", {}).get("VIn") == 1e-6
        for f in fields
    ), fields


# ---------------------------------------------------------------------------
# 8FD-04: Regional growth geometry aliases and unmatched scope validation
# ---------------------------------------------------------------------------

def test_canonical_geometry_alias_preserves_regional_growth(tmp_path: Path) -> None:
    geometry = Box(10., 10., 10., name="film_geom")
    workflow = {"per_geometry": [{"geometry": "film", "growth_rate": 1.4}]}
    _mesh_options_from_runtime_metadata(
        workflow, geometries=[geometry], default_hmax=2., include_size_fields=False
    )
    with pytest.raises(MeshGrowthValidationError):
        _mesh_result_payload(
            neighboring_tets(),
            mesh_name="alias",
            generation_mode="shared_domain_manual_remesh",
            mesh_provenance={"growth_rate": 2., **workflow},
            region_markers=[{"geometry_name": "film_geom", "marker": 1}],
            topology_artifact_dir=tmp_path,
        )
    assert not any(p.is_file() for p in tmp_path.rglob("*"))


def test_unmapped_growth_scope_rejected_when_markers_present(tmp_path: Path) -> None:
    """An unknown geometry scope cannot silently fall back to global default."""
    with pytest.raises(ValueError, match="unmapped_growth_scope"):
        _mesh_result_payload(
            neighboring_tets(),
            mesh_name="unmapped",
            generation_mode="shared_domain_manual_remesh",
            mesh_provenance={"per_geometry": [{"geometry": "completely_unknown_geom", "growth_rate": 1.4}]},
            region_markers=[{"geometry_name": "film_geom", "marker": 1}],
            topology_artifact_dir=tmp_path,
        )


def test_conflicting_alias_growth_rates_rejected(tmp_path: Path) -> None:
    """Conflicting growth rates for two aliases that resolve to the same marker must be rejected."""
    with pytest.raises(ValueError, match="Conflicting growth rate"):
        _mesh_result_payload(
            neighboring_tets(),
            mesh_name="conflict",
            generation_mode="shared_domain_manual_remesh",
            mesh_provenance={
                "per_geometry": [
                    {"geometry": "film", "growth_rate": 1.4},
                    {"geometry": "film_geom", "growth_rate": 1.8},
                ]
            },
            region_markers=[{"geometry_name": "film_geom", "marker": 1}],
            topology_artifact_dir=tmp_path,
        )


def test_workflow_size_field_vin_updates_effective_hmax(monkeypatch: pytest.MonkeyPatch) -> None:
    """A workflow size field with coarse VIn must update effective_hmax."""
    captured: dict[str, Any] = {}

    def stop(*args: Any, **kwargs: Any) -> None:
        captured.update(kwargs)
        raise StopAtGenerator()

    monkeypatch.setattr(occ, "generate_shared_domain_mesh_via_occ", stop)
    a = Box(8e-6, 8e-6, 2e-6, name="A")
    with pytest.raises(StopAtGenerator):
        assets._realize_fem_domain_mesh_asset_from_components_impl(
            [a],
            FEM(order=1, hmax=1e-6),
            study_universe={
                "mode": "manual",
                "size": [60e-6, 30e-6, 20e-6],
                "center": [10e-6, 0., 0.],
                "airbox_hmax": 1e-6,
            },
            mesh_workflow={
                "mesh_options": {
                    "size_fields": [
                        {"kind": "Box", "params": {"VIn": 4.5e-6, "VOut": 1e-5}}
                    ]
                }
            },
        )
    assert captured["hmax"] >= 4.5e-6


def test_shared_golden_fmmq_v2_matches_verification() -> None:
    """The shared golden 4-family FMMQ file validates with exactly 22 metrics and all 4 uniformity channels."""
    golden_path = repo_root() / "crates/fullmag-api/resources/golden_4family_fmmq_v2.fmmq"
    assert golden_path.is_file(), f"Golden file missing: {golden_path}"
    payload = golden_path.read_bytes()
    verification = fmmq.verify_fmmq_v2(payload)
    assert verification.element_count == 4
    assert len(verification.metric_ids) == 22
    for family in ("tet4", "prism6", "pyramid5", "hex8"):
        assert f"edge_length_uniformity.{family}.v1" in verification.metric_ids


# ---------------------------------------------------------------------------
# 8FD-05: Pair growth rate commutativity across cell storage order
# ---------------------------------------------------------------------------

def mixed_pair(reverse: bool) -> MeshData:
    nodes = np.array([[-1., -1., 0.], [1., -1., 0.], [1., 1., 0.], [-1., 1., 0.], [0., 0., 1.], [0., -3.2, 1.]])
    cells = [("tet4", [0, 1, 4, 5], 0), ("pyramid5", [0, 1, 2, 3, 4], 1)]
    if reverse:
        cells.reverse()
    offsets = [0]
    flat = []
    for _, conn, _ in cells:
        flat.extend(conn)
        offsets.append(len(flat))
    return MeshData(
        nodes=nodes,
        cell_types=[c[0] for c in cells],
        cell_offsets=offsets,
        cell_nodes=flat,
        cell_global_ordinals=[c[2] for c in cells],
        element_markers=[0, 0],
        cell_mesh_parts=["transition_air"] * 2,
        facet_types=[],
        facet_roles=[],
        facet_offsets=[0],
        facet_nodes=[],
        facet_global_ordinals=[],
        boundary_markers=[],
    )


def test_growth_verdict_is_independent_of_mixed_cell_storage_order() -> None:
    rates = {"tet4|marker:0|role:transition_air": 1.4, "pyramid5|marker:0|role:transition_air": 2.}
    left = measure_adjacent_size_growth(mixed_pair(False), scope_growth_rates=rates)
    right = measure_adjacent_size_growth(mixed_pair(True), scope_growth_rates=rates)
    assert left.evaluated_pair_count == right.evaluated_pair_count == 1
    assert math.isclose(left.ratio_max, 1.6)
    assert left.is_valid == right.is_valid
    assert left.violation_count == right.violation_count
    assert left.worst_pairs[0].allowed_ratio == right.worst_pairs[0].allowed_ratio


# ---------------------------------------------------------------------------
# OBS-03: Single-cell mesh and explicit evaluation status
# ---------------------------------------------------------------------------

def test_single_cell_mesh_growth_evaluation_status_not_applicable() -> None:
    mesh = single_cell_tet()
    report = validate_adjacent_size_growth(mesh, resolved_growth_rate=1.4, require_pairs=False)
    assert report.is_valid is True
    assert report.evaluated_pair_count == 0
    assert report.evaluation_status == "not_applicable"
    assert report.to_dict()["evaluation_status"] == "not_applicable"


# ---------------------------------------------------------------------------
# Curved ArchWaveguide shared OCC volume vs CAD mass oracle
# ---------------------------------------------------------------------------

def test_nonflat_arch_shared_occ_volume_matches_cad_mass() -> None:
    """Qualification extension, not a failure established in this audit.

    The current new full meshing test uses arch_height=0. This additionally
    tests a curved arch; CAD mass is the oracle, not the flat box formula.
    """
    gmsh = importlib.import_module("gmsh")
    arch = ArchWaveguide(100e-9, 20e-9, 5e-9, 10e-9, name="curved_arch")
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        gmsh.model.add("reference_mass")
        entities = generators._add_geometry_to_occ(gmsh, arch, scale=1e6)
        gmsh.model.occ.synchronize()
        expected = sum(gmsh.model.occ.getMass(dim, tag) for dim, tag in entities if dim == 3) / 1e18
    finally:
        gmsh.finalize()
    result = occ.generate_shared_domain_mesh_via_occ(
        [arch],
        hmax=4e-9,
        order=1,
        airbox=AirboxOptions(
            size=(300e-9, 100e-9, 100e-9),
            center=(0., 0., 0.),
            maximum_element_size=30e-9,
            minimum_element_size=8e-9,
        ),
        options=MeshOptions(compute_quality=True, per_element_quality=True),
    )
    mesh = result.mesh
    assert mesh.quality is not None
    measured = float(np.asarray(mesh.quality.element_volume)[np.asarray(mesh.element_markers) == 1].sum())
    assert expected > 0 and math.isclose(measured, expected, rel_tol=0.02)
