"""Runtime initial magnetization sampler.

Bridges analytic PresetTexture descriptors to concrete sampled vectors.
Called by the Python runtime when a solver needs an explicit m0 array
(e.g. FDM cell-center initialization or pre-sampling for FEM nodes).

The Rust solver receives the analytic IR payload and may call back into
Python via this module, or this module is called directly from simulation.py
before handing off to the native backend.
"""

from __future__ import annotations

from typing import Sequence

import numpy as np


def _apply_inverse_transform(
    points: np.ndarray,
    transform: dict[str, object],
) -> np.ndarray:
    """Transform world-space points into texture-local space.

    Applies the inverse of:  T = translate ∘ rotate ∘ scale  (around pivot)

    Args:
        points: (N, 3) float64 array of sample points in world/object space.
        transform: IR dict with "translation", "rotation_quat", "scale", "pivot".

    Returns:
        (N, 3) float64 array in texture-local coordinates.
    """
    translation = np.array(transform.get("translation", [0.0, 0.0, 0.0]), dtype=np.float64)
    rotation_quat = np.array(transform.get("rotation_quat", [0.0, 0.0, 0.0, 1.0]), dtype=np.float64)
    scale = np.array(transform.get("scale", [1.0, 1.0, 1.0]), dtype=np.float64)
    pivot = np.array(transform.get("pivot", [0.0, 0.0, 0.0]), dtype=np.float64)

    qx, qy, qz, qw = rotation_quat

    # 1. Undo translation (relative to pivot)
    pts = points - translation - pivot

    # 2. Undo rotation (apply conjugate quaternion: negate xyz)
    inv_quat = np.array([-qx, -qy, -qz, qw], dtype=np.float64)
    norm = np.sqrt(np.dot(inv_quat, inv_quat))
    if norm > 1e-30:
        inv_quat /= norm
    pts = _rotate_points_by_quat(pts, inv_quat)

    # 3. Undo scale FIRST, then add pivot back
    #    Correct inverse: local = pivot + S^-1 * R^-1 * (world - translation - pivot)
    safe_scale = np.where(np.abs(scale) > 1e-30, scale, 1.0)
    pts = pts / safe_scale
    pts = pts + pivot

    return pts


def _rotate_points_by_quat(points: np.ndarray, q: np.ndarray) -> np.ndarray:
    """Rotate (N,3) points by unit quaternion q = (qx, qy, qz, qw)."""
    qx, qy, qz, qw = q
    # Rodrigues / quaternion sandwich product v' = q * v * q^-1
    # Efficient form: v' = v + 2*qw*(qxyz × v) + 2*(qxyz × (qxyz × v))
    qvec = np.array([qx, qy, qz], dtype=np.float64)
    t = 2.0 * np.cross(qvec, points)  # shape (N,3) or (3,)
    return points + qw * t + np.cross(qvec, t)


def _mapping_space(mapping_ir: dict[str, object]) -> str:
    raw = mapping_ir.get("space")
    return str(raw).strip().lower() if isinstance(raw, str) and raw.strip() else "object"


def _mapping_projection(mapping_ir: dict[str, object]) -> str:
    raw = mapping_ir.get("projection")
    return str(raw).strip().lower() if isinstance(raw, str) and raw.strip() else "object_local"


def _mapping_clamp_mode(mapping_ir: dict[str, object]) -> str:
    raw = mapping_ir.get("clamp_mode")
    return str(raw).strip().lower() if isinstance(raw, str) and raw.strip() else "clamp"


def _map_points_into_mapping_space(
    points: np.ndarray,
    *,
    space: str,
    object_transform: dict[str, object] | None,
) -> np.ndarray:
    if space == "object":
        return _apply_inverse_transform(points, object_transform if isinstance(object_transform, dict) else {})
    # "world" and unknown spaces are interpreted as world-space coordinates.
    return points


def _project_mapping_coordinates(points: np.ndarray, *, projection: str) -> np.ndarray:
    if points.size == 0:
        return points
    if projection == "planar_xy":
        return np.column_stack((points[:, 0], points[:, 1], np.zeros(points.shape[0], dtype=np.float64)))
    if projection == "planar_xz":
        return np.column_stack((points[:, 0], points[:, 2], np.zeros(points.shape[0], dtype=np.float64)))
    if projection == "planar_yz":
        return np.column_stack((points[:, 1], points[:, 2], np.zeros(points.shape[0], dtype=np.float64)))
    # "object_local" keeps full 3D Cartesian — this is the correct default.
    if projection in {"box", "triplanar", "cylindrical", "spherical"}:
        import warnings
        warnings.warn(
            f"Projection mode '{projection}' is not yet implemented; "
            "falling back to Cartesian (object_local) coordinates.",
            stacklevel=2,
        )
    return points


def _repeat_wrap(points: np.ndarray) -> np.ndarray:
    return np.mod(points + 0.5, 1.0) - 0.5


def _mirror_wrap(points: np.ndarray) -> np.ndarray:
    wrapped = np.mod(points + 0.5, 2.0)
    mirrored = np.where(wrapped <= 1.0, wrapped, 2.0 - wrapped)
    return mirrored - 0.5


def _apply_clamp_mode(points: np.ndarray, *, clamp_mode: str) -> np.ndarray:
    if clamp_mode in {"repeat", "wrap"}:
        return _repeat_wrap(points)
    if clamp_mode == "mirror":
        return _mirror_wrap(points)
    # "clamp" and unknown values fallback to hard clamp in local texture space.
    return np.clip(points, -0.5, 0.5)


def prepare_initial_magnetization(
    spec: dict[str, object],
    sample_points: Sequence[Sequence[float]] | np.ndarray,
    *,
    object_transform: dict[str, object] | None = None,
) -> np.ndarray:
    """Sample an initial magnetization spec at the given points.

    Supports all IR kinds:
    - ``"uniform"`` — fills every point with the same direction
    - ``"random"`` / ``"random_seeded"`` — deterministic pseudo-random per point
    - ``"sampled_field"`` — returns the stored values (no re-sampling)
    - ``"preset_texture"`` — evaluates analytic preset after applying the
      inverse texture transform

    Args:
        spec: IR dict with at minimum ``"kind"`` key.
        sample_points: (N, 3) array of sample coordinates. For FDM: cell
            centers. For FEM: node coords restricted to magnetic parts only.
        object_transform: Optional geometry transform of the owning object.
            Used when ``mapping.space == "object"``.

    Returns:
        (N, 3) float64 array of normalized magnetization vectors.
    """
    from fullmag.init.preset_eval import evaluate_preset_texture

    pts = np.asarray(sample_points, dtype=np.float64)
    if pts.ndim == 1:
        pts = pts.reshape(1, 3)
    n = pts.shape[0]

    kind = str(spec.get("kind", "uniform"))

    if kind == "uniform":
        direction = np.array(spec.get("value", [1.0, 0.0, 0.0]), dtype=np.float64)
        norm = np.linalg.norm(direction)
        if norm > 1e-30:
            direction /= norm
        return np.tile(direction, (n, 1))

    elif kind in {"random", "random_seeded"}:
        result = evaluate_preset_texture(
            "random",
            {"seed": int(spec.get("seed", 1))},
            pts.tolist(),
        )
        return np.array(result.values, dtype=np.float64)

    elif kind == "sampled_field":
        values = np.array(spec.get("values", []), dtype=np.float64)
        if values.shape[0] == 0:
            raise ValueError("sampled_field spec has no values")
        if values.shape[0] != n:
            raise ValueError(
                f"sampled_field has {values.shape[0]} values but {n} sample points were provided"
            )
        norms = np.linalg.norm(values, axis=1, keepdims=True)
        norms = np.where(norms > 1e-30, norms, 1.0)
        return values / norms

    elif kind == "preset_texture":
        transform_ir = spec.get("texture_transform", {})
        mapping_ir = spec.get("mapping", {})
        if not isinstance(mapping_ir, dict):
            mapping_ir = {}

        mapped_pts = _map_points_into_mapping_space(
            pts,
            space=_mapping_space(mapping_ir),
            object_transform=object_transform,
        )
        mapped_pts = _project_mapping_coordinates(
            mapped_pts,
            projection=_mapping_projection(mapping_ir),
        )

        # Apply inverse texture transform to get texture-local coordinates
        if isinstance(transform_ir, dict) and any(transform_ir.values()):
            local_pts = _apply_inverse_transform(mapped_pts, transform_ir)
        else:
            local_pts = mapped_pts

        # For analytic presets operating in metric space, skip unit-box clamping.
        # Clamp/repeat/mirror is only meaningful for image-based or normalized
        # texture mappings, not for preset evaluators using physical coordinates.
        preset_kind = str(spec["preset_kind"])
        _METRIC_ANALYTIC_PRESETS = frozenset({
            "vortex", "antivortex", "bloch_skyrmion", "neel_skyrmion", "domain_wall",
            "helical", "conical", "two_domain",
        })
        clamp_mode = _mapping_clamp_mode(mapping_ir)
        if clamp_mode != "none" and preset_kind not in _METRIC_ANALYTIC_PRESETS:
            local_pts = _apply_clamp_mode(local_pts, clamp_mode=clamp_mode)

        params = dict(spec.get("preset_params") or spec.get("params") or {})

        result = evaluate_preset_texture(preset_kind, params, local_pts.tolist())
        arr = np.array(result.values, dtype=np.float64)
        norms = np.linalg.norm(arr, axis=1, keepdims=True)
        norms = np.where(norms > 1e-30, norms, 1.0)
        return arr / norms

    else:
        raise ValueError(f"Unsupported initial_magnetization kind: {kind!r}")


def filter_fem_magnetic_points(
    all_points: np.ndarray,
    mesh_parts: list[dict[str, object]],
    object_name: str | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Return only nodes that belong to magnetic mesh parts.

    In shared-domain FEM the mesh includes air and interface parts.
    Textures must be sampled ONLY on magnetic nodes.

    Args:
        all_points: (M, 3) array of all mesh node coordinates.
        mesh_parts: list of mesh part dicts with ``"role"``, ``"node_start"``,
            ``"node_count"``, and optionally ``"object_name"``.
        object_name: if provided, restrict to the specific ferromagnet.

    Returns:
        A tuple ``(filtered_points, full_indices)`` where ``full_indices``
        are the original row indices into ``all_points``.
    """
    indices: list[int] = []
    for part in mesh_parts:
        role = str(part.get("role", ""))
        if role != "magnetic_object":
            continue
        if object_name is not None and part.get("object_name") != object_name:
            continue
        node_start = int(part.get("node_start", 0))
        node_count = int(part.get("node_count", 0))
        indices.extend(range(node_start, node_start + node_count))

    if not indices:
        return np.zeros((0, 3), dtype=np.float64), np.array([], dtype=np.intp)

    idx = np.array(indices, dtype=np.intp)
    return all_points[idx], idx
