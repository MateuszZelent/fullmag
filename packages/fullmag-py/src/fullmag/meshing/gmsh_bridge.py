from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Any
import math

import numpy as np
from numpy.typing import NDArray

from fullmag.model.geometry import Box, Cylinder, Difference, Geometry, ImportedGeometry


def _import_gmsh() -> Any:
    try:
        import gmsh  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "Gmsh Python SDK is required for FEM meshing. "
            "Install with: pip install 'fullmag[meshing]'"
        ) from exc
    return gmsh


def _import_meshio() -> Any:
    try:
        import meshio  # type: ignore
    except ImportError as exc:  # pragma: no cover - depends on optional extra
        raise ImportError(
            "meshio is required to read pre-generated mesh files. "
            "Install with: pip install 'fullmag[meshing]'"
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
) -> MeshData:
    if isinstance(geometry, Box):
        return generate_box_mesh(geometry.size, hmax=hmax, order=order, air_padding=air_padding)
    if isinstance(geometry, Cylinder):
        return generate_cylinder_mesh(
            geometry.radius,
            geometry.height,
            hmax=hmax,
            order=order,
            air_padding=air_padding,
        )
    if isinstance(geometry, Difference):
        return generate_difference_mesh(geometry, hmax=hmax, order=order)
    if isinstance(geometry, ImportedGeometry):
        return generate_mesh_from_file(geometry.source, hmax=hmax, order=order, air_padding=air_padding)
    raise TypeError(f"unsupported geometry type: {type(geometry)!r}")


def generate_box_mesh(
    size: tuple[float, float, float],
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
) -> MeshData:
    gmsh = _import_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add("fullmag_box")
        sx, sy, sz = size
        gmsh.model.occ.addBox(-sx / 2.0, -sy / 2.0, -sz / 2.0, sx, sy, sz)
        gmsh.model.occ.synchronize()
        if air_padding > 0.0:
            # Air-box meshing remains planner policy; for now keep the magnetic body mesh-only.
            pass
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.model.mesh.generate(3)
        return _extract_mesh_data(gmsh)
    finally:  # pragma: no branch
        gmsh.finalize()


def generate_cylinder_mesh(
    radius: float,
    height: float,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
) -> MeshData:
    gmsh = _import_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add("fullmag_cylinder")
        gmsh.model.occ.addCylinder(0.0, 0.0, -height / 2.0, 0.0, 0.0, height, radius)
        gmsh.model.occ.synchronize()
        if air_padding > 0.0:
            pass
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.model.mesh.generate(3)
        return _extract_mesh_data(gmsh)
    finally:  # pragma: no branch
        gmsh.finalize()


def generate_difference_mesh(
    geometry: Difference,
    hmax: float,
    order: int = 1,
) -> MeshData:
    """Mesh a CSG Difference via Gmsh OCC boolean cut.

    OCC has numerical precision limits, so we scale geometry from SI metres
    to micrometres (×1e6) for boolean ops, then scale nodes back (×1e-6).
    """
    SCALE = 1e6  # m → µm
    gmsh = _import_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add("fullmag_difference")
        base_tags = _add_geometry_to_occ(gmsh, geometry.base, scale=SCALE)
        tool_tags = _add_geometry_to_occ(gmsh, geometry.tool, scale=SCALE)
        gmsh.model.occ.cut(base_tags, tool_tags)
        gmsh.model.occ.synchronize()
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax * SCALE)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.model.mesh.generate(3)
        mesh = _extract_mesh_data(gmsh)
        # Scale nodes back to SI metres
        return MeshData(
            nodes=mesh.nodes / SCALE,
            elements=mesh.elements,
            element_markers=mesh.element_markers,
            boundary_faces=mesh.boundary_faces,
            boundary_markers=mesh.boundary_markers,
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
    Supports recursive Difference nesting.
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
    if isinstance(geometry, Difference):
        base_tags = _add_geometry_to_occ(gmsh, geometry.base, scale=scale)
        tool_tags = _add_geometry_to_occ(gmsh, geometry.tool, scale=scale)
        result, _ = gmsh.model.occ.cut(base_tags, tool_tags)
        return result
    raise TypeError(
        f"CSG operand must be Box, Cylinder, or Difference, got {type(geometry)!r}"
    )


def generate_mesh_from_file(
    source: str | Path,
    hmax: float,
    order: int = 1,
    air_padding: float = 0.0,
) -> MeshData:
    path = Path(source)
    suffix = path.suffix.lower()
    if suffix in {".json", ".npz"}:
        return MeshData.load(path)
    if suffix in {".msh", ".vtk", ".vtu", ".xdmf"}:
        return _read_mesh_file(path)
    if suffix in {".step", ".stp", ".iges", ".igs"}:
        return _mesh_cad_file(path, hmax=hmax, order=order, air_padding=air_padding)
    if suffix == ".stl":
        return _mesh_stl_surface(path, hmax=hmax, order=order, air_padding=air_padding)
    raise ValueError(f"unsupported mesh/geometry source format: {path.suffix}")


def _mesh_cad_file(path: Path, hmax: float, order: int, air_padding: float) -> MeshData:
    gmsh = _import_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add(path.stem)
        gmsh.model.occ.importShapes(str(path))
        gmsh.model.occ.synchronize()
        if air_padding > 0.0:
            pass
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.model.mesh.generate(3)
        return _extract_mesh_data(gmsh)
    finally:  # pragma: no branch
        gmsh.finalize()


def _mesh_stl_surface(path: Path, hmax: float, order: int, air_padding: float) -> MeshData:
    gmsh = _import_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add(path.stem)
        gmsh.merge(str(path))
        angle = 40.0 * math.pi / 180.0
        gmsh.model.mesh.classifySurfaces(
            angle,
            boundary=True,
            forReparametrization=True,
            curveAngle=math.pi,
        )
        gmsh.model.mesh.createGeometry()
        surfaces = gmsh.model.getEntities(2)
        if not surfaces:
            raise ValueError(f"failed to recover closed surfaces from STL: {path}")
        surface_loop = gmsh.model.geo.addSurfaceLoop([tag for _, tag in surfaces])
        gmsh.model.geo.addVolume([surface_loop])
        gmsh.model.geo.synchronize()
        if air_padding > 0.0:
            pass
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.model.mesh.generate(3)
        return _extract_mesh_data(gmsh)
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


def _first_cell_block(mesh: Any, allowed: set[str], allow_empty: bool = False) -> NDArray[np.int32]:
    for cell_block in mesh.cells:
        if cell_block.type in allowed:
            return np.asarray(cell_block.data, dtype=np.int32)
    if allow_empty:
        width = 3 if "triangle" in allowed else 4
        return np.zeros((0, width), dtype=np.int32)
    raise ValueError(f"mesh does not contain required cell types: {sorted(allowed)}")


def _extract_mesh_data(gmsh: Any) -> MeshData:
    node_tags, coords, _ = gmsh.model.mesh.getNodes()
    if len(node_tags) == 0:
        raise ValueError("gmsh produced an empty node set")

    node_index = {int(tag): idx for idx, tag in enumerate(node_tags)}
    nodes = np.asarray(coords, dtype=np.float64).reshape(-1, 3)

    element_blocks = gmsh.model.mesh.getElements(dim=3)
    elements = _extract_gmsh_connectivity(element_blocks, node_index, nodes_per_element=4)

    boundary_blocks = gmsh.model.mesh.getElements(dim=2)
    boundary_faces = _extract_gmsh_connectivity(boundary_blocks, node_index, nodes_per_element=3)

    element_markers = np.ones(elements.shape[0], dtype=np.int32)
    boundary_markers = np.ones(boundary_faces.shape[0], dtype=np.int32)

    return MeshData(
        nodes=nodes,
        elements=elements,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
    )


def _extract_gmsh_connectivity(
    element_blocks: tuple[list[int], list[np.ndarray], list[np.ndarray]],
    node_index: dict[int, int],
    nodes_per_element: int,
) -> NDArray[np.int32]:
    _, _, node_tags_blocks = element_blocks
    rows: list[list[int]] = []
    for tags in node_tags_blocks:
        flat = [node_index[int(tag)] for tag in tags]
        for start in range(0, len(flat), nodes_per_element):
            rows.append(flat[start : start + nodes_per_element])
    if not rows:
        return np.zeros((0, nodes_per_element), dtype=np.int32)
    return np.asarray(rows, dtype=np.int32)
