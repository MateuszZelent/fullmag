# Native FEM Backend Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** finish the most important native FEM backend architecture changes described by `docs/reports/17.05.2026/deep-research-report.md`, while explicitly not adding new two-way magnetoelastic interactions in this rollout.

**Architecture:** strangler migration from the current wide `Context` and central MFEM orchestration into typed native FEM descriptors, a narrow backend facade, subsystem-owned state, backend-neutral physics contracts, an interaction registry, a demag subsystem, a stepper subsystem, explicit capability/provenance gates, and validation/performance proof before capability promotion.

**Tech Stack:** C++17 native FEM backend, MFEM/hypre/libCEED/CUDA integration points, Rust runner/capability layer, CMake native tests, Cargo runner tests, Python DSL/planner docs where public semantics move.

---

## Scope

This plan converts the report into executable stages P1-P10. It intentionally avoids a broad folder move as the first action. The first implementation pass must freeze contracts and prove signs/units before moving code, because a clean directory tree with ambiguous physics would be a regression.

Primary inputs:

- `docs/reports/17.05.2026/deep-research-report.md`
- `docs/adr/0014-native-fem-backend-modularization.md`
- `docs/specs/native-fem-backend-architecture-v1.md`
- `docs/physics/0900-native-fem-operator-contracts-and-validation.md`
- `docs/physics/0500-fdm-relaxation-algorithms.md`
- `docs/physics/0510-fem-relaxation-algorithms-mfem-gpu.md`
- `docs/physics/0530-shared-relaxation-stop-and-field-refresh-semantics.md`
- External solver references under `external_solvers/3`, `external_solvers/tetmag`, and `external_solvers/oommf`.

Non-goals for this rollout:

- No new two-way magnetoelastic mechanics coupling.
- No promotion of magnetoelasticity to validated production capability.
- No GPU parity claim for interactions without executable and validated gates.
- No new cross-cutting state added to `native/backends/fem/include/context.hpp` except temporary compatibility handles that are deleted by P10.
- No new physics implemented inside `mfem_bridge.cpp`; it remains an adapter.

## Target invariants

1. `H_eff` is always an H field in `A/m`.
2. A direct torque term is always `dm/dt`-like and has unit `1/s`.
3. The LLG RHS uses reduced `gamma_mu0` in `m/(A s)`, not electron `gamma` in `rad/(T s)`.
4. Energy-derived fields satisfy:

```text
dE = -mu0 integral_Omega Ms H_term . delta_m dV
```

5. Public relaxation torque is `max |m x H_eff|` in `A/m`. Any `T`-style torque value is derived as `mu0 * torque_Apm` and is not the Fullmag stop-control unit.
6. Energy plateau stopping uses `max(E)-min(E)` over the last 50 accepted relaxation steps, in `J`; a single small step-to-step delta is not enough.
7. Energy values may be negative. Stop logic compares ranges or explicit thresholds, not absolute sign assumptions.
8. Demag uses `H_demag = -grad(u)` and:

```text
E_demag = -0.5 mu0 integral_Omega_m Ms m . H_demag dV + boundary_term
```

9. Exchange energy remains non-negative for valid `A_ex >= 0`, and the field sign must drive smoothing/descent under the LLG/relaxation contract.
10. Capability language distinguishes legal semantics, executable implementation, and validated production support.

## P1 - Freeze physics, units, signs, and stop semantics

- [ ] Update `docs/physics/0900-native-fem-operator-contracts-and-validation.md` only if live code contradicts the contract. The contract to freeze is `H_eff` in `A/m`, `tau_direct` in `1/s`, reduced `gamma_mu0` in `m/(A s)`, and energy-derived field sign `dE = -mu0 integral Ms H . delta_m dV`.

- [ ] Add a native source contract test file `native/backends/fem/tests/fem_physics_units_contract.cpp` and wire it in `native/backends/fem/CMakeLists.txt`.

  The test must cover at least:

```cpp
// Pseudocode for exact assertions in the test body.
// 1. m parallel H gives zero torque.
// 2. |m x H| is reported in A/m.
// 3. mu0 * |m x H| is reported only as derived Tesla-style comparability.
// 4. gamma_mu0 is not multiplied by another mu0 inside fallback reconstruction.
// 5. dm/dt-derived fallback torque inverts the reduced-gamma overdamped formula.
```

- [ ] Add directional-derivative tests for each energy-derived term that already claims executable support:

  - `native/backends/fem/tests/fem_exchange_directional_derivative.cpp`
  - `native/backends/fem/tests/fem_demag_energy_sign_contract.cpp`
  - `native/backends/fem/tests/fem_zeeman_energy_sign_contract.cpp`
  - `native/backends/fem/tests/fem_anisotropy_directional_derivative.cpp`

  Required finite-difference check:

```text
(E(normalize(m + eps v)) - E(m)) / eps
  ~= -mu0 integral Ms H_term(m) . v dV
```

- [ ] Check exchange sign against the current MFEM mass-projection path in `native/backends/fem/cpu/mfem/interactions/exchange_mass_projection.cpp`. The implementation may use a negative algebraic solve result internally, but the published field must match the physical `H_ex = (2 A_ex / (mu0 Ms)) Laplacian(m)` convention.

- [ ] Check demag sign against a simple uniform magnetized sphere/ellipsoid or rectangular-prism validation case. For a sphere-like case, `H_demag` points opposite `M`, and `E_demag` must be positive under the Fullmag convention.

- [ ] Check Zeeman sign with a one-cell or uniform-field fixture: alignment with `H_ext` decreases energy, anti-alignment increases it.

- [ ] Check anisotropy signs:

  - easy-axis `Ku > 0` has minima at `m parallel axis`,
  - easy-plane or negative effective coefficient is explicitly documented before being accepted,
  - cubic axes are orthonormal before energy/field evaluation.

- [ ] Check DMI signs only to the existing public convention. If the finite-difference sign is not fully proven, keep DMI capability below validated production.

- [ ] Check all exponent/power uses in native FEM interactions with:

```bash
rg -n "pow|std::pow|\\*\\*|1e-|1e\\+|gamma|mu0|Ms|torque|energy" native/backends/fem
```

  Every dimensioned power must map to a documented formula: `A_ex` in `J/m`, `Ku` in `J/m^3`, DMI coefficient in the current public `J/m^2` convention, current density in `A/m^2`, field in `A/m`, energy in `J`.

- [ ] Compare stop semantics against external solvers:

  - `external_solvers/3/cuda/lltorque.go` and `external_solvers/3/cuda/llnoprecess.cu` use mumax-like no-precession relaxation torque in Tesla-style units.
  - `external_solvers/tetmag/main/TheLLG.cpp` reports `getMaxTorque()` as `mu0 * max |m x H_eff|`.
  - Fullmag must keep the public stop control in `A/m` and may publish the derived Tesla-style value for comparability.

- [ ] Verify the existing 50-step energy plateau implementation in `native/backends/fem/cpu/mfem/runtime/stage_completion.cpp` and equivalent Rust/FDM paths use `max(E)-min(E)` over exactly 50 accepted relax samples, not signed delta, relative delta, or one-step absolute delta.

- [ ] Acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build --target fem_physics_units_contract fem_exchange_directional_derivative fem_demag_energy_sign_contract fem_zeeman_energy_sign_contract fem_anisotropy_directional_derivative
cargo test -p fullmag-runner relaxation_stop --no-fail-fast
git diff --check
```

## P2 - Introduce typed internal FEM descriptors behind the existing C ABI

- [ ] Add `native/backends/fem/core/fem_descriptors.hpp` with backend-neutral internal descriptors translated from the current C ABI inputs:

```cpp
namespace fullmag::fem {

struct FemProblemConfig {
    double gamma_mu0 = 2.211e5;
    double alpha = 0.0;
    bool relaxation_mode = false;
};

struct FemMeshAndRegionsDesc {
    int dimension = 3;
    int order = 1;
    bool has_air_region = false;
    bool has_magnetic_region = false;
};

struct FemMaterialFieldsDesc {
    double uniform_ms_Apm = 0.0;
    double uniform_exchange_Jpm = 0.0;
    bool has_ms_field = false;
    bool has_exchange_field = false;
};

struct FemInteractionDesc {
    const char *name = nullptr;
    bool contributes_energy = false;
    bool contributes_field_Apm = false;
    bool contributes_direct_torque_per_s = false;
};

struct FemSolverDesc {
    bool enable_adaptive_dt = false;
    bool enable_demag = false;
    bool enable_gpu = false;
};

} // namespace fullmag::fem
```

- [ ] Add `native/backends/fem/core/fem_descriptors.cpp` with translation helpers from the existing public structs. Keep all public ABI structs stable in this stage.

- [ ] Add `native/backends/fem/tests/fem_descriptor_translation_contract.cpp`. The test must assert that the descriptor translation preserves requested intent, resolved backend hints, relaxation stop settings, field-refresh settings, and interaction list order.

- [ ] Modify `native/backends/fem/src/context.cpp` only at construction boundaries so it constructs descriptors first and then fills the current `Context` compatibility fields from descriptors. Do not move physics in this stage.

- [ ] Acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build --target fem_descriptor_translation_contract fem_stage_completion_contract
cargo test -p fullmag-runner native_fem_plan --no-fail-fast
git diff --check
```

## P3 - Split Context ownership without changing public behavior

- [ ] Add ownership structs under `native/backends/fem/core/`:

  - `problem_config.hpp/.cpp`
  - `mesh_and_regions.hpp/.cpp`
  - `material_fields.hpp/.cpp`
  - `field_buffers.hpp/.cpp`
  - `diagnostics_state.hpp/.cpp`

- [ ] Move state from `native/backends/fem/include/context.hpp` into these owners in small slices. Keep compatibility accessors or references on `Context` only while old call sites are migrated.

  Target shape by the end of this stage:

```cpp
struct Context {
    ProblemConfig problem;
    MeshAndRegions mesh_regions;
    MaterialFields material_fields;
    FieldBuffers field_buffers;
    DiagnosticsState diagnostics;

    // Transitional compatibility only. No new physics may depend on these.
};
```

- [ ] Add `native/backends/fem/tests/fem_context_ownership_contract.cpp`. It must verify that creating a context, loading material fields, refreshing fields, and collecting step stats produces byte-for-byte equivalent public stats for the existing CPU path before and after the split.

- [ ] Move diagnostic counters and profiler phase state into `DiagnosticsState` without changing the public endpoints or `set_solver_profile` behavior.

- [ ] Delete each transitional `Context` member only after all call sites use the owner object. Do not leave duplicate source-of-truth fields.

- [ ] Acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build --target fem_context_ownership_contract fem_step_metrics_contract
cargo test -p fullmag-runner native_fem_stats --no-fail-fast
git diff --check
```

## P4 - Finish the StepperSubsystem extraction

- [ ] Promote the RK migration already started around `native/backends/fem/cpu/mfem/integrators/rk_tableau.hpp`, `rk_stepper_workspace.hpp`, `rk_explicit.hpp`, and `rk_explicit_step.hpp` into a named subsystem:

  - `native/backends/fem/core/stepper_subsystem.hpp/.cpp`
  - `native/backends/fem/cpu/mfem/integrators/mfem_stepper_subsystem.hpp/.cpp`

- [ ] The subsystem owns RK tableaus, stage buffers, adaptive-step state, accepted/rejected counters, pseudo-time accumulation, and the per-stage RHS workspace. `Context` may call it but must not own duplicate RK arrays.

- [ ] Preserve all explicit RK integrators currently supported by the native FEM path. The existing project learning says gates must cover every supported explicit RK integrator, not only Heun.

- [ ] Add or extend tests:

  - `native/backends/fem/tests/rk_explicit_contract.cpp`
  - `native/backends/fem/tests/stage_completion_contract.cpp`
  - `native/backends/fem/tests/fem_stepper_workspace_contract.cpp`

- [ ] Verify relaxation stop fields are independent of timestep seeding:

  - `max_steps` is an iteration budget,
  - `max_pseudotime_s` is execution pseudo-time,
  - `max_physical_time_s` is physical-time budget,
  - absence of time stop means unbounded by time,
  - 50-step energy plateau can stop only after 50 accepted samples.

- [ ] Acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build --target rk_explicit_contract stage_completion_contract fem_stepper_workspace_contract
cargo test -p fullmag-runner relaxation --no-fail-fast
git diff --check
```

## P5 - Replace central field assembly with an interaction registry

- [ ] Add backend-neutral interaction contracts:

  - `native/backends/fem/core/interaction.hpp`
  - `native/backends/fem/core/interaction_registry.hpp/.cpp`
  - `native/backends/fem/core/field_accumulator.hpp/.cpp`

  Required interface:

```cpp
enum class FemContributionKind {
    EnergyDerivedField,
    DirectField,
    DirectTorque,
};

struct FemContribution {
    FemContributionKind kind;
    const char *name;
    const char *unit;
};

class FemInteraction {
public:
    virtual ~FemInteraction() = default;
    virtual const char *name() const = 0;
    virtual FemContribution contribution() const = 0;
    virtual bool evaluate(const FieldBuffers &in, FieldAccumulator &out, std::string &error) = 0;
};
```

- [ ] Convert existing terms one at a time from branches in `native/backends/fem/cpu/mfem/interactions/effective_field.cpp` into registered interactions:

  - exchange,
  - demag,
  - Zeeman,
  - uniaxial anisotropy,
  - cubic anisotropy,
  - interfacial DMI,
  - bulk DMI,
  - Oersted,
  - thermal Brown field,
  - existing prescribed-strain magnetoelastic field.

- [ ] Keep existing prescribed magnetoelastic support as an internal/reference interaction with the same behavior and capability status. Do not add elastic displacement solve, stress feedback, acoustic coupling, or two-way mechanics in this plan.

- [ ] `effective_field.cpp` becomes an adapter that asks the registry to evaluate interactions and sums fields through `FieldAccumulator`. It no longer owns policy decisions or per-interaction physics.

- [ ] Add `native/backends/fem/tests/fem_interaction_registry_contract.cpp`. It must assert interaction order stability, unique names, correct contribution units, and no direct torque mixed into `H_eff`.

- [ ] Add a source-level guard test `native/backends/fem/tests/fem_effective_field_adapter_contract.cpp` that fails if `effective_field.cpp` regains hard-coded branches for every physics term after migration.

- [ ] Acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build --target fem_interaction_registry_contract fem_effective_field_adapter_contract
cargo test -p fullmag-runner native_fem_interactions --no-fail-fast
git diff --check
```

## P6 - Make demag a first-class subsystem

- [ ] Add subsystem boundary files:

  - `native/backends/fem/core/demag_subsystem.hpp`
  - `native/backends/fem/cpu/mfem/interactions/demag_subsystem_mfem.hpp/.cpp`

- [ ] Move ownership of Poisson setup, RHS assembly, solve, field recovery, cached energy, boundary correction, telemetry, and warm-start vectors from `Context` into the demag subsystem.

- [ ] Preserve `PoissonHypreWorkspace` as the native FEM CPU warm-start cache. Warm-start reuse is part of the production proof and must not be lost during extraction.

- [ ] Preserve telemetry fields:

  - realization name,
  - setup time,
  - RHS time,
  - solve time,
  - recovery time,
  - energy time,
  - iteration count,
  - residual,
  - setup reused flag,
  - workspace cache key.

- [ ] Add or preserve tests:

  - `native/backends/fem/tests/demag_poisson_contract.cpp`
  - `native/backends/fem/tests/native_fem_hypre_solve_reuses_persistent_warm_start_vector.cpp`
  - `native/backends/fem/tests/fem_demag_telemetry_contract.cpp`

- [ ] Acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build --target demag_poisson_contract native_fem_hypre_solve_reuses_persistent_warm_start_vector fem_demag_telemetry_contract
cargo +nightly test -p fullmag-engine --test exchange_density_study
git diff --check
```

## P7 - Correct capability and provenance truth

- [ ] Update `crates/fullmag-runner/src/capabilities.rs` so each FEM interaction has separate statuses for:

  - semantic legality,
  - executable implementation,
  - validated production support.

- [ ] Sync `docs/specs/capability-matrix-v0.md` with the runner. No interaction may be listed as validated production unless its P1/P5/P6 derivative, sign, unit, telemetry, and benchmark gates pass.

- [ ] Magnetoelasticity remains planned/internal-reference for this rollout unless the existing prescribed-strain path has explicit validation. It must not be advertised as two-way coupled or production validated.

- [ ] GPU capability blocks in `native/backends/fem/include/gpu_rk.hpp` and runner provenance must distinguish exchange-only, exchange-demag, local fields, direct torque, and unsupported interaction sets. Unsupported GPU paths fail clearly or degrade explicitly according to execution mode.

- [ ] Runner metadata must preserve requested intent and resolved reality:

```text
requested_discretization
requested_device
requested_precision
requested_relaxation_algorithm
resolved_backend
resolved_device
resolved_precision
resolved_interactions
capability_status_by_interaction
stop_reason
stop_metric_name
stop_metric_value
stop_metric_threshold
```

- [ ] Add runner tests:

  - capability rejection for unsupported strict paths,
  - explicit degraded provenance for non-strict paths,
  - magnetoelastic not promoted to validated production,
  - GPU unsupported interaction explains the exact blocker.

- [ ] Acceptance commands:

```bash
cargo test -p fullmag-runner capabilities native_fem --no-fail-fast
rg -n "magnetoelastic" crates/fullmag-runner/src/capabilities.rs docs/specs/capability-matrix-v0.md native/backends/fem/include/gpu_rk.hpp
git diff --check
```

## P8 - Shrink `mfem_bridge.cpp` and `context.cpp` into adapters

- [ ] Identify the remaining non-adapter responsibilities in:

  - `native/backends/fem/src/context.cpp`
  - `native/backends/fem/src/mfem_bridge.cpp`
  - `native/backends/fem/include/context.hpp`

- [ ] Move problem construction to `ProblemConfig` and descriptor translation.

- [ ] Move mesh/region construction to `MeshAndRegions`.

- [ ] Move material upload and per-node fields to `MaterialFields`.

- [ ] Move field memory and AoS/component views to `FieldBuffers`.

- [ ] Move step/update decisions to `StepperSubsystem`.

- [ ] Move demag into `DemagSubsystem`.

- [ ] Move diagnostics/profiler state to `DiagnosticsState`.

- [ ] After each move, run the smallest contract test for that owner before starting the next owner.

- [ ] Final adapter criterion:

```text
mfem_bridge.cpp may:
  - translate C ABI calls,
  - create/destroy backend instances,
  - forward calls to subsystem owners,
  - translate errors.

mfem_bridge.cpp may not:
  - assemble physics fields,
  - choose interaction signs,
  - own solver workspace,
  - own capability policy,
  - own relaxation stop semantics.
```

- [ ] Acceptance commands:

```bash
rg -n "enable_exchange|enable_demag|enable_magnetoelastic|gamma|mu0|torque|energy" native/backends/fem/src/mfem_bridge.cpp native/backends/fem/src/context.cpp
cmake --build /tmp/fullmag-native-fem-arch-build --target fem_context_ownership_contract fem_interaction_registry_contract demag_poisson_contract stage_completion_contract
git diff --check
```

## P9 - CPU production slice, performance, and profiler gates

- [ ] Define the first validated production FEM CPU scope as:

```text
P1 tetra/H1:
  exchange + demag + Zeeman + uniaxial anisotropy
  double precision
  no-PBC unless explicit PBC gate passes
  explicit RK relaxation/time integration
  50-step energy plateau and torque stop metadata
```

- [ ] Update `docs/validation/fem_cpu_validation_matrix.md` with executable vs validated rows for the P1 production slice.

- [ ] Preserve opt-in solver profiler behavior:

  - disabled by default,
  - bounded `SolverProfileState`,
  - stable phase IDs,
  - no profiler sample allocation/logging when disabled,
  - `/v2/sessions/current/diagnostics/solver-profile` remains compatible.

- [ ] Add benchmark/proof commands for the production slice. Required metadata:

  - native CPU provenance,
  - active interaction energies,
  - demag setup reuse after warm-start,
  - stop reason,
  - stop metric name/value/threshold,
  - minimum qualified steps unless stopped by torque,
  - profiler phases when profiling is explicitly enabled.

- [ ] Acceptance commands:

```bash
cargo +nightly test -p fullmag-engine --test exchange_density_study
cargo test -p fullmag-runner fem_cpu_relaxation_qualification --no-fail-fast
git diff --check
```

## P10 - GPU boundaries and final cutover audit

- [ ] Keep CPU and GPU implementations behind backend-neutral physics contracts. Do not duplicate signs, units, or observable names per device.

- [ ] GPU paths must be honest:

  - executable exchange-only is not exchange-demag,
  - local-field support is not direct-torque support,
  - host fallback is explicit provenance, not hidden GPU support,
  - missing CUDA/libCEED/hypre support reports a blocker, not a silent downgrade in strict mode.

- [ ] Add source/provenance tests that fail if GPU code reintroduces CPU-owned hot-loop state without an explicit transfer/provenance record.

- [ ] Delete transitional duplicate `Context` fields that are no longer read.

- [ ] Run a final source audit:

```bash
rg -n "FIXME|temporary|transitional|compatibility only|enable_magnetoelastic|gamma|mu0|torque|energy" native/backends/fem crates/fullmag-runner docs/physics docs/specs
rg -n "new .*Context|Context .*owns|mfem_bridge.*energy|mfem_bridge.*torque" native/backends/fem
```

  Any remaining transitional marker must either be deleted in this rollout or have a documented owner, removal condition, and validation reason in `docs/specs/native-fem-backend-architecture-v1.md`.

- [ ] Final acceptance commands:

```bash
cmake --build /tmp/fullmag-native-fem-arch-build
cargo test -p fullmag-runner --no-fail-fast
cargo +nightly test -p fullmag-engine --test exchange_density_study
git diff --check
```

## Execution order

Implement P1 first. Do not start P2-P10 until P1 physics/unit/sign tests pass, because later architecture work will otherwise preserve or spread wrong semantics.

Then implement P2 and P3 together in small patches: descriptors first, owner split second. P4-P6 can proceed after P3 because stepper, interaction registry, and demag need real owners. P7 must land before any public capability/provenance claim. P8-P10 are cutover and proof stages.

## Completion checklist

- [ ] New two-way magnetoelastic interactions were not added.
- [ ] Prescribed magnetoelastic behavior, if still executable, is clearly labeled with its actual capability status.
- [ ] `Context` is no longer the cross-cutting owner of problem config, mesh, materials, buffers, demag, stepper, device runtime, and diagnostics.
- [ ] `mfem_bridge.cpp` is an adapter and does not define physics.
- [ ] Every energy-derived field has at least one directional-derivative test.
- [ ] Demag energy sign is validated against an analytic/reference fixture.
- [ ] Relaxation stop logic uses torque in `A/m` and 50-step total-energy range in `J`.
- [ ] Capability matrix, runner capabilities, provenance metadata, and validation docs agree.
- [ ] CPU production slice has benchmark/qualification metadata.
- [ ] GPU paths are explicit about unsupported or unvalidated interactions.
