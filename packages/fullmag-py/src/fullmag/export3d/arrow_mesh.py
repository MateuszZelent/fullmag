"""3D unit arrow mesh generation, merged static arrows, and animated TRS tracks."""

from __future__ import annotations

from dataclasses import dataclass
import math

import numpy as np
from numpy.typing import ArrayLike, NDArray


@dataclass(frozen=True, slots=True)
class UnitArrowMesh:
    """Unit arrow mesh oriented along ``+Y`` with total length ``1.0``."""

    positions: NDArray[np.float64]
    normals: NDArray[np.float64]
    indices: NDArray[np.uint32]
    anchor: str


def create_unit_arrow_mesh(
    *,
    radial_segments: int = 12,
    shaft_radius: float = 0.065,
    head_radius: float = 0.16,
    head_length_ratio: float = 0.34,
    anchor: str = "center",
) -> UnitArrowMesh:
    """Build a watertight cylinder+cone unit arrow oriented along ``+Y``."""
    seg = max(6, int(radial_segments))
    anchor_norm = anchor.strip().lower()
    if anchor_norm not in {"center", "tail"}:
        raise ValueError(f"arrow anchor must be 'center' or 'tail', got '{anchor}'")

    head_len = float(np.clip(head_length_ratio, 0.1, 0.8))
    y_min = -0.5 if anchor_norm == "center" else 0.0
    y_max = y_min + 1.0
    y_split = y_max - head_len

    angles = np.linspace(0.0, 2.0 * math.pi, seg, endpoint=False, dtype=np.float64)
    cos_a = np.cos(angles)
    sin_a = np.sin(angles)

    pos_parts: list[NDArray[np.float64]] = []
    norm_parts: list[NDArray[np.float64]] = []
    idx_parts: list[NDArray[np.uint32]] = []
    v_cursor = 0

    def _add_disk(y: float, radius: float, ny: float) -> None:
        nonlocal v_cursor
        verts = np.zeros((seg + 1, 3), dtype=np.float64)
        verts[0] = (0.0, y, 0.0)
        verts[1:, 0] = radius * cos_a
        verts[1:, 1] = y
        verts[1:, 2] = radius * sin_a

        norms = np.zeros((seg + 1, 3), dtype=np.float64)
        norms[:, 1] = ny

        i_arr = np.arange(seg, dtype=np.uint32)
        j_arr = (i_arr + 1) % seg
        tris = np.empty((seg, 3), dtype=np.uint32)
        tris[:, 0] = v_cursor
        if ny < 0.0:
            tris[:, 1] = v_cursor + 1 + i_arr
            tris[:, 2] = v_cursor + 1 + j_arr
        else:
            tris[:, 1] = v_cursor + 1 + j_arr
            tris[:, 2] = v_cursor + 1 + i_arr

        pos_parts.append(verts)
        norm_parts.append(norms)
        idx_parts.append(tris)
        v_cursor += seg + 1

    # 1. Shaft bottom cap (-Y normal)
    _add_disk(y_min, float(shaft_radius), -1.0)

    # 2. Shaft cylinder wall
    shaft_bot = np.column_stack((shaft_radius * cos_a, np.full(seg, y_min), shaft_radius * sin_a))
    shaft_top = np.column_stack((shaft_radius * cos_a, np.full(seg, y_split), shaft_radius * sin_a))
    shaft_norms = np.column_stack((cos_a, np.zeros(seg), sin_a))
    i_arr = np.arange(seg, dtype=np.uint32)
    j_arr = (i_arr + 1) % seg

    b0 = v_cursor + i_arr
    b1 = v_cursor + j_arr
    t0 = v_cursor + seg + i_arr
    t1 = v_cursor + seg + j_arr
    cyl_tris = np.empty((2 * seg, 3), dtype=np.uint32)
    cyl_tris[0::2, 0] = b0
    cyl_tris[0::2, 1] = t0
    cyl_tris[0::2, 2] = b1
    cyl_tris[1::2, 0] = t0
    cyl_tris[1::2, 1] = t1
    cyl_tris[1::2, 2] = b1
    pos_parts.extend((shaft_bot, shaft_top))
    norm_parts.extend((shaft_norms, shaft_norms))
    idx_parts.append(cyl_tris)
    v_cursor += 2 * seg

    # 3. Cone base cap (-Y normal)
    _add_disk(y_split, float(head_radius), -1.0)

    # 4. Cone flank (per-segment apex vertex keeps cone normal exact)
    slope = math.hypot(head_radius, head_len)
    ny_cone = head_radius / slope
    nr_cone = head_len / slope

    cone_base = np.column_stack((head_radius * cos_a, np.full(seg, y_split), head_radius * sin_a))
    cone_base_norms = np.column_stack((nr_cone * cos_a, np.full(seg, ny_cone), nr_cone * sin_a))
    mid_angles = angles + (math.pi / seg)
    cone_apex = np.tile(np.array([[0.0, y_max, 0.0]], dtype=np.float64), (seg, 1))
    cone_apex_norms = np.column_stack(
        (nr_cone * np.cos(mid_angles), np.full(seg, ny_cone), nr_cone * np.sin(mid_angles))
    )

    cb0 = v_cursor + i_arr
    cb1 = v_cursor + j_arr
    ca = v_cursor + seg + i_arr
    cone_tris = np.column_stack((cb0, ca, cb1)).astype(np.uint32)

    pos_parts.extend((cone_base, cone_apex))
    norm_parts.extend((cone_base_norms, cone_apex_norms))
    idx_parts.append(cone_tris)

    return UnitArrowMesh(
        positions=np.concatenate(pos_parts, axis=0),
        normals=np.concatenate(norm_parts, axis=0),
        indices=np.concatenate(idx_parts, axis=0),
        anchor=anchor_norm,
    )


def vectors_to_quaternions_xyzw(
    vectors: ArrayLike,
) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """Compute unit quaternions ``[x, y, z, w]`` rotating ``+Y`` onto each 3D vector.

    Returns ``(quats_xyzw, norms)`` preserving leading dimensions of ``vectors``.
    """
    arr = np.asarray(vectors, dtype=np.float64)
    if arr.ndim < 1 or arr.shape[-1] != 3:
        raise ValueError(f"expected vectors with last axis 3, got {arr.shape}")

    lead_shape = arr.shape[:-1]
    flat = arr.reshape(-1, 3)
    norms = np.linalg.norm(flat, axis=1)
    valid = np.isfinite(norms) & np.all(np.isfinite(flat), axis=1) & (norms > 1e-30)

    safe_norms = np.where(valid, norms, 1.0)
    ux = np.where(valid, flat[:, 0] / safe_norms, 0.0)
    uy = np.where(valid, flat[:, 1] / safe_norms, 1.0)
    uz = np.where(valid, flat[:, 2] / safe_norms, 0.0)

    quats = np.zeros((flat.shape[0], 4), dtype=np.float64)
    quats[:, 3] = 1.0

    anti = valid & (uy <= -1.0 + 1e-12)
    general = valid & ~anti & (uy < 1.0 - 1e-12)

    if np.any(anti):
        quats[anti] = (1.0, 0.0, 0.0, 0.0)

    if np.any(general):
        gx = uz[general]
        gz = -ux[general]
        gw = 1.0 + uy[general]
        q_norm = np.sqrt(gx * gx + gz * gz + gw * gw)
        quats[general, 0] = gx / q_norm
        quats[general, 1] = 0.0
        quats[general, 2] = gz / q_norm
        quats[general, 3] = gw / q_norm

    return quats.reshape(*lead_shape, 4), norms.reshape(lead_shape)


def enforce_quaternion_hemisphere_continuity(
    quats_xyzw: ArrayLike,
) -> NDArray[np.float64]:
    """Ensure ``dot(q[t], q[t - 1]) >= 0`` along axis 0 for smooth glTF slerp."""
    arr = np.asarray(quats_xyzw, dtype=np.float64).copy()
    if arr.ndim < 2 or arr.shape[-1] != 4:
        raise ValueError(f"expected shape (T, ..., 4), got {arr.shape}")
    for t in range(1, arr.shape[0]):
        dots = np.sum(arr[t] * arr[t - 1], axis=-1)
        flip = dots < 0.0
        if np.any(flip):
            arr[t, flip] = -arr[t, flip]
    return arr


def quaternions_to_rotation_matrices(quats_xyzw: ArrayLike) -> NDArray[np.float64]:
    """Convert ``(..., 4)`` XYZW quaternions into ``(..., 3, 3)`` rotation matrices."""
    q = np.asarray(quats_xyzw, dtype=np.float64)
    x = q[..., 0]
    y = q[..., 1]
    z = q[..., 2]
    w = q[..., 3]

    xx, yy, zz = x * x, y * y, z * z
    xy, xz, yz = x * y, x * z, y * z
    wx, wy, wz = w * x, w * y, w * z

    rot = np.empty((*q.shape[:-1], 3, 3), dtype=np.float64)
    rot[..., 0, 0] = 1.0 - 2.0 * (yy + zz)
    rot[..., 0, 1] = 2.0 * (xy - wz)
    rot[..., 0, 2] = 2.0 * (xz + wy)
    rot[..., 1, 0] = 2.0 * (xy + wz)
    rot[..., 1, 1] = 1.0 - 2.0 * (xx + zz)
    rot[..., 1, 2] = 2.0 * (yz - wx)
    rot[..., 2, 0] = 2.0 * (xz - wy)
    rot[..., 2, 1] = 2.0 * (yz + wx)
    rot[..., 2, 2] = 1.0 - 2.0 * (xx + yy)
    return rot


def build_merged_arrow_mesh(
    positions_m: ArrayLike,
    vectors: ArrayLike,
    colors_linear: ArrayLike,
    *,
    arrow_length_m: float,
    scale_by_magnitude: bool = False,
    max_magnitude: float | None = None,
    anchor: str = "center",
    radial_segments: int = 12,
) -> tuple[
    NDArray[np.float64],
    NDArray[np.float64],
    NDArray[np.float64],
    NDArray[np.uint32],
]:
    """Build a single merged triangle mesh for static 3D vector arrows with ``COLOR_0``."""
    sites = np.asarray(positions_m, dtype=np.float64)
    vecs = np.asarray(vectors, dtype=np.float64)
    cols = np.asarray(colors_linear, dtype=np.float64)
    if sites.ndim != 2 or sites.shape[1] != 3:
        raise ValueError(f"positions_m must have shape (M, 3), got {sites.shape}")
    if vecs.shape != sites.shape or cols.shape != sites.shape:
        raise ValueError("positions_m, vectors, and colors_linear must share shape (M, 3)")

    quats, norms = vectors_to_quaternions_xyzw(vecs)
    active = np.isfinite(norms) & (norms > 1e-30) & np.all(np.isfinite(sites), axis=1)
    if not np.any(active):
        return (
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0, 3), dtype=np.float64),
            np.zeros((0, 3), dtype=np.uint32),
        )

    sites_act = sites[active]
    quats_act = quats[active]
    norms_act = norms[active]
    cols_act = cols[active]

    if scale_by_magnitude:
        ref_max = (
            float(max_magnitude)
            if max_magnitude is not None and max_magnitude > 0.0
            else float(np.max(norms_act))
        )
        ref_max = max(ref_max, 1e-30)
        scales = float(arrow_length_m) * (norms_act / ref_max)
    else:
        scales = np.full(sites_act.shape[0], float(arrow_length_m), dtype=np.float64)

    unit = create_unit_arrow_mesh(radial_segments=radial_segments, anchor=anchor)
    rot_mats = quaternions_to_rotation_matrices(quats_act)  # (M, 3, 3)

    scaled_pos = unit.positions[np.newaxis, :, :] * scales[:, np.newaxis, np.newaxis]
    world_pos = (
        np.einsum("mij,mvj->mvi", rot_mats, scaled_pos)
        + sites_act[:, np.newaxis, :]
    )
    world_norm = np.einsum("mij,vj->mvi", rot_mats, unit.normals)
    world_cols = np.repeat(cols_act[:, np.newaxis, :], unit.positions.shape[0], axis=1)

    m_count = sites_act.shape[0]
    v_per_arrow = unit.positions.shape[0]
    offsets = (np.arange(m_count, dtype=np.uint32) * v_per_arrow)[:, np.newaxis, np.newaxis]
    merged_idx = (unit.indices[np.newaxis, :, :] + offsets).reshape(-1, 3)

    return (
        world_pos.reshape(-1, 3),
        world_norm.reshape(-1, 3),
        world_cols.reshape(-1, 3),
        merged_idx,
    )


def build_animated_arrow_tracks(
    positions_m: ArrayLike,
    vector_frames: ArrayLike,
    *,
    arrow_length_m: float,
    scale_by_magnitude: bool = False,
    max_magnitude: float | None = None,
) -> dict[str, NDArray[np.float64]]:
    """Build smooth TRS tracks for animated arrow sites over ``T`` keyframes.

    Returns dict with keys:
    - ``translations_m``: ``(T, M, 3)``
    - ``rotations_xyzw``: ``(T, M, 4)`` (hemisphere-continuous)
    - ``scales``: ``(T, M, 3)``
    """
    sites = np.asarray(positions_m, dtype=np.float64)
    frames = np.asarray(vector_frames, dtype=np.float64)
    if sites.ndim != 2 or sites.shape[1] != 3:
        raise ValueError(f"positions_m must have shape (M, 3), got {sites.shape}")
    if frames.ndim != 3 or frames.shape[1:] != sites.shape:
        raise ValueError(
            f"vector_frames must have shape (T, {sites.shape[0]}, 3), got {frames.shape}"
        )

    t_count, m_count, _ = frames.shape
    quats, norms = vectors_to_quaternions_xyzw(frames)
    quats = enforce_quaternion_hemisphere_continuity(quats)

    active = np.isfinite(norms) & (norms > 1e-30)
    if scale_by_magnitude:
        if max_magnitude is not None and max_magnitude > 0.0:
            ref_max = float(max_magnitude)
        else:
            ref_max = float(np.max(norms[active])) if np.any(active) else 1.0
        ref_max = max(ref_max, 1e-30)
        scalar_scale = np.where(active, float(arrow_length_m) * (norms / ref_max), 0.0)
    else:
        scalar_scale = np.where(active, float(arrow_length_m), 0.0)

    scales = np.repeat(scalar_scale[:, :, np.newaxis], 3, axis=2)
    translations = np.broadcast_to(sites[np.newaxis, :, :], (t_count, m_count, 3)).copy()

    return {
        "translations_m": translations,
        "rotations_xyzw": quats,
        "scales": scales,
    }
