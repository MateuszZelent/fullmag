# Native FEM Backend Architecture v1

- Status: canonical target architecture
- Last updated: 2026-05-16
- Related ADRs:
  - `docs/adr/0014-native-fem-backend-modularization.md`
- Related physics:
  - `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
  - `docs/physics/0430-fem-dipolar-demag-mfem-gpu-foundations.md`
  - `docs/physics/0532-fem-demag-solver-policy-and-runtime-threading.md`
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
FEM-BEM, Fredkin-Koehler, or FMM strategies can be compared honestly.

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
