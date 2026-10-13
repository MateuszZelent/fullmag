from __future__ import annotations

import itertools
import math
import unittest

import numpy as np

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