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

## Authoring-layer note

- `SceneDocument` `scene.v1` is now the canonical control-room authoring document for geometry,
  material assignment, magnetization initialization, study defaults, and editor metadata.
- This does not expand executable capability coverage by itself.
- Execution legality, planner resolution, requested-vs-resolved backend semantics, and runtime
  provenance remain governed by the same `ProblemIR` and backend capability rules listed below.

## Runtime engine naming

- `BackendPlanIR::Fem` on CPU resolves to `fem_cpu_native`.
- `BackendPlanIR::Fem` on GPU resolves to `fem_native_gpu`.
- `fem_cpu_reference` is reserved for the Rust FEM reference runner and must not appear as the
  public time-domain FEM `resolved_engine_id`.
- `BackendPlanIR::FemEigen` on CPU resolves to `fem_eigen_cpu_reference`.
- `BackendPlanIR::FemEigen` on GPU resolves to `fem_eigen_native_gpu`.
- `FULLMAG_FEM_EXECUTION=cpu` selects the CPU lane, but the final engine id still depends on the
  workflow family (`fem_cpu_native` for time-domain FEM, `fem_eigen_cpu_reference` for FEM eigen).
- `resolve_runtime_capabilities()` must return the same canonical engine ids as runtime/session
  resolution; capabilities metadata is part of the same public execution contract.
- Canonical reference: `docs/specs/runtime-engine-naming-v0.md`.

## Capability matrix

| Feature | FDM | FEM | Hybrid | Tier | Notes |
|---------|-----|-----|--------|------|-------|
| `Box` geometry | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Box→grid lowering for FDM and Box→mesh lowering for FEM |
| `Cylinder` geometry | planned | planned | planned | semantic-only | Requires active-mask voxelizer for accurate curved-boundary FDM execution |
| Imported geometry ref | planned | planned | planned | semantic-only | FDM planner accepts it when a precomputed grid asset is attached; public execution still depends on voxelization extras |
| Material constants (`Ms`, `A`, `alpha`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Used by the CPU reference FDM runner and MFEM-native FEM CPU/GPU runners |
| Material constants (`Ku1`, `anisU`) | planned | planned | planned | semantic-only | Anisotropy not in exchange-only scope |
| Ferromagnet + uniform `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Lowered to per-cell vectors for FDM and per-node vectors for FEM |
| Ferromagnet + random `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Deterministic xorshift64 RNG in planner |
| Multiple `Ferromagnet` bodies + global demag | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses multilayer-convolution for eligible z-stacks, with CPU reference, a native CUDA single-grid fast path for compatible stacks, and `cuda-assisted` fallback for the remaining current public scope; the CUDA multilayer paths honor `execution_precision` (`double` and calibrated `single`) across the native fast path and the assisted multilayer demag/Heun runtime; FEM merges disjoint mesh assets into one bootstrap plan with body-local exchange and global demag |
| `Exchange` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU 6-point stencil in FDM and lumped-mass P1 operator in FEM |
| `Demag` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses Newell tensor FFT; executable FEM uses MFEM-native CPU/GPU paths with transfer-grid and Poisson demag realizations. For explicit native `poisson_robin`, the managed runtime now resolves directly to `hypre_pcg_boomeramg` and logs the resolved solver; when FEM CPU thread selection is left on `auto`, the runtime may resolve to a smaller effective OpenMP count for Poisson/Robin meshes and logs requested vs effective threads. The older Rust FEM Robin/transfer-grid seam remains internal/reference-only under `fem_cpu_reference` |
| `InterfacialDMI` | planned | planned | planned | semantic-only | Not numerically implemented |
| `Zeeman` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Public API authors `B`; planner normalizes to `H_ext` in A/m for CPU FDM and CPU FEM |
| `Magnetoelastic` | planned | planned | planned | **internal-reference** | Small-strain magnetoelastic coupling (B1/B2 cubic, λ_s isotropic); prescribed-strain H_mel wired into H_eff; see `docs/physics/0700-shared-magnetoelastic-semantics.md` |
| `LLG` (Heun) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Heun stepper in `fullmag-engine` |
| `Relaxation(llg_overdamped)` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Shared `StudyIR::Relaxation` with torque / energy / max-step stopping; currently reuses the damped LLG field pipeline |
| `Relaxation(projected_gradient_bb)` | ✅ exec | planned | planned | **public-executable** (FDM) | Direct energy minimization on the sphere product manifold with alternating BB1/BB2 step sizes and Armijo backtracking; see `docs/physics/0500-fdm-relaxation-algorithms.md` |
| `Relaxation(nonlinear_cg)` | ✅ exec | planned | planned | **public-executable** (FDM) | Polak–Ribière+ CG with tangent-space vector transport, periodic restarts, and Armijo backtracking; see `docs/physics/0500-fdm-relaxation-algorithms.md` |
| `Relaxation(tangent_plane_implicit)` | planned | planned | planned | semantic-only | Canonical production-target FEM relaxation family; execution deferred |
| Execution precision `double` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU reference FDM remains the trusted baseline; FEM executes through MFEM-native CPU/GPU runtimes |
| Execution precision `single` | ✅ exec | planned | planned | **public-executable** (CUDA FDM) | Public CUDA FDM supports calibrated `single` precision across native single-body runs and multilayer CUDA paths; CPU reference FDM remains `double`-only |
| Field/scalar outputs (`m`, `H_ex`, `H_ext`, `H_eff`, `E_ex`, `E_ext`, `E_total`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Common artifact layout for current FDM/FEM executable slices |
| FEM demag outputs (`H_demag`, `E_demag`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | MFEM-native FEM CPU/GPU emit demag outputs through the same quantity/artifact contract as FDM |
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
