# Native FEM Backend Architecture v1

- Status: canonical target architecture
- Last updated: 2026-05-23
- Related ADRs:
  - `docs/adr/0014-native-fem-backend-modularization.md`
- Related physics:
  - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
  - `docs/physics/0817-native-fem-cpu-demag-hot-path-profile.md`
  - `docs/physics/0870-fem-bem-demag-open-boundary.md`
- Related patch specs:
  - `docs/specs/native-fem-magnetoelastic-patch-v1.md`
- Related reports:
  - `docs/reports/16.05.2026/fullmag_fem_cpu_audit.md`
  - `docs/reports/16.05.2026/fullmag_fem_cpu_refactor_architecture.md`
  - `docs/reports/16.05.2026/fullmag_fem_cpu_validation_matrix.md`

## 1. Purpose

This document is the long-lived target contract for the native FEM backend. It
turns the 2026-05-16 FEM CPU audit into canonical project documentation.

The goal is not to rename folders. The goal is to make the solver auditable,
testable, and optimizable by separating:

1. backend-neutral physics contracts,
2. FEM discretization and state,
3. CPU/MFEM/hypre implementation,
4. GPU/CUDA/libCEED implementation,
5. runtime, telemetry, artifacts, and provenance.

MFEM remains a valid implementation dependency for FEM CPU. It must not be the
architecture boundary for all physics and runtime behavior.

## 2. Non-negotiable Principles

### One Physics Contract

Fullmag must not maintain separate formulas for:

```text
FEM CPU exchange
FEM GPU exchange
FDM CPU exchange
FDM GPU exchange
```

The canonical physics contract defines energy, field or torque, SI units,
boundary conditions, observables, and validation. Backends implement numerical
realizations of that contract.

### Operator Modules Before Folder Moves

A refactor is not complete because files moved under new directories. It is
complete only when the operator or subsystem has a documented API, ownership
model, validation gate, telemetry, and capability behavior.

### CPU and GPU are Realizations

CPU and GPU lanes may use different storage and kernels. They must preserve the
same signs, units, requested intent, resolved engine provenance, and artifact
names.

### Demag is a Subsystem

Poisson demag is the current FEM bottleneck and the highest-risk nonlocal
operator. It must be modeled as a subsystem, not as a block inside a bridge
file.

### Opt-in Profiler is a Runtime Contract

The session-level solver profiler is part of the native FEM runtime contract,
not a temporary debug print. Any solver rebuild, folder split, CPU/GPU
separation, demag extraction, or integrator rewrite must preserve:

- `POST /v2/sessions/current/simulation/commands` with
  `kind: "set_solver_profile"`;
- `GET /v2/sessions/current/diagnostics/solver-profile`;
- bounded in-memory `SolverProfileState` snapshots;
- stable phase identifiers: `step_total`, `rhs_total`, `exchange`,
  `demag_total`, `demag_assemble`, `demag_solver_setup`,
  `demag_solver_apply`, `demag_recover`, `demag_energy`, `local_terms`,
  `normalization_projection`, `adaptive_error`, `snapshot`, and `host_sync`;
- disabled-by-default behavior with no profiler sample allocation, JSONL
  writes, or engine-log emission when the profiler is disabled.

Status resources remain thin revision pointers. Realtime remains
invalidation-only. Full profile samples live under the diagnostics resource and
optional run artifacts.

## 3. Layer Model

```text
Python DSL / UI authoring
  -> ProblemIR
  -> validation + capability planning
  -> backend-neutral FEM plan
  -> native FEM C ABI facade
  -> FemBackend
       -> FemCore state and interaction registry
       -> FemCpuBackend<MfemRuntime>
       -> FemGpuBackend<CudaRuntime>
  -> artifacts + telemetry + provenance
```

### Rust Control Plane

Rust owns:

- `ProblemIR` validation and normalization,
- capability decisions,
- requested vs resolved execution metadata,
- artifact/provenance contracts,
- the C ABI boundary.

Rust should not encode hidden backend-specific physics formulas when those
formulas belong in the canonical physics contract.

### Native C ABI

The C ABI remains the stable interop boundary. Internally it should route to
typed logical descriptors rather than one ever-growing plan:

```text
fullmag_fem_problem_desc
fullmag_fem_mesh_desc
fullmag_fem_material_desc
fullmag_fem_interaction_desc[]
fullmag_fem_solver_desc
fullmag_fem_runtime_desc
fullmag_fem_observable_desc[]
```

The existing wide plan may remain as a compatibility format during migration.

### FEM Core

FEM core owns backend-independent FEM state:

```text
FemProblem
FemMesh
FemMaterialFields
FemState
FemFieldBuffers
FemInteractionRegistry
FemTelemetry
FemWorkspace
FemObservableRegistry
```

FEM core does not own MFEM global device configuration, CUDA streams, hypre
object lifetimes, or libCEED kernels.

## 4. State Ownership

`Context` must move toward a narrow facade:

```cpp
struct Context {
  std::unique_ptr<FemBackend> backend;
  FemTelemetry telemetry;
};
```

The target state split is:

| Owner | Responsibility |
|---|---|
| `ProblemConfig` | immutable runtime plan, units, interaction set, solver policy |
| `MeshAndRegions` | mesh topology, magnetic region masks, airbox markers, periodic maps |
| `MaterialFields` | `Ms`, `A_ex`, `alpha`, anisotropy, DMI, and local parameter fields |
| `FieldBuffers` | `m`, `H_ex`, `H_demag`, `H_eff`, local fields, RHS, snapshots |
| `DemagSubsystem` | Poisson space, RHS, matrix/preconditioner, Krylov solver, recovery, energy |
| `StepperSubsystem` | RK buffers, adaptive controller, FSAL cache, normalization |
| `DeviceRuntime` | MFEM/CUDA runtime selection, host/device residency, thread policy |
| `DiagnosticsState` | timings, transfer audit, solver iterations, residuals, warnings |

New cross-cutting fields should not be added directly to `Context`. If a
temporary compatibility field is unavoidable, it must have a documented target
owner and removal condition.

Current migration note: explicit RK storage and tableau metadata have started
moving toward the `StepperSubsystem` target. `ExplicitTableau` is owned by
`cpu/mfem/integrators/rk_tableau.hpp`, and `StepperWorkspace` is owned by
`cpu/mfem/integrators/rk_stepper_workspace.hpp`; `Context` may temporarily hold
an instance for ABI compatibility, but it should not define RK storage or
tableau types.

Mesh migration has started with the topology helpers that do not require a new
state layout. Static periodic node-class reduction, per-periodic-class scalar
material validation, and P1 nodal dual-volume accumulation are owned by
`native/backends/fem/core/fem_mesh.hpp/.cpp`; `Context` still stores the
compatibility fields but no longer defines those helpers locally.

Material-field migration has started with plan import and validation helpers.
Optional per-node material arrays (`Ms`, `A_ex`, `alpha`, anisotropy, DMI, and
cubic anisotropy fields) plus scalar material sanity checks are owned by
`native/backends/fem/core/fem_material_fields.hpp/.cpp`; `Context` still stores
the compatibility vectors until the full `FemMaterialFields` state owner lands.

Field-buffer migration has started with nodal AOS-3 buffer sizing and
zero-initialization. `H_ex`, `H_demag`, local-interaction field buffers,
magnetoelastic field storage, and the initial `H_eff` external-field seed are
owned by `native/backends/fem/core/fem_field_buffers.hpp/.cpp`; `Context` still
stores the compatibility vectors until the full `FemFieldBuffers` state owner
lands.

GPU ownership migration has started with behavior-preserving source moves under
`native/backends/fem/gpu/cuda/`. GPU exchange readiness planning is owned by
`gpu/cuda/exchange/exchange_plan.hpp/.cpp`; legacy sparse exchange field and
energy CUDA wrappers are owned by `gpu/cuda/exchange/exchange_kernels.hpp/.cu`;
legacy sparse exchange device-side CSR, dimensions, readiness, and byte
accounting are owned by `gpu/cuda/exchange/exchange_state.hpp` and embedded in
`FemGpuState` as the `legacy_exchange` substate. Shared GPU integration metrics
such as lumped mass and inverse lumped mass are owned by
`gpu/cuda/mesh/mesh_metrics_state.hpp` and embedded in `FemGpuState` as the
`mesh_metrics` substate. `FemGpuState` allocation/transfer/device metadata is
owned by `gpu/cuda/state/gpu_state.hpp/.cpp`, and transfer-audit scope tracking
is owned by `gpu/cuda/transfer/transfer_audit.hpp/.cpp`. AoS/SoA
host-device CUDA transfer wrappers are owned by
`gpu/cuda/transfer/transfer_kernels.hpp/.cu`. GPU-state
runtime bootstrap and CUDA stream/snapshot metadata are owned by
`gpu/cuda/runtime/gpu_state_runtime.hpp/.cpp`. The legacy empty
`src/gpu_exchange.cpp`, `src/gpu_rk.cpp`, `src/gpu_state.cpp`, and
`src/transfer_audit.cpp` placeholder sources have been removed from the build.
GPU shared vector field CUDA wrappers are owned by
`gpu/cuda/fields/vector_field_kernels.hpp/.cu`.
GPU fused LLG RHS CUDA wrappers are owned by
`gpu/cuda/integrators/llg/llg_rhs_kernels.hpp/.cu`.
GPU RK readiness planning is owned by
`gpu/cuda/integrators/rk/rk.hpp` and `gpu/cuda/integrators/rk/rk_plan.cpp`, and uses the device-resident planner name
`gpu_rk_plan_device_resident`; the older internal
`gpu_rk_plan_exchange_only` wrapper has been removed. GPU RK CUDA step orchestration
is owned by `gpu/cuda/integrators/rk/rk_step.cu`. GPU RK step-level preflight,
including device-resident planning gates, integrator support validation, dt
validation, source-of-truth enforcement, exchange-mode validation, CUDA
stream/block setup, adaptive flagging, and FSAL policy resolution, is owned by
`gpu/cuda/integrators/rk/rk_step_preflight.hpp/.cu`. Device-resident common RK
attempt setup, including magnetization backup, FSAL reuse, k0 refresh, common
predictor sequencing, normalization, k1 refresh, and setup RHS accounting, is
owned by `gpu/cuda/integrators/rk/rk_attempt_setup.hpp/.cu`. Device-resident
per-attempt RK stage scheduling, including attempt setup delegation,
accepted-state normalization, integrator sequence dispatch, adaptive RK23 k3
dispatch, and final stage RHS accounting,
is owned by `gpu/cuda/integrators/rk/rk_stage_schedule.hpp/.cu`. The
Dormand-Prince RK45 stage sequence and DP54 accept sequence are owned by
`gpu/cuda/integrators/rk/rk45_stage_sequence.hpp/.cu`. RK4
midpoint/endpoint predictor and accept sequencing is owned by
`gpu/cuda/integrators/rk/rk4_stage_sequence.hpp/.cu`.
Bogacki-Shampine RK23 predictor and BS23 accept sequencing is owned by
`gpu/cuda/integrators/rk/rk23_stage_sequence.hpp/.cu`; the old combined
`rk4_rk23_stage_sequence.hpp/.cu` compatibility path has been removed. Heun
accept sequencing is owned by
`gpu/cuda/integrators/rk/heun_stage_sequence.hpp/.cu`.
The post-accept BS23 k3 RHS refresh needed for adaptive RK23 error estimation
is owned by `gpu/cuda/integrators/rk/rk23_adaptive_k3.hpp/.cu`.
Device-resident fixed/adaptive RK accepted-attempt looping, including
stage-attempt dispatch, embedded error-norm evaluation, delegated
accept/reject decisions, rejected-attempt restore, and accepted-attempt result
publication, is owned by `gpu/cuda/integrators/rk/rk_attempt_loop.hpp/.cu`.
Accepted-step final RHS/H_eff refresh, FSAL k0 propagation, max-RHS reduction,
base step-stat publication, and device/host residency marking are owned by
`gpu/cuda/integrators/rk/rk_final_refresh.hpp/.cu`. Strict GPU RK snapshot
recomputation and the no-CUDA snapshot fallback are owned by
`gpu/cuda/integrators/rk/rk_snapshot.hpp/.cpp/.cu`.
GPU RK final scalar slots, no-CUDA stats fallback, batched readback, and final
stats orchestration are owned by
`gpu/cuda/integrators/rk/rk_step_stats.hpp/.cpp/.cu`; host-side publication of
device-reduced scalar slots into `fullmag_fem_step_stats` is owned by
`gpu/cuda/integrators/rk/rk_step_stats_publication.hpp/.cpp`. Accepted-step
final refresh, snapshot recomputation, field metrics, and average magnetization
reductions include concrete `gpu/cuda/reductions` and `gpu/cuda/observables`
kernel owners directly instead of the global CUDA kernel compatibility umbrella.
Final accepted-step energy reductions for exchange, demag, Zeeman,
anisotropy, DMI, and magnetoelastic terms are owned by
`gpu/cuda/integrators/rk/rk_energy_reductions.hpp/.cu`; exchange final energy
kernel launch and scalar reduction are owned by
`gpu/cuda/integrators/rk/rk_exchange_energy_reductions.hpp/.cu`;
Zeeman/external final energy validation, kernel launch, and scalar reduction
are owned by
`gpu/cuda/integrators/rk/rk_external_energy_reductions.hpp/.cu`; demag final
energy, Robin boundary energy dispatch, validation, kernel launch, and scalar
reduction are owned by
`gpu/cuda/integrators/rk/rk_demag_energy_reductions.hpp/.cu`; uniaxial and
cubic anisotropy final energy validation, kernel launch, and scalar reduction are
owned by `gpu/cuda/integrators/rk/rk_anisotropy_energy_reductions.hpp/.cu`;
interfacial and bulk DMI final energy validation, kernel launch, and scalar reduction are owned by
`gpu/cuda/integrators/rk/rk_dmi_energy_reductions.hpp/.cu`; prescribed-strain
magnetoelastic final energy validation, kernel launch, and scalar reduction
are owned by
`gpu/cuda/integrators/rk/rk_magnetoelastic_energy_reductions.hpp/.cu`. Final accepted-step
observable reduction orchestration is owned by
`gpu/cuda/integrators/rk/rk_observable_reductions.hpp/.cu`; effective-field,
demag-field, and torque amplitude reductions are owned by
`gpu/cuda/integrators/rk/rk_field_metric_reductions.hpp/.cu`; average
magnetization reductions are owned by
`gpu/cuda/integrators/rk/rk_magnetization_reductions.hpp/.cu`. Embedded RK adaptive-error CUDA block
reducers are owned by `gpu/cuda/integrators/rk/adaptive_error_kernels.hpp/.cu`.
Adaptive RK PI-step policy and reject restore helpers are owned by
`gpu/cuda/integrators/rk/rk_adaptive_runtime.hpp/.cu`. Device adaptive
error-norm runtime reductions are owned by
`gpu/cuda/integrators/rk/rk_error_norm_runtime.hpp/.cu`. The transitional
scalar device-to-host readback and host PI-step handoff for adaptive RK
accept/reject are explicitly owned by
`gpu/cuda/integrators/rk/rk_adaptive_decision_readback.hpp/.cu`. The current
adaptive RK23/RK45 GPU path still performs that scalar readback in the hot RK
attempt loop; benchmark preflight must therefore report adaptive GPU RK
acceptance as blocked until that decision is made without hot-loop compute host
synchronization.
GPU RK FSAL reuse policy for autonomous RHS gating is owned by
`gpu/cuda/integrators/rk/rk_fsal_policy.hpp/.cpp`.
Low-level RK predictor kernels (`euler_stage`, `rk45_stage`) are owned by
`gpu/cuda/integrators/rk/rk_stage_predictor_kernels.hpp/.cu`. The old
`rk_stage_kernels.hpp/.cu` and `rk_stage_accept_kernels.hpp/.cu`
compatibility umbrellas have been removed; callers include the concrete
predictor and per-integrator accept owners directly. Concrete
accepted-state update kernels are owned by per-integrator modules:
`rk_heun_accept_kernel.hpp/.cu`, `rk_rk4_accept_kernel.hpp/.cu`,
`rk_bs23_accept_kernel.hpp/.cu`, and `rk_dp54_accept_kernel.hpp/.cu`.
The old `rk_device_io.hpp/.cu` compatibility umbrella has been removed;
callers include concrete I/O owners directly. Audited scalar-result reads are
owned by `gpu/cuda/integrators/rk/rk_scalar_readback.hpp/.cu`, and component
device-copy plus device-to-host AoS download helpers are owned by
`gpu/cuda/integrators/rk/rk_component_copy.hpp/.cu`.
Device-resident RK RHS assembly orchestration, including exchange dispatch
delegation, demag dispatch delegation, local-field contribution dispatch, H_eff
accumulation, LLG RHS dispatch delegation, and direct torque terms, is owned by
`gpu/cuda/integrators/rk/rk_rhs_runtime.hpp/.cu`. Legacy sparse exchange
validation and CUDA launch dispatch are owned by
`gpu/cuda/integrators/rk/rk_exchange_dispatch.hpp/.cu`. Per-stage RK demag
mode dispatch, including strict device Poisson and explicit hybrid CPU Poisson
compatibility routing, is owned by
`gpu/cuda/integrators/rk/rk_demag_dispatch.hpp/.cu`. Fused RK LLG RHS launch,
including gamma, damping, alpha-field selection, and precession mode argument
plumbing, is owned by `gpu/cuda/integrators/rk/rk_llg_rhs_dispatch.hpp/.cu`.
Per-stage local field contribution orchestration is owned by
`gpu/cuda/integrators/rk/rk_local_fields.hpp/.cu`; uniaxial and cubic
anisotropy field validation and launch are owned by
`gpu/cuda/integrators/rk/rk_anisotropy_field.hpp/.cu`; prescribed-strain
magnetoelastic field validation and launch are owned by
`gpu/cuda/integrators/rk/rk_magnetoelastic_field.hpp/.cu`; deterministic Brown
thermal field validation and launch are owned by
`gpu/cuda/integrators/rk/rk_thermal_field.hpp/.cu`. Per-stage
interfacial and bulk DMI field generation is owned by
`gpu/cuda/integrators/rk/rk_dmi_fields.hpp/.cu`. Effective-field
accumulation from exchange, demag, Zeeman/external, local fields, DMI, and
specialized interaction contributions is owned by
`gpu/cuda/integrators/rk/rk_effective_field.hpp/.cu`; scaled Oersted
contribution validation and accumulation are owned by
`gpu/cuda/integrators/rk/rk_oersted_field.hpp/.cu`. Direct `tau_direct`
orchestration is owned by
`gpu/cuda/integrators/rk/rk_direct_torques.hpp/.cu`; Slonczewski STT validation
and launch are owned by
`gpu/cuda/integrators/rk/rk_slonczewski_torque.hpp/.cu`; Zhang-Li STT validation
and launch are owned by
`gpu/cuda/integrators/rk/rk_zhang_li_torque.hpp/.cu`.
The old external CUDA kernel compatibility umbrella
`gpu/cuda/kernels/kernels.hpp` has been removed. Owner modules under
`gpu/cuda/` include each other only through concrete subsystem headers.
uniaxial/cubic anisotropy CUDA field/energy wrappers are owned by
`gpu/cuda/interactions/anisotropy/anisotropy_kernels.hpp/.cu`;
external-field Zeeman CUDA energy wrappers are owned by
`gpu/cuda/interactions/zeeman/zeeman_kernels.hpp/.cu`;
scaled Oersted CUDA field-add wrappers are owned by
`gpu/cuda/interactions/oersted/oersted_kernels.hpp/.cu`;
interfacial/bulk DMI weak-residual CUDA wrappers are owned by
`gpu/cuda/interactions/dmi/dmi_kernels.hpp/.cu`;
Slonczewski/Zhang-Li STT CUDA RHS wrappers are owned by
`gpu/cuda/interactions/stt/stt_kernels.hpp/.cu`;
deterministic Brown thermal CUDA field wrappers are owned by
`gpu/cuda/interactions/thermal/thermal_kernels.hpp/.cu`;
prescribed-strain magnetoelastic CUDA field/energy wrappers are owned by
`gpu/cuda/interactions/magnetoelastic/magnetoelastic_kernels.hpp/.cu`;
strict device Poisson demag RHS, recovery, and energy CUDA wrappers are owned by
`gpu/cuda/demag_poisson/demag_kernels.hpp/.cu`. GPU step metric and average magnetization
observable wrappers are owned by
`gpu/cuda/observables/observable_kernels.hpp/.cu`. GPU device-wide scalar reductions
are owned by `gpu/cuda/reductions/reduction_kernels.hpp/.cu`. Strict GPU demag Poisson public lifecycle and
status reporting are owned by `gpu/cuda/demag_poisson/poisson.hpp/.cpp`; per-stage
RHS/solve/recovery/energy orchestration is owned by
`gpu/cuda/demag_poisson/stage_compute.hpp/.cpp`; Hypre device-policy solver setup
and iteration/residual extraction are owned by
`gpu/cuda/demag_poisson/hypre_device_solver.hpp/.cpp`; internal P1 RHS/recovery CSR
operator records, workspace layout, and device upload/destroy helpers are owned by
`gpu/cuda/demag_poisson/operators.hpp/.cpp`.
The device-resident GPU RK execution entrypoint is `gpu_rk_device_resident_step`;
the previous `gpu_rk_exchange_only_step` name is not used for production step
dispatch because the path now covers exchange plus eligible local, demag, DMI,
thermal, Oersted, STT, and magnetoelastic terms.
Runner provenance publishes `fem_gpu_qualification_status` as
`unsupported`, `source_visible`, `production_executable`, or `validated`.
The strict GPU path may reach `production_executable` only when resolved
operator modes are device-resident and the hot-loop synchronization audit is
clean; `validated` is reserved for documented validation workloads.

## 5. Target Native Layout

The target native FEM layout is:

```text
native/backends/fem/
  include/
    fem_backend.hpp
    fem_types.hpp
    fem_result.hpp
  core/
    fem_problem.hpp/.cpp
    fem_mesh.hpp/.cpp
    fem_materials.hpp/.cpp
    fem_state.hpp/.cpp
    field_buffers.hpp/.cpp
    interaction.hpp
    interaction_registry.hpp/.cpp
    observables.hpp/.cpp
    telemetry.hpp/.cpp
  cpu/mfem/
    runtime/
      mfem_runtime.hpp/.cpp
      mfem_device.hpp/.cpp
      hypre_runtime.hpp/.cpp
      thread_policy.hpp/.cpp
    spaces/
      h1_spaces.hpp/.cpp
      vector_spaces.hpp/.cpp
      periodic_spaces.hpp/.cpp
      mass_operator.hpp/.cpp
    operators/
      exchange_operator.hpp/.cpp
      gradient_operator.hpp/.cpp
      divergence_operator.hpp/.cpp
      projection.hpp/.cpp
    interactions/
      zeeman.hpp/.cpp
      exchange.hpp/.cpp
      demag_poisson.hpp/.cpp
      anisotropy_uniaxial.hpp/.cpp
      anisotropy_cubic.hpp/.cpp
      dmi_interfacial.hpp/.cpp
      dmi_bulk.hpp/.cpp
      stt_slonczewski.hpp/.cpp
      stt_zhang_li.hpp/.cpp
      thermal_brown.hpp/.cpp
      oersted.hpp/.cpp
      magnetoelastic.hpp/.cpp
    integrators/
      rk_explicit.hpp/.cpp
      adaptive_controller.hpp/.cpp
    observables/
      field_copy.hpp/.cpp
      energy_terms.hpp/.cpp
  gpu/cuda/
    runtime/
    state/
    kernels/
    demag_poisson/
      rhs_operator.hpp/.cpp
      hypre_device_solver.hpp/.cpp
      recovery_operator.hpp/.cpp
      energy.hpp/.cpp
    interactions/
    integrators/
    transfer/
  api/
    c_api.cpp
```

This layout is descriptive, not a command to move files in one patch.

## 6. Interaction Contract

Each energy-derived interaction implements:

```cpp
class FemInteraction {
public:
  virtual ~FemInteraction() = default;
  virtual InteractionId id() const = 0;
  virtual InteractionKind kind() const = 0;
  virtual Capability required_capability() const = 0;
  virtual void validate(const FemProblem& problem, ErrorSink& errors) const = 0;
  virtual void initialize(FemBackendContext& ctx) = 0;
  virtual void add_field(const FemState& state,
                         FemFieldBuffers& fields,
                         Telemetry& telemetry) = 0;
  virtual double energy(const FemState& state,
                        const FemFieldBuffers& fields,
                        Telemetry& telemetry) = 0;
};
```

Direct torque terms implement:

```cpp
class FemTorqueTerm {
public:
  virtual ~FemTorqueTerm() = default;
  virtual void add_rhs(const FemState& state,
                       RhsBuffer& rhs,
                       Telemetry& telemetry) = 0;
};
```

An interaction cannot silently switch between effective-field and direct-torque
interpretations. The physics note must state which path it uses.

## 7. Demag Subsystem

The Poisson demag subsystem owns:

- scalar potential FE space,
- magnetic source assembly,
- boundary policy (`dirichlet`, `robin`, `airbox_dirichlet`,
  `airbox_robin`, future FEM-BEM/FMM),
- hypre matrix/preconditioner/Krylov solver,
- warm-start vectors,
- field recovery `H_demag = -grad(u)`,
- demag energy,
- phase telemetry.

Required telemetry:

```text
demag_rhs_ms
demag_solve_ms
demag_recover_ms
demag_energy_ms
demag_iteration_count
demag_final_residual
demag_preconditioner_reused
demag_boundary_mode
demag_airbox_metadata
```

Demag must be swappable behind the same contract so that Poisson airbox, Robin,
FEM-BEM, Fredkin-Koehler, or FMM strategies can be compared honestly. The
Fredkin-Koehler/FEM-BEM path is a body-only open-boundary method: it must not
allocate or require a volumetric airbox, because the exterior is represented by
a boundary integral operator on the magnetic surface.

The strict GPU Poisson demag realization is a sibling subsystem, not an
extension of `mfem_bridge.cpp`. It owns device CSR RHS/recovery operators,
persistent `poisson_rhs`, `poisson_solution`, `H_demag` buffers, hypre device
execution policy, BoomerAMG/Krylov object lifetime, warm-start residency, and
transfer-audit reporting. Runtime provenance must distinguish:

```text
device_hypre_poisson  -> strict device-resident demag
hybrid_cpu_poisson    -> explicit compatibility/debug round-trip path
```

`study.device("gpu")` resolves to `device_hypre_poisson` for demag-enabled FEM
runs. If hypre GPU, MFEM CUDA, P1/shared-domain preconditions, or device
operators are unavailable, strict GPU must fail clearly instead of falling back
to CPU Poisson.

## 8. Capability and Qualification

Capability has two distinct meanings:

1. executable availability: the runtime can execute a path;
2. qualification: validation and performance gates passed for a documented
   workload.

`production_executable` must not be described as `validated` until the
documented gates pass.

For the first production FEM CPU scope, the preferred qualified target is:

```text
FEM CPU P1
no PBC unless a feature-specific PBC gate passes
exchange
Zeeman
uniaxial anisotropy
cubic anisotropy after derivative tests
Poisson demag airbox with documented boundary limits
explicit RK fixed/adaptive with stop-reason telemetry
```

FEM GPU parity gates live in `crates/fullmag-runner/src/native_fem.rs` and
compare native FEM CPU against native FEM GPU on the same mesh signature,
precision, material configuration, and timestep policy. The required gate set
is:

```text
native_fem_cpu_gpu_exchange_h_eff_and_rhs_parity_when_available
native_fem_cpu_gpu_demag_parity_when_full_gpu_demag_is_available
native_fem_cpu_gpu_integrator_parity_when_available
```

Each gate reports `L2` and `Linf` field error norms when the host exposes the
required MFEM CPU/CUDA runtime. Passing source-only tests or availability probes
is not enough to mark strict FEM GPU as `validated`.

Do not promote these without feature-specific gates:

```text
STT Slonczewski
STT Zhang-Li
DMI interfacial/bulk
thermal noise
two-way magnetoelasticity
high-order FEM
general FEM GPU parity
```

Those features may be executable internally, but release documentation and
capability surfaces must distinguish that from validated production scope.

## 9. Performance Rules

Accepted-step hot paths must avoid:

- heap allocation,
- full field copies for diagnostics,
- dynamic MFEM object creation,
- hidden host/device transfers,
- recomputation of time-invariant material coefficients,
- telemetry-free solver setup or recovery costs.

Each significant operator must report apply/setup timing separately enough to
identify the next bottleneck. For current FEM CPU demag, `solve_poisson` is the
main optimization target, but RHS assembly, recovery, and energy must remain
visible.

## 10. Migration Order

1. Keep existing ABI compatibility and add typed modules beside it.
2. Freeze baseline artifacts before moving an operator.
3. Extract local terms with lowest coupling first.
4. Extract exchange and mass/projection operators.
5. Extract demag Poisson as an independently testable subsystem.
6. Extract DMI and torque terms after unit and variational contracts are
   unambiguous.
7. Collapse remaining `mfem_bridge.cpp` code into runtime, spaces, operators,
   interactions, solvers, integrators, and observables.

Each step needs old-vs-new numerical comparison and a performance regression
check.

## 11. Completion Criteria

The native FEM backend reaches this architecture when:

- `Context` is a facade, not the solver state model;
- `mfem_bridge.cpp` is an adapter/compatibility file, not a physics engine;
- each interaction has a module, physics note, capability status, validation
  gates, and telemetry;
- CPU and GPU lanes implement the same physics contract;
- demag Poisson can be benchmarked and replaced without touching unrelated
  integrator or local-interaction code;
- capability docs distinguish executable, production, and validated status
  honestly.
