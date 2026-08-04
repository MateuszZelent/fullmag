"""Exact one-layer ``prism6`` FEM restriction onto a Cartesian grid."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping

import numpy as np

from fullmag.analysis.magnetization_comparison import (
    CartesianGrid,
    MagnetizationComparisonError,
    StructuredMagnetization,
)


_ALIGNMENT_TOL = 2.0e-12
_CLIP_TOL = 0.0


def _polygon_area(polygon: np.ndarray) -> float:
    if polygon.shape[0] < 3:
        return 0.0
    return float(
        0.5
        * abs(
            np.dot(polygon[:, 0], np.roll(polygon[:, 1], -1))
            - np.dot(polygon[:, 1], np.roll(polygon[:, 0], -1))
        )
    )


def _polygon_centroid(polygon: np.ndarray, area: float) -> np.ndarray:
    """Return the area centroid of a non-degenerate clipped polygon."""

    if polygon.shape[0] < 3 or area <= np.finfo(np.float64).tiny:
        raise MagnetizationComparisonError("clipped polygon is degenerate")
    next_points = np.roll(polygon, -1, axis=0)
    cross = (
        polygon[:, 0] * next_points[:, 1]
        - next_points[:, 0] * polygon[:, 1]
    )
    signed_area_twice = float(np.sum(cross))
    if abs(signed_area_twice) <= np.finfo(np.float64).tiny:
        raise MagnetizationComparisonError("clipped polygon has zero signed area")
    centroid = np.sum(
        (polygon + next_points) * cross[:, np.newaxis],
        axis=0,
    ) / (3.0 * signed_area_twice)
    if not np.all(np.isfinite(centroid)):
        raise MagnetizationComparisonError("clipped polygon centroid is non-finite")
    return centroid


def _clip_polygon(
    polygon: np.ndarray,
    *,
    axis: int,
    bound: float,
    keep_greater: bool,
) -> np.ndarray:
    if polygon.shape[0] == 0:
        return polygon
    output: list[np.ndarray] = []

    def inside(point: np.ndarray) -> bool:
        return bool(point[axis] >= bound - _CLIP_TOL if keep_greater else point[axis] <= bound + _CLIP_TOL)

    def intersection(start: np.ndarray, end: np.ndarray) -> np.ndarray:
        delta = end[axis] - start[axis]
        if abs(delta) <= np.finfo(np.float64).eps:
            return start.copy()
        fraction = (bound - start[axis]) / delta
        return start + fraction * (end - start)

    previous = polygon[-1]
    previous_inside = inside(previous)
    for current in polygon:
        current_inside = inside(current)
        if current_inside != previous_inside:
            output.append(intersection(previous, current))
        if current_inside:
            output.append(current.copy())
        previous = current
        previous_inside = current_inside
    if not output:
        return np.zeros((0, 2), dtype=np.float64)
    return np.asarray(output, dtype=np.float64)


def _clip_triangle_to_rectangle(
    triangle_xy: np.ndarray,
    *,
    x_min: float,
    x_max: float,
    y_min: float,
    y_max: float,
) -> np.ndarray:
    polygon = np.asarray(triangle_xy, dtype=np.float64)
    for axis, bound, keep_greater in (
        (0, x_min, True),
        (0, x_max, False),
        (1, y_min, True),
        (1, y_max, False),
    ):
        polygon = _clip_polygon(
            polygon,
            axis=axis,
            bound=bound,
            keep_greater=keep_greater,
        )
        if polygon.shape[0] > 1:
            unique: list[np.ndarray] = [polygon[0]]
            for point in polygon[1:]:
                if not np.allclose(point, unique[-1], rtol=0.0, atol=_CLIP_TOL):
                    unique.append(point)
            if len(unique) > 1 and np.allclose(
                unique[0], unique[-1], rtol=0.0, atol=_CLIP_TOL
            ):
                unique.pop()
            polygon = np.asarray(unique, dtype=np.float64)
    return polygon


def _barycentric_coordinates(points: np.ndarray, triangle: np.ndarray) -> np.ndarray:
    origin = triangle[0]
    edge_a = triangle[1] - origin
    edge_b = triangle[2] - origin
    denominator = edge_a[0] * edge_b[1] - edge_a[1] * edge_b[0]
    scale = max(
        float(np.linalg.norm(edge_a)),
        float(np.linalg.norm(edge_b)),
        float(np.linalg.norm(edge_a - edge_b)),
        np.finfo(np.float64).tiny,
    )
    if abs(denominator) <= np.finfo(np.float64).eps * scale * scale:
        raise MagnetizationComparisonError("magnetic prism has a degenerate base triangle")
    relative = points - origin
    lambda_1 = (relative[:, 0] * edge_b[1] - relative[:, 1] * edge_b[0]) / denominator
    lambda_2 = (edge_a[0] * relative[:, 1] - edge_a[1] * relative[:, 0]) / denominator
    lambda_0 = 1.0 - lambda_1 - lambda_2
    return np.column_stack((lambda_0, lambda_1, lambda_2))


@dataclass(frozen=True, slots=True)
class CartesianRestriction:
    """Sparse FEM-node weights for every Cartesian voxel."""

    grid: CartesianGrid
    voxel_offsets: np.ndarray
    node_indices: np.ndarray
    node_weights: np.ndarray
    coverage: np.ndarray
    magnetic_volume: float
    magnetic_cell_count: int
    fem_node_volume_weights: np.ndarray
    mesh_topology_fingerprint: str | None = None
    metadata: Mapping[str, object] = field(default_factory=dict)

    def __post_init__(self) -> None:
        offsets = np.asarray(self.voxel_offsets, dtype=np.int64).reshape(-1)
        indices = np.asarray(self.node_indices, dtype=np.int64).reshape(-1)
        weights = np.asarray(self.node_weights, dtype=np.float64).reshape(-1)
        coverage = np.asarray(self.coverage, dtype=np.float64)
        fem_node_volume_weights = np.asarray(self.fem_node_volume_weights, dtype=np.float64).reshape(-1)
        if offsets.shape != (self.grid.voxel_count + 1,):
            raise ValueError("voxel_offsets must have one entry per voxel plus a sentinel")
        if indices.shape != weights.shape or offsets[-1] != indices.size:
            raise ValueError("restriction CSR arrays have inconsistent lengths")
        if coverage.shape != self.grid.shape_zyx:
            raise ValueError("coverage shape does not match the Cartesian grid")
        if np.any(fem_node_volume_weights < 0.0) or not np.all(np.isfinite(fem_node_volume_weights)):
            raise ValueError("FEM node volume weights must be finite and non-negative")
        if np.any(coverage < -1.0e-10) or np.any(coverage > 1.0 + 1.0e-10):
            raise ValueError("Cartesian magnetic coverage must be in [0,1]")
        object.__setattr__(self, "voxel_offsets", offsets)
        object.__setattr__(self, "node_indices", indices)
        object.__setattr__(self, "node_weights", weights)
        object.__setattr__(self, "coverage", coverage)
        object.__setattr__(self, "fem_node_volume_weights", fem_node_volume_weights)
        object.__setattr__(self, "metadata", dict(self.metadata or {}))

    @property
    def valid_mask(self) -> np.ndarray:
        return self.coverage > 1.0e-14

    def to_dict(self) -> dict[str, object]:
        return {
            "grid": self.grid.to_dict(),
            "magnetic_volume_m3": float(self.magnetic_volume),
            "magnetic_cell_count": self.magnetic_cell_count,
            "fem_node_count": int(self.fem_node_volume_weights.size),
            "valid_voxel_count": int(np.count_nonzero(self.valid_mask)),
            "coverage_min": float(np.min(self.coverage)),
            "coverage_max": float(np.max(self.coverage)),
            "coverage_mean": float(np.mean(self.coverage)),
            "mesh_topology_fingerprint": self.mesh_topology_fingerprint,
            "metadata": dict(self.metadata),
        }

    def apply(self, nodal_values: np.ndarray) -> np.ndarray:
        values = np.asanyarray(nodal_values, dtype=np.float64)
        if values.ndim != 2 or values.shape[1] != 3:
            raise MagnetizationComparisonError("FEM magnetization must have shape (node, component)")
        if self.node_indices.size and int(np.max(self.node_indices)) >= values.shape[0]:
            raise MagnetizationComparisonError("FEM magnetization has fewer nodes than the mesh")
        result = np.zeros((self.grid.voxel_count, 3), dtype=np.float64)
        for voxel in range(self.grid.voxel_count):
            start = int(self.voxel_offsets[voxel])
            end = int(self.voxel_offsets[voxel + 1])
            if end == start:
                continue
            result[voxel] = np.sum(
                self.node_weights[start:end, np.newaxis]
                * values[self.node_indices[start:end]],
                axis=0,
            )
            coverage = float(self.coverage.reshape(-1)[voxel])
            if coverage > 1.0e-14:
                result[voxel] /= coverage
        return result.reshape((*self.grid.shape_zyx, 3))

    def conservation(self, nodal_values: np.ndarray) -> dict[str, object]:
        projected = self.apply(nodal_values).reshape((-1, 3))
        coverage = self.coverage.reshape(-1)
        restricted_integral = np.sum(projected * coverage[:, np.newaxis], axis=0) * self.grid.voxel_volume
        projected_volume = float(np.sum(coverage) * self.grid.voxel_volume)
        values = np.asanyarray(nodal_values, dtype=np.float64)
        fem_integral = np.sum(
            self.fem_node_volume_weights[:, np.newaxis] * values,
            axis=0,
        )
        return {
            "fem_volume_m3": float(self.magnetic_volume),
            "projected_volume_m3": projected_volume,
            "volume_relative_error": abs(projected_volume - self.magnetic_volume)
            / max(abs(self.magnetic_volume), np.finfo(np.float64).tiny),
            "fem_integral": fem_integral.tolist(),
            "projected_integral": restricted_integral.tolist(),
            "integral_absolute_error": np.abs(fem_integral - restricted_integral).tolist(),
        }


def _cell_box_indices(
    triangle: np.ndarray,
    grid: CartesianGrid,
) -> tuple[range, range]:
    dx, dy, _ = grid.cell_size_xyz
    x0, y0, _ = grid.bounds_min_xyz
    nx, ny = grid.shape_zyx[2], grid.shape_zyx[1]
    min_x = max(0, int(np.floor((float(np.min(triangle[:, 0])) - x0) / dx)) - 1)
    max_x = min(nx - 1, int(np.ceil((float(np.max(triangle[:, 0])) - x0) / dx)) + 1)
    min_y = max(0, int(np.floor((float(np.min(triangle[:, 1])) - y0) / dy)) - 1)
    max_y = min(ny - 1, int(np.ceil((float(np.max(triangle[:, 1])) - y0) / dy)) + 1)
    return range(min_x, max_x + 1), range(min_y, max_y + 1)


def build_prism6_cartesian_restriction(
    mesh: Any,
    grid: CartesianGrid,
    *,
    magnetic_markers: tuple[int, ...] = (1,),
) -> CartesianRestriction:
    """Build exact P1 restriction weights for a single aligned prism layer."""

    if grid.shape_zyx[0] != 1:
        raise MagnetizationComparisonError("the production SP4 restriction requires Nz=1")
    markers = tuple(int(marker) for marker in magnetic_markers)
    if not markers:
        raise ValueError("magnetic_markers must not be empty")
    magnetic_cells = np.flatnonzero(np.isin(mesh.element_markers, markers))
    if magnetic_cells.size == 0:
        raise MagnetizationComparisonError("mesh contains no magnetic cells for the requested markers")
    if any(str(mesh.cell_types[index]) != "prism6" for index in magnetic_cells):
        raise MagnetizationComparisonError(
            "exact FEM-to-Cartesian restriction supports only magnetic prism6 cells"
        )

    dx, dy, dz = grid.cell_size_xyz
    grid_min = np.asarray(grid.bounds_min_xyz, dtype=np.float64)
    grid_max = np.asarray(grid.bounds_max_xyz, dtype=np.float64)
    rows: list[dict[int, float]] = [dict() for _ in range(grid.voxel_count)]
    coverage = np.zeros(grid.shape_zyx, dtype=np.float64)
    magnetic_volume = 0.0
    node_count = int(mesh.n_nodes)
    fem_node_volume_weights = np.zeros(node_count, dtype=np.float64)
    for cell_index in magnetic_cells:
        node_ids = np.asarray(mesh.cell_node_ids(int(cell_index)), dtype=np.int64)
        if node_ids.shape != (6,) or np.any(node_ids < 0) or np.any(node_ids >= node_count):
            raise MagnetizationComparisonError("magnetic prism6 connectivity is invalid")
        coordinates = np.asarray(mesh.nodes[node_ids], dtype=np.float64)
        bottom = coordinates[:3]
        top = coordinates[3:]
        bottom_z = float(np.mean(bottom[:, 2]))
        top_z = float(np.mean(top[:, 2]))
        if top_z < bottom_z:
            raise MagnetizationComparisonError(
                "prism6 node order must list the lower triangle before the upper triangle"
            )
        thickness = top_z - bottom_z
        if thickness <= 0.0 or not np.allclose(bottom[:, 2], bottom_z, rtol=0.0, atol=_ALIGNMENT_TOL):
            raise MagnetizationComparisonError("prism6 magnetic cells must have planar bottom and top faces")
        if not np.allclose(top[:, 2], top_z, rtol=0.0, atol=_ALIGNMENT_TOL):
            raise MagnetizationComparisonError("prism6 magnetic cells must have planar bottom and top faces")
        if not np.allclose(bottom[:, :2], top[:, :2], rtol=0.0, atol=_ALIGNMENT_TOL):
            raise MagnetizationComparisonError("prism6 top and bottom triangles must be aligned")
        if abs(bottom_z - grid_min[2]) > _ALIGNMENT_TOL or abs(top_z - grid_max[2]) > _ALIGNMENT_TOL:
            raise MagnetizationComparisonError(
                "magnetic prism layer must coincide with the Cartesian grid z bounds"
            )
        triangle = bottom[:, :2]
        triangle_area = _polygon_area(triangle)
        if triangle_area <= np.finfo(np.float64).tiny:
            raise MagnetizationComparisonError("magnetic prism6 base triangle is degenerate")
        magnetic_volume += triangle_area * thickness
        fem_node_volume_weights[node_ids] += triangle_area * thickness / 6.0
        x_range, y_range = _cell_box_indices(triangle, grid)
        for iy in y_range:
            y_min = grid_min[1] + iy * dy
            y_max = y_min + dy
            for ix in x_range:
                x_min = grid_min[0] + ix * dx
                x_max = x_min + dx
                clipped = _clip_triangle_to_rectangle(
                    triangle,
                    x_min=x_min,
                    x_max=x_max,
                    y_min=y_min,
                    y_max=y_max,
                )
                area = _polygon_area(clipped)
                if area <= np.finfo(np.float64).tiny:
                    continue
                # A clipped triangle is often a quadrilateral or pentagon.
                # The arithmetic mean of polygon vertices is not its area
                # centroid, so it does not integrate an affine P1 basis
                # exactly.  Evaluate the barycentric basis at the shoelace
                # area centroid instead.
                centroid = _polygon_centroid(clipped, area)
                lambda_integrals = area * _barycentric_coordinates(
                    centroid[np.newaxis, :], triangle
                )[0]
                voxel = iy * grid.shape_zyx[2] + ix
                voxel_volume = dx * dy * dz
                base_factor = thickness / (2.0 * voxel_volume)
                for local_index in range(3):
                    rows[voxel][int(node_ids[local_index])] = rows[voxel].get(
                        int(node_ids[local_index]), 0.0
                    ) + base_factor * float(lambda_integrals[local_index])
                    rows[voxel][int(node_ids[local_index + 3])] = rows[voxel].get(
                        int(node_ids[local_index + 3]), 0.0
                    ) + base_factor * float(lambda_integrals[local_index])
                coverage.reshape(-1)[voxel] += area * thickness / voxel_volume

    if np.any(coverage > 1.0 + 1.0e-9):
        raise MagnetizationComparisonError(
            "magnetic prism cells overlap in the Cartesian restriction grid"
        )
    offsets = [0]
    indices: list[int] = []
    weights: list[float] = []
    for row in rows:
        indices.extend(sorted(row))
        weights.extend(row[node] for node in sorted(row))
        offsets.append(len(indices))
    mesh_fingerprint = None
    fingerprint_method = getattr(mesh, "topology_fingerprint_v3", None)
    if callable(fingerprint_method):
        mesh_fingerprint = str(fingerprint_method())
    return CartesianRestriction(
        grid=grid,
        voxel_offsets=np.asarray(offsets, dtype=np.int64),
        node_indices=np.asarray(indices, dtype=np.int64),
        node_weights=np.asarray(weights, dtype=np.float64),
        coverage=coverage,
        magnetic_volume=magnetic_volume,
        magnetic_cell_count=int(magnetic_cells.size),
        fem_node_volume_weights=fem_node_volume_weights,
        mesh_topology_fingerprint=mesh_fingerprint,
        metadata={
            "method": "exact_prism6_p1_volume_restriction",
            "axis_order": "zyx",
            "component_order": ["x", "y", "z"],
            "magnetic_markers": list(markers),
        },
    )


def restrict_fem_magnetization(
    nodal_values: np.ndarray,
    restriction: CartesianRestriction,
) -> StructuredMagnetization:
    """Apply restriction weights and return one final ``(t,z,y,x,c)`` frame."""

    values = restriction.apply(nodal_values)
    mask = ~restriction.valid_mask
    masked = np.ma.array(
        values[np.newaxis, ...],
        mask=np.broadcast_to(mask[np.newaxis, ..., np.newaxis], (1, *mask.shape, 3)),
    )
    metadata = {
        **restriction.metadata,
        "coverage_min": float(np.min(restriction.coverage)),
        "coverage_max": float(np.max(restriction.coverage)),
        "coverage_mean": float(np.mean(restriction.coverage)),
        "mesh_topology_fingerprint": restriction.mesh_topology_fingerprint,
    }
    return StructuredMagnetization(
        values=masked,
        times=np.asarray([0.0], dtype=np.float64),
        grid=restriction.grid,
        dataset="m",
        metadata=metadata,
    )


def _tet4_barycentric_coordinates(point: np.ndarray, tetrahedron: np.ndarray) -> np.ndarray:
    """Return affine P1 barycentric coordinates for one tetrahedron point."""

    origin = tetrahedron[0]
    matrix = (tetrahedron[1:] - origin).T
    scale = max(float(np.max(np.linalg.norm(matrix, axis=0))), np.finfo(np.float64).tiny)
    determinant = float(np.linalg.det(matrix))
    if abs(determinant) <= np.finfo(np.float64).eps * scale**3:
        raise MagnetizationComparisonError("magnetic tet4 cell is degenerate")
    tail = np.linalg.solve(matrix, point - origin)
    return np.asarray((1.0 - float(np.sum(tail)), *tail), dtype=np.float64)


def sample_fem_tet4_cartesian_centers(
    mesh: Any,
    nodal_values: np.ndarray,
    grid: CartesianGrid,
    *,
    magnetic_markers: tuple[int, ...] = (1,),
    barycentric_tolerance: float = 1.0e-10,
    time_s: float = 0.0,
) -> StructuredMagnetization:
    """Sample a linear ``tet4`` FEM field at Cartesian cell centers.

    This is an explicitly diagnostic comparison operator.  It evaluates the
    exact affine P1 field at each FDM cell center; it does not claim the
    volume-integrated ``prism6`` restriction used by the SP4 qualification
    path.  Cells outside all selected magnetic tetrahedra are masked.  A
    continuous FEM field can be covered by more than one tetrahedron on a
    shared face; their values are averaged to avoid topology-order dependence.
    """

    if not np.isfinite(barycentric_tolerance) or barycentric_tolerance < 0.0:
        raise ValueError("barycentric_tolerance must be finite and non-negative")
    if not np.isfinite(time_s):
        raise ValueError("time_s must be finite")
    markers = tuple(int(marker) for marker in magnetic_markers)
    if not markers:
        raise ValueError("magnetic_markers must not be empty")
    values = np.asanyarray(nodal_values, dtype=np.float64)
    if values.ndim != 2 or values.shape != (int(mesh.n_nodes), 3):
        raise MagnetizationComparisonError(
            "FEM magnetization must have shape (mesh.n_nodes, component)"
        )
    if not np.all(np.isfinite(values)):
        raise MagnetizationComparisonError("FEM magnetization contains non-finite values")

    magnetic_cells = np.flatnonzero(np.isin(mesh.element_markers, markers))
    if magnetic_cells.size == 0:
        raise MagnetizationComparisonError(
            "mesh contains no magnetic cells for the requested markers"
        )
    if any(str(mesh.cell_types[index]) != "tet4" for index in magnetic_cells):
        raise MagnetizationComparisonError(
            "tet4 center sampling supports only magnetic tet4 cells"
        )

    nx, ny, nz = grid.shape_zyx[2], grid.shape_zyx[1], grid.shape_zyx[0]
    dx, dy, dz = grid.cell_size_xyz
    x_centers = grid.bounds_min_xyz[0] + (np.arange(nx, dtype=np.float64) + 0.5) * dx
    y_centers = grid.bounds_min_xyz[1] + (np.arange(ny, dtype=np.float64) + 0.5) * dy
    z_centers = grid.bounds_min_xyz[2] + (np.arange(nz, dtype=np.float64) + 0.5) * dz
    sampled = np.zeros((grid.voxel_count, 3), dtype=np.float64)
    sample_count = np.zeros(grid.voxel_count, dtype=np.int32)

    for cell_index in magnetic_cells:
        node_ids = np.asarray(mesh.cell_node_ids(int(cell_index)), dtype=np.int64)
        if node_ids.shape != (4,) or np.any(node_ids < 0) or np.any(node_ids >= mesh.n_nodes):
            raise MagnetizationComparisonError("magnetic tet4 connectivity is invalid")
        tetrahedron = np.asarray(mesh.nodes[node_ids], dtype=np.float64)
        minimum = np.maximum(
            np.min(tetrahedron, axis=0),
            np.asarray(grid.bounds_min_xyz, dtype=np.float64),
        )
        maximum = np.minimum(
            np.max(tetrahedron, axis=0),
            np.asarray(grid.bounds_max_xyz, dtype=np.float64),
        )
        if np.any(maximum < minimum):
            continue
        x_indices = np.flatnonzero((x_centers >= minimum[0]) & (x_centers <= maximum[0]))
        y_indices = np.flatnonzero((y_centers >= minimum[1]) & (y_centers <= maximum[1]))
        z_indices = np.flatnonzero((z_centers >= minimum[2]) & (z_centers <= maximum[2]))
        for iz in z_indices:
            for iy in y_indices:
                for ix in x_indices:
                    point = np.asarray((x_centers[ix], y_centers[iy], z_centers[iz]))
                    barycentric = _tet4_barycentric_coordinates(point, tetrahedron)
                    if np.any(barycentric < -barycentric_tolerance) or np.any(
                        barycentric > 1.0 + barycentric_tolerance
                    ):
                        continue
                    voxel = (int(iz) * ny + int(iy)) * nx + int(ix)
                    sampled[voxel] += barycentric @ values[node_ids]
                    sample_count[voxel] += 1

    valid = sample_count > 0
    if not np.any(valid):
        raise MagnetizationComparisonError(
            "no Cartesian cell centers fall inside the selected magnetic tet4 cells"
        )
    sampled[valid] /= sample_count[valid, np.newaxis]
    shaped = sampled.reshape((*grid.shape_zyx, 3))
    mask = np.broadcast_to(
        (~valid).reshape((*grid.shape_zyx, 1)),
        (*grid.shape_zyx, 3),
    )
    return StructuredMagnetization(
        values=np.ma.array(shaped[np.newaxis, ...], mask=mask[np.newaxis, ...]),
        times=np.asarray([time_s], dtype=np.float64),
        grid=grid,
        dataset="m",
        metadata={
            "method": "tet4_cartesian_center_barycentric_v1",
            "axis_order": "zyx",
            "component_order": ["x", "y", "z"],
            "magnetic_markers": list(markers),
            "barycentric_tolerance": float(barycentric_tolerance),
            "sample_count_min": int(np.min(sample_count[valid])),
            "sample_count_max": int(np.max(sample_count[valid])),
            "valid_voxel_count": int(np.count_nonzero(valid)),
            "valid_fraction": float(np.mean(valid)),
        },
    )
