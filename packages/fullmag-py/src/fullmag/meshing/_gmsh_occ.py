from __future__ import annotations

import itertools
import math

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
from ._gmsh_types import MeshData, SharedDomainMeshResult
from ._airbox_grading import (
    _add_airbox_grading_field,
    _airbox_boundary_distance_from_bbox,
)
from .gmsh_bridge import AirboxOptions, MeshOptions, _import_gmsh


def _region_uses_conformal_occ_realization(region: dict[str, object]) -> bool:
    policy = region.get("realization_policy")
    return policy == "conformal"


def _component_interface_size_targets(options: MeshOptions) -> dict[str, float]:
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


def _airbox_interface_dist_max(
    *,
    default_h_inner: float,
    h_inner: float,
    fallback_dist_max: float,
) -> float:
    return max(fallback_dist_max, default_h_inner, h_inner)


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
    gmsh: object,
    dimtags: list[tuple[int, int]],
) -> tuple[tuple[float, float, float], tuple[float, float, float]] | None:
    bounds: list[tuple[float, float, float, float, float, float]] = []
    for dim, tag in dimtags:
        try:
            raw = gmsh.model.getBoundingBox(int(dim), int(tag))  # type: ignore[attr-defined]
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


def is_occ_compatible(geometries: list[Geometry]) -> bool:
    """Check if all geometries are standard shapes compatible with native OCC pipeline."""
    for geometry in geometries:
        if isinstance(geometry, ImportedGeometry):
            return False
        if isinstance(geometry, Cylinder):
            continue
        if isinstance(geometry, (Box, Ellipsoid, Ellipse, ArchWaveguide)):
            continue
        if isinstance(geometry, Translate):
            if not is_occ_compatible([geometry.geometry]):
                return False
            continue
        if isinstance(geometry, Difference):
            if not is_occ_compatible([geometry.base, geometry.tool]):
                return False
            continue
        if isinstance(geometry, Union):
            if not is_occ_compatible([geometry.a, geometry.b]):
                return False
            continue
        if isinstance(geometry, Intersection):
            if not is_occ_compatible([geometry.a, geometry.b]):
                return False
            continue
        return False
    return True


def _contains_boolean_csg(geometry: Geometry) -> bool:
    if isinstance(geometry, Translate):
        return _contains_boolean_csg(geometry.geometry)
    if isinstance(geometry, (Difference, Intersection, Union)):
        return True
    return False


def _geometry_translation(geometry: Geometry) -> tuple[float, float, float]:
    if isinstance(geometry, Translate):
        nested = _geometry_translation(geometry.geometry)
        return (
            nested[0] + geometry.offset[0],
            nested[1] + geometry.offset[1],
            nested[2] + geometry.offset[2],
        )
    return (0.0, 0.0, 0.0)


def _dimtags_bounding_box(
    gmsh: object,
    dimtags: list[tuple[int, int]],
) -> tuple[float, float, float, float, float, float]:
    bounds = [
        gmsh.model.getBoundingBox(dim, tag)  # type: ignore[attr-defined]
        for dim, tag in dimtags
    ]
    return (
        min(bound[0] for bound in bounds),
        min(bound[1] for bound in bounds),
        min(bound[2] for bound in bounds),
        max(bound[3] for bound in bounds),
        max(bound[4] for bound in bounds),
        max(bound[5] for bound in bounds),
    )


def _axis_from_periodic_pair_id(pair_id: str) -> int | None:
    normalized = pair_id.strip().lower().replace("-", "_")
    if normalized in {"x", "x_face", "x_faces", "x_periodic"}:
        return 0
    if normalized in {"y", "y_face", "y_faces", "y_periodic"}:
        return 1
    if normalized in {"z", "z_face", "z_faces", "z_periodic"}:
        return 2
    return None


def _surface_center_key(
    bbox: tuple[float, float, float, float, float, float],
    axis: int,
) -> tuple[float, float, float, float]:
    other_axes = [candidate for candidate in range(3) if candidate != axis]
    return (
        0.5 * (bbox[other_axes[0]] + bbox[other_axes[0] + 3]),
        0.5 * (bbox[other_axes[1]] + bbox[other_axes[1] + 3]),
        bbox[other_axes[0] + 3] - bbox[other_axes[0]],
        bbox[other_axes[1] + 3] - bbox[other_axes[1]],
    )


def _configure_axis_periodic_surfaces(
    gmsh: object,
    *,
    surface_tags: list[int],
    pair_ids: list[str],
) -> list[dict[str, object]]:
    if not pair_ids:
        return []
    if not surface_tags:
        raise ValueError("periodic mesh generation requires outer boundary surfaces")

    surface_bounds = {
        int(tag): tuple(float(value) for value in gmsh.model.getBoundingBox(2, int(tag)))  # type: ignore[attr-defined]
        for tag in surface_tags
    }
    bounds_min, bounds_max = _entity_bounds(
        gmsh,
        [(2, int(tag)) for tag in surface_tags],
    ) or ((0.0, 0.0, 0.0), (0.0, 0.0, 0.0))
    span = tuple(bounds_max[index] - bounds_min[index] for index in range(3))
    tol = max(max(abs(value) for value in span) * 1.0e-6, 1.0e-6)

    specs: list[dict[str, object]] = []
    for pair_id in pair_ids:
        axis = _axis_from_periodic_pair_id(pair_id)
        if axis is None:
            raise ValueError(
                f"unsupported periodic_pair_ids entry {pair_id!r}; expected x_faces, y_faces, or z_faces"
            )
        if span[axis] <= tol:
            raise ValueError(f"periodic pair '{pair_id}' has zero domain span")
        min_surfaces = [
            tag
            for tag, bbox in surface_bounds.items()
            if abs(bbox[axis] - bounds_min[axis]) <= tol
            and abs(bbox[axis + 3] - bounds_min[axis]) <= tol
        ]
        max_surfaces = [
            tag
            for tag, bbox in surface_bounds.items()
            if abs(bbox[axis] - bounds_max[axis]) <= tol
            and abs(bbox[axis + 3] - bounds_max[axis]) <= tol
        ]
        if not min_surfaces or not max_surfaces or len(min_surfaces) != len(max_surfaces):
            samples = sorted(
                (
                    (
                        tag,
                        surface_bounds[tag][axis],
                        surface_bounds[tag][axis + 3],
                    )
                    for tag in surface_bounds
                ),
                key=lambda item: min(
                    abs(item[1] - bounds_min[axis]),
                    abs(item[2] - bounds_min[axis]),
                    abs(item[1] - bounds_max[axis]),
                    abs(item[2] - bounds_max[axis]),
                ),
            )[:8]
            raise ValueError(
                f"periodic pair '{pair_id}' requires matching min/max outer surfaces; "
                f"found {len(min_surfaces)} and {len(max_surfaces)} "
                f"(axis_bounds=({bounds_min[axis]:.9g},{bounds_max[axis]:.9g}), "
                f"tol={tol:.3g}, sample_axis_bboxes={samples})"
            )
        min_ordered = sorted(
            min_surfaces,
            key=lambda tag: _surface_center_key(surface_bounds[tag], axis),
        )
        max_ordered = sorted(
            max_surfaces,
            key=lambda tag: _surface_center_key(surface_bounds[tag], axis),
        )
        axis_translation = 0.5 * (
            surface_bounds[max_ordered[0]][axis]
            + surface_bounds[max_ordered[0]][axis + 3]
            - surface_bounds[min_ordered[0]][axis]
            - surface_bounds[min_ordered[0]][axis + 3]
        )
        translation = [0.0, 0.0, 0.0]
        translation[axis] = float(axis_translation)
        affine = [
            1.0,
            0.0,
            0.0,
            translation[0],
            0.0,
            1.0,
            0.0,
            translation[1],
            0.0,
            0.0,
            1.0,
            translation[2],
            0.0,
            0.0,
            0.0,
            1.0,
        ]
        gmsh.model.mesh.setPeriodic(2, max_ordered, min_ordered, affine)  # type: ignore[attr-defined]
        for master_tag, slave_tag in zip(min_ordered, max_ordered, strict=True):
            specs.append(
                {
                    "pair_id": pair_id,
                    "master_tag": int(master_tag),
                    "slave_tag": int(slave_tag),
                    "marker_a": int(master_tag),
                    "marker_b": int(slave_tag),
                    "translation": list(translation),
                    "tolerance_m": tol,
                }
            )

    return specs


def _periodic_candidate_surface_tags(
    *,
    gamma_out: list[int],
    component_surface_tags: dict[str, list[int]],
    has_airbox: bool,
    all_surface_tags: list[int] | None = None,
) -> list[int]:
    """Return boundary surfaces that may carry axis-periodic constraints."""
    if all_surface_tags:
        return sorted({int(tag) for tag in all_surface_tags})
    if has_airbox:
        return sorted(int(tag) for tag in gamma_out)
    return sorted(
        {
            int(tag)
            for tags in component_surface_tags.values()
            for tag in tags
        }
    )


def _add_periodic_boundary_physical_groups(
    gmsh: object,
    specs: list[dict[str, object]],
    *,
    reserved_markers: set[int],
) -> set[int]:
    """Assign physical boundary markers to periodic surfaces and update specs."""
    periodic_surface_tags: set[int] = set()
    if not specs:
        return periodic_surface_tags

    next_marker = max(reserved_markers | {0}) + 1
    surface_markers: dict[int, int] = {}

    def marker_for_surface(surface_tag: int) -> int:
        nonlocal next_marker
        existing = surface_markers.get(surface_tag)
        if existing is not None:
            return existing
        while next_marker in reserved_markers or next_marker in surface_markers.values():
            next_marker += 1
        marker = next_marker
        surface_markers[surface_tag] = marker
        reserved_markers.add(marker)
        next_marker += 1
        return marker

    for spec in specs:
        master_tag = int(spec["master_tag"])
        slave_tag = int(spec["slave_tag"])
        marker_a = marker_for_surface(master_tag)
        marker_b = marker_for_surface(slave_tag)
        spec["marker_a"] = marker_a
        spec["marker_b"] = marker_b
        periodic_surface_tags.update((master_tag, slave_tag))

    for surface_tag, marker in sorted(surface_markers.items(), key=lambda item: item[1]):
        gmsh.model.addPhysicalGroup(2, [surface_tag], tag=marker)  # type: ignore[attr-defined]
        gmsh.model.setPhysicalName(  # type: ignore[attr-defined]
            2,
            marker,
            f"periodic_boundary_{surface_tag}",
        )

    return periodic_surface_tags


def _scale_periodic_boundary_pairs(
    pairs: list[dict[str, object]],
    *,
    scale: float,
) -> list[dict[str, object]]:
    scaled: list[dict[str, object]] = []
    for pair in pairs:
        item = dict(pair)
        translation = item.get("translation")
        if isinstance(translation, list):
            item["translation"] = [float(value) / scale for value in translation]
        if "tolerance_m" in item:
            item["tolerance_m"] = float(item["tolerance_m"]) / scale
        scaled.append(item)
    return scaled


def _bounding_box_contains(
    outer: tuple[float, float, float, float, float, float],
    inner: tuple[float, float, float, float, float, float],
) -> bool:
    characteristic_length = max(
        *(abs(value) for value in outer),
        *(abs(value) for value in inner),
        outer[3] - outer[0],
        outer[4] - outer[1],
        outer[5] - outer[2],
        1.0,
    )
    tolerance = characteristic_length * 1.0e-7
    return all(
        inner[axis] >= outer[axis] - tolerance
        and inner[axis + 3] <= outer[axis + 3] + tolerance
        for axis in range(3)
    )


def _add_conformal_region_to_occ(
    gmsh: object,
    region: dict[str, object],
    owner_geometry: Geometry,
    *,
    scale: float,
) -> tuple[int, int]:
    shape = region.get("shape")
    if not isinstance(shape, dict):
        raise ValueError("conformal object region requires a shape mapping")
    center_value = shape.get("center", [0.0, 0.0, 0.0])
    if not isinstance(center_value, (list, tuple)) or len(center_value) != 3:
        raise ValueError("conformal object region shape.center must contain three values")
    center = tuple(float(value) for value in center_value)
    if region.get("frame", "object") == "object":
        translation = _geometry_translation(owner_geometry)
        center = tuple(center[index] + translation[index] for index in range(3))
    center_scaled = tuple(value * scale for value in center)
    kind = shape.get("kind")
    if kind == "box":
        size_value = shape.get("size")
        if not isinstance(size_value, (list, tuple)) or len(size_value) != 3:
            raise ValueError("conformal box region requires shape.size with three values")
        size = tuple(float(value) * scale for value in size_value)
        if min(size) <= 0.0:
            raise ValueError("conformal box region dimensions must be positive")
        tag = gmsh.model.occ.addBox(  # type: ignore[attr-defined]
            center_scaled[0] - size[0] / 2.0,
            center_scaled[1] - size[1] / 2.0,
            center_scaled[2] - size[2] / 2.0,
            size[0],
            size[1],
            size[2],
        )
        return (3, int(tag))
    if kind == "cylinder":
        radius = float(shape.get("radius", 0.0)) * scale
        height = float(shape.get("height", 0.0)) * scale
        axis_value = shape.get("axis", [0.0, 0.0, 1.0])
        if not isinstance(axis_value, (list, tuple)) or len(axis_value) != 3:
            raise ValueError("conformal cylinder region axis must contain three values")
        axis = tuple(float(value) for value in axis_value)
        axis_norm = math.sqrt(sum(value * value for value in axis))
        if radius <= 0.0 or height <= 0.0 or axis_norm <= 0.0:
            raise ValueError(
                "conformal cylinder region requires positive radius/height and non-zero axis"
            )
        unit = tuple(value / axis_norm for value in axis)
        base = tuple(
            center_scaled[index] - 0.5 * height * unit[index]
            for index in range(3)
        )
        direction = tuple(height * value for value in unit)
        tag = gmsh.model.occ.addCylinder(  # type: ignore[attr-defined]
            base[0],
            base[1],
            base[2],
            direction[0],
            direction[1],
            direction[2],
            radius,
        )
        return (3, int(tag))
    raise ValueError(
        f"automatic conformal object-region meshing supports box/cylinder, got {kind!r}"
    )


def generate_shared_domain_mesh_via_occ(
    geometries: list[Geometry],
    *,
    hmax: float,
    order: int = 1,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
    object_regions: list[dict[str, object]] | None = None,
) -> SharedDomainMeshResult:
    """Generate a conformal shared-domain mesh with native OCC fragment."""
    if not geometries:
        raise ValueError("at least one geometry is required")

    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)

    # Lazy imports to prevent circular references
    from ._gmsh_generators import (
        _configure_gmsh_threads,
        _add_geometry_to_occ,
        _sanitize_csg_mesh_options_for_geometries,
        _scale_airbox_options,
        _extract_quality_metrics,
        _GmshProgressLogger,
        _apply_post_mesh_options,
        _add_airbox_volume_clamp_fields,
    )
    from ._gmsh_fields import _apply_mesh_options
    from ._gmsh_extraction import _extract_mesh_data

    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("shared_domain_occ")

        opts = _sanitize_csg_mesh_options_for_geometries(
            options or MeshOptions(),
            geometries,
            context="shared-domain OCC mesh",
        )

        # Use micrometre scaling (1e6) for OCC CAD numerical stability
        SCALE = 1e6
        airbox_scaled = _scale_airbox_options(airbox, SCALE)

        # 1 - Build OCC entities for each geometry
        magnetic_tags: list[tuple[int, int]] = []
        magnetic_tags_by_geometry: dict[str, list[tuple[int, int]]] = {}

        for geom in geometries:
            comp_tags = _add_geometry_to_occ(gmsh, geom, scale=SCALE)
            comp_volume_tags = [(dim, tag) for dim, tag in comp_tags if dim == 3]
            if not comp_volume_tags:
                raise RuntimeError(
                    f"OCC geometry '{geom.geometry_name}' produced no volumes"
                )
            magnetic_tags.extend(comp_volume_tags)
            magnetic_tags_by_geometry[geom.geometry_name] = comp_volume_tags

        geometry_by_name = {geometry.geometry_name: geometry for geometry in geometries}
        conformal_regions = [
            region
            for region in (object_regions or [])
            if region.get("enabled", True)
            and _region_uses_conformal_occ_realization(region)
        ]
        region_tags_by_id: dict[str, tuple[int, int]] = {}
        region_owner_by_id: dict[str, str] = {}
        for region in conformal_regions:
            region_id = str(region.get("region_id", "")).strip()
            owner_geometry_name = str(region.get("owner_geometry_name", "")).strip()
            if not region_id or not owner_geometry_name:
                raise ValueError(
                    "conformal object region requires region_id and owner_geometry_name"
                )
            owner_geometry = geometry_by_name.get(owner_geometry_name)
            if owner_geometry is None:
                raise ValueError(
                    f"conformal object region '{region_id}' references unknown owner geometry "
                    f"'{owner_geometry_name}'"
                )
            region_tags_by_id[region_id] = _add_conformal_region_to_occ(
                gmsh,
                region,
                owner_geometry,
                scale=SCALE,
            )
            region_owner_by_id[region_id] = owner_geometry_name

        gmsh.model.occ.synchronize()

        for region_id, region_dimtag in region_tags_by_id.items():
            owner_bounds = _dimtags_bounding_box(
                gmsh,
                magnetic_tags_by_geometry[region_owner_by_id[region_id]],
            )
            region_bounds = _dimtags_bounding_box(gmsh, [region_dimtag])
            if not _bounding_box_contains(owner_bounds, region_bounds):
                raise ValueError(
                    f"conformal object region '{region_id}' must be fully contained "
                    "inside its owner geometry bounds"
                )

        # 2 - Define Airbox geometry in OCC
        has_airbox = airbox_scaled is not None
        if not has_airbox:
            raise ValueError("Airbox options are required for shared-domain meshing")

        # Compute bounding box of all magnetic bodies
        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
        dx, dy, dz = xmax - xmin, ymax - ymin, zmax - zmin
        cx, cy, cz = (xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2
        pf = airbox_scaled.padding_factor
        airbox_radius: float | None = None

        explicit_size = airbox_scaled.size
        explicit_center = airbox_scaled.center
        if explicit_size is not None:
            ox, oy, oz = explicit_size
            if min(ox, oy, oz) <= 0.0:
                raise ValueError("airbox.size components must be positive")
            if explicit_center is not None:
                cx, cy, cz = explicit_center
            if airbox_scaled.shape == "sphere":
                radius = max(ox, oy, oz) / 2.0
                airbox_radius = float(radius)
                outer_tag = gmsh.model.occ.addSphere(cx, cy, cz, radius)
            else:
                outer_tag = gmsh.model.occ.addBox(
                    cx - ox / 2, cy - oy / 2, cz - oz / 2, ox, oy, oz
                )
        elif airbox_scaled.shape == "sphere":
            R = max(dx, dy, dz) / 2 * pf
            airbox_radius = float(R)
            outer_tag = gmsh.model.occ.addSphere(cx, cy, cz, R)
            ox = oy = oz = 2.0 * R
        else:
            ox, oy, oz = dx * pf, dy * pf, dz * pf
            outer_tag = gmsh.model.occ.addBox(
                cx - ox / 2, cy - oy / 2, cz - oz / 2, ox, oy, oz
            )

        outer_dimtags = [(3, outer_tag)]

        # 3 - Conforming OCC Fragment
        region_input_tags = list(region_tags_by_id.values())
        _result, result_map = gmsh.model.occ.fragment(
            outer_dimtags,
            magnetic_tags + region_input_tags,
        )
        gmsh.model.occ.synchronize()

        if not result_map:
            raise RuntimeError("OCC fragment failed - check geometries")

        # 4 - Identify final volume tags per component
        component_volume_tags: dict[str, list[int]] = {}
        all_magnetic_vols: list[int] = []
        result_map_index = len(outer_dimtags)

        for geom in geometries:
            comp_vols: list[int] = []
            for _dimtag in magnetic_tags_by_geometry[geom.geometry_name]:
                if result_map_index >= len(result_map):
                    raise RuntimeError("OCC fragment returned an incomplete input map")
                comp_vols.extend(
                    tag for dim, tag in result_map[result_map_index] if dim == 3
                )
                result_map_index += 1
            comp_vols = sorted(set(comp_vols))
            if not comp_vols:
                raise RuntimeError(
                    f"OCC fragment produced no magnetic volumes for '{geom.geometry_name}'"
                )
            component_volume_tags[geom.geometry_name] = comp_vols
            all_magnetic_vols.extend(comp_vols)

        region_volume_tags: dict[str, list[int]] = {}
        region_result_index = len(outer_dimtags) + len(magnetic_tags)
        for region_id in region_tags_by_id:
            if region_result_index >= len(result_map):
                raise RuntimeError("OCC fragment returned an incomplete object-region map")
            region_vols = sorted(
                {
                    tag
                    for dim, tag in result_map[region_result_index]
                    if dim == 3
                }
            )
            region_result_index += 1
            owner_volumes = set(
                component_volume_tags[region_owner_by_id[region_id]]
            )
            clipped_region_volumes = sorted(set(region_vols).intersection(owner_volumes))
            if not clipped_region_volumes:
                raise ValueError(
                    f"conformal object region '{region_id}' does not intersect "
                    "its owner geometry"
                )
            region_volume_tags[region_id] = clipped_region_volumes

        region_ids = list(region_volume_tags)
        for index, region_id in enumerate(region_ids):
            volumes = set(region_volume_tags[region_id])
            for other_region_id in region_ids[index + 1 :]:
                shared_volumes = volumes.intersection(
                    region_volume_tags[other_region_id]
                )
                if shared_volumes:
                    raise ValueError(
                        "automatic conformal object-region meshing does not support "
                        f"overlapping regions '{region_id}' and '{other_region_id}'"
                    )

        magnetic_volume_set = set(all_magnetic_vols)
        air_vols = sorted(
            {
                tag
                for dim, tag in result_map[0]
                if dim == 3 and tag not in magnetic_volume_set
            }
        )

        # Validate that we have volumes
        if not all_magnetic_vols:
            raise RuntimeError("OCC fragment produced no magnetic volumes")
        if not air_vols:
            raise RuntimeError(
                "OCC fragment produced no air volumes - check airbox padding/size"
            )

        # 5 - Establish Physical Groups (stable markers for MeshIR)
        component_marker_tags: dict[str, int] = {}
        all_region_volumes = {
            volume
            for volumes in region_volume_tags.values()
            for volume in volumes
        }
        for idx, geom in enumerate(geometries):
            marker = 1 + idx
            component_marker_tags[geom.geometry_name] = marker
            parent_volumes = sorted(
                set(component_volume_tags[geom.geometry_name]) - all_region_volumes
            )
            if not parent_volumes:
                raise ValueError(
                    f"conformal regions consume the complete owner geometry "
                    f"'{geom.geometry_name}'"
                )
            gmsh.model.addPhysicalGroup(
                3,
                parent_volumes,
                tag=marker,
            )
            gmsh.model.setPhysicalName(3, marker, geom.geometry_name)

        object_region_marker_tags: dict[str, int] = {}
        for offset, (region_id, volume_tags) in enumerate(
            region_volume_tags.items(),
            start=1 + len(geometries),
        ):
            object_region_marker_tags[region_id] = offset
            gmsh.model.addPhysicalGroup(3, volume_tags, tag=offset)
            gmsh.model.setPhysicalName(3, offset, region_id)

        air_tag = 1 + len(geometries) + len(region_volume_tags)
        gmsh.model.addPhysicalGroup(3, air_vols, tag=air_tag)
        gmsh.model.setPhysicalName(3, air_tag, "air")

        # Surface markers: Gamma_out and mag_air_interface
        air_boundary = gmsh.model.getBoundary(
            [(3, t) for t in air_vols],
            oriented=False,
        )
        mag_boundary = gmsh.model.getBoundary(
            [(3, t) for t in all_magnetic_vols],
            oriented=False,
        )

        air_surface_tags = {abs(tag) for dim, tag in air_boundary if dim == 2}
        mag_surface_tags = {abs(tag) for dim, tag in mag_boundary if dim == 2}
        interface_tags = air_surface_tags & mag_surface_tags
        gamma_out = sorted(air_surface_tags - interface_tags)
        interface_list = sorted(interface_tags)

        component_surface_tags: dict[str, list[int]] = {}
        component_bounds: dict[
            str,
            tuple[tuple[float, float, float], tuple[float, float, float]],
        ] = {}
        for geom in geometries:
            comp_vols = component_volume_tags[geom.geometry_name]
            comp_boundary = gmsh.model.getBoundary(
                [(3, t) for t in comp_vols],
                oriented=False,
            )
            component_surface_tags[geom.geometry_name] = sorted(
                {abs(tag) for _, tag in comp_boundary}
            )
            bounds = _entity_bounds(gmsh, [(3, tag) for tag in comp_vols])
            if bounds is not None:
                component_bounds[geom.geometry_name] = bounds

        # 6 - Graded size field on the airbox
        airbox_field_ids: list[int] = []
        if airbox_scaled.grading_ratio > 1.0 and interface_list:
            h_outer = (
                airbox_scaled.maximum_element_size
                if airbox_scaled.maximum_element_size is not None
                else hmax * SCALE * airbox_scaled.grading_ratio ** 4
            )
            default_h_inner = (
                airbox_scaled.minimum_element_size
                if airbox_scaled.minimum_element_size is not None
                else hmax * SCALE
            )
            d_outer = _airbox_boundary_distance_from_bbox(
                object_bounds_min=(xmin, ymin, zmin),
                object_bounds_max=(xmax, ymax, zmax),
                airbox_bounds_min=(cx - ox / 2, cy - oy / 2, cz - oz / 2),
                airbox_bounds_max=(cx + ox / 2, cy + oy / 2, cz + oz / 2),
            )
            airbox_bounds_min = (cx - ox / 2, cy - oy / 2, cz - oz / 2)
            airbox_bounds_max = (cx + ox / 2, cy + oy / 2, cz + oz / 2)

            component_size_targets = _component_interface_size_targets(opts)
            covered_interface_tags: set[int] = set()
            fallback_dist_max = max(d_outer, hmax * SCALE)
            for geom in geometries:
                geom_interface = sorted(
                    set(component_surface_tags.get(geom.geometry_name, []))
                    & set(interface_list)
                )
                if not geom_interface:
                    continue
                covered_interface_tags.update(geom_interface)
                target = component_size_targets.get(geom.geometry_name)
                h_inner = (
                    default_h_inner
                    if target is None
                    else min(default_h_inner, target * SCALE)
                )
                object_bounds_min, object_bounds_max = component_bounds.get(
                    geom.geometry_name,
                    ((xmin, ymin, zmin), (xmax, ymax, zmax)),
                )
                object_radius = (
                    _radius_from_center_to_bbox_corner(
                        (cx, cy, cz),
                        object_bounds_min,
                        object_bounds_max,
                    )
                    if airbox_scaled.shape == "sphere"
                    else None
                )

                field_id = _add_airbox_grading_field(
                    gmsh,
                    surface_tags=geom_interface,
                    h_inner=h_inner,
                    h_outer=h_outer,
                    grading_ratio=airbox_scaled.grading_ratio,
                    grading_mode=airbox_scaled.grading_mode,
                    dist_max=_airbox_interface_dist_max(
                        default_h_inner=default_h_inner,
                        h_inner=h_inner,
                        fallback_dist_max=fallback_dist_max,
                    ),
                    object_bounds_min=object_bounds_min,
                    object_bounds_max=object_bounds_max,
                    airbox_bounds_min=airbox_bounds_min,
                    airbox_bounds_max=airbox_bounds_max,
                    airbox_shape=airbox_scaled.shape,
                    airbox_center=(cx, cy, cz),
                    object_radius=object_radius,
                    airbox_radius=airbox_radius,
                )
                if field_id is not None:
                    airbox_field_ids.append(field_id)

            remaining_interface = sorted(set(interface_list) - covered_interface_tags)
            if remaining_interface:
                object_radius = (
                    _radius_from_center_to_bbox_corner(
                        (cx, cy, cz),
                        (xmin, ymin, zmin),
                        (xmax, ymax, zmax),
                    )
                    if airbox_scaled.shape == "sphere"
                    else None
                )
                field_id = _add_airbox_grading_field(
                    gmsh,
                    surface_tags=remaining_interface,
                    h_inner=default_h_inner,
                    h_outer=h_outer,
                    grading_ratio=airbox_scaled.grading_ratio,
                    grading_mode=airbox_scaled.grading_mode,
                    dist_max=_airbox_interface_dist_max(
                        default_h_inner=default_h_inner,
                        h_inner=default_h_inner,
                        fallback_dist_max=fallback_dist_max,
                    ),
                    object_bounds_min=(xmin, ymin, zmin),
                    object_bounds_max=(xmax, ymax, zmax),
                    airbox_bounds_min=airbox_bounds_min,
                    airbox_bounds_max=airbox_bounds_max,
                    airbox_shape=airbox_scaled.shape,
                    airbox_center=(cx, cy, cz),
                    object_radius=object_radius,
                    airbox_radius=airbox_radius,
                )
                if field_id is not None:
                    airbox_field_ids.append(field_id)

        # 7 - Apply Sizing Options & Local Fields
        preexisting = list(airbox_field_ids)
        airbox_lower_bound_field_ids: list[int] = []
        if airbox_scaled is not None:
            clamp_max_fields, clamp_min_fields = _add_airbox_volume_clamp_fields(
                gmsh,
                air_volume_tags=air_vols,
                airbox=airbox_scaled,
            )
            preexisting.extend(clamp_max_fields)
            airbox_lower_bound_field_ids.extend(clamp_min_fields)
        report = _apply_mesh_options(
            gmsh,
            hmax * SCALE,
            order,
            opts,
            hscale=SCALE,
            preexisting_field_ids=preexisting,
            preexisting_lower_bound_field_ids=airbox_lower_bound_field_ids,
            component_volume_tags=component_volume_tags,
            component_surface_tags=component_surface_tags,
            airbox_maximum_element_size=(
                airbox_scaled.maximum_element_size
                if airbox_scaled is not None
                and airbox_scaled.maximum_element_size is not None
                else None
            ),
        )
        periodic_surface_tags = _periodic_candidate_surface_tags(
            gamma_out=gamma_out,
            component_surface_tags=component_surface_tags,
            has_airbox=has_airbox,
            all_surface_tags=[
                int(tag)
                for dim, tag in gmsh.model.getEntities(2)  # type: ignore[attr-defined]
                if int(dim) == 2
            ],
        )
        periodic_pair_specs = _configure_axis_periodic_surfaces(
            gmsh,
            surface_tags=periodic_surface_tags,
            pair_ids=list(opts.periodic_pair_ids),
        )
        periodic_physical_surfaces = _add_periodic_boundary_physical_groups(
            gmsh,
            periodic_pair_specs,
            reserved_markers={10, int(airbox_scaled.boundary_marker)},
        )
        gamma_out_robin = [
            int(tag) for tag in gamma_out if int(tag) not in periodic_physical_surfaces
        ]
        if gamma_out_robin:
            gmsh.model.addPhysicalGroup(2, gamma_out_robin, tag=airbox_scaled.boundary_marker)
            gmsh.model.setPhysicalName(2, airbox_scaled.boundary_marker, "Gamma_out")
        if interface_list:
            gmsh.model.addPhysicalGroup(2, interface_list, tag=10)
            gmsh.model.setPhysicalName(2, 10, "mag_air_interface")

        from ._gmsh_generators import collect_orphan_entity_diagnostics
        orphan_entities = collect_orphan_entity_diagnostics(gmsh)

        # 8 - Generate 3D mesh
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)

        _apply_post_mesh_options(gmsh, opts)

        # 9 - Extract MeshData and scale back to SI meters
        quality, _pdq = (
            _extract_quality_metrics(gmsh, opts)
            if opts.compute_quality
            else (None, None)
        )
        mesh = _extract_mesh_data(
            gmsh,
            quality=quality,
            has_physical_groups=True,
            per_domain_quality=_pdq,
            periodic_pair_specs=periodic_pair_specs,
        )

        scaled_mesh = MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            periodic_boundary_pairs=_scale_periodic_boundary_pairs(
                mesh.periodic_boundary_pairs,
                scale=SCALE,
            ),
            periodic_node_pairs=mesh.periodic_node_pairs,
            quality=quality,
            per_domain_quality=_pdq,
        )

        return SharedDomainMeshResult(
            mesh=scaled_mesh,
            component_marker_tags=component_marker_tags,
            component_volume_tags=component_volume_tags,
            component_surface_tags=component_surface_tags,
            interface_surface_tags=interface_list,
            outer_boundary_surface_tags=gamma_out,
            object_region_marker_tags=object_region_marker_tags,
            selector_resolution=report.selector_resolution,
            boundary_layer_result=report.boundary_layer_result,
            orphan_entities=orphan_entities,
        )
    finally:
        gmsh.finalize()
