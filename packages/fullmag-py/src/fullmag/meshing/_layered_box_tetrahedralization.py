"""Exact-predicate prototype for conforming layered rectangular-box tets.

This internal kernel starts from a globally conforming Freudenthal seed and
inserts the supplied cap nodes by stellar face or edge subdivision. It keeps
the original float64 nodes unchanged and returns Tet4 connectivity in their
input order. It does not route production meshes, establish element quality,
or certify periodic boundary conditions.

Predicates use Fraction.from_float so they are exact for the represented
binary64 inputs. An exact isotropic centering and scaling transform reduces
coordinate magnitude without changing any predicate. Each insertion rescans
the current topology; together with
arbitrary-precision rational arithmetic this is a correctness prototype, not a
large-mesh algorithm (quadratic in node count when the cell count grows
linearly, and potentially worse for high-valence edge splits).
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


def _positive_cell(cell: _Cell, points: Sequence[_Point3]) -> _Cell:
    determinant = _orient3d(points, cell)
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

    _validate_tetrahedralization(cells, exact_points, plane_values, bounds)

    ordered_cells = sorted(cells, key=lambda cell: tuple(sorted(cell)))
    output = np.asarray(
        [[original_indices[vertex] for vertex in cell] for cell in ordered_cells],
        dtype=np.int32,
    )
    return output.reshape((-1, 4))