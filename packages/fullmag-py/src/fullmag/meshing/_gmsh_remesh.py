from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress
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

from ._gmsh_types import MeshData, MeshOptions, SizeFieldData
from ._gmsh_infra import (
    _import_gmsh,
    _configure_gmsh_threads,
    _GmshProgressLogger,
    _normalize_scale_xyz,
    _source_hmax_from_scale,
    _scale_mesh_nodes,
)
from ._gmsh_extraction import (
    _extract_mesh_data,
    _extract_quality_metrics,
)
from ._gmsh_fields import _apply_mesh_options, _apply_post_mesh_options
from ._gmsh_generators import _add_geometry_to_occ, _build_stl_volume_model


def _apply_postview_background_mesh(
    gmsh: Any,
    sf: SizeFieldData,
    coord_scale: float = 1.0,
) -> None:
    """Inject a PostView-based background mesh size field into Gmsh.

    Creates a Gmsh view with scattered-point (SP) data from the nodal
    size field computed by the Rust error estimator, then registers a
    PostView field as the background mesh.

    Disables all other automatic size sources so the PostView controls
    element sizes exclusively.

    Args:
        gmsh: Initialised Gmsh module.
        sf: Nodal size field (coordinates + h values).
        coord_scale: Multiplier applied to node coordinates and h values
                     to match the internal Gmsh model scale (e.g. 1e6
                     for µm-scaled OCC models).
    """
    # Disable competing size sources
    gmsh.option.setNumber("Mesh.MeshSizeExtendFromBoundary", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromPoints", 0)
    gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)

    # Build list data: each SP entry = [x, y, z, h]
    view_tag = gmsh.view.add("afem_size_field")
    n = sf.node_coords.shape[0]
    # addListData expects list of lists: each sub-list = [x, y, z, val]
    data: list[list[float]] = []
    for i in range(n):
        x, y, z = sf.node_coords[i] * coord_scale
        h = float(sf.h_values[i]) * coord_scale
        data.append([x, y, z, h])
    gmsh.view.addListData(view_tag, "SP", n, data)

    # Create PostView field and set as background mesh
    fid = gmsh.model.mesh.field.add("PostView")
    gmsh.model.mesh.field.setNumber(fid, "ViewTag", view_tag)
    gmsh.model.mesh.field.setAsBackgroundMesh(fid)


def remesh_with_size_field(
    geometry: "Geometry",
    size_field: SizeFieldData,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    options: MeshOptions | None = None,
) -> MeshData:
    """Re-mesh geometry using an adaptive size field from error estimation.

    This is the primary entry point for the AFEM remesh step.  It
    reconstructs the OCC geometry, injects a PostView background mesh
    derived from the Rust-side nodal size field, and generates a new
    tetrahedral mesh conforming to those target element sizes.

    Args:
        geometry: Fullmag geometry descriptor (same as for generate_mesh).
        size_field: Nodal size field produced by the error estimator.
        hmax: Fallback maximum element size (SI metres). Used as upper
              bound and for CharacteristicLengthMax.
        order: Mesh element order (always 1 for current pipeline).
        air_padding: Reserved for future air-box meshing.
        options: Optional advanced Gmsh options.
    """
    opts = options or MeshOptions()

    # Delegate to type-specific remeshers that share the OCC pipeline
    if isinstance(geometry, Box):
        return _remesh_box(geometry, size_field, hmax, order, air_padding, opts)
    if isinstance(geometry, Cylinder):
        return _remesh_cylinder(geometry, size_field, hmax, order, air_padding, opts)
    if isinstance(geometry, (Difference, Union, Intersection, Translate, Ellipsoid, Ellipse)):
        return _remesh_csg(geometry, size_field, hmax, order, opts)
    if isinstance(geometry, ImportedGeometry):
        return _remesh_imported(geometry, size_field, hmax, order, air_padding, opts)
    raise TypeError(f"unsupported geometry type for adaptive remeshing: {type(geometry)!r}")


def _remesh_box(
    geometry: Box,
    sf: SizeFieldData,
    hmax: float,
    order: int,
    air_padding: float,
    opts: MeshOptions,
) -> MeshData:
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_box_afem")
        emit_progress("AFEM: building OCC box geometry")
        sx, sy, sz = geometry.size
        gmsh.model.occ.addBox(-sx / 2.0, -sy / 2.0, -sz / 2.0, sx, sy, sz)
        gmsh.model.occ.synchronize()
        emit_progress("AFEM: applying adaptive size field")
        _apply_mesh_options(gmsh, hmax, order, opts)
        _apply_postview_background_mesh(gmsh, sf)
        emit_progress("AFEM: generating adaptive 3D mesh")
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, per_domain_quality=_pdq)
        emit_progress(
            f"AFEM: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements"
        )
        return mesh
    finally:
        gmsh.finalize()


def _remesh_cylinder(
    geometry: Cylinder,
    sf: SizeFieldData,
    hmax: float,
    order: int,
    air_padding: float,
    opts: MeshOptions,
) -> MeshData:
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_cylinder_afem")
        emit_progress("AFEM: building OCC cylinder geometry")
        axis = geometry.axis
        base = tuple(-0.5 * geometry.height * component for component in axis)
        direction = tuple(geometry.height * component for component in axis)
        gmsh.model.occ.addCylinder(
            base[0], base[1], base[2],
            direction[0], direction[1], direction[2],
            geometry.radius,
        )
        gmsh.model.occ.synchronize()
        emit_progress("AFEM: applying adaptive size field")
        _apply_mesh_options(gmsh, hmax, order, opts)
        _apply_postview_background_mesh(gmsh, sf)
        emit_progress("AFEM: generating adaptive 3D mesh")
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, per_domain_quality=_pdq)
        emit_progress(
            f"AFEM: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements"
        )
        return mesh
    finally:
        gmsh.finalize()


def _remesh_csg(
    geometry: "Geometry",
    sf: SizeFieldData,
    hmax: float,
    order: int,
    opts: MeshOptions,
) -> MeshData:
    SCALE = 1e6
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_csg_afem")
        emit_progress("AFEM: building OCC geometry")
        _add_geometry_to_occ(gmsh, geometry, scale=SCALE)
        gmsh.model.occ.synchronize()
        emit_progress("AFEM: applying adaptive size field (µm-scaled)")
        _apply_mesh_options(gmsh, hmax * SCALE, order, opts, hscale=SCALE)
        _apply_postview_background_mesh(gmsh, sf, coord_scale=SCALE)
        emit_progress("AFEM: generating adaptive 3D mesh")
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _extract_mesh_data(gmsh, quality=quality, per_domain_quality=_pdq)
        emit_progress(
            f"AFEM: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements"
        )
        return MeshData.from_legacy_tet4(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=quality,
            per_domain_quality=_pdq,
        )
    finally:
        gmsh.finalize()


def _remesh_imported(
    geometry: "ImportedGeometry",
    sf: SizeFieldData,
    hmax: float,
    order: int,
    air_padding: float,
    opts: MeshOptions,
) -> MeshData:
    path = Path(geometry.source)
    suffix = path.suffix.lower()
    scale_xyz = _normalize_scale_xyz(geometry.scale)
    source_hmax = _source_hmax_from_scale(hmax, scale_xyz)
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add(path.stem + "_afem")
        if suffix in {".step", ".stp", ".iges", ".igs"}:
            emit_progress("AFEM: importing CAD shapes")
            gmsh.model.occ.importShapes(str(path))
            gmsh.model.occ.synchronize()
        elif suffix == ".stl":
            emit_progress("AFEM: importing STL surface")
            _build_stl_volume_model(gmsh, path)  # return values unused here
        else:
            raise ValueError(
                f"adaptive remeshing from file format {suffix!r} not supported; "
                "use .step/.stp/.iges/.igs/.stl"
            )
        emit_progress("AFEM: applying adaptive size field")
        _apply_mesh_options(gmsh, source_hmax, order, opts)
        # Size field coordinates are in SI; scale to source space
        inv_scale = 1.0 / float(np.max(scale_xyz[scale_xyz > 0]))
        _apply_postview_background_mesh(gmsh, sf, coord_scale=inv_scale)
        emit_progress("AFEM: generating adaptive 3D mesh")
        with _GmshProgressLogger(gmsh):
            gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality, _pdq = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else (None, None)
        mesh = _scale_mesh_nodes(_extract_mesh_data(gmsh, quality=quality, per_domain_quality=_pdq), scale_xyz)
        emit_progress(
            f"AFEM: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements"
        )
        return mesh
    finally:
        gmsh.finalize()


# ---------------------------------------------------------------------------
# Air-box mesh generation for Poisson demag (S01)
# ---------------------------------------------------------------------------
