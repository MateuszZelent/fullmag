"""Vectorized exterior surface and volumetric cell extraction for regular 3D FDM grids."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Any, Sequence

import numpy as np
from numpy.typing import ArrayLike, NDArray


@dataclass(frozen=True, slots=True)
class VoxelShell:
    """Exterior triangle shell extracted from a regular 3D voxel grid.

    Every exposed voxel quad emits 4 unshared vertices so face normals remain
    flat and every triangle carries the exact color of its owning cell via
    ``cell_indices``.
    """

    positions: NDArray[np.float64]
    normals: NDArray[np.float64]
    indices: NDArray[np.uint32]
    cell_indices: NDArray[np.int64]
    edge_indices: NDArray[np.uint32]
    grid_shape: tuple[int, int, int]
    cell_size_m: tuple[float, float, float]
    origin_m: tuple[float, float, float]


@dataclass(frozen=True, slots=True)
class VoxelHexahedra:
    """Compacted VTK_HEXAHEDRON (type=12) volume mesh for active FDM cells."""

    points_m: NDArray[np.float64]
    connectivity: NDArray[np.int64]
    cell_indices: NDArray[np.int64]


# Each entry: (axis_normal, 4 corner (dx, dy, dz) offsets in CCW outward order)
_FACE_SPECS: tuple[
    tuple[tuple[float, float, float], tuple[tuple[int, int, int], ...]], ...
] = (
    ((-1.0, 0.0, 0.0), ((0, 0, 0), (0, 0, 1), (0, 1, 1), (0, 1, 0))),
    ((1.0, 0.0, 0.0), ((1, 0, 0), (1, 1, 0), (1, 1, 1), (1, 0, 1))),
    ((0.0, -1.0, 0.0), ((0, 0, 0), (1, 0, 0), (1, 0, 1), (0, 0, 1))),
    ((0.0, 1.0, 0.0), ((0, 1, 0), (0, 1, 1), (1, 1, 1), (1, 1, 0))),
    ((0.0, 0.0, -1.0), ((0, 0, 0), (0, 1, 0), (1, 1, 0), (1, 0, 0))),
    ((0.0, 0.0, 1.0), ((0, 0, 1), (1, 0, 1), (1, 1, 1), (0, 1, 1))),
)

_HEX_VTK_CORNER_OFFSETS: tuple[tuple[int, int, int], ...] = (
    (0, 0, 0),
    (1, 0, 0),
    (1, 1, 0),
    (0, 1, 0),
    (0, 0, 1),
    (1, 0, 1),
    (1, 1, 1),
    (0, 1, 1),
)


def validate_grid_descriptor(
    grid_shape: Sequence[int],
    cell_size_m: Sequence[float],
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
) -> tuple[tuple[int, int, int], tuple[float, float, float], tuple[float, float, float]]:
    """Validate and normalize ``(nx, ny, nz)``, ``(dx, dy, dz)``, and ``(ox, oy, oz)``."""
    if len(grid_shape) != 3:
        raise ValueError(f"grid_shape must have 3 elements (nx, ny, nz), got {grid_shape}")
    nx, ny, nz = (int(grid_shape[0]), int(grid_shape[1]), int(grid_shape[2]))
    if nx <= 0 or ny <= 0 or nz <= 0:
        raise ValueError(f"grid_shape entries must be positive, got {(nx, ny, nz)}")

    if len(cell_size_m) != 3:
        raise ValueError(f"cell_size_m must have 3 elements (dx, dy, dz), got {cell_size_m}")
    dx, dy, dz = (float(cell_size_m[0]), float(cell_size_m[1]), float(cell_size_m[2]))
    if not (
        math.isfinite(dx)
        and math.isfinite(dy)
        and math.isfinite(dz)
        and dx > 0.0
        and dy > 0.0
        and dz > 0.0
    ):
        raise ValueError(f"cell_size_m entries must be positive and finite, got {(dx, dy, dz)}")

    if len(origin_m) != 3:
        raise ValueError(f"origin_m must have 3 elements (ox, oy, oz), got {origin_m}")
    ox, oy, oz = (float(origin_m[0]), float(origin_m[1]), float(origin_m[2]))
    if not (math.isfinite(ox) and math.isfinite(oy) and math.isfinite(oz)):
        raise ValueError(f"origin_m entries must be finite, got {(ox, oy, oz)}")

    return (nx, ny, nz), (dx, dy, dz), (ox, oy, oz)


def normalize_active_mask(
    active_mask: ArrayLike | Any | None,
    grid_shape: tuple[int, int, int],
    *,
    axis_order: str = "zyx",
) -> NDArray[np.bool_]:
    """Return a contiguous boolean mask of shape ``(nz, ny, nx)``."""
    nx, ny, nz = grid_shape
    total = nx * ny * nz
    if active_mask is None:
        return np.ones((nz, ny, nx), dtype=bool)

    if hasattr(active_mask, "mask") and hasattr(active_mask, "shape"):
        raw = np.asarray(active_mask.mask, dtype=bool)
        axis_order = "zyx"
    else:
        raw = np.asarray(active_mask)
        if raw.dtype != bool:
            raw = raw != 0

    if raw.ndim == 1:
        if raw.size != total:
            raise ValueError(
                f"flat active_mask length {raw.size} does not match grid cell count {total}"
            )
        return np.ascontiguousarray(raw.reshape((nz, ny, nx)), dtype=bool)

    if raw.ndim == 3:
        order = axis_order.strip().lower()
        if order == "zyx":
            if raw.shape != (nz, ny, nx):
                raise ValueError(
                    f"3D active_mask with axis_order='zyx' must have shape {(nz, ny, nx)}, got {raw.shape}"
                )
            return np.ascontiguousarray(raw, dtype=bool)
        if order == "xyz":
            if raw.shape != (nx, ny, nz):
                raise ValueError(
                    f"3D active_mask with axis_order='xyz' must have shape {(nx, ny, nz)}, got {raw.shape}"
                )
            return np.ascontiguousarray(np.transpose(raw, (2, 1, 0)), dtype=bool)
        raise ValueError(f"axis_order must be 'zyx' or 'xyz', got '{axis_order}'")

    raise ValueError(
        f"active_mask must be 1D ({total},) or 3D ({nz}, {ny}, {nx}), got shape {raw.shape}"
    )


def _exposed_face_masks(occ: NDArray[np.bool_]) -> tuple[NDArray[np.bool_], ...]:
    """Compute exposed face boolean masks for (-X, +X, -Y, +Y, -Z, +Z)."""
    neg_x = np.empty_like(occ)
    neg_x[:, :, 0] = occ[:, :, 0]
    neg_x[:, :, 1:] = occ[:, :, 1:] & ~occ[:, :, :-1]

    pos_x = np.empty_like(occ)
    pos_x[:, :, -1] = occ[:, :, -1]
    pos_x[:, :, :-1] = occ[:, :, :-1] & ~occ[:, :, 1:]

    neg_y = np.empty_like(occ)
    neg_y[:, 0, :] = occ[:, 0, :]
    neg_y[:, 1:, :] = occ[:, 1:, :] & ~occ[:, :-1, :]

    pos_y = np.empty_like(occ)
    pos_y[:, -1, :] = occ[:, -1, :]
    pos_y[:, :-1, :] = occ[:, :-1, :] & ~occ[:, 1:, :]

    neg_z = np.empty_like(occ)
    neg_z[0, :, :] = occ[0, :, :]
    neg_z[1:, :, :] = occ[1:, :, :] & ~occ[:-1, :, :]

    pos_z = np.empty_like(occ)
    pos_z[-1, :, :] = occ[-1, :, :]
    pos_z[:-1, :, :] = occ[:-1, :, :] & ~occ[1:, :, :]

    return (neg_x, pos_x, neg_y, pos_y, neg_z, pos_z)


def extract_voxel_shell(
    grid_shape: Sequence[int],
    cell_size_m: Sequence[float],
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: ArrayLike | Any | None = None,
    *,
    axis_order: str = "zyx",
    cell_offset: int = 0,
    include_edges: bool = True,
) -> VoxelShell:
    """Extract the face-culled exterior triangle shell of a regular 3D voxel grid."""
    shape, cell_size, origin = validate_grid_descriptor(grid_shape, cell_size_m, origin_m)
    nx, ny, nz = shape
    dx, dy, dz = cell_size
    ox, oy, oz = origin

    occ = normalize_active_mask(active_mask, shape, axis_order=axis_order)
    if not np.any(occ):
        raise ValueError("active_mask leaves zero active cells to extract")

    face_masks = _exposed_face_masks(occ)
    pos_chunks: list[NDArray[np.float64]] = []
    norm_chunks: list[NDArray[np.float64]] = []
    idx_chunks: list[NDArray[np.uint32]] = []
    cell_chunks: list[NDArray[np.int64]] = []
    gid_chunks: list[NDArray[np.int64]] = []
    edge_gid_chunks: list[NDArray[np.int64]] = []

    vertex_cursor = 0
    plane_stride = nx * ny
    grid_stride_y = nx + 1
    grid_stride_z = (nx + 1) * (ny + 1)

    for face_mask, (normal, corners) in zip(face_masks, _FACE_SPECS):
        iz, iy, ix = np.nonzero(face_mask)
        face_count = iz.shape[0]
        if face_count == 0:
            continue

        iz_i64 = iz.astype(np.int64)
        iy_i64 = iy.astype(np.int64)
        ix_i64 = ix.astype(np.int64)
        flat_cells = int(cell_offset) + iz_i64 * plane_stride + iy_i64 * nx + ix_i64

        quad_pos = np.empty((face_count, 4, 3), dtype=np.float64)
        quad_gids = np.empty((face_count, 4), dtype=np.int64)
        for corner_i, (cx, cy, cz) in enumerate(corners):
            gx = ix_i64 + cx
            gy = iy_i64 + cy
            gz = iz_i64 + cz
            quad_pos[:, corner_i, 0] = ox + gx * dx
            quad_pos[:, corner_i, 1] = oy + gy * dy
            quad_pos[:, corner_i, 2] = oz + gz * dz
            if include_edges:
                quad_gids[:, corner_i] = gz * grid_stride_z + gy * grid_stride_y + gx

        pos_chunks.append(quad_pos.reshape(face_count * 4, 3))
        norm_arr = np.empty((face_count * 4, 3), dtype=np.float64)
        norm_arr[:, 0] = normal[0]
        norm_arr[:, 1] = normal[1]
        norm_arr[:, 2] = normal[2]
        norm_chunks.append(norm_arr)

        base = vertex_cursor + (np.arange(face_count, dtype=np.uint32) * 4)
        tris = np.empty((face_count * 2, 3), dtype=np.uint32)
        tris[0::2, 0] = base
        tris[0::2, 1] = base + 1
        tris[0::2, 2] = base + 2
        tris[1::2, 0] = base
        tris[1::2, 1] = base + 2
        tris[1::2, 2] = base + 3
        idx_chunks.append(tris)
        cell_chunks.append(np.repeat(flat_cells, 4))

        if include_edges:
            gid_chunks.append(quad_gids.reshape(-1))
            pairs = np.stack(
                (
                    np.stack((quad_gids[:, 0], quad_gids[:, 1]), axis=1),
                    np.stack((quad_gids[:, 1], quad_gids[:, 2]), axis=1),
                    np.stack((quad_gids[:, 2], quad_gids[:, 3]), axis=1),
                    np.stack((quad_gids[:, 3], quad_gids[:, 0]), axis=1),
                ),
                axis=1,
            ).reshape(-1, 2)
            edge_gid_chunks.append(np.sort(pairs, axis=1))

        vertex_cursor += face_count * 4

    positions = np.concatenate(pos_chunks, axis=0)
    normals = np.concatenate(norm_chunks, axis=0)
    indices = np.concatenate(idx_chunks, axis=0)
    cell_indices = np.concatenate(cell_chunks, axis=0)

    if include_edges and edge_gid_chunks:
        all_gids = np.concatenate(gid_chunks, axis=0)
        unique_gids, first_vidx = np.unique(all_gids, return_index=True)
        unique_edges_gid = np.unique(np.concatenate(edge_gid_chunks, axis=0), axis=0)
        pos_in_unique = np.searchsorted(unique_gids, unique_edges_gid)
        edge_indices = first_vidx[pos_in_unique].astype(np.uint32)
    else:
        edge_indices = np.zeros((0, 2), dtype=np.uint32)

    return VoxelShell(
        positions=positions,
        normals=normals,
        indices=indices,
        cell_indices=cell_indices,
        edge_indices=edge_indices,
        grid_shape=shape,
        cell_size_m=cell_size,
        origin_m=origin,
    )


def merge_voxel_shells(shells: Sequence[VoxelShell]) -> VoxelShell:
    """Merge multiple layer ``VoxelShell`` objects into a single shell."""
    if not shells:
        raise ValueError("cannot merge an empty sequence of VoxelShell instances")
    if len(shells) == 1:
        return shells[0]

    pos_list: list[NDArray[np.float64]] = []
    norm_list: list[NDArray[np.float64]] = []
    idx_list: list[NDArray[np.uint32]] = []
    cell_list: list[NDArray[np.int64]] = []
    edge_list: list[NDArray[np.uint32]] = []

    offset = 0
    for shell in shells:
        pos_list.append(shell.positions)
        norm_list.append(shell.normals)
        idx_list.append(shell.indices + np.uint32(offset))
        cell_list.append(shell.cell_indices)
        if shell.edge_indices.size:
            edge_list.append(shell.edge_indices + np.uint32(offset))
        offset += shell.positions.shape[0]

    edge_indices = (
        np.concatenate(edge_list, axis=0)
        if edge_list
        else np.zeros((0, 2), dtype=np.uint32)
    )
    return VoxelShell(
        positions=np.concatenate(pos_list, axis=0),
        normals=np.concatenate(norm_list, axis=0),
        indices=np.concatenate(idx_list, axis=0),
        cell_indices=np.concatenate(cell_list, axis=0),
        edge_indices=edge_indices,
        grid_shape=shells[0].grid_shape,
        cell_size_m=shells[0].cell_size_m,
        origin_m=shells[0].origin_m,
    )


def voxel_cell_centers_m(
    grid_shape: Sequence[int],
    cell_size_m: Sequence[float],
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: ArrayLike | Any | None = None,
    *,
    axis_order: str = "zyx",
    cell_offset: int = 0,
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    """Return ``(centers_m, cell_indices)`` for all active cells of a 3D voxel grid."""
    shape, cell_size, origin = validate_grid_descriptor(grid_shape, cell_size_m, origin_m)
    nx, ny, _nz = shape
    dx, dy, dz = cell_size
    ox, oy, oz = origin
    occ = normalize_active_mask(active_mask, shape, axis_order=axis_order)
    iz, iy, ix = np.nonzero(occ)
    if iz.size == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0,), dtype=np.int64)
    iz_i64 = iz.astype(np.int64)
    iy_i64 = iy.astype(np.int64)
    ix_i64 = ix.astype(np.int64)
    centers = np.column_stack(
        (
            ox + (ix_i64 + 0.5) * dx,
            oy + (iy_i64 + 0.5) * dy,
            oz + (iz_i64 + 0.5) * dz,
        )
    )
    cell_indices = int(cell_offset) + iz_i64 * (nx * ny) + iy_i64 * nx + ix_i64
    return centers, cell_indices


def sample_grid_arrow_sites(
    grid_shape: Sequence[int],
    cell_size_m: Sequence[float],
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: ArrayLike | Any | None = None,
    *,
    max_arrows: int = 256,
    axis_order: str = "zyx",
    cell_offset: int = 0,
) -> tuple[NDArray[np.float64], NDArray[np.int64]]:
    """Spatially sample up to ``max_arrows`` active cell centers across the grid."""
    centers, cell_indices = voxel_cell_centers_m(
        grid_shape,
        cell_size_m,
        origin_m,
        active_mask=active_mask,
        axis_order=axis_order,
        cell_offset=cell_offset,
    )
    budget = max(0, int(max_arrows))
    if budget == 0 or centers.shape[0] == 0:
        return np.zeros((0, 3), dtype=np.float64), np.zeros((0,), dtype=np.int64)
    if centers.shape[0] <= budget:
        return centers, cell_indices

    nx, ny, nz = validate_grid_descriptor(grid_shape, cell_size_m, origin_m)[0]
    local_indices = cell_indices - int(cell_offset)
    ix = local_indices % nx
    iy = (local_indices // nx) % ny
    iz = local_indices // (nx * ny)

    # Choose spatial strides per axis so total sampled cells remain within budget.
    stride = max(1, int(math.ceil((centers.shape[0] / budget) ** (1.0 / 3.0))))
    sx = min(stride, max(1, nx))
    sy = min(stride, max(1, ny))
    sz = min(stride, max(1, nz))
    selected = np.flatnonzero(((ix % sx) == 0) & ((iy % sy) == 0) & ((iz % sz) == 0))
    if selected.size == 0 or selected.size > budget:
        idx = np.unique(
            np.floor(np.linspace(0, centers.shape[0] - 1, budget)).astype(np.int64)
        )
        return centers[idx], cell_indices[idx]
    return centers[selected], cell_indices[selected]


def voxel_hexahedra_vtu_data(
    grid_shape: Sequence[int],
    cell_size_m: Sequence[float],
    origin_m: Sequence[float] = (0.0, 0.0, 0.0),
    active_mask: ArrayLike | Any | None = None,
    *,
    axis_order: str = "zyx",
    cell_offset: int = 0,
) -> VoxelHexahedra:
    """Build compacted VTK hexahedron points and connectivity for active cells."""
    shape, cell_size, origin = validate_grid_descriptor(grid_shape, cell_size_m, origin_m)
    nx, ny, _nz = shape
    dx, dy, dz = cell_size
    ox, oy, oz = origin
    occ = normalize_active_mask(active_mask, shape, axis_order=axis_order)
    iz, iy, ix = np.nonzero(occ)
    if iz.size == 0:
        raise ValueError("active_mask leaves zero active cells to export")

    iz_i64 = iz.astype(np.int64)
    iy_i64 = iy.astype(np.int64)
    ix_i64 = ix.astype(np.int64)
    cell_indices = int(cell_offset) + iz_i64 * (nx * ny) + iy_i64 * nx + ix_i64

    stride_y = nx + 1
    stride_z = (nx + 1) * (ny + 1)
    cell_count = iz_i64.shape[0]
    corner_gids = np.empty((cell_count, 8), dtype=np.int64)
    for corner_i, (cx, cy, cz) in enumerate(_HEX_VTK_CORNER_OFFSETS):
        corner_gids[:, corner_i] = (
            (iz_i64 + cz) * stride_z + (iy_i64 + cy) * stride_y + (ix_i64 + cx)
        )

    unique_gids, inverse = np.unique(corner_gids, return_inverse=True)
    connectivity = inverse.reshape(cell_count, 8).astype(np.int64)

    ux = unique_gids % (nx + 1)
    uy = (unique_gids // (nx + 1)) % (ny + 1)
    uz = unique_gids // stride_z
    points_m = np.column_stack((ox + ux * dx, oy + uy * dy, oz + uz * dz))

    return VoxelHexahedra(
        points_m=points_m,
        connectivity=connectivity,
        cell_indices=cell_indices,
    )
