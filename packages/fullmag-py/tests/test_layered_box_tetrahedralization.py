from __future__ import annotations

from fractions import Fraction
import itertools
import math
import unittest
from unittest.mock import patch

import numpy as np

from fullmag.meshing import _layered_box_tetrahedralization as _kernel
from fullmag.meshing._layered_box_tetrahedralization import (
    tetrahedralize_layered_box,
)


_SCALE = 2.0**-30
_PLANES = np.asarray([-_SCALE, 0.0, _SCALE], dtype=np.float64)
_BOUNDS = (-2.0 * _SCALE, 2.0 * _SCALE, -2.0 * _SCALE, 2.0 * _SCALE)
_CORNERS = [
    (-2.0 * _SCALE, -2.0 * _SCALE),
    (2.0 * _SCALE, -2.0 * _SCALE),
    (2.0 * _SCALE, 2.0 * _SCALE),
    (-2.0 * _SCALE, 2.0 * _SCALE),
]


def _layered_input(
    planes: np.ndarray, fine_plane_indices: tuple[int, ...]
) -> tuple[np.ndarray, np.ndarray, tuple[float, ...]]:
    fine_points = [
        *_CORNERS,
        (-0.5 * _SCALE, -0.25 * _SCALE),
        (0.5 * _SCALE, -0.25 * _SCALE),
        (0.25 * _SCALE, 0.5 * _SCALE),
    ]
    by_plane = [
        fine_points if index in fine_plane_indices else _CORNERS
        for index in range(len(planes))
    ]
    nodes = np.asarray(
        [
            (x, y, float(z))
            for z, xy in zip(planes, by_plane, strict=True)
            for x, y in xy
        ],
        dtype=np.float64,
    )
    return nodes, planes.copy(), _BOUNDS


def _coarse_fine_coarse_input() -> tuple[np.ndarray, np.ndarray, tuple[float, ...]]:
    return _layered_input(_PLANES, (1,))


def _face_incidence(
    nodes: np.ndarray, cells: np.ndarray, planes: np.ndarray
) -> tuple[dict[tuple[int, int, int], int], dict[tuple[int, int, int], list[int]]]:
    plane_indices = {float(z): index for index, z in enumerate(planes)}
    counts: dict[tuple[int, int, int], int] = {}
    slabs: dict[tuple[int, int, int], list[int]] = {}
    for cell in cells:
        z_indices = [plane_indices[float(nodes[int(index), 2])] for index in cell]
        slab = min(z_indices)
        for omitted in range(4):
            face = tuple(sorted(int(index) for i, index in enumerate(cell) if i != omitted))
            counts[face] = counts.get(face, 0) + 1
            slabs.setdefault(face, []).append(slab)
    return counts, slabs


def _geometry_connectivity(
    nodes: np.ndarray, cells: np.ndarray, shift: np.ndarray
) -> list[tuple[tuple[int, int, int], ...]]:
    integer_coordinates = np.rint(
        (nodes - shift[None, :]) / (_SCALE / 4.0)
    ).astype(np.int64)
    return sorted(
        tuple(sorted(tuple(int(value) for value in integer_coordinates[index]) for index in cell))
        for cell in cells
    )


def _near_collinear_periodic_input() -> tuple[np.ndarray, np.ndarray, tuple[float, ...]]:
    nodes, planes, bounds = _layered_input(_PLANES, ())
    extras = np.asarray(
        [
            (-0.5 * _SCALE, -2.0 * _SCALE + 2.0**-24 * _SCALE, 0.0),
            (-2.0 * _SCALE, 0.0, 0.0),
            (2.0 * _SCALE, 0.0, 0.0),
            (0.0, -2.0 * _SCALE, 0.0),
            (0.0, 2.0 * _SCALE, 0.0),
        ],
        dtype=np.float64,
    )
    return np.vstack((nodes, extras)), planes, bounds


def _pre_flip_cells(
    nodes: np.ndarray, planes: np.ndarray, bounds: tuple[float, ...]
) -> np.ndarray:
    points, _, original_indices, plane_values, normalized_bounds = (
        _kernel._validate_and_prepare(nodes, np.asarray(planes), bounds)
    )
    cells = _kernel._seed_freudenthal(points, plane_values, normalized_bounds)
    plane_index_by_z = {z: index for index, z in enumerate(plane_values)}
    xmin, xmax, ymin, ymax = normalized_bounds
    corner_points = {
        (x, y, z)
        for z in plane_values
        for x, y in ((xmin, ymin), (xmax, ymin), (xmax, ymax), (xmin, ymax))
    }
    for point_id, point in enumerate(points):
        if point not in corner_points:
            cells = _kernel._insert_cap_node(
                cells,
                points,
                point_id,
                plane_index_by_z[point[2]],
                plane_values,
            )
    return np.asarray(
        [[original_indices[index] for index in cell] for cell in cells],
        dtype=np.int32,
    )


def _exact_quality_vector(nodes: np.ndarray, cells: np.ndarray) -> tuple[Fraction, ...]:
    exact_nodes = [
        tuple(Fraction.from_float(float(value)) for value in row) for row in nodes
    ]

    def determinant(a, b, c):
        return (
            a[0] * (b[1] * c[2] - b[2] * c[1])
            - a[1] * (b[0] * c[2] - b[2] * c[0])
            + a[2] * (b[0] * c[1] - b[1] * c[0])
        )

    values = []
    for cell in cells:
        a, b, c, d = (exact_nodes[int(index)] for index in cell)
        vectors = [
            tuple(right[axis] - left[axis] for axis in range(3))
            for left, right in ((a, b), (a, c), (a, d))
        ]
        det = determinant(*vectors)
        edge_lengths_squared = [
            sum((left[axis] - right[axis]) ** 2 for axis in range(3))
            for left, right in itertools.combinations((a, b, c, d), 2)
        ]
        max_edge_squared = max(edge_lengths_squared)
        values.append(det**2 / max_edge_squared**3)
    return tuple(sorted(values))


def _cap_triangle_geometry(
    nodes: np.ndarray, cells: np.ndarray, z_value: float
) -> set[tuple[tuple[float, float], ...]]:
    counts, _ = _face_incidence(nodes, cells, _PLANES)
    return {
        tuple(sorted(tuple(float(value) for value in nodes[index, :2]) for index in face))
        for face in counts
        if np.all(nodes[np.asarray(face, dtype=np.int64), 2] == z_value)
    }


def _assert_periodic_side_facets(
    test: unittest.TestCase,
    nodes: np.ndarray,
    cells: np.ndarray,
    bounds: tuple[float, ...],
) -> None:
    counts, _ = _face_incidence(nodes, cells, _PLANES)
    for axis, sides in ((0, (bounds[0], bounds[1])), (1, (bounds[2], bounds[3]))):
        other_axes = [dimension for dimension in range(3) if dimension != axis]
        paired_facets = []
        for coordinate in sides:
            facets = {
                tuple(
                    sorted(
                        tuple(float(nodes[index, dimension]) for dimension in other_axes)
                        for index in face
                    )
                )
                for face, incidence in counts.items()
                if incidence == 1
                and all(nodes[index, axis] == coordinate for index in face)
            }
            test.assertTrue(facets)
            paired_facets.append(facets)
        test.assertEqual(paired_facets[0], paired_facets[1])


class LayeredBoxTetrahedralizationTests(unittest.TestCase):
    def _assert_mesh_contract(
        self,
        nodes: np.ndarray,
        planes: np.ndarray,
        bounds: tuple[float, ...],
        cells: np.ndarray,
    ) -> None:
        self.assertEqual(cells.ndim, 2)
        self.assertEqual(cells.shape[1], 4)
        self.assertTrue(np.issubdtype(cells.dtype, np.integer))
        self.assertEqual(set(np.unique(cells).tolist()), set(range(len(nodes))))

        signed_determinants = np.asarray(
            [np.linalg.det(nodes[cell][1:] - nodes[cell][0]) for cell in cells],
            dtype=np.float64,
        )
        self.assertTrue(np.all(np.isfinite(signed_determinants)))
        self.assertTrue(np.all(signed_determinants > 0.0))

        plane_lookup = {float(z): index for index, z in enumerate(planes)}
        slab_volumes: list[list[float]] = [[] for _ in range(len(planes) - 1)]
        for cell, determinant in zip(cells, signed_determinants, strict=True):
            z = nodes[cell, 2]
            self.assertTrue(np.all(np.isin(z, planes)))
            plane_indices = [plane_lookup[float(value)] for value in z]
            self.assertEqual(max(plane_indices) - min(plane_indices), 1)
            slab_volumes[min(plane_indices)].append(float(determinant) / 6.0)

        xmin, xmax, ymin, ymax = bounds
        for index, volumes in enumerate(slab_volumes):
            expected = (xmax - xmin) * (ymax - ymin) * (
                planes[index + 1] - planes[index]
            )
            self.assertTrue(volumes)
            self.assertTrue(
                math.isclose(
                    math.fsum(volumes), float(expected), rel_tol=1e-12, abs_tol=0.0
                )
            )

        face_counts, face_slabs = _face_incidence(nodes, cells, planes)
        self.assertTrue(face_counts)
        for face, incidence in face_counts.items():
            self.assertIn(incidence, (1, 2))
            face_nodes = nodes[np.asarray(face, dtype=np.int64)]
            on_box_boundary = (
                np.all(face_nodes[:, 0] == xmin)
                or np.all(face_nodes[:, 0] == xmax)
                or np.all(face_nodes[:, 1] == ymin)
                or np.all(face_nodes[:, 1] == ymax)
                or np.all(face_nodes[:, 2] == planes[0])
                or np.all(face_nodes[:, 2] == planes[-1])
            )
            if incidence == 1:
                self.assertTrue(
                    on_box_boundary, msg=f"exterior face is not on the box: {face}"
                )
            if on_box_boundary:
                self.assertEqual(
                    incidence, 1, msg=f"box-boundary face has wrong incidence: {face}"
                )

        for plane_index, z_value in enumerate(planes):
            cap_faces = [
                face
                for face in face_counts
                if np.all(nodes[np.asarray(face, dtype=np.int64), 2] == z_value)
            ]
            self.assertTrue(cap_faces, msg=f"missing triangulated cap at z={z_value}")
            expected_area = (xmax - xmin) * (ymax - ymin)
            cap_area = 0.0
            for face in cap_faces:
                face_xy = nodes[np.asarray(face, dtype=np.int64), :2]
                area = abs(
                    float(
                        (face_xy[1, 0] - face_xy[0, 0])
                        * (face_xy[2, 1] - face_xy[0, 1])
                        - (face_xy[1, 1] - face_xy[0, 1])
                        * (face_xy[2, 0] - face_xy[0, 0])
                    )
                ) / 2.0
                cap_area += area
                if 0 < plane_index < len(planes) - 1:
                    self.assertEqual(face_counts[face], 2)
                    self.assertEqual(
                        sorted(face_slabs[face]),
                        [plane_index - 1, plane_index],
                    )
                else:
                    self.assertEqual(face_counts[face], 1)
            self.assertTrue(
                math.isclose(cap_area, expected_area, rel_tol=1e-12, abs_tol=0.0)
            )

    def test_coarse_fine_coarse_layers_keep_roi_and_shared_caps(self) -> None:
        nodes, planes, bounds = _coarse_fine_coarse_input()
        cells = tetrahedralize_layered_box(nodes, planes, bounds)
        self._assert_mesh_contract(nodes, planes, bounds, cells)

        centroids = nodes[cells].mean(axis=1)
        roi = (
            (np.hypot(centroids[:, 0], centroids[:, 1]) <= _SCALE)
            & (np.abs(centroids[:, 2]) <= 0.5 * _SCALE)
        )
        self.assertGreater(int(np.count_nonzero(roi)), 0)

    def test_four_planes_validate_each_shared_cap(self) -> None:
        planes = np.asarray([-3.0 * _SCALE, -_SCALE, 0.0, _SCALE])
        nodes, planes, bounds = _layered_input(planes, (1, 2))
        cells = tetrahedralize_layered_box(nodes, planes, bounds)
        self._assert_mesh_contract(nodes, planes, bounds, cells)

    def test_edge_and_box_boundary_insertions_remain_conforming(self) -> None:
        nodes, planes, bounds = _coarse_fine_coarse_input()
        extras = np.asarray(
            [
                (0.0, -2.0 * _SCALE, 0.0),  # interior point on a cap boundary edge
                (0.0, 0.0, 0.0),  # point on the seed cap diagonal
            ],
            dtype=np.float64,
        )
        nodes = np.vstack((nodes, extras))
        cells = tetrahedralize_layered_box(nodes, planes, bounds)
        self._assert_mesh_contract(nodes, planes, bounds, cells)
        self.assertIn(len(nodes) - 2, cells)
        self.assertIn(len(nodes) - 1, cells)

    def test_paired_boundary_insertions_keep_translated_periodic_facets(self) -> None:
        # Pair existing boundary nodes; do not infer conformity from node counts.
        # Each cap has different density and each periodic face is checked as
        # a complete set of geometric triangles after the prescribed translation.
        for axis in (0, 1):
            with self.subTest(axis=axis):
                nodes, planes, bounds = _coarse_fine_coarse_input()
                extras = []
                for level, z in enumerate(planes):
                    for offset in (-1.0, 0.0, 1.0)[:level + 1]:
                        for side in (-2.0, 2.0):
                            xy = [offset * _SCALE, offset * _SCALE]
                            xy[axis] = side * _SCALE
                            extras.append((*xy, float(z)))
                nodes = np.vstack((nodes, np.asarray(extras)))
                cells = tetrahedralize_layered_box(nodes, planes, bounds)
                self._assert_mesh_contract(nodes, planes, bounds, cells)
                counts, _ = _face_incidence(nodes, cells, planes)
                sides = []
                other_axes = [dimension for dimension in range(3) if dimension != axis]
                for coordinate in (-2.0 * _SCALE, 2.0 * _SCALE):
                    triangles = {
                        tuple(sorted(
                            tuple(float(nodes[index, dimension]) for dimension in other_axes)
                            for index in face
                        ))
                        for face, count in counts.items()
                        if count == 1 and all(nodes[index, axis] == coordinate for index in face)
                    }
                    self.assertTrue(triangles)
                    sides.append(triangles)
                self.assertEqual(sides[0], sides[1])

    def test_reordering_and_exact_binary_translation_preserve_mesh_contract(self) -> None:
        nodes, planes, bounds = _coarse_fine_coarse_input()
        original = tetrahedralize_layered_box(nodes, planes, bounds)
        self._assert_mesh_contract(nodes, planes, bounds, original)
        zero = np.zeros(3, dtype=np.float64)
        expected = _geometry_connectivity(nodes, original, zero)

        permutation = np.random.default_rng(41).permutation(len(nodes))
        permuted_nodes = nodes[permutation]
        permuted = tetrahedralize_layered_box(permuted_nodes, planes, bounds)
        self._assert_mesh_contract(permuted_nodes, planes, bounds, permuted)
        self.assertEqual(_geometry_connectivity(permuted_nodes, permuted, zero), expected)

        shift = np.asarray((8.0 * _SCALE, -4.0 * _SCALE, 16.0 * _SCALE))
        translated_nodes = nodes + shift[None, :]
        translated_planes = planes + shift[2]
        translated_bounds = (
            bounds[0] + shift[0],
            bounds[1] + shift[0],
            bounds[2] + shift[1],
            bounds[3] + shift[1],
        )
        translated = tetrahedralize_layered_box(
            translated_nodes, translated_planes, translated_bounds
        )
        self._assert_mesh_contract(
            translated_nodes, translated_planes, translated_bounds, translated
        )
        self.assertEqual(
            _geometry_connectivity(translated_nodes, translated, shift), expected
        )

    def test_decimal_si_coordinates_preserve_nodes_and_cover_slabs(self) -> None:
        planes = np.asarray([-10e-9, 0.0, 10e-9])
        bounds = (-20e-9, 20e-9, -20e-9, 20e-9)
        corners = [(bounds[0], bounds[2]), (bounds[1], bounds[2]),
                   (bounds[1], bounds[3]), (bounds[0], bounds[3])]
        interior = [(-12e-9, -4e-9), (4e-9, -10e-9),
                    (10e-9, 6e-9), (-6e-9, 12e-9), (2e-9, 2e-9)]
        nodes = np.asarray([(x, y, z) for z in planes for x, y in corners]
                           + [(x, y, 0.0) for x, y in interior])
        original = nodes.copy()
        cells = tetrahedralize_layered_box(nodes, planes, bounds)
        np.testing.assert_array_equal(nodes, original)
        self._assert_mesh_contract(nodes, planes, bounds, cells)

    def test_near_collinear_cap_flip_improves_quality_and_preserves_periodicity(self) -> None:
        nodes, planes, bounds = _near_collinear_periodic_input()
        original_nodes = nodes.copy()
        before_flip = _pre_flip_cells(nodes, planes, bounds)

        cells = tetrahedralize_layered_box(nodes, planes, bounds)

        self.assertGreater(
            _exact_quality_vector(nodes, cells),
            _exact_quality_vector(nodes, before_flip),
        )
        np.testing.assert_array_equal(nodes, original_nodes)
        self._assert_mesh_contract(nodes, planes, bounds, cells)
        _assert_periodic_side_facets(self, nodes, cells, bounds)

    def test_internal_cap_flip_is_shared_by_both_adjacent_slabs(self) -> None:
        nodes, planes, bounds = _near_collinear_periodic_input()
        before_flip = _pre_flip_cells(nodes, planes, bounds)
        cells = tetrahedralize_layered_box(nodes, planes, bounds)

        self.assertNotEqual(
            _cap_triangle_geometry(nodes, before_flip, float(planes[1])),
            _cap_triangle_geometry(nodes, cells, float(planes[1])),
        )
        counts, slabs = _face_incidence(nodes, cells, planes)
        internal_faces = [
            face
            for face in counts
            if np.all(nodes[np.asarray(face, dtype=np.int64), 2] == planes[1])
        ]
        self.assertTrue(internal_faces)
        for face in internal_faces:
            self.assertEqual(counts[face], 2)
            self.assertEqual(sorted(slabs[face]), [0, 1])

    def test_cached_orientation_keeps_ordered_sign_and_zero(self) -> None:
        points = [
            tuple(Fraction(value) for value in row)
            for row in ((0, 0, 0), (1, 0, 0), (0, 1, 0), (0, 0, 1))
        ]
        positive = (0, 1, 2, 3)
        negative = (1, 0, 2, 3)
        degenerate = (0, 1, 2, 2)
        cache = {}
        with patch.object(_kernel, "_orient3d", wraps=_kernel._orient3d) as orient:
            for _ in range(2):
                self.assertEqual(_kernel._cached_orient3d(points, positive, cache), 1)
                self.assertEqual(_kernel._cached_orient3d(points, negative, cache), -1)
                self.assertEqual(_kernel._cached_orient3d(points, degenerate, cache), 0)
            self.assertEqual(orient.call_count, 3)
            self.assertEqual(_kernel._positive_cell(negative, points, cache), positive)
            self.assertEqual(orient.call_count, 3)

    def test_cap_flip_skips_partial_shared_cavity_with_different_lower_apices(self) -> None:
        points = [
            (Fraction(0), Fraction(0), Fraction(0)),
            (Fraction(2), Fraction(0), Fraction(0)),
            (Fraction(1, 4), Fraction(1, 8), Fraction(0)),
            (Fraction(7, 4), Fraction(-1), Fraction(0)),
            (Fraction(0), Fraction(0), Fraction(-1)),
            (Fraction(2), Fraction(0), Fraction(-1)),
            (Fraction(0), Fraction(0), Fraction(1)),
        ]
        upper_cells = [
            _kernel._positive_cell((0, 1, 2, 6), points),
            _kernel._positive_cell((0, 1, 3, 6), points),
        ]
        cells = [
            _kernel._positive_cell((0, 1, 2, 4), points),
            _kernel._positive_cell((0, 1, 3, 5), points),
            *upper_cells,
        ]

        upper_only_flip = _kernel._improve_cap_edges(
            upper_cells, points, (Fraction(0), Fraction(1))
        )
        self.assertNotEqual(upper_only_flip, upper_cells)

        improved = _kernel._improve_cap_edges(
            cells, points, (Fraction(-1), Fraction(0), Fraction(1))
        )

        self.assertEqual(improved, cells)

    def test_invalid_geometry_fails_closed(self) -> None:
        nodes, planes, bounds = _coarse_fine_coarse_input()

        cases = [(nodes.astype(complex) + 1j, planes, bounds, "real"),
                 (nodes, planes.astype(complex) + 1j, bounds, "real"),
                 (nodes, planes, np.asarray(bounds, dtype=complex) + 1j, "real")]
        nonfinite = nodes.copy()
        nonfinite[4, 0] = np.nan
        cases.append((nonfinite, planes, bounds, "finite"))

        nonfinite_plane = planes.copy()
        nonfinite_plane[1] = np.inf
        cases.append((nodes, nonfinite_plane, bounds, "finite"))

        duplicate_plane = np.asarray([planes[0], planes[0], planes[2]])
        cases.append((nodes, duplicate_plane, bounds, "strictly increasing"))

        off_plane = nodes.copy()
        off_plane[4, 2] = np.nextafter(0.0, 1.0)
        cases.append((off_plane, planes, bounds, "requested z plane"))

        outside = nodes.copy()
        outside[4, 0] = np.nextafter(bounds[1], np.inf)
        cases.append((outside, planes, bounds, "outside"))

        duplicate_node = np.vstack((nodes, nodes[4]))
        cases.append((duplicate_node, planes, bounds, "duplicate"))

        missing_corner = np.delete(nodes, 0, axis=0)
        cases.append((missing_corner, planes, bounds, "corner"))

        reversed_bounds = (bounds[1], bounds[0], bounds[2], bounds[3])
        cases.append((nodes, planes, reversed_bounds, "positive"))

        for invalid_nodes, invalid_planes, invalid_bounds, expected_message in cases:
            with self.subTest(expected_message=expected_message):
                with self.assertRaisesRegex(ValueError, expected_message):
                    tetrahedralize_layered_box(
                        invalid_nodes, invalid_planes, invalid_bounds
                    )


if __name__ == "__main__":
    unittest.main()
