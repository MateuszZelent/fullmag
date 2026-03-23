# Capability matrix v0

## Purpose

The capability matrix answers two questions before execution:

1. Is a Python-authored `ProblemIR` legal for the requested backend and mode?
2. If it is legal, what planning path should be selected?

## Current bootstrap policy

- `strict` means backend-neutral semantics only.
- `extended` is reserved for future backend-specific features.
- `hybrid` is explicit and requires both hybrid mode and hybrid backend.

## Bootstrap matrix

| Feature | FDM | FEM | Hybrid | Modes | Notes |
|---------|-----|-----|--------|-------|-------|
| Imported geometry reference | planned | planned | planned | strict, extended, hybrid | Shared semantics only |
| Analytic primitive geometry (`Box`, `Cylinder`) | planned | planned | planned | strict, extended, hybrid | Planner-owned voxelization/meshing from shared primitives |
| Material constants (`Ms`, `A`, `alpha`, `Ku1`, `anisU`) | planned | planned | planned | strict, extended, hybrid | Serialized in canonical IR |
| Ferromagnet + uniform `m0` | planned | planned | planned | strict, extended, hybrid | Shared bootstrap surface |
| Ferromagnet + seeded-random `m0` | planned | planned | planned | strict, extended, hybrid | Shared seed semantics; backend-specific discretization allowed |
| Ferromagnet + sampled-field `m0` | planned | planned | planned | strict, extended, hybrid | Canonical sampled values; lowering-time sampling/projection still evolving |
| `Exchange` | planned | planned | planned | strict, extended, hybrid | Shared term; internal CPU/FDM reference operator exists, public lowering still pending |
| `Demag` | planned | planned | planned | strict, extended, hybrid | Planned, not numerically implemented |
| `InterfacialDMI` | planned | planned | planned | strict, extended, hybrid | Planned, not numerically implemented |
| `Zeeman` | planned | planned | planned | strict, extended, hybrid | Planned, not numerically implemented |
| `LLG` | planned | planned | planned | strict, extended, hybrid | Shared semantics defined; internal Heun-based CPU/FDM reference stepper exists, public lowering still pending |
| Field/scalar outputs | planned | planned | planned | strict, extended, hybrid | Canonical output naming only |
| FDM hints | planned | n/a | planned | strict, extended | Shared hints, backend-specific use later |
| FEM hints | n/a | planned | planned | strict, extended | Shared hints, backend-specific use later |
| Hybrid hints | n/a | n/a | planned | hybrid | Requires hybrid mode and backend |

## Early planner rules

- `backend="auto"` resolves to `fdm` for `strict` and `extended` during bootstrap planning.
- `backend="auto"` does not resolve hybrid implicitly.
- Hybrid planning is a deliberate opt-in, not a fallback.

---

## Cross-backend comparison tolerances

### Purpose

FDM and FEM solutions to the same `ProblemIR` will differ numerically due to discretization
differences. Comparisons must be under **physical** tolerances, not bitwise equality.

### Default tolerances

| Metric | Default tolerance | Notes |
|--------|-------------------|-------|
| Exchange energy (relative) | 1% | For meshes refined enough that discretization error is small |
| Effective field L2 norm | 5% | On matched/projected grids; dominated by boundary representation |
| Magnetization L2 norm | 1% | After sufficient relaxation with identical initial conditions |

### Convergence-rate requirement

Tolerance claims require a **convergence-rate study** demonstrating that:

1. The quantity of interest converges with mesh/grid refinement for each backend individually.
2. The FDM and FEM solutions converge to each other as both are refined.
3. The convergence rate is consistent with the expected order of the discretization scheme
   (second-order for FDM 6-point stencil, first- or second-order for FEM depending on element order).

Without a completed convergence study, comparison results are informational only and must not
be used as acceptance criteria.

### Comparison methodology

- **Grid matching**: FDM cell centers must be projected onto FEM nodes (or vice versa) using
  nearest-neighbor or interpolation. The projection scheme must be documented.
- **Boundary handling**: Boundary cells/nodes may be excluded from L2 norms if the geometric
  representation differs significantly between FDM voxels and FEM elements.
- **Time alignment**: Comparisons must be at identical simulation times. If adaptive stepping
  is used, outputs must be interpolated to common time points.
- **Reproducibility**: Comparison scripts must be deterministic and checked into the repository.
