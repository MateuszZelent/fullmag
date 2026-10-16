"""Real-Gmsh regression for body-only exact-layer Box Tet4 meshes."""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "packages/fullmag-py/src"))

import fullmag as fm
from fullmag.meshing import generate_mesh
from fullmag.meshing import _gmsh_swept
from fullmag.meshing.asset_pipeline import (
    realize_fem_domain_mesh_asset_from_components_with_report,
)
from fullmag.meshing._gmsh_types import MeshOptions
from fullmag.model.geometry import Box


_SIZE_M = (40.0e-9, 32.0e-9, 10.0e-9)
_LAYERS = 3
_PLANE_TOLERANCE_M = 1.0e-15


def _body_only_options(
    *,
    periodic_pair_ids: tuple[str, ...] = (),
    size_fields: list[dict[str, object]] | None = None,
) -> MeshOptions:
    return MeshOptions(
        mesh_strategy="thin_film_tetrahedral",
        through_thickness_elements=_LAYERS,
        periodic_pair_ids=list(periodic_pair_ids),
        size_fields=list(size_fields or []),
        compute_quality=False,
        per_element_quality=False,
    )


def _assert_exact_body_tet4(mesh, *, layers: int = _LAYERS) -> None:
    mesh.validate_strict(require_positive_orientation=True)
    assert set(mesh.cell_types.tolist()) == {"tet4"}
    assert set(mesh.facet_types.tolist()) == {"tri3"}
    assert set(np.asarray(mesh.element_markers, dtype=np.int32).tolist()) == {1}

    nodes = np.asarray(mesh.nodes, dtype=np.float64)
    cells = np.asarray(mesh.elements, dtype=np.int32)
    expected_planes = np.linspace(-0.5 * _SIZE_M[2], 0.5 * _SIZE_M[2], layers + 1)
    body_nodes = np.unique(cells.reshape(-1))
    body_z = nodes[body_nodes, 2]
    distance = np.min(np.abs(body_z[:, None] - expected_planes[None, :]), axis=1)
    assert np.all(distance <= _PLANE_TOLERANCE_M)
    assert all(
        np.any(np.abs(body_z - plane) <= _PLANE_TOLERANCE_M)
        for plane in expected_planes
    )

    tetrahedra = nodes[cells]
    for plane in expected_planes[1:-1]:
        crossing = (tetrahedra[:, :, 2].min(axis=1) < plane - _PLANE_TOLERANCE_M) & (
            tetrahedra[:, :, 2].max(axis=1) > plane + _PLANE_TOLERANCE_M
        )
        assert not np.any(crossing), f"tetrahedron crosses requested plane z={plane:.17g} m"
    centroids_z = tetrahedra[:, :, 2].mean(axis=1)
    for lower, upper in zip(expected_planes[:-1], expected_planes[1:], strict=True):
        assert np.any((centroids_z >= lower) & (centroids_z <= upper))

    signed_volumes = np.linalg.det(tetrahedra[:, 1:] - tetrahedra[:, :1]) / 6.0
    assert np.all(np.isfinite(signed_volumes))
    assert np.all(signed_volumes > 0.0)
    assert float(np.sum(signed_volumes)) == pytest.approx(
        float(np.prod(_SIZE_M)), rel=1.0e-12, abs=0.0
    )


@pytest.mark.parametrize("periodic_pair_ids", [(), ("x_faces", "y_faces")])
def test_body_only_box_thin_film_realizes_exact_tet4_layers(periodic_pair_ids) -> None:
    pytest.importorskip("gmsh")
    geometry = Box(size=_SIZE_M, name="body_only_box")

    mesh = generate_mesh(
        geometry,
        hmax=10.0e-9,
        order=1,
        airbox=None,
        options=_body_only_options(periodic_pair_ids=periodic_pair_ids),
    )

    _assert_exact_body_tet4(mesh)
    if periodic_pair_ids:
        certificate = mesh.periodic_mesh_certificate
        assert certificate is not None
        assert certificate["certificate_status"] == "accepted"
        assert {
            str(pair["pair_id"]) for pair in mesh.periodic_boundary_pairs
        } == set(periodic_pair_ids)
        expected_translations = {
            "x_faces": np.asarray([_SIZE_M[0], 0.0, 0.0]),
            "y_faces": np.asarray([0.0, _SIZE_M[1], 0.0]),
        }
        for pair in mesh.periodic_boundary_pairs:
            np.testing.assert_allclose(
                np.asarray(pair["translation"], dtype=np.float64),
                expected_translations[str(pair["pair_id"])],
                rtol=0.0,
                atol=1.0e-15,
            )
    else:
        assert mesh.periodic_boundary_pairs == []
        assert mesh.periodic_node_pairs == []
        assert mesh.periodic_mesh_certificate is None


def test_public_mesh_pipeline_reports_body_only_owner_fields_without_airbox() -> None:
    pytest.importorskip("gmsh")
    geometry = Box(size=_SIZE_M, name="body_only_field_box")
    mesh, region_markers, report = (
        realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[geometry],
            hints=fm.FEM(order=1, hmax=10.0e-9),
            study_universe=None,
            mesh_workflow={
                "mesh_options": {
                    "mesh_strategy": "thin_film_tetrahedral",
                    "through_thickness_elements": _LAYERS,
                    "compute_quality": False,
                    "per_element_quality": False,
                    "size_fields": [
                        {
                            "kind": "ComponentVolumeConstant",
                            "params": {
                                "GeometryName": geometry.geometry_name,
                                "VIn": 10.0e-9,
                                "VOut": 20.0e-9,
                            },
                        },
                        {
                            "kind": "ComponentRestrictedBox",
                            "params": {
                                "GeometryName": geometry.geometry_name,
                                "VIn": 5.0e-9,
                                "VOut": 20.0e-9,
                                "XMin": -10.0e-9,
                                "XMax": 10.0e-9,
                                "YMin": -10.0e-9,
                                "YMax": 10.0e-9,
                                "ZMin": -0.5 * _SIZE_M[2],
                                "ZMax": 0.5 * _SIZE_M[2],
                            },
                        },
                    ],
                }
            },
        )
    )

    _assert_exact_body_tet4(mesh)
    assert region_markers == [{"geometry_name": geometry.geometry_name, "marker": 1}]
    assert report.build_mode == "single_geometry_geo_body_only_layered_box"
    thin_film = next(
        status
        for status in report.operation_statuses
        if status.kind == "thin_film" and status.scope == geometry.geometry_name
    )
    assert thin_film.status == "applied"
    assert thin_film.actual_method == "geo_body_only_layer_partitioned_tetrahedral"
    assert thin_film.details["resolved_sweep_direction"] == "z"
    assert thin_film.details["airbox_present"] is False
    assert thin_film.details["body_only_domain"] is True
    assert thin_film.details["layer_mesh_mode"] == "geo_extruded_triangular_source_tet4"
    assert thin_film.details["layer_planes_realized"] is True
    assert thin_film.details["resolved_layer_partitions"] == _LAYERS
    owner_fields = [
        field
        for field in report.to_dict()["size_fields_realized"]
        if field.get("target") == geometry.geometry_name
    ]
    assert {field["kind"] for field in owner_fields} == {
        "ComponentVolumeConstant",
        "ComponentRestrictedBox",
    }
    assert all(field["status"] == "applied" for field in owner_fields)


def test_body_only_box_keeps_lateral_minimum_independent_of_layer_thickness() -> None:
    pytest.importorskip("gmsh")
    geometry = Box(size=_SIZE_M, name="body_only_lateral_minimum_box")
    mesh = generate_mesh(
        geometry,
        hmax=10.0e-9,
        order=1,
        airbox=None,
        options=MeshOptions(
            mesh_strategy="thin_film_tetrahedral",
            through_thickness_elements=_LAYERS,
            hmin=8.0e-9,
            compute_quality=False,
            per_element_quality=False,
        ),
    )
    _assert_exact_body_tet4(mesh)


def test_body_only_box_accepts_volume_wide_owner_lower_bound() -> None:
    pytest.importorskip("gmsh")
    geometry = Box(size=_SIZE_M, name="body_only_lower_bound_box")
    lower_bound = {
        "kind": "ComponentVolumeLowerBound",
        "params": {
            "GeometryName": geometry.geometry_name,
            "MinimumElementSize": 4.0e-9,
        },
    }

    mesh = generate_mesh(
        geometry,
        hmax=10.0e-9,
        order=1,
        airbox=None,
        options=MeshOptions(
            mesh_strategy="thin_film_tetrahedral",
            through_thickness_elements=_LAYERS,
            lower_bound_fields=[lower_bound],
            compute_quality=False,
            per_element_quality=False,
        ),
    )

    _assert_exact_body_tet4(mesh)
    assert lower_bound["_gmsh_status"] == "applied"


@pytest.mark.parametrize(
    ("options", "error_text"),
    [
        (
            MeshOptions(
                mesh_strategy="thin_film_tetrahedral",
                through_thickness_elements=_LAYERS,
                sweep_direction="x",
            ),
            "only the z sweep direction",
        ),
        (
            MeshOptions(
                mesh_strategy="thin_film_tetrahedral",
                through_thickness_elements=_LAYERS,
                size_fields=[
                    {
                        "kind": "ComponentRestrictedBox",
                        "params": {
                            "GeometryName": "invalid_body_only_box",
                            "VIn": 5.0e-9,
                            "VOut": 20.0e-9,
                            "XMin": -10.0e-9,
                            "XMax": 10.0e-9,
                            "YMin": -10.0e-9,
                            "YMax": 10.0e-9,
                            "ZMin": -2.0e-9,
                            "ZMax": 2.0e-9,
                        },
                    }
                ],
            ),
            "does not span the full film thickness",
        ),
    ],
)
def test_body_only_box_rejects_unsupported_scope_before_gmsh(
    monkeypatch, options: MeshOptions, error_text: str
) -> None:
    monkeypatch.setattr(
        _gmsh_swept,
        "_import_gmsh",
        lambda: pytest.fail("invalid body-only request must fail before Gmsh initialization"),
    )
    geometry = Box(size=_SIZE_M, name="invalid_body_only_box")
    with pytest.raises(ValueError, match=error_text):
        generate_mesh(
            geometry,
            hmax=10.0e-9,
            order=1,
            airbox=None,
            options=options,
        )
