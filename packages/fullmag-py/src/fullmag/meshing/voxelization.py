from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag.model.geometry import (
    Box,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    Geometry,
    ImportedGeometry,
    Intersection,
    Translate,
    Union,
)


def _normalize_import_scale(
    scale: float | tuple[float, float, float],
) -> NDArray[np.float64]:
    if isinstance(scale, (int, float)):
        value = float(scale)
        return np.asarray([value, value, value], dtype=np.float64)
    scale_xyz = np.asarray(scale, dtype=np.float64)
    if scale_xyz.shape != (3,):
        raise ValueError("imported geometry scale must be a scalar or a 3-tuple")
    return scale_xyz


def _import_trimesh() -> Any:
    try:
        import trimesh  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "trimesh is required for STL voxelization helpers. "
            "Install with: python -m pip install 'trimesh>=4.2'"
        ) from exc
    return trimesh


def _import_trimesh_voxelization_stack() -> Any:
    trimesh = _import_trimesh()
    try:
        import scipy.sparse  # type: ignore  # noqa: F401
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "scipy is required for STL voxelization through trimesh. "
            "Install with: python -m pip install 'scipy>=1.10'"
        ) from exc
    return trimesh


def _load_stl_triangles(path: Path) -> NDArray[np.float64]:
    data = path.read_bytes()
    if len(data) >= 84:
        triangle_count = int.from_bytes(data[80:84], byteorder="little", signed=False)
        expected_size = 84 + triangle_count * 50
        if expected_size == len(data):
            return _load_binary_stl_triangles(data, triangle_count)
    return _load_ascii_stl_triangles(data.decode("utf-8", errors="ignore"))


def _load_binary_stl_triangles(data: bytes, triangle_count: int) -> NDArray[np.float64]:
    triangles = np.empty((triangle_count, 3, 3), dtype=np.float64)
    offset = 84
    for index in range(triangle_count):
        record = data[offset : offset + 50]
        floats = np.frombuffer(record, dtype="<f4", count=12)
        triangles[index] = floats[3:].reshape(3, 3)
        offset += 50
    return triangles


def _load_ascii_stl_triangles(text: str) -> NDArray[np.float64]:
    vertices: list[tuple[float, float, float]] = []
    for raw_line in text.splitlines():
        stripped = raw_line.strip()
        if not stripped:
            continue
        parts = stripped.split()
        if len(parts) == 4 and parts[0].lower() == "vertex":
            vertices.append((float(parts[1]), float(parts[2]), float(parts[3])))
    if not vertices or len(vertices) % 3 != 0:
        raise ValueError("could not parse STL triangles from imported geometry")
    return np.asarray(vertices, dtype=np.float64).reshape(-1, 3, 3)


def _merge_sorted_intersections(
    intersections: NDArray[np.float64],
    *,
    tolerance: float,
) -> NDArray[np.float64]:
    if intersections.size == 0:
        return intersections
    merged = [float(intersections[0])]
    for value in intersections[1:]:
        if abs(float(value) - merged[-1]) > tolerance:
            merged.append(float(value))
    return np.asarray(merged, dtype=np.float64)


def _voxelize_tetra_mesh(
    nodes: NDArray[np.float64],
    elements: NDArray[np.int32],
    cell_size: tuple[float, float, float],
) -> VoxelMaskData:
    mins = nodes.min(axis=0)
    maxs = nodes.max(axis=0)
    cell = np.asarray(cell_size, dtype=np.float64)
    extent = np.maximum(maxs - mins, cell)
    cells = np.maximum(1, np.ceil(extent / cell).astype(int))
    nx, ny, nz = int(cells[0]), int(cells[1]), int(cells[2])

    x_centers = mins[0] + (np.arange(nx, dtype=np.float64) + 0.5) * cell_size[0]
    y_centers = mins[1] + (np.arange(ny, dtype=np.float64) + 0.5) * cell_size[1]
    z_centers = mins[2] + (np.arange(nz, dtype=np.float64) + 0.5) * cell_size[2]
    mask = np.zeros((nz, ny, nx), dtype=np.bool_)
    bary_tolerance = float(cell.min() * 1e-9 + 1e-15)

    for tet in elements:
        tetra = nodes[tet]
        tet_min = tetra.min(axis=0)
        tet_max = tetra.max(axis=0)

        ix0 = max(0, int(np.floor((tet_min[0] - mins[0]) / cell_size[0] - 0.5)))
        ix1 = min(nx - 1, int(np.ceil((tet_max[0] - mins[0]) / cell_size[0] - 0.5)))
        iy0 = max(0, int(np.floor((tet_min[1] - mins[1]) / cell_size[1] - 0.5)))
        iy1 = min(ny - 1, int(np.ceil((tet_max[1] - mins[1]) / cell_size[1] - 0.5)))
        iz0 = max(0, int(np.floor((tet_min[2] - mins[2]) / cell_size[2] - 0.5)))
        iz1 = min(nz - 1, int(np.ceil((tet_max[2] - mins[2]) / cell_size[2] - 0.5)))
        if ix0 > ix1 or iy0 > iy1 or iz0 > iz1:
            continue

        matrix = np.column_stack(
            (
                tetra[1] - tetra[0],
                tetra[2] - tetra[0],
                tetra[3] - tetra[0],
            )
        )
        det = np.linalg.det(matrix)
        det_tolerance = max(float(np.linalg.norm(matrix, ord=np.inf) ** 3 * 1e-12), 1e-30)
        if abs(det) <= det_tolerance:
            continue
        inverse = np.linalg.inv(matrix)

        local_x = x_centers[ix0 : ix1 + 1]
        local_y = y_centers[iy0 : iy1 + 1]
        local_z = z_centers[iz0 : iz1 + 1]
        xx, yy, zz = np.meshgrid(local_x, local_y, local_z, indexing="xy")
        points = np.stack((xx, yy, zz), axis=-1).reshape(-1, 3)
        bary = (points - tetra[0]) @ inverse.T
        l1 = bary[:, 0]
        l2 = bary[:, 1]
        l3 = bary[:, 2]
        l0 = 1.0 - l1 - l2 - l3
        inside = (
            (l0 >= -bary_tolerance)
            & (l1 >= -bary_tolerance)
            & (l2 >= -bary_tolerance)
            & (l3 >= -bary_tolerance)
        )
        if not np.any(inside):
            centroid = tetra.mean(axis=0)
            ix = int(np.clip(np.floor((centroid[0] - mins[0]) / cell_size[0]), 0, nx - 1))
            iy = int(np.clip(np.floor((centroid[1] - mins[1]) / cell_size[1]), 0, ny - 1))
            iz = int(np.clip(np.floor((centroid[2] - mins[2]) / cell_size[2]), 0, nz - 1))
            mask[iz, iy, ix] = True
            continue

        local_mask = inside.reshape(local_y.size, local_x.size, local_z.size).transpose(2, 0, 1)
        mask[iz0 : iz1 + 1, iy0 : iy1 + 1, ix0 : ix1 + 1] |= local_mask

    return VoxelMaskData(
        mask=mask,
        cell_size=cell_size,
        origin=(float(mins[0]), float(mins[1]), float(mins[2])),
    )


def _voxelize_stl_without_trimesh(
    path: Path,
    cell_size: tuple[float, float, float],
    *,
    scale: float | tuple[float, float, float] = 1.0,
) -> VoxelMaskData:
    triangles = _load_stl_triangles(path)
    scale_xyz = _normalize_import_scale(scale)
    if not np.allclose(scale_xyz, 1.0):
        triangles = triangles * scale_xyz.reshape(1, 1, 3)
    mins = triangles.min(axis=(0, 1))
    maxs = triangles.max(axis=(0, 1))
    dx, dy, dz = cell_size

    extent = np.maximum(maxs - mins, np.asarray(cell_size, dtype=np.float64))
    cells = np.maximum(1, np.ceil(extent / np.asarray(cell_size, dtype=np.float64)).astype(int))
    nx, ny, nz = int(cells[0]), int(cells[1]), int(cells[2])

    x_centers = mins[0] + (np.arange(nx, dtype=np.float64) + 0.5) * dx
    y_centers = mins[1] + (np.arange(ny, dtype=np.float64) + 0.5) * dy
    z_centers = mins[2] + (np.arange(nz, dtype=np.float64) + 0.5) * dz

    y_min = triangles[:, :, 1].min(axis=1)
    y_max = triangles[:, :, 1].max(axis=1)
    z_min = triangles[:, :, 2].min(axis=1)
    z_max = triangles[:, :, 2].max(axis=1)

    mask = np.zeros((nz, ny, nx), dtype=np.bool_)
    ray_origin_x = float(mins[0] - dx)
    direction = np.asarray([1.0, 0.0, 0.0], dtype=np.float64)
    # Use a spatial tolerance for coordinate comparisons, but keep the
    # Moller-Trumbore determinant tolerance much smaller. After scaling STL
    # coordinates from e.g. nanometers to meters, a geometry can be perfectly
    # valid while its triangle determinants are around 1e-16 .. 1e-18. The
    # old single tolerance rejected every triangle as "parallel", producing a
    # silently empty active mask.
    spatial_tolerance = max(dx, dy, dz) * 1e-9 + 1e-15
    det_tolerance = max(dx, dy, dz) ** 2 * 1e-12

    for iz, z in enumerate(z_centers):
        for iy, y in enumerate(y_centers):
            candidate = (
                (y >= (y_min - spatial_tolerance))
                & (y <= (y_max + spatial_tolerance))
                & (z >= (z_min - spatial_tolerance))
                & (z <= (z_max + spatial_tolerance))
            )
            if not np.any(candidate):
                continue

            subset = triangles[candidate]
            v0 = subset[:, 0, :]
            v1 = subset[:, 1, :]
            v2 = subset[:, 2, :]
            edge1 = v1 - v0
            edge2 = v2 - v0
            pvec = np.cross(np.broadcast_to(direction, edge2.shape), edge2)
            det = np.einsum("ij,ij->i", edge1, pvec)
            valid = np.abs(det) > det_tolerance
            if not np.any(valid):
                continue

            v0 = v0[valid]
            edge1 = edge1[valid]
            edge2 = edge2[valid]
            pvec = pvec[valid]
            det = det[valid]
            inv_det = 1.0 / det

            origin = np.asarray([ray_origin_x, y, z], dtype=np.float64)
            tvec = origin - v0
            u = np.einsum("ij,ij->i", tvec, pvec) * inv_det
            qvec = np.cross(tvec, edge1)
            v = qvec[:, 0] * inv_det
            t = np.einsum("ij,ij->i", edge2, qvec) * inv_det

            hit = (
                (u >= -spatial_tolerance)
                & (v >= -spatial_tolerance)
                & ((u + v) <= (1.0 + spatial_tolerance))
                & (t >= -spatial_tolerance)
            )
            if not np.any(hit):
                continue

            intersections = np.sort(ray_origin_x + t[hit])
            intersections = _merge_sorted_intersections(
                intersections,
                tolerance=spatial_tolerance,
            )
            if intersections.size < 2:
                continue
            if intersections.size % 2 == 1:
                intersections = intersections[:-1]
            if intersections.size == 0:
                continue

            row = mask[iz, iy, :]
            for start, end in intersections.reshape(-1, 2):
                row |= (x_centers >= (start - spatial_tolerance)) & (
                    x_centers <= (end + spatial_tolerance)
                )

    return VoxelMaskData(
        mask=mask,
        cell_size=cell_size,
        origin=(float(mins[0]), float(mins[1]), float(mins[2])),
    )


@dataclass(frozen=True, slots=True)
class VoxelMaskData:
    mask: NDArray[np.bool_]
    cell_size: tuple[float, float, float]
    origin: tuple[float, float, float]

    def __post_init__(self) -> None:
        object.__setattr__(self, "mask", np.asarray(self.mask, dtype=np.bool_))
        if self.mask.ndim != 3:
            raise ValueError("mask must have shape (nz, ny, nx)")

    @property
    def shape(self) -> tuple[int, int, int]:
        return tuple(int(v) for v in self.mask.shape)

    @property
    def active_cell_count(self) -> int:
        return int(self.mask.sum())

    @property
    def active_fraction(self) -> float:
        return float(self.mask.mean()) if self.mask.size else 0.0

    def save(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        np.savez_compressed(
            target,
            mask=self.mask,
            cell_size=np.asarray(self.cell_size, dtype=np.float64),
            origin=np.asarray(self.origin, dtype=np.float64),
            mask_axis_order=np.asarray("zyx"),
        )

    @classmethod
    def load(cls, path: str | Path) -> "VoxelMaskData":
        data = np.load(Path(path))
        mask = np.asarray(data["mask"], dtype=np.bool_)
        axis_order = "zyx"
        if "mask_axis_order" in data.files:
            raw_axis_order = data["mask_axis_order"]
            axis_order = str(raw_axis_order.tolist() if hasattr(raw_axis_order, "tolist") else raw_axis_order)
        if axis_order == "xyz":
            mask = np.transpose(mask, (2, 1, 0))
        elif axis_order != "zyx":
            raise ValueError(f"unsupported voxel mask axis order '{axis_order}'")
        return cls(
            mask=mask,
            cell_size=tuple(float(v) for v in data["cell_size"]),
            origin=tuple(float(v) for v in data["origin"]),
        )

    def to_ir(self, geometry_name: str) -> dict[str, object]:
        nz, ny, nx = self.shape
        return {
            "geometry_name": geometry_name,
            "cells": [nx, ny, nz],
            "cell_size": list(self.cell_size),
            "origin": list(self.origin),
            "active_mask": self.mask.reshape(-1).tolist(),
        }


# ---------------------------------------------------------------------------
# Bounding box computation
# ---------------------------------------------------------------------------
def _bounding_box(geometry: Geometry) -> tuple[float, float, float]:
    """Return (sx, sy, sz) that fully contains the geometry, centered at origin."""
    if isinstance(geometry, Box):
        return geometry.size
    if isinstance(geometry, Cylinder):
        d = 2.0 * geometry.radius
        return (d, d, geometry.height)
    if isinstance(geometry, Ellipsoid):
        return (2.0 * geometry.rx, 2.0 * geometry.ry, 2.0 * geometry.rz)
    if isinstance(geometry, Ellipse):
        return (2.0 * geometry.rx, 2.0 * geometry.ry, geometry.height)
    if isinstance(geometry, Difference):
        return _bounding_box(geometry.base)
    if isinstance(geometry, Union):
        ba = _bounding_box(geometry.a)
        bb = _bounding_box(geometry.b)
        return (max(ba[0], bb[0]), max(ba[1], bb[1]), max(ba[2], bb[2]))
    if isinstance(geometry, Intersection):
        ba = _bounding_box(geometry.a)
        bb = _bounding_box(geometry.b)
        return (min(ba[0], bb[0]), min(ba[1], bb[1]), min(ba[2], bb[2]))
    if isinstance(geometry, Translate):
        inner = _bounding_box(geometry.geometry)
        ox, oy, oz = geometry.offset
        return (
            inner[0] + 2.0 * abs(ox),
            inner[1] + 2.0 * abs(oy),
            inner[2] + 2.0 * abs(oz),
        )
    if isinstance(geometry, ImportedGeometry):
        raise TypeError(
            "cannot compute bounding box for ImportedGeometry; "
            "use _voxelize_imported_geometry directly"
        )
    raise TypeError(f"unsupported geometry type: {type(geometry)!r}")


# ---------------------------------------------------------------------------
# SDF-based containment test (vectorized numpy)
# ---------------------------------------------------------------------------
def _contains(
    geometry: Geometry,
    xx: NDArray[np.float64],
    yy: NDArray[np.float64],
    zz: NDArray[np.float64],
) -> NDArray[np.bool_]:
    """Return boolean mask of cells contained in the geometry.

    xx, yy, zz are 3D arrays of cell center coordinates (shape nz, ny, nx).
    """
    if isinstance(geometry, Box):
        sx, sy, sz = geometry.size
        return (
            (np.abs(xx) <= sx / 2.0)
            & (np.abs(yy) <= sy / 2.0)
            & (np.abs(zz) <= sz / 2.0)
        )

    if isinstance(geometry, Cylinder):
        r = geometry.radius
        h = geometry.height
        return (xx * xx + yy * yy <= r * r) & (np.abs(zz) <= h / 2.0)

    if isinstance(geometry, Ellipsoid):
        rx, ry, rz = geometry.rx, geometry.ry, geometry.rz
        return (xx / rx) ** 2 + (yy / ry) ** 2 + (zz / rz) ** 2 <= 1.0

    if isinstance(geometry, Ellipse):
        rx, ry, h = geometry.rx, geometry.ry, geometry.height
        return ((xx / rx) ** 2 + (yy / ry) ** 2 <= 1.0) & (np.abs(zz) <= h / 2.0)

    if isinstance(geometry, Difference):
        base_mask = _contains(geometry.base, xx, yy, zz)
        tool_mask = _contains(geometry.tool, xx, yy, zz)
        return base_mask & ~tool_mask

    if isinstance(geometry, Union):
        return _contains(geometry.a, xx, yy, zz) | _contains(geometry.b, xx, yy, zz)

    if isinstance(geometry, Intersection):
        return _contains(geometry.a, xx, yy, zz) & _contains(geometry.b, xx, yy, zz)

    if isinstance(geometry, Translate):
        ox, oy, oz = geometry.offset
        return _contains(geometry.geometry, xx - ox, yy - oy, zz - oz)

    raise TypeError(f"unsupported geometry type for containment test: {type(geometry)!r}")


# ---------------------------------------------------------------------------
# Main voxelization entry point
# ---------------------------------------------------------------------------
def voxelize_geometry(
    geometry: Geometry,
    cell_size: tuple[float, float, float],
) -> VoxelMaskData:
    """Convert any Geometry into a VoxelMaskData using SDF containment.

    For ImportedGeometry, delegates to file-based loading.
    For all other types, uses recursive ``_contains`` evaluation.
    """
    if isinstance(geometry, ImportedGeometry):
        return _voxelize_imported_geometry(geometry.source, cell_size, scale=geometry.scale)

    # Compute bounding box and grid
    sx, sy, sz = _bounding_box(geometry)
    dx, dy, dz = cell_size
    nx = max(1, int(round(sx / dx)))
    ny = max(1, int(round(sy / dy)))
    nz = max(1, int(round(sz / dz)))

    # Cell center coordinates
    xs = -sx / 2.0 + (np.arange(nx, dtype=np.float64) + 0.5) * dx
    ys = -sy / 2.0 + (np.arange(ny, dtype=np.float64) + 0.5) * dy
    zs = -sz / 2.0 + (np.arange(nz, dtype=np.float64) + 0.5) * dz

    # 3D meshgrid: xx[iz, iy, ix], yy[iz, iy, ix], zz[iz, iy, ix]
    xx_2d, yy_2d = np.meshgrid(xs, ys, indexing="xy")
    xx = np.broadcast_to(xx_2d[np.newaxis, :, :], (nz, ny, nx)).copy()
    yy = np.broadcast_to(yy_2d[np.newaxis, :, :], (nz, ny, nx)).copy()
    zz = np.broadcast_to(
        zs[:, np.newaxis, np.newaxis], (nz, ny, nx)
    ).copy()

    mask = _contains(geometry, xx, yy, zz)

    return VoxelMaskData(
        mask=mask,
        cell_size=cell_size,
        origin=(-sx / 2.0, -sy / 2.0, -sz / 2.0),
    )


# ---------------------------------------------------------------------------
# Imported geometry (NPZ / STL)
# ---------------------------------------------------------------------------
def _voxelize_imported_geometry(
    source: str | Path,
    cell_size: tuple[float, float, float],
    *,
    scale: float | tuple[float, float, float] = 1.0,
) -> VoxelMaskData:
    path = Path(source)
    scale_xyz = _normalize_import_scale(scale)
    if path.suffix.lower() == ".npz":
        if not np.allclose(scale_xyz, 1.0):
            raise ValueError("scale is not supported for precomputed .npz voxel assets")
        mask_data = VoxelMaskData.load(path)
        if any(
            not np.isclose(mask_data.cell_size[index], cell_size[index])
            for index in range(3)
        ):
            raise ValueError(
                "precomputed voxel mask cell size does not match requested FDM cell size"
            )
        return mask_data
    if path.suffix.lower() != ".stl":
        raise ValueError(
            "initial imported-geometry voxelization scaffold supports only STL or precomputed .npz voxel assets"
        )

    dx, dy, dz = cell_size
    if not np.isclose(dx, dy) or not np.isclose(dx, dz):
        raise NotImplementedError(
            "initial STL voxelization scaffold supports only isotropic cell size"
        )

    try:
        trimesh = _import_trimesh_voxelization_stack()
    except ImportError:
        try:
            from .gmsh_bridge import generate_mesh_from_file

            mesh = generate_mesh_from_file(
                path,
                hmax=float(
                    min(
                        cell_size[index] / scale_xyz[index]
                        for index in range(3)
                    )
                ),
                order=1,
            )
            nodes = mesh.nodes if np.allclose(scale_xyz, 1.0) else mesh.nodes * scale_xyz
            return _voxelize_tetra_mesh(nodes, mesh.elements, (dx, dy, dz))
        except Exception:
            return _voxelize_stl_without_trimesh(path, (dx, dy, dz), scale=scale)

    mesh = trimesh.load_mesh(path, force="mesh")
    if not np.allclose(scale_xyz, 1.0):
        mesh = mesh.copy()
        scale_transform = np.eye(4, dtype=np.float64)
        scale_transform[0, 0] = scale_xyz[0]
        scale_transform[1, 1] = scale_xyz[1]
        scale_transform[2, 2] = scale_xyz[2]
        mesh.apply_transform(scale_transform)
    voxel_grid = mesh.voxelized(dx).fill()
    matrix = np.asarray(voxel_grid.matrix, dtype=np.bool_)
    # trimesh exposes dense voxel grids in (x, y, z) order, while the rest of
    # Fullmag uses canonical (z, y, x) masks so flattening stays x-fastest.
    matrix = np.transpose(matrix, (2, 1, 0))
    translation = np.asarray(voxel_grid.transform[:3, 3], dtype=np.float64)

    return VoxelMaskData(
        mask=matrix,
        cell_size=(dx, dy, dz),
        origin=(float(translation[0]), float(translation[1]), float(translation[2])),
    )
