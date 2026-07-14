from __future__ import annotations

import itertools
import math
import warnings
from pathlib import Path
from typing import Any

import numpy as np

from fullmag._progress import emit_progress
from ._airbox_grading import (
    _add_airbox_grading_field,
    _airbox_boundary_distance_from_bbox,
)
from fullmag.model.geometry import (
    ArchWaveguide,
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
from ._gmsh_waveguides import add_arch_waveguide_to_occ

from ._gmsh_types import AirboxOptions, MeshData, MeshOptions, MeshQualityReport
from ._gmsh_infra import _import_gmsh, _configure_gmsh_threads, _GmshProgressLogger
from ._gmsh_extraction import _extract_quality_metrics


def _radius_from_center_to_bbox_corner(
    center: tuple[float, float, float],
    bounds_min: tuple[float, float, float],
    bounds_max: tuple[float, float, float],
) -> float:
    return max(
        math.dist(center, corner)
        for corner in itertools.product(
            [float(bounds_min[0]), float(bounds_max[0])],
            [float(bounds_min[1]), float(bounds_max[1])],
            [float(bounds_min[2]), float(bounds_max[2])],
        )
    )


def _entity_bounds(
    gmsh: Any,
    dimtags: list[tuple[int, int]],
) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    bounds: list[tuple[float, float, float, float, float, float]] = []
    for dim, tag in dimtags:
        try:
            raw = gmsh.model.getBoundingBox(int(dim), int(tag))
        except Exception:
            continue
        if len(raw) == 6:
            bounds.append(tuple(float(value) for value in raw))  # type: ignore[arg-type]
    if not bounds:
        return None

    return (
        (
            min(bound[0] for bound in bounds),
            min(bound[1] for bound in bounds),
            min(bound[2] for bound in bounds),
        ),
        (
            max(bound[3] for bound in bounds),
            max(bound[4] for bound in bounds),
            max(bound[5] for bound in bounds),
        ),
    )


def _component_interface_size_targets(options: MeshOptions | None) -> dict[str, float]:
    if options is None:
        return {}
    targets: dict[str, float] = {}
    for field in options.size_fields:
        if not isinstance(field, dict):
            continue
        kind = field.get("kind")
        params = field.get("params", {})
        if not isinstance(params, dict):
            continue
        geometry_name = params.get("GeometryName")
        if not isinstance(geometry_name, str) or not geometry_name.strip():
            continue
        value = None
        if kind in {"SurfaceDistanceThreshold", "InterfaceShellThreshold"}:
            value = params.get("SizeMin")
        if not isinstance(value, (int, float)) or value <= 0.0:
            continue
        previous = targets.get(geometry_name)
        targets[geometry_name] = (
            float(value) if previous is None else min(previous, float(value))
        )
    return targets


def _add_airbox_geo(
    gmsh: Any,
    body_vol_tags: list[int],
    body_surf_tags: list[int],
    airbox: AirboxOptions,
    hmax: float,
    *,
    component_volume_groups: dict[str, list[int]] | None = None,
    component_surface_groups: dict[str, list[int]] | None = None,
    mesh_options: MeshOptions | None = None,
) -> int | None:
    """Add an airbox around a GEO-kernel body using pure GEO primitives.

    This is the GEO-kernel equivalent of :func:`_add_airbox_and_fragment`.
    It is required for STL-imported bodies whose entities live in the GEO
    kernel and are invisible to OCC boolean operations.

    The airbox volume is defined as the box (or sphere-approximation)
    bounded externally by six planar faces and internally by the body
    surface.  The body surface loop is reused as a *hole* in the airbox
    shell, producing a conforming interface without OCC ``fragment``.

    After return the model has physical groups:
      - volume physical groups 1..N = magnetic bodies,
      - volume physical group N+1 = air,
      - surface physical group ``airbox.boundary_marker`` = Γ_out,
      - surface physical group 10 = magnetic–air interface.
    """
    # 1 — bounding box of magnetic body
    xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
    dx, dy, dz = xmax - xmin, ymax - ymin, zmax - zmin
    cx, cy, cz = (xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2
    pf = airbox.padding_factor

    # 2 — compute outer box dimensions
    explicit_size = airbox.size
    explicit_center = airbox.center
    if explicit_size is not None:
        ox, oy, oz = explicit_size
        if min(ox, oy, oz) <= 0.0:
            raise ValueError("airbox.size components must be positive")
        if explicit_center is not None:
            cx, cy, cz = explicit_center
    elif airbox.shape == "sphere":
        # Approximate sphere with bounding box for the GEO path
        emit_progress("Gmsh: spherical airbox requested on GEO path; approximating with bbox airbox")
        R = max(dx, dy, dz) / 2 * pf
        ox = oy = oz = 2.0 * R
    else:  # bbox
        ox, oy, oz = dx * pf, dy * pf, dz * pf

    x0, y0, z0 = cx - ox / 2, cy - oy / 2, cz - oz / 2
    x1, y1, z1 = cx + ox / 2, cy + oy / 2, cz + oz / 2
    h_outer = (
        airbox.maximum_element_size
        if airbox.maximum_element_size is not None
        else hmax * max(airbox.grading_ratio ** 4, 1.0)
    )

    # 3 — build box geometry using GEO points/lines/surfaces
    p = []
    for z in [z0, z1]:
        for y in [y0, y1]:
            for x in [x0, x1]:
                p.append(gmsh.model.geo.addPoint(x, y, z, h_outer))
    # p[0..7]: bottom-face (z0) then top-face (z1), each in order (x0y0, x1y0, x0y1, x1y1)

    # Bottom face edges
    lb = [
        gmsh.model.geo.addLine(p[0], p[1]),
        gmsh.model.geo.addLine(p[1], p[3]),
        gmsh.model.geo.addLine(p[3], p[2]),
        gmsh.model.geo.addLine(p[2], p[0]),
    ]
    # Top face edges
    lt = [
        gmsh.model.geo.addLine(p[4], p[5]),
        gmsh.model.geo.addLine(p[5], p[7]),
        gmsh.model.geo.addLine(p[7], p[6]),
        gmsh.model.geo.addLine(p[6], p[4]),
    ]
    # Vertical edges
    lv = [
        gmsh.model.geo.addLine(p[0], p[4]),
        gmsh.model.geo.addLine(p[1], p[5]),
        gmsh.model.geo.addLine(p[2], p[6]),
        gmsh.model.geo.addLine(p[3], p[7]),
    ]

    # 6 planar faces
    cl_bot = gmsh.model.geo.addCurveLoop([lb[0], lb[1], lb[2], lb[3]])
    cl_top = gmsh.model.geo.addCurveLoop([lt[0], lt[1], lt[2], lt[3]])
    cl_front = gmsh.model.geo.addCurveLoop([lb[0], lv[1], -lt[0], -lv[0]])
    cl_back = gmsh.model.geo.addCurveLoop([lb[2], lv[2], -lt[2], -lv[3]])
    cl_left = gmsh.model.geo.addCurveLoop([lb[3], lv[0], -lt[3], -lv[2]])
    cl_right = gmsh.model.geo.addCurveLoop([lb[1], lv[3], -lt[1], -lv[1]])

    s_bot = gmsh.model.geo.addPlaneSurface([cl_bot])
    s_top = gmsh.model.geo.addPlaneSurface([cl_top])
    s_front = gmsh.model.geo.addPlaneSurface([cl_front])
    s_back = gmsh.model.geo.addPlaneSurface([cl_back])
    s_left = gmsh.model.geo.addPlaneSurface([cl_left])
    s_right = gmsh.model.geo.addPlaneSurface([cl_right])
    outer_surf_tags = [s_bot, s_top, s_front, s_back, s_left, s_right]

    # 4 — airbox volume: outer box faces + body surfaces as inner holes.
    # When multiple disconnected bodies are present each body needs its own
    # surface loop (Gmsh requires each hole to be a separate shell); passing
    # all body surfaces in a single surface loop is only valid for one body.
    outer_sl = gmsh.model.geo.addSurfaceLoop(outer_surf_tags)
    if component_surface_groups is not None and len(component_surface_groups) > 1:
        body_sls = [
            gmsh.model.geo.addSurfaceLoop(list(surfs))
            for surfs in component_surface_groups.values()
            if surfs
        ]
        air_vol = gmsh.model.geo.addVolume([outer_sl] + body_sls)
    else:
        # Single body (or no grouping info): classic combined surface loop hole
        hole_sl = gmsh.model.geo.addSurfaceLoop(body_surf_tags)
        air_vol = gmsh.model.geo.addVolume([outer_sl, hole_sl])
    gmsh.model.geo.synchronize()

    # 5 — physical groups (same convention as the OCC path)
    if component_volume_groups:
        for index, (geometry_name, volume_tags) in enumerate(component_volume_groups.items(), start=1):
            gmsh.model.addPhysicalGroup(3, list(volume_tags), tag=index)
            gmsh.model.setPhysicalName(3, index, geometry_name)
        air_tag = len(component_volume_groups) + 1
    else:
        for index, body_vol_tag in enumerate(body_vol_tags, start=1):
            gmsh.model.addPhysicalGroup(3, [body_vol_tag], tag=index)
            gmsh.model.setPhysicalName(3, index, f"magnetic_{index}")
        air_tag = len(body_vol_tags) + 1
    gmsh.model.addPhysicalGroup(3, [air_vol], tag=air_tag)
    gmsh.model.setPhysicalName(3, air_tag, "air")
    gmsh.model.addPhysicalGroup(2, outer_surf_tags, tag=airbox.boundary_marker)
    gmsh.model.setPhysicalName(2, airbox.boundary_marker, "Gamma_out")
    gmsh.model.addPhysicalGroup(2, body_surf_tags, tag=10)
    gmsh.model.setPhysicalName(2, 10, "mag_air_interface")

    # 6 — mesh grading: fine at interface, coarse at outer boundary
    if airbox.grading_ratio > 1.0:
        default_h_inner = (
            airbox.minimum_element_size
            if airbox.minimum_element_size is not None
            else hmax
        )
        global_d_outer = _airbox_boundary_distance_from_bbox(
            object_bounds_min=(xmin, ymin, zmin),
            object_bounds_max=(xmax, ymax, zmax),
            airbox_bounds_min=(x0, y0, z0),
            airbox_bounds_max=(x1, y1, z1),
        )
        field_ids: list[int] = []
        covered_surfaces: set[int] = set()
        component_size_targets = _component_interface_size_targets(mesh_options)
        if component_surface_groups:
            for geometry_name, surface_tags in component_surface_groups.items():
                if not surface_tags:
                    continue
                covered_surfaces.update(int(tag) for tag in surface_tags)
                target = component_size_targets.get(geometry_name)
                h_inner = (
                    default_h_inner
                    if target is None
                    else min(default_h_inner, float(target))
                )
                component_bounds = None
                if component_volume_groups is not None:
                    component_bounds = _entity_bounds(
                        gmsh,
                        [(3, tag) for tag in component_volume_groups.get(geometry_name, [])],
                    )
                bounds_min, bounds_max = component_bounds or (
                    (xmin, ymin, zmin),
                    (xmax, ymax, zmax),
                )
                d_outer = _airbox_boundary_distance_from_bbox(
                    object_bounds_min=bounds_min,
                    object_bounds_max=bounds_max,
                    airbox_bounds_min=(x0, y0, z0),
                    airbox_bounds_max=(x1, y1, z1),
                )
                field_id = _add_airbox_grading_field(
                    gmsh,
                    surface_tags=surface_tags,
                    h_inner=h_inner,
                    h_outer=h_outer,
                    grading_ratio=airbox.grading_ratio,
                    grading_mode=airbox.grading_mode,
                    dist_max=max(d_outer, hmax, default_h_inner, h_inner),
                    object_bounds_min=bounds_min,
                    object_bounds_max=bounds_max,
                    airbox_bounds_min=(x0, y0, z0),
                    airbox_bounds_max=(x1, y1, z1),
                    airbox_shape="bbox",
                )
                if field_id is not None:
                    field_ids.append(field_id)

        remaining_surfaces = [
            tag for tag in body_surf_tags if int(tag) not in covered_surfaces
        ]
        if remaining_surfaces or not field_ids:
            field_id = _add_airbox_grading_field(
                gmsh,
                surface_tags=remaining_surfaces or body_surf_tags,
                h_inner=default_h_inner,
                h_outer=h_outer,
                grading_ratio=airbox.grading_ratio,
                grading_mode=airbox.grading_mode,
                dist_max=max(global_d_outer, hmax, default_h_inner),
                object_bounds_min=(xmin, ymin, zmin),
                object_bounds_max=(xmax, ymax, zmax),
                airbox_bounds_min=(x0, y0, z0),
                airbox_bounds_max=(x1, y1, z1),
                airbox_shape="bbox",
            )
            if field_id is not None:
                field_ids.append(field_id)
        if not field_ids:
            return None
        if len(field_ids) == 1:
            return field_ids[0]
        combined = gmsh.model.mesh.field.add("Min")
        gmsh.model.mesh.field.setNumbers(combined, "FieldsList", field_ids)
        return combined
    return None


def _add_airbox_and_fragment(
    gmsh: Any,
    magnetic_tags: list[tuple[int, int]],
    airbox: AirboxOptions,
    hmax: float,
) -> int | None:
    """Add an airbox around the magnetic body and fragment for a conforming mesh.

    After this call the Gmsh model has physical groups:
      - volume tag 1 = magnetic, volume tag 2 = air,
      - surface tag ``airbox.boundary_marker`` = Γ_out,
      - surface tag 10 = magnetic–air interface.

    A graded ``Threshold`` size field is set so that element size equals
    ``hmax`` at the interface and grows by ``grading_ratio`` toward the outer
    boundary.

    .. note::

       This function requires all *magnetic_tags* to be OCC entities.
       For GEO-kernel bodies (e.g. STL imports), use :func:`_add_airbox_geo`
       instead.
    """
    # 1 — bounding box of magnetic body
    xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
    dx, dy, dz = xmax - xmin, ymax - ymin, zmax - zmin
    cx, cy, cz = (xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2
    pf = airbox.padding_factor

    # 2 — outer shell geometry
    explicit_size = airbox.size
    explicit_center = airbox.center
    airbox_radius: float | None = None
    if explicit_size is not None:
        ox, oy, oz = explicit_size
        if min(ox, oy, oz) <= 0.0:
            raise ValueError("airbox.size components must be positive")
        if explicit_center is not None:
            cx, cy, cz = explicit_center
        if airbox.shape == "sphere":
            radius = max(ox, oy, oz) / 2.0
            airbox_radius = float(radius)
            outer_tag = gmsh.model.occ.addSphere(cx, cy, cz, radius)
        else:  # bbox
            outer_tag = gmsh.model.occ.addBox(
                cx - ox / 2, cy - oy / 2, cz - oz / 2, ox, oy, oz,
            )
    elif airbox.shape == "sphere":
        R = max(dx, dy, dz) / 2 * pf
        airbox_radius = float(R)
        outer_tag = gmsh.model.occ.addSphere(cx, cy, cz, R)
        ox = oy = oz = 2.0 * R
    else:  # bbox
        ox, oy, oz = dx * pf, dy * pf, dz * pf
        outer_tag = gmsh.model.occ.addBox(
            cx - ox / 2, cy - oy / 2, cz - oz / 2, ox, oy, oz,
        )
    outer_dimtags = [(3, outer_tag)]

    # 3 — OCC fragment: conforming interface between magnetic body and airbox
    result, result_map = gmsh.model.occ.fragment(outer_dimtags, magnetic_tags)
    gmsh.model.occ.synchronize()

    if not result_map:
        raise RuntimeError(
            "OCC fragment returned an empty result_map — the magnetic body "
            "entities are likely not in the OCC kernel.  If the geometry was "
            "built from an STL file via the GEO kernel (classifySurfaces / "
            "createGeometry / geo.addVolume), use _add_airbox_geo() instead."
        )

    # 4 — identify magnetic vs air volumes via result_map
    #     result_map[0]  → children of outer_dimtags  (air + overlap)
    #     result_map[1:] → children of magnetic_tags  (the magnetic region)
    magnetic_vol_tags: list[int] = []
    for parent_idx in range(1, len(result_map)):
        for dim, tag in result_map[parent_idx]:
            if dim == 3 and tag not in magnetic_vol_tags:
                magnetic_vol_tags.append(tag)
    air_vol_tags: list[int] = []
    for dim, tag in result_map[0]:
        if dim == 3 and tag not in magnetic_vol_tags:
            air_vol_tags.append(tag)

    if not magnetic_vol_tags:
        raise RuntimeError(
            "airbox fragment produced no magnetic volumes — check geometry"
        )
    if not air_vol_tags:
        raise RuntimeError(
            "airbox fragment produced no air volumes — padding_factor too small?"
        )

    # 5 — physical groups → element_markers
    gmsh.model.addPhysicalGroup(3, magnetic_vol_tags, tag=1)
    gmsh.model.setPhysicalName(3, 1, "magnetic")
    gmsh.model.addPhysicalGroup(3, air_vol_tags, tag=2)
    gmsh.model.setPhysicalName(3, 2, "air")

    # 6 — boundary tags
    #     outer surfaces of air that are NOT the mag–air interface → Γ_out
    air_boundary = gmsh.model.getBoundary(
        [(3, t) for t in air_vol_tags], oriented=False,
    )
    mag_boundary = gmsh.model.getBoundary(
        [(3, t) for t in magnetic_vol_tags], oriented=False,
    )
    interface_tags = {abs(tag) for _, tag in mag_boundary}
    gamma_out = sorted({abs(tag) for _, tag in air_boundary} - interface_tags)
    interface_list = sorted(interface_tags)

    if gamma_out:
        gmsh.model.addPhysicalGroup(2, gamma_out, tag=airbox.boundary_marker)
        gmsh.model.setPhysicalName(2, airbox.boundary_marker, "Gamma_out")
    if interface_list:
        gmsh.model.addPhysicalGroup(2, interface_list, tag=10)
        gmsh.model.setPhysicalName(2, 10, "mag_air_interface")

    # 7 — mesh grading: fine at interface, coarse at outer boundary
    if airbox.grading_ratio > 1.0:
        h_outer = (
            airbox.maximum_element_size
            if airbox.maximum_element_size is not None
            else hmax * airbox.grading_ratio ** 4
        )
        h_inner = (
            airbox.minimum_element_size
            if airbox.minimum_element_size is not None
            else hmax
        )
        d_outer = _airbox_boundary_distance_from_bbox(
            object_bounds_min=(xmin, ymin, zmin),
            object_bounds_max=(xmax, ymax, zmax),
            airbox_bounds_min=(cx - ox / 2, cy - oy / 2, cz - oz / 2),
            airbox_bounds_max=(cx + ox / 2, cy + oy / 2, cz + oz / 2),
        )
        return _add_airbox_grading_field(
            gmsh,
            surface_tags=interface_list,
            h_inner=h_inner,
            h_outer=h_outer,
            grading_ratio=airbox.grading_ratio,
            grading_mode=airbox.grading_mode,
            dist_max=max(d_outer, hmax),
            object_bounds_min=(xmin, ymin, zmin),
            object_bounds_max=(xmax, ymax, zmax),
            airbox_bounds_min=(cx - ox / 2, cy - oy / 2, cz - oz / 2),
            airbox_bounds_max=(cx + ox / 2, cy + oy / 2, cz + oz / 2),
            airbox_shape=airbox.shape,
            airbox_center=(cx, cy, cz),
            object_radius=(
                _radius_from_center_to_bbox_corner(
                    (cx, cy, cz),
                    (xmin, ymin, zmin),
                    (xmax, ymax, zmax),
                )
                if airbox.shape == "sphere"
                else None
            ),
            airbox_radius=airbox_radius,
        )
    return None




def add_air_box(
    geometry: Geometry,
    hmax: float | None = None,
    factor: float = 3.0,
    grading: float = 0.3,
    order: int = 1,
    boundary_marker: int = 99,
    options: MeshOptions | None = None,
    maximum_element_size: float | None = None,
) -> MeshData:
    """Generate a tetrahedral mesh with an air-box surrounding the magnetic region.

    The magnetic volume gets ``element_marker=1``, the air region gets
    ``element_marker=0``.  Boundary faces on the outer air-box surface get
    ``boundary_marker`` (default 99) for Dirichlet/Robin BC application.

    The air-box extends ``factor`` times the magnetic bounding box in each
    direction (centered on the magnet centroid).  ``grading`` controls how
    much the mesh coarsens between the magnet surface and the outer boundary
    (0 = uniform, 1 = maximum grading).

    Args:
        geometry: Magnetic body geometry (Box, Cylinder, Sphere, etc.).
        maximum_element_size: Maximum element size on the magnetic body
            (SI metres). ``hmax`` is accepted as a compatibility alias.
        factor: Air-box size as a multiple of the magnetic bounding-box diagonal.
        grading: Mesh grading factor (0–1).  Higher = coarser air far from magnet.
        order: FE order (1 = linear P1, 2 = quadratic P2).
        boundary_marker: Marker assigned to outer air-box boundary faces.
        options: Advanced Gmsh meshing options.

    Returns:
        MeshData with both magnetic (marker=1) and air (marker=0) elements.
    """
    warnings.warn(
        "add_air_box() is deprecated; use FEM shared-domain meshing with "
        "AirboxOptions/universe mesh configuration instead.",
        DeprecationWarning,
        stacklevel=2,
    )
    if factor < 1.5:
        raise ValueError(f"air_box factor must be >= 1.5, got {factor}")
    if not 0.0 <= grading <= 1.0:
        raise ValueError(f"grading must be in [0, 1], got {grading}")
    resolved_hmax = maximum_element_size if maximum_element_size is not None else hmax
    if resolved_hmax is None:
        raise TypeError("add_air_box() requires maximum_element_size")
    hmax = float(resolved_hmax)

    opts = options or MeshOptions()
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_airbox")

        # ── Create magnetic volume via Gmsh OCC ──
        magnetic_tags = _create_occ_geometry(gmsh, geometry)
        if not magnetic_tags:
            raise RuntimeError("air-box generation failed: geometry produced no OCC volumes")
        gmsh.model.occ.synchronize()

        # Get bounding box of magnetic volume
        mins = np.array([math.inf, math.inf, math.inf], dtype=np.float64)
        maxs = np.array([-math.inf, -math.inf, -math.inf], dtype=np.float64)
        for dim, tag in magnetic_tags:
            if dim != 3:
                continue
            xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.occ.getBoundingBox(dim, tag)
            mins = np.minimum(mins, np.array([xmin, ymin, zmin], dtype=np.float64))
            maxs = np.maximum(maxs, np.array([xmax, ymax, zmax], dtype=np.float64))
        if not np.all(np.isfinite(mins)) or not np.all(np.isfinite(maxs)):
            raise RuntimeError("air-box generation failed: magnetic OCC bounds are not finite")
        xmin, ymin, zmin = float(mins[0]), float(mins[1]), float(mins[2])
        xmax, ymax, zmax = float(maxs[0]), float(maxs[1]), float(maxs[2])
        cx, cy, cz = (xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2
        dx, dy, dz = xmax - xmin, ymax - ymin, zmax - zmin
        diag = math.sqrt(dx * dx + dy * dy + dz * dz)

        # ── Create air-box as a larger box ──
        half = factor * diag / 2.0
        air_tag = gmsh.model.occ.addBox(
            cx - half, cy - half, cz - half,
            2 * half, 2 * half, 2 * half,
        )

        # ── Boolean cut: air = box - magnet, preserving both ──
        # Fragment produces non-overlapping volumes sharing interfaces
        _, result_map = gmsh.model.occ.fragment([(3, air_tag)], magnetic_tags)
        gmsh.model.occ.synchronize()

        # ── Identify which fragment is the magnet and which is air ──
        if not result_map:
            raise RuntimeError(
                "air-box generation failed: OCC fragment returned an empty result map"
            )
        mag_volumes: list[int] = []
        for parent_idx in range(1, len(result_map)):
            for dim, tag in result_map[parent_idx]:
                if dim == 3 and tag not in mag_volumes:
                    mag_volumes.append(tag)
        air_volumes: list[int] = []
        mag_set = set(mag_volumes)
        for dim, tag in result_map[0]:
            if dim == 3 and tag not in mag_set:
                air_volumes.append(tag)

        if not mag_volumes:
            raise RuntimeError(
                "air-box generation failed: could not identify magnetic volume after fragment"
            )
        if not air_volumes:
            raise RuntimeError(
                "air-box generation failed: could not identify air volume after fragment"
            )

        # ── Physical groups: magnetic=1, air=0 ──
        gmsh.model.addPhysicalGroup(3, mag_volumes, tag=1)
        gmsh.model.setPhysicalName(3, 1, "magnetic")
        gmsh.model.addPhysicalGroup(3, air_volumes, tag=2)
        gmsh.model.setPhysicalName(3, 2, "air")

        # ── Outer boundary: faces on the air-box exterior ──
        air_boundary = gmsh.model.getBoundary(
            [(3, tag) for tag in air_volumes],
            oriented=False,
        )
        mag_boundary = gmsh.model.getBoundary(
            [(3, tag) for tag in mag_volumes],
            oriented=False,
        )
        interface_tags = {abs(tag) for _, tag in mag_boundary}
        outer_faces = sorted({abs(tag) for _, tag in air_boundary} - interface_tags)
        if outer_faces:
            gmsh.model.addPhysicalGroup(2, outer_faces, tag=boundary_marker)
            gmsh.model.setPhysicalName(2, boundary_marker, "outer_boundary")

        # ── Mesh size: fine near magnet surface, coarser in air ──
        gmsh.option.setNumber("Mesh.MeshSizeMax", hmax * factor * (1.0 + 2.0 * grading))
        gmsh.option.setNumber("Mesh.MeshSizeMin", hmax * 0.1)

        # Size field: distance from magnetic surface + threshold
        mag_surfaces = sorted(interface_tags)

        f_dist = gmsh.model.mesh.field.add("Distance")
        gmsh.model.mesh.field.setNumbers(f_dist, "SurfacesList", mag_surfaces)

        f_thresh = gmsh.model.mesh.field.add("Threshold")
        gmsh.model.mesh.field.setNumber(f_thresh, "InField", f_dist)
        gmsh.model.mesh.field.setNumber(f_thresh, "SizeMin", hmax)
        gmsh.model.mesh.field.setNumber(f_thresh, "SizeMax", hmax * factor * (1.0 + 2.0 * grading))
        gmsh.model.mesh.field.setNumber(f_thresh, "DistMin", 0.0)
        gmsh.model.mesh.field.setNumber(f_thresh, "DistMax", half * grading + hmax)

        f_min = gmsh.model.mesh.field.add("Min")
        gmsh.model.mesh.field.setNumbers(f_min, "FieldsList", [f_thresh])
        gmsh.model.mesh.field.setAsBackgroundMesh(f_min)

        gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        gmsh.option.setNumber("Mesh.Algorithm3D", opts.algorithm_3d)

        if order > 1:
            gmsh.option.setNumber("Mesh.ElementOrder", order)

        # ── Generate ──
        emit_progress("Gmsh: generating air-box 3D mesh")
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)

        # ── Extract mesh data ──
        mesh = _extract_airbox_mesh_data(gmsh, mag_volumes, air_volumes, boundary_marker, quality, per_domain_quality=_pdq)
        emit_progress(
            f"Gmsh: air-box mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements "
            f"(magnetic: {int((mesh.element_markers == 1).sum())}, "
            f"air: {int((mesh.element_markers == 0).sum())})"
        )
        return mesh
    finally:
        gmsh.finalize()


def _create_occ_geometry(gmsh: Any, geometry: Geometry) -> list[tuple[int, int]]:
    """Create OCC entities from a fullmag ``Geometry`` tree.

    Returns a list of OCC ``(dim, tag)`` tuples for downstream boolean ops.
    """
    if isinstance(geometry, Box):
        sx, sy, sz = geometry.size
        tag = gmsh.model.occ.addBox(-sx / 2, -sy / 2, -sz / 2, sx, sy, sz)
        return [(3, tag)]
    if isinstance(geometry, Cylinder):
        axis = geometry.axis
        base = tuple(-0.5 * geometry.height * component for component in axis)
        direction = tuple(geometry.height * component for component in axis)
        tag = gmsh.model.occ.addCylinder(
            base[0], base[1], base[2],
            direction[0], direction[1], direction[2], geometry.radius
        )
        return [(3, tag)]
    if isinstance(geometry, Ellipsoid):
        tag = gmsh.model.occ.addSphere(0, 0, 0, 1.0)
        rx, ry, rz = geometry.rx, geometry.ry, geometry.rz
        gmsh.model.occ.dilate([(3, tag)], 0, 0, 0, rx, ry, rz)
        return [(3, tag)]
    if isinstance(geometry, Ellipse):
        rmax = max(geometry.rx, geometry.ry)
        tag = gmsh.model.occ.addCylinder(
            0.0,
            0.0,
            -geometry.height / 2.0,
            0.0,
            0.0,
            geometry.height,
            rmax,
        )
        gmsh.model.occ.dilate(
            [(3, tag)],
            0.0,
            0.0,
            0.0,
            geometry.rx / rmax,
            geometry.ry / rmax,
            1.0,
        )
        return [(3, tag)]
    if isinstance(geometry, ArchWaveguide):
        return add_arch_waveguide_to_occ(gmsh, geometry)
    if isinstance(geometry, Difference):
        base_tags = _create_occ_geometry(gmsh, geometry.base)
        tool_tags = _create_occ_geometry(gmsh, geometry.tool)
        result, _ = gmsh.model.occ.cut(base_tags, tool_tags)
        return list(result)
    if isinstance(geometry, Union):
        a_tags = _create_occ_geometry(gmsh, geometry.a)
        b_tags = _create_occ_geometry(gmsh, geometry.b)
        result, _ = gmsh.model.occ.fuse(a_tags, b_tags)
        return list(result)
    if isinstance(geometry, Intersection):
        a_tags = _create_occ_geometry(gmsh, geometry.a)
        b_tags = _create_occ_geometry(gmsh, geometry.b)
        result, _ = gmsh.model.occ.intersect(a_tags, b_tags)
        return list(result)
    if isinstance(geometry, Translate):
        inner_tags = _create_occ_geometry(gmsh, geometry.geometry)
        ox, oy, oz = geometry.offset
        gmsh.model.occ.translate(inner_tags, ox, oy, oz)
        return inner_tags
    if isinstance(geometry, ImportedGeometry):
        source = Path(geometry.source)
        suffix = source.suffix.lower()
        if suffix not in {".step", ".stp", ".iges", ".igs", ".brep"}:
            raise TypeError(
                f"add_air_box only supports CAD ImportedGeometry sources in OCC "
                f"(STEP/IGES/BREP), got '{source.name}'"
            )
        tags = list(gmsh.model.occ.importShapes(str(source)))
        if isinstance(geometry.scale, (int, float)):
            sx = sy = sz = float(geometry.scale)
        else:
            sx, sy, sz = (float(component) for component in geometry.scale)
        if not (math.isclose(sx, 1.0) and math.isclose(sy, 1.0) and math.isclose(sz, 1.0)):
            gmsh.model.occ.dilate(tags, 0.0, 0.0, 0.0, sx, sy, sz)
        return tags
    raise TypeError(f"add_air_box does not yet support {type(geometry).__name__} geometry")


def _extract_airbox_mesh_data(
    gmsh: Any,
    mag_volumes: list[int],
    air_volumes: list[int],
    boundary_marker: int,
    quality: MeshQualityReport | None,
    per_domain_quality: dict[int, MeshQualityReport] | None = None,
) -> MeshData:
    """Extract mesh data with correct element markers from an air-box mesh.

    magnetic volumes → element_marker=1, air volumes → element_marker=0.
    """
    # Get all nodes
    node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
    n_gmsh_nodes = len(node_tags)
    # Build tag→index mapping
    tag_to_idx: dict[int, int] = {}
    max_tag = int(node_tags.max()) if n_gmsh_nodes > 0 else 0
    coords_3d = node_coords.reshape(-1, 3)
    # Renumber into contiguous array
    reindex = np.full(max_tag + 1, -1, dtype=np.int32)
    for i, tag in enumerate(node_tags):
        reindex[int(tag)] = i

    nodes = coords_3d.copy()

    # Collect elements with markers
    all_elements: list[np.ndarray] = []
    all_markers: list[np.ndarray] = []

    mag_set = set(mag_volumes)
    for dim, vol_tag in gmsh.model.getEntities(3):
        elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(dim, vol_tag)
        for et, etags, enodes in zip(elem_types, elem_tags, elem_node_tags):
            props = gmsh.model.mesh.getElementProperties(et)
            if props[0] != "Tetrahedron":
                continue
            n_per = props[3]
            if n_per < 4:
                continue
            node_array = np.array(enodes, dtype=np.int64).reshape(-1, n_per)
            # Take first 4 nodes (linear P1 corners)
            tets = node_array[:, :4]
            n_tets = tets.shape[0]
            marker = 1 if vol_tag in mag_set else 0
            reindexed = reindex[tets.ravel()].reshape(-1, 4)
            all_elements.append(reindexed)
            all_markers.append(np.full(n_tets, marker, dtype=np.int32))

    if not all_elements:
        raise RuntimeError("air-box mesh generation produced zero tetrahedra")

    elements = np.concatenate(all_elements, axis=0)
    element_markers = np.concatenate(all_markers, axis=0)

    # Collect boundary faces
    all_bnd_faces: list[np.ndarray] = []
    all_bnd_markers: list[np.ndarray] = []
    for dim, surf_tag in gmsh.model.getEntities(2):
        elem_types, elem_tags, elem_node_tags = gmsh.model.mesh.getElements(dim, surf_tag)
        for et, etags, enodes in zip(elem_types, elem_tags, elem_node_tags):
            props = gmsh.model.mesh.getElementProperties(et)
            if props[0] != "Triangle":
                continue
            n_per = props[3]
            node_array = np.array(enodes, dtype=np.int64).reshape(-1, n_per)
            tris = node_array[:, :3]
            n_tris = tris.shape[0]
            reindexed = reindex[tris.ravel()].reshape(-1, 3)
            all_bnd_faces.append(reindexed)
            # Check if this surface belongs to the outer boundary physical group
            phys_groups = gmsh.model.getPhysicalGroupsForEntity(2, surf_tag)
            bm = boundary_marker if boundary_marker in phys_groups else 1
            all_bnd_markers.append(np.full(n_tris, bm, dtype=np.int32))

    if all_bnd_faces:
        boundary_faces = np.concatenate(all_bnd_faces, axis=0)
        boundary_markers_arr = np.concatenate(all_bnd_markers, axis=0)
    else:
        boundary_faces = np.zeros((0, 3), dtype=np.int32)
        boundary_markers_arr = np.zeros(0, dtype=np.int32)

    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers_arr,
        quality=quality,
        per_domain_quality=per_domain_quality,
    )
