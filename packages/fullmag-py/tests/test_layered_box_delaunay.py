from __future__ import annotations

import numpy as np
import pytest

from fullmag.meshing import _layered_box_mesh_data as _mesh_data
from fullmag.meshing import _layered_box_delaunay as _delaunay
from fullmag.meshing import _layered_box_tetrahedralization as _kernel


_SCALE = 2.0**-12
_PLANES = np.asarray([-_SCALE, 0.0, _SCALE], dtype=np.float64)
_BOUNDS = (-2.0 * _SCALE, 2.0 * _SCALE, -2.0 * _SCALE, 2.0 * _SCALE)
_XY = (
    (-2.0 * _SCALE, -2.0 * _SCALE),
    (2.0 * _SCALE, -2.0 * _SCALE),
    (2.0 * _SCALE, 2.0 * _SCALE),
    (-2.0 * _SCALE, 2.0 * _SCALE),
)
_EDGE_XY = (
    (-2.0 * _SCALE, -2.0 * _SCALE),
    (0.0, -2.0 * _SCALE),
    (2.0 * _SCALE, -2.0 * _SCALE),
    (2.0 * _SCALE, 0.0),
    (2.0 * _SCALE, 2.0 * _SCALE),
    (0.0, 2.0 * _SCALE),
    (-2.0 * _SCALE, 2.0 * _SCALE),
    (-2.0 * _SCALE, 0.0),
)


def _nodes() -> np.ndarray:
    return np.asarray(
        [(x, y, float(z)) for z in _PLANES for x, y in _XY],
        dtype=np.float64,
    )


def _edge_midpoint_nodes() -> np.ndarray:
    return np.asarray(
        [(x, y, float(z)) for z in _PLANES for x, y in _EDGE_XY],
        dtype=np.float64,
    )


def _periodic_inputs(nodes: np.ndarray):
    coordinate_to_index = {
        tuple(float(value) for value in point): index
        for index, point in enumerate(nodes)
    }
    boundary_pairs = []
    node_pairs = []
    patch_z_bounds = {}
    for axis, pair_id in ((0, "periodic-x"), (1, "periodic-y")):
        low = _BOUNDS[2 * axis]
        high = _BOUNDS[2 * axis + 1]
        translation = [0.0, 0.0, 0.0]
        translation[axis] = high - low
        for slab, (z_low, z_high) in enumerate(zip(_PLANES[:-1], _PLANES[1:], strict=True)):
            marker_a = 31 + axis * 10 + slab * 2
            marker_b = marker_a + 1
            boundary_pairs.append(
                {
                    "pair_id": pair_id,
                    "marker_a": marker_a,
                    "marker_b": marker_b,
                    "axis_hint": "x" if axis == 0 else "y",
                    "translation": translation,
                    "tolerance_m": 0.0,
                }
            )
            patch_z_bounds[(pair_id, marker_a, marker_b)] = (
                float(z_low),
                float(z_high),
            )
        for node_a, point in enumerate(nodes):
            if point[axis] != low:
                continue
            destination = point.copy()
            destination[axis] = high
            node_b = coordinate_to_index[tuple(float(value) for value in destination)]
            node_pairs.append(
                {"pair_id": pair_id, "node_a": node_a, "node_b": node_b}
            )
    return boundary_pairs, node_pairs, patch_z_bounds


def _geometry_cells(nodes: np.ndarray, cells: np.ndarray):
    return sorted(
        tuple(sorted(tuple(float(value) for value in nodes[int(node)]) for node in cell))
        for cell in cells
    )


def test_exact_candidate_discards_only_zero_volume_simplices() -> None:
    points = [
        (0, 0, 0),
        (1, 0, 0),
        (0, 1, 0),
        (1, 1, 0),
        (0, 0, 1),
    ]
    cells = _delaunay._exact_positive_simplices(
        points,
        [(0, 1, 2, 3), (0, 1, 2, 4)],
    )

    assert [tuple(sorted(cell)) for cell in cells] == [(0, 1, 2, 4)]
    assert _kernel._orient3d(points, cells[0]) > 0


def test_candidate_rejects_qhull_output_that_omits_input_nodes(monkeypatch) -> None:
    import scipy.spatial

    class OmittingDelaunay:
        def __init__(self, coordinates):
            self.simplices = np.empty((0, 4), dtype=np.int32)

    monkeypatch.setattr(scipy.spatial, "Delaunay", OmittingDelaunay)

    with pytest.raises(ValueError, match="do not use every input node"):
        _delaunay.tetrahedralize_layered_box_delaunay(
            _nodes(), _PLANES, _BOUNDS
        )


def test_unsupported_quad_and_different_apex_are_not_reconciled() -> None:
    concave_points = [
        (0, 0, 0),
        (2, 0, 0),
        (1, 1, 0),
        (0, 2, 0),
    ]
    assert _delaunay._strict_convex_quad((0, 1, 2, 3), concave_points) is None

    square_and_apexes = [
        (0, 0, 0),
        (2, 0, 0),
        (2, 2, 0),
        (0, 2, 0),
        (0, 0, 1),
        (2, 2, 1),
    ]
    hull = _delaunay._strict_convex_quad((0, 1, 2, 3), square_and_apexes)
    assert hull is not None
    diagonal, _ = _delaunay._diagonals(hull)
    old_faces = _delaunay._triangles_for_diagonal((0, 1, 2, 3), diagonal)
    cells = [
        _delaunay._canonical_positive_cell((*face, apex), square_and_apexes)
        for face, apex in zip(sorted(old_faces), (4, 5), strict=True)
    ]
    assert all(cell is not None for cell in cells)
    typed_cells = [cell for cell in cells if cell is not None]
    incidence = _delaunay._face_incidence(typed_cells)

    assert (
        _delaunay._cone_for_faces(
            old_faces, incidence, typed_cells, square_and_apexes, (0, 1, 2, 3), hull
        )
        is None
    )


def test_edge_midpoint_caps_use_guarded_one_sided_internal_quad_flip() -> None:
    nodes = _edge_midpoint_nodes()
    connectivity = _delaunay.tetrahedralize_layered_box_delaunay(
        nodes, _PLANES, _BOUNDS
    )

    assert len(connectivity) > 0
    assert {int(node) for cell in connectivity for node in cell} == set(range(len(nodes)))
    points, _, original_indices, plane_values, bounds = _kernel._validate_and_prepare(
        nodes, _PLANES, _BOUNDS
    )
    inverse_original = {
        int(original): sorted_id for sorted_id, original in enumerate(original_indices)
    }
    sorted_cells = [
        tuple(inverse_original[int(node)] for node in cell) for cell in connectivity
    ]
    _kernel._validate_tetrahedralization(sorted_cells, points, plane_values, bounds)


def test_geometry_ordered_candidate_is_permutation_deterministic() -> None:
    nodes = _nodes()
    connectivity = _delaunay.tetrahedralize_layered_box_delaunay(
        nodes, _PLANES, _BOUNDS
    )
    permutation = np.random.default_rng(731).permutation(len(nodes))
    permuted_nodes = nodes[permutation]
    permuted_connectivity = _delaunay.tetrahedralize_layered_box_delaunay(
        permuted_nodes, _PLANES, _BOUNDS
    )

    assert _geometry_cells(nodes, connectivity) == _geometry_cells(
        permuted_nodes, permuted_connectivity
    )
    assert connectivity.shape[1:] == (4,)
    assert len({tuple(sorted(int(node) for node in cell)) for cell in connectivity}) == len(
        connectivity
    )


def test_periodic_x_y_patches_match_complete_triangles_and_corner_maps() -> None:
    nodes = _edge_midpoint_nodes()
    boundary_pairs, node_pairs, patch_z_bounds = _periodic_inputs(nodes)
    connectivity = _delaunay.tetrahedralize_layered_box_delaunay(
        nodes,
        _PLANES,
        _BOUNDS,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
        periodic_patch_z_bounds=patch_z_bounds,
    )

    points, sorted_nodes, original_indices, plane_values, bounds = (
        _kernel._validate_and_prepare(nodes, _PLANES, _BOUNDS)
    )
    inverse_original = {int(original): sorted_id for sorted_id, original in enumerate(original_indices)}
    sorted_cells = [
        tuple(inverse_original[int(node)] for node in cell)
        for cell in connectivity
    ]
    _kernel._validate_tetrahedralization(
        sorted_cells, points, plane_values, bounds
    )
    facets = _delaunay._periodic_validator_facets(
        sorted_cells,
        np.asarray(sorted_nodes, dtype=np.float64),
        _BOUNDS,
        _delaunay._normalize_periodic_inputs(
            nodes,
            _PLANES,
            _BOUNDS,
            original_indices,
            boundary_pairs,
            node_pairs,
            patch_z_bounds,
        )[0],
    )
    boundary_rows, pair_by_id, node_rows, node_maps = _delaunay._normalize_periodic_inputs(
        nodes,
        _PLANES,
        _BOUNDS,
        original_indices,
        boundary_pairs,
        node_pairs,
        patch_z_bounds,
    )
    _mesh_data._validate_periodic_topology(
        nodes=np.asarray(sorted_nodes, dtype=np.float64),
        facets=facets,
        bounds_xy=_BOUNDS,
        boundary_pairs=boundary_rows,
        node_maps=node_maps,
        node_pairs=node_rows,
    )
    assert len(connectivity) > 0
    assert set(pair_by_id) == {"periodic-x", "periodic-y"}


def test_periodic_map_must_be_complete_and_bijective() -> None:
    nodes = _nodes()
    boundary_pairs, node_pairs, patch_z_bounds = _periodic_inputs(nodes)
    incomplete = [row for row in node_pairs if row["pair_id"] != "periodic-x"]
    incomplete.extend(
        row for row in node_pairs if row["pair_id"] == "periodic-x"
    )
    incomplete.pop()

    with pytest.raises(ValueError, match="bijectively cover every node"):
        _delaunay.tetrahedralize_layered_box_delaunay(
            nodes,
            _PLANES,
            _BOUNDS,
            periodic_boundary_pairs=boundary_pairs,
            periodic_node_pairs=incomplete,
            periodic_patch_z_bounds=patch_z_bounds,
        )
