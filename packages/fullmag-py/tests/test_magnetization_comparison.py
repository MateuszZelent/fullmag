from __future__ import annotations

import json
from pathlib import Path

import numpy as np
import pytest

from fullmag.analysis.magnetization_comparison import (
    CartesianGrid,
    MagnetizationComparisonError,
    compare_magnetization_textures,
    compare_relaxed_states,
    load_mumax_magnetization,
)
from fullmag.analysis.fem_cartesian_restriction import (
    build_prism6_cartesian_restriction,
    build_tet4_cartesian_restriction,
    sample_fem_tet4_cartesian_centers,
    restrict_fem_magnetization,
)
from fullmag.meshing.gmsh_bridge import MeshData
from fullmag.init.state_io import save_magnetization
from fullmag.meshing.persistence import save_mesh_artifact


def _square_prism_mesh() -> MeshData:
    nodes = np.asarray(
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
    )
    cells = np.asarray(
        [0, 1, 2, 4, 5, 6, 0, 2, 3, 4, 6, 7],
        dtype=np.int32,
    )
    return MeshData(
        nodes=nodes,
        cell_types=np.asarray(["prism6", "prism6"]),
        cell_offsets=np.asarray([0, 6, 12]),
        cell_nodes=cells,
        element_markers=np.asarray([1, 1], dtype=np.int32),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0], dtype=np.int64),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0, 1], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
        cell_mesh_parts=np.asarray(["magnetic", "magnetic"]),
    )


def _unit_tetra_mesh() -> MeshData:
    nodes = np.asarray(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    return MeshData(
        nodes=nodes,
        cell_types=np.asarray(["tet4"]),
        cell_offsets=np.asarray([0, 4]),
        cell_nodes=np.asarray([0, 1, 2, 3], dtype=np.int32),
        element_markers=np.asarray([1], dtype=np.int32),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0], dtype=np.int64),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
        cell_mesh_parts=np.asarray(["magnetic"]),
    )


def test_tet4_center_sampling_interpolates_affine_field_and_masks_outside() -> None:
    mesh = _unit_tetra_mesh()
    grid = CartesianGrid(
        shape_zyx=(1, 2, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(1.0, 1.0, 0.5),
    )
    nodal_values = np.column_stack(
        [
            mesh.nodes[:, 0] + mesh.nodes[:, 1] + mesh.nodes[:, 2],
            mesh.nodes[:, 0],
            mesh.nodes[:, 1],
        ]
    )

    texture = sample_fem_tet4_cartesian_centers(mesh, nodal_values, grid)

    assert texture.metadata["method"] == "tet4_cartesian_center_barycentric_v1"
    assert texture.values.shape == (1, 1, 2, 2, 3)
    assert texture.values.mask[0, 0, 0, 1].all()
    assert texture.values.mask[0, 0, 1, 0].all()
    assert texture.values.mask[0, 0, 1, 1].all()
    np.testing.assert_allclose(texture.values[0, 0, 0, 0], [0.75, 0.25, 0.25])


def test_tet4_volume_restriction_preserves_affine_integral() -> None:
    mesh = _unit_tetra_mesh()
    grid = CartesianGrid(
        shape_zyx=(2, 2, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(1.0, 1.0, 1.0),
    )
    nodal_values = np.column_stack(
        [
            mesh.nodes[:, 0] + mesh.nodes[:, 1] + mesh.nodes[:, 2],
            mesh.nodes[:, 0],
            mesh.nodes[:, 1],
        ]
    )

    restriction = build_tet4_cartesian_restriction(mesh, grid)
    texture = restrict_fem_magnetization(nodal_values, restriction)
    conservation = restriction.conservation(nodal_values)

    assert restriction.metadata["method"] == "exact_tet4_p1_volume_restriction_v1"
    np.testing.assert_allclose(restriction.magnetic_volume, 1.0 / 6.0, rtol=0.0, atol=1.0e-12)
    np.testing.assert_allclose(conservation["projected_volume_m3"], 1.0 / 6.0, rtol=0.0, atol=1.0e-12)
    np.testing.assert_allclose(conservation["volume_relative_error"], 0.0, rtol=0.0, atol=1.0e-12)
    np.testing.assert_allclose(conservation["integral_absolute_error"], [0.0, 0.0, 0.0], rtol=0.0, atol=1.0e-12)
    assert texture.values.shape == (1, 2, 2, 2, 3)
    assert np.count_nonzero(~np.ma.getmaskarray(texture.values[..., 0])) > 0


def test_cartesian_restriction_is_exact_for_an_affine_prism_field() -> None:
    mesh = _square_prism_mesh()
    grid = CartesianGrid(
        shape_zyx=(1, 2, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(1.0, 1.0, 1.0),
    )
    nodal_values = np.column_stack(
        [mesh.nodes[:, 0] + mesh.nodes[:, 1], mesh.nodes[:, 0], mesh.nodes[:, 1]]
    )

    restriction = build_prism6_cartesian_restriction(mesh, grid)
    texture = restrict_fem_magnetization(nodal_values, restriction)

    expected = np.asarray(
        [
            [[0.5, 0.25, 0.25], [1.0, 0.75, 0.25]],
            [[1.0, 0.25, 0.75], [1.5, 0.75, 0.75]],
        ],
        dtype=np.float64,
    )
    assert texture.values.shape == (1, 1, 2, 2, 3)
    np.testing.assert_allclose(texture.values[0, 0], expected)
    np.testing.assert_allclose(restriction.coverage, 1.0)
    assert restriction.conservation(nodal_values)["volume_relative_error"] < 1e-14


def test_cartesian_restriction_accepts_si_scale_prism_geometry() -> None:
    mesh = _square_prism_mesh()
    scale = 1.0e-9
    mesh = MeshData(
        nodes=mesh.nodes * scale,
        cell_types=mesh.cell_types,
        cell_offsets=mesh.cell_offsets,
        cell_nodes=mesh.cell_nodes,
        element_markers=mesh.element_markers,
        facet_types=mesh.facet_types,
        facet_roles=mesh.facet_roles,
        facet_offsets=mesh.facet_offsets,
        facet_nodes=mesh.facet_nodes,
        boundary_markers=mesh.boundary_markers,
        cell_global_ordinals=mesh.cell_global_ordinals,
        facet_global_ordinals=mesh.facet_global_ordinals,
        cell_mesh_parts=mesh.cell_mesh_parts,
    )
    grid = CartesianGrid(
        shape_zyx=(1, 2, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(scale, scale, scale),
    )

    restriction = build_prism6_cartesian_restriction(mesh, grid)

    np.testing.assert_allclose(restriction.coverage, 1.0)


def test_cartesian_restriction_integrates_clipped_quadrilateral_exactly() -> None:
    nodes = np.asarray(
        [
            [0.1, 0.1, 0.0],
            [1.3, 0.2, 0.0],
            [0.2, 1.4, 0.0],
            [0.1, 0.1, 1.0],
            [1.3, 0.2, 1.0],
            [0.2, 1.4, 1.0],
        ],
        dtype=np.float64,
    )
    mesh = MeshData(
        nodes=nodes,
        cell_types=np.asarray(["prism6"]),
        cell_offsets=np.asarray([0, 6]),
        cell_nodes=np.arange(6, dtype=np.int32),
        element_markers=np.asarray([1], dtype=np.int32),
        facet_types=np.asarray([], dtype=np.str_),
        facet_roles=np.asarray([], dtype=np.str_),
        facet_offsets=np.asarray([0], dtype=np.int64),
        facet_nodes=np.asarray([], dtype=np.int32),
        boundary_markers=np.asarray([], dtype=np.int32),
        cell_global_ordinals=np.asarray([0], dtype=np.int64),
        facet_global_ordinals=np.asarray([], dtype=np.int64),
        cell_mesh_parts=np.asarray(["magnetic"]),
    )
    grid = CartesianGrid(
        shape_zyx=(1, 2, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(1.5, 1.5, 1.0),
    )
    nodal_values = np.column_stack(
        [nodes[:, 0] + 2.0 * nodes[:, 1], nodes[:, 0], nodes[:, 1]]
    )

    restriction = build_prism6_cartesian_restriction(mesh, grid)
    conservation = restriction.conservation(nodal_values)

    assert conservation["volume_relative_error"] < 1e-14
    np.testing.assert_allclose(
        conservation["projected_integral"],
        conservation["fem_integral"],
        rtol=1e-12,
        atol=1e-15,
    )


def test_cartesian_restriction_masks_nonmagnetic_voxels() -> None:
    mesh = _square_prism_mesh()
    grid = CartesianGrid(
        shape_zyx=(1, 1, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(2.0, 1.0, 1.0),
    )
    restriction = build_prism6_cartesian_restriction(mesh, grid)
    texture = restrict_fem_magnetization(
        np.broadcast_to([1.0, 0.0, 0.0], (mesh.n_nodes, 3)), restriction
    )

    assert restriction.coverage.tolist() == [[[1.0, 0.0]]]
    assert bool(np.all(texture.values.mask[0, 0, 0, 1]))
    np.testing.assert_allclose(texture.values[0, 0, 0, 0], [1.0, 0.0, 0.0])


def test_mumax_loader_preserves_tzyxc_contract_and_rejects_old_trajectory(tmp_path: Path) -> None:
    zarr = pytest.importorskip("zarr")
    path = tmp_path / "standardproblem4.zarr"
    root = zarr.open_group(str(path), mode="w")
    values = np.zeros((2, 1, 2, 3, 3), dtype=np.float32)
    values[..., 0] = 1.0
    target = root.create_dataset("m", data=values, shape=values.shape, dtype="f4")
    root.attrs.update({"Nx": 3, "Ny": 2, "Nz": 1, "Tx": 3.0, "Ty": 2.0, "Tz": 1.0})
    target.attrs["t"] = [0.0, 1.0]

    texture = load_mumax_magnetization(path)
    assert texture.values.shape == values.shape
    assert texture.grid.shape_zyx == (1, 2, 3)
    np.testing.assert_allclose(texture.times, [0.0, 1.0])
    with pytest.raises(MagnetizationComparisonError, match="exactly one final frame"):
        load_mumax_magnetization(path, require_single_frame=True)


def test_texture_metrics_use_only_common_unmasked_voxels() -> None:
    grid = CartesianGrid(
        shape_zyx=(1, 1, 2),
        bounds_min_xyz=(0.0, 0.0, 0.0),
        bounds_max_xyz=(2.0, 1.0, 1.0),
    )
    left = np.ma.array(
        [[[[[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]]]]],
        mask=[[[[[False, False, False], [True, True, True]]]]],
    )
    right = np.ma.array(
        [[[[[0.0, 0.0, 1.0], [0.0, 0.0, 1.0]]]]],
        mask=False,
    )
    result = compare_magnetization_textures(left, right, grid=grid)
    assert result.valid_voxel_count == 1
    assert result.component["x"]["mae"] == pytest.approx(1.0)
    assert result.vector["rms"] == pytest.approx(np.sqrt(2.0))


def test_compare_relaxed_states_loads_fullmag_node_state_and_reports_provenance(
    tmp_path: Path,
) -> None:
    zarr = pytest.importorskip("zarr")
    mesh = _square_prism_mesh()
    mesh_path = tmp_path / "sp4.fullmag-mesh"
    save_mesh_artifact(
        mesh_path,
        mesh=mesh,
        mesh_name="film",
        authoring_document={"kind": "test"},
        region_markers=[{"geometry_name": "film", "marker": 1}],
    )
    state_path = tmp_path / "relaxed_m.zarr"
    save_magnetization(
        state_path,
        np.broadcast_to([1.0, 0.0, 0.0], (mesh.n_nodes, 3)),
        format="zarr",
        dataset="m",
    )
    mumax_path = tmp_path / "mumax.zarr"
    root = zarr.open_group(str(mumax_path), mode="w")
    values = np.zeros((1, 1, 2, 2, 3), dtype=np.float32)
    values[..., 0] = 1.0
    target = root.create_dataset("m", data=values, shape=values.shape, dtype="f4")
    root.attrs.update(
        {
            "Nx": 2,
            "Ny": 2,
            "Nz": 1,
            "Tx": 1.0,
            "Ty": 1.0,
            "Tz": 1.0,
            "bounds_min_xyz": [0.0, 0.0, 0.0],
            "bounds_max_xyz": [1.0, 1.0, 1.0],
        }
    )
    target.attrs["t"] = [0.0]

    report = compare_relaxed_states(
        mumax_path,
        fullmag_state_path=state_path,
        fullmag_mesh_path=mesh_path,
    )
    assert report["scope"] == {
        "state": "final_relaxed_state",
        "dynamics_included": False,
        "mumax_dataset": "m",
        "fullmag_dataset": "m",
    }
    assert report["metrics"]["valid_voxel_count"] == 4
    assert report["conservation"]["volume_relative_error"] < 1e-14
    assert report["metrics"]["vector"]["max"] == pytest.approx(0.0)
    assert report["fullmag"]["node_count"] == mesh.n_nodes


def test_compare_relaxed_states_uses_native_planner_mesh_node_order(
    tmp_path: Path,
) -> None:
    zarr = pytest.importorskip("zarr")
    source = _square_prism_mesh()
    source = MeshData(
        nodes=source.nodes,
        cell_types=source.cell_types,
        cell_offsets=source.cell_offsets,
        cell_nodes=source.cell_nodes,
        element_markers=np.asarray([1, 0], dtype=np.int32),
        facet_types=source.facet_types,
        facet_roles=source.facet_roles,
        facet_offsets=source.facet_offsets,
        facet_nodes=source.facet_nodes,
        boundary_markers=source.boundary_markers,
        cell_global_ordinals=source.cell_global_ordinals,
        facet_global_ordinals=source.facet_global_ordinals,
        cell_mesh_parts=np.asarray(["magnetic", "far_air"]),
    )
    mesh_path = tmp_path / "mixed.fullmag-mesh"
    save_mesh_artifact(
        mesh_path,
        mesh=source,
        mesh_name="mixed",
        authoring_document={"kind": "test"},
        region_markers=[{"geometry_name": "film", "marker": 1}],
    )

    native_to_source = np.asarray([0, 1, 2, 4, 5, 6, 3, 7], dtype=np.int64)
    source_to_native = np.empty_like(native_to_source)
    source_to_native[native_to_source] = np.arange(native_to_source.size)
    native = {
        "mesh_name": "mixed",
        "nodes": source.nodes[native_to_source].tolist(),
        "cells": {
            "types": source.cell_types.tolist(),
            "offsets": source.cell_offsets.tolist(),
            "nodes": source_to_native[source.cell_nodes].tolist(),
            "global_ordinals": source.cell_global_ordinals.tolist(),
            "mesh_parts": source.cell_mesh_parts.tolist(),
        },
        "element_markers": source.element_markers.tolist(),
        "facets": {
            "types": [],
            "roles": [],
            "offsets": [0],
            "nodes": [],
            "global_ordinals": [],
        },
        "boundary_markers": [],
    }
    run_bundle = tmp_path / "run"
    metadata_path = run_bundle / "workspace-history/session/stages/stage/metadata.json"
    metadata_path.parent.mkdir(parents=True)
    metadata_path.write_text(
        json.dumps({"execution_plan": {"backend_plan": {"mesh": native}}}),
        encoding="utf-8",
    )

    state_path = tmp_path / "relaxed_m.zarr"
    state = np.zeros((source.n_nodes, 3), dtype=np.float64)
    state[:6, 0] = 1.0
    save_magnetization(state_path, state, format="zarr", dataset="m")
    mumax_path = tmp_path / "mumax.zarr"
    root = zarr.open_group(str(mumax_path), mode="w")
    values = np.zeros((1, 1, 2, 2, 3), dtype=np.float32)
    values[..., 0] = 1.0
    root.create_dataset("m", data=values, shape=values.shape, dtype="f4").attrs["t"] = [0.0]
    root.attrs.update(
        {
            "Nx": 2,
            "Ny": 2,
            "Nz": 1,
            "Tx": 1.0,
            "Ty": 1.0,
            "Tz": 1.0,
            "bounds_min_xyz": [0.0, 0.0, 0.0],
            "bounds_max_xyz": [1.0, 1.0, 1.0],
        }
    )

    report = compare_relaxed_states(
        mumax_path,
        fullmag_state_path=state_path,
        fullmag_mesh_path=mesh_path,
        fullmag_run_bundle=run_bundle,
    )

    assert report["fullmag"]["node_order"] == "native_planner_mesh"
    assert report["metrics"]["vector"]["max"] == pytest.approx(0.0)

    empty_run_bundle = tmp_path / "empty-run"
    empty_run_bundle.mkdir()
    with pytest.raises(MagnetizationComparisonError, match="execution_plan.backend_plan.mesh"):
        compare_relaxed_states(
            mumax_path,
            fullmag_state_path=state_path,
            fullmag_mesh_path=mesh_path,
            fullmag_run_bundle=empty_run_bundle,
        )
