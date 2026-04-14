# Swept mesh (through-thickness structured layers)

- Status: draft
- Last updated: 2026-04-15
- Related specs: `docs/physics/0100-mesh-and-region-discretization.md`

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

**Distribution types:**

| Distribution  | Layer heights                                      |
|---------------|---------------------------------------------------|
| `uniform`     | All layers equal: $h_i = t / N_z$                 |
| `arithmetic`  | Linear growth: $h_i = h_0 + i \cdot d$            |
| `geometric`   | Exponential growth: $h_i = h_0 \cdot r^i$         |

Non-uniform distributions concentrate elements near surfaces (interfaces, free boundaries) where
exchange and stray-field gradients are strongest.

**Element type:** Swept meshing produces prismatic (wedge) elements from triangular source faces or
hexahedral elements from quadrilateral source faces. The mesh generator (Gmsh) converts these to
tetrahedra if the solver requires it.

### 3.3 Hybrid

Hybrid paths may benefit from a swept mesh on the FEM side while using the in-plane Cartesian grid
for FDM operators. The interface projection is simpler when the FEM layer boundaries align with FDM
cell boundaries.

## 4. API, IR, and planner impact

### 4.1 Python API surface

New dataclasses in `fullmag.model.discretization`:

```python
@dataclass
class SweepDistribution:
    kind: Literal["uniform", "arithmetic", "geometric"] = "uniform"
    num_layers: int = 1
    growth_rate: float = 1.0

@dataclass
class SweptMeshControls:
    distribution: SweepDistribution
    sweep_direction: Literal["auto", "x", "y", "z"] = "auto"
```

`SweptMeshControls` attaches to a per-object mesh recipe (future `PerObjectMeshRecipe.swept`),
not to the global `FEM` hints, because different objects in a multilayer may need different sweep
parameters.

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
- Capability: swept meshing is a Gmsh feature, so it is available everywhere Gmsh is available.
  No backend restriction.

## 5. Validation strategy

### 5.1 Analytical checks

- Verify element count: exactly `N_\text{surface\_elements} × N_z` prisms (before tet splitting).
- Verify layer heights match the requested distribution.

### 5.2 Cross-backend checks

- Compare FEM solutions on swept vs. unstructured meshes for a standard thin-film problem.
- Element quality metrics (SICN, gamma) should improve for swept meshes on thin geometries.

### 5.3 Regression tests

- Round-trip: Python → IR → session state → UI → export → Python must preserve swept mesh controls.
- Solver convergence on a 5 nm thin film with 3 swept layers vs. unstructured.

## 6. Completeness checklist

- [ ] Python API — `SweepDistribution`, `SweptMeshControls` dataclasses
- [ ] ProblemIR — `SweptMeshHintsIR`
- [ ] Planner — swept mesh eligibility check
- [ ] Capability matrix — no restrictions (Gmsh-only)
- [ ] FDM backend — N/A
- [ ] FEM backend — Gmsh swept mesh generation
- [ ] UI — swept mesh controls panel
- [ ] Round-trip — Python ↔ UI export preservation
- [ ] Validation — element count and quality checks

## 7. Known limits and deferred work

- Only single-axis sweeps are supported initially (no multi-step COMSOL-style sweeps).
- Curved sweep paths are deferred.
- Auto-detection of sweep eligibility relies on bounding-box heuristics; complex non-prismatic
  geometries may need explicit user hints.
