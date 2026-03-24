# Capability matrix v0

## Purpose

The capability matrix answers two questions before execution:

1. Is a Python-authored `ProblemIR` legal for the requested backend and mode?
2. If it is legal, what planning path should be selected?

## Three-tier feature status model

Every feature carries one of three statuses:

| Status | Meaning |
|--------|---------|
| **`semantic-only`** | Legal in Python API and `ProblemIR`. Can be serialized, validated, and planned. Not numerically implemented. |
| **`internal-reference`** | Numerically implemented inside `fullmag-engine` or equivalent crate, but not wired to the public `Simulation.run()` path. |
| **`public-executable`** | Fully wired end-to-end: Python `Simulation.run()` → plan → runner → engine → artifacts. |

## Current bootstrap policy

- `strict` means backend-neutral semantics only.
- `extended` is reserved for future backend-specific features.
- `hybrid` is explicit and requires both hybrid mode and hybrid backend.

## Capability matrix

| Feature | FDM | FEM | Hybrid | Tier | Notes |
|---------|-----|-----|--------|------|-------|
| `Box` geometry | ✅ exec | planned | planned | **public-executable** (FDM) | Box→grid lowering in `fullmag-plan` |
| `Cylinder` geometry | planned | planned | planned | semantic-only | Requires active-mask voxelizer for accurate curved-boundary FDM execution |
| Imported geometry ref | planned | planned | planned | semantic-only | FDM planner accepts it when a precomputed grid asset is attached; public execution still depends on voxelization extras |
| Material constants (`Ms`, `A`, `alpha`) | ✅ exec | planned | planned | **public-executable** (FDM) | Used by the CPU reference FDM runner |
| Material constants (`Ku1`, `anisU`) | planned | planned | planned | semantic-only | Anisotropy not in exchange-only scope |
| Ferromagnet + uniform `m0` | ✅ exec | planned | planned | **public-executable** (FDM) | Lowered to per-cell vectors by planner |
| Ferromagnet + random `m0` | ✅ exec | planned | planned | **public-executable** (FDM) | Deterministic xorshift64 RNG in planner |
| `Exchange` | ✅ exec | planned | planned | **public-executable** (FDM) | CPU 6-point stencil in `fullmag-engine` |
| `Demag` | ✅ exec | planned | planned | **public-executable** (FDM) | CPU bootstrap spectral demag and CUDA spectral demag on zero-padded grid |
| `InterfacialDMI` | planned | planned | planned | semantic-only | Not numerically implemented |
| `Zeeman` | ✅ exec | planned | planned | **public-executable** (FDM) | Public API still authors `B`; planner normalizes to `H_ext` in A/m for CPU and CUDA FDM |
| `LLG` (Heun) | ✅ exec | planned | planned | **public-executable** (FDM) | Heun stepper in `fullmag-engine` |
| Execution precision `double` | ✅ exec | planned | planned | **public-executable** (FDM) | Current CPU reference precision and qualified CUDA precision for the narrow FDM slice |
| Execution precision `single` | planned | planned | planned | semantic-only | Defined in Python API and `ProblemIR`; reserved for Phase 2 CUDA FDM |
| Field/scalar outputs (`m`, `H_ex`, `H_demag`, `H_ext`, `H_eff`, `E_ex`, `E_demag`, `E_ext`, `E_total`) | ✅ exec | planned | planned | **public-executable** (FDM) | Artifacts: `metadata.json`, expanded `scalars.csv`, and per-field snapshots under `fields/` |
| FDM hints | ✅ exec | n/a | planned | **public-executable** | Cell size → grid dims in planner |
| FEM hints | n/a | planned | planned | semantic-only | Planner can build `FemPlanIR` from precomputed `MeshIR`; runner execution remains deferred |
| Hybrid hints | n/a | n/a | planned | semantic-only | Requires hybrid mode and backend |

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
