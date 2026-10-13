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


def test_periodic_snapshot_rejects_a_missing_patch_without_losing_faces() -> None:
    nodes = _edge_midpoint_nodes()
    boundary_pairs, node_pairs, scopes = _periodic_inputs(nodes)
    connectivity = _delaunay.tetrahedralize_layered_box_delaunay(
        nodes, _PLANES, _BOUNDS,
        periodic_boundary_pairs=boundary_pairs,
        periodic_node_pairs=node_pairs,
        periodic_patch_z_bounds=scopes,
    )
    _, sorted_nodes, original, _, _ = _kernel._validate_and_prepare(nodes, _PLANES, _BOUNDS)
    inverse = {int(node): index for index, node in enumerate(original)}
    cells = [tuple(inverse[int(node)] for node in cell) for cell in connectivity]
    rows, _, _, maps = _delaunay._normalize_periodic_inputs(
        nodes, _PLANES, _BOUNDS, original, boundary_pairs, node_pairs, scopes,
    )
    with pytest.raises(ValueError, match="do not partition side-A faces"):
        _delaunay._periodic_snapshots(cells, np.asarray(sorted_nodes), _BOUNDS, rows[:-1], maps)


def test_exact_sat_cache_is_bound_to_immutable_geometry(monkeypatch) -> None:
    points = [
        (0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1),
        (2, 0, 0), (3, 0, 0), (2, 1, 0), (2, 0, 1),
    ]
    first, second = (0, 1, 2, 3), (4, 5, 6, 7)
    original = _kernel._tetrahedra_are_separated
    calls = []
    def counted(geometry, a, b):
        calls.append((a, b))
        return original(geometry, a, b)
    monkeypatch.setattr(_kernel, "_tetrahedra_are_separated", counted)
    separated = _delaunay._separation_checker(points)
    assert separated(first, second) is True
    assert separated(tuple(reversed(second)), tuple(reversed(first))) is True
    assert len(calls) == 1
    points[4:] = points[:4]
    # A new geometry has an overlapping pair with the same node identifiers.
    overlapping = _delaunay._separation_checker(points)
    assert overlapping(first, second) is False
    # Existing realization coordinates remain immutable despite external edits.
    assert separated(first, second) is True


def test_periodic_reconciliation_preserves_geometry_for_reordered_patch_inputs() -> None:
    nodes = _edge_midpoint_nodes()
    pairs, node_pairs, scopes = _periodic_inputs(nodes)
    forward = _delaunay.tetrahedralize_layered_box_delaunay(
        nodes, _PLANES, _BOUNDS, periodic_boundary_pairs=pairs,
        periodic_node_pairs=node_pairs, periodic_patch_z_bounds=scopes,
    )
    reversed_input = _delaunay.tetrahedralize_layered_box_delaunay(
        nodes, _PLANES, _BOUNDS, periodic_boundary_pairs=list(reversed(pairs)),
        periodic_node_pairs=list(reversed(node_pairs)), periodic_patch_z_bounds=scopes,
    )
    np.testing.assert_array_equal(forward, reversed_input)


def test_congruent_cap_prism_candidates_preserve_exact_nodes_and_volume() -> None:
    from fractions import Fraction
    # Use complete adjacent caps, independent of caller node ordering.
    nodes = np.asarray([(x,y,z) for z in (-_SCALE, 0.0) for x,y in _EDGE_XY])
    points, _, _, planes, bounds = _kernel._validate_and_prepare(
        nodes, np.asarray([-_SCALE, 0.0]), _BOUNDS,
    )
    ids = list(range(len(points)))
    cells = _delaunay._congruent_cap_prism_candidates(points, ids, planes[0], planes[1])
    assert cells is not None
    _kernel._validate_tetrahedralization(cells, points, planes, bounds)
    assert set(node for cell in cells for node in cell) == set(ids)
    assert sum((_kernel._orient3d(points, cell) for cell in cells), Fraction(0)) > 0
    reordered = _delaunay._congruent_cap_prism_candidates(
        points, list(reversed(ids)), planes[0], planes[1],
    )
    assert cells == reordered


def test_congruent_cap_prism_candidates_do_not_match_almost_equal_xy() -> None:
    from fractions import Fraction
    points = [(Fraction(x),Fraction(y),Fraction(z))
              for z in (0,1) for x,y in ((0,0),(1,0),(1,1),(0,1))]
    points[4] = (Fraction(1,2**60), points[4][1], points[4][2])
    assert _delaunay._congruent_cap_prism_candidates(points,list(range(8)),0,1) is None


def _different_cap_points():
    from fractions import Fraction as F
    lower_xy = [(0,0),(1,0),(1,1),(0,1),(F(1,2),F(1,2))]
    upper_xy = lower_xy[:-1] + [(F(1,2)+F(1,2**52),F(1,2))]
    return [(F(x),F(y),F(z)) for z,cap in ((0,lower_xy),(1,upper_xy)) for x,y in cap]


def test_compatible_cap_candidate_preserves_different_exact_coordinates() -> None:
    from fractions import Fraction as F
    points = _different_cap_points()
    original = list(points)
    ids = list(range(len(points)))
    bounds = (F(0),F(1),F(0),F(1))
    cells = _delaunay._compatible_cap_prism_candidates(points,ids,F(0),F(1),bounds)
    assert cells is not None
    _kernel._validate_tetrahedralization(cells,points,(F(0),F(1)),bounds)
    assert points == original
    assert len(cells) == 12
    assert sum((_kernel._orient3d(points,cell) for cell in cells),F(0)) == 6
    from itertools import combinations
    for first,second in combinations(cells,2):
        assert _kernel._tetrahedra_are_separated(points,first,second)
    assert cells == _delaunay._compatible_cap_prism_candidates(
        points,list(reversed(ids)),F(0),F(1),bounds,
    )


def test_compatible_cap_candidate_rejects_boundary_class_mismatch() -> None:
    from fractions import Fraction as F
    points = _different_cap_points()
    points[5] = (F(1,2**52),F(0),F(1))
    assert _delaunay._compatible_cap_prism_candidates(
        points,list(range(len(points))),F(0),F(1),(F(0),F(1),F(0),F(1)),
    ) is None


def test_compatible_cap_candidate_requires_exact_overlap_check(monkeypatch) -> None:
    from fractions import Fraction as F
    points = _different_cap_points()
    calls = []
    def overlapping(geometry,first,second):
        calls.append((first,second))
        return False
    monkeypatch.setattr(_kernel,'_tetrahedra_are_separated',overlapping)
    assert _delaunay._compatible_cap_prism_candidates(
        points,list(range(len(points))),F(0),F(1),(F(0),F(1),F(0),F(1)),
    ) is None
    assert calls

def test_different_cap_public_route_is_invariant_to_input_node_permutation() -> None:
    nodes = np.asarray(_different_cap_points(),dtype=np.float64)
    permutation = np.asarray([8,0,6,3,5,1,9,2,7,4])
    def geometric_cells(coordinates,cells):
        return sorted(tuple(sorted(tuple(coordinates[node]) for node in cell)) for cell in cells)
    first = _delaunay.tetrahedralize_layered_box_delaunay(nodes,[0.0,1.0],[0.0,1.0,0.0,1.0])
    shuffled = nodes[permutation]
    second = _delaunay.tetrahedralize_layered_box_delaunay(shuffled,[0.0,1.0],[0.0,1.0,0.0,1.0])
    assert geometric_cells(nodes,first) == geometric_cells(shuffled,second)
    np.testing.assert_array_equal(nodes,np.asarray(_different_cap_points(),dtype=np.float64))


def test_compatible_cap_candidate_rejects_reversed_interior_assignment(monkeypatch) -> None:
    from fractions import Fraction as F
    from scipy import optimize
    xy = [(F(0),F(0)),(F(1),F(0)),(F(1),F(1)),(F(0),F(1)),
          (F(1,4),F(1,4)),(F(3,4),F(3,4))]
    points = [(x,y,F(z)) for z in (0,1) for x,y in xy]
    monkeypatch.setattr(optimize,'linear_sum_assignment',
                        lambda costs: (np.asarray([0,1]),np.asarray([1,0])))
    assert _delaunay._compatible_cap_prism_candidates(
        points,list(range(len(points))),F(0),F(1),(F(0),F(1),F(0),F(1)),
    ) is None