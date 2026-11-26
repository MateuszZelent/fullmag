from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

import fullmag as fm
from fullmag.meshing._gmsh_swept import generate_pure_prism_box_airbox_mesh
from fullmag.meshing._gmsh_types import (
    AirboxOptions,
    MeshData,
    MeshOptions,
    MIXED_QUALITY_METRIC,
    PURE_PRISM_CERT_SCHEMA_VERSION,
    PURE_PRISM_SHARED_GEO_STRATEGY,
)
from fullmag.meshing.asset_pipeline import (
    realize_fem_domain_mesh_asset_from_components_with_report,
)
from fullmag.meshing.persistence import (
    load_mesh_artifact,
    mesh_data_from_ir,
    save_mesh_artifact,
)
from fullmag.model.discretization import FEM, PerObjectMeshRecipe, SweptMeshControls
from fullmag.model.geometry import Box


def _assert_valid_pure_prism_certificate(
    mesh: MeshData,
    *,
    expected_layers: int,
    expected_resolved_axis: str,
    outer_boundary_marker: int,
) -> dict[str, object]:
    assert set(mesh.cell_types.tolist()) == {"prism6"}
    assert set(mesh.facet_types.tolist()) == {"tri3", "quad4"}
    assert mesh.mixed_layer_topology_certificate is None
    cert = mesh.pure_prism_topology_certificate
    assert isinstance(cert, dict)
    assert cert["schema_version"] == PURE_PRISM_CERT_SCHEMA_VERSION
    assert cert["certificate_status"] == "accepted"
    assert cert["resolved_sweep_direction"] == expected_resolved_axis
    assert cert["requested_layer_count"] == expected_layers
    assert cert["realized_layer_count"] == expected_layers
    assert cert["lower_air_layer_count"] >= 1
    assert cert["upper_air_layer_count"] >= 1
    assert len(cert["magnetic_plane_coordinates_m"]) == expected_layers + 1
    assert cert["interface_marker"] == 10
    assert cert["outer_boundary_marker"] == outer_boundary_marker
    assert cert["magnetic_bounds_relative_error"] < 1.0e-8
    assert cert["airbox_bounds_relative_error"] < 1.0e-8
    assert set(cert["cell_family_counts_by_marker"]) == {"0", "1"}
    assert set(cert["cell_family_counts_by_marker"]["0"]) == {"prism6"}
    assert set(cert["cell_family_counts_by_marker"]["1"]) == {"prism6"}
    assert set(cert["cell_family_counts_by_part"]) == {"magnetic", "far_air"}
    assert set(cert["cell_family_counts_by_part"]["magnetic"]) == {"prism6"}
    assert set(cert["cell_family_counts_by_part"]["far_air"]) == {"prism6"}
    expected_facet_keys = {
        "material_interface:10",
        f"exterior:{outer_boundary_marker}",
    }
    assert set(cert["facet_family_counts_by_role_marker"]) == expected_facet_keys
    for key in expected_facet_keys:
        counts = cert["facet_family_counts_by_role_marker"][key]
        assert set(counts) == {"tri3", "quad4"}
        assert counts["tri3"] > 0 and counts["quad4"] > 0
    assert cert["jacobian_minima_m3_by_family"]["prism6"] > 0.0
    assert cert["quality_metric"] == MIXED_QUALITY_METRIC
    assert cert["scaled_jacobian_minima_by_family"]["prism6"] > 0.0
    assert cert["scaled_jacobian_p05_by_family"]["prism6"] >= 0.1
    assert cert["magnetic_relative_volume_error"] < 1.0e-12
    assert cert["shared_domain_relative_volume_error"] < 1.0e-12
    assert cert["marker_coverage_complete"] is True
    assert cert["nonconforming_face_count"] == 0
    assert cert["orphan_face_count"] == 0
    assert cert["nonmanifold_face_count"] == 0
    assert cert["coincident_interface_face_count"] == 0
    assert cert["topology_fingerprint_version"] == "v3"
    assert cert["topology_fingerprint"] == mesh.topology_fingerprint_v3()
    assert cert["strategy"] == PURE_PRISM_SHARED_GEO_STRATEGY
    assert cert["effective_gmsh_thread_count"] == 1
    assert cert["fallbacks_triggered"] == []
    assert isinstance(cert["deterministic_inputs"], dict)
    assert cert["deterministic_inputs"]["element_order"] == 1
    assert cert["deterministic_inputs"]["random_factor"] == 0.0
    assert cert["deterministic_inputs"]["thread_count"] == 1
    return cert


@pytest.mark.parametrize("layers", [1, 2, 3, 4])
def test_pure_prism_thin_film_layers_1_to_4_via_asset_pipeline(layers: int) -> None:
    pytest.importorskip("gmsh")
    film_geom = Box(100.0e-9, 80.0e-9, 5.0e-9, name="film")
    mesh_workflow = {
        "per_geometry": [
            {
                "geometry": "film",
                "mode": "custom",
                "hmax": 10.0e-9,
                "maximum_element_size": 10.0e-9,
                "order": 1,
                "mesh_strategy": "swept_prism",
                "through_thickness_elements": layers,
                "through_thickness_distribution": "fixed",
                "sweep_face_meshing": "triangular",
                "topology": "prismatic",
                "sweep_direction": "auto",
                "element_family": "prism",
                "transition_policy": "pure_prism",
                "exact_layer_count": True,
            }
        ],
        "mesh_options": {
            "mesh_strategy": "swept_prism",
            "through_thickness_elements": layers,
            "through_thickness_distribution": "fixed",
            "sweep_face_meshing": "triangular",
            "sweep_direction": "auto",
            "transition_policy": "pure_prism",
        },
    }
    study_universe = {
        "mode": "manual",
        "size": [300.0e-9, 240.0e-9, 150.0e-9],
        "center": [0.0, 0.0, 0.0],
        "airbox_hmax": 45.0e-9,
        "airbox_growth_rate": 1.5,
        "airbox_grading": "geometric",
    }
    mesh, region_markers, report = realize_fem_domain_mesh_asset_from_components_with_report(
        [film_geom],
        FEM(order=1, maximum_element_size=10.0e-9),
        study_universe=study_universe,
        mesh_workflow=mesh_workflow,
    )
    assert region_markers == [{"geometry_name": "film", "marker": 1}]
    assert report.build_mode == PURE_PRISM_SHARED_GEO_STRATEGY
    assert report.degraded is False
    assert report.fallbacks_triggered == []
    assert report.mixed_layer_topology_certificate is None
    assert report.mixed_layer_topology_certificate_v2 is None
    cert = _assert_valid_pure_prism_certificate(
        mesh,
        expected_layers=layers,
        expected_resolved_axis="z",
        outer_boundary_marker=99,
    )
    assert report.pure_prism_topology_certificate == cert
    assert report.to_dict()["pure_prism_topology_certificate"] == cert


@pytest.mark.parametrize(
    ("box_size", "airbox_size", "requested_direction", "expected_axis"),
    [
        ((5.0e-9, 100.0e-9, 80.0e-9), (150.0e-9, 300.0e-9, 240.0e-9), "auto", "x"),
        ((5.0e-9, 100.0e-9, 80.0e-9), (150.0e-9, 300.0e-9, 240.0e-9), "x", "x"),
        ((80.0e-9, 5.0e-9, 100.0e-9), (240.0e-9, 150.0e-9, 300.0e-9), "y", "y"),
    ],
)
def test_pure_prism_rotated_sweep_axes(
    box_size: tuple[float, float, float],
    airbox_size: tuple[float, float, float],
    requested_direction: str,
    expected_axis: str,
) -> None:
    pytest.importorskip("gmsh")
    airbox = AirboxOptions(
        shape="bbox",
        size=airbox_size,
        center=(0.0, 0.0, 0.0),
        maximum_element_size=45.0e-9,
        grading_ratio=1.5,
        boundary_marker=3,
    )
    mesh = generate_pure_prism_box_airbox_mesh(
        box_size,
        hmax=10.0e-9,
        n_layers=2,
        airbox=airbox,
        thin_axis=int(np.argmin(np.asarray(box_size))),
        requested_direction=requested_direction,
        options=MeshOptions(sweep_direction=requested_direction),
    )
    cert = _assert_valid_pure_prism_certificate(
        mesh,
        expected_layers=2,
        expected_resolved_axis=expected_axis,
        outer_boundary_marker=3,
    )
    assert cert["requested_sweep_direction"] == requested_direction


def test_pure_prism_300x300x5_benchmark_geometry_layers_2() -> None:
    pytest.importorskip("gmsh")
    airbox = AirboxOptions(
        shape="bbox",
        size=(900.0e-9, 900.0e-9, 600.0e-9),
        center=(0.0, 0.0, 0.0),
        maximum_element_size=110.0e-9,
        grading_ratio=1.5,
        boundary_marker=2,
    )
    mesh = generate_pure_prism_box_airbox_mesh(
        (300.0e-9, 300.0e-9, 5.0e-9),
        hmax=5.0e-9,
        n_layers=2,
        airbox=airbox,
        thin_axis=2,
        requested_direction="auto",
    )
    _assert_valid_pure_prism_certificate(
        mesh,
        expected_layers=2,
        expected_resolved_axis="z",
        outer_boundary_marker=2,
    )


def test_pure_prism_persistence_and_ir_roundtrip(tmp_path: Path) -> None:
    pytest.importorskip("gmsh")
    airbox = AirboxOptions(
        shape="bbox",
        size=(240.0e-9, 240.0e-9, 120.0e-9),
        center=(0.0, 0.0, 0.0),
        maximum_element_size=40.0e-9,
        grading_ratio=1.5,
        boundary_marker=2,
    )
    mesh = generate_pure_prism_box_airbox_mesh(
        (80.0e-9, 80.0e-9, 5.0e-9),
        hmax=10.0e-9,
        n_layers=2,
        airbox=airbox,
        thin_axis=2,
        requested_direction="auto",
    )
    expected_cert = mesh.pure_prism_topology_certificate
    assert expected_cert is not None

    # 1. MeshData JSON & NPZ round-trip
    json_path = tmp_path / "pure_prism.json"
    npz_path = tmp_path / "pure_prism.npz"
    mesh.save(json_path)
    mesh.save(npz_path)
    assert MeshData.load(json_path).pure_prism_topology_certificate == expected_cert
    assert MeshData.load(npz_path).pure_prism_topology_certificate == expected_cert

    # 2. MeshIR round-trip
    mesh_ir = mesh.to_ir("pure_prism_study")
    assert mesh_ir["pure_prism_topology_certificate"] == expected_cert
    assert "mixed_layer_topology_certificate" not in mesh_ir
    rehydrated = mesh_data_from_ir(mesh_ir)
    assert rehydrated.pure_prism_topology_certificate == expected_cert

    # 3. Native .fullmag-mesh persistence artifact round-trip
    artifact_path = tmp_path / "pure_prism.fullmag-mesh"
    authoring_doc = {"mesh_strategy": "swept_prism", "transition_policy": "pure_prism", "layers": 2}
    build_report = {
        "build_mode": PURE_PRISM_SHARED_GEO_STRATEGY,
        "degraded": False,
        "fallbacks_triggered": [],
        "pure_prism_topology_certificate": expected_cert,
    }
    save_mesh_artifact(
        artifact_path,
        mesh=mesh,
        mesh_name="pure_prism_study",
        authoring_document=authoring_doc,
        region_markers=[{"geometry_name": "film", "marker": 1}],
        boundary_map={"mag_air_interface": 10, "outer_boundary": 2},
        build_report=build_report,
    )
    loaded = load_mesh_artifact(artifact_path, expected_authoring_document=authoring_doc)
    assert loaded.mesh.pure_prism_topology_certificate == expected_cert
    assert loaded.build_report is not None
    assert loaded.build_report["pure_prism_topology_certificate"] == expected_cert
    assert loaded.topology_fingerprint == mesh.topology_fingerprint_v3()

    # 4. Tampered fingerprint must fail closed
    tampered = dict(expected_cert)
    tampered["topology_fingerprint"] = "sha256:" + "0" * 64
    with pytest.raises(ValueError, match="fingerprint is stale"):
        replace(mesh, pure_prism_topology_certificate=tampered)


def test_pure_prism_dsl_and_discretization_validation() -> None:
    controls = SweptMeshControls(
        element_family="prism",
        transition_policy="pure_prism",
        exact_layer_count=True,
    )
    assert controls.to_ir()["transition_policy"] == "pure_prism"

    with pytest.raises(ValueError, match="contradicts pure_prism"):
        SweptMeshControls(element_family="hex", transition_policy="pure_prism")

    recipe = PerObjectMeshRecipe(
        maximum_element_size=5.0e-9,
        order=1,
        mesh_strategy="swept_prism",
        through_thickness_elements=4,
        through_thickness_distribution="fixed",
        sweep_face_meshing="triangular",
        topology="prismatic",
        sweep_direction="auto",
        element_family="prism",
        transition_policy="pure_prism",
        exact_layer_count=True,
    )
    assert recipe.to_ir()["transition_policy"] == "pure_prism"

    with pytest.raises(ValueError, match="contradicts pure_prism"):
        PerObjectMeshRecipe(
            mesh_strategy="swept_hex",
            through_thickness_elements=2,
            through_thickness_distribution="fixed",
            sweep_face_meshing="quadrilateral",
            sweep_direction="auto",
            element_family="hex",
            transition_policy="pure_prism",
            exact_layer_count=True,
        )

    # DSL thin_film(transition="pure_prism") smoke test via fm.study()
    study = fm.study("pure-prism-dsl")
    study.engine("fem")
    film = study.geometry(fm.Box(100.0e-9, 80.0e-9, 5.0e-9), name="film")
    film.Ms = 800e3
    film.Aex = 13e-12
    film.alpha = 0.01
    film.mesh.thin_film(
        maximum_element_size=10.0e-9,
        layers=4,
        topology="prismatic",
        transition="pure_prism",
        exact_layers=True,
        order=1,
    )
    assert film._mesh_spec.transition_policy == "pure_prism"
    assert film._mesh_spec.through_thickness_elements == 4
