from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any
import math

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


# ---------------------------------------------------------------------------
# Mesh quality report
# ---------------------------------------------------------------------------
@dataclass(frozen=True, slots=True)
class MeshQualityReport:
    """Per-element quality metrics extracted from Gmsh.

    Attributes:
        n_elements: Total element count.
        sicn_min: Minimum Signed Inverse Condition Number (ideal → 1).
        sicn_max: Maximum SICN.
        sicn_mean: Mean SICN across all elements.
        sicn_p5: 5th-percentile SICN (worst-case tail).
        sicn_histogram: 20 bins across [-1, 1].
        gamma_min: Minimum inscribed/circumscribed ratio (ideal → 1).
        gamma_mean: Mean gamma.
        gamma_histogram: 20 bins across [0, 1].
        volume_min: Smallest element volume.
        volume_max: Largest element volume.
        volume_mean: Mean element volume.
        volume_std: Standard deviation of volumes.
        avg_quality: Global ``Mesh.AvgQuality`` (ICN) from Gmsh.
        element_sicn: Per-element SICN values (None if not requested).
        element_gamma: Per-element gamma values (None if not requested).
    """

    n_elements: int
    sicn_min: float
    sicn_max: float
    sicn_mean: float
    sicn_p5: float
    sicn_histogram: list[int]
    gamma_min: float
    gamma_mean: float
    gamma_histogram: list[int]
    volume_min: float
    volume_max: float
    volume_mean: float
    volume_std: float
    avg_quality: float
    element_sicn: list[float] | None = None
    element_gamma: list[float] | None = None


# ---------------------------------------------------------------------------
# Mesh generation options
# ---------------------------------------------------------------------------
# 2D algorithm constants
ALGO_2D_MESHADAPT = 1
ALGO_2D_AUTOMATIC = 2
ALGO_2D_DELAUNAY = 5
ALGO_2D_FRONTAL_DELAUNAY = 6
ALGO_2D_BAMG = 7
ALGO_2D_FRONTAL_QUADS = 8

# 3D algorithm constants
ALGO_3D_DELAUNAY = 1
ALGO_3D_FRONTAL = 4
ALGO_3D_MMG3D = 7
ALGO_3D_HXT = 10


@dataclass(frozen=True, slots=True)
class MeshOptions:
    """Advanced mesh generation options passed through to Gmsh.

    All fields have safe defaults that match Gmsh 4.x behaviour.
    """

    algorithm_2d: int = ALGO_2D_FRONTAL_DELAUNAY
    algorithm_3d: int = ALGO_3D_DELAUNAY
    hmin: float | None = None
    size_factor: float = 1.0
    size_from_curvature: int = 0
    smoothing_steps: int = 1
    optimize: str | None = None
    optimize_iters: int = 1
    size_fields: list[dict[str, Any]] = field(default_factory=list)
    compute_quality: bool = False
    per_element_quality: bool = False


@dataclass(frozen=True, slots=True)
class SizeFieldData:
    """Nodal target element sizes for adaptive remeshing.

    Attributes:
        node_coords: (N, 3) array of node coordinates from the previous mesh.
        h_values: (N,) array of target element sizes at each node.
    """

    node_coords: NDArray[np.float64]
    h_values: NDArray[np.float64]

    def __post_init__(self) -> None:
        coords = np.asarray(self.node_coords, dtype=np.float64)
        h = np.asarray(self.h_values, dtype=np.float64)
        object.__setattr__(self, "node_coords", coords)
        object.__setattr__(self, "h_values", h)
        if coords.ndim != 2 or coords.shape[1] != 3:
            raise ValueError("node_coords must have shape (N, 3)")
        if h.ndim != 1 or h.shape[0] != coords.shape[0]:
            raise ValueError("h_values must have shape (N,)")
        if np.any(h <= 0):
            raise ValueError("h_values must be strictly positive")


def _import_gmsh() -> Any:
    try:
        import gmsh  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "Gmsh Python SDK is required for FEM meshing. "
            "Install with: python -m pip install 'gmsh>=4.12'"
        ) from exc
    return gmsh


def _import_meshio() -> Any:
    try:
        import meshio  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "meshio is required to read pre-generated mesh files. "
            "Install with: python -m pip install 'meshio>=5.3'"
        ) from exc
    return meshio


@dataclass(frozen=True, slots=True)
class MeshData:
    """Tetrahedral mesh data ready for FEM lowering."""

    nodes: NDArray[np.float64]
    elements: NDArray[np.int32]
    element_markers: NDArray[np.int32]
    boundary_faces: NDArray[np.int32]
    boundary_markers: NDArray[np.int32]
    quality: MeshQualityReport | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "nodes", np.asarray(self.nodes, dtype=np.float64))
        object.__setattr__(self, "elements", np.asarray(self.elements, dtype=np.int32))
        object.__setattr__(self, "element_markers", np.asarray(self.element_markers, dtype=np.int32))
        object.__setattr__(self, "boundary_faces", np.asarray(self.boundary_faces, dtype=np.int32))
        object.__setattr__(self, "boundary_markers", np.asarray(self.boundary_markers, dtype=np.int32))
        self.validate()

    @property
    def n_nodes(self) -> int:
        return int(self.nodes.shape[0])

    @property
    def n_elements(self) -> int:
        return int(self.elements.shape[0])

    @property
    def n_boundary_faces(self) -> int:
        return int(self.boundary_faces.shape[0])

    def validate(self) -> None:
        if self.nodes.ndim != 2 or self.nodes.shape[1] != 3:
            raise ValueError("nodes must have shape (N, 3)")
        if self.elements.ndim != 2 or self.elements.shape[1] != 4:
            raise ValueError("elements must have shape (M, 4)")
        if self.element_markers.shape != (self.n_elements,):
            raise ValueError("element_markers must have shape (M,)")
        if self.boundary_faces.ndim != 2 or (
            self.boundary_faces.size != 0 and self.boundary_faces.shape[1] != 3
        ):
            raise ValueError("boundary_faces must have shape (F, 3)")
        if self.boundary_markers.shape != (self.n_boundary_faces,):
            raise ValueError("boundary_markers must have shape (F,)")
        if self.elements.size and (self.elements.min() < 0 or self.elements.max() >= self.n_nodes):
            raise ValueError("elements contain invalid node indices")
        if self.boundary_faces.size and (
            self.boundary_faces.min() < 0 or self.boundary_faces.max() >= self.n_nodes
        ):
            raise ValueError("boundary_faces contain invalid node indices")

    def save(self, path: str | Path) -> None:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.suffix.lower() == ".json":
            target.write_text(
                json.dumps(
                    {
                        "mesh_name": target.stem,
                        "nodes": self.nodes.tolist(),
                        "elements": self.elements.tolist(),
                        "element_markers": self.element_markers.tolist(),
                        "boundary_faces": self.boundary_faces.tolist(),
                        "boundary_markers": self.boundary_markers.tolist(),
                    },
                    indent=2,
                ),
                encoding="utf-8",
            )
            return
        np.savez_compressed(
            target,
            nodes=self.nodes,
            elements=self.elements,
            element_markers=self.element_markers,
            boundary_faces=self.boundary_faces,
            boundary_markers=self.boundary_markers,
        )

    def export_stl(self, path: str | Path) -> Path:
        """Export boundary surface as binary STL (zero dependencies)."""
        import struct
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        n_faces = self.n_boundary_faces
        with open(target, "wb") as fp:
            fp.write(b"\0" * 80)  # header
            fp.write(struct.pack("<I", n_faces))
            for fi in range(n_faces):
                v0, v1, v2 = self.nodes[self.boundary_faces[fi]]
                e1 = v1 - v0
                e2 = v2 - v0
                normal = np.cross(e1, e2)
                norm_len = np.linalg.norm(normal)
                if norm_len > 0:
                    normal /= norm_len
                fp.write(struct.pack("<3f", *normal.astype(np.float32)))
                fp.write(struct.pack("<3f", *v0.astype(np.float32)))
                fp.write(struct.pack("<3f", *v1.astype(np.float32)))
                fp.write(struct.pack("<3f", *v2.astype(np.float32)))
                fp.write(struct.pack("<H", 0))  # attribute byte count
        return target

    def export_vtk(
        self,
        path: str | Path,
        fields: dict[str, NDArray] | None = None,
    ) -> Path:
        """Export full tetrahedral mesh as VTK legacy file.

        Args:
            path: Destination file path.
            fields: Optional dict of per-node field data to include.
                    Keys are field names (e.g. "m", "H_ex").
                    Values are arrays of shape (n_nodes, 3) for vectors
                    or (n_nodes,) for scalars.
        """
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        n = self.n_nodes
        m = self.n_elements
        with open(target, "w", encoding="utf-8") as fp:
            fp.write("# vtk DataFile Version 3.0\n")
            fp.write("fullmag tetrahedral mesh\n")
            fp.write("ASCII\n")
            fp.write("DATASET UNSTRUCTURED_GRID\n")
            fp.write(f"POINTS {n} double\n")
            for node in self.nodes:
                fp.write(f"{node[0]:.15e} {node[1]:.15e} {node[2]:.15e}\n")
            fp.write(f"\nCELLS {m} {m * 5}\n")
            for tet in self.elements:
                fp.write(f"4 {tet[0]} {tet[1]} {tet[2]} {tet[3]}\n")
            fp.write(f"\nCELL_TYPES {m}\n")
            for _ in range(m):
                fp.write("10\n")  # VTK_TETRA = 10
            fp.write(f"\nCELL_DATA {m}\n")
            fp.write("SCALARS region int 1\n")
            fp.write("LOOKUP_TABLE default\n")
            for marker in self.element_markers:
                fp.write(f"{marker}\n")
            # Per-node field data
            if fields:
                fp.write(f"\nPOINT_DATA {n}\n")
                for name, data in fields.items():
                    arr = np.asarray(data)
                    if arr.ndim == 2 and arr.shape[1] == 3:
                        fp.write(f"VECTORS {name} double\n")
                        for vec in arr:
                            fp.write(f"{vec[0]:.15e} {vec[1]:.15e} {vec[2]:.15e}\n")
                    elif arr.ndim == 1:
                        fp.write(f"SCALARS {name} double 1\n")
                        fp.write("LOOKUP_TABLE default\n")
                        for val in arr:
                            fp.write(f"{val:.15e}\n")
        return target

    @classmethod
    def load(cls, path: str | Path) -> "MeshData":
        source = Path(path)
        if source.suffix.lower() == ".json":
            payload = json.loads(source.read_text(encoding="utf-8"))
            return cls(
                nodes=np.asarray(payload["nodes"], dtype=np.float64),
                elements=np.asarray(payload["elements"], dtype=np.int32),
                element_markers=np.asarray(payload["element_markers"], dtype=np.int32),
                boundary_faces=np.asarray(payload["boundary_faces"], dtype=np.int32),
                boundary_markers=np.asarray(payload["boundary_markers"], dtype=np.int32),
            )

        data = np.load(source)
        return cls(
            nodes=data["nodes"],
            elements=data["elements"],
            element_markers=data["element_markers"],
            boundary_faces=data["boundary_faces"],
            boundary_markers=data["boundary_markers"],
        )

    def to_ir(self, mesh_name: str) -> dict[str, object]:
        return {
            "mesh_name": mesh_name,
            "nodes": self.nodes.tolist(),
            "elements": self.elements.tolist(),
            "element_markers": self.element_markers.tolist(),
            "boundary_faces": self.boundary_faces.tolist(),
            "boundary_markers": self.boundary_markers.tolist(),
        }


def generate_mesh(
    geometry: Geometry,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    options: MeshOptions | None = None,
) -> MeshData:
    """Generate a tetrahedral mesh for the given geometry.

    Args:
        geometry: Fullmag geometry descriptor.
        hmax: Maximum element size (SI metres).
        order: Finite-element order (1 = linear, 2 = quadratic).
        air_padding: Reserved for future air-box meshing.
        options: Advanced Gmsh options (algorithms, quality, size fields).
    """
    opts = options or MeshOptions()
    if isinstance(geometry, Box):
        return generate_box_mesh(geometry.size, hmax=hmax, order=order, air_padding=air_padding, options=opts)
    if isinstance(geometry, Cylinder):
        return generate_cylinder_mesh(
            geometry.radius,
            geometry.height,
            hmax=hmax,
            order=order,
            air_padding=air_padding,
            options=opts,
        )
    if isinstance(geometry, (Difference, Union, Intersection, Translate, Ellipsoid, Ellipse)):
        return _generate_csg_mesh(geometry, hmax=hmax, order=order, options=opts)
    if isinstance(geometry, ImportedGeometry):
        return generate_mesh_from_file(
            geometry.source,
            hmax=hmax,
            order=order,
            air_padding=air_padding,
            scale=geometry.scale,
            options=opts,
        )
    raise TypeError(f"unsupported geometry type: {type(geometry)!r}")


def generate_box_mesh(
    size: tuple[float, float, float],
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    options: MeshOptions | None = None,
) -> MeshData:
    opts = options or MeshOptions()
    emit_progress("Gmsh: generating box geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.add("fullmag_box")
        sx, sy, sz = size
        gmsh.model.occ.addBox(-sx / 2.0, -sy / 2.0, -sz / 2.0, sx, sy, sz)
        gmsh.model.occ.synchronize()
        if air_padding > 0.0:
            # Air-box meshing remains planner policy; for now keep the magnetic body mesh-only.
            pass
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax, order, opts)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return mesh
    finally:  # pragma: no branch
        gmsh.finalize()


def generate_cylinder_mesh(
    radius: float,
    height: float,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    options: MeshOptions | None = None,
) -> MeshData:
    opts = options or MeshOptions()
    emit_progress("Gmsh: generating cylinder geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.add("fullmag_cylinder")
        gmsh.model.occ.addCylinder(0.0, 0.0, -height / 2.0, 0.0, 0.0, height, radius)
        gmsh.model.occ.synchronize()
        if air_padding > 0.0:
            pass
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax, order, opts)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return mesh
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
    opts = options or MeshOptions()
    SCALE = 1e6  # m → µm
    emit_progress("Gmsh: building OCC difference geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.add("fullmag_difference")
        base_tags = _add_geometry_to_occ(gmsh, geometry.base, scale=SCALE)
        tool_tags = _add_geometry_to_occ(gmsh, geometry.tool, scale=SCALE)
        gmsh.model.occ.cut(base_tags, tool_tags)
        gmsh.model.occ.synchronize()
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax * SCALE, order, opts, hscale=SCALE)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
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
        )
    finally:  # pragma: no branch
        gmsh.finalize()


def _generate_csg_mesh(
    geometry: Geometry,
    hmax: float,
    order: int = 1,
    options: MeshOptions | None = None,
) -> MeshData:
    """Mesh any geometry type via the generic OCC pipeline.

    Uses micrometre scaling (×1e6) for OCC numerical stability.
    """
    opts = options or MeshOptions()
    SCALE = 1e6
    emit_progress("Gmsh: building OCC geometry")
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.add("fullmag_csg")
        _add_geometry_to_occ(gmsh, geometry, scale=SCALE)
        gmsh.model.occ.synchronize()
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax * SCALE, order, opts, hscale=SCALE)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
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
    raise TypeError(
        f"unsupported geometry type for OCC meshing: {type(geometry)!r}"
    )


def generate_mesh_from_file(
    source: str | Path,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
    scale: float | tuple[float, float, float] = 1.0,
    options: MeshOptions | None = None,
) -> MeshData:
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
            air_padding=air_padding,
            scale_xyz=scale_xyz,
            options=opts,
        )
    if suffix == ".stl":
        emit_progress(f"Gmsh: meshing STL surface {path.name}")
        return _mesh_stl_surface(
            path,
            hmax=source_hmax,
            order=order,
            air_padding=air_padding,
            scale_xyz=scale_xyz,
            options=opts,
        )
    raise ValueError(f"unsupported mesh/geometry source format: {path.suffix}")


def _mesh_cad_file(
    path: Path,
    hmax: float,
    order: int,
    air_padding: float,
    scale_xyz: NDArray[np.float64],
    options: MeshOptions | None = None,
) -> MeshData:
    opts = options or MeshOptions()
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.add(path.stem)
        emit_progress("Gmsh: importing CAD shapes")
        gmsh.model.occ.importShapes(str(path))
        gmsh.model.occ.synchronize()
        if air_padding > 0.0:
            pass
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax, order, opts)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _scale_mesh_nodes(_extract_mesh_data(gmsh, quality=quality), scale_xyz)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return mesh
    finally:  # pragma: no branch
        gmsh.finalize()


def _mesh_stl_surface(
    path: Path,
    hmax: float,
    order: int,
    air_padding: float,
    scale_xyz: NDArray[np.float64],
    options: MeshOptions | None = None,
) -> MeshData:
    opts = options or MeshOptions()
    gmsh = _import_gmsh()
    gmsh.initialize()
    gmsh.option.setNumber("General.Terminal", 0)
    try:
        gmsh.model.add(path.stem)
        emit_progress("Gmsh: importing STL surface")
        gmsh.merge(str(path))
        angle = 40.0 * math.pi / 180.0
        emit_progress("Gmsh: classifying STL surfaces")
        gmsh.model.mesh.classifySurfaces(
            angle,
            boundary=True,
            forReparametrization=True,
            curveAngle=math.pi,
        )
        emit_progress("Gmsh: creating geometry from classified surfaces")
        gmsh.model.mesh.createGeometry()
        surfaces = gmsh.model.getEntities(2)
        if not surfaces:
            raise ValueError(f"failed to recover closed surfaces from STL: {path}")
        surface_loop = gmsh.model.geo.addSurfaceLoop([tag for _, tag in surfaces])
        gmsh.model.geo.addVolume([surface_loop])
        gmsh.model.geo.synchronize()
        if air_padding > 0.0:
            pass
        emit_progress("Gmsh: generating 3D tetrahedral mesh")
        _apply_mesh_options(gmsh, hmax, order, opts)
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _scale_mesh_nodes(_extract_mesh_data(gmsh, quality=quality), scale_xyz)
        emit_progress(
            f"Gmsh: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements, {mesh.n_boundary_faces} boundary faces"
        )
        return mesh
    finally:  # pragma: no branch
        gmsh.finalize()


def _read_mesh_file(path: Path) -> MeshData:
    meshio = _import_meshio()
    mesh = meshio.read(path)
    tetra = _first_cell_block(mesh, {"tetra"})
    triangles = _first_cell_block(mesh, {"triangle"}, allow_empty=True)
    nodes = np.asarray(mesh.points[:, :3], dtype=np.float64)
    elements = np.asarray(tetra, dtype=np.int32)
    boundary_faces = np.asarray(triangles, dtype=np.int32)
    element_markers = np.ones(elements.shape[0], dtype=np.int32)
    boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)
    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
    )


def _normalize_scale_xyz(scale: float | tuple[float, float, float]) -> NDArray[np.float64]:
    if isinstance(scale, (int, float)):
        return np.full(3, float(scale), dtype=np.float64)
    return np.asarray(scale, dtype=np.float64)


def _source_hmax_from_scale(hmax: float, scale_xyz: NDArray[np.float64]) -> float:
    # Imported files are meshed in their own source coordinates. Convert the
    # requested SI hmax into a source-space target using the most restrictive
    # axis so anisotropic scales do not under-resolve the final SI geometry.
    positive_scales = scale_xyz[scale_xyz > 0]
    if positive_scales.size == 0:
        raise ValueError("imported geometry scale must be strictly positive")
    return float(hmax / float(np.max(positive_scales)))


def _scale_mesh_nodes(mesh: MeshData, scale_xyz: NDArray[np.float64]) -> MeshData:
    if np.allclose(scale_xyz, 1.0):
        return mesh
    return MeshData(
        nodes=np.asarray(mesh.nodes, dtype=np.float64) * scale_xyz.reshape(1, 3),
        elements=mesh.elements,
        element_markers=mesh.element_markers,
        boundary_faces=mesh.boundary_faces,
        boundary_markers=mesh.boundary_markers,
    )


def _first_cell_block(mesh: Any, allowed: set[str], allow_empty: bool = False) -> NDArray[np.int32]:
    for cell_block in mesh.cells:
        if cell_block.type in allowed:
            return np.asarray(cell_block.data, dtype=np.int32)
    if allow_empty:
        width = 3 if "triangle" in allowed else 4
        return np.zeros((0, width), dtype=np.int32)
    raise ValueError(f"mesh does not contain required cell types: {sorted(allowed)}")


def _extract_mesh_data(gmsh: Any, quality: MeshQualityReport | None = None) -> MeshData:
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    if len(node_tags) == 0:
        raise ValueError("gmsh produced an empty node set")

    node_index = {int(tag): idx for idx, tag in enumerate(node_tags)}
    nodes = np.asarray(coords, dtype=np.float64).reshape(-1, 3)

    element_blocks = gmsh.model.mesh.getElements(dim=3)
    elements = _extract_gmsh_connectivity(
        gmsh, element_blocks, node_index, nodes_per_element=4
    )

    boundary_blocks = gmsh.model.mesh.getElements(dim=2)
    boundary_faces = _extract_gmsh_connectivity(
        gmsh, boundary_blocks, node_index, nodes_per_element=3
    )

    element_markers = np.ones(elements.shape[0], dtype=np.int32)
    boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)

    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
        quality=quality,
    )


# ---------------------------------------------------------------------------
# Gmsh option helpers
# ---------------------------------------------------------------------------
def _apply_mesh_options(
    gmsh: Any,
    hmax: float,
    order: int,
    opts: MeshOptions,
    hscale: float = 1.0,
) -> None:
    """Apply MeshOptions to the Gmsh context before mesh.generate()."""
    gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
    # The exported mesh asset is intentionally first-order topology.
    # Higher-order FEM lives in the solver space (`fe_order`), not in the
    # geometric mesh connectivity. Generating quadratic Gmsh elements here
    # introduces mid-edge nodes that are not part of our MeshIR contract and
    # has produced unstable/degenerate tetrahedra for imported STL cases.
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.option.setNumber("Mesh.Algorithm", opts.algorithm_2d)
    gmsh.option.setNumber("Mesh.Algorithm3D", opts.algorithm_3d)
    gmsh.option.setNumber("Mesh.MeshSizeFactor", opts.size_factor)
    gmsh.option.setNumber("Mesh.Smoothing", opts.smoothing_steps)

    if opts.hmin is not None:
        gmsh.option.setNumber("Mesh.CharacteristicLengthMin", opts.hmin * hscale)

    if opts.size_from_curvature > 0:
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", opts.size_from_curvature)

    if opts.size_fields:
        _configure_mesh_size_fields(gmsh, opts.size_fields, hscale)


def _apply_post_mesh_options(gmsh: Any, opts: MeshOptions) -> None:
    """Apply post-generation options (optimization passes)."""
    if opts.optimize is not None:
        method = opts.optimize
        niter = opts.optimize_iters
        emit_progress(f"Gmsh: optimizing mesh (method={method!r}, iters={niter})")
        gmsh.model.mesh.optimize(method, niter=niter)


def _configure_mesh_size_fields(
    gmsh: Any,
    fields: list[dict[str, Any]],
    hscale: float = 1.0,
) -> None:
    """Configure Gmsh mesh size fields from JSON-serializable configs.

    Each field config dict has:
        {"kind": "Box", "params": {"VIn": ..., "VOut": ..., ...}}

    Size values (VIn, VOut, hMin, hMax, SizeMin, SizeMax, Radius, etc.)
    are automatically scaled by ``hscale`` when the parameter name
    contains a size-like keyword.
    """
    _SIZE_PARAMS = {
        "vin", "vout", "hmin", "hmax", "hbulk",
        "sizemin", "sizemax", "distmin", "distmax",
        "radius", "thickness",
        "sizeminnormal", "sizemintangent",
        "sizemaxnormal", "sizemaxtangent",
    }

    field_ids = []
    for config in fields:
        kind = config["kind"]
        fid = gmsh.model.mesh.field.add(kind)
        for key, value in config.get("params", {}).items():
            if isinstance(value, str):
                gmsh.model.mesh.field.setString(fid, key, value)
            elif isinstance(value, list):
                gmsh.model.mesh.field.setNumbers(fid, key, value)
            else:
                # Auto-scale size-like params for µm-scaled geometries
                if hscale != 1.0 and key.lower() in _SIZE_PARAMS:
                    value = value * hscale
                gmsh.model.mesh.field.setNumber(fid, key, value)
        field_ids.append(fid)

    if field_ids:
        if len(field_ids) > 1:
            combo = gmsh.model.mesh.field.add("Min")
            gmsh.model.mesh.field.setNumbers(combo, "FieldsList", field_ids)
            gmsh.model.mesh.field.setAsBackgroundMesh(combo)
        else:
            gmsh.model.mesh.field.setAsBackgroundMesh(field_ids[0])


def _extract_quality_metrics(
    gmsh: Any,
    opts: MeshOptions,
) -> MeshQualityReport:
    """Extract per-element quality metrics from the current Gmsh mesh."""
    emit_progress("Gmsh: extracting quality metrics")

    # Collect all 3D element tags
    elem_types, elem_tags_blocks, _ = gmsh.model.mesh.getElements(dim=3)
    all_tags: list[int] = []
    for block in elem_tags_blocks:
        all_tags.extend(int(t) for t in block)

    if not all_tags:
        return MeshQualityReport(
            n_elements=0,
            sicn_min=0.0, sicn_max=0.0, sicn_mean=0.0, sicn_p5=0.0,
            sicn_histogram=[0] * 20,
            gamma_min=0.0, gamma_mean=0.0,
            gamma_histogram=[0] * 20,
            volume_min=0.0, volume_max=0.0, volume_mean=0.0, volume_std=0.0,
            avg_quality=0.0,
        )

    sicn = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "minSICN"))
    gamma = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "gamma"))
    vols = np.asarray(gmsh.model.mesh.getElementQualities(all_tags, "volume"))
    avg_q = gmsh.option.getNumber("Mesh.AvgQuality")

    sicn_hist, _ = np.histogram(sicn, bins=20, range=(-1.0, 1.0))
    gamma_hist, _ = np.histogram(gamma, bins=20, range=(0.0, 1.0))

    return MeshQualityReport(
        n_elements=len(all_tags),
        sicn_min=float(np.min(sicn)),
        sicn_max=float(np.max(sicn)),
        sicn_mean=float(np.mean(sicn)),
        sicn_p5=float(np.percentile(sicn, 5)),
        sicn_histogram=sicn_hist.tolist(),
        gamma_min=float(np.min(gamma)),
        gamma_mean=float(np.mean(gamma)),
        gamma_histogram=gamma_hist.tolist(),
        volume_min=float(np.min(vols)),
        volume_max=float(np.max(vols)),
        volume_mean=float(np.mean(vols)),
        volume_std=float(np.std(vols)),
        avg_quality=float(avg_q),
        element_sicn=sicn.tolist() if opts.per_element_quality else None,
        element_gamma=gamma.tolist() if opts.per_element_quality else None,
    )


def _extract_gmsh_connectivity(
    gmsh: Any,
    element_blocks: tuple[list[int], list[np.ndarray], list[np.ndarray]],
    node_index: dict[int, int],
    nodes_per_element: int,
) -> NDArray[np.int32]:
    element_types, _, node_tags_blocks = element_blocks
    rows: list[list[int]] = []
    for element_type, tags in zip(element_types, node_tags_blocks):
        _, _, _, num_nodes, _, num_primary_nodes = gmsh.model.mesh.getElementProperties(
            int(element_type)
        )
        if num_primary_nodes < nodes_per_element:
            raise ValueError(
                f"gmsh element type {element_type} exposes only {num_primary_nodes} "
                f"primary nodes, expected at least {nodes_per_element}"
            )
        flat = [node_index[int(tag)] for tag in tags]
        if len(flat) % num_nodes != 0:
            raise ValueError(
                f"gmsh connectivity for element type {element_type} has {len(flat)} "
                f"entries, not divisible by {num_nodes}"
            )
        for start in range(0, len(flat), num_nodes):
            element_nodes = flat[start : start + num_nodes]
            rows.append(element_nodes[:nodes_per_element])
    if not rows:
        return np.zeros((0, nodes_per_element), dtype=np.int32)
    return np.asarray(rows, dtype=np.int32)


# ---------------------------------------------------------------------------
# Adaptive remeshing with PostView background size field
# ---------------------------------------------------------------------------
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
        gmsh.model.add("fullmag_box_afem")
        sx, sy, sz = geometry.size
        gmsh.model.occ.addBox(-sx / 2.0, -sy / 2.0, -sz / 2.0, sx, sy, sz)
        gmsh.model.occ.synchronize()
        emit_progress("AFEM: applying adaptive size field")
        _apply_mesh_options(gmsh, hmax, order, opts)
        _apply_postview_background_mesh(gmsh, sf)
        emit_progress("AFEM: generating adaptive 3D mesh")
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
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
        gmsh.model.add("fullmag_cylinder_afem")
        gmsh.model.occ.addCylinder(
            0.0, 0.0, -geometry.height / 2.0,
            0.0, 0.0, geometry.height,
            geometry.radius,
        )
        gmsh.model.occ.synchronize()
        emit_progress("AFEM: applying adaptive size field")
        _apply_mesh_options(gmsh, hmax, order, opts)
        _apply_postview_background_mesh(gmsh, sf)
        emit_progress("AFEM: generating adaptive 3D mesh")
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
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
        gmsh.model.add("fullmag_csg_afem")
        _add_geometry_to_occ(gmsh, geometry, scale=SCALE)
        gmsh.model.occ.synchronize()
        emit_progress("AFEM: applying adaptive size field (µm-scaled)")
        _apply_mesh_options(gmsh, hmax * SCALE, order, opts, hscale=SCALE)
        _apply_postview_background_mesh(gmsh, sf, coord_scale=SCALE)
        emit_progress("AFEM: generating adaptive 3D mesh")
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _extract_mesh_data(gmsh, quality=quality)
        emit_progress(
            f"AFEM: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements"
        )
        return MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
            quality=quality,
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
        gmsh.model.add(path.stem + "_afem")
        if suffix in {".step", ".stp", ".iges", ".igs"}:
            emit_progress("AFEM: importing CAD shapes")
            gmsh.model.occ.importShapes(str(path))
            gmsh.model.occ.synchronize()
        elif suffix == ".stl":
            emit_progress("AFEM: importing STL surface")
            gmsh.merge(str(path))
            angle = 40.0 * math.pi / 180.0
            gmsh.model.mesh.classifySurfaces(
                angle, boundary=True, forReparametrization=True, curveAngle=math.pi,
            )
            gmsh.model.mesh.createGeometry()
            surfaces = gmsh.model.getEntities(2)
            if not surfaces:
                raise ValueError(f"failed to recover closed surfaces from STL: {path}")
            surface_loop = gmsh.model.geo.addSurfaceLoop([tag for _, tag in surfaces])
            gmsh.model.geo.addVolume([surface_loop])
            gmsh.model.geo.synchronize()
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
        gmsh.model.mesh.generate(3)
        _apply_post_mesh_options(gmsh, opts)
        quality = _extract_quality_metrics(gmsh, opts) if opts.compute_quality else None
        mesh = _scale_mesh_nodes(_extract_mesh_data(gmsh, quality=quality), scale_xyz)
        emit_progress(
            f"AFEM: mesh ready — {mesh.n_nodes} nodes, {mesh.n_elements} elements"
        )
        return mesh
    finally:
        gmsh.finalize()
