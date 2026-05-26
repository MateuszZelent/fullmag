from __future__ import annotations

from dataclasses import replace as _dc_replace
import math
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress
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

from ._gmsh_types import (
    ALGO_2D_FRONTAL_DELAUNAY,
    ALGO_2D_FRONTAL_QUADS,
    ALGO_3D_DELAUNAY,
    ALGO_3D_HXT,
    AirboxOptions,
    ComponentDescriptor,
    MeshData,
    MeshOptions,
    SharedDomainMeshResult,
    SizeFieldData,
)
from ._gmsh_infra import (
    _import_gmsh,
    _peel_translate_chain,
    _configure_gmsh_threads,
    _GmshProgressLogger,
    _normalize_scale_xyz,
    _source_hmax_from_scale,
    _scale_mesh_nodes,
)
from ._gmsh_extraction import (
    _extract_mesh_data,
    _extract_quality_metrics,
    _extract_gmsh_connectivity,
    _read_mesh_file,
)
from ._gmsh_fields import _apply_mesh_options, _apply_post_mesh_options
from ._gmsh_selectors import collect_orphan_entity_diagnostics
from ._gmsh_airbox import _add_airbox_and_fragment, _add_airbox_geo
from ._gmsh_swept import should_use_swept, generate_swept_mesh, classify_sweepability
from ._gmsh_waveguides import add_arch_waveguide_to_occ

_NO_OP_FIELD_SIZE = 1.0e22


def _airbox_volume_tags_for_components(
    gmsh: Any,
    component_volume_tags: dict[str, list[int]],
) -> list[int]:
    component_volumes = {
        int(tag)
        for tags in component_volume_tags.values()
        for tag in tags
    }
    all_volumes = [int(tag) for dim, tag in gmsh.model.getEntities(3) if dim == 3]
    return [tag for tag in all_volumes if tag not in component_volumes]


def _add_airbox_volume_clamp_fields(
    gmsh: Any,
    *,
    air_volume_tags: list[int],
    airbox: AirboxOptions,
) -> tuple[list[int], list[int]]:
    upper_bound_fields: list[int] = []
    lower_bound_fields: list[int] = []
    if not air_volume_tags:
        return upper_bound_fields, lower_bound_fields

    if airbox.maximum_element_size is not None:
        f_air_max = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(f_air_max, "VolumesList", air_volume_tags)
        gmsh.model.mesh.field.setNumber(f_air_max, "VIn", float(airbox.maximum_element_size))
        gmsh.model.mesh.field.setNumber(f_air_max, "VOut", float(_NO_OP_FIELD_SIZE))
        upper_bound_fields.append(f_air_max)

    if airbox.minimum_element_size is not None:
        f_air_min = gmsh.model.mesh.field.add("Constant")
        gmsh.model.mesh.field.setNumbers(f_air_min, "VolumesList", air_volume_tags)
        gmsh.model.mesh.field.setNumber(f_air_min, "VIn", float(airbox.minimum_element_size))
        gmsh.model.mesh.field.setNumber(f_air_min, "VOut", 0.0)
        lower_bound_fields.append(f_air_min)

    return upper_bound_fields, lower_bound_fields


def _scale_airbox_options(
    airbox: AirboxOptions | None,
    scale: float,
) -> AirboxOptions | None:
    """Scale explicit airbox dimensions into the active meshing coordinate system.

    OCC mesh generators in this module often scale geometry from SI metres to
    micrometres for numerical robustness.  When an explicit ``airbox.size`` /
    ``airbox.center`` is provided from study metadata (still in SI), we must
    scale those fields too before calling OCC booleans; otherwise OCC receives
    near-zero box dimensions and can fail or create distorted outer domains.
    """
    if airbox is None:
        return None

    size = (
        tuple(float(component) * scale for component in airbox.size)
        if airbox.size is not None
        else None
    )
    center = (
        tuple(float(component) * scale for component in airbox.center)
        if airbox.center is not None
        else None
    )
    maximum_element_size = (
        float(airbox.maximum_element_size) * scale
        if airbox.maximum_element_size is not None
        else None
    )
    minimum_element_size = (
        float(airbox.minimum_element_size) * scale
        if airbox.minimum_element_size is not None
        else None
    )

    return AirboxOptions(
        padding_factor=float(airbox.padding_factor),
        shape=str(airbox.shape),
        grading_ratio=float(airbox.grading_ratio),
        grading_mode=str(airbox.grading_mode),
        boundary_marker=int(airbox.boundary_marker),
        size=size,
        center=center,
        maximum_element_size=maximum_element_size,
        minimum_element_size=minimum_element_size,
    )


def _sanitize_volume_mesh_options(
    opts: MeshOptions,
    *,
    context: str,
) -> MeshOptions:
    """Guard against cap-pole singularities in thin-body volume meshing.

    ``Mesh.Algorithm=8`` (Frontal for Quads) can produce severe pole-like
    connectivity spikes and poor through-thickness layering on thin films.
    For 3D tetrahedral workflows we consistently prefer Frontal-Delaunay
    triangles on the surface stage.
    """
    if opts.algorithm_2d != ALGO_2D_FRONTAL_QUADS:
        return opts
    emit_progress(
        f"Gmsh: {context}: algorithm_2d=8 (FrontalQuads) is unstable for 3D thin-film volume meshing; "
        "falling back to algorithm_2d=6 (Frontal-Delaunay)"
    )
    return _dc_replace(opts, algorithm_2d=ALGO_2D_FRONTAL_DELAUNAY)


def _geometry_contains_arch_waveguide(geometry: Geometry) -> bool:
    if isinstance(geometry, ArchWaveguide):
        return True
    if isinstance(geometry, Translate):
        return _geometry_contains_arch_waveguide(geometry.geometry)
    if isinstance(geometry, Difference):
        return _geometry_contains_arch_waveguide(geometry.base) or _geometry_contains_arch_waveguide(
            geometry.tool
        )
    if isinstance(geometry, (Union, Intersection)):
        return _geometry_contains_arch_waveguide(geometry.a) or _geometry_contains_arch_waveguide(
            geometry.b
        )
    return False


def _sanitize_csg_mesh_options(
    opts: MeshOptions,
    geometry: Geometry,
    *,
    context: str,
) -> MeshOptions:
    resolved = _sanitize_volume_mesh_options(opts, context=context)
    if (
        _geometry_contains_arch_waveguide(geometry)
        and resolved.algorithm_3d == ALGO_3D_DELAUNAY
    ):
        emit_progress(
            f"Gmsh: {context}: algorithm_3d=1 (Delaunay) fails boundary recovery "
            "for lofted ArchWaveguide solids in Gmsh 4.15; falling back to HXT"
        )
        return _dc_replace(resolved, algorithm_3d=ALGO_3D_HXT)
    return resolved


def generate_mesh(
    geometry: Geometry,
    hmax: float | None = None,
    order: int = 1,
    air_padding: float = 0.0,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
    maximum_element_size: float | None = None,
) -> MeshData:
    """Generate a tetrahedral mesh for the given geometry.

    Args:
        geometry: Fullmag geometry descriptor.
        maximum_element_size: Maximum element size (SI metres). ``hmax`` is
                accepted as a compatibility alias.
        order: Finite-element order (1 = linear, 2 = quadratic).
        air_padding: Scalar padding factor (legacy). Use *airbox* instead.
        airbox: Structured airbox configuration. When given, takes precedence
                over *air_padding*.
        options: Advanced Gmsh options (algorithms, quality, size fields).
    """
    resolved_hmax = maximum_element_size if maximum_element_size is not None else hmax
    if resolved_hmax is None:
        raise TypeError("generate_mesh() requires maximum_element_size")
    resolved_airbox = airbox or (
        AirboxOptions(padding_factor=air_padding) if air_padding > 0 else None
    )
    opts = _sanitize_volume_mesh_options(
        options or MeshOptions(),
        context="volume mesh dispatch",
    )

    # ── Swept mesh dispatch ──
    if should_use_swept(geometry, opts):
        n_layers = opts.through_thickness_elements or 6
        distribution = opts.through_thickness_distribution or "fixed"
        element_ratio = opts.through_thickness_element_ratio or 1.0
        symmetric = opts.through_thickness_symmetric
        recombine = opts.sweep_face_meshing == "quadrilateral"
        emit_progress(
            f"Mesh strategy: swept ({n_layers} layers, {distribution}) "
            f"for '{getattr(geometry, 'geometry_name', type(geometry).__name__)}'"
        )
        return generate_swept_mesh(
            geometry, resolved_hmax, n_layers,
            order=order, distribution=distribution,
            element_ratio=element_ratio, symmetric=symmetric,
            recombine=recombine, airbox=resolved_airbox, options=opts,
        )

    if isinstance(geometry, Box):
        return generate_box_mesh(geometry.size, hmax=resolved_hmax, order=order, airbox=resolved_airbox, options=opts)
    if isinstance(geometry, Cylinder):
        return generate_cylinder_mesh(
            geometry.radius,
            geometry.height,
            hmax=resolved_hmax,
            order=order,
            airbox=resolved_airbox,
            options=opts,
        )
    if isinstance(geometry, (Difference, Union, Intersection, Translate, Ellipsoid, Ellipse, ArchWaveguide)):
        # A chain of Translate wrapping an ImportedGeometry cannot go through
        # the OCC CSG pipeline (OCC cannot ingest STL/NPZ sources). Detect this
        # pattern, mesh the imported file directly, and apply the accumulated
        # translation to the resulting mesh nodes instead.
        if isinstance(geometry, Translate):
            offset, inner = _peel_translate_chain(geometry)
            if isinstance(inner, ImportedGeometry):
                mesh = generate_mesh_from_file(
                    inner.source,
                    hmax=resolved_hmax,
                    order=order,
                    airbox=resolved_airbox,
                    scale=inner.scale,
                    options=opts,
                )
                ox, oy, oz = offset
                if ox != 0.0 or oy != 0.0 or oz != 0.0:
                    shift = np.array([ox, oy, oz], dtype=np.float64)
                    mesh = MeshData(
                        nodes=mesh.nodes + shift,
                        elements=mesh.elements,
                        element_markers=mesh.element_markers,
                        boundary_faces=mesh.boundary_faces,
                        boundary_markers=mesh.boundary_markers,
                        quality=mesh.quality,
                    )
                return mesh
        return _generate_csg_mesh(geometry, hmax=resolved_hmax, order=order, airbox=resolved_airbox, options=opts)
    if isinstance(geometry, ImportedGeometry):
        return generate_mesh_from_file(
            geometry.source,
            hmax=resolved_hmax,
            order=order,
            air_padding=air_padding,
            airbox=resolved_airbox,
            scale=geometry.scale,
            options=opts,
        )
    raise TypeError(f"unsupported geometry type: {type(geometry)!r}")


def generate_box_mesh(
    size: tuple[float, float, float],
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    resolved = airbox or (AirboxOptions(padding_factor=air_padding) if air_padding > 0 else None)
    resolved_scaled = _scale_airbox_options(resolved, 1e6)
    opts = _sanitize_volume_mesh_options(
        options or MeshOptions(),
        context="box mesh",
    )
    SCALE = 1e6  # m → µm for better OCC robustness on thin nano-scale films
    emit_progress("Gmsh: generating box geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_box")
        sx, sy, sz = [dim * SCALE for dim in size]
        gmsh.model.occ.addBox(-sx / 2.0, -sy / 2.0, -sz / 2.0, sx, sy, sz)
        gmsh.model.occ.synchronize()
        has_airbox = resolved_scaled is not None
        airbox_field_ids: list[int] = []
        if has_airbox:
            emit_progress("Gmsh: adding airbox domain")
            airbox_field = _add_airbox_and_fragment(
                gmsh, [(3, 1)], resolved_scaled, hmax * SCALE,
            )
            if airbox_field is not None:
                airbox_field_ids.append(airbox_field)
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(
            gmsh,
            hmax * SCALE,
            order,
            opts,
            hscale=SCALE,
            preexisting_field_ids=airbox_field_ids,
            airbox_maximum_element_size=resolved_scaled.maximum_element_size if resolved_scaled is not None and resolved_scaled.maximum_element_size is not None else None,
        )
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, has_physical_groups=has_airbox, per_domain_quality=_pdq)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=mesh.quality,
            per_domain_quality=mesh.per_domain_quality,
        )
    finally:  # pragma: no branch
        gmsh.finalize()


def generate_cylinder_mesh(
    radius: float,
    height: float,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    resolved = airbox or (AirboxOptions(padding_factor=air_padding) if air_padding > 0 else None)
    resolved_scaled = _scale_airbox_options(resolved, 1e6)
    opts = _sanitize_volume_mesh_options(
        options or MeshOptions(),
        context="cylinder mesh",
    )
    SCALE = 1e6  # m → µm for better OCC robustness on thin nano-scale films
    emit_progress("Gmsh: generating cylinder geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_cylinder")
        gmsh.model.occ.addCylinder(0.0, 0.0, -height * SCALE / 2.0, 0.0, 0.0, height * SCALE, radius * SCALE)
        gmsh.model.occ.synchronize()
        has_airbox = resolved_scaled is not None
        airbox_field_ids: list[int] = []
        if has_airbox:
            emit_progress("Gmsh: adding airbox domain")
            airbox_field = _add_airbox_and_fragment(
                gmsh, [(3, 1)], resolved_scaled, hmax * SCALE,
            )
            if airbox_field is not None:
                airbox_field_ids.append(airbox_field)
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(
            gmsh,
            hmax * SCALE,
            order,
            opts,
            hscale=SCALE,
            preexisting_field_ids=airbox_field_ids,
            airbox_maximum_element_size=resolved_scaled.maximum_element_size if resolved_scaled is not None and resolved_scaled.maximum_element_size is not None else None,
        )
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, has_physical_groups=has_airbox, per_domain_quality=_pdq)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=mesh.quality,
            per_domain_quality=mesh.per_domain_quality,
        )
    finally:  # pragma: no branch
        gmsh.finalize()


def generate_difference_mesh(
    geometry: Difference,
    hmax: float,
    order: int = 1,
    options: MeshOptions | None = None,
) -> MeshData:
    """Mesh a CSG Difference via Gmsh OCC boolean cut.

    OCC has numerical precision limits, so we scale geometry from SI metres
    to micrometres (×1e6) for boolean ops, then scale nodes back (×1e-6).
    """
    opts = _sanitize_volume_mesh_options(
        options or MeshOptions(),
        context="difference mesh",
    )
    SCALE = 1e6  # m → µm
    emit_progress("Gmsh: building OCC difference geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_difference")
        base_tags = _add_geometry_to_occ(gmsh, geometry.base, scale=SCALE)
        tool_tags = _add_geometry_to_occ(gmsh, geometry.tool, scale=SCALE)
        gmsh.model.occ.cut(base_tags, tool_tags)
        gmsh.model.occ.synchronize()
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax * SCALE, order, opts, hscale=SCALE)
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, per_domain_quality=_pdq)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        # Scale nodes back to SI metres
        return MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=quality,
            per_domain_quality=_pdq,
        )
    finally:  # pragma: no branch
        gmsh.finalize()


def _generate_csg_mesh(
    geometry: Geometry,
    hmax: float,
    order: int = 1,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Mesh any geometry type via the generic OCC pipeline.

    Uses micrometre scaling (×1e6) for OCC numerical stability.
    """
    opts = _sanitize_csg_mesh_options(
        options or MeshOptions(),
        geometry,
        context="CSG mesh",
    )
    SCALE = 1e6
    airbox_scaled = _scale_airbox_options(airbox, SCALE)
    emit_progress("Gmsh: building OCC geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_csg")
        mag_tags = _add_geometry_to_occ(gmsh, geometry, scale=SCALE)
        gmsh.model.occ.synchronize()
        has_airbox = airbox_scaled is not None
        airbox_field_ids: list[int] = []
        if has_airbox:
            emit_progress("Gmsh: adding airbox domain")
            airbox_field = _add_airbox_and_fragment(
                gmsh, mag_tags, airbox_scaled, hmax * SCALE,
            )
            if airbox_field is not None:
                airbox_field_ids.append(airbox_field)
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(
            gmsh,
            hmax * SCALE,
            order,
            opts,
            hscale=SCALE,
            preexisting_field_ids=airbox_field_ids,
            airbox_maximum_element_size=airbox_scaled.maximum_element_size if airbox_scaled is not None and airbox_scaled.maximum_element_size is not None else None,
        )
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, has_physical_groups=has_airbox, per_domain_quality=_pdq)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=quality,
            per_domain_quality=_pdq,
        )
    finally:  # pragma: no branch
        gmsh.finalize()


def _add_geometry_to_occ(
    gmsh: Any,
    geometry: Geometry,
    scale: float = 1.0,
) -> list[tuple[int, int]]:
    """Add a geometry primitive to the Gmsh OCC kernel.

    Returns list of (dim, tag) tuples suitable for boolean operations.
    Supports recursive CSG nesting.
    All dimensions are multiplied by `scale` before passing to OCC.
    """
    if isinstance(geometry, Box):
        sx, sy, sz = [d * scale for d in geometry.size]
        tag = gmsh.model.occ.addBox(-sx / 2.0, -sy / 2.0, -sz / 2.0, sx, sy, sz)
        return [(3, tag)]
    if isinstance(geometry, Cylinder):
        r = geometry.radius * scale
        h = geometry.height * scale
        tag = gmsh.model.occ.addCylinder(
            0.0, 0.0, -h / 2.0,
            0.0, 0.0, h,
            r,
        )
        return [(3, tag)]
    if isinstance(geometry, Ellipsoid):
        # OCC: create sphere with max radius, then dilate to ellipsoid
        rmax = max(geometry.rx, geometry.ry, geometry.rz) * scale
        tag = gmsh.model.occ.addSphere(0.0, 0.0, 0.0, rmax)
        fx = (geometry.rx * scale) / rmax
        fy = (geometry.ry * scale) / rmax
        fz = (geometry.rz * scale) / rmax
        gmsh.model.occ.dilate([(3, tag)], 0.0, 0.0, 0.0, fx, fy, fz)
        return [(3, tag)]
    if isinstance(geometry, Ellipse):
        # Elliptical cylinder: create circular cylinder, then dilate x/y
        rmax = max(geometry.rx, geometry.ry) * scale
        h = geometry.height * scale
        tag = gmsh.model.occ.addCylinder(
            0.0, 0.0, -h / 2.0,
            0.0, 0.0, h,
            rmax,
        )
        fx = (geometry.rx * scale) / rmax
        fy = (geometry.ry * scale) / rmax
        gmsh.model.occ.dilate([(3, tag)], 0.0, 0.0, 0.0, fx, fy, 1.0)
        return [(3, tag)]
    if isinstance(geometry, ArchWaveguide):
        return add_arch_waveguide_to_occ(gmsh, geometry, scale=scale)
    if isinstance(geometry, Difference):
        base_tags = _add_geometry_to_occ(gmsh, geometry.base, scale=scale)
        tool_tags = _add_geometry_to_occ(gmsh, geometry.tool, scale=scale)
        result, _ = gmsh.model.occ.cut(base_tags, tool_tags)
        return result
    if isinstance(geometry, Union):
        a_tags = _add_geometry_to_occ(gmsh, geometry.a, scale=scale)
        b_tags = _add_geometry_to_occ(gmsh, geometry.b, scale=scale)
        result, _ = gmsh.model.occ.fuse(a_tags, b_tags)
        return result
    if isinstance(geometry, Intersection):
        a_tags = _add_geometry_to_occ(gmsh, geometry.a, scale=scale)
        b_tags = _add_geometry_to_occ(gmsh, geometry.b, scale=scale)
        result, _ = gmsh.model.occ.intersect(a_tags, b_tags)
        return result
    if isinstance(geometry, Translate):
        inner_tags = _add_geometry_to_occ(gmsh, geometry.geometry, scale=scale)
        ox, oy, oz = [d * scale for d in geometry.offset]
        gmsh.model.occ.translate(inner_tags, ox, oy, oz)
        return inner_tags
    if isinstance(geometry, ImportedGeometry):
        # Only CAD formats (STEP/IGES/BREP) can be loaded into the OCC kernel
        # via importShapes. STL and mesh files must go through the GEO pipeline
        # (see generate_mesh for the Translate-over-ImportedGeometry path).
        source = Path(geometry.source)
        suffix = source.suffix.lower()
        if suffix not in {".step", ".stp", ".iges", ".igs", ".brep"}:
            raise TypeError(
                f"ImportedGeometry source '{source.name}' cannot be used inside a CSG "
                f"boolean operation — only STEP, IGES, and BREP files are supported in "
                f"the OCC kernel. For STL sources, wrap the geometry only in Translate "
                f"(not boolean ops) and call geometry.mesh().build() directly."
            )
        tags = gmsh.model.occ.importShapes(str(source))
        # Apply the effective scale (unit-adjusted) via OCC dilate
        raw_scale = geometry.scale
        if isinstance(raw_scale, (int, float)):
            sx = sy = sz = float(raw_scale) * scale
        else:
            sx, sy, sz = (float(c) * scale for c in raw_scale)
        if sx != 1.0 or sy != 1.0 or sz != 1.0:
            gmsh.model.occ.dilate(tags, 0.0, 0.0, 0.0, sx, sy, sz)
        return list(tags)
    raise TypeError(
        f"unsupported geometry type for OCC meshing: {type(geometry)!r}"
    )


def generate_mesh_from_file(
    source: str | Path,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    airbox: AirboxOptions | None = None,
    scale: float | tuple[float, float, float] = 1.0,
    options: MeshOptions | None = None,
) -> MeshData:
    resolved = airbox or (AirboxOptions(padding_factor=air_padding) if air_padding > 0 else None)
    opts = options or MeshOptions()
    path = Path(source)
    suffix = path.suffix.lower()
    scale_xyz = _normalize_scale_xyz(scale)
    source_hmax = _source_hmax_from_scale(hmax, scale_xyz)
    if suffix in {".json", ".npz"}:
        emit_progress(f"Loading pre-generated FEM mesh from {path.name}")
        return _scale_mesh_nodes(MeshData.load(path), scale_xyz)
    if suffix in {".msh", ".vtk", ".vtu", ".xdmf"}:
        emit_progress(f"Loading external mesh file {path.name}")
        return _scale_mesh_nodes(_read_mesh_file(path), scale_xyz)
    if suffix in {".step", ".stp", ".iges", ".igs"}:
        emit_progress(f"Gmsh: meshing CAD file {path.name}")
        return _mesh_cad_file(
            path,
            hmax=source_hmax,
            order=order,
            airbox=resolved,
            scale_xyz=scale_xyz,
            options=opts,
        )
    if suffix == ".stl":
        emit_progress(f"Gmsh: meshing STL surface {path.name}")
        return _mesh_stl_surface(
            path,
            hmax=source_hmax,
            order=order,
            airbox=resolved,
            scale_xyz=scale_xyz,
            options=opts,
        )
    raise ValueError(f"unsupported mesh/geometry source format: {path.suffix}")


def _mesh_cad_file(
    path: Path,
    hmax: float,
    order: int,
    airbox: AirboxOptions | None = None,
    scale_xyz: NDArray[np.float64] = np.ones(3),
    options: MeshOptions | None = None,
) -> MeshData:
    opts = _sanitize_volume_mesh_options(
        options or MeshOptions(),
        context=f"CAD mesh ({path.name})",
    )
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add(path.stem)
        emit_progress("Gmsh: importing CAD shapes")
        gmsh.model.occ.importShapes(str(path))
        gmsh.model.occ.synchronize()
        has_airbox = airbox is not None
        airbox_field_ids: list[int] = []
        if has_airbox:
            emit_progress("Gmsh: adding airbox domain")
            volumes = gmsh.model.getEntities(dim=3)
            airbox_field = _add_airbox_and_fragment(gmsh, volumes, airbox, hmax)
            if airbox_field is not None:
                airbox_field_ids.append(airbox_field)
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax, order, opts, preexisting_field_ids=airbox_field_ids, airbox_maximum_element_size=airbox.maximum_element_size if airbox is not None else None)
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _scale_mesh_nodes(
            _extract_mesh_data(gmsh, quality=quality, has_physical_groups=has_airbox, per_domain_quality=_pdq),
            scale_xyz,
        )
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return mesh
    finally:  # pragma: no branch
        gmsh.finalize()


def _build_stl_volume_model(
    gmsh: object,
    path: Path,
) -> tuple[list[int], list[int]]:
    """Classify an STL surface into watertight volume model(s) via the GEO kernel.

    Shared by both initial meshing (``_mesh_stl_surface``) and adaptive
    remeshing (``_remesh_imported``).  After return, the Gmsh model contains
    one or more volume entities ready for ``generate(3)``.

    When the STL contains multiple disconnected closed surfaces (e.g. two
    nanoflower bodies concatenated into a single file), each connected
    component is turned into a separate GEO volume.

    Returns:
        A tuple ``(volume_tags, surface_tags)`` of the created GEO entities.
        *volume_tags* may contain more than one tag for multi-body STLs.
        These are needed by :func:`_add_airbox_geo` to build the airbox
        shell around the body.
    """
    from collections import defaultdict

    emit_progress("Gmsh: importing STL surface")
    gmsh.merge(str(path))
    angle = 40.0 * math.pi / 180.0
    emit_progress("Gmsh: classifying STL surfaces")
    # Gmsh reparametrization fragments thin lofted STL surfaces into artificial
    # patches; keep physical facet classification for edge-distance fields.
    gmsh.model.mesh.classifySurfaces(
        angle,
        boundary=True,
        forReparametrization=False,
        curveAngle=math.pi,
    )
    emit_progress("Gmsh: creating geometry from classified surfaces")
    gmsh.model.mesh.createGeometry()
    surfaces = gmsh.model.getEntities(2)
    if not surfaces:
        raise ValueError(f"failed to recover closed surfaces from STL: {path}")
    surface_tags = [tag for _, tag in surfaces]

    # --- detect connected components via shared edges (union-find) ---
    edge_to_surfs: dict[int, set[int]] = defaultdict(set)
    for _, stag in surfaces:
        edges = gmsh.model.getBoundary([(2, stag)], oriented=False)
        for _, etag in edges:
            edge_to_surfs[abs(etag)].add(stag)

    parent: dict[int, int] = {t: t for t in surface_tags}

    def _find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a: int, b: int) -> None:
        ra, rb = _find(a), _find(b)
        if ra != rb:
            parent[ra] = rb

    for _edge_tag, stags in edge_to_surfs.items():
        tags_list = list(stags)
        for i in range(1, len(tags_list)):
            _union(tags_list[0], tags_list[i])

    components: dict[int, list[int]] = defaultdict(list)
    for t in surface_tags:
        components[_find(t)].append(t)

    # --- create one volume per connected component ---
    volume_tags: list[int] = []
    if len(components) == 1:
        # Single body — simple path (preserves original behaviour)
        sl = gmsh.model.geo.addSurfaceLoop(surface_tags)
        volume_tags.append(gmsh.model.geo.addVolume([sl]))
    else:
        for _root, comp_surfs in components.items():
            sl = gmsh.model.geo.addSurfaceLoop(comp_surfs)
            volume_tags.append(gmsh.model.geo.addVolume([sl]))

    gmsh.model.geo.synchronize()
    return volume_tags, surface_tags


def _mesh_stl_surface(
    path: Path,
    hmax: float,
    order: int,
    airbox: AirboxOptions | None = None,
    scale_xyz: NDArray[np.float64] = np.ones(3),
    options: MeshOptions | None = None,
) -> MeshData:
    opts = options or MeshOptions()
    stl_opts = _sanitize_volume_mesh_options(opts, context="STL mesh")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add(path.stem)
        body_vols, body_surfs = _build_stl_volume_model(gmsh, path)
        has_airbox = airbox is not None
        airbox_field_ids: list[int] = []
        if has_airbox:
            emit_progress("Gmsh: adding airbox domain")
            airbox_field = _add_airbox_geo(gmsh, body_vols, body_surfs, airbox, hmax)
            if airbox_field is not None:
                airbox_field_ids.append(airbox_field)
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(
            gmsh,
            hmax,
            order,
            stl_opts,
            preexisting_field_ids=airbox_field_ids,
            airbox_maximum_element_size=airbox.maximum_element_size if airbox is not None else None,
        )
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, stl_opts)
        quality, _pdq = (
            _extract_quality_metrics(gmsh, stl_opts) if stl_opts.compute_quality else (None, None)
        )
        mesh = _scale_mesh_nodes(
            _extract_mesh_data(gmsh, quality=quality, has_physical_groups=has_airbox, per_domain_quality=_pdq),
            scale_xyz,
        )
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return mesh
    finally:  # pragma: no branch
        gmsh.finalize()


# ---------------------------------------------------------------------------
# Component-aware shared-domain mesh generation (Commit 1)
# ---------------------------------------------------------------------------


def _build_stl_volume_model_for_component(
    gmsh: Any,
    path: Path,
) -> tuple[list[int], list[int]]:
    """Import a single-component STL and create GEO volume(s).

    Similar to ``_build_stl_volume_model`` but designed for use in a
    multi-component workflow where each component is imported separately.
    """
    from collections import defaultdict

    existing_surfs = {tag for _, tag in gmsh.model.getEntities(2)}

    gmsh.merge(str(path))
    angle = 40.0 * math.pi / 180.0
    # Gmsh reparametrization fragments thin lofted STL surfaces into artificial
    # patches; keep physical facet classification for edge-distance fields.
    gmsh.model.mesh.classifySurfaces(
        angle,
        boundary=True,
        forReparametrization=False,
        curveAngle=math.pi,
    )
    gmsh.model.mesh.createGeometry()
    surfaces = gmsh.model.getEntities(2)
    if not surfaces:
        raise ValueError(f"failed to recover closed surfaces from STL: {path}")
    surface_tags = [tag for _, tag in surfaces if tag not in existing_surfs]

    edge_to_surfs: dict[int, set[int]] = defaultdict(set)
    for stag in surface_tags:
        edges = gmsh.model.getBoundary([(2, stag)], oriented=False)
        for _, etag in edges:
            edge_to_surfs[abs(etag)].add(stag)

    parent: dict[int, int] = {t: t for t in surface_tags}

    def _find(x: int) -> int:
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def _union(a: int, b: int) -> None:
        ra, rb = _find(a), _find(b)
        if ra != rb:
            parent[ra] = rb

    for _edge_tag, stags in edge_to_surfs.items():
        tags_list = list(stags)
        for i in range(1, len(tags_list)):
            _union(tags_list[0], tags_list[i])

    components: dict[int, list[int]] = defaultdict(list)
    for t in surface_tags:
        components[_find(t)].append(t)

    volume_tags: list[int] = []
    if len(components) == 1:
        sl = gmsh.model.geo.addSurfaceLoop(surface_tags)
        volume_tags.append(gmsh.model.geo.addVolume([sl]))
    else:
        for _root, comp_surfs in components.items():
            sl = gmsh.model.geo.addSurfaceLoop(comp_surfs)
            volume_tags.append(gmsh.model.geo.addVolume([sl]))

    gmsh.model.geo.synchronize()
    return volume_tags, surface_tags


def generate_shared_domain_mesh_from_components(
    components: list[ComponentDescriptor],
    *,
    hmax: float,
    order: int = 1,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> SharedDomainMeshResult:
    """Generate a shared-domain FEM mesh with per-component identity preserved.

    Instead of concatenating all geometries into one anonymous STL file, each
    component is imported as a separate set of GEO entities.  The resulting
    volume → geometry_name mapping is established *before* mesh generation,
    giving downstream code a stable identity without bbox/centroid heuristics.
    """
    if not components:
        raise ValueError("at least one component is required")

    opts = options or MeshOptions()
    shared_stl_opts = _sanitize_volume_mesh_options(
        opts,
        context="shared-domain STL mesh",
    )
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("shared_domain_components")

        all_body_vols: list[int] = []
        all_body_surfs: list[int] = []
        component_marker_tags: dict[str, int] = {}
        component_volume_tags: dict[str, list[int]] = {}
        component_surface_tags: dict[str, list[int]] = {}

        for component_index, comp in enumerate(components, start=1):
            # Record existing entities before merge so we can detect new ones
            existing_surfs = {tag for _, tag in gmsh.model.getEntities(2)}
            existing_vols = {tag for _, tag in gmsh.model.getEntities(3)}

            comp_vols, comp_surfs = _build_stl_volume_model_for_component(
                gmsh, comp.stl_path,
            )

            # Isolate tags actually created for this component
            new_surfs = [t for t in comp_surfs if t not in existing_surfs]
            new_vols = [t for t in comp_vols if t not in existing_vols]

            component_marker_tags[comp.geometry_name] = component_index
            component_volume_tags[comp.geometry_name] = new_vols
            component_surface_tags[comp.geometry_name] = new_surfs
            all_body_vols.extend(new_vols)
            all_body_surfs.extend(new_surfs)

            emit_progress(
                f"Component '{comp.geometry_name}': "
                f"{len(new_vols)} volume(s), {len(new_surfs)} surface(s)"
            )

        has_airbox = airbox is not None
        airbox_field_ids: list[int] = []
        airbox_lower_bound_field_ids: list[int] = []
        interface_surface_tags: list[int] = list(all_body_surfs)
        outer_boundary_surface_tags: list[int] = []

        if has_airbox:
            emit_progress("Gmsh: adding airbox domain around components")
            airbox_field = _add_airbox_geo(
                gmsh,
                all_body_vols,
                all_body_surfs,
                airbox,
                hmax,
                component_volume_groups=component_volume_tags,
                component_surface_groups=component_surface_tags,
            )
            if airbox_field is not None:
                airbox_field_ids.append(airbox_field)
            air_volume_tags = _airbox_volume_tags_for_components(gmsh, component_volume_tags)
            clamp_max_fields, clamp_min_fields = _add_airbox_volume_clamp_fields(
                gmsh,
                air_volume_tags=air_volume_tags,
                airbox=airbox,
            )
            airbox_field_ids.extend(clamp_max_fields)
            airbox_lower_bound_field_ids.extend(clamp_min_fields)
            # The airbox creates 6 outer boundary surfaces — collect them
            for _, phys_tag in gmsh.model.getPhysicalGroups(dim=2):
                if phys_tag == airbox.boundary_marker:
                    entities = gmsh.model.getEntitiesForPhysicalGroup(2, phys_tag)
                    outer_boundary_surface_tags = list(entities)
                    break

        emit_progress("Gmsh: generating 3D tetrahedral mesh (component-aware)")
        application_report = _apply_mesh_options(
            gmsh,
            hmax,
            order,
            shared_stl_opts,
            preexisting_field_ids=airbox_field_ids,
            preexisting_lower_bound_field_ids=airbox_lower_bound_field_ids,
            component_volume_tags=component_volume_tags,
            component_surface_tags=component_surface_tags,
            airbox_maximum_element_size=airbox.maximum_element_size if airbox is not None else None,
        )
        orphan_entities = collect_orphan_entity_diagnostics(gmsh)
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, shared_stl_opts)
        quality, per_domain_quality = (
            _extract_quality_metrics(gmsh, shared_stl_opts)
            if shared_stl_opts.compute_quality
            else (None, None)
        )
        mesh = _extract_mesh_data(
            gmsh,
            quality=quality,
            has_physical_groups=has_airbox,
            per_domain_quality=per_domain_quality,
        )
        emit_progress(
            f"Gmsh: component-aware mesh ready — "
            f"{mesh.n_nodes} nodes, {mesh.n_elements} elements, "
            f"{mesh.n_boundary_faces} boundary faces"
        )
        return SharedDomainMeshResult(
            mesh=mesh,
            component_marker_tags=component_marker_tags,
            component_volume_tags=component_volume_tags,
            component_surface_tags=component_surface_tags,
            interface_surface_tags=interface_surface_tags,
            outer_boundary_surface_tags=outer_boundary_surface_tags,
            selector_resolution=application_report.selector_resolution,
            orphan_entities=orphan_entities,
        )
    finally:
        gmsh.finalize()
