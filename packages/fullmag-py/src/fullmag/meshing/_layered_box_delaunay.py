"""Exact-validated per-slab Delaunay candidates for layered rectangular boxes.

SciPy/Qhull proposes connectivity only. Every orientation, supported
reconciliation move, slab volume, cap, exterior face and authored periodic map
is checked using the existing exact layered-box contracts. This private
prototype does not activate production routing or certify mesh quality.
"""
from __future__ import annotations

from collections import Counter
from collections.abc import Mapping, Sequence
from itertools import combinations
from numbers import Integral

import numpy as np
from numpy.typing import NDArray

from . import _layered_box_mesh_data as _mesh_data
from . import _layered_box_tetrahedralization as _kernel


_Exact = _kernel._Exact
_Point3 = _kernel._Point3
_Cell = _kernel._Cell
_Face = _kernel._Face
_Edge = _kernel._Edge


def _faces(cell: _Cell) -> tuple[_Face, ...]:
    return tuple(
        tuple(sorted(cell[index] for index in range(4) if index != omitted))
        for omitted in range(4)
    )


def _canonical_positive_cell(cell: Sequence[int], points: Sequence[_Point3]) -> _Cell | None:
    """Canonicalize a simplex by geometry-ranked IDs, preserving exact positive sign."""
    if len(cell) != 4 or len(set(int(vertex) for vertex in cell)) != 4:
        raise ValueError("Delaunay simplex must contain four distinct nodes")
    ordered = tuple(sorted(int(vertex) for vertex in cell))
    determinant = _kernel._orient3d(points, ordered)
    if determinant == 0:
        return None
    if determinant < 0:
        ordered = (ordered[1], ordered[0], ordered[2], ordered[3])
    return ordered


def _exact_positive_simplices(
    points: Sequence[_Point3], simplices: Sequence[Sequence[int]]
) -> list[_Cell]:
    """Drop only exact-zero simplices and orient all other candidates positively."""
    cells: list[_Cell] = []
    seen: set[tuple[int, int, int, int]] = set()
    for simplex in simplices:
        cell = _canonical_positive_cell(simplex, points)
        if cell is None:
            continue
        key = tuple(sorted(cell))
        if key in seen:
            raise ValueError("Delaunay candidate contains duplicate positive tetrahedra")
        seen.add(key)
        cells.append(cell)
    return sorted(cells, key=lambda cell: tuple(sorted(cell)))


def _require_all_nodes_used(cells: Sequence[_Cell], node_count: int) -> None:
    used = {node for cell in cells for node in cell}
    if used != set(range(node_count)):
        raise ValueError("Delaunay candidates do not use every input node")


def _face_incidence(cells: Sequence[_Cell]) -> dict[_Face, list[int]]:
    incidence: dict[_Face, list[int]] = {}
    for cell_index, cell in enumerate(cells):
        for face in _faces(cell):
            owners = incidence.setdefault(face, [])
            owners.append(cell_index)
            if len(owners) > 2:
                raise ValueError("Delaunay candidate has a face with more than two owners")
    return incidence


def _cross2(
    points: Sequence[_Point3], axes: tuple[int, int], a: int, b: int, c: int
) -> _Exact:
    pa, pb, pc = (points[index] for index in (a, b, c))
    return (
        (pb[axes[0]] - pa[axes[0]]) * (pc[axes[1]] - pa[axes[1]])
        - (pb[axes[1]] - pa[axes[1]]) * (pc[axes[0]] - pa[axes[0]])
    )


def _strict_convex_quad(
    quad: Sequence[int], points: Sequence[_Point3]
) -> tuple[int, int, int, int] | None:
    """Return an exact cyclic hull for four strictly convex coplanar nodes."""
    if len(set(quad)) != 4:
        return None
    ordered_quad = tuple(sorted(int(vertex) for vertex in quad))
    normal: _Point3 | None = None
    for a, b, c in combinations(ordered_quad, 3):
        candidate = _kernel._interior_vector_cross(
            _kernel._interior_vector_sub(points[b], points[a]),
            _kernel._interior_vector_sub(points[c], points[a]),
        )
        if candidate != (0, 0, 0):
            normal = candidate
            break
    if normal is None:
        return None

    dropped_axis = max(range(3), key=lambda axis: abs(normal[axis]))
    axes = tuple(axis for axis in range(3) if axis != dropped_axis)
    planar_order = sorted(
        ordered_quad,
        key=lambda node: (points[node][axes[0]], points[node][axes[1]], points[node]),
    )

    lower: list[int] = []
    for node in planar_order:
        while len(lower) >= 2 and _cross2(
            points, axes, lower[-2], lower[-1], node
        ) <= 0:
            lower.pop()
        lower.append(node)
    upper: list[int] = []
    for node in reversed(planar_order):
        while len(upper) >= 2 and _cross2(
            points, axes, upper[-2], upper[-1], node
        ) <= 0:
            upper.pop()
        upper.append(node)
    hull = lower[:-1] + upper[:-1]
    if len(hull) != 4 or _kernel._orient3d(points, tuple(hull)) != 0:
        return None
    return tuple(hull)


def _diagonals(hull: Sequence[int]) -> tuple[_Edge, _Edge]:
    return (
        tuple(sorted((int(hull[0]), int(hull[2])))),
        tuple(sorted((int(hull[1]), int(hull[3])))),
    )


def _triangles_for_diagonal(
    quad: Sequence[int], diagonal: Sequence[int]
) -> set[_Face]:
    remaining = sorted(set(int(node) for node in quad).difference(diagonal))
    if len(remaining) != 2 or len(diagonal) != 2:
        return set()
    return {
        tuple(sorted((int(diagonal[0]), int(diagonal[1]), remaining[0]))),
        tuple(sorted((int(diagonal[0]), int(diagonal[1]), remaining[1]))),
    }


def _cone_for_faces(
    faces: set[_Face],
    incidence: Mapping[_Face, list[int]],
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    quad: Sequence[int],
    hull: Sequence[int],
) -> dict[str, object] | None:
    """Find two positive owner tetrahedra sharing one apex over a quad diagonal."""
    if len(faces) != 2 or not set(faces).issubset(incidence):
        return None
    owners: list[tuple[int, _Cell, int]] = []
    quad_nodes = set(quad)
    plane_face = tuple(int(node) for node in hull[:3])
    side_signs: list[int] = []
    for face in sorted(faces):
        cell_indices = incidence[face]
        if len(cell_indices) != 1:
            return None
        cell_index = cell_indices[0]
        cell = cells[cell_index]
        apexes = set(cell).difference(face)
        if len(apexes) != 1:
            return None
        apex = next(iter(apexes))
        if apex in quad_nodes or _kernel._orient3d(points, cell) <= 0:
            return None
        side = _kernel._orient3d(points, (*plane_face, apex))
        if side == 0:
            return None
        side_signs.append(1 if side > 0 else -1)
        owners.append((cell_index, cell, apex))
    if owners[0][0] == owners[1][0] or owners[0][2] != owners[1][2]:
        return None
    if side_signs[0] != side_signs[1]:
        return None
    return {
        "cell_indices": tuple(sorted((owners[0][0], owners[1][0]))),
        "cells": (owners[0][1], owners[1][1]),
        "apex": owners[0][2],
        "side": side_signs[0],
    }


def _faces_have_exact_side_owners(
    faces: set[_Face],
    incidence: Mapping[_Face, list[int]],
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    hull: Sequence[int],
    expected_side: int,
    plane_values: Sequence[_Exact],
    expected_slab: int,
) -> bool:
    """Require each unchanged target triangle owner on the opposite exact side."""
    if len(faces) != 2:
        return False
    plane_face = tuple(int(node) for node in hull[:3])
    plane_index_by_z = {z: index for index, z in enumerate(plane_values)}
    for face in faces:
        owners = incidence.get(face, ())
        if len(owners) != 1:
            return False
        cell = cells[owners[0]]
        apexes = set(cell).difference(face)
        if (
            len(apexes) != 1
            or _kernel._orient3d(points, cell) <= 0
            or _kernel._cell_slab_index(cell, points, plane_index_by_z) != expected_slab
        ):
            return False
        side = _kernel._orient3d(points, (*plane_face, next(iter(apexes))))
        if side == 0 or (1 if side > 0 else -1) != expected_side:
            return False
    return True


def _cap_face_signature(
    cells: Sequence[_Cell], points: Sequence[_Point3], plane_values: Sequence[_Exact]
) -> Counter[_Face]:
    planes = set(plane_values)
    return Counter(
        face
        for cell in cells
        for face in _faces(cell)
        if len({points[node][2] for node in face}) == 1
        and points[face[0]][2] in planes
    )


def _aabb_disjoint(first: _Cell, second: _Cell, points: Sequence[_Point3]) -> bool:
    for axis in range(3):
        first_values = [points[node][axis] for node in first]
        second_values = [points[node][axis] for node in second]
        if max(first_values) <= min(second_values) or max(second_values) <= min(first_values):
            return True
    return False


def _guarded_two_to_two(
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
    *,
    old_cell_indices: Sequence[int],
    quad: Sequence[int],
    old_quad_faces: set[_Face],
    new_quad_faces: set[_Face],
    target_incidence: int,
) -> list[_Cell] | None:
    """Return a globally safe exact 2->2 update, otherwise reject the move."""
    if len(old_cell_indices) != 2 or len(set(old_cell_indices)) != 2:
        return None
    old_indices = tuple(sorted(int(index) for index in old_cell_indices))
    old_cells = [cells[index] for index in old_indices]
    quad_set = set(int(node) for node in quad)
    if len(quad_set) != 4 or len(old_quad_faces) != 2 or len(new_quad_faces) != 2:
        return None
    if any(len(set(cell)) != 4 or _kernel._orient3d(points, cell) <= 0 for cell in old_cells):
        return None

    plane_index_by_z = {z: i for i, z in enumerate(plane_values)}
    old_slabs = [
        _kernel._cell_slab_index(cell, points, plane_index_by_z)
        for cell in old_cells
    ]
    if old_slabs[0] is None or old_slabs[0] != old_slabs[1]:
        return None
    slab = old_slabs[0]

    diagonal = tuple(sorted(set.intersection(*(set(face) for face in new_quad_faces))))
    if len(diagonal) != 2:
        return None
    other_nodes = sorted(quad_set.difference(diagonal))
    if len(other_nodes) != 2:
        return None
    apex_candidates = [set(cell).difference(quad_set) for cell in old_cells]
    if any(len(apexes) != 1 for apexes in apex_candidates):
        return None
    common_apexes = set.intersection(*apex_candidates)
    if len(common_apexes) != 1:
        return None
    apex = next(iter(common_apexes))
    if apex in quad_set:
        return None

    raw_new_cells = (
        (apex, diagonal[0], diagonal[1], other_nodes[0]),
        (apex, diagonal[0], diagonal[1], other_nodes[1]),
    )
    new_cells: list[_Cell] = []
    for raw in raw_new_cells:
        cell = _canonical_positive_cell(raw, points)
        if cell is None:
            return None
        new_cells.append(cell)
    new_cells.sort(key=lambda cell: tuple(sorted(cell)))
    if len({tuple(sorted(cell)) for cell in new_cells}) != 2:
        return None

    old_face_counts = Counter(face for cell in old_cells for face in _faces(cell))
    new_face_counts = Counter(face for cell in new_cells for face in _faces(cell))
    old_boundary = {face for face, count in old_face_counts.items() if count == 1}
    new_boundary = {face for face, count in new_face_counts.items() if count == 1}
    old_quad_boundary = {face for face in old_boundary if set(face).issubset(quad_set)}
    new_quad_boundary = {face for face in new_boundary if set(face).issubset(quad_set)}
    if old_quad_boundary != old_quad_faces or new_quad_boundary != new_quad_faces:
        return None
    if old_boundary.difference(old_quad_faces) != new_boundary.difference(new_quad_faces):
        return None
    if any(count not in (1, 2) for count in old_face_counts.values()):
        return None
    if any(count not in (1, 2) for count in new_face_counts.values()):
        return None

    determinants = [_kernel._orient3d(points, cell) for cell in (*old_cells, *new_cells)]
    if any(value <= 0 for value in determinants):
        return None
    if sum(determinants[:2]) != sum(determinants[2:]):
        return None
    new_slabs = [
        _kernel._cell_slab_index(cell, points, plane_index_by_z)
        for cell in new_cells
    ]
    if any(value != slab for value in new_slabs):
        return None

    before_caps = _cap_face_signature(cells, points, plane_values)
    replaced = set(old_indices)
    updated: list[_Cell] = []
    insertion_index = min(old_indices)
    for index, cell in enumerate(cells):
        if index == insertion_index:
            updated.extend(new_cells)
        if index not in replaced:
            updated.append(cell)
    updated.sort(key=lambda cell: tuple(sorted(cell)))

    if len({tuple(sorted(cell)) for cell in updated}) != len(updated):
        return None
    if _cap_face_signature(updated, points, plane_values) != before_caps:
        return None
    updated_incidence = _face_incidence(updated)
    old_global_incidence = _face_incidence(cells)
    if any(len(old_global_incidence[face]) != 1 for face in old_quad_faces):
        return None
    if any(
        len(updated_incidence.get(face, ())) != target_incidence
        for face in new_quad_faces
    ):
        return None

    # The same two cavity tets must be separated from each other and from every
    # unchanged tet. AABB rejects most pairs before exact SAT arithmetic.
    if not _kernel._tetrahedra_are_separated(points, new_cells[0], new_cells[1]):
        return None
    for candidate in new_cells:
        for index, other in enumerate(cells):
            if index in replaced or _aabb_disjoint(candidate, other, points):
                continue
            if not _kernel._tetrahedra_are_separated(points, candidate, other):
                return None
    return updated


def _free_internal_faces(
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    planes: Sequence[_Exact],
    bounds: tuple[_Exact, _Exact, _Exact, _Exact],
) -> set[_Face]:
    xmin, xmax, ymin, ymax = bounds
    plane_set = set(planes)
    result: set[_Face] = set()
    for face, owners in _face_incidence(cells).items():
        if len(owners) != 1:
            continue
        face_points = [points[node] for node in face]
        if (
            all(point[0] == xmin for point in face_points)
            or all(point[0] == xmax for point in face_points)
            or all(point[1] == ymin for point in face_points)
            or all(point[1] == ymax for point in face_points)
        ):
            continue
        if len({point[2] for point in face_points}) == 1 and face_points[0][2] in plane_set:
            continue
        result.add(face)
    return result


def _internal_quad_patches(
    free_faces: set[_Face], points: Sequence[_Point3]
) -> list[dict[str, object]]:
    candidates: dict[tuple[int, int, int, int], dict[str, object]] = {}
    for first, second in combinations(sorted(free_faces), 2):
        if len(set(first).intersection(second)) != 2:
            continue
        quad = tuple(sorted(set(first).union(second)))
        if len(quad) != 4:
            continue
        hull = _strict_convex_quad(quad, points)
        if hull is None:
            continue
        diagonal_a, diagonal_b = _diagonals(hull)
        triangles_a = _triangles_for_diagonal(quad, diagonal_a)
        triangles_b = _triangles_for_diagonal(quad, diagonal_b)
        patch_faces = triangles_a | triangles_b
        if len(patch_faces) != 4 or not patch_faces.issubset(free_faces):
            continue
        candidates[quad] = {
            "quad": quad,
            "hull": hull,
            "diagonal_a": diagonal_a,
            "diagonal_b": diagonal_b,
            "triangles_a": triangles_a,
            "triangles_b": triangles_b,
            "patch_faces": patch_faces,
        }

    coverage = Counter(
        face for patch in candidates.values() for face in patch["patch_faces"]
    )
    if (
        set(coverage) != free_faces
        or any(count != 1 for count in coverage.values())
    ):
        raise ValueError(
            "unsupported internal free-face topology: faces do not partition into exact convex quad patches"
        )
    return sorted(
        candidates.values(),
        key=lambda patch: tuple(points[node] for node in patch["quad"]),
    )


def _reconcile_internal_free_faces(
    cells: list[_Cell],
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
    bounds: tuple[_Exact, _Exact, _Exact, _Exact],
) -> list[_Cell]:
    working = list(cells)
    while True:
        free_faces = _free_internal_faces(working, points, plane_values, bounds)
        if not free_faces:
            return working
        patches = _internal_quad_patches(free_faces, points)
        incidence = _face_incidence(working)
        legal_moves: list[tuple[tuple[object, ...], list[_Cell], set[_Face]]] = []
        for patch in patches:
            cones = (
                _cone_for_faces(
                    patch["triangles_a"], incidence, working, points,
                    patch["quad"], patch["hull"],
                ),
                _cone_for_faces(
                    patch["triangles_b"], incidence, working, points,
                    patch["quad"], patch["hull"],
                ),
            )
            for cone_index, cone in enumerate(cones):
                if cone is None:
                    continue
                old_faces = (
                    patch["triangles_a"] if cone_index == 0 else patch["triangles_b"]
                )
                target_faces = (
                    patch["triangles_b"] if cone_index == 0 else patch["triangles_a"]
                )
                cone_slab = _kernel._cell_slab_index(
                    working[cone["cell_indices"][0]],
                    points,
                    {z: index for index, z in enumerate(plane_values)},
                )
                if cone_slab is None or not _faces_have_exact_side_owners(
                    target_faces,
                    incidence,
                    working,
                    points,
                    patch["hull"],
                    -int(cone["side"]),
                    plane_values,
                    cone_slab,
                ):
                    continue
                updated = _guarded_two_to_two(
                    working, points, plane_values,
                    old_cell_indices=cone["cell_indices"],
                    quad=patch["quad"],
                    old_quad_faces=old_faces,
                    new_quad_faces=target_faces,
                    target_incidence=2,
                )
                if updated is None:
                    continue
                after_free = _free_internal_faces(updated, points, plane_values, bounds)
                if after_free != free_faces.difference(patch["patch_faces"]):
                    continue
                rank_key = (
                    tuple(points[node] for node in patch["quad"]),
                    points[int(cone["apex"])],
                    tuple(tuple(points[node] for node in face) for face in sorted(target_faces)),
                    cone_index,
                )
                legal_moves.append((rank_key, updated, patch["patch_faces"]))
        if not legal_moves:
            raise ValueError(
                "unsupported internal free-face quad: no exact guarded one-sided 2-to-2 reconciliation"
            )
        _rank, next_cells, removed_faces = min(legal_moves, key=lambda item: item[0])
        if len(free_faces.difference(removed_faces)) >= len(free_faces):
            raise ValueError("internal quad reconciliation did not strictly reduce free faces")
        working = next_cells


def _internal_outer_marker(periodic_boundary_pairs: object) -> int:
    """Reserve an un-emitted marker only for the existing schema normalizer."""
    used = {10}
    if isinstance(periodic_boundary_pairs, (tuple, list)):
        for entry in periodic_boundary_pairs:
            if not isinstance(entry, Mapping):
                continue
            for name in ("marker_a", "marker_b"):
                value = entry.get(name)
                if isinstance(value, Integral) and not isinstance(value, (bool, np.bool_)):
                    used.add(int(value))
    marker = 1
    while marker in used:
        marker += 1
    return marker


def _normalize_periodic_inputs(
    nodes: NDArray[np.float64],
    layer_planes: Sequence[float],
    bounds_xy: Sequence[float],
    original_indices: Sequence[int],
    periodic_boundary_pairs: object,
    periodic_node_pairs: object,
    periodic_patch_z_bounds: object,
) -> tuple[
    list[dict[str, object]],
    dict[str, dict[str, object]],
    list[dict[str, object]],
    dict[str, dict[int, int]],
]:
    raw_bounds = tuple(float(value) for value in bounds_xy)
    planes = np.asarray(layer_planes, dtype=np.float64)
    boundary_pairs, pair_by_id = _mesh_data._normalize_boundary_pairs(
        periodic_boundary_pairs,
        bounds_xy=raw_bounds,
        planes=planes,
        outer_boundary_marker=_internal_outer_marker(periodic_boundary_pairs),
        periodic_patch_z_bounds=periodic_patch_z_bounds,
    )
    node_pairs_input, maps_input = _mesh_data._normalize_node_pairs(
        periodic_node_pairs,
        pair_by_id=pair_by_id,
        node_count=len(nodes),
    )
    input_to_sorted = {
        int(original): sorted_id for sorted_id, original in enumerate(original_indices)
    }
    node_pairs = [
        {
            "pair_id": str(row["pair_id"]),
            "node_a": input_to_sorted[int(row["node_a"])],
            "node_b": input_to_sorted[int(row["node_b"])],
        }
        for row in node_pairs_input
    ]
    node_maps = {
        pair_id: {
            input_to_sorted[int(node_a)]: input_to_sorted[int(node_b)]
            for node_a, node_b in mapping.items()
        }
        for pair_id, mapping in maps_input.items()
    }
    return boundary_pairs, pair_by_id, node_pairs, node_maps


def _validate_authored_node_maps(
    sorted_nodes: NDArray[np.float64],
    bounds_xy: tuple[float, float, float, float],
    pair_by_id: Mapping[str, dict[str, object]],
    node_maps: Mapping[str, dict[int, int]],
) -> None:
    for pair_id, pair in pair_by_id.items():
        axis = int(pair["_axis"])
        side_a = str(pair["_side_a"])
        side_b = str(pair["_side_b"])
        side_a_nodes = _mesh_data._side_nodes(sorted_nodes, axis, side_a, bounds_xy)
        side_b_nodes = _mesh_data._side_nodes(sorted_nodes, axis, side_b, bounds_xy)
        mapping = node_maps[pair_id]
        if (
            len(side_a_nodes) != len(side_b_nodes)
            or set(mapping) != side_a_nodes
            or set(mapping.values()) != side_b_nodes
        ):
            raise ValueError(
                f"periodic node map {pair_id!r} must bijectively cover every node on both sides"
            )
        translation = np.asarray(pair["translation"], dtype=np.float64)
        tolerance = float(pair["tolerance_m"])
        for node_a, node_b in mapping.items():
            residual = float(
                np.max(np.abs((sorted_nodes[node_b] - sorted_nodes[node_a]) - translation))
            )
            if residual > tolerance:
                raise ValueError(
                    f"periodic node translation for {pair_id!r} exceeds tolerance_m"
                )

    pair_ids = sorted(pair_by_id)
    for left_index, left_id in enumerate(pair_ids):
        for right_id in pair_ids[left_index + 1 :]:
            left_map = node_maps[left_id]
            right_map = node_maps[right_id]
            for source in set(left_map).intersection(right_map):
                left_then_right = right_map.get(left_map[source])
                right_then_left = left_map.get(right_map[source])
                if left_then_right is None or left_then_right != right_then_left:
                    raise ValueError("periodic edge/corner node mappings do not commute")


def _side_coordinate(
    bounds_xy: tuple[float, float, float, float], axis: int, side: str
) -> float:
    if axis == 0:
        return bounds_xy[0] if side == "min" else bounds_xy[1]
    return bounds_xy[2] if side == "min" else bounds_xy[3]


def _on_side(
    face: _Face,
    nodes: NDArray[np.float64],
    bounds_xy: tuple[float, float, float, float],
    axis: int,
    side: str,
) -> bool:
    coordinate = _side_coordinate(bounds_xy, axis, side)
    return bool(np.all(nodes[np.asarray(face, dtype=np.int64), axis] == coordinate))


def _periodic_snapshots(
    cells: Sequence[_Cell],
    nodes: NDArray[np.float64],
    bounds_xy: tuple[float, float, float, float],
    boundary_pairs: list[dict[str, object]],
    node_maps: Mapping[str, dict[int, int]],
) -> dict[tuple[str, int, int], dict[str, object]]:
    incidence = _face_incidence(cells)
    exterior = {face for face, owners in incidence.items() if len(owners) == 1}
    pair_ids = sorted({str(pair["pair_id"]) for pair in boundary_pairs})
    result: dict[tuple[str, int, int], dict[str, object]] = {}
    for pair_id in pair_ids:
        patches = [pair for pair in boundary_pairs if str(pair["pair_id"]) == pair_id]
        pair = patches[0]
        axis = int(pair["_axis"])
        side_a = str(pair["_side_a"])
        side_b = str(pair["_side_b"])
        side_a_faces = {face for face in exterior if _on_side(face, nodes, bounds_xy, axis, side_a)}
        side_b_faces = {face for face in exterior if _on_side(face, nodes, bounds_xy, axis, side_b)}
        assigned_a: Counter[_Face] = Counter()
        assigned_b: Counter[_Face] = Counter()
        for patch in patches:
            key = (pair_id, int(patch["marker_a"]), int(patch["marker_b"]))
            z_low, z_high = float(patch["_z_low"]), float(patch["_z_high"])
            row_a = {
                face for face in side_a_faces
                if z_low <= float(np.min(nodes[np.asarray(face), 2]))
                and float(np.max(nodes[np.asarray(face), 2])) <= z_high
            }
            row_b = {
                face for face in side_b_faces
                if z_low <= float(np.min(nodes[np.asarray(face), 2]))
                and float(np.max(nodes[np.asarray(face), 2])) <= z_high
            }
            assigned_a.update(row_a)
            assigned_b.update(row_b)
            mapping = node_maps[pair_id]
            mapped_to_actual: dict[_Face, _Face] = {}
            for face in row_a:
                if any(node not in mapping for node in face):
                    raise ValueError(
                        f"periodic facet patch {pair_id!r} has an unmapped side-A node"
                    )
                mapped_face = tuple(sorted(mapping[node] for node in face))
                if mapped_face in mapped_to_actual:
                    raise ValueError(
                        f"periodic facet patch {pair_id!r} has duplicate mapped triangles"
                    )
                mapped_to_actual[mapped_face] = face
            mapped_faces = set(mapped_to_actual)
            result[key] = {
                "pair": patch,
                "a_faces": row_a,
                "b_faces": row_b,
                "mapped_to_actual": mapped_to_actual,
                "mapped_faces": mapped_faces,
                "missing": mapped_faces.difference(row_b),
                "extra": row_b.difference(mapped_faces),
            }
        if set(assigned_a) != side_a_faces or any(count != 1 for count in assigned_a.values()):
            raise ValueError(
                f"periodic facet patches for {pair_id!r} do not partition side-A faces"
            )
        if set(assigned_b) != side_b_faces or any(count != 1 for count in assigned_b.values()):
            raise ValueError(
                f"periodic facet patches for {pair_id!r} do not partition side-B faces"
            )
    return result


def _periodic_quad_patches(
    row: Mapping[str, object],
    node_map: Mapping[int, int],
    points: Sequence[_Point3],
) -> list[dict[str, object]]:
    missing = set(row["missing"])
    extra = set(row["extra"])
    mapped_faces = set(row["mapped_faces"])
    destination_faces = set(row["b_faces"])
    mismatches = sorted(missing | extra)
    candidates: dict[tuple[int, int, int, int], dict[str, object]] = {}
    inverse = {destination: source for source, destination in node_map.items()}
    for first, second in combinations(mismatches, 2):
        if len(set(first).intersection(second)) != 2:
            continue
        quad_b = tuple(sorted(set(first).union(second)))
        if len(quad_b) != 4:
            continue
        hull_b = _strict_convex_quad(quad_b, points)
        if hull_b is None:
            continue
        diagonal_a, diagonal_b = _diagonals(hull_b)
        triangles_a = _triangles_for_diagonal(quad_b, diagonal_a)
        triangles_b = _triangles_for_diagonal(quad_b, diagonal_b)
        a_on_quad = {face for face in mapped_faces if set(face).issubset(quad_b)}
        b_on_quad = {face for face in destination_faces if set(face).issubset(quad_b)}
        if (
            len(a_on_quad) != 2
            or len(b_on_quad) != 2
            or a_on_quad not in (triangles_a, triangles_b)
            or b_on_quad not in (triangles_a, triangles_b)
            or a_on_quad == b_on_quad
            or not a_on_quad.issubset(missing)
            or not b_on_quad.issubset(extra)
        ):
            continue
        quad_a = tuple(sorted(inverse[node] for node in quad_b))
        hull_a = _strict_convex_quad(quad_a, points)
        if hull_a is None:
            continue
        a_old = {tuple(sorted(inverse[node] for node in face)) for face in a_on_quad}
        a_target = {tuple(sorted(inverse[node] for node in face)) for face in b_on_quad}
        candidates[quad_b] = {
            "quad_a": quad_a,
            "quad_b": quad_b,
            "hull_a": hull_a,
            "hull_b": hull_b,
            "a_old": a_old,
            "a_target": a_target,
            "b_old": b_on_quad,
            "b_target": a_on_quad,
            "missing": a_on_quad,
            "extra": b_on_quad,
        }

    missing_coverage = Counter(
        face for patch in candidates.values() for face in patch["missing"]
    )
    extra_coverage = Counter(
        face for patch in candidates.values() for face in patch["extra"]
    )
    if (
        set(missing_coverage) != missing
        or set(extra_coverage) != extra
        or any(count != 1 for count in (*missing_coverage.values(), *extra_coverage.values()))
    ):
        raise ValueError(
            "unsupported periodic boundary mismatch: triangles do not partition into exact paired quads"
        )
    return sorted(
        candidates.values(),
        key=lambda patch: tuple(points[node] for node in patch["quad_b"]),
    )


def _reconcile_periodic_boundaries(
    cells: list[_Cell],
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
    sorted_nodes: NDArray[np.float64],
    bounds_xy: tuple[float, float, float, float],
    boundary_pairs: list[dict[str, object]],
    node_maps: Mapping[str, dict[int, int]],
) -> list[_Cell]:
    if not boundary_pairs:
        return cells
    working = list(cells)
    while True:
        snapshots = _periodic_snapshots(
            working, sorted_nodes, bounds_xy, boundary_pairs, node_maps
        )
        mismatch_rows = {
            key: row for key, row in snapshots.items()
            if row["missing"] or row["extra"]
        }
        if not mismatch_rows:
            return working

        row_patches: list[
            tuple[tuple[object, ...], tuple[str, int, int], dict[str, object]]
        ] = []
        for key, row in mismatch_rows.items():
            patches = _periodic_quad_patches(row, node_maps[key[0]], points)
            for patch in patches:
                row_patches.append(
                    (
                        (
                            key[0], key[1], key[2],
                            tuple(points[node] for node in patch["quad_b"]),
                        ),
                        key,
                        patch,
                    )
                )
        incidence = _face_incidence(working)
        legal_moves: list[tuple[tuple[object, ...], list[_Cell]]] = []
        before_count = sum(
            len(row["missing"]) + len(row["extra"]) for row in snapshots.values()
        )
        for patch_key, row_key, patch in row_patches:
            candidates = (
                ("a", patch["quad_a"], patch["hull_a"], patch["a_old"], patch["a_target"]),
                ("b", patch["quad_b"], patch["hull_b"], patch["b_old"], patch["b_target"]),
            )
            for side_index, (_side, quad, hull, old_faces, target_faces) in enumerate(candidates):
                cone = _cone_for_faces(old_faces, incidence, working, points, quad, hull)
                if cone is None:
                    continue
                updated = _guarded_two_to_two(
                    working, points, plane_values,
                    old_cell_indices=cone["cell_indices"],
                    quad=quad,
                    old_quad_faces=old_faces,
                    new_quad_faces=target_faces,
                    target_incidence=1,
                )
                if updated is None:
                    continue
                after = _periodic_snapshots(
                    updated, sorted_nodes, bounds_xy, boundary_pairs, node_maps
                )
                for key, before_row in snapshots.items():
                    after_row = after[key]
                    if key != row_key:
                        if (
                            after_row["missing"] != before_row["missing"]
                            or after_row["extra"] != before_row["extra"]
                        ):
                            break
                    elif (
                        after_row["missing"]
                        != set(before_row["missing"]).difference(patch["missing"])
                        or after_row["extra"]
                        != set(before_row["extra"]).difference(patch["extra"])
                    ):
                        break
                else:
                    after_count = sum(
                        len(row["missing"]) + len(row["extra"])
                        for row in after.values()
                    )
                    if after_count != before_count - 4:
                        continue
                    rank_key = (
                        *patch_key,
                        side_index,
                        points[int(cone["apex"])],
                        tuple(tuple(points[node] for node in face) for face in sorted(target_faces)),
                    )
                    legal_moves.append((rank_key, updated))
        if not legal_moves:
            raise ValueError(
                "unsupported periodic boundary quad: no exact guarded flip preserves the authored node-map state"
            )
        _rank, next_cells = min(legal_moves, key=lambda move: move[0])
        after_count = sum(
            len(row["missing"]) + len(row["extra"])
            for row in _periodic_snapshots(
                next_cells, sorted_nodes, bounds_xy, boundary_pairs, node_maps
            ).values()
        )
        if after_count >= before_count:
            raise ValueError(
                "periodic boundary reconciliation did not strictly reduce triangle mismatches"
            )
        working = next_cells


def _periodic_validator_facets(
    cells: Sequence[_Cell],
    sorted_nodes: NDArray[np.float64],
    bounds_xy: tuple[float, float, float, float],
    boundary_pairs: list[dict[str, object]],
) -> list[tuple[_Face, str, int]]:
    if not boundary_pairs:
        return []
    incidence = _face_incidence(cells)
    side_rows: dict[tuple[int, str], list[dict[str, object]]] = {}
    for pair in boundary_pairs:
        axis = int(pair["_axis"])
        side_rows.setdefault((axis, str(pair["_side_a"])), []).append(pair)
        side_rows.setdefault((axis, str(pair["_side_b"])), []).append(pair)
    facets: list[tuple[_Face, str, int]] = []
    for face, owners in incidence.items():
        if len(owners) != 1:
            continue
        matched: list[tuple[dict[str, object], str]] = []
        for axis in (0, 1):
            for side in ("min", "max"):
                if not _on_side(face, sorted_nodes, bounds_xy, axis, side):
                    continue
                patches = side_rows.get((axis, side), [])
                if not patches:
                    continue
                z_values = sorted(float(sorted_nodes[node, 2]) for node in face)
                matches = [
                    pair for pair in patches
                    if float(pair["_z_low"]) <= z_values[0]
                    and z_values[-1] <= float(pair["_z_high"])
                ]
                if len(matches) != 1:
                    raise ValueError(
                        f"periodic exterior facet on {axis=}, {side=} does not match exactly one z patch"
                    )
                matched.append((matches[0], side))
        if len(matched) > 1:
            raise ValueError("exterior facet lies on more than one periodic side")
        if not matched:
            continue
        pair, side = matched[0]
        marker = int(pair["marker_a"] if side == pair["_side_a"] else pair["marker_b"])
        facets.append((face, "periodic_seam", marker))
    return facets


def tetrahedralize_layered_box_delaunay(
    nodes: NDArray[np.float64] | list[list[float]],
    layer_planes: Sequence[float],
    bounds_xy: Sequence[float],
    *,
    periodic_boundary_pairs: Sequence[Mapping[str, object]] = (),
    periodic_node_pairs: Sequence[Mapping[str, object]] = (),
    periodic_patch_z_bounds: Mapping[
        tuple[str, int, int], tuple[float, float]
    ] | None = None,
) -> NDArray[np.int32]:
    """Return exact-validated, input-indexed Tet4 connectivity for layered boxes.

    Delaunay triangulation is performed independently for each exact adjacent
    z-plane pair. Qhull coordinates use the exact kernel's isotropic
    normalization for candidate generation only; caller SI nodes and planes
    are never modified. Unsupported exact-zero holes, non-quad gaps, illegal
    cavities, incomplete periodic maps, and unresolvable facets fail closed.
    """
    (
        points,
        sorted_coordinates,
        original_indices,
        plane_values,
        bounds,
    ) = _kernel._validate_and_prepare(nodes, np.asarray(layer_planes), bounds_xy)

    coordinates_in_input_order = np.asarray(nodes, dtype=np.float64)
    raw_bounds = np.asarray(bounds_xy, dtype=np.float64)
    if raw_bounds.shape != (4,):
        raise ValueError("bounds_xy must contain xmin, xmax, ymin, ymax")
    normalized_bounds = tuple(float(value) for value in raw_bounds)
    sorted_nodes = np.asarray(sorted_coordinates, dtype=np.float64)

    boundary_pairs, pair_by_id, node_pairs, node_maps = _normalize_periodic_inputs(
        coordinates_in_input_order,
        layer_planes,
        normalized_bounds,
        original_indices,
        periodic_boundary_pairs,
        periodic_node_pairs,
        periodic_patch_z_bounds,
    )
    _validate_authored_node_maps(
        sorted_nodes, normalized_bounds, pair_by_id, node_maps
    )

    try:
        from scipy.spatial import Delaunay, QhullError
    except ImportError as exc:
        raise RuntimeError(
            "SciPy is required for the private layered-box Delaunay candidate"
        ) from exc

    plane_index_by_z = {z: index for index, z in enumerate(plane_values)}
    candidate_cells: list[_Cell] = []
    candidate_keys: set[tuple[int, int, int, int]] = set()
    for slab in range(len(plane_values) - 1):
        slab_node_ids = [
            node for node, point in enumerate(points)
            if plane_index_by_z[point[2]] in (slab, slab + 1)
        ]
        if len(slab_node_ids) < 4:
            raise ValueError(f"exact z slab {slab} has fewer than four candidate nodes")
        qhull_coordinates = np.asarray(
            [[float(value) for value in points[node]] for node in slab_node_ids],
            dtype=np.float64,
        )
        try:
            triangulation = Delaunay(qhull_coordinates)
        except QhullError as exc:
            raise ValueError(f"SciPy Delaunay failed for exact z slab {slab}") from exc
        local_cells = _exact_positive_simplices(
            [points[node] for node in slab_node_ids],
            triangulation.simplices,
        )
        for local_cell in local_cells:
            cell = tuple(slab_node_ids[node] for node in local_cell)
            key = tuple(sorted(cell))
            if key in candidate_keys:
                raise ValueError("per-slab Delaunay candidates contain duplicate tetrahedra")
            candidate_keys.add(key)
            candidate_cells.append(cell)

    candidate_cells.sort(key=lambda cell: tuple(sorted(cell)))
    _require_all_nodes_used(candidate_cells, len(points))
    candidate_cells = _reconcile_internal_free_faces(
        candidate_cells, points, plane_values, bounds
    )
    candidate_cells = _reconcile_periodic_boundaries(
        candidate_cells,
        points,
        plane_values,
        sorted_nodes,
        normalized_bounds,
        boundary_pairs,
        node_maps,
    )

    _kernel._validate_tetrahedralization(
        candidate_cells, points, plane_values, bounds
    )
    if boundary_pairs:
        facets = _periodic_validator_facets(
            candidate_cells, sorted_nodes, normalized_bounds, boundary_pairs
        )
        _mesh_data._validate_periodic_topology(
            nodes=sorted_nodes,
            facets=facets,
            bounds_xy=normalized_bounds,
            boundary_pairs=boundary_pairs,
            node_maps=node_maps,
            node_pairs=node_pairs,
        )

    ordered_cells = sorted(candidate_cells, key=lambda cell: tuple(sorted(cell)))
    return np.asarray(
        [
            [int(original_indices[node]) for node in cell]
            for cell in ordered_cells
        ],
        dtype=np.int32,
    ).reshape((-1, 4))
