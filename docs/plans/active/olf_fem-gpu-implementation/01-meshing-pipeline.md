# S1: Geometry assets + meshing pipeline — STL/STEP/Gmsh → IR → Rust

- Etap: **S1** (brak zależności, start natychmiast)
- Priorytet: **CRITICAL** — bez siatki nie ma FEM
- Powiązane: `docs/physics/0100-mesh-and-region-discretization.md`

---

## 1. Cele etapu

1. **Generować siatkę tetraedryczną P1** z geometrii analitycznej (Box, Cylinder) + importu.
2. **Transportować dane siatki** z Pythona do Rust IR (nodes, elements, markers).
3. **Generować air-box** dla demag (magnet + otoczka powietrzna).
4. **Weryfikować jakość siatki** (aspekt ratio, koplanarne tetraedry).
5. **Serializować/deserializować** mesh w formacie niezależnym od Gmsh.
6. **Traktować STL jako wspólny asset geometrii**, nie solver-native truth.
7. **Wspierać STL export/import** dla:
   - FEM meshing,
   - FDM voxelization / `active_mask`,
   - frontend/debug workflows.
8. **Przygotować jeden shared geometry asset pipeline** dla przełącznika backendów FDM/FEM.

---

## 2. Architektura

```
┌────────────────────────────────┐
│  fm.Problem(shape=Box(...),    │
│             fem=fm.FEM(hmax=5e-9)) │
├────────────────────────────────┤
│          to_ir()               │
│    ┌─────────────────────┐     │
│    │ GeometryIR          │     │
│    │  + FemHintsIR       │     │
│    └──────┬──────────────┘     │
│           │                    │
│    ┌──────▼──────────────┐     │
│    │ GeometryAssetLayer  │     │  Python layer
│    │  gmsh + meshio      │     │
│    │  + trimesh          │     │
│    └──────┬──────────────┘     │
│           │                    │
│    ┌──────▼──────────────┐     │
│    │ MeshDataPy          │     │
│    │ / VoxelMaskData     │     │
│    └──────┬──────────────┘     │
├───────────┼────────────────────┤
│    ┌──────▼──────────────┐     │
│    │ MeshIR / GridAsset  │     │  Rust layer
│    │  via PyO3 transfer  │     │
│    └─────────────────────┘     │
└────────────────────────────────┘
```

### 2.1 Decyzja architektoniczna

Ten etap nie jest tylko “pipeline FEM”.
To jest wspólny **geometry asset stage** dla obu backendów:

- FEM konsumuje tetra mesh,
- FDM konsumuje voxelized `active_mask`,
- oba lowering paths startują z tego samego `GeometryIR` / `ImportedGeometry`.

---

## 3. Zadania szczegółowe

### S1.1 — Klasa `MeshGenerator` w Python

**Plik:** `packages/fullmag-py/src/fullmag/meshing/__init__.py`

```python
"""Mesh generation utilities for FEM backend."""

from .gmsh_bridge import generate_mesh, MeshData
from .quality import validate_mesh

__all__ = ["generate_mesh", "MeshData", "validate_mesh"]
```

**Plik:** `packages/fullmag-py/src/fullmag/meshing/gmsh_bridge.py`

```python
"""Bridge between Fullmag geometries and Gmsh meshing engine."""

import numpy as np
from numpy.typing import NDArray

try:
    import gmsh
except ImportError:
    gmsh = None  # Deferred error at call site

from dataclasses import dataclass
from typing import Optional


@dataclass
class MeshData:
    """Tetrahedral mesh data ready for FEM computation.

    Attributes:
        nodes: (N, 3) array of node coordinates in meters.
        elements: (M, 4) array of tetrahedral element connectivity (0-based).
        node_markers: (N,) array of domain IDs per node (0 = interior, 1 = boundary).
        element_markers: (M,) array of material region IDs per element.
        boundary_faces: (F, 3) array of boundary triangle connectivity (0-based).
        boundary_markers: (F,) array of boundary condition markers per face.
    """
    nodes: NDArray[np.float64]           # (N, 3)
    elements: NDArray[np.int32]          # (M, 4)
    node_markers: NDArray[np.int32]      # (N,)
    element_markers: NDArray[np.int32]   # (M,)
    boundary_faces: NDArray[np.int32]    # (F, 3)
    boundary_markers: NDArray[np.int32]  # (F,)

    @property
    def n_nodes(self) -> int:
        return self.nodes.shape[0]

    @property
    def n_elements(self) -> int:
        return self.elements.shape[0]

    @property
    def n_boundary_faces(self) -> int:
        return self.boundary_faces.shape[0]

    def node_volumes(self) -> NDArray[np.float64]:
        """Compute lumped node volumes (1/4 of sum of adjacent tet volumes).

        Returns:
            (N,) array of node volumes in m³.
        """
        volumes = np.zeros(self.n_nodes, dtype=np.float64)
        for i in range(self.n_elements):
            n0, n1, n2, n3 = self.elements[i]
            v0 = self.nodes[n0]
            v1 = self.nodes[n1]
            v2 = self.nodes[n2]
            v3 = self.nodes[n3]
            # Volume = |det([v1-v0, v2-v0, v3-v0])| / 6
            mat = np.column_stack([v1 - v0, v2 - v0, v3 - v0])
            vol = abs(np.linalg.det(mat)) / 6.0
            # Lumped: distribute equally to 4 nodes
            volumes[n0] += vol / 4.0
            volumes[n1] += vol / 4.0
            volumes[n2] += vol / 4.0
            volumes[n3] += vol / 4.0
        return volumes

    def save(self, path: str) -> None:
        """Save mesh to .npz file for reuse."""
        np.savez_compressed(
            path,
            nodes=self.nodes,
            elements=self.elements,
            node_markers=self.node_markers,
            element_markers=self.element_markers,
            boundary_faces=self.boundary_faces,
            boundary_markers=self.boundary_markers,
        )

    @classmethod
    def load(cls, path: str) -> "MeshData":
        """Load mesh from .npz file."""
        data = np.load(path)
        return cls(
            nodes=data["nodes"],
            elements=data["elements"],
            node_markers=data["node_markers"],
            element_markers=data["element_markers"],
            boundary_faces=data["boundary_faces"],
            boundary_markers=data["boundary_markers"],
        )


# Physical group tags
_TAG_MAGNETIC_VOLUME = 1
_TAG_AIR_VOLUME = 2
_TAG_OUTER_BOUNDARY = 3
_TAG_MAGNETIC_SURFACE = 4


def _ensure_gmsh():
    if gmsh is None:
        raise ImportError(
            "Gmsh Python SDK not installed. "
            "Install with: pip install gmsh"
        )


def generate_box_mesh(
    size: tuple[float, float, float],
    hmax: float,
    order: int = 1,
    air_factor: float = 0.0,
) -> MeshData:
    """Generate tetrahedral mesh for a box geometry.

    Args:
        size: (sx, sy, sz) box dimensions in meters.
        hmax: Maximum element size in meters.
        order: Polynomial order (1 = linear, 2 = quadratic).
        air_factor: If > 0, add air box with sides air_factor * max(size)
                    around the magnet. 0 = no air box.

    Returns:
        MeshData with tetrahedral mesh.
    """
    _ensure_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add("fullmag_box")
        sx, sy, sz = size

        # Magnetic volume
        mag_vol = gmsh.model.occ.addBox(-sx/2, -sy/2, -sz/2, sx, sy, sz)

        if air_factor > 0:
            # Air box
            a = air_factor * max(size)
            ax, ay, az = sx + 2*a, sy + 2*a, sz + 2*a
            air_vol = gmsh.model.occ.addBox(-ax/2, -ay/2, -az/2, ax, ay, az)

            # Boolean: air = air_box - magnetic_body
            # Fragment to create shared boundary
            gmsh.model.occ.fragment(
                [(3, air_vol)], [(3, mag_vol)]
            )
            gmsh.model.occ.synchronize()

            # Assign physical groups
            # After fragment, volumes may be renumbered; find them by position
            all_vols = gmsh.model.getEntities(dim=3)
            for dim, tag in all_vols:
                com = gmsh.model.occ.getCenterOfMass(dim, tag)
                # Magnetic volume center should be near origin
                if abs(com[0]) < sx/2 and abs(com[1]) < sy/2 and abs(com[2]) < sz/2:
                    gmsh.model.addPhysicalGroup(3, [tag], _TAG_MAGNETIC_VOLUME)
                    gmsh.model.setPhysicalName(3, _TAG_MAGNETIC_VOLUME, "magnetic")
                else:
                    gmsh.model.addPhysicalGroup(3, [tag], _TAG_AIR_VOLUME)
                    gmsh.model.setPhysicalName(3, _TAG_AIR_VOLUME, "air")

            # Outer boundary faces
            all_surfs = gmsh.model.getBoundary([(3, tag) for _, tag in all_vols],
                                                oriented=False, combined=True)
            outer_tags = [abs(s[1]) for s in all_surfs]
            gmsh.model.addPhysicalGroup(2, outer_tags, _TAG_OUTER_BOUNDARY)
        else:
            gmsh.model.occ.synchronize()
            gmsh.model.addPhysicalGroup(3, [mag_vol], _TAG_MAGNETIC_VOLUME)
            gmsh.model.setPhysicalName(3, _TAG_MAGNETIC_VOLUME, "magnetic")

        # Mesh settings
        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.option.setNumber("Mesh.Algorithm3D", 1)  # Delaunay
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.OptimizeNetgen", 1)

        # Generate
        gmsh.model.mesh.generate(3)

        return _extract_mesh_data(gmsh)
    finally:
        gmsh.finalize()


def generate_cylinder_mesh(
    radius: float,
    height: float,
    hmax: float,
    order: int = 1,
    air_factor: float = 0.0,
) -> MeshData:
    """Generate tetrahedral mesh for a cylinder geometry.

    Args:
        radius: Cylinder radius in meters.
        height: Cylinder height in meters.
        hmax: Maximum element size in meters.
        order: Polynomial order.
        air_factor: Air box size factor (0 = no air box).

    Returns:
        MeshData with tetrahedral mesh.
    """
    _ensure_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add("fullmag_cylinder")

        # Cylinder along z-axis, centered at origin
        cyl_vol = gmsh.model.occ.addCylinder(
            0, 0, -height/2,    # base center
            0, 0, height,       # direction vector
            radius
        )

        if air_factor > 0:
            a = air_factor * max(2*radius, height)
            ax, ay, az = 2*radius + 2*a, 2*radius + 2*a, height + 2*a
            air_vol = gmsh.model.occ.addBox(-ax/2, -ay/2, -az/2, ax, ay, az)
            gmsh.model.occ.fragment([(3, air_vol)], [(3, cyl_vol)])
            gmsh.model.occ.synchronize()

            all_vols = gmsh.model.getEntities(dim=3)
            for dim, tag in all_vols:
                com = gmsh.model.occ.getCenterOfMass(dim, tag)
                dist = np.sqrt(com[0]**2 + com[1]**2)
                if dist < radius and abs(com[2]) < height/2:
                    gmsh.model.addPhysicalGroup(3, [tag], _TAG_MAGNETIC_VOLUME)
                    gmsh.model.setPhysicalName(3, _TAG_MAGNETIC_VOLUME, "magnetic")
                else:
                    gmsh.model.addPhysicalGroup(3, [tag], _TAG_AIR_VOLUME)
                    gmsh.model.setPhysicalName(3, _TAG_AIR_VOLUME, "air")
        else:
            gmsh.model.occ.synchronize()
            gmsh.model.addPhysicalGroup(3, [cyl_vol], _TAG_MAGNETIC_VOLUME)
            gmsh.model.setPhysicalName(3, _TAG_MAGNETIC_VOLUME, "magnetic")

        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.option.setNumber("Mesh.Algorithm3D", 1)
        gmsh.option.setNumber("Mesh.Optimize", 1)
        gmsh.option.setNumber("Mesh.OptimizeNetgen", 1)

        gmsh.model.mesh.generate(3)
        return _extract_mesh_data(gmsh)
    finally:
        gmsh.finalize()


def generate_mesh_from_file(
    filepath: str,
    hmax: float,
    order: int = 1,
    air_factor: float = 0.0,
) -> MeshData:
    """Generate mesh from imported geometry file (STEP, STL, etc.).

    Args:
        filepath: Path to geometry file.
        hmax: Maximum element size.
        order: Polynomial order.
        air_factor: Air box size factor.

    Returns:
        MeshData with tetrahedral mesh.
    """
    _ensure_gmsh()
    gmsh.initialize()
    try:
        gmsh.model.add("fullmag_import")
        gmsh.merge(filepath)
        gmsh.model.occ.synchronize()

        # All volumes become magnetic
        all_vols = gmsh.model.getEntities(dim=3)
        vol_tags = [tag for _, tag in all_vols]
        gmsh.model.addPhysicalGroup(3, vol_tags, _TAG_MAGNETIC_VOLUME)

        if air_factor > 0:
            # Get bounding box
            xmin, ymin, zmin, xmax, ymax, zmax = gmsh.model.getBoundingBox(-1, -1)
            max_dim = max(xmax - xmin, ymax - ymin, zmax - zmin)
            a = air_factor * max_dim
            air_vol = gmsh.model.occ.addBox(
                xmin - a, ymin - a, zmin - a,
                (xmax - xmin) + 2*a, (ymax - ymin) + 2*a, (zmax - zmin) + 2*a
            )
            gmsh.model.occ.fragment([(3, air_vol)], [(3, t) for t in vol_tags])
            gmsh.model.occ.synchronize()

        gmsh.option.setNumber("Mesh.CharacteristicLengthMax", hmax)
        gmsh.option.setNumber("Mesh.ElementOrder", order)
        gmsh.option.setNumber("Mesh.Algorithm3D", 1)
        gmsh.option.setNumber("Mesh.Optimize", 1)

        gmsh.model.mesh.generate(3)
        return _extract_mesh_data(gmsh)
    finally:
        gmsh.finalize()


def _extract_mesh_data(gmsh_module) -> MeshData:
    """Extract mesh arrays from active Gmsh model.

    Assumes gmsh is initialized and mesh has been generated.
    """
    # --- Nodes ---
    node_tags, coords, _ = gmsh_module.model.mesh.getNodes()
    # node_tags are 1-based; create mapping to 0-based
    max_tag = int(node_tags.max())
    tag_to_idx = np.full(max_tag + 1, -1, dtype=np.int32)
    for idx, tag in enumerate(node_tags):
        tag_to_idx[int(tag)] = idx
    n_nodes = len(node_tags)
    nodes = coords.reshape(-1, 3)

    # --- Tetrahedra (3D elements of type 4 = 4-node tet) ---
    elem_types, elem_tags_list, node_tags_list = gmsh_module.model.mesh.getElements(dim=3)

    elements_list = []
    element_markers_list = []

    for etype, etags, ntags in zip(elem_types, elem_tags_list, node_tags_list):
        # etype 4 = 4-node tetrahedron, etype 11 = 10-node tet (P2)
        if etype == 4:
            n_per_elem = 4
        elif etype == 11:
            n_per_elem = 10
        else:
            continue
        n_elems = len(etags)
        connectivity = ntags.reshape(n_elems, n_per_elem)
        # Convert 1-based node tags to 0-based indices
        connectivity_0 = np.array([[tag_to_idx[int(t)] for t in row]
                                    for row in connectivity], dtype=np.int32)
        elements_list.append(connectivity_0[:, :4])  # Always store first 4 for P1
        element_markers_list.append(np.ones(n_elems, dtype=np.int32))

    elements = np.vstack(elements_list) if elements_list else np.empty((0, 4), dtype=np.int32)
    element_markers = np.concatenate(element_markers_list) if element_markers_list else np.empty(0, dtype=np.int32)

    # --- Physical group markers for elements ---
    # Query which physical group each element belongs to
    phys_3d = gmsh_module.model.getPhysicalGroups(dim=3)
    for tag_dim, tag_phys in phys_3d:
        entities = gmsh_module.model.getEntitiesForPhysicalGroup(tag_dim, tag_phys)
        for ent in entities:
            # Get elements of this entity
            et, tags_e, _ = gmsh_module.model.mesh.getElements(dim=3, tag=ent)
            for etags in tags_e:
                for etag in etags:
                    # Find this element in our list
                    # (simplified — production code should use tag-based lookup)
                    pass
    # Simplified: mark all as magnetic (1)
    # Material assignment from physical groups is handled in production version

    # --- Node markers (boundary = 1, interior = 0) ---
    node_markers = np.zeros(n_nodes, dtype=np.int32)

    # --- Boundary faces ---
    boundary_faces_list = []
    boundary_markers_list = []
    surf_types, surf_tags_list, surf_nodes_list = gmsh_module.model.mesh.getElements(dim=2)
    for stype, stags, sntags in zip(surf_types, surf_tags_list, surf_nodes_list):
        if stype == 2:  # 3-node triangle
            n_per = 3
        elif stype == 9:  # 6-node triangle (P2)
            n_per = 6
        else:
            continue
        n_faces = len(stags)
        face_conn = sntags.reshape(n_faces, n_per)
        face_conn_0 = np.array([[tag_to_idx[int(t)] for t in row[:3]]
                                 for row in face_conn], dtype=np.int32)
        boundary_faces_list.append(face_conn_0)
        boundary_markers_list.append(np.ones(n_faces, dtype=np.int32))
        # Mark boundary nodes
        for row in face_conn_0:
            node_markers[row] = 1

    boundary_faces = (np.vstack(boundary_faces_list) if boundary_faces_list
                      else np.empty((0, 3), dtype=np.int32))
    boundary_markers = (np.concatenate(boundary_markers_list) if boundary_markers_list
                        else np.empty(0, dtype=np.int32))

    return MeshData(
        nodes=nodes,
        elements=elements,
        node_markers=node_markers,
        element_markers=element_markers,
        boundary_faces=boundary_faces,
        boundary_markers=boundary_markers,
    )
```

---

### S1.2 — Walidacja jakości siatki

**Plik:** `packages/fullmag-py/src/fullmag/meshing/quality.py`

```python
"""Mesh quality validation utilities."""

import numpy as np
from numpy.typing import NDArray
from dataclasses import dataclass

from .gmsh_bridge import MeshData


@dataclass
class MeshQualityReport:
    """Mesh quality statistics."""
    n_nodes: int
    n_elements: int
    n_boundary_faces: int
    total_volume: float            # m³
    min_element_volume: float      # m³
    max_element_volume: float      # m³
    mean_element_volume: float     # m³
    min_aspect_ratio: float        # 1.0 = perfect
    max_aspect_ratio: float
    mean_aspect_ratio: float
    n_degenerate: int              # aspect ratio > 100
    n_inverted: int                # negative volume
    is_valid: bool
    issues: list[str]


def tet_volume(p0, p1, p2, p3) -> float:
    """Compute signed volume of tetrahedron."""
    mat = np.column_stack([p1 - p0, p2 - p0, p3 - p0])
    return np.linalg.det(mat) / 6.0


def tet_aspect_ratio(p0, p1, p2, p3) -> float:
    """Compute aspect ratio of tetrahedron.

    Aspect ratio = longest edge / shortest altitude.
    Perfect tetrahedron ≈ 1.0, degenerate → ∞.
    """
    # 6 edges
    edges = [p1 - p0, p2 - p0, p3 - p0, p2 - p1, p3 - p1, p3 - p2]
    edge_lengths = [np.linalg.norm(e) for e in edges]
    longest = max(edge_lengths)

    # Volume
    vol = abs(tet_volume(p0, p1, p2, p3))
    if vol < 1e-30:
        return float("inf")

    # Surface area (4 triangles)
    faces = [
        (p0, p1, p2), (p0, p1, p3), (p0, p2, p3), (p1, p2, p3)
    ]
    area = 0.0
    for a, b, c in faces:
        area += 0.5 * np.linalg.norm(np.cross(b - a, c - a))

    # Shortest altitude = 3 * vol / max_face_area
    max_face_area = max(
        0.5 * np.linalg.norm(np.cross(b - a, c - a))
        for a, b, c in faces
    )
    shortest_altitude = 3.0 * vol / max_face_area if max_face_area > 0 else 0.0

    if shortest_altitude < 1e-30:
        return float("inf")

    return longest / shortest_altitude


def validate_mesh(mesh: MeshData) -> MeshQualityReport:
    """Validate mesh quality and produce a report.

    Args:
        mesh: MeshData to validate.

    Returns:
        MeshQualityReport with statistics and issues.
    """
    issues = []
    volumes = []
    aspect_ratios = []
    n_inverted = 0
    n_degenerate = 0

    for i in range(mesh.n_elements):
        n0, n1, n2, n3 = mesh.elements[i]
        p0 = mesh.nodes[n0]
        p1 = mesh.nodes[n1]
        p2 = mesh.nodes[n2]
        p3 = mesh.nodes[n3]

        vol = tet_volume(p0, p1, p2, p3)
        ar = tet_aspect_ratio(p0, p1, p2, p3)

        volumes.append(vol)
        aspect_ratios.append(ar)

        if vol <= 0:
            n_inverted += 1
        if ar > 100:
            n_degenerate += 1

    volumes = np.array(volumes)
    aspect_ratios = np.array(aspect_ratios)
    finite_ar = aspect_ratios[np.isfinite(aspect_ratios)]

    if n_inverted > 0:
        issues.append(f"{n_inverted} inverted elements (negative volume)")
    if n_degenerate > 0:
        issues.append(f"{n_degenerate} degenerate elements (aspect ratio > 100)")
    if mesh.n_elements == 0:
        issues.append("Mesh has no elements")
    if mesh.n_nodes < 4:
        issues.append("Mesh has fewer than 4 nodes")

    is_valid = n_inverted == 0 and mesh.n_elements > 0 and mesh.n_nodes >= 4

    return MeshQualityReport(
        n_nodes=mesh.n_nodes,
        n_elements=mesh.n_elements,
        n_boundary_faces=mesh.n_boundary_faces,
        total_volume=float(np.sum(volumes[volumes > 0])) if len(volumes) > 0 else 0.0,
        min_element_volume=float(volumes.min()) if len(volumes) > 0 else 0.0,
        max_element_volume=float(volumes.max()) if len(volumes) > 0 else 0.0,
        mean_element_volume=float(volumes.mean()) if len(volumes) > 0 else 0.0,
        min_aspect_ratio=float(finite_ar.min()) if len(finite_ar) > 0 else float("inf"),
        max_aspect_ratio=float(finite_ar.max()) if len(finite_ar) > 0 else float("inf"),
        mean_aspect_ratio=float(finite_ar.mean()) if len(finite_ar) > 0 else float("inf"),
        n_degenerate=n_degenerate,
        n_inverted=n_inverted,
        is_valid=is_valid,
        issues=issues,
    )
```

---

### S1.3 — `MeshIR` w Rust (fullmag-ir)

**Plik do edycji:** `crates/fullmag-ir/src/lib.rs`

Nowe typy:

```rust
/// Tetrahedral mesh data for FEM computation.
///
/// All indices are 0-based. Coordinates in meters.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct MeshIR {
    /// Node coordinates, flattened: [x0, y0, z0, x1, y1, z1, ...].
    /// Length = 3 * n_nodes.
    pub nodes: Vec<f64>,

    /// Tetrahedral element connectivity, flattened: [n0, n1, n2, n3, ...].
    /// Length = 4 * n_elements. Each value is a 0-based node index.
    pub elements: Vec<u32>,

    /// Per-node domain marker (0 = interior, 1 = boundary).
    /// Length = n_nodes.
    pub node_markers: Vec<u8>,

    /// Per-element material region ID.
    /// Length = n_elements.
    pub element_markers: Vec<u32>,

    /// Boundary triangle connectivity, flattened: [n0, n1, n2, ...].
    /// Length = 3 * n_boundary_faces.
    pub boundary_faces: Vec<u32>,

    /// Per-boundary-face marker.
    /// Length = n_boundary_faces.
    pub boundary_markers: Vec<u32>,
}

impl MeshIR {
    /// Number of nodes in the mesh.
    pub fn n_nodes(&self) -> usize {
        self.nodes.len() / 3
    }

    /// Number of tetrahedral elements.
    pub fn n_elements(&self) -> usize {
        self.elements.len() / 4
    }

    /// Number of boundary faces.
    pub fn n_boundary_faces(&self) -> usize {
        self.boundary_faces.len() / 3
    }

    /// Basic validation: lengths are consistent.
    pub fn validate(&self) -> Result<(), String> {
        if self.nodes.len() % 3 != 0 {
            return Err("nodes length must be a multiple of 3".into());
        }
        if self.elements.len() % 4 != 0 {
            return Err("elements length must be a multiple of 4".into());
        }
        if self.node_markers.len() != self.n_nodes() {
            return Err(format!(
                "node_markers length {} != n_nodes {}",
                self.node_markers.len(),
                self.n_nodes()
            ));
        }
        if self.element_markers.len() != self.n_elements() {
            return Err(format!(
                "element_markers length {} != n_elements {}",
                self.element_markers.len(),
                self.n_elements()
            ));
        }
        if self.boundary_faces.len() % 3 != 0 {
            return Err("boundary_faces length must be a multiple of 3".into());
        }
        if self.boundary_markers.len() != self.n_boundary_faces() {
            return Err(format!(
                "boundary_markers length {} != n_boundary_faces {}",
                self.boundary_markers.len(),
                self.n_boundary_faces()
            ));
        }
        // Check node indices in elements are valid
        let n = self.n_nodes() as u32;
        for &idx in &self.elements {
            if idx >= n {
                return Err(format!("element references node {} but only {} nodes exist", idx, n));
            }
        }
        for &idx in &self.boundary_faces {
            if idx >= n {
                return Err(format!("boundary face references node {} but only {} nodes exist", idx, n));
            }
        }
        Ok(())
    }
}
```

### S1.4 — Transfer Python → Rust (PyO3)

**Plik do edycji:** `crates/fullmag-py-core/src/lib.rs` (lub moduł mesh)

```rust
/// Convert Python MeshData to Rust MeshIR.
///
/// Called from Python: `mesh_ir = _core.mesh_data_to_ir(mesh_data)`
#[pyfunction]
fn mesh_data_to_ir(
    nodes: PyReadonlyArray2<f64>,        // (N, 3)
    elements: PyReadonlyArray2<i32>,     // (M, 4)
    node_markers: PyReadonlyArray1<i32>, // (N,)
    element_markers: PyReadonlyArray1<i32>, // (M,)
    boundary_faces: PyReadonlyArray2<i32>,   // (F, 3)
    boundary_markers: PyReadonlyArray1<i32>, // (F,)
) -> PyResult<MeshIR> {
    let nodes_flat: Vec<f64> = nodes.as_array().iter().copied().collect();
    let elements_flat: Vec<u32> = elements.as_array().iter().map(|&v| v as u32).collect();
    let node_markers_vec: Vec<u8> = node_markers.as_array().iter().map(|&v| v as u8).collect();
    let element_markers_vec: Vec<u32> = element_markers.as_array().iter().map(|&v| v as u32).collect();
    let boundary_faces_flat: Vec<u32> = boundary_faces.as_array().iter().map(|&v| v as u32).collect();
    let boundary_markers_vec: Vec<u32> = boundary_markers.as_array().iter().map(|&v| v as u32).collect();

    let mesh = MeshIR {
        nodes: nodes_flat,
        elements: elements_flat,
        node_markers: node_markers_vec,
        element_markers: element_markers_vec,
        boundary_faces: boundary_faces_flat,
        boundary_markers: boundary_markers_vec,
    };

    mesh.validate().map_err(|e| pyo3::exceptions::PyValueError::new_err(e))?;
    Ok(mesh)
}
```

### S1.5 — Aktualizacja `FemPlanIR`

**Plik:** `crates/fullmag-ir/src/lib.rs` — edycja istniejącej struktury:

```rust
/// FROM (current stub):
pub struct FemPlanIR {
    pub mesh_name: String,
    pub initial_magnetization: InitialMagnetizationIR,
    pub exchange_bc: ExchangeBcIR,
    pub integrator: IntegratorChoice,
    pub fixed_timestep: f64,
}

/// TO (full version):
pub struct FemPlanIR {
    /// Mesh data for FEM computation.
    pub mesh: MeshIR,

    /// FE polynomial order (1 = linear, 2 = quadratic).
    pub fe_order: u32,

    /// Material properties applied uniformly.
    pub material: MaterialIR,

    /// Energy terms enabled.
    pub energy_terms: Vec<EnergyTermIR>,

    /// Initial magnetization configuration.
    pub initial_magnetization: InitialMagnetizationIR,

    /// Exchange boundary condition.
    pub exchange_bc: ExchangeBcIR,

    /// Time integrator.
    pub integrator: IntegratorChoice,

    /// Fixed timestep in seconds.
    pub fixed_timestep: f64,

    /// Air-box configuration for demag.
    pub air_box: Option<AirBoxConfig>,

    /// Solver configuration for Poisson (demag).
    pub demag_solver: DemagSolverConfig,
}

/// Air-box configuration for FEM demag.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AirBoxConfig {
    /// Multiplicative factor: air_extent = factor * max(geometry_size).
    pub factor: f64,
    /// BC on outer air boundary: "dirichlet" (u=0) or "robin".
    pub outer_bc: AirBoxBoundaryCondition,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum AirBoxBoundaryCondition {
    /// u = 0 on ∂D (first-order truncation).
    Dirichlet,
    /// ∂u/∂n + (1/R)u = 0 (Robin, better accuracy).
    Robin,
}

/// Solver configuration for the demag Poisson problem.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DemagSolverConfig {
    /// Solver type: "cg", "gmres".
    pub solver: LinearSolverType,
    /// Preconditioner: "amg", "jacobi", "none".
    pub preconditioner: PreconditionerType,
    /// Relative tolerance.
    pub rtol: f64,
    /// Maximum iterations.
    pub max_iter: u32,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum LinearSolverType {
    Cg,
    Gmres,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub enum PreconditionerType {
    Amg,
    Jacobi,
    None,
}
```

---

### S1.6 — Integracja z `to_ir()` pipeline

**Plik:** `packages/fullmag-py/src/fullmag/model/problem.py`

Zadanie: Rozszerzyć `to_ir()` aby dla `backend="fem"`:
1. Wygenerować siatkę z `MeshGenerator` na podstawie `GeometryIR` + `FemHintsIR`.
2. Walidować jakość siatki (`validate_mesh`).
3. Przekazać `MeshIR` do `FemPlanIR`.

```python
# In Problem.to_ir() or _build_fem_plan():
if self.backend == "fem":
    from fullmag.meshing import generate_mesh, validate_mesh

    geometry = self.shape  # Box, Cylinder, ImportedGeometry
    fem_hints = self.discretization  # FEM(hmax=..., order=...)

    # Generate mesh based on geometry type
    if isinstance(geometry, Box):
        mesh = generate_box_mesh(
            size=(geometry.sx, geometry.sy, geometry.sz),
            hmax=fem_hints.hmax,
            order=fem_hints.order,
            air_factor=3.0 if self.has_demag else 0.0,
        )
    elif isinstance(geometry, Cylinder):
        mesh = generate_cylinder_mesh(
            radius=geometry.radius,
            height=geometry.height,
            hmax=fem_hints.hmax,
            order=fem_hints.order,
            air_factor=3.0 if self.has_demag else 0.0,
        )
    # ... etc

    # Validate
    report = validate_mesh(mesh)
    if not report.is_valid:
        raise ValueError(f"Mesh validation failed: {report.issues}")

    # Convert to IR
    mesh_ir = _core.mesh_data_to_ir(
        mesh.nodes, mesh.elements,
        mesh.node_markers, mesh.element_markers,
        mesh.boundary_faces, mesh.boundary_markers,
    )
```

---

### S1.7 — Testy

**Plik:** `packages/fullmag-py/tests/test_meshing.py`

| Test | Opis |
|------|------|
| `test_box_mesh_basic` | Box 100×100×20 nm, hmax=10 nm → >100 elementów, valid |
| `test_box_mesh_volume` | Suma objętości elementów ≈ całkowita objętość boxa (±1%) |
| `test_cylinder_mesh_basic` | Cylinder R=50 nm, H=20 nm, hmax=10 nm → valid |
| `test_cylinder_mesh_volume` | Suma objętości ≈ πR²H (±5% ze względu na dyskretyzację) |
| `test_air_box_generation` | air_factor=3.0 → więcej elementów niż bez air-boxu |
| `test_mesh_quality_report` | Brak inverted, brak degenerate dla standardowych meshów |
| `test_mesh_save_load_roundtrip` | save → load → arrays identical |
| `test_mesh_ir_validation` | MeshIR.validate() passes for valid, fails for invalid |
| `test_mesh_ir_transfer` | Python → Rust → back → arrays identical |
| `test_node_volumes` | Sum of node_volumes ≈ total volume (±0.1%) |
| `test_hmax_controls_density` | smaller hmax → more elements |

---

## 4. Struktura plików (co nowego tworzy S1)

```
packages/fullmag-py/src/fullmag/meshing/
├── __init__.py           # public API: generate_mesh, MeshData, validate_mesh
├── gmsh_bridge.py        # Gmsh SDK integration
└── quality.py            # Mesh quality validation

packages/fullmag-py/tests/
└── test_meshing.py       # S1 tests (11 test cases)

crates/fullmag-ir/src/lib.rs
    + MeshIR struct
    + AirBoxConfig, DemagSolverConfig, etc.
    + FemPlanIR update

crates/fullmag-py-core/src/lib.rs   (or mesh.rs module)
    + mesh_data_to_ir() PyO3 function
```

---

## 5. Zależności do dodania

### Python (pyproject.toml)

```toml
[project.optional-dependencies]
fem = [
    "gmsh>=4.12",
    "meshio>=5.3",
]
```

### Rust (Cargo.toml — fullmag-ir)

Brak nowych zależności (`serde` już jest).

---

## 6. Kryteria akceptacji S1

| # | Kryterium | Jak sprawdzić |
|---|-----------|---------------|
| 1 | Box 100×100×20 nm, hmax=5 nm → valid mesh | `test_box_mesh_basic` |
| 2 | Cylinder R=50 nm, H=20 nm → valid mesh | `test_cylinder_mesh_basic` |
| 3 | Air-box generuje się poprawnie | `test_air_box_generation` |
| 4 | MeshIR przechodzi walidację | `test_mesh_ir_validation` |
| 5 | Roundtrip Python↔Rust zachowuje dane | `test_mesh_ir_transfer` |
| 6 | Jakość siatki: 0 inverted, 0 degenerate | `test_mesh_quality_report` |
| 7 | `pip install fullmag[fem]` instaluje gmsh | Manual check |

---

## 7. Ryzyka i mitigacja

| Ryzyko | Wpływ | Mitigacja |
|--------|-------|-----------|
| Gmsh Python SDK niedostępne na niektórych platformach | Nie można generować meshów | Alternatywa: Gmsh CLI subprocess |
| Licencja GPL Gmsha | Propagacja GPL? | Gmsh SDK API jest oddzielne; MeshData to dane, nie linkowany kod |
| Bardzo duże meshe (>1M elementów) powolny transfer | Wolne `to_ir()` | Lazy mesh: generuj raz, cachuj na dysku (.npz) |
| Air-box za mały → boundary artifacts w demag | Złe wyniki demag | Domyślny factor=3.0, walidacja w docs |
