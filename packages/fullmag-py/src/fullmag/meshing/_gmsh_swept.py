"""Swept (extruded) mesh generation for thin-film and slab geometries.

Implements structured through-thickness meshing via Gmsh ``extrude()`` API
with explicit layer count control.  This produces prism elements (from
triangular source faces) or hexahedral elements (from quad source faces),
giving deterministic control over the number of element layers in the sweep
direction — something that free tetrahedral meshing cannot guarantee.

Key concepts (following COMSOL terminology):
  - **source face**: the 2D face that is meshed first (triangles or quads).
  - **destination face**: the face produced by extrusion on the opposite end.
  - **sweep direction**: the extrusion axis (typically the thin axis).
  - **distribution**: how layers are spaced — fixed uniform, linear grading,
    or exponential grading.

References:
  - COMSOL Learning Center, "Fundamentals of Swept Meshing"
  - Gmsh manual §6.3, ``gmsh.model.geo.extrude``
"""

from __future__ import annotations

import math
import tempfile
from pathlib import Path
from typing import Any, Literal

import numpy as np
from numpy.typing import NDArray

from fullmag._progress import emit_progress
from fullmag.model.geometry import ArchWaveguide, Box, Cylinder, Geometry

from ._gmsh_types import (
    AirboxOptions,
    MeshData,
    MeshOptions,
    MeshQualityReport,
)
from ._gmsh_infra import (
    _import_gmsh,
    _configure_gmsh_threads,
    _GmshProgressLogger,
)
from ._gmsh_extraction import _extract_quality_metrics
from ._gmsh_fields import _apply_mesh_options


# ---------------------------------------------------------------------------
# Sweepability classifier
# ---------------------------------------------------------------------------

SWEEP_STRATEGY_PRISM = "swept_prism"
SWEEP_STRATEGY_HEX = "swept_hex"
SWEEP_STRATEGY_AUTO = "auto"
SWEEP_STRATEGY_FREE_TET = "free_tetrahedral"

DISTRIBUTION_FIXED = "fixed"
DISTRIBUTION_LINEAR = "linear"
DISTRIBUTION_EXPONENTIAL = "exponential"


class SweepabilityResult:
    """Result of checking whether a geometry is sweepable."""

    __slots__ = (
        "sweepable",
        "thin_axis",
        "thickness",
        "aspect_ratio",
        "reason",
    )

    def __init__(
        self,
        sweepable: bool,
        thin_axis: int | None = None,
        thickness: float | None = None,
        aspect_ratio: float | None = None,
        reason: str = "",
    ) -> None:
        self.sweepable = sweepable
        self.thin_axis = thin_axis
        self.thickness = thickness
        self.aspect_ratio = aspect_ratio
        self.reason = reason


def classify_sweepability(geometry: Geometry) -> SweepabilityResult:
    """Classify whether *geometry* can be swept-meshed.

    Currently supports:
    - ``Box`` with aspect ratio > 2 in any axis
    - ``Cylinder`` where height ≪ diameter (thin disk)

    Returns a :class:`SweepabilityResult` with diagnostics.
    """
    if isinstance(geometry, Cylinder):
        h = geometry.height
        d = 2.0 * geometry.radius
        ar = d / h if h > 0 else float("inf")
        if ar >= 2.0:
            return SweepabilityResult(
                sweepable=True,
                thin_axis=2,  # Z axis
                thickness=h,
                aspect_ratio=ar,
                reason=f"Thin disk: diameter/height={ar:.1f}",
            )
        return SweepabilityResult(
            sweepable=False,
            thin_axis=None,
            thickness=h,
            aspect_ratio=ar,
            reason=f"Cylinder aspect ratio {ar:.1f} < 2.0; not a thin disk",
        )

    if isinstance(geometry, Box):
        sx, sy, sz = geometry.size
        dims = [sx, sy, sz]
        min_dim = min(dims)
        max_dim = max(dims)
        thin_axis = dims.index(min_dim)
        ar = max_dim / min_dim if min_dim > 0 else float("inf")
        if ar >= 2.0:
            return SweepabilityResult(
                sweepable=True,
                thin_axis=thin_axis,
                thickness=min_dim,
                aspect_ratio=ar,
                reason=f"Thin slab: axis={thin_axis}, max/min={ar:.1f}",
            )
        return SweepabilityResult(
            sweepable=False,
            thin_axis=None,
            thickness=min_dim,
            aspect_ratio=ar,
            reason=f"Box aspect ratio {ar:.1f} < 2.0; roughly cubic",
        )

    if isinstance(geometry, ArchWaveguide):
        thickness = geometry.height
        lateral_size = max(geometry.length, geometry.width, abs(geometry.arch_height) + thickness)
        ar = lateral_size / thickness if thickness > 0 else float("inf")
        if ar >= 2.0:
            return SweepabilityResult(
                sweepable=True,
                thin_axis=2,
                thickness=thickness,
                aspect_ratio=ar,
                reason=f"Thin arch waveguide: lateral/thickness={ar:.1f}",
            )
        return SweepabilityResult(
            sweepable=False,
            thin_axis=None,
            thickness=thickness,
            aspect_ratio=ar,
            reason=f"ArchWaveguide aspect ratio {ar:.1f} < 2.0; not a thin ribbon",
        )

    return SweepabilityResult(
        sweepable=False,
        reason=f"Geometry type {type(geometry).__name__} not yet supported for swept meshing",
    )


# ---------------------------------------------------------------------------
# Distribution helpers
# ---------------------------------------------------------------------------

def _compute_layer_heights(
    n_layers: int,
    total_thickness: float,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
) -> list[float]:
    """Compute normalised layer heights for the extrusion.

    Returns a list of *n_layers* fractional heights that sum to 1.0.
    Gmsh ``extrude()`` expects cumulative normalised heights.
    """
    if n_layers < 1:
        raise ValueError("n_layers must be >= 1")

    if distribution == DISTRIBUTION_FIXED or element_ratio == 1.0:
        return [1.0 / n_layers] * n_layers

    if symmetric:
        # Mirror grading: fine at both faces, coarser in center.
        half_n = n_layers // 2
        remainder = n_layers - 2 * half_n
        half_heights = _compute_layer_heights(
            half_n, total_thickness / 2.0, distribution, element_ratio, symmetric=False,
        )
        result = half_heights[:]
        if remainder > 0:
            result.append(1.0 / n_layers)
        result.extend(reversed(half_heights))
        total = sum(result)
        return [h / total for h in result]

    if distribution == DISTRIBUTION_LINEAR:
        # Linear grading: height_i = 1 + (ratio-1) * i / (n-1)
        if n_layers == 1:
            return [1.0]
        raw = [1.0 + (element_ratio - 1.0) * i / (n_layers - 1) for i in range(n_layers)]
        total = sum(raw)
        return [h / total for h in raw]

    if distribution == DISTRIBUTION_EXPONENTIAL:
        # Geometric grading: height_i = ratio^i
        raw = [element_ratio ** i for i in range(n_layers)]
        total = sum(raw)
        return [h / total for h in raw]

    # Fallback: uniform
    return [1.0 / n_layers] * n_layers


# ---------------------------------------------------------------------------
# Swept mesh generators
# ---------------------------------------------------------------------------

def generate_swept_cylinder_mesh(
    radius: float,
    height: float,
    hmax: float,
    n_layers: int,
    *,
    order: int = 1,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
    recombine: bool = False,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Generate a swept (extruded) mesh for a thin cylinder.

    Builds a circular disk (source face) at z = -height/2, meshes it with
    triangles (or quads if *recombine*), then extrudes upward by *height*
    with *n_layers* structured layers.

    Args:
        radius: Cylinder radius (SI metres).
        height: Cylinder height / thickness (SI metres).
        hmax: Maximum element size on the source face (SI metres).
        n_layers: Number of element layers through thickness.
        distribution: Layer spacing: "fixed", "linear", "exponential".
        element_ratio: Grading ratio for non-uniform distributions.
        symmetric: Mirror grading about the mid-plane.
        recombine: If True, use quads on source face → hexahedral elements.
        airbox: Optional airbox (currently triggers fallback to tet).
        options: Additional Gmsh options.
    """
    opts = options or MeshOptions()
    SCALE = 1e6  # m → µm

    if airbox is not None:
        emit_progress(
            "Gmsh swept: airbox requested with swept mesh — "
            "falling back to free tetrahedral for combined domain"
        )
        from ._gmsh_generators import generate_cylinder_mesh
        return generate_cylinder_mesh(
            radius, height, hmax, order=order, airbox=airbox, options=options,
        )

    layer_heights = _compute_layer_heights(
        n_layers, height, distribution, element_ratio, symmetric,
    )
    # Gmsh extrude expects cumulative normalised heights
    cumulative = []
    acc = 0.0
    for h in layer_heights:
        acc += h
        cumulative.append(acc)

    r_scaled = radius * SCALE
    h_scaled = height * SCALE
    hmax_scaled = hmax * SCALE

    emit_progress(
        f"Gmsh swept: cylinder r={radius:.2e}, h={height:.2e}, "
        f"{n_layers} layers ({distribution})"
    )

    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_swept_cylinder")

        # Build source face at z = -h/2 as a disk via GEO kernel.
        # GEO extrude supports Layers{} and Recombine natively.
        z_bottom = -h_scaled / 2.0

        # Create a circle arc: center + 4 quarter arcs
        p_center = gmsh.model.geo.addPoint(0.0, 0.0, z_bottom, hmax_scaled)
        p_right = gmsh.model.geo.addPoint(r_scaled, 0.0, z_bottom, hmax_scaled)
        p_top = gmsh.model.geo.addPoint(0.0, r_scaled, z_bottom, hmax_scaled)
        p_left = gmsh.model.geo.addPoint(-r_scaled, 0.0, z_bottom, hmax_scaled)
        p_bot = gmsh.model.geo.addPoint(0.0, -r_scaled, z_bottom, hmax_scaled)

        arc1 = gmsh.model.geo.addCircleArc(p_right, p_center, p_top)
        arc2 = gmsh.model.geo.addCircleArc(p_top, p_center, p_left)
        arc3 = gmsh.model.geo.addCircleArc(p_left, p_center, p_bot)
        arc4 = gmsh.model.geo.addCircleArc(p_bot, p_center, p_right)

        loop = gmsh.model.geo.addCurveLoop([arc1, arc2, arc3, arc4])
        source_surf = gmsh.model.geo.addPlaneSurface([loop])

        if recombine:
            gmsh.model.geo.mesh.setRecombine(2, source_surf)

        gmsh.model.geo.synchronize()

        # Mesh the 2D source face
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax_scaled)
        if opts.hmin is not None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * SCALE)
        gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)

        gmsh.model.mesh.generate(2)

        # Extrude the source face with structured layers
        num_elements_per_layer = [1] * n_layers
        extrude_result = gmsh.model.geo.extrude(
            [(2, source_surf)],
            0.0, 0.0, h_scaled,
            numElements=num_elements_per_layer,
            heights=cumulative,
            recombine=recombine,
        )
        gmsh.model.geo.synchronize()

        # Generate 3D mesh from the extrusion
        gmsh.model.mesh.generate(3)

        # Extract mesh data
        node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
        nodes = np.array(node_coords, dtype=np.float64).reshape(-1, 3) / SCALE

        # Get all 3D elements (prisms = type 6, hexahedra = type 5, tetra = type 4)
        elem_types, elem_tags_list, elem_node_tags_list = gmsh.model.mesh.getElements(3)

        all_elements = []
        for etype, etags, enodes in zip(elem_types, elem_tags_list, elem_node_tags_list):
            gmsh_info = gmsh.model.mesh.getElementProperties(etype)
            nodes_per_elem = gmsh_info[3]
            elem_array = np.array(enodes, dtype=np.int64).reshape(-1, nodes_per_elem)
            all_elements.append((etype, elem_array))

        # Build node tag → index mapping
        tag_to_idx = np.zeros(int(node_tags.max()) + 1, dtype=np.int32)
        for idx, tag in enumerate(node_tags):
            tag_to_idx[int(tag)] = idx

        # Convert prisms/hexes to tetrahedra for MeshData compatibility.
        # Each prism (6 nodes) → 3 tets; each hex (8 nodes) → 5 or 6 tets.
        tet_elements: list[NDArray[np.int32]] = []
        for etype, elem_arr in all_elements:
            remapped = tag_to_idx[elem_arr.astype(np.int64)]
            if etype == 6:  # Prism: 6 nodes
                tet_elements.extend(_split_prism_to_tets(remapped))
            elif etype == 5:  # Hex: 8 nodes
                tet_elements.extend(_split_hex_to_tets(remapped))
            elif etype == 4:  # Already tetra
                tet_elements.append(remapped)

        if len(tet_elements) == 0:
            raise RuntimeError("Swept mesh produced 0 volume elements")

        elements = np.vstack(tet_elements).astype(np.int32)
        element_markers = np.ones(elements.shape[0], dtype=np.int32)

        # Extract boundary faces (triangles on the surface)
        surf_types, surf_tags_list, surf_node_tags_list = gmsh.model.mesh.getElements(2)
        boundary_faces_list: list[NDArray[np.int32]] = []
        for stype, stags, snodes in zip(surf_types, surf_tags_list, surf_node_tags_list):
            info = gmsh.model.mesh.getElementProperties(stype)
            npn = info[3]
            if npn == 3:  # triangles
                tri = np.array(snodes, dtype=np.int64).reshape(-1, 3)
                boundary_faces_list.append(tag_to_idx[tri].astype(np.int32))
            elif npn == 4:  # quads → split into 2 triangles each
                quad = np.array(snodes, dtype=np.int64).reshape(-1, 4)
                remapped = tag_to_idx[quad]
                tri_a = remapped[:, [0, 1, 2]]
                tri_b = remapped[:, [0, 2, 3]]
                boundary_faces_list.append(tri_a.astype(np.int32))
                boundary_faces_list.append(tri_b.astype(np.int32))

        if boundary_faces_list:
            boundary_faces = np.vstack(boundary_faces_list)
        else:
            boundary_faces = np.zeros((0, 3), dtype=np.int32)
        boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)

        quality = None
        if opts.compute_quality:
            quality = _compute_swept_quality(nodes, elements)

        emit_progress(
            f"Gmsh swept: mesh ready — {nodes.shape[0]} nodes, "
            f"{elements.shape[0]} elements ({n_layers} layers), "
            f"{boundary_faces.shape[0]} boundary faces"
        )

        return MeshData(
            nodes=nodes,
            elements=elements,
            element_markers=element_markers,
            boundary_faces=boundary_faces,
            boundary_markers=boundary_markers,
            quality=quality,
        )
    finally:
        gmsh.finalize()


def generate_swept_box_mesh(
    size: tuple[float, float, float],
    hmax: float,
    n_layers: int,
    *,
    thin_axis: int = 2,
    order: int = 1,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
    recombine: bool = False,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Generate a swept mesh for a thin box/slab geometry.

    Meshes the large cross-section face (perpendicular to *thin_axis*),
    then extrudes with *n_layers* structured layers along the thin axis.
    """
    opts = options or MeshOptions()
    SCALE = 1e6

    if airbox is not None:
        emit_progress(
            "Gmsh swept: airbox requested — "
            "falling back to free tetrahedral for combined domain"
        )
        from ._gmsh_generators import generate_box_mesh
        return generate_box_mesh(size, hmax, order=order, airbox=airbox, options=options)

    sx, sy, sz = size
    dims = [sx, sy, sz]
    thickness = dims[thin_axis]

    layer_heights = _compute_layer_heights(
        n_layers, thickness, distribution, element_ratio, symmetric,
    )
    cumulative = []
    acc = 0.0
    for h in layer_heights:
        acc += h
        cumulative.append(acc)

    emit_progress(
        f"Gmsh swept: box {sx:.2e}×{sy:.2e}×{sz:.2e}, "
        f"thin_axis={thin_axis}, {n_layers} layers ({distribution})"
    )

    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        _configure_gmsh_threads(gmsh)
        gmsh.model.add("fullmag_swept_box")

        # Compute source-face rectangle (the two non-thin axes)
        axes = [0, 1, 2]
        face_axes = [a for a in axes if a != thin_axis]
        face_dims = [dims[a] for a in face_axes]

        # Extrusion direction vector
        extrude_dir = [0.0, 0.0, 0.0]
        extrude_dir[thin_axis] = thickness * SCALE

        # Source face origin (bottom of thin axis)
        origin = [-sx * SCALE / 2.0, -sy * SCALE / 2.0, -sz * SCALE / 2.0]

        # Build the 2D rectangle at the source face
        w = face_dims[0] * SCALE
        h = face_dims[1] * SCALE
        hmax_scaled = hmax * SCALE

        # Map face_axes to 3D coordinates
        corner = list(origin)
        p1 = gmsh.model.geo.addPoint(corner[0], corner[1], corner[2], hmax_scaled)

        corner2 = list(origin)
        corner2[face_axes[0]] += w
        p2 = gmsh.model.geo.addPoint(corner2[0], corner2[1], corner2[2], hmax_scaled)

        corner3 = list(origin)
        corner3[face_axes[0]] += w
        corner3[face_axes[1]] += h
        p3 = gmsh.model.geo.addPoint(corner3[0], corner3[1], corner3[2], hmax_scaled)

        corner4 = list(origin)
        corner4[face_axes[1]] += h
        p4 = gmsh.model.geo.addPoint(corner4[0], corner4[1], corner4[2], hmax_scaled)

        l1 = gmsh.model.geo.addLine(p1, p2)
        l2 = gmsh.model.geo.addLine(p2, p3)
        l3 = gmsh.model.geo.addLine(p3, p4)
        l4 = gmsh.model.geo.addLine(p4, p1)

        loop = gmsh.model.geo.addCurveLoop([l1, l2, l3, l4])
        source_surf = gmsh.model.geo.addPlaneSurface([loop])

        if recombine:
            gmsh.model.geo.mesh.setRecombine(2, source_surf)

        gmsh.model.geo.synchronize()

        # Mesh the source face
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax_scaled)
        if opts.hmin is not None:
            gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * SCALE)
        gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)
        gmsh.model.mesh.generate(2)

        # Extrude
        num_elements_per_layer = [1] * n_layers
        gmsh.model.geo.extrude(
            [(2, source_surf)],
            extrude_dir[0], extrude_dir[1], extrude_dir[2],
            numElements=num_elements_per_layer,
            heights=cumulative,
            recombine=recombine,
        )
        gmsh.model.geo.synchronize()
        gmsh.model.mesh.generate(3)

        # Extract → same pipeline as cylinder
        return _extract_swept_mesh_data(gmsh, SCALE, opts)
    finally:
        gmsh.finalize()


# ---------------------------------------------------------------------------
# Prism/hex → tet splitting (for MeshData compat with tet-only solver)
# ---------------------------------------------------------------------------

def _split_prism_to_tets(prisms: NDArray) -> list[NDArray[np.int32]]:
    """Split prism elements (6 nodes each) into 3 tetrahedra each.

    Gmsh prism node ordering: 0,1,2 (bottom triangle), 3,4,5 (top triangle).
    """
    n = prisms.shape[0]
    # 3 tets per prism
    t1 = prisms[:, [0, 1, 2, 3]]
    t2 = prisms[:, [1, 2, 3, 4]]
    t3 = prisms[:, [2, 3, 4, 5]]
    return [t1, t2, t3]


def _split_hex_to_tets(hexes: NDArray) -> list[NDArray[np.int32]]:
    """Split hexahedral elements (8 nodes each) into 5 tetrahedra each.

    Gmsh hex node ordering: 0-3 bottom, 4-7 top.
    Standard 5-tet decomposition.
    """
    n = hexes.shape[0]
    t1 = hexes[:, [0, 1, 3, 4]]
    t2 = hexes[:, [1, 2, 3, 6]]
    t3 = hexes[:, [3, 4, 6, 7]]
    t4 = hexes[:, [1, 4, 5, 6]]
    t5 = hexes[:, [1, 3, 4, 6]]
    return [t1, t2, t3, t4, t5]


# ---------------------------------------------------------------------------
# Internal extraction helper
# ---------------------------------------------------------------------------

def _extract_swept_mesh_data(
    gmsh: Any,
    scale: float,
    opts: MeshOptions,
) -> MeshData:
    """Extract mesh data from Gmsh after swept extrusion, converting to MeshData."""
    node_tags, node_coords, _ = gmsh.model.mesh.getNodes()
    nodes = np.array(node_coords, dtype=np.float64).reshape(-1, 3) / scale

    elem_types, elem_tags_list, elem_node_tags_list = gmsh.model.mesh.getElements(3)
    tag_to_idx = np.zeros(int(node_tags.max()) + 1, dtype=np.int32)
    for idx, tag in enumerate(node_tags):
        tag_to_idx[int(tag)] = idx

    tet_elements: list[NDArray[np.int32]] = []
    for etype, etags, enodes in zip(elem_types, elem_tags_list, elem_node_tags_list):
        info = gmsh.model.mesh.getElementProperties(etype)
        npn = info[3]
        remapped = tag_to_idx[np.array(enodes, dtype=np.int64).reshape(-1, npn)]
        if etype == 6:
            tet_elements.extend(_split_prism_to_tets(remapped))
        elif etype == 5:
            tet_elements.extend(_split_hex_to_tets(remapped))
        elif etype == 4:
            tet_elements.append(remapped)

    if not tet_elements:
        raise RuntimeError("Swept mesh produced 0 volume elements")

    elements = np.vstack(tet_elements).astype(np.int32)
    element_markers = np.ones(elements.shape[0], dtype=np.int32)

    surf_types, surf_tags_list, surf_node_tags_list = gmsh.model.mesh.getElements(2)
    bf_list: list[NDArray[np.int32]] = []
    for stype, stags, snodes in zip(surf_types, surf_tags_list, surf_node_tags_list):
        info = gmsh.model.mesh.getElementProperties(stype)
        npn = info[3]
        if npn == 3:
            tri = tag_to_idx[np.array(snodes, dtype=np.int64).reshape(-1, 3)]
            bf_list.append(tri.astype(np.int32))
        elif npn == 4:
            quad = tag_to_idx[np.array(snodes, dtype=np.int64).reshape(-1, 4)]
            bf_list.append(quad[:, [0, 1, 2]].astype(np.int32))
            bf_list.append(quad[:, [0, 2, 3]].astype(np.int32))

    boundary_faces = np.vstack(bf_list) if bf_list else np.zeros((0, 3), dtype=np.int32)
    boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)

    quality = _compute_swept_quality(nodes, elements) if opts.compute_quality else None

    emit_progress(
        f"Gmsh swept: mesh ready — {nodes.shape[0]} nodes, "
        f"{elements.shape[0]} elements, {boundary_faces.shape[0]} boundary faces"
    )

    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
        quality=quality,
    )


# ---------------------------------------------------------------------------
# Quality metrics for swept mesh
# ---------------------------------------------------------------------------

def _compute_swept_quality(
    nodes: NDArray[np.float64],
    elements: NDArray[np.int32],
) -> MeshQualityReport:
    """Compute basic quality metrics for tet elements from swept mesh."""
    n_elem = elements.shape[0]
    if n_elem == 0:
        return MeshQualityReport(
            n_elements=0,
            sicn_min=0.0, sicn_max=0.0, sicn_mean=0.0, sicn_p5=0.0,
            sicn_histogram=[],
            gamma_min=0.0, gamma_mean=0.0,
            gamma_histogram=[0] * 20,
            volume_min=0.0, volume_max=0.0, volume_mean=0.0, volume_std=0.0,
            avg_quality=0.0,
            quality_source="unavailable",
        )

    # Compute volumes of tetrahedra
    v0 = nodes[elements[:, 0]]
    v1 = nodes[elements[:, 1]]
    v2 = nodes[elements[:, 2]]
    v3 = nodes[elements[:, 3]]

    e1 = v1 - v0
    e2 = v2 - v0
    e3 = v3 - v0
    volumes = np.abs(np.einsum("ij,ij->i", e1, np.cross(e2, e3))) / 6.0

    # Simple gamma (inscribed/circumscribed radius ratio) proxy:
    # Use volume-based aspect ratio as a simplified quality metric.
    # For a regular tet, gamma = 1; for degenerate, gamma → 0.
    edge_lengths = np.zeros((n_elem, 6), dtype=np.float64)
    edge_lengths[:, 0] = np.linalg.norm(v1 - v0, axis=1)
    edge_lengths[:, 1] = np.linalg.norm(v2 - v0, axis=1)
    edge_lengths[:, 2] = np.linalg.norm(v3 - v0, axis=1)
    edge_lengths[:, 3] = np.linalg.norm(v2 - v1, axis=1)
    edge_lengths[:, 4] = np.linalg.norm(v3 - v1, axis=1)
    edge_lengths[:, 5] = np.linalg.norm(v3 - v2, axis=1)

    max_edge = edge_lengths.max(axis=1)
    # Avoid division by zero
    max_edge = np.maximum(max_edge, 1e-30)
    # Normalised quality ∝ V / l_max^3 (scaled to [0,1] for regular tet)
    gamma = (6.0 * np.sqrt(2.0) * volumes) / (max_edge ** 3)
    gamma = np.clip(gamma, 0.0, 1.0)

    gamma_hist, _ = np.histogram(gamma, bins=20, range=(0.0, 1.0))

    return MeshQualityReport(
        n_elements=n_elem,
        sicn_min=0.0,
        sicn_max=0.0,
        sicn_mean=0.0,
        sicn_p5=0.0,
        sicn_histogram=[],
        gamma_min=float(gamma.min()),
        gamma_mean=float(gamma.mean()),
        gamma_histogram=[int(value) for value in gamma_hist.tolist()],
        volume_min=float(volumes.min()),
        volume_max=float(volumes.max()),
        volume_mean=float(volumes.mean()),
        volume_std=float(volumes.std()),
        avg_quality=float(gamma.mean()),
        element_gamma=[float(value) for value in gamma.tolist()],
        element_volume=[float(value) for value in volumes.tolist()],
        quality_source="swept_topology_proxy",
    )


# ---------------------------------------------------------------------------
# Public dispatch
# ---------------------------------------------------------------------------

def should_use_swept(geometry: Geometry, opts: MeshOptions) -> bool:
    """Decide whether to use swept meshing for the given geometry + options."""
    strategy = opts.mesh_strategy
    if strategy == SWEEP_STRATEGY_FREE_TET:
        return False
    if strategy in (SWEEP_STRATEGY_PRISM, SWEEP_STRATEGY_HEX):
        return True
    if strategy == SWEEP_STRATEGY_AUTO or strategy is None:
        # Auto-detect: use swept if geometry is sweepable AND
        # through_thickness_elements is set
        if opts.through_thickness_elements is not None and opts.through_thickness_elements > 0:
            result = classify_sweepability(geometry)
            return result.sweepable
    return False


def generate_swept_mesh(
    geometry: Geometry,
    hmax: float,
    n_layers: int,
    *,
    order: int = 1,
    distribution: str = DISTRIBUTION_FIXED,
    element_ratio: float = 1.0,
    symmetric: bool = False,
    recombine: bool = False,
    airbox: AirboxOptions | None = None,
    options: MeshOptions | None = None,
) -> MeshData:
    """Dispatch swept mesh generation based on geometry type."""
    if isinstance(geometry, Cylinder):
        return generate_swept_cylinder_mesh(
            geometry.radius, geometry.height, hmax, n_layers,
            order=order, distribution=distribution,
            element_ratio=element_ratio, symmetric=symmetric,
            recombine=recombine, airbox=airbox, options=options,
        )
    if isinstance(geometry, Box):
        result = classify_sweepability(geometry)
        thin_axis = result.thin_axis if result.thin_axis is not None else 2
        return generate_swept_box_mesh(
            geometry.size, hmax, n_layers,
            thin_axis=thin_axis, order=order,
            distribution=distribution, element_ratio=element_ratio,
            symmetric=symmetric, recombine=recombine,
            airbox=airbox, options=options,
        )
    if isinstance(geometry, ArchWaveguide):
        from ._gmsh_generators import generate_mesh_from_file
        from .surface_assets import _geometry_to_trimesh, _import_trimesh

        emit_progress(
            "Gmsh swept: ArchWaveguide uses layered surface-constrained "
            "tetrahedral meshing"
        )
        with tempfile.TemporaryDirectory(prefix="fullmag-arch-waveguide-layered-") as tmp_dir:
            surface_path = Path(tmp_dir) / "arch_waveguide_layered.stl"
            trimesh = _import_trimesh()
            surface = _geometry_to_trimesh(
                geometry,
                trimesh,
                through_thickness_elements=n_layers,
                through_thickness_distribution=distribution,
                through_thickness_element_ratio=element_ratio,
                through_thickness_symmetric=symmetric,
            )
            surface.export(surface_path)
            return generate_mesh_from_file(
                surface_path,
                hmax=hmax,
                order=order,
                airbox=airbox,
                options=options,
            )
    raise TypeError(
        f"Swept meshing not supported for geometry type {type(geometry).__name__}. "
        "Use mesh_strategy='free_tetrahedral' instead."
    )
