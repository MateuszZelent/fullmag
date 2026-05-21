# Magnetoelastic Frequency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build a staged, verifiable path from first-class frequency-response semantics to scalable magnetic frequency-domain solvers and then coupled magnetoelastic mechanics.

**Architecture:** Keep public semantics above execution backends. Move solver work through operator families, planner capability checks, runtime capability payloads, and artifact contracts before advertising execution. Preserve existing FDM/FEM lanes while rejecting semantic-only requests explicitly.

**Tech Stack:** Rust IR/planner/runner/API crates, Python `fullmag` authoring model, native FEM/MFEM/libCEED/hypre, future PETSc/SLEPc for scalable eigen solves, v2 frequency-domain artifacts, Control Room Analyze UI resources.

---

## Phase Map

| Phase | Scope | Capability movement |
|---|---|---|
| 1 | Contracts and IR | `StudyIR::FrequencyResponse` is first-class but semantic-only |
| 2 | Scalable magnetic eigen backend | magnetic-only eigen can move beyond dense reference after SLEPc/PETSc gates |
| 3 | Driven magnetic-only frequency response | `supports_frequency_response` may become true only for validated lanes |
| 4 | Quasistatic bidirectional magnetoelasticity | `supports_coupled_magnetoelastic_quasistatic` may become true only after mechanics gates |
| 5 | Elastodynamic frequency response | `supports_frequency_domain_elastodynamics` remains false until harmonic mechanics exists |
| 6 | Coupled eigenmodes | `supports_coupled_eigenmodes` remains false until coupled magnon-phonon operators and branch tracking pass |

## Files And Responsibilities

- `crates/fullmag-ir/src/frequency_response_contract.rs`: response excitation, sweep, response observable, and response study field contracts.
- `crates/fullmag-ir/src/study.rs`: public study variants and study-level data structures.
- `crates/fullmag-ir/src/lib.rs`: semantic validation for study payloads.
- `crates/fullmag-plan/src/lib.rs`: public planner routing and semantic-only rejection.
- `crates/fullmag-runner/src/capabilities.rs`: runtime capability flags exposed by engine id.
- `packages/fullmag-py/src/fullmag/model/study.py`: Python authoring objects and validation.
- `packages/fullmag-py/src/fullmag/model/outputs.py`: response output helper `fm.SaveResponse` and output serialization.
- `packages/fullmag-py/src/fullmag/world.py`: flat helpers `fm.save_response`, `fm.frequency_response`, and declarative frequency-response stages.
- `packages/fullmag-py/src/fullmag/__init__.py`: top-level exports for response helpers.
- `packages/fullmag-py/src/fullmag/__init__.py`, `packages/fullmag-py/src/fullmag/model/__init__.py`: public Python API exports for response outputs.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py`: generated runtime stage serialization.
- `docs/specs/frequency-domain-artifacts-v2.md`: artifact compatibility for eigen/response output.
- `docs/specs/fullmag_magnetoelastic_frequency_patch_specs.md`: patch-level contract for this roadmap.
- `docs/physics/frequency_domain_solver_physics.md`: physics contract for linearized LLG, mechanics, and coupling.
- `docs/engineering/frequency_domain_solver_engineering.md`: backend, CLI, UI, ABI, and benchmark work plan.

## Task 1: Lock First-Class FrequencyResponse Semantics

**Files:**
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Modify: `crates/fullmag-ir/src/validation.rs`
- Modify: `crates/fullmag-ir/tests/ir_tests.rs`
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/model/problem.py`
- Modify: `packages/fullmag-py/src/fullmag/model/outputs.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/__init__.py`
- Modify: `packages/fullmag-py/tests/test_api.py`

- [x] Add or verify `StudyIR::FrequencyResponse` as a top-level `StudyIR` variant with explicit excitation, sweep, normalization, damping, spin-wave boundary, optional `k_sampling`, equilibrium artifact, and sampling fields.
- [x] Validate finite positive frequencies, finite excitation vectors, non-empty equilibrium artifact paths, response-compatible outputs, and reject `fm.SaveResponse` for `Eigenmodes`.
- [x] Add or verify Python `FrequencyResponse` authoring validation mirrors Rust validation and emits `frequency_response_output` through `fm.SaveResponse`; flat helpers preserve the same contract through `fm.save_response(...)` and `fm.frequency_response(...)`.
- [x] Run `cargo test -p fullmag-ir frequency_response_round_trips_as_first_class_study` and expect pass.
- [x] Run `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k frequency_response` and expect pass.

## Task 2: Keep Semantic-Only Execution Rejection Explicit

**Files:**
- Modify: `crates/fullmag-plan/src/lib.rs`
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/validate.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Modify: `crates/fullmag-cli/src/step_utils.rs`
- Modify: `packages/fullmag-py/src/fullmag/runtime/cli.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`

- [x] Route `StudyIR::FrequencyResponse` through validation and metadata as a legal semantic study.
- [x] Reject FDM/FEM execution with a diagnostic that says driven frequency-domain execution is not implemented.
- [x] Treat runtime duration as zero for script helpers because the study is not a time integration.
- [x] Ensure stage export emits `frequency_response` rather than disguising the study as eigenmodes or time evolution, including canonical script rewrite/reload coverage.
- [x] Run `cargo test -p fullmag-plan frequency_response_is_first_class_ir_but_not_executable_yet` and expect pass.
- [x] Run `cargo check -p fullmag-cli` and expect pass.

## Task 3: Expose Deferred Runtime Capability Bits

**Files:**
- Modify: `crates/fullmag-runner/src/capabilities.rs`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`

- [x] Add five booleans to `BackendCapabilities`: `supports_frequency_response`, `supports_coupled_magnetoelastic_quasistatic`, `supports_coupled_magnetoelastic_elastodynamic`, `supports_frequency_domain_elastodynamics`, and `supports_coupled_eigenmodes`.
- [x] Set all five to false for FDM CPU, FDM CUDA, FEM CPU native, FEM native GPU, FEM eigen CPU, and FEM eigen GPU capability payloads.
- [x] Add a unit test that iterates all current capability constructors and asserts all five flags are false.
- [x] Document the same deferred flags in the capability matrix Markdown and JSON.
- [x] Run `cargo test -p fullmag-runner capabilities`, `cargo check -p fullmag-api`, and `python3 -m json.tool docs/specs/capability-matrix-v0.json`.

## Task 4: Scalable Magnetic-Only Eigen Backend

- [x] Keep dense CPU reference eigen as a validation lane and record its problem-size limits in docs.
- [x] Introduce an assembled tangent-plane magnetic operator family binding surface that can be bound to PETSc/SLEPc on CPU; current implementation exposes the scalar-projected assembled generalized operator while PETSc/SLEPc execution remains deferred.
- [x] Preserve `spectrum.v2.json`, `branches.v2.json`, `dispersion.csv`, and mode JSON compatibility, including single-k `DispersionCurve` requests.
- [x] Add an exchange-only reciprocal dispersion gate where `f(k) = f(-k)` when DMI and other nonreciprocal terms are disabled.
- [x] Add exported-mode diagnostics for tangent leakage and residual norms.
- [ ] Do not promote any scalable eigen capability until native build, native tests, and artifact reader tests pass.

## Task 5: Driven Magnetic-Only Frequency Response

- [ ] Implement a block-real harmonic magnetic solve for tangent-plane perturbations.
  - [x] Land the first dense runner primitive for `K - omega^2 M + i omega C` as a block-real `2N x 2N` solve with complex excitation/response, dimension validation, and residual norms. This is intentionally not wired to `StudyIR::FrequencyResponse`, sweep artifacts, or capability promotion yet.
- [ ] Support field excitation first; bind antenna/current-source excitation only after source artifacts are validated.
  - [x] Add a field-driven sweep wrapper over the dense block-real primitive; antenna/current-source excitation remains unbound.
  - [x] Reject empty sweeps, non-positive/non-finite frequencies, and non-finite complex excitations before producing response diagnostics.
- [ ] Export amplitude, phase, absorbed power density, susceptibility diagnostics, and residual per frequency.
  - [x] Produce amplitude, phase, field-work absorbed-power diagnostic, scalar susceptibility, and residual norms per frequency in the runner primitive result model.
  - [x] Build and write an artifact-ready `response/magnetic_response_sweep.v1.json` payload for dense field-driven validation, including schema version, SI units, backend engine id, solver model, damping policy, lane classification, Hz/rad-s frequency metadata, response vectors, susceptibility tensor, absorbed-power diagnostic, residuals, excitation provenance, sweep reuse, and explicit tangent-leakage diagnostic status. Runtime integration remains pending.
  - [x] Expose the optional response sweep artifact through `GET /v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1`, preserving diagnostic 404 behavior when `response/magnetic_response_sweep.v1.json` is absent; generated `apps/control-room` OpenAPI/types/path literals, the `ControlRoomApi.analysis.frequencyResponse.magneticSweepV1()` facade, and the optional `useMagneticResponseSweepResource()` hook are synchronized.
- [ ] Reuse solver state across frequency sweep points and expose warm-start provenance.
  - [x] Carry previous-frequency response provenance through the dense field-driven sweep, including warm-start source frequency and residual quality for the candidate state; reusable preconditioner/factorization state remains pending for the scalable backend.
- [ ] Keep `supports_frequency_response=false` until at least one backend lane passes residual, artifact, and smoke gates.

## Task 6: Quasistatic Bidirectional Magnetoelasticity

- [ ] Implement small-strain elasticity with explicit boundary conditions and load cases.
- [ ] Add same-mesh transfer for the first executable slice; reject `Omega_m != Omega_s` until transfer operators exist.
- [ ] Assemble stiffness once, reuse solver/preconditioner state, refresh only the RHS, and warm-start displacement.
- [ ] Export `u`, `eps`, `sigma`, `E_el`, `E_mel`, and mechanics residuals.
- [ ] Keep `supports_coupled_magnetoelastic_quasistatic=false` until patch tests, rigid-body constraints, and energy derivative gates pass.

## Task 7: Elastodynamic And Coupled Frequency-Domain Mechanics

- [ ] Implement harmonic mechanics `A_u(omega)` with damping policy and boundary-condition validation.
- [ ] Couple magnetic and mechanical blocks only after both independent blocks pass validation.
- [ ] Add block preconditioner and persistent sweep context before enabling production-sized sweeps.
- [ ] Keep `supports_frequency_domain_elastodynamics=false` until harmonic mechanics response passes residual and benchmark gates.
- [ ] Keep `supports_coupled_eigenmodes=false` until coupled eigen branch tracking and hybridization diagnostics pass.

## Required Verification Commands

```bash
cargo test -p fullmag-ir frequency_response_round_trips_as_first_class_study
cargo test -p fullmag-plan frequency_response_is_first_class_ir_but_not_executable_yet
cargo test -p fullmag-runner capabilities
cargo check -p fullmag-api
cargo check -p fullmag-cli
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k "frequency_response or eigenmodes_serializes_floquet"
python3 -m json.tool docs/specs/capability-matrix-v0.json
```

Native backend gates apply when implementation reaches the relevant phase:

```bash
cmake --build <native-build-dir> --target <native-fem-target>
ctest --test-dir <native-build-dir> -R "fem|frequency|magnetoelastic" --output-on-failure
```

Replace angle-bracket values with the configured native build path and target
from the active developer environment before recording release evidence.

## MR Schedule

| MR | Scope | Main deliverables |
|---|---|---|
| MR-A | IR and capability contracts | first-class semantic frequency response, explicit deferred flags, docs |
| MR-B | Scalable magnetic eigen backend | PETSc/SLEPc CPU lane, v2 artifact compatibility |
| MR-C | Driven magnetic-only frequency response | harmonic solve, sweep residuals, response artifacts |
| MR-D | Mechanics execution core | elasticity operator family, BCs, solver policy, observables |
| MR-E | Quasistatic bidirectional magnetoelasticity | `m -> u -> H_mel`, energy and parity gates |
| MR-F | Elastodynamic harmonic block | `A_u(omega)`, damping, transfer operators |
| MR-G | Coupled magnon-phonon response | block solve, hybrid mode diagnostics |
| MR-H | Frontend Analyze and production baselines | UI resources, benchmark gates, release evidence |

## Production Readiness Criteria

A lane can move from semantic-only to executable only when planner, runner,
artifacts, numerical tests, benchmark records, docs, CLI, API, and UI all name
the same feature and backend lane as executable.
