from __future__ import annotations

from unittest.mock import patch

import numpy as np

import fullmag as fm
from fullmag.meshing._gmsh_occ import SharedDomainMeshResult
from fullmag.meshing._gmsh_types import ALGO_3D_DELAUNAY, ALGO_3D_HXT, MeshData, MeshOptions
from fullmag.meshing.asset_pipeline import realize_fem_domain_mesh_asset_from_components_with_report


def _mesh(*, partial_degenerate: bool) -> MeshData:
    nodes = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1e-8, 0.0, 0.0],
            [0.0, 1e-8, 0.0],
            [0.0, 0.0, 1e-8],
            [2e-8, 0.0, 0.0],
            [3e-8, 0.0, 0.0],
            [2e-8, 1e-8, 0.0],
            [3e-8, 1e-8, 0.0] if partial_degenerate else [2e-8, 0.0, 1e-8],
        ],
        dtype=np.float64,
    )
    return MeshData.from_legacy_tet4(
        nodes=nodes,
        elements=np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32),
        element_markers=np.asarray([7, 7], dtype=np.int32),
        boundary_faces=np.empty((0, 3), dtype=np.int32),
        boundary_markers=np.empty((0,), dtype=np.int32),
    )


def _mesh_with_global_only_degenerate_tet(*, degraded: bool) -> MeshData:
    """Build a mesh that only the execution-scale volume policy rejects.

    The first tetrahedron is well above the local characteristic-length
    threshold used by ``MeshData.validate_strict`` but below the Rust
    execution threshold based on the full domain bounding box.
    """
    nodes = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1e-8, 0.0, 0.0],
            [0.0, 1e-8, 0.0],
            [0.0, 0.0, 6e-21 if degraded else 1e-8],
            [5e-7, 0.0, 0.0],
            [1.5e-6, 0.0, 0.0],
            [5e-7, 1e-6, 0.0],
            [5e-7, 0.0, 1e-6],
        ],
        dtype=np.float64,
    )
    return MeshData.from_legacy_tet4(
        nodes=nodes,
        elements=np.asarray([[0, 1, 2, 3], [4, 5, 6, 7]], dtype=np.int32),
        element_markers=np.asarray([7, 7], dtype=np.int32),
        boundary_faces=np.empty((0, 3), dtype=np.int32),
        boundary_markers=np.empty((0,), dtype=np.int32),
    )


def test_partial_degenerate_occ_mesh_retries_instead_of_cutting_topology() -> None:
    calls: list[int] = []

    def fake_occ(*_args: object, **kwargs: object) -> SharedDomainMeshResult:
        options = kwargs["options"]
        assert isinstance(options, MeshOptions)
        calls.append(options.algorithm_3d)
        return SharedDomainMeshResult(
            mesh=_mesh(partial_degenerate=len(calls) == 1),
            component_marker_tags={"left": 7},
            component_volume_tags={"left": [7]},
            component_surface_tags={"left": [1]},
            interface_surface_tags=[1],
            outer_boundary_surface_tags=[2],
        )

    with (
        patch("fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ", side_effect=fake_occ),
        patch(
            "fullmag.meshing.asset_pipeline._drop_degenerate_tetrahedra",
            side_effect=AssertionError("destructive cleanup must not run for conformal OCC"),
        ),
    ):
        mesh, _regions, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[fm.Box((20e-9, 20e-9, 10e-9), name="left")],
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
                "per_geometry": [{"geometry": "left", "mode": "custom", "hmax": 20e-9}],
            },
        )

    assert calls == [ALGO_3D_HXT, ALGO_3D_DELAUNAY]
    assert mesh.n_elements == 2
    assert report.fallbacks_triggered == ["conformal_occ_hxt_degenerate_retry_delaunay"]


def test_execution_scale_degenerate_occ_mesh_retries_before_rust_validation() -> None:
    calls: list[int] = []

    def fake_occ(*_args: object, **kwargs: object) -> SharedDomainMeshResult:
        options = kwargs["options"]
        assert isinstance(options, MeshOptions)
        calls.append(options.algorithm_3d)
        return SharedDomainMeshResult(
            mesh=_mesh_with_global_only_degenerate_tet(degraded=len(calls) == 1),
            component_marker_tags={"left": 7},
            component_volume_tags={"left": [7]},
            component_surface_tags={"left": [1]},
            interface_surface_tags=[1],
            outer_boundary_surface_tags=[2],
        )

    with (
        patch("fullmag.meshing._gmsh_occ.generate_shared_domain_mesh_via_occ", side_effect=fake_occ),
        patch(
            "fullmag.meshing.asset_pipeline._drop_degenerate_tetrahedra",
            side_effect=AssertionError("destructive cleanup must not run for conformal OCC"),
        ),
    ):
        mesh, _regions, report = realize_fem_domain_mesh_asset_from_components_with_report(
            geometries=[fm.Box((20e-9, 20e-9, 10e-9), name="left")],
            hints=fm.FEM(order=1, hmax=80e-9),
            study_universe={
                "mode": "manual",
                "size": [1.5e-6, 1.0e-6, 1.0e-6],
                "center": [0.0, 0.0, 0.0],
                "airbox_hmax": 120e-9,
                "airbox_hmin": 20e-9,
            },
            mesh_workflow={
                "mesh_options": {"algorithm_3d": ALGO_3D_HXT},
                "per_geometry": [{"geometry": "left", "mode": "custom", "hmax": 20e-9}],
            },
        )

    assert calls == [ALGO_3D_HXT, ALGO_3D_DELAUNAY]
    assert mesh.n_elements == 2
    assert report.fallbacks_triggered == ["conformal_occ_hxt_degenerate_retry_delaunay"]
