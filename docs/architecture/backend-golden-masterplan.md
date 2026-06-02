# Fullmag Backend Golden Masterplan

- Status: canonical masterplan draft
- Owners: Fullmag core
- Last updated: 2026-06-02
- Scope: backend solver architecture, runtime ownership, source layout, production physics validation, and follow-up updates for docs, `AGENTS.md`, and skills.

## 1. Purpose

This document is the backend source of truth that must sit above individual ADRs,
physics notes, implementation reports, and local agent instructions.

The immediate symptom is that `crates/fullmag-runner/src/dispatch.rs` has grown
into a monolith. The deeper architectural issue is that Fullmag operates four
solver lanes that must remain convergent but must not be mixed:

1. FDM CPU
2. FDM GPU
3. FEM CPU
4. FEM GPU

Those lanes share physics contracts, public quantity semantics, units,
provenance vocabulary, and validation targets. They do not share hidden runtime
state, hot loops, device residency, fallback behavior, or backend-specific
implementation details.

## 2. Non-negotiable rules

1. A solver lane is an explicit execution boundary, not just a device flag.
2. FDM and FEM are separate discretizations. They may be compared or connected
   through explicit transfer contracts, but neither solver should call the
   other's implementation during its own solve.
3. CPU and GPU are separate implementations of a lane. They must implement the
   same backend-neutral physics contract and publish requested-vs-resolved
   provenance.
4. Forced GPU must fail clearly when GPU requirements are not met. Silent CPU
   fallback is allowed only for explicitly non-forced modes and must be recorded
   in provenance.
5. Public semantics live above compiled backends. Compiled backends execute
   semantics; they must not invent product behavior that is invisible to IR,
   planner, API, or documentation.
6. Runtime validation is separate from local contract validation. A local unit
   test can prove selection logic; it does not prove CUDA/MFEM runtime behavior.
7. New solver code must not be added to `dispatch.rs`. Until it is split,
   `dispatch.rs` is a compatibility facade and migration queue.
8. Fullmag is not building a standalone in-house FEM numerical stack beyond the
   MFEM/hypre/libCEED line. Historical repository names must not define the
   architecture. FEM means MFEM/hypre/libCEED integration with CPU and GPU
   execution lanes.

## 3. Four solver lanes

| Lane | Discretization | Device | Current primary ownership | Current selection surface | Canonical role |
|---|---|---|---|---|---|
| FDM CPU | finite-difference grid | CPU | target: `crates/fullmag-runner/src/solvers/fdm/cpu/*` and `crates/fullmag-engine/src/solvers/fdm/cpu/*` | `FdmEngine::CpuReference`, `FULLMAG_FDM_EXECUTION=cpu` | CPU reference/validation lane and CPU execution baseline for FDM |
| FDM GPU | finite-difference grid | CUDA GPU | target: `backends/solvers/fdm/gpu/cuda/*` plus Rust lane facade | `FdmEngine::CudaFdm`, `FULLMAG_FDM_EXECUTION=cuda/gpu/auto` | production GPU lane for structured-grid FDM |
| FEM CPU | finite-element mesh | CPU | target: `backends/solvers/fem/mfem/cpu/*` plus Rust lane facade | target: `FemEngine::MfemCpu`, `FULLMAG_FEM_EXECUTION=cpu/auto` | production CPU lane backed by MFEM/hypre/libCEED |
| FEM GPU | finite-element mesh | CUDA GPU | target: `backends/solvers/fem/mfem/gpu/*` plus Rust lane facade | target: `FemEngine::MfemGpu`, `FULLMAG_FEM_EXECUTION=gpu/all_in_gpu`, `FULLMAG_FEM_ALL_IN_GPU=1` | production GPU lane backed by MFEM/hypre/libCEED/CUDA |

Rust FEM reference code, for example `crates/fullmag-engine/src/fem.rs` and
`crates/fullmag-runner/src/fem_reference.rs`, remains a validation and debug
surface. It is not a production lane and must not become the way Fullmag grows
an independent FEM solver beside MFEM/hypre/libCEED.

## 4. Backend layer map

The allowed dependency direction is:

```text
Python DSL / examples
  -> ProblemIR and planning
  -> solver_runtime selection
  -> solvers/{fdm,fem} lane facade
  -> backends/solvers/* compiled implementation where needed
  -> artifacts, telemetry, provenance
  -> API resources
  -> control-room clients and views
```

Target source ownership:

| Layer | Target paths | Responsibility |
|---|---|---|
| Authoring surface | `packages/fullmag-py/src/fullmag/*`, `examples/*` | public problem description, solver hints, mesh hints, study setup |
| IR and planning | `crates/fullmag-ir/*`, `crates/fullmag-plan/*` | backend-neutral problem model, validation, capability planning |
| Solver runtime | `crates/fullmag-runner/src/solver_runtime/*` | requested/resolved engine IDs, availability, fallback, provenance, managed runtime discovery |
| Rust solver facades | `crates/fullmag-runner/src/solvers/*` | lane routing, plan normalization, preview, artifacts, API-facing result contracts |
| Rust reference numerics | `crates/fullmag-engine/src/solvers/*` | CPU/reference numerics, shared contracts, validation baselines |
| Compiled solver backends | `backends/solvers/*` | CUDA FDM and MFEM/hypre/libCEED FEM implementations |
| Runtime bundle/export | `docker/fem-gpu/*`, `scripts/export_fem_gpu_runtime.sh`, `.fullmag/runtimes/*`, `just ensure-managed-fem-runtime` | reproducible backend packaging and freshness |
| Session/API | `crates/fullmag-api/*`, generated OpenAPI, handwritten `ControlRoomApi` | resource contracts, session state, artifact access, status/provenance exposure |
| Control room | `apps/control-room/*` | generated/handwritten API consumption, resource hooks, visualization, smoke validation |

Backend contract changes that touch API-visible behavior must flow through
backend resource code, generated OpenAPI artifacts, handwritten client code, and
focused control-room resource or smoke checks.

## 5. Canonical target solver tree

This is the intended source tree after the masterplan refactor. It is not an
illustrative sketch. It is the navigation model humans should use when looking
for a solver, interaction, workflow, integrator, observable, backend adapter, or
validation fixture.

### 5.1 External solver architecture lessons

The target layout follows patterns already proven by the local reference
solvers in `external_solvers/`:

| Solver | Local evidence | Architectural lesson for Fullmag |
|---|---|---|
| mumax3 | `external_solvers/3/engine/exchange.go`, `demag.go`, `energy.go`, `relax.go`, `run.go`; CUDA kernels under `external_solvers/3/cuda/*` | physics interactions, energy registration, relaxation, time loop, and CUDA kernels are separate modules, not branches in one dispatcher |
| BORIS | `external_solvers/BORIS/Boris/Exchange.*`, `ExchangeCUDA.*`, `Demag*`, `Zeeman*`, `DiffEqFM_Evals_*.cpp`, `DiffEqFM_EvalsCUDA_*.cu` | CPU/CUDA implementations mirror each other by interaction and by algorithm; complex subsystems such as demag get their own directory-level ownership |
| TetraX | `external_solvers/tetrax/tetrax/interactions/*`, `experiments/_relax/*`, `experiments/eigen/*` | interactions are plugin-like units; relaxation and eigensolvers are workflow modules above interactions, not mixed into interaction code |

Fullmag adopts these rules:

1. Every interaction is a first-class module. It owns its parameters, effective
   field or weak form, energy, energy density, observables, validation fixtures,
   and CPU/GPU realization adapters.
2. Every workflow is a first-class module. Time-domain solve, relaxation,
   hysteresis, eigensolver, and frequency-domain solve are sibling workflows.
   They must not be hidden as branches in `dispatch.rs`, `execute.rs`, or a
   compiled bridge file.
3. CPU and GPU code must mirror names and ownership. If FDM CUDA has
   `interactions/exchange`, FDM CPU and the shared FDM contract must expose the
   corresponding exchange module unless the capability is explicitly unsupported
   with provenance.
4. Non-local or workspace-heavy interactions, especially demag, are subsystem
   directories. FFT kernels, convolution plans, PBC kernels, mesh operators, and
   temporary buffers do not belong in a generic interaction file.
5. Energy and observable aggregation uses registries. Interactions register
   terms; aggregate total energy code must not know every interaction through a
   growing `match` or `if` chain.
6. Validation is colocated with the module it protects and promoted into the
   production physics suite. A new interaction without fixtures is incomplete.

### 5.2 Required navigation axes

The tree is organized by three axes:

1. Discretization: `fdm` and `fem/mfem`.
2. Device lane: `cpu` and `gpu/cuda`.
3. Concern: `interactions`, `workflows`, `integrators`, `observables`,
   `artifacts`, and `validation`.

The user-facing FEM architecture is MFEM/hypre/libCEED. Historical file names
may remain only as migration sources until they are renamed or deleted.

### 5.3 FEM demag is a model family

FEM demagnetization is not one implementation behind `demag/`. It is a family
of numerical realizations of the same magnetostatic energy and field contract.
The architecture must keep these axes separate:

| Axis | Examples | Why it matters |
|---|---|---|
| Physical/numerical model | Poisson airbox, FEM/BEM Fredkin-Koehler, BEM, FMM, mapped exterior/shell transform | decides whether the exterior is a volumetric air domain, a boundary integral, or a far-field approximation |
| Mesh topology | shared magnetic+air domain, body-only magnetic mesh, periodic shared-domain unit cell | planner must choose or reject mesh workflows before runtime |
| Boundary variant | airbox Dirichlet, airbox Robin, periodic reduced Poisson, open-boundary BEM | changes weak form, validation target, and provenance |
| Runtime realization | MFEM/hypre CPU, MFEM/hypre GPU, libCEED/CUDA operators, dense reference BEM, compressed BEM/H2/FMM, explicit hybrid CPU Poisson debug path | changes performance, residency, fallback legality, and runtime telemetry |

Current and target FEM demag strategy names:

| Strategy | Mesh requirement | CPU status | GPU status | Notes |
|---|---|---|---|---|
| `poisson_airbox_dirichlet` | shared magnetic+air mesh | executable/bootstrap | target via MFEM/hypre GPU when prerequisites pass | finite-domain approximation, fastest sanity path |
| `poisson_airbox_robin` | shared magnetic+air mesh | executable/default | target via MFEM/hypre GPU when prerequisites pass | current preferred airbox model; must carry Robin beta policy |
| `poisson_airbox_pbc_reduced` | periodic shared magnetic+air unit cell | reference/partial, MFEM target | target after MFEM/hypre PBC gate | excludes Robin/Dirichlet mass on periodic seams |
| `fem_bem_fredkin_koehler` | body-only closed magnetic mesh with oriented boundary | dense reference path first | future compressed/operator path | no volumetric airbox; exterior is represented by boundary integral |
| `bem` | body-only closed magnetic mesh with oriented boundary | architecture only until capability gate | future | public alias or lower-level realization must be decided by capability matrix |
| `fmm` | body-only magnetic mesh | future | future | far-field acceleration, not a separate public energy term |
| `mapped_exterior_shell` | mapped exterior mesh | future | future | may require exterior shell elements but not ordinary truncated airbox semantics |

Rules:

1. `Demag()` remains the public physics term. FEM demag model selection is a
   requested/resolved strategy under that term, not a new interaction.
2. Airbox strategies must require `air_box_config` and shared-domain
   magnetic+air meshes. FEM/BEM/FMM strategies must not allocate or require a
   volumetric airbox.
3. Provenance must record requested model, resolved model, mesh topology,
   boundary variant, solver policy, execution realization, and validation
   status.
4. Runtime compatibility paths such as `hybrid_cpu_poisson` are execution
   realizations, not physical models. Strict GPU requests must not silently
   fallback to them.
5. Cross-model validation is mandatory: airbox padding convergence must be
   compared against body-only open-boundary strategies on the same magnetic
   body before production claims.

```text
crates/fullmag-runner/src/
  solver_runtime/
    engine.rs              requested/resolved engine IDs
    selection.rs           env/user-hint parsing and lane selection
    availability.rs        CPU/GPU/MFEM/CUDA availability records
    registry.rs            managed runtime discovery and freshness
    provenance.rs          shared requested/resolved/fallback records

  solvers/
    mod.rs
    shared/
      units.rs             lane-independent unit assertions
      quantities.rs        public quantity and artifact IDs
      energy_registry.rs   aggregate energy/energy-density registry contracts
      validation.rs        common validation report types
      state_transfer.rs    explicit FDM<->FEM transfer contracts
      interactions/
        exchange.rs        backend-neutral interaction contracts
        demag.rs
        zeeman.rs
        anisotropy.rs
        dmi.rs
        thermal.rs
        stt.rs
        oersted.rs
        magnetoelastic.rs

    fdm/
      mod.rs
      contract.rs          FDM public lane contract
      plan.rs              FDM plan normalization
      execute.rs           FDM execution facade
      preview.rs           FDM preview/data extraction
      artifacts.rs         FDM artifact persistence
      observables.rs       FDM energy/field/average read models
      interactions/
        exchange/
          contract.rs
          field.rs
          energy.rs
          observables.rs
          validation.rs
        demag/
          contract.rs
          field.rs
          energy.rs
          fft_plan.rs
          pbc.rs
          observables.rs
          validation.rs
        zeeman/
        anisotropy/
        dmi/
        thermal/
        stt/
      workflows/
        time_domain/
          execute.rs
          schedule.rs
          output.rs
        relaxation/
          energy_minimize.rs
          torque_minimize.rs
          execute.rs
        hysteresis/
          sweep.rs
          loop_state.rs
          execute.rs
        frequency_domain/
          linear_response.rs
          spectrum.rs
          execute.rs
      integrators/
        euler.rs
        heun.rs
        rk4.rs
        rk_adaptive.rs
      cpu/
        mod.rs
        engine.rs          CPU reference lane adapter
        integrators/
        interactions/
          exchange/
            stencil.rs
            workspace.rs
          demag/
            convolution.rs
            workspace.rs
        observables/
        workflows/
      gpu/
        mod.rs
        cuda/
          engine.rs        CUDA FDM lane adapter
          residency.rs
          integrators/
          interactions/
            exchange/
              launch.rs
              workspace.rs
            demag/
              kernel_builder.rs
              convolution.rs
              workspace.rs
          demag_fft/
          observables/
          workflows/

    fem/
      mod.rs
      contract.rs          FEM public lane contract
      plan.rs              FEM plan normalization
      pbc.rs               FEM periodic and capability preprocessing
      execute.rs           FEM workflow facade after lane selection
      preview.rs           FEM preview/data extraction
      artifacts.rs         FEM artifact persistence
      observables.rs       FEM energy/field/average read models
      workflows/
        time_domain/
          execute.rs
          schedule.rs
          output.rs
        relaxation/
          energy_minimize.rs
          torque_minimize.rs
          execute.rs
        hysteresis/
          sweep.rs
          loop_state.rs
          execute.rs
        eigen/
          assemble_dynamic_matrix.rs
          solve.rs
          mode_profiles.rs
          execute.rs
        frequency_domain/
          linear_response.rs
          spectrum.rs
          execute.rs
      mfem/
        mod.rs
        common/
          abi.rs           Fullmag <-> MFEM C ABI descriptors
          mesh.rs          mesh import, markers, FE space setup contract
          materials.rs     material fields and coefficient import
          fields.rs        magnetization and effective-field buffers
          interactions/
            exchange/
              contract.rs
              coefficients.rs
              weak_form.rs
              energy.rs
              validation.rs
            demag/
              contract.rs
              model.rs
              mesh_requirements.rs
              provenance.rs
              airbox.rs
              energy.rs
              validation.rs
              poisson_airbox/
                dirichlet.rs
                robin.rs
                pbc_reduction.rs
                weak_form.rs
                solver_policy.rs
              fem_bem/
                boundary_surface.rs
                fredkin_koehler.rs
                dense_reference.rs
                compressed_operator.rs
              fmm/
                contract.rs
              mapped_exterior_shell/
                contract.rs
            zeeman/
            anisotropy/
            dmi/
            thermal/
            stt/
            oersted/
            magnetoelastic/
          observables/
          validation/
        cpu/
          engine.rs        MFEM CPU lane adapter
          spaces/
          operators/
          hypre/
          integrators/
          demag/
            poisson_airbox/
              rhs.rs
              hypre_solver.rs
              recovery.rs
              energy.rs
              warm_start.rs
            pbc_reduced_poisson/
              reduction.rs
              solver.rs
              recovery.rs
            fem_bem/
              neumann_poisson.rs
              boundary_operator_dense.rs
              boundary_operator_compressed.rs
              dirichlet_laplace.rs
              recovery.rs
              energy.rs
            validation_reference/
          interactions/
            exchange/
              operator.rs
              workspace.rs
            demag/
              operator.rs
              workspace.rs
          observables/
          workflows/
        gpu/
          engine.rs        MFEM GPU lane adapter
          cuda/
          libceed/
          hypre_device/
          transfer/
          integrators/
          demag/
            poisson_airbox/
              device_hypre_solver.rs
              rhs_recovery_kernels.rs
              energy_kernels.rs
              warm_start.rs
              residency.rs
            hybrid_cpu_poisson/
              transfer_audit.rs
              compatibility.rs
            pbc_reduced_poisson/
              device_reduction.rs
              solver.rs
            fem_bem/
              boundary_operator_apply.rs
              compressed_operator.rs
          interactions/
            exchange/
              ceed_operator.rs
              cuda_workspace.rs
            demag/
              ceed_operator.rs
              cuda_workspace.rs
          observables/
          workflows/
```

Compiled implementation target:

```text
backends/solvers/
  fdm/
    cuda/
      abi/
      runtime/
      interactions/
        exchange/
          contract.hpp
          kernels.cu
          launch.cpp
          energy.cu
        demag/
          kernels.cu
          fft_plan.cpp
          convolution.cu
          pbc.cu
        zeeman/
        anisotropy/
        dmi/
        thermal/
        stt/
      integrators/
        euler/
        rk4/
        rk_adaptive/
      workflows/
        time_domain/
        relaxation/
        hysteresis/
        frequency_domain/
      observables/
      tests/

  fem/
    mfem/
      abi/
      runtime/
      common/
        mesh/
        spaces/
        materials/
        fields/
        interactions/
          exchange/
          demag/
            contract/
            poisson_airbox/
            fem_bem/
            fmm/
          zeeman/
          anisotropy/
          dmi/
        observables/
        validation/
      cpu/
        operators/
        hypre/
        integrators/
        demag/
          poisson_airbox/
          pbc_reduced_poisson/
          fem_bem/
          validation_reference/
        interactions/
          exchange/
          demag/
          zeeman/
          anisotropy/
          dmi/
        workflows/
          time_domain/
          relaxation/
          hysteresis/
          eigen/
          frequency_domain/
        observables/
      gpu/
        cuda/
        libceed/
        hypre_device/
        transfer/
        integrators/
        demag/
          poisson_airbox/
          hybrid_cpu_poisson/
          pbc_reduced_poisson/
          fem_bem/
        interactions/
          exchange/
          demag/
          zeeman/
          anisotropy/
          dmi/
        workflows/
          time_domain/
          relaxation/
          hysteresis/
          eigen/
          frequency_domain/
        observables/
      tests/
```

Rules for this tree:

1. A new interaction must appear under `interactions/<name>/` for every lane
   that implements it, and under `common/interactions/<name>/` for shared
   contract code.
2. CPU and GPU implementations may share descriptors and validation, but they
   must not hide device-specific behavior in a common hot-loop module.
3. FDM code never lives under `fem/`; FEM code never lives under `fdm/`.
4. MFEM common code is allowed only for FEM descriptors, mesh/spaces/material
   import, shared observables, validation, and ABI descriptors.
5. Workflow modules own algorithms. `relaxation`, `hysteresis`, `eigen`, and
   `frequency_domain` must be discoverable by path before implementation is
   considered complete.
6. FEM demag model code must be discoverable under
   `fem/mfem/*/demag/<strategy>/`. A generic `demag.rs` or `demag/` may only
   hold contracts, registries, and shared dispatch, never all model
   implementations.
7. `mod.rs`, `execute.rs`, and bridge files are orchestration surfaces, not
   homes for physics equations, kernels, or solver algorithms.
8. `dispatch.rs`, `Context`, and `mfem_bridge.cpp` are compatibility migration
   files, not target homes for new code.
9. Target module files should stay below 500 lines. A larger file requires a
   written reason and an extraction task in the roadmap.
10. New target paths must use `fem/mfem`, not historical standalone FEM naming.

## 6. Legacy migration map

Current paths are implementation history. They must migrate into the target tree
above:

| Current path | Target path |
|---|---|
| `crates/fullmag-runner/src/dispatch.rs` | delete or reduce to a tiny compatibility shim after `solver_runtime/*` and `solvers/*` exist |
| `crates/fullmag-runner/src/fdm/*` | `crates/fullmag-runner/src/solvers/fdm/*` |
| `crates/fullmag-runner/src/fem/*` | `crates/fullmag-runner/src/solvers/fem/*` |
| `crates/fullmag-runner/src/native_fem.rs` | `crates/fullmag-runner/src/solvers/fem/mfem/common/abi.rs` plus CPU/GPU lane adapters |
| `crates/fullmag-engine/src/fdm/*` | `crates/fullmag-engine/src/solvers/fdm/*` |
| `crates/fullmag-engine/src/fem*.rs` | validation/reference helpers under `crates/fullmag-engine/src/solvers/fem/*`; not a production lane |
| legacy FDM compiled backend path | `backends/solvers/fdm/cuda/*` |
| legacy FEM compiled backend path | `backends/solvers/fem/mfem/{common,cpu,gpu}/*` |
| `crates/fullmag-fdm-sys/*` | `crates/fullmag-fdm-sys/*` remains the sys crate, but binds to `backends/solvers/fdm/cuda/abi/*` |
| `crates/fullmag-fem-sys/*` | `crates/fullmag-fem-sys/*` remains the sys crate, but binds to `backends/solvers/fem/mfem/abi/*` |

The word "legacy" here does not mean broken. It means "not the target
navigation model". New code should target `solver_runtime`, `solvers`, and
`backends/solvers`.

## 7. Monolith elimination plan

`crates/fullmag-runner/src/dispatch.rs` currently owns too many concerns:

- environment parsing and CPU/GPU engine selection,
- FDM and FEM execution routing,
- FEM preview routing,
- artifact writing,
- FEM/MFEM availability and fallback handling,
- runtime registry/backend metadata,
- stage, relaxation, hysteresis, eigen, and frequency-domain routing,
- cross-cutting provenance decisions.

Target ownership:

| Target module | Responsibility |
|---|---|
| `crates/fullmag-runner/src/solver_runtime/engine.rs` | backend-neutral engine IDs and requested/resolved execution records |
| `crates/fullmag-runner/src/solver_runtime/selection.rs` | parsing env/user hints and selecting FDM/FEM CPU/GPU lanes |
| `crates/fullmag-runner/src/solver_runtime/availability.rs` | FDM CUDA and FEM MFEM CPU/GPU availability records |
| `crates/fullmag-runner/src/solver_runtime/registry.rs` | managed runtime discovery and freshness |
| `crates/fullmag-runner/src/solvers/fdm/execute.rs` | FDM execution facade after lane selection |
| `crates/fullmag-runner/src/solvers/fdm/preview.rs` | FDM preview/export concerns |
| `crates/fullmag-runner/src/solvers/fdm/artifacts.rs` | FDM-specific artifact persistence |
| `crates/fullmag-runner/src/solvers/fdm/interactions/*` | FDM interaction contracts, energies, observables, and validation fixtures |
| `crates/fullmag-runner/src/solvers/fdm/workflows/time_domain/*` | FDM time-domain scheduling and output workflow |
| `crates/fullmag-runner/src/solvers/fdm/workflows/relaxation/*` | FDM energy/torque relaxation workflow |
| `crates/fullmag-runner/src/solvers/fdm/workflows/hysteresis/*` | FDM field-sweep and loop-state workflow |
| `crates/fullmag-runner/src/solvers/fdm/workflows/frequency_domain/*` | FDM linear-response/frequency-domain workflow |
| `crates/fullmag-runner/src/solvers/fem/plan.rs` | FEM execution-plan normalization before MFEM calls |
| `crates/fullmag-runner/src/solvers/fem/pbc.rs` | FEM periodic/PBC preprocessing and capability rejection |
| `crates/fullmag-runner/src/solvers/fem/execute.rs` | FEM workflow facade after lane selection |
| `crates/fullmag-runner/src/solvers/fem/preview.rs` | FEM preview/export concerns |
| `crates/fullmag-runner/src/solvers/fem/artifacts.rs` | FEM-specific artifact persistence |
| `crates/fullmag-runner/src/solvers/fem/workflows/time_domain/*` | FEM time-domain scheduling and output workflow |
| `crates/fullmag-runner/src/solvers/fem/workflows/relaxation/*` | FEM energy/torque relaxation workflow |
| `crates/fullmag-runner/src/solvers/fem/workflows/hysteresis/*` | FEM field-sweep and loop-state workflow |
| `crates/fullmag-runner/src/solvers/fem/workflows/eigen/*` | FEM dynamic-matrix/eigenmode workflow |
| `crates/fullmag-runner/src/solvers/fem/workflows/frequency_domain/*` | FEM linear-response/frequency-domain workflow |
| `crates/fullmag-runner/src/solvers/fem/mfem/common/abi.rs` | Fullmag-to-MFEM descriptors and ABI translation |
| `crates/fullmag-runner/src/solvers/fem/mfem/common/interactions/*` | MFEM interaction weak forms, coefficients, energies, and validation fixtures |
| `crates/fullmag-runner/src/solvers/fem/mfem/common/interactions/demag/model.rs` | requested/resolved FEM demag strategy vocabulary |
| `crates/fullmag-runner/src/solvers/fem/mfem/common/interactions/demag/mesh_requirements.rs` | airbox/body-only/PBC mesh requirements and planner rejection reasons |
| `crates/fullmag-runner/src/solvers/fem/mfem/common/interactions/demag/poisson_airbox/*` | airbox Dirichlet/Robin/PBC weak forms, boundary variants, and solver policy contract |
| `crates/fullmag-runner/src/solvers/fem/mfem/common/interactions/demag/fem_bem/*` | body-only open-boundary FEM/BEM and Fredkin-Koehler contract |
| `crates/fullmag-runner/src/solvers/fem/mfem/cpu/demag/poisson_airbox/*` | CPU MFEM/hypre Poisson airbox RHS, solve, recovery, energy, warm-start |
| `crates/fullmag-runner/src/solvers/fem/mfem/cpu/demag/pbc_reduced_poisson/*` | CPU reduced periodic Poisson solve and recovery |
| `crates/fullmag-runner/src/solvers/fem/mfem/cpu/demag/fem_bem/*` | CPU dense/compressed FEM/BEM reference and production boundary-operator path |
| `crates/fullmag-runner/src/solvers/fem/mfem/gpu/demag/poisson_airbox/*` | strict device-resident MFEM/hypre Poisson airbox realization |
| `crates/fullmag-runner/src/solvers/fem/mfem/gpu/demag/hybrid_cpu_poisson/*` | explicit debug/compatibility CPU round-trip path, never silent fallback |
| `crates/fullmag-runner/src/solvers/fem/mfem/gpu/demag/fem_bem/*` | future GPU boundary-operator application/compression path |

`dispatch.rs` should shrink to a temporary compatibility facade, then disappear
or become a small public routing shim. The extraction is not complete until the
directory for each interaction and workflow exists and owns at least its
contract, validation plan, and execution adapter. Any remaining function over
250 lines in the target solver tree needs an explicit reason and an extraction
task.

## 8. Shared contracts

All four lanes must agree on:

- SI units and symbols from `docs/physics/units.md`;
- public quantity IDs and artifact names from backend quantity contracts;
- energy, effective-field, and torque sign conventions;
- material parameter interpretation and normalization policy;
- requested-vs-resolved backend provenance;
- capability rejection semantics;
- deterministic seed behavior where stochastic terms are enabled;
- validation tolerances and benchmark metadata.

They may differ in:

- discretization error model;
- mesh/grid representation;
- memory layout;
- FFT/Poisson/demag implementation;
- sparse/dense/operator representation;
- CPU/GPU residency;
- performance telemetry details;
- allowed precision tiers, as long as precision is explicit and qualified.

## 9. Forbidden coupling

These are architecture violations:

- FDM execution calling FEM execution internals to finish a solve.
- FEM execution calling FDM execution internals to finish a solve.
- GPU lanes silently using CPU hot-loop stages for forced GPU requests.
- CPU lanes depending on live CUDA availability.
- Cross-lane state transfer without an explicit adapter, provenance, and
  validation note.
- Duplicating equations per lane without a shared physics contract.
- Treating FEM demag as a single Poisson implementation when the requested
  model requires body-only FEM/BEM, FMM, PBC reduction, or mapped exterior
  semantics.
- Allocating a volumetric airbox for a body-only FEM/BEM/FMM demag request.
- Treating `hybrid_cpu_poisson` as an allowed fallback for strict FEM GPU demag.
- Adding a new operator as another branch in `dispatch.rs`, `Context`, or
  `mfem_bridge.cpp`.
- Exposing backend-only toggles as normal user semantics.

## 10. Cross-lane transfer

FDM-to-FEM and FEM-to-FDM movement is a state-transfer operation, not a hybrid
solver. The transfer contract must define:

- source lane and target lane;
- source discretization and target discretization;
- interpolation/projection method;
- normalization policy;
- units and component order;
- provenance fields;
- validation fixture and tolerance.

After transfer, the target solver recomputes its own fields and observables.
For example, an FEM-to-FDM transferred magnetization does not mean the FDM lane
inherits FEM demag, FEM mesh state, or FEM boundary conditions.

## 11. Runtime selection contract

Selection belongs in a runtime-selection module, not inside solver loops.

Current environment surfaces include:

| Variable | Meaning |
|---|---|
| `FULLMAG_FDM_EXECUTION` | FDM lane preference, for example CPU/reference vs CUDA/auto |
| `FULLMAG_FEM_EXECUTION` | FEM lane preference, for example CPU/GPU/all-in-GPU/auto |
| `FULLMAG_FEM_ALL_IN_GPU` | strict device-resident FEM mode request |
| `FULLMAG_FEM_MFEM_DEVICE` | MFEM device/runtime override |
| GPU index/visibility variables | selected CUDA device and host runtime visibility |

Rules:

1. Requested engine ID and resolved engine ID must both be stored.
2. Strict GPU modes must fail when GPU prerequisites are absent.
3. Non-forced `auto` modes may fallback only through documented policy.
4. Fallback reason must be visible in provenance.
5. FEM CPU availability and FEM GPU availability are independent facts.
6. FDM CPU availability and FDM GPU availability are independent facts.
7. Runtime selection must not change physics legality. Capability checks remain
   planner/domain decisions.

## 12. Verification matrix

The verification target is convergence of contracts, not accidental bit identity
across unrelated discretizations.

| Check | FDM CPU | FDM GPU | FEM CPU | FEM GPU |
|---|---:|---:|---:|---:|
| Unit/quantity contract | required | required | required | required |
| Operator sign and energy-field derivative | required | required | required | required |
| CPU-vs-GPU parity inside same discretization | baseline | compare to FDM CPU | baseline | compare to FEM CPU |
| Cross-discretization comparison | compare only where physically meaningful | compare only where physically meaningful | compare only where physically meaningful | compare only where physically meaningful |
| Runtime availability selection | local tests | local + CUDA runtime proof | local + MFEM runtime proof | local + CUDA/MFEM runtime proof |
| Provenance and fallback | required | required | required | required |
| Artifact/resource compatibility | required | required | required | required |

Recommended gates:

- Rust contract tests: `cargo test -p fullmag-runner` and
  `cargo test -p fullmag-engine`.
- Compiled backend source/layout/contract tests: CTest from the current CMake
  backend build tree.
- FEM GPU live proof: `scripts/verify_fem_gpu_enablement.sh` or the managed
  runtime path produced by `just ensure-managed-fem-runtime`.
- Control-room smoke: only for API/resource/visual workflow validation; it is
  not solver-correctness proof.

The current CMake backend build tree is a validation artifact only. Generated
or historical build trees must not be documented as source ownership.

## 13. Production physics validation program

The architecture is not production-ready until it can repeatedly prove the
physics. Source layout, ABI tests, smoke runs, and GPU visibility are necessary
but insufficient. Production promotion requires automated physics validation
against standard micromagnetic problems, analytical cases, and cross-lane
convergence studies.

### 13.1 Validation sources

Fullmag must use primary, versioned validation sources:

| Source | Role |
|---|---|
| NIST/µMAG standard problems | public micromagnetic standard-problem suite; use official problem statements, submitted solution tables, and strategy notes as primary references |
| OOMMF | NIST reference implementation and FDM-compatible reference runner for selected standard problems |
| Analytical benchmarks | exact or asymptotic checks for simple geometries, fields, energies, and dynamics |
| Cross-lane Fullmag comparisons | FDM CPU vs FDM GPU and FEM CPU vs FEM GPU parity within one discretization family |
| External solver comparisons | secondary, version-locked comparisons against tools such as mumax/mumax+, Boris, COMSOL, TetraX, or MagTense when the physical model and discretization assumptions match |

External solvers are comparison evidence, not the source of truth. If OOMMF,
mumax, COMSOL, and Fullmag disagree, the next action is to inspect problem
definition, units, boundary conditions, material conventions, discretization,
and convergence before declaring a Fullmag bug or accepting another solver as
truth.

### 13.2 Validation levels

Every production solver lane must climb the same validation ladder:

| Level | Name | Purpose | Required before |
|---|---|---|---|
| L0 | contract sanity | units, quantity IDs, provenance, deterministic fixture loading | any solver result is shown as trusted |
| L1 | operator physics | per-interaction energy, field/torque sign, variational derivative, known limits | an interaction is marked supported |
| L2 | analytical geometry | macrospin, sphere/ellipsoid/prism demag, thin film, disk/nanodot, 1D wall or spin wave where applicable | a lane is marked physically validated for that interaction |
| L3 | NIST/µMAG standard problems | public standard problem reproduction with declared tolerances and convergence evidence | a lane is promoted to production-grade micromagnetics |
| L4 | cross-lane convergence | CPU/GPU parity inside FDM and FEM plus meaningful FDM/FEM comparison where discretizations converge to the same continuum result | a release can claim backend convergence |
| L5 | runtime robustness | runtime, performance, memory, interruption, profiler, artifact, and API resource proof | a lane can be used in long-running production workloads |

No lane may skip L1/L2 just because a larger benchmark appears to pass.

### 13.3 Required benchmark families

The validation suite must include these families before production claims:

| Family | Examples | Required observables |
|---|---|---|
| Macrospin | uniform Zeeman precession, damping to field, anisotropy minima | `m(t)`, energy monotonicity where expected, analytical frequency/decay |
| Exchange | sinusoidal magnetization, spin wave, 1D wall profile | exchange energy, exchange field, convergence order |
| Demag | uniformly magnetized sphere, ellipsoid, rectangular prism, thin film | demag field, demag energy, boundary/airbox convergence, body-only open-boundary comparison |
| FEM demag model family | Poisson airbox Dirichlet/Robin, airbox PBC reduction, FEM/BEM Fredkin-Koehler, future BEM/FMM | requested/resolved model, mesh requirement, boundary variant, solver policy, `H_demag`, `E_demag`, cross-model convergence |
| Anisotropy | uniaxial and cubic known minima, rotated axes | anisotropy energy, field derivative, axis normalization |
| Zeeman | constant and time-dependent fields | Zeeman energy sign, envelope timing, averaged magnetization |
| DMI | 1D spiral pitch, chirality, boundary tilt, interfacial/bulk convention | DMI energy, DMI field/torque, unit convention, chirality |
| Standard problems | NIST/µMAG problems #1-#5 where supported by the lane | requested problem outputs, convergence tables, final states or time traces |
| Device parity | small deterministic fixtures on CPU and GPU | per-interaction energies, total energy, fields, averages, provenance |

For geometries such as disks and nanodots, total energy alone is not enough.
The fixture must record at least total energy, exchange energy, demag energy,
Zeeman energy when present, anisotropy energy when present, DMI energy when
present, average magnetization, final state hash/checksum, mesh/grid resolution,
and solver/provenance metadata.

### 13.4 Harness and artifact ownership

Target ownership for the automated physics suite:

```text
docs/physics/validation/
  benchmark-family specs, references, tolerances, and acceptance rationale

tests/physics/
  small deterministic fixtures suitable for CI and local pre-merge checks

scripts/validation/
  slower standard-problem and convergence-study runners

validation/baselines/
  JSON/CSV baseline manifests, checksums, references, and tolerance metadata
```

Baseline artifacts must be reproducible and reviewable:

- small scalar baselines may live in Git as JSON/CSV;
- large field/state outputs should use checksum manifests and a documented
  artifact location instead of unreviewable binary churn;
- every baseline must record Fullmag commit, lane, runtime versions, compiler
  flags, GPU model where relevant, mesh/grid resolution, solver tolerances,
  physical constants, and source reference;
- baseline updates require a short physics rationale, not just regenerated
  numbers.

### 13.5 Tolerances and convergence

Validation tolerances must be owned by the benchmark specification, not buried
in test code. Each benchmark must state:

- absolute and relative tolerances for scalar energies and averages;
- vector-field or time-series comparison metric;
- expected convergence order with grid or mesh refinement;
- which differences are discretization error, solver tolerance, or runtime
  precision;
- whether single precision is informational, qualified, or production-grade;
- whether FEM and FDM should match directly or only after continuum/refinement
  extrapolation.

FDM/FEM comparisons are valid only when the physical problem, geometry,
boundary conditions, material fields, and observables are actually the same.
Otherwise the suite must report "not comparable" rather than forcing a false
parity target.

FEM demag validation must also compare numerical realizations inside the FEM
family. Poisson airbox runs must include airbox-size and boundary-variant
convergence; body-only FEM/BEM or FMM runs must include closed-boundary
topology checks, boundary-operator sanity checks, and comparison against the
converged airbox limit on the same magnetic body. Periodic reduced Poisson is a
separate validation target and must report periodic axes, seam handling, gauge
policy, and open-axis boundary policy.

### 13.6 Promotion gate

A solver lane is production-ready only when its validation report can answer:

1. Which interactions are physically supported?
2. Which standard problems pass, with what tolerances?
3. Which analytical benchmarks pass, with what convergence behavior?
4. Which CPU/GPU parity checks pass inside the same discretization family?
5. Which FDM/FEM comparisons are meaningful and which are explicitly not
   comparable?
6. Which observables are validated: total energy, per-interaction energies,
   energy densities, fields, torques, average magnetization, time traces,
   final states, and artifacts?
7. Which runtime modes are validated: CPU, GPU, strict GPU, fallback, precision,
   and managed runtime bundle?

The answer must be generated by automation, not assembled manually from logs.

## 14. Documentation hierarchy

This document governs backend structure. Lower-level documents keep their
specialized authority:

| Document | Role under this masterplan |
|---|---|
| `docs/adr/0014-mfem-backend-modularization.md` | FEM/MFEM backend modularization decision |
| `docs/specs/mfem-backend-architecture-v1.md` | target architecture for the MFEM/hypre/libCEED integration layer |
| `docs/physics/0900-mfem-operator-contracts-and-validation.md` | FEM/MFEM operator contract standard |
| `docs/physics/0560-all-in-gpu-fem-runtime.md` | strict FEM GPU residency contract |
| `docs/physics/0816-mfem-cpu-availability-contract.md` | FEM CPU availability split from GPU availability |
| `docs/physics/0532-fem-fdm-magnetization-state-transfer.md` | cross-discretization state transfer semantics |
| `docs/physics/units.md` | shared solver units contract |
| `docs/physics/validation/*` | target location for production physics benchmark specs and tolerances |
| `AGENTS.md` | should link here and retain only concise operational rules |
| skills | should encode lane boundaries and verification gates, not duplicate stale architecture |

When these documents conflict, update the lower-level document or write a new
ADR that explicitly supersedes this masterplan section.

Historical FEM document names that imply an in-house FEM stack must be renamed
or superseded with the MFEM/hypre/libCEED target document names above during
Phase 5.

## 15. AGENTS and skills update plan

After this document is accepted:

1. Replace scattered backend doctrine in `AGENTS.md` with a short pointer to
   this file and a small list of non-negotiable operational rules.
2. Keep `AGENTS.md` focused on commands, local workflow, and high-risk project
   constraints.
3. Create or update a Fullmag backend skill that says:
   - identify the lane before editing;
   - keep FDM/FEM and CPU/GPU separate;
   - update physics docs before adding compiled-backend operators;
   - run lane-specific verification;
   - distinguish contract tests, runtime smoke, and production physics
     validation;
   - require NIST/µMAG and analytical benchmark coverage before production
     physics claims;
   - do not add solver logic to `dispatch.rs`, `Context`, or
     `mfem_bridge.cpp`.
4. Update architecture docs and ADR indexes so this document is discoverable.
5. Add source-layout contract tests only where the layout itself is now a
   maintained boundary.

## 16. Refactor roadmap

### Phase 0: Freeze new monolith growth

- No new solver behavior goes into `dispatch.rs`.
- No new physics behavior goes into the FEM/MFEM compatibility `Context` or
  `mfem_bridge.cpp`.
- Any unavoidable compatibility code must name its target owner.

### Phase 1: Extract runtime selection

- Create `crates/fullmag-runner/src/solver_runtime/*`.
- Move FDM/FEM requested/resolved engine enums and env parsing out of
  `dispatch.rs`.
- Add focused tests for forced GPU failure, auto fallback, and independent
  FEM CPU/GPU availability.

### Phase 2: Extract FDM execution ownership

- Move FDM execution routing to `crates/fullmag-runner/src/solvers/fdm/execute.rs`.
- Move FDM preview concerns to `crates/fullmag-runner/src/solvers/fdm/preview.rs`.
- Create `crates/fullmag-runner/src/solvers/fdm/interactions/*` directories
  before moving interaction logic.
- Create `crates/fullmag-runner/src/solvers/fdm/workflows/{time_domain,relaxation,hysteresis,frequency_domain}/*`.
- Keep FDM CPU and FDM GPU lane code separate below the facade.

### Phase 3: Extract FEM execution ownership

- Move FEM plan normalization to `crates/fullmag-runner/src/solvers/fem/plan.rs`.
- Move FEM PBC/capability preprocessing to `crates/fullmag-runner/src/solvers/fem/pbc.rs`.
- Move FEM time-domain execution to `crates/fullmag-runner/src/solvers/fem/workflows/time_domain/*`.
- Move FEM relaxation execution to `crates/fullmag-runner/src/solvers/fem/workflows/relaxation/*`.
- Move FEM hysteresis execution to `crates/fullmag-runner/src/solvers/fem/workflows/hysteresis/*`.
- Move FEM eigen execution to `crates/fullmag-runner/src/solvers/fem/workflows/eigen/*`.
- Move FEM frequency-domain execution to `crates/fullmag-runner/src/solvers/fem/workflows/frequency_domain/*`.
- Keep `crates/fullmag-runner/src/solvers/fem/execute.rs` as a thin workflow
  facade only.
- Move FEM preview concerns to `crates/fullmag-runner/src/solvers/fem/preview.rs`.

### Phase 4: Align FEM/MFEM layout

- Continue shrinking the FEM/MFEM compatibility `Context` toward a facade.
- Move MFEM CPU implementation details under `mfem/cpu/*`.
- Move MFEM GPU/CUDA, libCEED CUDA, hypre-device, transfer audit, and residency
  details under `mfem/gpu/*`.
- Keep shared MFEM descriptors, mesh import, FE-space contracts, material
  import, fields, observables, and validation under `mfem/common/*`.
- Split FEM demag into explicit strategy directories:
  `poisson_airbox`, `pbc_reduced_poisson`, `fem_bem`, `fmm`, and
  `mapped_exterior_shell` where applicable.
- Keep demag model selection, mesh requirements, boundary variants, solver
  policy, and provenance in `mfem/common/interactions/demag/*`.
- Keep CPU Poisson/BEM solvers under `mfem/cpu/demag/*` and strict GPU Poisson
  or future GPU BEM realizations under `mfem/gpu/demag/*`.
- Require planner errors when an airbox strategy receives a body-only mesh or a
  body-only FEM/BEM/FMM strategy receives only an airbox-specific topology.
- Do not introduce a custom non-MFEM FEM assembly or solver subtree.
- Require operator contract tests before moving production responsibility.

### Phase 5: Align docs and agent instructions

- Update `AGENTS.md`.
- Update or create backend skills.
- Add backlinks from FEM-only architecture docs to this masterplan.
- Rename or supersede FEM documents that still use historical standalone-FEM
  naming so the accepted architecture consistently says MFEM/hypre/libCEED.
- Remove stale instructions that describe `dispatch.rs` as a normal extension
  point.

### Phase 6: Automate production physics validation

- Create `docs/physics/validation/` benchmark specs for the first production
  benchmark families.
- Add small deterministic fixtures under `tests/physics/`.
- Add slower NIST/µMAG and convergence runners under `scripts/validation/`.
- Add baseline manifests under `validation/baselines/`.
- Generate a machine-readable validation report per lane.
- Make production solver claims depend on those reports, not on smoke logs.

## 17. Completion definition

This masterplan is operationally complete when:

- every backend change can identify one of the four solver lanes before editing;
- lane-specific runtime selection and provenance are outside `dispatch.rs`;
- FDM CPU/GPU and FEM CPU/GPU verification gates are documented and runnable;
- production physics validation covers NIST/µMAG standard problems where
  applicable, analytical benchmarks, total and per-interaction energies,
  convergence studies, and machine-readable validation reports;
- the FEM/MFEM compatibility `Context` and `mfem_bridge.cpp` no longer own
  cross-cutting physics/runtime concerns;
- every interaction and workflow listed in Section 5 has a discoverable owner
  directory with a contract, execution adapter, observables/outputs, and
  validation fixture plan;
- every FEM demag strategy listed in Section 5.3 has explicit mesh
  requirements, requested/resolved provenance, capability status, runtime
  realization ownership, and validation target;
- accepted target docs and agent instructions use MFEM/hypre/libCEED naming
  rather than historical standalone-FEM wording;
- `AGENTS.md` and backend skills point to this document instead of carrying
  divergent backend doctrine;
- API-visible backend changes continue through generated OpenAPI and handwritten
  client/resource checks.
