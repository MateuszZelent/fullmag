from __future__ import annotations

import math
from pathlib import Path

from fullmag.model.geometry import (
    ArchWaveguide,
    CPWAntennaLayout,
    Box,
    Cone,
    Cylinder,
    Difference,
    Ellipse,
    Ellipsoid,
    ImportedGeometry,
    Intersection,
    MicrostripAntennaLayout,
    PolygonPrism,
    SinWaveguide,
    SlicePlane,
    Torus,
    Transform,
    Translate,
    Union,
    Xor,
    rotation_matrix_from_quaternion,
)

Vec3 = tuple[float, float, float]
BoundsPair = tuple[Vec3 | None, Vec3 | None]


def _optional_vec3(value: object) -> Vec3 | None:
    if isinstance(value, (list, tuple)) and len(value) == 3:
        try:
            return (float(value[0]), float(value[1]), float(value[2]))
        except (TypeError, ValueError):
            return None
    return None


def _normalize_bounds_pair(
    bounds_min: Vec3,
    bounds_max: Vec3,
) -> BoundsPair:
    normalized_min = tuple(min(bounds_min[i], bounds_max[i]) for i in range(3))
    normalized_max = tuple(max(bounds_min[i], bounds_max[i]) for i in range(3))
    if any(normalized_max[i] - normalized_min[i] <= 0 for i in range(3)):
        return None, None
    return normalized_min, normalized_max


def _combine_bounds_union(left: BoundsPair, right: BoundsPair) -> BoundsPair:
    left_min, left_max = left
    right_min, right_max = right
    if left_min is None or left_max is None:
        return right
    if right_min is None or right_max is None:
        return left
    return (
        tuple(min(left_min[i], right_min[i]) for i in range(3)),
        tuple(max(left_max[i], right_max[i]) for i in range(3)),
    )


def geometry_bounds(
    geometry: object,
    *,
    source_root: Path | None = None,
) -> BoundsPair:
    if isinstance(geometry, ImportedGeometry):
        from fullmag.meshing.surface_assets import load_surface_asset

        try:
            asset = load_surface_asset(geometry.source, source_root=source_root)
        except Exception:
            return None, None
        if asset.bounds_min is None or asset.bounds_max is None:
            return None, None
        if isinstance(geometry.scale, (int, float)):
            scale = (float(geometry.scale), float(geometry.scale), float(geometry.scale))
        else:
            scale = tuple(float(component) for component in geometry.scale)
        bounds_min = tuple(asset.bounds_min[i] * scale[i] for i in range(3))
        bounds_max = tuple(asset.bounds_max[i] * scale[i] for i in range(3))
        return _normalize_bounds_pair(bounds_min, bounds_max)
    if isinstance(geometry, (MicrostripAntennaLayout, CPWAntennaLayout)):
        return geometry.world_bounds()
    if isinstance(geometry, Box):
        sx, sy, sz = geometry.size
        return (-0.5 * sx, -0.5 * sy, -0.5 * sz), (0.5 * sx, 0.5 * sy, 0.5 * sz)
    if isinstance(geometry, Cylinder):
        radius = geometry.radius
        half_height = 0.5 * geometry.height
        extents = tuple(
            radius * math.sqrt(max(0.0, 1.0 - component * component))
            + half_height * abs(component)
            for component in geometry.axis
        )
        return tuple(-value for value in extents), extents
    if isinstance(geometry, SinWaveguide):
        half_length = 0.5 * geometry.length
        half_width = 0.5 * geometry.width
        half_height = 0.5 * geometry.height
        z_margin = abs(geometry.amplitude) + half_height
        return (
            -half_length,
            -half_width,
            geometry.z0 - z_margin,
        ), (
            half_length,
            half_width,
            geometry.z0 + z_margin,
        )
    if isinstance(geometry, ArchWaveguide):
        half_length = 0.5 * geometry.length
        half_width = 0.5 * geometry.width
        half_height = 0.5 * geometry.height
        z_min = min(geometry.z0, geometry.z0 + geometry.arch_height) - half_height
        z_max = max(geometry.z0, geometry.z0 + geometry.arch_height) + half_height
        return (-half_length, -half_width, z_min), (half_length, half_width, z_max)
    if isinstance(geometry, Ellipsoid):
        return (-geometry.rx, -geometry.ry, -geometry.rz), (
            geometry.rx,
            geometry.ry,
            geometry.rz,
        )
    if isinstance(geometry, Ellipse):
        half_height = 0.5 * geometry.height
        return (-geometry.rx, -geometry.ry, -half_height), (
            geometry.rx,
            geometry.ry,
            half_height,
        )
    if isinstance(geometry, Cone):
        half_height = 0.5 * geometry.height
        ax, ay, az = geometry.axis
        mins = []
        maxs = []
        for comp in (ax, ay, az):
            perp = math.sqrt(max(0.0, 1.0 - comp * comp))
            c_bot = -half_height * comp
            c_top = half_height * comp
            mins.append(min(c_bot - geometry.radius_bottom * perp, c_top - geometry.radius_top * perp))
            maxs.append(max(c_bot + geometry.radius_bottom * perp, c_top + geometry.radius_top * perp))
        return tuple(mins), tuple(maxs)
    if isinstance(geometry, Torus):
        extents = tuple(
            geometry.major_radius * math.sqrt(max(0.0, 1.0 - component * component))
            + geometry.minor_radius
            for component in geometry.axis
        )
        return tuple(-value for value in extents), extents
    if isinstance(geometry, PolygonPrism):
        xs = [pt[0] for pt in geometry.vertices_xy]
        ys = [pt[1] for pt in geometry.vertices_xy]
        half_t = 0.5 * geometry.thickness
        return (min(xs), min(ys), -half_t), (max(xs), max(ys), half_t)
    if isinstance(geometry, Translate):
        bounds_min, bounds_max = geometry_bounds(geometry.geometry, source_root=source_root)
        if bounds_min is None or bounds_max is None:
            return None, None
        return (
            tuple(bounds_min[i] + geometry.offset[i] for i in range(3)),
            tuple(bounds_max[i] + geometry.offset[i] for i in range(3)),
        )
    if isinstance(geometry, Transform):
        child_min, child_max = geometry_bounds(geometry.child, source_root=source_root)
        if child_min is None or child_max is None:
            return None, None
        rot = rotation_matrix_from_quaternion(geometry.rotation_quat)
        tx, ty, tz = geometry.translation
        sx, sy, sz = geometry.scale
        px, py, pz = geometry.pivot
        transformed: list[tuple[float, float, float]] = []
        for x in (child_min[0], child_max[0]):
            for y in (child_min[1], child_max[1]):
                for z in (child_min[2], child_max[2]):
                    lx = (x - px) * sx
                    ly = (y - py) * sy
                    lz = (z - pz) * sz
                    wx = rot[0][0] * lx + rot[0][1] * ly + rot[0][2] * lz + px + tx
                    wy = rot[1][0] * lx + rot[1][1] * ly + rot[1][2] * lz + py + ty
                    wz = rot[2][0] * lx + rot[2][1] * ly + rot[2][2] * lz + pz + tz
                    transformed.append((wx, wy, wz))
        return (
            tuple(min(pt[i] for pt in transformed) for i in range(3)),
            tuple(max(pt[i] for pt in transformed) for i in range(3)),
        )
    if isinstance(geometry, SlicePlane):
        child_min, child_max = geometry_bounds(geometry.child, source_root=source_root)
        if child_min is None or child_max is None:
            return None, None
        ox, oy, oz = geometry.plane_origin
        nx, ny, nz = geometry.plane_normal
        sign = 1.0 if geometry.keep_side == "positive" else -1.0
        corners = [
            (x, y, z)
            for x in (child_min[0], child_max[0])
            for y in (child_min[1], child_max[1])
            for z in (child_min[2], child_max[2])
        ]
        signed = [
            sign * ((pt[0] - ox) * nx + (pt[1] - oy) * ny + (pt[2] - oz) * nz)
            for pt in corners
        ]
        kept: list[tuple[float, float, float]] = [
            pt for pt, d in zip(corners, signed) if d >= -1e-18
        ]
        # Edges of the 8-corner cube differ in exactly 1 bit
        for i in range(8):
            for bit in (1, 2, 4):
                j = i ^ bit
                if j > i:
                    di, dj = signed[i], signed[j]
                    if (di < 0.0 < dj) or (dj < 0.0 < di):
                        t = di / (di - dj)
                        pi, pj = corners[i], corners[j]
                        kept.append(
                            (
                                pi[0] + t * (pj[0] - pi[0]),
                                pi[1] + t * (pj[1] - pi[1]),
                                pi[2] + t * (pj[2] - pi[2]),
                            )
                        )
        if not kept:
            return None, None
        return _normalize_bounds_pair(
            tuple(min(pt[i] for pt in kept) for i in range(3)),
            tuple(max(pt[i] for pt in kept) for i in range(3)),
        )
    if isinstance(geometry, Union):
        return _combine_bounds_union(
            geometry_bounds(geometry.a, source_root=source_root),
            geometry_bounds(geometry.b, source_root=source_root),
        )
    if isinstance(geometry, Xor):
        return _combine_bounds_union(
            geometry_bounds(geometry.left, source_root=source_root),
            geometry_bounds(geometry.right, source_root=source_root),
        )
    if isinstance(geometry, Intersection):
        a_min, a_max = geometry_bounds(geometry.a, source_root=source_root)
        b_min, b_max = geometry_bounds(geometry.b, source_root=source_root)
        if a_min is None or a_max is None or b_min is None or b_max is None:
            return None, None
        return _normalize_bounds_pair(
            tuple(max(a_min[i], b_min[i]) for i in range(3)),
            tuple(min(a_max[i], b_max[i]) for i in range(3)),
        )
    if isinstance(geometry, Difference):
        return geometry_bounds(geometry.base, source_root=source_root)
    return None, None


def object_union_bounds(
    geometries: list[object],
    *,
    source_root: Path | None = None,
) -> BoundsPair:
    bounds_min: Vec3 | None = None
    bounds_max: Vec3 | None = None
    for geometry in geometries:
        current_min, current_max = geometry_bounds(geometry, source_root=source_root)
        bounds_min, bounds_max = _combine_bounds_union(
            (bounds_min, bounds_max),
            (current_min, current_max),
        )
    return bounds_min, bounds_max


def _bounds_extent(bounds_min: Vec3, bounds_max: Vec3) -> Vec3:
    return tuple(bounds_max[i] - bounds_min[i] for i in range(3))


def _bounds_center(bounds_min: Vec3, bounds_max: Vec3) -> Vec3:
    return tuple(0.5 * (bounds_min[i] + bounds_max[i]) for i in range(3))


def build_domain_frame(
    *,
    geometries: list[object],
    source_root: str | Path | None,
    study_universe: dict[str, object] | None,
) -> dict[str, object] | None:
    root_path = Path(source_root) if source_root is not None else None
    object_bounds_min, object_bounds_max = object_union_bounds(
        geometries,
        source_root=root_path,
    )
    declared_universe: dict[str, object] | None = None
    effective_extent: Vec3 | None = None
    effective_center: Vec3 | None = None
    effective_source: str | None = None

    if study_universe:
        declared_mode = study_universe.get("mode")
        declared_size = _optional_vec3(study_universe.get("size"))
        declared_center = _optional_vec3(study_universe.get("center"))
        declared_padding = _optional_vec3(study_universe.get("padding"))
        declared_airbox_hmax = study_universe.get("airbox_hmax")
        declared_airbox_hmin = study_universe.get("airbox_hmin")
        declared_airbox_growth_rate = study_universe.get("airbox_growth_rate")
        declared_airbox_grading = study_universe.get("airbox_grading")
        declared_universe = {
            "mode": str(declared_mode) if isinstance(declared_mode, str) else "auto",
            "size": list(declared_size) if declared_size is not None else None,
            "center": list(declared_center) if declared_center is not None else None,
            "padding": list(declared_padding) if declared_padding is not None else None,
            "airbox_hmax": (
                float(declared_airbox_hmax)
                if isinstance(declared_airbox_hmax, (int, float))
                else None
            ),
            "airbox_hmin": (
                float(declared_airbox_hmin)
                if isinstance(declared_airbox_hmin, (int, float))
                else None
            ),
            "airbox_growth_rate": (
                float(declared_airbox_growth_rate)
                if isinstance(declared_airbox_growth_rate, (int, float))
                else None
            ),
            "airbox_grading": (
                str(declared_airbox_grading)
                if isinstance(declared_airbox_grading, str) and declared_airbox_grading.strip()
                else None
            ),
        }
        # Note 0107 air feature controls: copied only when authored.
        for key in ("airbox_curvature_factor", "airbox_narrow_region_resolution"):
            value = study_universe.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                declared_universe[key] = float(value)
        if declared_universe["mode"] == "manual" and declared_size is not None:
            effective_extent = declared_size
            effective_center = (
                declared_center
                or (
                    _bounds_center(object_bounds_min, object_bounds_max)
                    if object_bounds_min is not None and object_bounds_max is not None
                    else None
                )
            )
            effective_source = "declared_universe_manual"
        elif object_bounds_min is not None and object_bounds_max is not None:
            object_extent = _bounds_extent(object_bounds_min, object_bounds_max)
            object_center = _bounds_center(object_bounds_min, object_bounds_max)
            padding = declared_padding or (0.0, 0.0, 0.0)
            if any(abs(component) > 0.0 for component in padding):
                effective_extent = tuple(
                    object_extent[i] + 2.0 * padding[i] for i in range(3)
                )
                effective_source = "declared_universe_auto_padding"
            else:
                effective_extent = object_extent
                effective_source = "object_union_bounds"
            effective_center = object_center

    if (
        effective_extent is None
        and object_bounds_min is not None
        and object_bounds_max is not None
    ):
        effective_extent = _bounds_extent(object_bounds_min, object_bounds_max)
        effective_center = _bounds_center(object_bounds_min, object_bounds_max)
        effective_source = "object_union_bounds"

    if (
        declared_universe is None
        and object_bounds_min is None
        and object_bounds_max is None
        and effective_extent is None
    ):
        return None

    return {
        "declared_universe": declared_universe,
        "object_bounds_min": list(object_bounds_min) if object_bounds_min is not None else None,
        "object_bounds_max": list(object_bounds_max) if object_bounds_max is not None else None,
        "mesh_bounds_min": None,
        "mesh_bounds_max": None,
        "effective_extent": list(effective_extent) if effective_extent is not None else None,
        "effective_center": list(effective_center) if effective_center is not None else None,
        "effective_source": effective_source,
    }
