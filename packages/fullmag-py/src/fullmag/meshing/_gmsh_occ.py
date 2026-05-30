from __future__ import annotations

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
        if kind == "ComponentVolumeConstant":
            value = params.get("VIn")
        elif kind in {"SurfaceDistanceThreshold", "InterfaceShellThreshold"}:
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
        if isinstance(geometry, (Box, Cylinder, Ellipsoid, Ellipse, ArchWaveguide)):
            continue
        if isinstance(geometry, Translate):
            if not is_occ_compatible([geometry.geometry]):
                return False
            continue
        if isinstance(geometry, Difference):
            if not is_occ_compatible([geometry.base, geometry.tool]):
                return False
            continue
        if isinstance(geometry, (Union, Intersection)):
            if not is_occ_compatible([geometry.a, geometry.b]):
                return False
            continue
        return False
    return True


def generate_shared_domain_mesh_via_occ(
    geometries: list[Geometry],
    *,
    hmax: float,
    order: int = 1,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
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
        _sanitize_csg_mesh_options,
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

        opts = _sanitize_csg_mesh_options(
            options or MeshOptions(),
            geometries[0],
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

        gmsh.model.occ.synchronize()

        # 2 - Define Airbox geometry in OCC
        has_airbox = airbox_scaled is not None
        if not has_airbox:
            raise ValueError("Airbox options are required for shared-domain meshing")

        # Compute bounding box of all magnetic bodies
        xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
        dx, dy, dz = xmax - xmin, ymax - ymin, zmax - zmin
        cx, cy, cz = (xmin + xmax) / 2, (ymin + ymax) / 2, (zmin + zmax) / 2
        pf = airbox_scaled.padding_factor

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
                outer_tag = gmsh.model.occ.addSphere(cx, cy, cz, radius)
            else:
                outer_tag = gmsh.model.occ.addBox(
                    cx - ox / 2, cy - oy / 2, cz - oz / 2, ox, oy, oz
                )
        elif airbox_scaled.shape == "sphere":
            R = max(dx, dy, dz) / 2 * pf
            outer_tag = gmsh.model.occ.addSphere(cx, cy, cz, R)
            ox = oy = oz = 2.0 * R
        else:
            ox, oy, oz = dx * pf, dy * pf, dz * pf
            outer_tag = gmsh.model.occ.addBox(
                cx - ox / 2, cy - oy / 2, cz - oz / 2, ox, oy, oz
            )

        outer_dimtags = [(3, outer_tag)]

        # 3 - Conforming OCC Fragment
        _result, result_map = gmsh.model.occ.fragment(outer_dimtags, magnetic_tags)
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
        for idx, geom in enumerate(geometries):
            marker = 1 + idx
            component_marker_tags[geom.geometry_name] = marker
            gmsh.model.addPhysicalGroup(
                3,
                component_volume_tags[geom.geometry_name],
                tag=marker,
            )
            gmsh.model.setPhysicalName(3, marker, geom.geometry_name)

        air_tag = 1 + len(geometries)
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

        if gamma_out:
            gmsh.model.addPhysicalGroup(2, gamma_out, tag=airbox_scaled.boundary_marker)
            gmsh.model.setPhysicalName(2, airbox_scaled.boundary_marker, "Gamma_out")
        if interface_list:
            gmsh.model.addPhysicalGroup(2, interface_list, tag=10)
            gmsh.model.setPhysicalName(2, 10, "mag_air_interface")

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
                )
                if field_id is not None:
                    airbox_field_ids.append(field_id)

            remaining_interface = sorted(set(interface_list) - covered_interface_tags)
            if remaining_interface:
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
        )

        scaled_mesh = MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
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
            selector_resolution=report.selector_resolution,
            orphan_entities=orphan_entities,
        )
    finally:
        gmsh.finalize()
