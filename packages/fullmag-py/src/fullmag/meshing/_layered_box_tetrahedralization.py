"""Exact-predicate prototype for conforming layered rectangular-box tets.

This internal kernel starts from a globally conforming Freudenthal seed,
inserts the supplied cap nodes by stellar face or edge subdivision, then
applies only exact, quality-improving cap-edge flips with a shared cavity on
both sides of an internal cap. It keeps the original float64 nodes unchanged
and returns Tet4 connectivity in their input order. It does not route
production meshes or certify periodic boundary conditions.

Predicates use Fraction.from_float so they are exact for the represented
binary64 inputs. An exact isotropic centering and scaling transform reduces
coordinate magnitude without changing any predicate. Each insertion rescans
the current topology; together with
arbitrary-precision rational arithmetic this is a correctness prototype, not a
large-mesh algorithm (quadratic in node count when the cell count grows
linearly, and potentially worse for high-valence edge splits). The cap-quality
pass caches exact Q² by canonical cell key, signed determinants by ordered
cell key, and convexity by geometry-ordered quad. It precomputes geometry ranks
and builds all plane cap maps in one cell pass, but restarts its deterministic
cap-edge scan after each accepted flip; its worst-case cost still scales with
accepted flips times cap topology. No large-mesh performance qualification is
claimed.
"""
from __future__ import annotations

from fractions import Fraction
from itertools import combinations, permutations
from typing import Sequence

import numpy as np


_Exact = Fraction
_Point3 = tuple[_Exact, _Exact, _Exact]
_Cell = tuple[int, int, int, int]
_Face = tuple[int, int, int]
_Edge = tuple[int, int]


def _as_fraction(value: float) -> _Exact:
    return Fraction.from_float(float(value))


def _orient2d(a: _Point3, b: _Point3, p: _Point3) -> _Exact:
    return (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])


def _orient3d(points: Sequence[_Point3], cell: _Cell) -> _Exact:
    a, b, c, d = (points[index] for index in cell)
    ax, ay, az = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    bx, by, bz = c[0] - a[0], c[1] - a[1], c[2] - a[2]
    cx, cy, cz = d[0] - a[0], d[1] - a[1], d[2] - a[2]
    return (
        ax * (by * cz - bz * cy)
        - ay * (bx * cz - bz * cx)
        + az * (bx * cy - by * cx)
    )


def _cached_orient3d(
    points: Sequence[_Point3],
    cell: _Cell,
    determinant_cache: dict[_Cell, _Exact],
) -> _Exact:
    """Reuse an exact signed determinant for the same ordered cell."""
    determinant = determinant_cache.get(cell)
    if determinant is None:
        determinant = _orient3d(points, cell)
        determinant_cache[cell] = determinant
    return determinant


def _positive_cell(
    cell: _Cell,
    points: Sequence[_Point3],
    determinant_cache: dict[_Cell, _Exact] | None = None,
) -> _Cell:
    determinant = (
        _orient3d(points, cell)
        if determinant_cache is None
        else _cached_orient3d(points, cell, determinant_cache)
    )
    if determinant == 0:
        raise ValueError("tetrahedralization would create a degenerate tetrahedron")
    if determinant < 0:
        return (cell[1], cell[0], cell[2], cell[3])
    return cell


def _point_on_segment(p: _Point3, a: _Point3, b: _Point3) -> bool:
    return (
        _orient2d(a, b, p) == 0
        and min(a[0], b[0]) <= p[0] <= max(a[0], b[0])
        and min(a[1], b[1]) <= p[1] <= max(a[1], b[1])
    )


def _strictly_inside_triangle(p: _Point3, a: _Point3, b: _Point3, c: _Point3) -> bool:
    signs = (_orient2d(a, b, p), _orient2d(b, c, p), _orient2d(c, a, p))
    return all(sign > 0 for sign in signs) or all(sign < 0 for sign in signs)


def _cap_face_cells(
    cells: Sequence[_Cell], points: Sequence[_Point3], z: _Exact
) -> dict[_Face, list[int]]:
    result: dict[_Face, list[int]] = {}
    for cell_index, cell in enumerate(cells):
        for omitted in range(4):
            face = tuple(sorted(cell[index] for index in range(4) if index != omitted))
            if all(points[index][2] == z for index in face):
                result.setdefault(face, []).append(cell_index)
    return result


def _cap_faces_by_plane(
    cells: Sequence[_Cell],
    node_plane_indices: Sequence[int | None],
    plane_count: int,
) -> list[dict[_Face, list[int]]]:
    """Build each requested plane's cap-face map in one deterministic cell scan."""
    result: list[dict[_Face, list[int]]] = [{} for _ in range(plane_count)]
    for cell_index, cell in enumerate(cells):
        for omitted in range(4):
            face = tuple(sorted(cell[index] for index in range(4) if index != omitted))
            plane_index = node_plane_indices[face[0]]
            if plane_index is None or any(
                node_plane_indices[vertex] != plane_index for vertex in face[1:]
            ):
                continue
            result[plane_index].setdefault(face, []).append(cell_index)
    return result


def _triangle_area2(points: Sequence[_Point3], face: _Face) -> _Exact:
    a, b, c = (points[index] for index in face)
    return _orient2d(a, b, c)


def _positive_projected_area(
    points: Sequence[_Point3], face: _Face, first_axis: int, second_axis: int
) -> _Exact:
    a, b, c = (points[index] for index in face)
    return abs(
        (b[first_axis] - a[first_axis]) * (c[second_axis] - a[second_axis])
        - (b[second_axis] - a[second_axis]) * (c[first_axis] - a[first_axis])
    )


def _validate_and_prepare(
    nodes: np.ndarray,
    layer_planes: np.ndarray,
    bounds_xy: Sequence[float],
) -> tuple[
    list[_Point3],
    list[tuple[float, float, float]],
    list[int],
    list[_Exact],
    tuple[_Exact, _Exact, _Exact, _Exact],
]:
    if any(np.iscomplexobj(value) for value in (nodes, layer_planes, bounds_xy)):
        raise ValueError("nodes, layer_planes, and bounds_xy must be real")
    try:
        raw_nodes = np.asarray(nodes, dtype=np.float64)
        raw_planes = np.asarray(layer_planes, dtype=np.float64)
        raw_bounds = np.asarray(bounds_xy, dtype=np.float64)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("nodes, layer_planes, and bounds_xy must be numeric") from exc

    if raw_nodes.ndim != 2 or raw_nodes.shape[1] != 3 or raw_nodes.shape[0] < 8:
        raise ValueError("nodes must be a finite Nx3 array containing at least eight corners")
    if not np.all(np.isfinite(raw_nodes)):
        raise ValueError("nodes must be finite")
    if raw_planes.ndim != 1 or raw_planes.size < 2:
        raise ValueError(
            "layer_planes must be a finite one-dimensional sequence with at least two values"
        )
    if not np.all(np.isfinite(raw_planes)):
        raise ValueError("layer_planes must be finite")
    if not np.all(raw_planes[1:] > raw_planes[:-1]):
        raise ValueError("layer_planes must be strictly increasing")
    if raw_bounds.shape != (4,) or not np.all(np.isfinite(raw_bounds)):
        raise ValueError("bounds_xy must be four finite values (xmin, xmax, ymin, ymax)")

    xmin_f, xmax_f, ymin_f, ymax_f = (float(value) for value in raw_bounds)
    if not (xmin_f < xmax_f and ymin_f < ymax_f):
        raise ValueError("bounds_xy must have positive x and y spans")

    input_coordinates = [tuple(float(value) for value in row) for row in raw_nodes]
    if len(set(input_coordinates)) != len(input_coordinates):
        raise ValueError("duplicate input node coordinates are not supported")

    plane_floats = [float(value) for value in raw_planes]
    plane_set = set(plane_floats)
    xmin, xmax, ymin, ymax = (_as_fraction(value) for value in (xmin_f, xmax_f, ymin_f, ymax_f))
    plane_values = [_as_fraction(value) for value in plane_floats]

    for x, y, z in input_coordinates:
        if z not in plane_set:
            raise ValueError("every node must lie on a requested z plane")
        x_exact, y_exact = _as_fraction(x), _as_fraction(y)
        if not (xmin <= x_exact <= xmax and ymin <= y_exact <= ymax):
            raise ValueError("node lies outside the xy bounds")

    required_corners = {
        (x, y, z)
        for z in plane_floats
        for x, y in ((xmin_f, ymin_f), (xmax_f, ymin_f), (xmax_f, ymax_f), (xmin_f, ymax_f))
    }
    present_coordinates = set(input_coordinates)
    if not required_corners.issubset(present_coordinates):
        raise ValueError("each requested z plane must contain all four box corners")

    if len(input_coordinates) > np.iinfo(np.int32).max:
        raise ValueError("node count exceeds the supported int32 connectivity range")

    sorted_coordinates = sorted(input_coordinates, key=lambda point: (point[2], point[0], point[1]))
    original_index_by_coordinate = {
        coordinate: index for index, coordinate in enumerate(input_coordinates)
    }
    original_indices = [
        original_index_by_coordinate[coordinate] for coordinate in sorted_coordinates
    ]
    exact_points = [
        (_as_fraction(x), _as_fraction(y), _as_fraction(z))
        for x, y, z in sorted_coordinates
    ]
    center = (
        (xmin + xmax) / 2,
        (ymin + ymax) / 2,
        (plane_values[0] + plane_values[-1]) / 2,
    )
    isotropic_scale = max(
        xmax - xmin,
        ymax - ymin,
        plane_values[-1] - plane_values[0],
    )
    exact_points = [
        tuple(
            (coordinate[axis] - center[axis]) / isotropic_scale
            for axis in range(3)
        )
        for coordinate in exact_points
    ]
    plane_values = [
        (z_value - center[2]) / isotropic_scale for z_value in plane_values
    ]
    normalized_bounds = (
        (xmin - center[0]) / isotropic_scale,
        (xmax - center[0]) / isotropic_scale,
        (ymin - center[1]) / isotropic_scale,
        (ymax - center[1]) / isotropic_scale,
    )
    return (
        exact_points,
        sorted_coordinates,
        original_indices,
        plane_values,
        normalized_bounds,
    )


def _seed_freudenthal(
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
    bounds: tuple[_Exact, _Exact, _Exact, _Exact],
) -> list[_Cell]:
    point_to_id = {point: index for index, point in enumerate(points)}
    xmin, xmax, ymin, ymax = bounds
    corner_xy = (
        (xmin, ymin),
        (xmax, ymin),
        (xmax, ymax),
        (xmin, ymax),
    )
    plane_to_corner_ids: list[tuple[int, int, int, int]] = []
    for z_value in plane_values:
        plane_to_corner_ids.append(
            tuple(point_to_id[(x, y, z_value)] for x, y in corner_xy)
        )

    xy_corner_index = {(0, 0): 0, (1, 0): 1, (1, 1): 2, (0, 1): 3}

    def corner_id(bits: Sequence[int], lower_plane: int, upper_plane: int) -> int:
        x_bit, y_bit, z_bit = bits
        plane_index = upper_plane if z_bit else lower_plane
        return plane_to_corner_ids[plane_index][xy_corner_index[(x_bit, y_bit)]]

    cells: list[_Cell] = []
    for slab in range(len(plane_values) - 1):
        for axis_order in permutations((0, 1, 2)):
            bits = [0, 0, 0]
            path = [corner_id(bits, slab, slab + 1)]
            for axis in axis_order:
                bits[axis] = 1
                path.append(corner_id(bits, slab, slab + 1))
            cells.append(_positive_cell(tuple(path), points))
    return cells


def _insert_cap_node(
    cells: list[_Cell],
    points: Sequence[_Point3],
    point_id: int,
    plane_index: int,
    plane_values: Sequence[_Exact],
) -> list[_Cell]:
    point = points[point_id]
    z_value = plane_values[plane_index]
    cap_faces = _cap_face_cells(cells, points, z_value)
    if not cap_faces:
        raise ValueError("unsupported cap: no current triangles on requested z plane")

    cap_edges = {
        tuple(sorted((face[first], face[second])))
        for face in cap_faces
        for first, second in combinations(range(3), 2)
    }
    edge_matches = [
        edge
        for edge in sorted(cap_edges)
        if _point_on_segment(point, points[edge[0]], points[edge[1]])
    ]
    if len(edge_matches) > 1:
        raise ValueError("unsupported cap: point lies on multiple distinct cap edges")

    if edge_matches:
        edge = edge_matches[0]
        replacement: list[_Cell] = []
        split_count = 0
        for cell in cells:
            if edge[0] in cell and edge[1] in cell:
                opposite = [vertex for vertex in cell if vertex not in edge]
                if len(opposite) != 2:
                    raise ValueError("unsupported cap edge incidence")
                replacement.append(
                    _positive_cell((edge[0], point_id, opposite[0], opposite[1]), points)
                )
                replacement.append(
                    _positive_cell((point_id, edge[1], opposite[0], opposite[1]), points)
                )
                split_count += 1
            else:
                replacement.append(cell)
        if split_count == 0:
            raise ValueError("unsupported cap: located edge has no incident tetrahedra")
        return replacement

    containing_faces = [
        face
        for face in sorted(cap_faces)
        if _strictly_inside_triangle(
            point, points[face[0]], points[face[1]], points[face[2]]
        )
    ]
    if len(containing_faces) != 1:
        raise ValueError("point is not strictly contained in exactly one current cap triangle")

    face = containing_faces[0]
    incident_cells = cap_faces[face]
    expected_incidence = 1 if plane_index in (0, len(plane_values) - 1) else 2
    if len(incident_cells) != expected_incidence:
        raise ValueError("unsupported cap: cap triangle has unexpected tetrahedron incidence")

    face_vertices = tuple(face)
    replacement = []
    incident_set = set(incident_cells)
    for cell_index, cell in enumerate(cells):
        if cell_index not in incident_set:
            replacement.append(cell)
            continue
        opposite = [vertex for vertex in cell if vertex not in face_vertices]
        if len(opposite) != 1:
            raise ValueError("unsupported cap triangle incidence")
        opposite_vertex = opposite[0]
        a, b, c = face_vertices
        replacement.extend(
            (
                _positive_cell((point_id, a, b, opposite_vertex), points),
                _positive_cell((point_id, b, c, opposite_vertex), points),
                _positive_cell((point_id, c, a, opposite_vertex), points),
            )
        )
    return replacement


def _cell_slab_index(
    cell: _Cell,
    points: Sequence[_Point3],
    plane_index_by_z: dict[_Exact, int],
) -> int | None:
    try:
        indices = [plane_index_by_z[points[vertex][2]] for vertex in cell]
    except KeyError:
        return None
    lower, upper = min(indices), max(indices)
    if upper != lower + 1:
        return None
    return lower


def _cavity_face_counts(cells: Sequence[_Cell]) -> dict[_Face, int] | None:
    counts: dict[_Face, int] = {}
    for cell in cells:
        if len(set(cell)) != 4:
            return None
        for omitted in range(4):
            face = tuple(sorted(cell[index] for index in range(4) if index != omitted))
            counts[face] = counts.get(face, 0) + 1
            if counts[face] > 2:
                return None
    return counts


def _tetrahedron_quality_q2(
    points: Sequence[_Point3],
    cell: _Cell,
    determinant_cache: dict[_Cell, _Exact] | None = None,
) -> _Exact:
    determinant = (
        _orient3d(points, cell)
        if determinant_cache is None
        else _cached_orient3d(points, cell, determinant_cache)
    )
    if determinant <= 0:
        raise ValueError("cap flip cavity contains a nonpositive tetrahedron")
    max_edge_squared = max(
        sum((points[left][axis] - points[right][axis]) ** 2 for axis in range(3))
        for left, right in combinations(cell, 2)
    )
    return determinant**2 / max_edge_squared**3


def _cap_edge_flip_candidate(
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
    plane_index: int,
    first_face: _Face,
    second_face: _Face,
    cap_faces: dict[_Face, list[int]],
    cap_edges: set[_Edge],
    quality_cache: dict[_Cell, _Exact],
    cell_indices_by_key: dict[_Cell, int],
    plane_index_by_z: dict[_Exact, int],
    geometry_rank: Sequence[int],
    convexity_cache: dict[tuple[int, int, int, int], bool],
    determinant_cache: dict[_Cell, _Exact],
) -> tuple[tuple[int, ...], tuple[_Cell, ...]] | None:
    """Return a legal strictly improving cavity replacement, if one exists."""
    if first_face not in cap_faces or second_face not in cap_faces:
        return None
    if any(
        points[vertex][2] != plane_values[plane_index]
        for vertex in (*first_face, *second_face)
    ):
        return None

    shared = set(first_face).intersection(second_face)
    if len(shared) != 2:
        return None
    edge = tuple(sorted(shared, key=geometry_rank.__getitem__))
    opposite_vertices = set(first_face).union(second_face).difference(shared)
    if len(opposite_vertices) != 2:
        return None
    first_opposite, second_opposite = sorted(
        opposite_vertices, key=geometry_rank.__getitem__
    )
    new_diagonal = tuple(sorted((first_opposite, second_opposite)))
    if new_diagonal in cap_edges:
        return None

    quad_key = (edge[0], edge[1], first_opposite, second_opposite)
    strictly_convex = convexity_cache.get(quad_key)
    if strictly_convex is None:
        a, b = points[edge[0]], points[edge[1]]
        c, d = points[first_opposite], points[second_opposite]
        strictly_convex = (
            _orient2d(a, b, c) * _orient2d(a, b, d) < 0
            and _orient2d(c, d, a) * _orient2d(c, d, b) < 0
        )
        convexity_cache[quad_key] = strictly_convex
    if not strictly_convex:
        return None

    adjacent_slabs = (
        [0]
        if plane_index == 0
        else [len(plane_values) - 2]
        if plane_index == len(plane_values) - 1
        else [plane_index - 1, plane_index]
    )
    def owners(face: _Face) -> dict[int, tuple[int, int]] | None:
        by_slab: dict[int, tuple[int, int]] = {}
        for cell_index in cap_faces[face]:
            cell = cells[cell_index]
            opposite = set(cell).difference(face)
            if len(opposite) != 1:
                return None
            slab = _cell_slab_index(cell, points, plane_index_by_z)
            if slab not in adjacent_slabs or slab in by_slab:
                return None
            by_slab[slab] = (cell_index, next(iter(opposite)))
        if set(by_slab) != set(adjacent_slabs):
            return None
        return by_slab

    first_owners = owners(first_face)
    second_owners = owners(second_face)
    if first_owners is None or second_owners is None:
        return None
    if any(
        first_owners[slab][1] != second_owners[slab][1]
        for slab in adjacent_slabs
    ):
        return None

    cavity_indices = tuple(
        sorted(
            [first_owners[slab][0] for slab in adjacent_slabs]
            + [second_owners[slab][0] for slab in adjacent_slabs]
        )
    )
    if len(set(cavity_indices)) != 2 * len(adjacent_slabs):
        return None
    old_cavity = tuple(cells[index] for index in cavity_indices)

    new_cap_faces = {
        tuple(sorted((edge[0], first_opposite, second_opposite))),
        tuple(sorted((edge[1], first_opposite, second_opposite))),
    }
    old_cap_faces = {first_face, second_face}
    if any(face in cap_faces and face not in old_cap_faces for face in new_cap_faces):
        return None

    new_cavity_list: list[_Cell] = []
    new_cavity_by_slab: dict[int, tuple[_Cell, _Cell]] = {}
    try:
        for slab in adjacent_slabs:
            apex = first_owners[slab][1]
            slab_cells = (
                _positive_cell(
                    (edge[0], first_opposite, second_opposite, apex),
                    points,
                    determinant_cache,
                ),
                _positive_cell(
                    (edge[1], first_opposite, second_opposite, apex),
                    points,
                    determinant_cache,
                ),
            )
            new_cavity_by_slab[slab] = slab_cells
            new_cavity_list.extend(slab_cells)
    except ValueError:
        return None
    new_cavity = tuple(new_cavity_list)

    old_nodes = {vertex for cell in old_cavity for vertex in cell}
    new_nodes = {vertex for cell in new_cavity for vertex in cell}
    if new_nodes != old_nodes:
        return None
    if any(
        _cached_orient3d(points, cell, determinant_cache) <= 0
        for cell in new_cavity
    ):
        return None

    def cached_quality(cell: _Cell) -> _Exact:
        key = tuple(sorted(cell))
        if key not in quality_cache:
            quality_cache[key] = _tetrahedron_quality_q2(
                points, cell, determinant_cache
            )
        return quality_cache[key]

    try:
        old_quality = tuple(sorted(cached_quality(cell) for cell in old_cavity))
    except ValueError:
        return None
    new_quality = tuple(sorted(cached_quality(cell) for cell in new_cavity))
    if not new_quality > old_quality:
        return None

    for slab in adjacent_slabs:
        old_slab_cells = (
            cells[first_owners[slab][0]],
            cells[second_owners[slab][0]],
        )
        old_volume6 = sum(
            (
                _cached_orient3d(points, cell, determinant_cache)
                for cell in old_slab_cells
            ),
            Fraction(0),
        )
        new_volume6 = sum(
            (
                _cached_orient3d(points, cell, determinant_cache)
                for cell in new_cavity_by_slab[slab]
            ),
            Fraction(0),
        )
        if old_volume6 != new_volume6:
            return None

    old_face_counts = _cavity_face_counts(old_cavity)
    new_face_counts = _cavity_face_counts(new_cavity)
    if old_face_counts is None or new_face_counts is None:
        return None
    cap_face_changes = old_cap_faces | new_cap_faces
    old_boundary = {face for face, count in old_face_counts.items() if count == 1}
    new_boundary = {face for face, count in new_face_counts.items() if count == 1}
    if (old_boundary - cap_face_changes) != (new_boundary - cap_face_changes):
        return None
    expected_cap_incidence = len(adjacent_slabs)
    if any(
        old_face_counts.get(face) != expected_cap_incidence for face in old_cap_faces
    ):
        return None
    if any(new_face_counts.get(face) != expected_cap_incidence for face in new_cap_faces):
        return None

    replacement_keys = [tuple(sorted(cell)) for cell in new_cavity]
    if len(set(replacement_keys)) != len(replacement_keys):
        return None
    cavity_index_set = set(cavity_indices)
    if any(
        key in cell_indices_by_key and cell_indices_by_key[key] not in cavity_index_set
        for key in replacement_keys
    ):
        return None
    return cavity_indices, new_cavity


def _improve_cap_edges(
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
) -> list[_Cell]:
    """Apply deterministic, exact-quality-improving cap-edge flips to closure."""
    improved = list(cells)
    quality_cache: dict[_Cell, _Exact] = {}
    determinant_cache: dict[_Cell, _Exact] = {}
    convexity_cache: dict[tuple[int, int, int, int], bool] = {}
    geometry_order = sorted(range(len(points)), key=points.__getitem__)
    geometry_rank = [0] * len(points)
    for rank, vertex in enumerate(geometry_order):
        geometry_rank[vertex] = rank
    plane_index_by_z = {z_value: index for index, z_value in enumerate(plane_values)}
    node_plane_indices = tuple(
        plane_index_by_z.get(point[2]) for point in points
    )
    # The exact sorted Q² vector is a strict potential over finitely many fixed-node,
    # fixed-cell-count topologies, so no heuristic iteration cap is needed.
    while True:
        accepted = False
        cell_indices_by_key = {
            tuple(sorted(cell)): index for index, cell in enumerate(improved)
        }
        cap_faces_by_plane = _cap_faces_by_plane(
            improved, node_plane_indices, len(plane_values)
        )
        for plane_index, cap_faces in enumerate(cap_faces_by_plane):
            edge_faces: dict[_Edge, list[_Face]] = {}
            for face in cap_faces:
                for first, second in combinations(face, 2):
                    edge_faces.setdefault(tuple(sorted((first, second))), []).append(face)

            ordered_edges = sorted(
                edge_faces,
                key=lambda edge: tuple(sorted(geometry_rank[vertex] for vertex in edge)),
            )
            cap_edges = set(edge_faces)
            for edge in ordered_edges:
                adjacent_faces = edge_faces[edge]
                if len(adjacent_faces) != 2:
                    continue
                first_face, second_face = sorted(
                    adjacent_faces,
                    key=lambda face: tuple(sorted(geometry_rank[vertex] for vertex in face)),
                )
                candidate = _cap_edge_flip_candidate(
                    improved,
                    points,
                    plane_values,
                    plane_index,
                    first_face,
                    second_face,
                    cap_faces,
                    cap_edges,
                    quality_cache,
                    cell_indices_by_key,
                    plane_index_by_z,
                    geometry_rank,
                    convexity_cache,
                    determinant_cache,
                )
                if candidate is None:
                    continue
                cavity_indices, replacement = candidate
                cavity_set = set(cavity_indices)
                first_cavity_index = min(cavity_indices)
                next_cells: list[_Cell] = []
                for cell_index, cell in enumerate(improved):
                    if cell_index == first_cavity_index:
                        next_cells.extend(replacement)
                    if cell_index not in cavity_set:
                        next_cells.append(cell)
                improved = next_cells
                accepted = True
                break
            if accepted:
                break
        if not accepted:
            return improved


def _validate_tetrahedralization(
    cells: Sequence[_Cell],
    points: Sequence[_Point3],
    plane_values: Sequence[_Exact],
    bounds: tuple[_Exact, _Exact, _Exact, _Exact],
) -> None:
    if not cells:
        raise ValueError("tetrahedralization is empty")
    if len({tuple(sorted(cell)) for cell in cells}) != len(cells):
        raise ValueError("tetrahedralization contains duplicate tetrahedra")

    used_nodes: set[int] = set()
    plane_index_by_z = {z: index for index, z in enumerate(plane_values)}
    slab_volumes = [Fraction(0) for _ in range(len(plane_values) - 1)]
    face_slabs: dict[_Face, list[int]] = {}
    for cell in cells:
        used_nodes.update(cell)
        determinant = _orient3d(points, cell)
        if determinant <= 0:
            raise ValueError("tetrahedralization contains a nonpositive-volume tetrahedron")
        z_indices = [plane_index_by_z[points[index][2]] for index in cell]
        low, high = min(z_indices), max(z_indices)
        if high - low != 1:
            raise ValueError("tetrahedron crosses a requested layer slab")
        slab_volumes[low] += determinant / 6
        for omitted in range(4):
            face = tuple(sorted(cell[index] for index in range(4) if index != omitted))
            face_slabs.setdefault(face, []).append(low)

    if used_nodes != set(range(len(points))):
        raise ValueError("tetrahedralization does not use every input node")

    xmin, xmax, ymin, ymax = bounds
    expected_slab_area = (xmax - xmin) * (ymax - ymin)
    for slab, volume in enumerate(slab_volumes):
        expected = expected_slab_area * (plane_values[slab + 1] - plane_values[slab])
        if volume != expected:
            raise ValueError("tetrahedra do not exactly cover a requested layer slab")

    cap_faces_by_plane: list[list[_Face]] = [[] for _ in plane_values]
    side_areas = {
        ("x", xmin): Fraction(0),
        ("x", xmax): Fraction(0),
        ("y", ymin): Fraction(0),
        ("y", ymax): Fraction(0),
    }
    for face, incident_slabs in face_slabs.items():
        if len(incident_slabs) not in (1, 2):
            raise ValueError("face incidence must be one or two")
        face_points = [points[index] for index in face]
        face_zs = {point[2] for point in face_points}
        boundary_axis: tuple[str, _Exact] | None = None
        if all(point[0] == xmin for point in face_points):
            boundary_axis = ("x", xmin)
        elif all(point[0] == xmax for point in face_points):
            boundary_axis = ("x", xmax)
        elif all(point[1] == ymin for point in face_points):
            boundary_axis = ("y", ymin)
        elif all(point[1] == ymax for point in face_points):
            boundary_axis = ("y", ymax)
        elif len(face_zs) == 1 and next(iter(face_zs)) in (plane_values[0], plane_values[-1]):
            boundary_axis = ("z", next(iter(face_zs)))

        if boundary_axis is not None and len(incident_slabs) != 1:
            raise ValueError("box-boundary face must have one incident tetrahedron")
        if len(incident_slabs) == 1 and boundary_axis is None:
            raise ValueError("exterior face lies away from the box boundary")

        if len(face_zs) == 1:
            z_value = next(iter(face_zs))
            plane_index = plane_index_by_z[z_value]
            cap_faces_by_plane[plane_index].append(face)
            if plane_index not in (0, len(plane_values) - 1):
                if sorted(incident_slabs) != [plane_index - 1, plane_index]:
                    raise ValueError("internal cap face is not shared by adjacent slabs")

        if boundary_axis is not None and boundary_axis[0] in ("x", "y"):
            if boundary_axis[0] == "x":
                area2 = _positive_projected_area(points, face, 1, 2)
            else:
                area2 = _positive_projected_area(points, face, 0, 2)
            side_areas[boundary_axis] += area2 / 2

    for plane_index, cap_faces in enumerate(cap_faces_by_plane):
        if not cap_faces:
            raise ValueError("a requested z plane has no triangulated cap")
        area = sum(
            (abs(_triangle_area2(points, face)) / 2 for face in cap_faces),
            Fraction(0),
        )
        if area != expected_slab_area:
            raise ValueError("cap triangles do not exactly cover the box cross-section")
        expected_incidence = 1 if plane_index in (0, len(plane_values) - 1) else 2
        for face in cap_faces:
            if len(face_slabs[face]) != expected_incidence:
                raise ValueError("cap face has incorrect incidence")
            if expected_incidence == 2 and sorted(face_slabs[face]) != [
                plane_index - 1,
                plane_index,
            ]:
                raise ValueError("internal cap is not shared by its adjacent slabs")

    expected_height = plane_values[-1] - plane_values[0]
    expected_x_side_area = (ymax - ymin) * expected_height
    expected_y_side_area = (xmax - xmin) * expected_height
    if side_areas[("x", xmin)] != expected_x_side_area:
        raise ValueError("xmin exterior faces do not cover the box side")
    if side_areas[("x", xmax)] != expected_x_side_area:
        raise ValueError("xmax exterior faces do not cover the box side")
    if side_areas[("y", ymin)] != expected_y_side_area:
        raise ValueError("ymin exterior faces do not cover the box side")
    if side_areas[("y", ymax)] != expected_y_side_area:
        raise ValueError("ymax exterior faces do not cover the box side")


def tetrahedralize_layered_box(
    nodes: np.ndarray,
    layer_planes: Sequence[float],
    bounds_xy: Sequence[float],
) -> np.ndarray:
    """Return positive Tet4 connectivity for a rectangular box with layered caps.

    Args:
        nodes: Finite (N, 3) SI coordinates, with every z coordinate equal to
            one requested layer plane and all four box corners present on
            every plane. No node is added, removed, or perturbed.
        layer_planes: Strictly increasing exact-z planes.
        bounds_xy: (xmin, xmax, ymin, ymax) rectangular cross-section.

    Returns:
        An (M, 4) int32 array indexing nodes. Cell order and connectivity are
        deterministic by physical geometry, independent of the input node order.

    Raises:
        ValueError: If the input geometry is invalid or a point cannot be
            inserted conformingly into the current cap triangulation.
    """
    (
        exact_points,
        _sorted_coordinates,
        original_indices,
        plane_values,
        bounds,
    ) = _validate_and_prepare(nodes, np.asarray(layer_planes), bounds_xy)

    cells = _seed_freudenthal(exact_points, plane_values, bounds)
    plane_index_by_z = {z: index for index, z in enumerate(plane_values)}
    xmin, xmax, ymin, ymax = bounds
    corner_points = {
        (x, y, z)
        for z in plane_values
        for x, y in ((xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax))
    }

    for point_id, point in enumerate(exact_points):
        if point in corner_points:
            continue
        plane_index = plane_index_by_z[exact_points[point_id][2]]
        cells = _insert_cap_node(
            cells, exact_points, point_id, plane_index, plane_values
        )

    cells = _improve_cap_edges(cells, exact_points, plane_values)
    _validate_tetrahedralization(cells, exact_points, plane_values, bounds)

    ordered_cells = sorted(cells, key=lambda cell: tuple(sorted(cell)))
    output = np.asarray(
        [[original_indices[vertex] for vertex in cell] for cell in ordered_cells],
        dtype=np.int32,
    )
    return output.reshape((-1, 4))
