# Capability matrix v0

## Purpose

The capability matrix answers two questions before execution:

1. Is a Python-authored `ProblemIR` legal for the requested backend and mode?
2. If it is legal, what planning path should be selected?

For the STT / STNO roadmap slice, the canonical machine-readable source is:

- `docs/specs/capability-matrix-v0.json`

That JSON file is the authoritative status source for:

- the four-state vocabulary,
- Oersted alignment,
- STNO benchmark / report status,
- explicit semantic-only status for deferred FEM periodic / eigen parity items.

The broader Markdown tables below remain a wider repository snapshot during the
status-model migration, but the JSON slice above wins if there is any conflict
for STT / STNO roadmap items.

## Four-state status vocabulary

Every product-facing feature should be described with one of these statuses:

| Status | Meaning |
|--------|---------|
| **`semantic_only`** | Legal in Python API and `ProblemIR`, but not executable on the current public path. |
| **`reference_executable`** | Executable on the trusted reference lane used for correctness and validation. |
| **`production_executable`** | Executable on the intended production lane. |
| **`validated`** | Executable and benchmarked with explicit regression coverage for the documented workload. |

## Native FEM qualification overlay

The 2026-05-16 native FEM audit adds a stricter reading rule for FEM CPU/GPU:
executor availability is not the same thing as solver qualification.

For native FEM, `production_executable` means the public lane can execute the
feature. It does **not** mean the feature is validated for production workloads
unless the row or related note lists explicit validated workloads.

Canonical references:

- `docs/adr/0014-native-fem-backend-modularization.md`
- `docs/specs/native-fem-backend-architecture-v1.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

Native FEM release documentation must use this minimum target as the first
qualified CPU FEM scope unless a narrower release note says otherwise:

```text
FEM CPU P1
no PBC unless feature-specific PBC gates pass
exchange
Zeeman
uniaxial anisotropy
cubic anisotropy after derivative tests
Poisson demag airbox with documented boundary limits
explicit RK fixed/adaptive with stop-reason telemetry
```

The following native FEM features may be executable in the current code, but
must not be described as `validated` until their feature-specific gates pass:

```text
Slonczewski STT
Zhang-Li STT
DMI interfacial/bulk
thermal noise
two-way magnetoelasticity
high-order FEM
general FEM GPU parity
```

Capability changes for those features must update both the capability row and
the relevant physics note with units, field/torque interpretation, validation
coverage, and known limits.

## Drive / STNO alignment slice

The following status statements are intentionally explicit because older docs and examples drifted:

| Feature | Status summary | Alignment note |
|---|---|---|
| `OerstedCylinder` on FDM and MFEM FEM | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM for constant / sinusoidal / pulse envelopes | `piecewise_linear` is still rejected on the public planner path. |
| `OerstedField(model="from_current_solution")` for cylindrical `prescribed_density` sources | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Executable only for `CurrentTransport(model="prescribed_density")` with cylindrical `solve_region` and axis-aligned current; planner lowers to the exact infinite-cylinder Oersted realization. |
| `OerstedField(model="from_current_solution")` for general `prescribed_density` sources | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Non-cylindrical prescribed-current sources lower to a midpoint Biot-Savart `H_oe(x)` realization with explicit provenance. The current FDM slice is still single-body and capped by planner source-cell count, but both CPU reference and native CUDA now execute the resulting per-cell field. |
| `CurrentTransport(model="prescribed_density")` | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Emits `current_transport/<name>.json` as an auxiliary artifact. On FDM and MFEM FEM it can bind named current sources into prescribed Slonczewski / Zhang-Li torque modules. |
| `SlonczewskiSTT` / `ZhangLiSTT` | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | MFEM FEM executes the current public single-module subset; the Rust FEM reference runner still does not. The 2026-05-16 native FEM audit treats these FEM paths as executable but not validated until the macrospin/current-scaling and 1D domain-wall gates in the native FEM validation matrix pass. |
| `examples/stno_vortex_ref_minimal.py` | `reference_executable` on the reference FDM lane | This is the canonical minimal STNO benchmark; full solver CI validation remains separate work. |
| `examples/stno_vortex_mtj_workflow.py` | non-canonical workflow example | Do not treat this generated workflow as the golden benchmark. |
| Artifact-backed STNO report | `validated` on the reference FDM lane | Uses real solver artifacts, not synthetic demonstration data, and has regression coverage for the analysis path. |
| FEM periodic / Floquet spin-wave support | `semantic_only` | Keep semantics and implementation status separate. |
| FEM eigen equilibrium import for STNO parity | `semantic_only` | Do not describe as end-to-end public STNO support yet. |

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
- `fem_cpu_native` is the sole maintained CPU FEM engine and denotes the MFEM/libCEED/hypre
  runtime stack, not a generic "some CPU-native FEM" bucket.
- `fem_cpu_native` availability is `native_fem_cpu_available`: an MFEM/hypre CPU-capable
  native FEM stack is present. CUDA runtime support, visible CUDA devices, and MFEM CUDA device
  support are not prerequisites for this CPU lane.
- `BackendPlanIR::Fem` on GPU resolves to `fem_native_gpu`.
- `fem_native_gpu` availability is `native_fem_gpu_available` and remains separate from the
  CPU probe. Non-forced GPU fallback may resolve to `fem_cpu_native` only when
  `native_fem_cpu_available=true`.
- Time-domain FEM has no CPU-reference fallback lane: if the local launcher lacks native MFEM
  support, it must hand off to the managed `fem-gpu-host` runtime or fail early with an explicit
  diagnostic.
- `fem_cpu_baseline_internal` is reserved for the Rust FEM baseline helper and must not appear as
  the public time-domain FEM `resolved_engine_id`.
- `BackendPlanIR::FemEigen` on CPU resolves to `fem_eigen_cpu_baseline`.
- `BackendPlanIR::FemEigen` on GPU resolves to `fem_eigen_native_gpu`.
- `FULLMAG_FEM_EXECUTION=cpu` selects the CPU lane, but the final engine id still depends on the
  workflow family (`fem_cpu_native` for time-domain FEM, `fem_eigen_cpu_baseline` for FEM eigen).
- `resolve_runtime_capabilities()` must return the same canonical engine ids as runtime/session
  resolution; capabilities metadata is part of the same public execution contract.
- Canonical reference: `docs/specs/runtime-engine-naming-v0.md`.

## Capability matrix

| Feature | FDM | FEM | Hybrid | Tier | Notes |
|---------|-----|-----|--------|------|-------|
| `Box` geometry | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Box→grid lowering for FDM and Box→mesh lowering for FEM |
| `Cylinder` geometry | planned | planned | planned | semantic-only | Requires active-mask voxelizer for accurate curved-boundary FDM execution |
| Imported geometry ref | planned | planned | planned | semantic-only | FDM planner accepts it when a precomputed grid asset is attached; public execution still depends on voxelization extras |
| Material constants (`Ms`, `A`, `alpha`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Used by the CPU reference FDM runner and the MFEM/libCEED/hypre CPU plus MFEM/libCEED/CUDA GPU FEM runners |
| Material constants (`Ku1`, `anisU`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Local uniaxial anisotropy is executable on the current FDM and FEM lanes. Native FEM CPU qualification now includes `exchange_anis_uniaxial` and `exchange_demag_anis_uniaxial` readiness gates for the no-PBC adaptive slice; this does not promote the broader FEM relaxation solver to `validated` or cover surface anisotropy. |
| Material constants (`Kc1`, `anisC1`, `anisC2`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Local cubic anisotropy is executable on the current FDM and FEM lanes. Native FEM CPU qualification now includes `exchange_anis_cubic` and `exchange_demag_anis_cubic` readiness gates for the no-PBC adaptive slice; this does not cover nonlocal or surface anisotropy. |
| Ferromagnet + uniform `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Lowered to per-cell vectors for FDM and per-node vectors for FEM |
| Ferromagnet + random `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Deterministic xorshift64 RNG in planner |
| Multiple `Ferromagnet` bodies + global demag | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses multilayer-convolution for eligible z-stacks, with CPU reference, a native CUDA single-grid fast path for compatible stacks, and `cuda-assisted` fallback for the remaining current public scope; the CUDA multilayer paths honor `execution_precision` (`double` and calibrated `single`) across the native fast path and the assisted multilayer demag/Heun runtime; FEM merges disjoint mesh assets into one bootstrap plan with body-local exchange and global demag |
| `Exchange` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU 6-point stencil in FDM and lumped-mass P1 operator in FEM |
| `Demag` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses Newell tensor FFT; executable FEM is Poisson-only (`poisson_robin` / `poisson_dirichlet`) on the MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU lanes and requires a shared-domain mesh with air. Native FEM Poisson exposes an explicit backend-hint `FemLinearSolverPolicy` authoring contract (`CG/GMRES`, `AMG/JACOBI/NONE`, tolerances, iteration cap) while keeping `Demag()` physics-first. For explicit native `poisson_robin`, the managed runtime resolves directly to `hypre_pcg_boomeramg`; live session views preserve requested CPU threads, resolved Rayon threads, and requested/effective OpenMP threads when the native runtime reports them. |
| `InterfacialDMI` | planned | planned | planned | semantic-only | Not numerically implemented |
| `Zeeman` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Public API authors `B`; planner normalizes to `H_ext` in A/m for CPU FDM and CPU FEM |
| `Magnetoelastic` | planned | planned | planned | **internal-reference** | Small-strain magnetoelastic coupling (B1/B2 cubic, λ_s isotropic); prescribed-strain H_mel wired into H_eff; see `docs/physics/0700-shared-magnetoelastic-semantics.md` |
| `LLG` (Heun) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Heun stepper in `fullmag-engine` |
| `Relaxation(llg_overdamped)` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Shared `StudyIR::Relaxation` with explicit `RelaxStop` / `FieldRefreshPolicy` semantics and structured stop reasons; executable FDM/FEM paths reuse the LLG field pipeline while keeping demag refresh cadence separate from integrator `dt` |
| `Relaxation(projected_gradient_bb)` | ✅ exec | ✅ exec (bootstrap) | planned | **public-executable** (FDM CPU/reference; CUDA-assisted FDM bootstrap; FEM native bootstrap) | Direct energy minimization on the sphere product manifold with alternating BB1/BB2 step sizes and Armijo backtracking; CUDA FDM and FEM bootstrap paths use native backend field/energy snapshots with runner-side line search until fully native minimizer kernels / FE mass-metric minimizers land; see `docs/physics/0500-fdm-relaxation-algorithms.md` and `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` |
| `Relaxation(nonlinear_cg)` | ✅ exec | ✅ exec (bootstrap) | planned | **public-executable** (FDM CPU/reference; CUDA-assisted FDM bootstrap; FEM native bootstrap) | Polak–Ribière+ CG with tangent-space vector transport, periodic restarts, and Armijo backtracking; CUDA FDM and FEM bootstrap paths use native backend field/energy snapshots with runner-side line search until fully native minimizer kernels / FE mass-metric minimizers land; see `docs/physics/0500-fdm-relaxation-algorithms.md` and `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md` |
| `Relaxation(tangent_plane_implicit)` | planned | planned | planned | semantic-only | Canonical production-target FEM relaxation family; execution deferred |
| Execution precision `double` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU reference FDM remains the trusted baseline; FEM executes through the MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU runtimes |
| Execution precision `single` | ✅ exec | planned | planned | **public-executable** (CUDA FDM) | Public CUDA FDM supports calibrated `single` precision across native single-body runs and multilayer CUDA paths; CPU reference FDM remains `double`-only |
| Field/scalar outputs (`m`, `H_ex`, `H_ext`, `H_eff`, `E_ex`, `E_ext`, `E_total`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Common artifact layout for current FDM/FEM executable slices |
| FEM demag outputs (`H_demag`, `E_demag`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | The MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM lanes emit demag outputs through the same quantity/artifact contract as FDM |
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
