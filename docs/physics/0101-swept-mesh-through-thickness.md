# Swept mesh (through-thickness structured layers)

- Status: implemented for Box, Cylinder, and ArchWaveguide thin-film surface layering
- Last updated: 2026-07-27
- Related specs: `docs/physics/0100-mesh-and-region-discretization.md`
- Mixed-P1 target: `docs/physics/0106-fem-mixed-prism-pyramid-shared-domain.md`

## 1. Problem statement

Thin-film micromagnetic geometries (bilayers, multilayers, patterned disks, tracks) have large
in-plane extent relative to their thickness. A fully tetrahedral mesh often wastes elements on the
thin dimension or produces badly shaped (high-aspect-ratio) tetrahedra that degrade solver accuracy
and performance.

A swept (extruded, through-thickness) mesh generates structured prismatic or hexahedral layers along
the thin direction and meshes the remaining face with an unstructured 2-D triangulation. This gives
fine through-thickness resolution with high element quality, matching COMSOL's "swept mesh"
paradigm.

## 2. Physical model

### 2.1 Governing equations

No new equations; swept meshing is a discretization strategy. It affects element shape functions,
quadrature quality, and how exchange/demag operators discretize gradients through the film normal.

### 2.2 Symbols and SI units

| Symbol         | Meaning                          | Unit |
|----------------|----------------------------------|------|
| $N_z$          | Number of layers through thickness | —  |
| $t$            | Total thickness                  | m    |
| $h_z$          | Layer height ($t / N_z$ for uniform) | m |

### 2.3 Assumptions and approximations

- The geometry is prismatic or nearly prismatic along one axis (the sweep direction).
- Source and target faces are parallel planar or gently curved.
- In-plane mesh nodes are replicated at each swept layer; node count scales as
  $N_\text{surface} \times (N_z + 1)$.

## 3. Numerical interpretation

### 3.1 FDM

Not applicable. FDM already uses a regular Cartesian grid with explicit cell sizes per direction.

### 3.2 FEM

The swept mesh strategy applies to FEM geometries where one direction (typically z for thin films)
has significantly fewer characteristic lengths than the in-plane directions.

For `ArchWaveguide`, the supported production path is layered surface-constrained tetrahedral
meshing: the arch surface is generated with explicit through-thickness layer boundaries, then the
shared-domain tetrahedral mesh conforms to those layer boundaries. This gives deterministic control
over "one element through a 2 nm thickness" while preserving the airbox/shared-domain mesh contract.

**Distribution types:**

| Distribution  | Layer heights                                      |
|---------------|---------------------------------------------------|
| `fixed`       | All layers equal: $h_i = t / N_z$                 |
| `linear`      | Linear growth: $h_i = h_0 + i \cdot d$            |
| `exponential` | Geometric growth: $h_i = h_0 \cdot r^i$           |

Non-uniform distributions concentrate elements near surfaces (interfaces, free boundaries) where
exchange and stray-field gradients are strongest.

**Element type:** Swept meshing produces prismatic (wedge) elements from triangular source faces or
hexahedral elements from quadrilateral source faces. The current tetrahedral solver path may convert
these cells only when the requested contract permits that realized topology. The strict mixed-P1
target keeps native `prism6` magnetic cells, uses `pyramid5` only in the air transition, and forbids
silent prism-to-tet conversion; that target is not executable yet.

### 3.3 Hybrid

Hybrid paths may benefit from a swept mesh on the FEM side while using the in-plane Cartesian grid
for FDM operators. The interface projection is simpler when the FEM layer boundaries align with FDM
cell boundaries.

## 4. API, IR, and planner impact

### 4.1 Python API surface

Current Python object mesh API:

```python
waveguide.mesh(
    maximum_element_size=50e-9,
    minimum_element_size=2e-9,
    mesh_strategy="swept_prism",
    through_thickness_elements=1,
    through_thickness_distribution="fixed",
    sweep_face_meshing="triangular",
)
```

The convenience form is:

```python
waveguide.mesh.swept(elements=1, distribution="fixed", face_meshing="triangular")
```

Swept/layered controls are per-object mesh semantics. A single object may request one through-
thickness layer when the physical model intentionally assumes no through-thickness variation.
Fullmag still reports a thin-film diagnostic warning below four layers because that is often too
coarse for exchange-gradient accuracy.

### 4.2 ProblemIR representation

```rust
pub struct SweptMeshHintsIR {
    pub sweep_direction: String,           // "auto" | "x" | "y" | "z"
    pub num_layers: u32,
    pub distribution: String,              // "uniform" | "arithmetic" | "geometric"
    pub growth_rate: Option<f64>,
}
```

Attached to `FemPerObjectTargetIR` as an optional `swept` field.

### 4.3 Planner and capability-matrix impact

- The planner must verify that the geometry is prismatic before accepting swept mesh controls.
- If `sweep_direction = "auto"`, the planner resolves it from the geometry's bounding box
  (shortest axis).
- Gmsh availability is sufficient only to author or generate a swept mesh. Native mixed-element
  execution additionally requires the exact topology, operator, ABI, and lane capabilities in note
  0106; unsupported combinations reject before backend startup.

## 5. Validation strategy

### 5.1 Analytical checks

- For a native-prism request, verify exactly
  `N_\text{surface\_elements} × N_z` magnetic prisms in the realized solver mesh, with no tet split.
- Verify layer heights match the requested distribution.

### 5.2 Cross-backend checks

- Compare FEM solutions on swept vs. unstructured meshes for a standard thin-film problem.
- Element quality metrics (SICN, gamma) should improve for swept meshes on thin geometries.

### 5.3 Regression tests

- Round-trip: Python → IR → session state → UI → export → Python must preserve swept mesh controls.
- Solver convergence on a 5 nm thin film with 3 swept layers vs. unstructured.

## 6. Completeness checklist

- [x] Python API — `mesh_strategy`, `through_thickness_*`, and `mesh.swept(...)`
- [x] ProblemIR/session metadata — mesh workflow preserves swept controls for single-object and mesh-options paths
- [x] Planner — swept mesh eligibility check for Box, Cylinder, and ArchWaveguide
- [ ] Capability matrix — existing swept authoring and native mixed-P1 execution are distinct
- [ ] FDM backend — N/A
- [x] FEM backend — Gmsh swept mesh generation for Box/Cylinder and the layered ArchWaveguide
  surface-constrained tetrahedral path
- [ ] FEM mixed-P1 backend — native prism/pyramid/tet import and operators
- [ ] UI — swept mesh controls panel
- [ ] Round-trip — Python ↔ UI export preservation
- [x] Validation — ArchWaveguide layered surface topology and runtime metadata regression tests

## 7. Known limits and deferred work

- Only single-axis sweeps are supported initially (no multi-step COMSOL-style sweeps).
- Full curved-volume prism/hexahedral sweeping for `ArchWaveguide` is deferred; current support is
  layered surface-constrained tetrahedral meshing in the shared-domain pipeline.
- Auto-detection of sweep eligibility relies on bounding-box heuristics; complex non-prismatic
  geometries may need explicit user hints.
