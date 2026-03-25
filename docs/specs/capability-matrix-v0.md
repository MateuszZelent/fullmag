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
| `Box` geometry | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Box→grid lowering for FDM and Box→mesh lowering for FEM |
| `Cylinder` geometry | planned | planned | planned | semantic-only | Requires active-mask voxelizer for accurate curved-boundary FDM execution |
| Imported geometry ref | planned | planned | planned | semantic-only | FDM planner accepts it when a precomputed grid asset is attached; public execution still depends on voxelization extras |
| Material constants (`Ms`, `A`, `alpha`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Used by the CPU reference FDM runner and bootstrap FEM CPU reference runner |
| Material constants (`Ku1`, `anisU`) | planned | planned | planned | semantic-only | Anisotropy not in exchange-only scope |
| Ferromagnet + uniform `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Lowered to per-cell vectors for FDM and per-node vectors for FEM |
| Ferromagnet + random `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Deterministic xorshift64 RNG in planner |
| Multiple `Ferromagnet` bodies + global demag | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses multilayer-convolution for eligible z-stacks, with CPU reference and a public `cuda-assisted` runner; FEM merges disjoint mesh assets into one bootstrap plan with body-local exchange and global demag |
| `Exchange` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU 6-point stencil in FDM and lumped-mass P1 operator in FEM |
| `Demag` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses Newell tensor FFT; executable FEM currently uses a bootstrap transfer-grid demag seam (CPU reference and native MFEM path) for cross-backend parity |
| `InterfacialDMI` | planned | planned | planned | semantic-only | Not numerically implemented |
| `Zeeman` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Public API authors `B`; planner normalizes to `H_ext` in A/m for CPU FDM and CPU FEM |
| `LLG` (Heun) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Heun stepper in `fullmag-engine` |
| `Relaxation(llg_overdamped)` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Shared `StudyIR::Relaxation` with torque / energy / max-step stopping; currently reuses the damped LLG field pipeline |
| `Relaxation(projected_gradient_bb)` | ✅ exec | planned | planned | **public-executable** (FDM) | Direct energy minimization on the sphere product manifold with alternating BB1/BB2 step sizes and Armijo backtracking; see `docs/physics/0500-fdm-relaxation-algorithms.md` |
| `Relaxation(nonlinear_cg)` | ✅ exec | planned | planned | **public-executable** (FDM) | Polak–Ribière+ CG with tangent-space vector transport, periodic restarts, and Armijo backtracking; see `docs/physics/0500-fdm-relaxation-algorithms.md` |
| `Relaxation(tangent_plane_implicit)` | planned | planned | planned | semantic-only | Canonical production-target FEM relaxation family; execution deferred |
| Execution precision `double` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Current CPU reference precision for both narrow executable backends |
| Execution precision `single` | planned | planned | planned | semantic-only | Defined in Python API and `ProblemIR`; reserved for Phase 2 CUDA FDM |
| Field/scalar outputs (`m`, `H_ex`, `H_ext`, `H_eff`, `E_ex`, `E_ext`, `E_total`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Common artifact layout for current FDM/FEM executable slices |
| FEM demag outputs (`H_demag`, `E_demag`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Bootstrap FEM CPU reference emits demag outputs through the same quantity/artifact contract as FDM |
| FDM hints | ✅ exec | n/a | planned | **public-executable** | Cell size → grid dims in planner |
| FEM hints | n/a | ✅ exec | planned | **public-executable** (FEM) | Planner builds `FemPlanIR`; execution currently requires `MeshIR` or external meshing extras |
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
