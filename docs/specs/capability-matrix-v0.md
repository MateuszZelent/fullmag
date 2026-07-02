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
| **`unsupported`** | Not executable on the current lane. |
| **`source_visible`** | Source code or scaffolding exists, but the lane is not publishable as an executable production path. |
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

Native FEM GPU runtime provenance uses `fem_gpu_qualification_status` with the
ladder `unsupported`, `source_visible`, `production_executable`, `validated`.
The current strict GPU path may publish `production_executable` only when the
resolved device-resident operator modes and hot-loop synchronization audit are
clean; it must not publish `validated` until the documented validation workload
has passed.

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
generalized/current-solution Oersted on FEM
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
| `OerstedCylinder` on FDM and MFEM FEM | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM for constant / sinusoidal / pulse envelopes | `piecewise_linear` is still rejected on the public planner path. The FDM status covers current single-grid lanes; public multilayer FDM rejects Oersted terms until staged CPU/GPU multilayer RHS coverage exists. |
| `OerstedField(model="from_current_solution")` for cylindrical `prescribed_density` sources | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Executable only for `CurrentTransport(model="prescribed_density")` with cylindrical `solve_region` and axis-aligned current; planner lowers to the exact infinite-cylinder Oersted realization. The FDM status covers current single-grid lanes; public multilayer FDM rejects Oersted terms until staged CPU/GPU multilayer RHS coverage exists. |
| `OerstedField(model="from_current_solution")` for general `prescribed_density` sources | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Non-cylindrical prescribed-current sources lower to a midpoint Biot-Savart `H_oe(x)` realization with explicit provenance. The current FDM slice is still single-body and capped by planner source-cell count, but both CPU reference and native CUDA now execute the resulting per-cell field. Public multilayer FDM rejects Oersted terms until staged CPU/GPU multilayer RHS coverage exists. |
| `CurrentTransport(model="prescribed_density")` | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | Emits `current_transport/<name>.json` as an auxiliary artifact. On single-grid FDM and MFEM FEM it can bind named current sources into OerstedField and prescribed Slonczewski / Zhang-Li torque modules. Public multilayer FDM rejects Oersted and spin-torque/current bindings until staged CPU/GPU multilayer RHS coverage exists. |
| `SlonczewskiSTT` / `ZhangLiSTT` | `reference_executable` on CPU FDM, `production_executable` on GPU FDM plus MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM | The FDM status covers the current single-grid lanes. Public multilayer FDM rejects legacy STT fields and `spin_torque_modules` explicitly until staged CPU/GPU multilayer RHS coverage exists. MFEM FEM executes the current public single-module subset; the Rust FEM reference runner still does not. Slonczewski execution uses the direct-RHS equivalent of the effective-field form, including `gamma_mu0`; Zhang-Li execution uses the explicit Gilbert alpha/beta projection. The 2026-05-16 native FEM audit treats these FEM paths as executable but not validated until the macrospin/current-scaling and 1D domain-wall gates in the native FEM validation matrix pass. |
| `examples/stno_vortex_ref_minimal.py` | `reference_executable` on the reference FDM lane | This is the canonical minimal STNO benchmark; full solver CI validation remains separate work. |
| `examples/stno_vortex_mtj_workflow.py` | non-canonical workflow example | Do not treat this generated workflow as the golden benchmark. |
| Artifact-backed STNO report | `validated` on the reference FDM lane | Uses real solver artifacts, not synthetic demonstration data, and has regression coverage for the analysis path. |
| FEM periodic / Floquet spin-wave support | `partial_production_executable` for k=0 static-periodic driven response on native FEM CPU and native FEM GPU no-demag magnetic slices; narrow development smoke for GPU nonzero-k Floquet no-demag phase projection; `semantic_only`/`unsupported` for broader Floquet lanes | Static-periodic response requires `mesh.periodic_node_pairs` plus boundary-pair metadata with translation/tolerance diagnostics, and stays separate from full nonzero-k Floquet/Bloch support. The current CPU/GPU static-periodic response can run on a magnetic-body mesh or on the compacted magnetic slice extracted from a shared-domain airbox mesh when dynamic demag is disabled. The current GPU Floquet smoke phase-projects the complex response block for local terms plus a supplied exchange-edge tangent operator only; the high-level planner/runner can reach it only for explicit GPU, magnetic-body or compacted magnetic-slice, no-demag/no-DMI requests with complete pair metadata and Bloch-phased tangent drive. It is not periodic demag, full periodic exchange-graph assembly, periodic Poisson, or production k-path response. Floquet dynamic demag remains gated. |
| FEM eigen equilibrium import for STNO parity | `semantic_only` | Do not describe as end-to-end public STNO support yet. |
| FEM eigen frequency-window target | `semantic_only` for public authoring; production solver pending | Intended public contract: `frequency_min_hz`, `frequency_max_hz`, and `count` as max returned modes in the interval. Production execution requires PETSc/SLEPc or FEAST-class sparse/matrix-free eigensolve with residuals, converged-mode count, spectral-transform provenance, and live solver progress. Current dense/sparse reference runner must not be marketed as COMSOL-class large-object execution. |
| FEM modal interior-window eigensolve | `semantic_only` | This row is the modal `modal_eigen` product only. `Eigenmodes` uses `A q = lambda B q`, tangent variables, and explicit interval targets such as `frequency_min_hz` / `frequency_max_hz`. Its status does not promote driven response. |
| FEM modal k-path dispersion | `reference_executable` for the CPU reference/MVP modal artifact lane; `partial_production_executable` for the managed native CPU selected-spectrum no-demag `Full2x2` Floquet k-path slice and for the gamma-equivalent production CPU provenance bridge; production GPU remains `unsupported` | COMSOL-style nonzero-k dispersion maps to `Eigenmodes` over a Floquet/Bloch k path, not to driven `FrequencyResponse`. `/v2/sessions/current/analysis/frequency-domain/manifest.v1` exposes `capabilities.dispersion.reference_cpu`, `capabilities.dispersion.production_cpu`, `capabilities.dispersion.production_cpu_gamma_k_path`, and `capabilities.dispersion.production_gpu`: the reference CPU lane can emit spectrum, branches, `dispersion.csv`, and mode-field artifacts; `production_cpu_gamma_k_path` proves only that legal gamma-equivalent samples can preserve selected-spectrum production CPU provenance through the multi-k orchestrator; and `production_cpu` is the managed native CPU selected-spectrum nonzero-k Floquet slice with labelled Bloch/Floquet tangent payloads, `lambda_eq_i_omega`, `exp_i_omega_t`, persisted mode-field payloads, and analytic/reciprocal exchange-only gates. Dynamic demag-k, broader sparse/matrix-free Floquet validation, and modal GPU remain gated until the matching native operators/eigensolvers exist. The driven-response GPU Floquet smoke must not be reused as modal dispersion proof. |
| FEM driven frequency response | `partial_production_executable` for the native FEM CPU gamma/free-boundary and k=0 static-periodic magnetic/compacted shared-domain no-demag slice; `partial_production_executable` for the native FEM GPU gamma/free-boundary and k=0 static-periodic no-demag magnetic/compacted shared-domain slice plus a narrow nonzero-k Floquet no-demag phase-projection smoke; `reference_executable` for dense FEM validation response | This row is the driven `driven_response` product only. `Frequency Response` solves `(i omega B - A) q = b` at requested frequencies. Its status does not promote modal eigensolve. The CPU/GPU slices include exchange, Zeeman, uniform uniaxial anisotropy, uniform or nodal damping, and k=0 static-periodic tangent projection through the native operator when periodic pair metadata is complete; when the authored problem carries a shared-domain airbox mesh but dynamic demag is disabled, the runner builds the native request on the compacted magnetic-node slice. The nonzero-k Floquet development smoke phase-projects local terms and a supplied exchange-edge tangent operator with `floquet_phase_projection=true`; high-level planning is limited to explicit GPU, magnetic-body or compacted magnetic-slice, no-demag/no-DMI requests with complete pair metadata and Bloch-phased tangent drive. Full periodic exchange-graph assembly, DMI on GPU, demag, periodic Poisson, magnetoelastic response, and validated production k-path response remain explicitly gated. |
| `StudyIR::FrequencyResponse` | `partial_production_executable` for the native FEM CPU gamma/free-boundary and k=0 static-periodic magnetic/compacted shared-domain no-demag slice; `partial_production_executable` for the native FEM GPU gamma/free-boundary and k=0 static-periodic no-demag magnetic/compacted shared-domain slice plus a narrow nonzero-k Floquet no-demag phase-projection smoke; `reference_executable` for dense FEM validation response | Public Python/API/IR semantics exist. The current runner can emit artifact-backed dense block-real magnetic frequency-sweep validation results as `fem_frequency_response_dense_validation`, exposes the limited native MFEM production CPU response engine as `fem_frequency_response_production_cpu`, and routes requested GPU frequency response to `fem_frequency_response_production_gpu` for the no-demag gamma/free-boundary and k=0 static-periodic magnetic slices. Static-periodic response requires `mesh.periodic_node_pairs`; explicit CPU/GPU no-demag response may use a shared-domain airbox mesh only by compacting the native request to magnetic nodes and leaving dynamic demag off. The current nonzero-k Floquet smoke requires supplied Floquet pair metadata and remains limited to phase projection of local terms plus a supplied exchange-edge tangent operator, with the Rust native wrapper forwarding that accepted slice to C ABI instead of pre-native unavailable short-circuiting. The high-level planner/runner can now build the narrow explicit-GPU no-demag/no-DMI Floquet tangent-drive payload from complete pair metadata. Demag, full nonzero-k Floquet/Bloch production response, missing periodic pair metadata, DMI on GPU, magnetoelastic response, periodic demag, and broader production GPU response remain explicitly gated. |

Runtime capability payloads expose five separate deferred booleans for this scope: `supports_frequency_response`, `supports_coupled_magnetoelastic_quasistatic`, `supports_coupled_magnetoelastic_elastodynamic`, `supports_frequency_domain_elastodynamics`, and `supports_coupled_eigenmodes`; all remain `false` for current engines until the matching solver family is implemented and validated. The frequency-domain analysis manifest is the precise UI gate for modal dispersion lane status and must keep `dispersion.reference_cpu`, `dispersion.production_cpu`, `dispersion.production_cpu_gamma_k_path`, and `dispersion.production_gpu` aligned with the rows above.

## Current execution policy

- `strict` means backend-neutral semantics only.
- `extended` is reserved for future backend-specific features.
- `hybrid` is explicit and requires both hybrid mode and hybrid backend.

## Authoring-layer note

- `SceneDocument` `scene.v1` is now the canonical control-room authoring document for geometry,
  material assignment, magnetization initialization, study defaults, and editor metadata.
- `study.exchange_enabled` and `study.demag_enabled` are authoring switches for active
  `ProblemIR.energy_terms`. Disabling either term removes that contribution from `H_eff`; it does
  not create a new solver capability or a per-object demag participation mask.
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
- FEM relaxation algorithms `llg_overdamped`, `projected_gradient_bb`,
  `nonlinear_cg`, and CPU/MFEM `tangent_plane_implicit` are the current
  production-executable relaxation set.
  `projected_gradient_bb` and `nonlinear_cg` execute on both `fem_cpu_native`
  and `fem_native_gpu`. `tangent_plane_implicit` executes on `fem_cpu_native`;
  the GPU/libCEED device-resident tangent-plane solve remains under
  development. In automatic runtime selection, a resolved `fem_native_gpu` plan
  for TPI falls back to `fem_cpu_native` with reason
  `fem_gpu_relaxation_algorithm_cpu_only`, while forced GPU selection fails
  clearly.
- FEM relaxation runtime proof must be container-backed. Host-side `cargo`,
  `cmake`, or direct native binaries are smoke checks only; final FEM runtime
  evidence comes from the managed `just` recipes such as
  `just ensure-managed-fem-runtime` and `just fem-gpu-headless ...`.
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
| Material constants (`Ku1`, `anisU`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Local uniaxial anisotropy is executable on the current FDM and FEM lanes. CPU FDM, single-grid native CUDA FDM, and public multilayer FDM expose the derived `H_ani` observation boundary; native FEM CPU qualification now includes `exchange_anis_uniaxial` and `exchange_demag_anis_uniaxial` readiness gates for the no-PBC adaptive slice. Shared-domain FEM may realize different per-object uniaxial axes as nodal axis fields when materialization proves ownership; cubic-axis heterogeneity and surface anisotropy remain separately gated. This does not promote the broader FEM relaxation solver to `validated`. |
| Material constants (`Kc1`, `anisC1`, `anisC2`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Local cubic anisotropy is executable on the current FDM and FEM lanes. CPU FDM, single-grid native CUDA FDM, and public multilayer FDM expose the derived `H_ani` observation boundary; native FEM CPU qualification now includes `exchange_anis_cubic` and `exchange_demag_anis_cubic` readiness gates for the no-PBC adaptive slice; this does not cover nonlocal or surface anisotropy. |
| Per-cell material fields (`ms_field`, `a_field`, `alpha_field`, `ku*_field`, `kc*_field`) | planned | ✅ exec | planned | **explicitly-deferred** (FDM) | Current FDM execution plans carry uniform material constants only; single-grid and public multilayer FDM reject used materials with per-cell material fields instead of silently dropping them. FEM carries material field payloads through its native material-field lanes where supported. |
| Object-owned authored regions (`object_regions`, region material overrides, region mesh policy, region couplings) | partial CUDA FDM exec | partial FEM executable | planned | **source-visible / partial-executable** | Authored regions are visible in Python, ProblemIR, OpenAPI, and the Control Room. Current single-grid CUDA FDM can materialize owner-scoped region masks for region texture overrides and explicit/disabled region-region exchange pairs; CPU reference FDM rejects executable pair overrides instead of silently ignoring them. FDM/FEM planning samples smooth `Ms/Aex` region material transitions into coefficient payloads using signed-distance weights; omitted `material_transition` defaults to `mesh_relative(cells=3, scope=boundary)` for `Ms/Aex`, while explicit `kind=sharp` remains the conformal/projection-gated discontinuous path. FEM also samples `Alpha` region overrides/fields into nodal coefficient payloads, records realization method plus min/max/mean statistics, and emits projection warnings for explicit sharp projection into runtime solver status. Python/Gmsh automatically creates conformal authored-region markers for fully contained box and cylinder regions on the OCC shared-domain path, including arbitrary cylinder axes; unsupported shapes, regions outside the owner, and overlapping conformal regions reject instead of degrading silently. Metadata-only markers do not qualify, and marker IDs cannot collide with object/domain `region_markers`. Strict sharp-jump runtime execution is not yet production-qualified: the native FEM lane still needs element/domain coefficient mapping for discontinuous `A/Ms` while preserving one shared `m` field across the internal interface. The planner must not promote that path by duplicating region interface DOFs. Explicit projection in extended mode remains the executable nodal-field path. Python `study.domain_mesh(..., object_region_markers=...)` preserves explicit precomputed markers through ProblemIR and script export. Region couplings, broader conformal CSG, strict conformal coefficient runtime mapping, and public multilayer FDM region-owned material/coupling remain deferred; public multilayer FDM rejects authored `object_regions` rather than silently ignoring them. Unsupported `rkky` and `interlayer_exchange` runtime coupling diagnostics use the public snake_case kind tokens, not Rust enum debug names. Native single-grid multilayer CUDA emits explicit disabled exchange pairs between object ids so separate objects keep free-surface semantics even though intra-object region defaults use harmonic mean. |
| Ferromagnet + uniform `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Lowered to per-cell vectors for FDM and per-node vectors for FEM |
| Ferromagnet + random `m0` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Deterministic xorshift64 RNG in planner |
| Multiple `Ferromagnet` bodies + global demag | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | FDM uses multilayer-convolution for eligible z-stacks, with CPU reference, a native CUDA single-grid fast path for compatible stacks, and `cuda-assisted` fallback for the remaining current public scope; compatible native single-grid stacks can route fixed-step RK23/RK45/ABM3 through the existing single-grid CUDA integrators, while staged native v2 multilayer routes fixed-step Heun/RK4/RK23 and continues to reject adaptive RK23/RK45 and ABM3; the CUDA multilayer paths honor `execution_precision` (`double` and calibrated `single`) across the native fast path and the assisted multilayer demag/explicit-RK runtime; FEM merges disjoint mesh assets into one execution plan with body-local exchange and global demag |
| `Exchange` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU 6-point stencil in FDM and lumped-mass P1 operator in FEM |
| `Demag` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM, validation pending for full FEM GPU demag) | FDM uses Newell tensor FFT. Executable FEM includes Poisson airbox (`poisson_robin` / `poisson_dirichlet`) on the MFEM/libCEED/hypre CPU lane and strict MFEM/libCEED/CUDA GPU lane. Strict FEM GPU demag mode is `device_hypre_poisson`: RHS, hypre solve, warm-start, recovery `H_demag`, and demag energy stay device-resident, with `uses_gpu_poisson=true`, `hypre_execution_policy=device`, and no hot-loop demag field/magnetization round-trip. `hybrid_cpu_poisson` is only an explicit compatibility/debug mode and must not be silently selected for `study.device("gpu")`. Initial strict GPU scope is P1, double precision, shared-domain airbox Dirichlet/Robin. High-order and Fredkin-Koehler GPU demag remain gated. The static/time-domain k=0 periodic demag slice has ordinary managed CPU/GPU periodic-antidot relaxation evidence for seam continuity and device-Poisson provenance, but remains below validated production until strict M5 z-padding and primitive-vs-supercell reports pass for the same workload; it may execute only when `ProblemIR.pbc.demag="periodic_airbox_k0"`, the mesh carries `periodic_node_pairs`, `periodic_boundary_pairs`, periodic axes that match `ProblemIR.pbc.axes`, a shared-domain airbox, at least one open axis, and accepted `periodic_pairs.v1` diagnostics proving shared-airbox coverage, magnetic coverage where the magnetic body crosses the selected seam, and opposed-normal boundary-face pairs; selected periodic axes may include `z` for non-fully-periodic cells, while the current antidot qualification fixture remains the film-specific `x/y` periodic, open-`z` case. A historical managed 3x3 primitive-vs-periodic-supercell artifact `.fullmag/reports/fem-demag-periodic-airbox-validation-supercell-pbc/periodic_airbox_validation.csv` passed with `2.4167958871934916e-3` relative energy error against the `2.0e-2` tolerance and zero primitive `H_demag`/`phi` seam mismatch for its fixture; this is supporting evidence for the reduced Poisson path, not current M5 antidot acceptance. Strict GPU k=0 static periodic demag has source-contract support and ordinary managed periodic-antidot GPU gate evidence proving `uses_cuda_kernels=true`, `uses_gpu_poisson=true`, `demag_operator_mode="device_hypre_poisson"`, and zero accepted `H_demag`/normal-flux seam mismatch for `exchange_coupled` and `air_gap`; it must still not be reported as validated production until strict M5 z-padding and primitive-vs-supercell evidence pass. Fully periodic 3D, dynamic frequency-response demag, nonzero-k Floquet magnetostatics, and broader GPU periodic demag remain gated. The public nonzero-k Floquet demag request is `magnetostatic_bc=floquet_airbox`; it is accepted as IR/DSL intent but must fail capability planning until a validated Bloch/Floquet demag-k operator exists. Executable FEM also includes the initial body-only `fredkin_koehler` FEM/BEM open-boundary path in the native MFEM CPU subsystem. Poisson requires a shared-domain mesh with air; `fredkin_koehler` must not require or allocate an airbox and uses the magnetic body boundary surface instead. The Fredkin-Koehler implementation is dense-reference/validation-scale until analytic and cross-model qualification are complete. Native FEM demag exposes an explicit backend-hint `FemLinearSolverPolicy` authoring contract (`CG/GMRES`, `AMG/JACOBI/NONE`, tolerances, iteration cap) while keeping `Demag()` physics-first. For explicit native `poisson_robin`, the managed runtime resolves directly to `hypre_pcg_boomeramg`; live session views preserve requested CPU threads, resolved Rayon threads, and requested/effective OpenMP threads when the native runtime reports them. |
| `InterfacialDMI` / `BulkDMI` | ✅ exec | planned | planned | **public-executable** (FDM); **under-qualification** (FEM frequency response CPU slice) | CPU FDM computes DMI field/energy in the reference lane and exposes `H_dmi` as a derived snapshot/preview observable. Public multilayer FDM carries global DMI constants through CPU reference observables/RHS, CUDA-assisted local effective fields, native stacked single-grid plans, native stacked scalar/field reporting, and staged multilayer v2 explicit-RK RHS for fixed-step Heun/RK4/RK23; staged multilayer handles expose per-layer `H_DMI` copy endpoints for those global constants. The FEM driven frequency-response CPU lane has a P1 tetrahedral tangent DMI payload and native MFEM weak-residual operator for the gamma-point/free-boundary slice, but this remains under managed-runtime qualification and does not imply demag, Floquet, spatial DMI fields, or GPU frequency-response support. Requested FEM GPU frequency response with DMI rejects explicitly until a native CUDA weak-residual DMI operator is qualified. Per-layer/per-cell DMI fields remain deferred. |
| `Zeeman` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Public API authors `B`; planner normalizes to `H_ext` in A/m for CPU FDM and CPU FEM |
| `ThermalNoise` | ✅ exec | planned | planned | **public-executable** (single-grid FDM) | CPU/GPU single-grid FDM execute Brown thermal noise where configured. Public multilayer FDM rejects thermal noise explicitly until staged CPU/GPU multilayer RHS coverage exists, rather than dropping it from `FdmMultilayerPlanIR`. |
| `Magnetoelastic` | planned | planned | planned | **internal-reference** | Small-strain magnetoelastic coupling (B1/B2 cubic, λ_s isotropic); prescribed-strain H_mel wired into H_eff; see `docs/physics/0700-shared-magnetoelastic-semantics.md` |
| `LLG` (Heun) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Heun stepper in `fullmag-engine` |
| `Relaxation(llg_overdamped)` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Shared `StudyIR::Relaxation` with explicit `RelaxStop` / `FieldRefreshPolicy` semantics and structured stop reasons; executable FDM/FEM paths reuse the LLG field pipeline while keeping demag refresh cadence separate from integrator `dt` |
| `Relaxation(projected_gradient_bb)` | ✅ exec | ✅ exec on `fem_cpu_native` and `fem_native_gpu` | **planned** | **public-executable** (FDM CPU/reference; native FEM CPU/MFEM/CUDA) | Direct energy minimization on the sphere product manifold with alternating BB1/BB2 step sizes, FEM lumped-mass inner products, norm-preserving retraction, and native Armijo backtracking through `fullmag_fem_backend_relax_step`. The CPU/MFEM lane additionally uses exchange-plus-mass preconditioned tangent gradients with serial MFEM CG as the production default; HyprePCG/BoomerAMG remains an explicit opt-in qualification path via `FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER=hypre`. The native CUDA lane owns device tangent-gradient, mass-metric, retraction, Armijo accepted-step, BB-update, rollback, and transfer-audit checks under `backends/fem/gpu/cuda/relaxation`; controlled compute scalar readbacks for Armijo/BB decisions are reported separately, while exchange hot-loop host sync remains rejected. Automatic FEM GPU selection keeps PG-BB on `fem_native_gpu` once that runtime is resolved. |
| `Relaxation(nonlinear_cg)` | ✅ exec | ✅ exec on `fem_cpu_native` and `fem_native_gpu` | **planned** | **public-executable** (FDM CPU/reference; native FEM CPU/MFEM/CUDA) | Polak-Ribiere+ CG with tangent-space vector transport, periodic restarts, FEM lumped-mass inner products, native Armijo backtracking, and descent-direction reset through `fullmag_fem_backend_relax_step`. The CPU/MFEM lane additionally uses exchange-plus-mass preconditioned tangent gradients with serial MFEM CG as the production default; HyprePCG/BoomerAMG remains an explicit opt-in qualification path via `FULLMAG_FEM_DIRECT_MINIMIZER_PRECONDITIONER_SOLVER=hypre`. The native CUDA lane owns device-resident tangent-gradient, mass-metric dot products, normalized retraction, Armijo accepted-step loop, persistent search-direction state, PR+ direction update, rollback, and transfer-audit checks under `backends/fem/gpu/cuda/relaxation`. Automatic FEM GPU selection keeps NCG on `fem_native_gpu` once that runtime is resolved. |
| `Relaxation(tangent_plane_implicit)` | semantic-only | CPU/MFEM development lane; GPU under development / forced unsupported | **planned** | **under-development** (native FEM CPU/MFEM and FEM GPU/libCEED) | FEM-only tangent-plane implicit relaxation has a native CPU/MFEM implementation path, but it is not part of the production-qualified relaxation set. The current operator includes `mass + step * exchange`, local anisotropy curvature, Zeeman tangent curvature, DMI weak-residual action, and demag fresh-solve linear response. Automatic FEM GPU selection falls back to `fem_cpu_native` with `fem_gpu_relaxation_algorithm_cpu_only`; forced FEM GPU fails while the full GPU/libCEED device-resident tangent-plane solve remains under development. |
| `FrequencyResponse` | semantic-only | reference-executable dense validation path; gated production CPU slice; gated production GPU no-demag slice plus narrow nonzero-k Floquet phase-projection smoke | planned | partial production CPU/GPU executable, broader response still gated | First-class `StudyIR::FrequencyResponse` and Python `fm.FrequencyResponse` serialize the driven frequency-domain contract. This is COMSOL-like `Frequency Domain` forced harmonic response, not COMSOL-like `Eigenfrequency`; response peaks are mode candidates, not modal proof. The current runner can execute the dense block-real magnetic frequency-sweep validation path and emit artifact-backed response sweeps, progress, diagnostics, and field payload resources. New production promotion is blocked by the audit P0 contract until the phasor convention, matrix form, dynamic-demag Poisson sign, `Ms`-correct susceptibility/absorbed-power units, damping convention, and tangent-frame transport are implemented and tested. The native MFEM frequency-domain production CPU lane is executable only for the gamma-point/free-boundary and k=0 static-periodic magnetic/compacted shared-domain no-demag response slice with exchange, Zeeman, uniform uniaxial anisotropy, interfacial/bulk DMI on P1 tetrahedra for the non-shared CPU slice, uniform or nodal Gilbert damping, matrix-free GMRES, progress telemetry, and partial-artifact cancellation. A narrow CPU `k=0 periodic_airbox_k0` driven-response diagnostic slice exists for the antidot/PBC work, but it is a matrix-free Schur/phi-consistency provider path, not a full assembled coupled `[delta_m, delta_phi]` solver, not an eigenmode/modal solver, and not GPU dynamic demag. After `just rebuild-fem-runtime` on 2026-06-30, a one-iteration managed smoke intentionally returned `solve_error` and the generated bounded bundle passed `scripts/verify_fem_frequency_domain_runtime_artifacts.py --allow-solve-error --require-periodic-airbox-cpu-demag-solved --require-frozen-magnetic-submesh`; solver acceptance still requires a converged single-point run, longer equilibrium proof, fresh spectrum/refined artifacts, and supercell acceptance. The native FEM production GPU lane is executable only for the gamma-point/free-boundary and k=0 static-periodic no-demag magnetic/compacted shared-domain response slices with exchange, Zeeman, uniform uniaxial anisotropy, uniform or nodal Gilbert damping, native CUDA operator application, matrix-free GMRES, static-periodic tangent projection, and `validation_fallback_used=false`; shared-domain airbox meshes are accepted in CPU/GPU no-demag lanes only after compacting to the magnetic-node slice. It additionally has a nonzero-k Floquet no-demag smoke that phase-projects local terms plus a supplied exchange-edge tangent operator and is reachable through the Rust native wrapper and the high-level planner/runner when explicit GPU, no-demag/no-DMI, magnetic-body or compacted magnetic-slice and complete pair metadata prerequisites are met. Static-periodic response requires `mesh.periodic_node_pairs` and boundary-pair translation/tolerance diagnostics. The DMI part of the CPU slice is wired through the public runner payload and native weak-residual contract but still requires managed FEM runtime proof before it is promoted to validated production. Full nonzero-k Floquet/Bloch production response, GPU periodic/dynamic demag, frequency-domain elastodynamics, true `periodic_airbox_k0` eigenfrequency/modal solving, coupled eigenmodes, and two-way magnetoelastic response remain explicitly capability-gated. `/v2/sessions/current/analysis/frequency-domain/manifest.v1` exposes nested `frequency_domain_capabilities.v1` for precise UI gating. |
| Execution precision `double` | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | CPU reference FDM remains the trusted baseline; FEM executes through the MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU runtimes |
| Execution precision `single` | ✅ exec | planned | planned | **public-executable** (CUDA FDM) | Public CUDA FDM supports calibrated `single` precision across native single-body runs and multilayer CUDA paths; CPU reference FDM remains `double`-only |
| Field/scalar outputs (`m`, `H_ex`, `H_ext`, `H_ani`, `H_dmi`, `H_eff`, `E_ex`, `E_ext`, `E_ani`, `E_dmi`, `E_total`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | Common artifact layout for current FDM/FEM executable slices; FDM `H_ani` is exposed by CPU reference, single-grid native CUDA copy/preview/snapshot endpoints, and public multilayer observable paths. FDM `H_dmi` remains CPU/reference plus current public multilayer observable coverage, with broader per-layer/per-cell native DMI still tracked separately. |
| FEM demag outputs (`H_demag`, `demag_phi`, `E_demag`) | ✅ exec | ✅ exec | planned | **public-executable** (FDM/FEM) | The MFEM/libCEED/hypre CPU and MFEM/libCEED/CUDA GPU FEM lanes emit demag outputs through the same quantity/artifact contract as FDM. Static PBC equilibrium acceptance requires same-step `H_demag` and scalar-potential `demag_phi` field artifacts plus seam checks across explicit periodic node pairs; `demag_phi` is checked after removing the best constant gauge offset per periodic pair id. |
| FDM hints | ✅ exec | n/a | planned | **public-executable** | Cell size → grid dims in planner |
| FEM hints | n/a | ✅ exec | planned | **public-executable** (FEM) | Planner builds `FemPlanIR`; execution currently requires `MeshIR` or external meshing extras |
| Hybrid hints | n/a | n/a | planned | semantic-only | Requires hybrid mode and backend |

## Early planner rules

- `backend="auto"` resolves to `fdm` for `strict` and `extended` during execution planning.
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
