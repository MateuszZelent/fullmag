# COMSOL-Grade FEM Frequency-Domain Solver Implementation Masterplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` when implementing tasks from this plan. Keep this file updated after each accepted implementation step.

**Goal:** Build a COMSOL-class FEM frequency-domain product in Fullmag: driven harmonic response, modal/eigenfrequency analysis, FMR spectra, dispersion, periodic/Floquet workflows, complex field visualization, and provenance-preserving CPU/GPU runtime gates.

**Architecture:** Frequency-domain is an analysis family, not one solver. Fullmag keeps `FrequencyResponse` as the forced harmonic solver and `Eigenmodes` as the modal/eigenfrequency solver; both share the linearized LLG tangent operator, equilibrium provenance, boundary-condition contracts, artifact family, and Control Room resource model.

**Tech Stack:** Python DSL and canonical script export, `ProblemIR`, FEM planner, Rust runner orchestration, native FEM under `backends/fem` with MFEM/hypre/libCEED/CUDA and PETSc/SLEPc-class modal targets, v2 resource-first API, Control Room Explorer/Inspector/Analysis/Viewport modules, JSON control-plane artifacts, Zarr heavy-data payloads, and container-backed `just` verification recipes.

---

## 0. Status Of This Document

- Created: 2026-06-30.
- Scope: living masterplan and progress ledger for the FEM frequency-domain solver program.
- Location: `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/11-comsol-grade-frequency-domain-masterplan-2026-06-30.md`.
- Update rule: every implementation step that changes capability, backend behavior, artifacts, frontend behavior, verification gates, or user-facing status must update this file in the same change.

Progress percentages below are engineering readiness estimates for the named milestone acceptance gates. They are not marketing claims. A milestone is not production-complete until its exit gates pass through the managed/container-backed `just` recipes where native FEM/MFEM/CUDA/hypre/libCEED runtime behavior is involved.

## 1. Existing Documentation Found And Consolidated

This plan is not a replacement for the existing source-of-truth stack. It is the top-level live index that ties those files together.

### 1.1 Active frequency-domain plan family

- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/README.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/audyt_planu_solvera_fem_domena_czestotliwosci.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/00-source-of-truth-and-consolidation.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/01-backend-native-fem-frequency-domain.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/02-ir-planner-python-capabilities-api.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/03-artifacts-resources-and-runtime.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/04-control-room-explorer-tree.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/05-control-room-inspectors.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/06-analysis-plots-and-3d-mode-visualization.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/07-implementation-stages-and-verification.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/08-periodic-floquet-bloch-boundary-conditions.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/09-control-room-study-stage-inspector-detail-contract.md`
- `docs/plans/active/frequency-domain-fem-masterplan-2026-06-11/10-production-interior-window-eigensolver.md`

### 1.2 Newer active readiness plans

- `docs/plans/active/fmr-k0-pbc-gpu-readiness-plan-2026-06-28-pl.md`
- `docs/plans/active/fullmag_pbc_fem_bloch_airbox_plan.md`

These two files are the current correction layer for PBC, GPU, periodic-airbox, and nonzero-k Floquet status. They must be consulted before promoting any frequency-domain capability.

### 1.3 Physics and specs

- `docs/physics/0700-frequency-domain-linearized-llg.md`
- `docs/physics/0600-fem-eigenmodes-linearized-llg.md`
- `docs/physics/0600-fem-eigenmodes.md`
- `docs/physics/frequency_domain_solver_physics.md`
- `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`
- `docs/physics/0800-fem-static-pbc-demag.md`
- `docs/physics/0828-fem-frequency-domain-floquet-demag.md`
- `docs/specs/frequency-domain-artifacts-v2.md`
- `docs/specs/capability-matrix-v0.md`
- `docs/specs/capability-matrix-v0.json`
- `docs/architecture/backend-golden-masterplan.md`

### 1.4 Reports and historical plans

- `docs/engineering/frequency_domain_solver_engineering.md`
- `docs/plans/fullmag_magnetoelastic_frequency_implementation_plan.md`
- `docs/reports/fullmag_native_fem_magnetoelastic_frequency_audit.md`
- `docs/reports/2026-06-29/frequency-domain-tetrax-tetmag-fullmag-audit.md`
- `docs/plans/active/eigenmodes-v2-implementation-plan-2026-04-04.md`

### 1.5 COMSOL reference

- `docs/comsol/Manual_for_Micromagnetics_Module.pdf`

This PDF is a parity reference for user-facing workflow expectations, not a semantic source that overrides Fullmag physics notes.

Relevant COMSOL-facing requirements extracted for this plan:

- Time-domain micromagnetics and frequency-domain micromagnetics are separate study surfaces.
- Frequency-domain micromagnetics is linearized LLG around equilibrium `m0`.
- Dynamic magnetization `delta_m` is a complex phasor.
- The harmonic factor is supplied by the solver; users specify the dynamic drive amplitude/phase, not a hand-written sinusoid.
- Equilibrium `m0` must be stable and may come from a prior time-domain or relaxation solve.
- `Eigenfrequency` and `Frequency Domain` are separate studies: eigenfrequency returns natural modes/eigenvectors; frequency domain returns forced response at requested drive frequencies.
- Periodic and Floquet periodic boundary conditions are first-class frequency-domain features.
- Floquet uses phase `exp(-i k dot (r_dst - r_src))`, matching Fullmag's `exp_minus_i_k_dot_delta_r` convention.

## 2. Non-Negotiable Product Split

Fullmag uses one analysis family and two solver products:

| Name | Canonical study | Mathematical form | Primary output | Status owner |
|---|---|---|---|---|
| Frequency-domain family | umbrella only | shared linearized tangent LLG contract | manifest, resources, workflow routing | this masterplan and artifact specs |
| Driven response | `FrequencyResponse` | `(i omega B - A) q = b` | response sweep, susceptibility, absorbed power, complex response fields | driven-response milestones |
| Modal/eigenfrequency | `Eigenmodes` | `A q = lambda B q` or equivalent gyrotropic pencil | eigenfrequencies, modes, dispersion, branch tracking | modal milestones |

Rules:

- Do not call `Eigenmodes` the driven frequency-domain solver.
- Do not call response-sweep peaks eigenmodes. They are mode candidates or peak-derived response modes.
- Do not promote modal support based on driven-response artifacts.
- Do not promote driven response based on eigen artifacts.
- Do not present dense/reference or development smoke paths as COMSOL-class production execution.
- Do not promote any new frequency-domain lane until the audit P0 mathematical contract is closed: one `exp(i omega t)` convention, correct gyrotropic/eigenvalue mapping, dynamic demag Poisson sign, `Ms`-correct susceptibility and absorbed-power units, and tangent-frame transport for PBC/Floquet.

## 3. Current Implementation Inventory

### 3.1 Python DSL and canonical script export

Progress: 85%.

Implemented:

- `packages/fullmag-py/src/fullmag/model/study.py` defines `Eigenmodes` and `FrequencyResponse`.
- `packages/fullmag-py/src/fullmag/model/eigen.py` owns `KPoint`, `KPath`, `ModeTracking`, and k-sampling serialization helpers.
- `packages/fullmag-py/src/fullmag/world.py` exposes flat and staged helpers for `eigenmodes` and `frequency_response`.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py` exports and reloads eigen and frequency-response stages, including spin-wave boundary configuration.

Remaining:

- Authoring/UI fields must stay aligned with canonical Python names. Compatibility aliases such as `near_frequency` must remain boundary translations, not backend semantics.
- Public examples must avoid implying unsupported dynamic demag or general Floquet production.
- More end-to-end round-trip tests are needed for frequency-window eigenfrequency, k-path dispersion, and response-map authoring.

### 3.2 ProblemIR and planner

Progress: 74%.

Implemented:

- `crates/fullmag-ir/src/study.rs` and companion contract files represent `Eigenmodes` and `FrequencyResponse`.
- `crates/fullmag-plan/src/fem.rs` plans FEM eigenmodes and current FEM frequency-response slices.
- Planner rejects unsupported FDM response, dynamic demag-k, unsupported Floquet/demag combinations, missing periodic pair metadata, and unsupported GPU slices.
- Capability matrix now distinguishes partial driven-response slices from semantic-only modal interior-window status.

Remaining:

- Frequency-window eigenfrequency authoring is still semantic/public-contract level; production scalable eigensolver completion is pending.
- Capability payloads need to remain synchronized with the newest accepted CPU/GPU Floquet slices.
- Planner messages and UI capability reasons need explicit mapping for every accepted/rejected slice.
- Audit P0 must be reflected in capability reasons: unsupported modal/response lanes should cite missing mathematical contracts where the gyrotropic pencil, dynamic demag derivative, susceptibility/absorbed-power units, or tangent-frame transport are not yet implemented.

### 3.3 Native FEM backend, CPU driven response

Progress: 68%.

Implemented:

- `backends/fem/include/frequency_domain/*` defines frequency-domain contracts, tangent frame, operator terms, excitation, driven-response request, modal request/result, solver progress, and C ABI-facing structures.
- `backends/fem/src/frequency_domain/*` implements shared contract glue, tangent/equilibrium utilities, driven-response solve orchestration, progress JSON, and structured unavailable/error result handling.
- `backends/fem/cpu/frequency_domain/*` contains dense validation response, MFEM operator context, exchange, Zeeman, DMI, tangent-space machinery, production CPU driven response, modal operator payloads, window partitioning, contour interval solver support, mode filtering, and mode deduplication utilities.
- `crates/fullmag-runner/src/frequency_response.rs` builds native payloads, preserves requested/resolved execution, writes response artifacts, and prevents unsupported forced GPU paths from silently falling back.
- CPU `gamma/free` and `k=0 static-periodic` magnetic response slices are partial production executable.
- CPU periodic-airbox dynamic-demag work has a qualified matrix-free driven-response diagnostic slice with bounded `solve_error` artifacts.

Remaining:

- Periodic-airbox `include_demag=true` driven response is not solved to production acceptance yet. Recent evidence shows GMRES near the target tolerance but still failing the strict point.
- The current periodic-airbox path must be described as a qualified driven-response diagnostic slice until solved single-point, stable relaxation, refined spectrum, and supercell acceptance all pass.
- Nonzero-k dynamic demag/Floquet coupled `delta_m/delta_phi` is not implemented.
- CPU dynamic demag must gain a stronger preconditioner/Schur strategy instead of relying on arbitrary iteration-limit increases.

### 3.4 Native FEM backend, GPU driven response

Progress: 52%.

Implemented:

- `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu` implements a CUDA tangent operator for exchange, local precession/mass, Zeeman, uniaxial anisotropy, and damping-style local terms.
- The runner exposes strict GPU request paths without silent CPU/dense validation fallback.
- GPU `gamma/free` no-demag driven response is partial production executable.
- GPU `k=0 static-periodic` no-demag response is partial production executable when periodic pair metadata is complete.
- A narrow nonzero-k Floquet no-demag development smoke exists for explicit GPU, magnetic-body, no-demag/no-DMI requests with complete pair metadata and Bloch-phased tangent drive.
- `just verify-fem-frequency-domain-gpu-floquet-runtime` and related recipes exist as managed runtime gates for current development slices.

Remaining:

- GPU dynamic demag is absent.
- GPU periodic-airbox dynamic demag must explicitly report unavailable and must not silently run CPU.
- GPU DMI in frequency response remains gated for current promoted slices.
- Nonzero-k Floquet GPU path is phase-projected no-demag smoke, not full Bloch-reduced production response.
- Production labels require managed runtime evidence and parity gates, especially against CPU for no-demag static-periodic slices.

### 3.5 Native FEM backend, modal/eigenfrequency

Progress: 34%.

Implemented:

- `backends/fem/include/frequency_domain/modal_eigen_request.hpp` and `modal_eigen_result.hpp` define modal request/result contracts.
- `backends/fem/cpu/frequency_domain/slepc_modal_eigen.*` and tests expose SLEPc/PETSc dependency diagnostics and tiny shift-invert validation behavior when dependencies are available.
- `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`, contour interval, spectral transform, window partition, and mode filtering files exist as the current native modal spine.
- `crates/fullmag-runner/src/eigen/*` writes v2 eigen spectrum, branch, dispersion, mode metadata, and Zarr-backed mode payload artifacts.
- `just verify-fem-frequency-domain-eigen-runtime` verifies the current eigen artifact contract for `examples/fem_eigenmodes.py` and `examples/fem_eigenmodes_frequency_window.py`.

Remaining:

- The production gyrotropic pencil and eigenvalue-to-frequency mapping must be corrected and proven before SLEPc/selected-spectrum promotion.
- COMSOL-class large-object eigenfrequency requires sparse/matrix-free selected-spectrum execution, production residuals, orthogonality, mass normalization, spectral-transform provenance, and live progress.
- Modal dynamic demag and Floquet/PBC eigensolve are not production-complete.
- Dense/reference modal paths must remain validation/reference paths until scalable native modal gates pass.
- UI must keep modal/eigenfrequency labels separate from driven response.

### 3.6 Runtime artifacts and validators

Progress: 76%.

Implemented:

- `docs/specs/frequency-domain-artifacts-v2.md` defines the artifact family.
- Runtime writes or validates:
  - `frequency_domain/manifest.v1.json`
  - `response/magnetic_response_sweep.v1.json`
  - `response/magnetic_response_sweep.v2.json`
  - `response/progress.v1.json`
  - `response/cancel_requested.v1.json` for interrupted/cancelled flows
  - `response/diagnostics/solver.v1.json`
  - `response/frequency_points/frequency_XXXX.json`
  - `response/field_payloads.zarr`
  - `eigen/spectrum.v2.json`
  - `eigen/branches.v2.json`
  - `eigen/dispersion.csv`
  - `eigen/modes/sample_XXXX/mode_YYYY.json`
  - `eigen/mode_fields.zarr`
  - `mesh/periodic_pairs.v1.json`
- `scripts/verify_fem_frequency_domain_runtime_artifacts.py` validates response artifacts, static-periodic diagnostics, Floquet projection diagnostics, GPU unsupported bundles, field payload links, response peaks, and derived peak modes.
- `scripts/verify_fem_frequency_domain_eigen_artifacts.py` validates modal artifact bundles.
- `scripts/verify_fem_frequency_domain_supercell_artifacts.py` compares unit-cell periodic-airbox response artifacts with Gamma-like supercell artifacts.
- `scripts/derive_fem_frequency_response_modes.py` derives a response-peak mode artifact from a completed response sweep.
- `scripts/fem_frequency_response_refinement_env.py` computes refined sweep frequency env values from prior artifacts.

Remaining:

- Periodic-airbox solved bundle must pass the same observability/provenance requirements as bounded solve-error bundles.
- Artifact validators must be kept in lockstep with any schema evolution.
- Zarr remains the production heavy-data direction; raw bin payloads are compatibility only.
- Response and modal artifacts must include the audit-required units/provenance fields for `delta_m` vs `delta_M`, susceptibility, absorbed power, phasor convention, matrix form, and response-derived peak modes.

### 3.7 API and Control Room frontend

Progress: 76%.

Implemented:

- `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs`, `response.rs`, and `frequency_domain.rs` expose v2 analysis routes.
- `apps/control-room/src/kernel/api/apiPaths.ts` and `ControlRoomApi.ts` contain typed route constants and facade methods for eigen and frequency-domain response resources.
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` exposes resource hooks for manifest, eigen spectrum/branches/diagnostics/dispersion/mode/field metadata, response sweep/progress/cancel/diagnostics/frequency point/field metadata.
- `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts` builds a COMSOL-like frequency-domain result tree: calculation modes, FMR, dispersion, eigen, response, comparison, exports, periodic pairs, response fields, and response-map only when artifacts prove it exists.
- `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.tsx` and `frequency-domain/FrequencyDomainResultInspectors.tsx` provide dedicated panels for calculation modes, FMR, modal spectrum, modes, dispersion, branches, response sweep, response points, diagnostics, exports, and periodic pair resources.
- `apps/control-room/src/modules/analysis-plots/*` and `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts` build spectrum, dispersion, branch, response, peak, and modal-vs-driven comparison series.
- `apps/control-room/src/kernel/visualization/AnalysisFieldOverlayController.ts` and `analysisFieldOverlayCommandContributions.ts` support eigen-mode and frequency-response complex field overlays with real, imaginary, absolute, phase, and phase-rotated-real views.

Remaining:

- Browser smoke proof is still required before claiming viewport overlay completion for new visual behavior.
- UI authoring must expose every Python-authorable frequency-domain field through transaction-backed Study inspector controls, not result-only previews.
- Capability labels must distinguish reference, partial production, unsupported, and unavailable backend lanes without hiding no-demag/demag limits.
- Full Control Room gates remain: `pnpm --dir apps/control-room typecheck`, `lint`, `test`, plus browser smoke for viewport overlay changes.

### 3.8 Static PBC equilibrium and demag stabilization

Progress: 45%.

Implemented:

- `docs/physics/0800-fem-static-pbc-demag.md` defines the static/time-domain FEM PBC demag contract for periodic magnetic samples with open airbox direction.
- The active PBC/Bloch plan names the 200 x 200 x 10 nm thin-film antidot unit cell with a centered 50 nm hole as the target magnonic-crystal smoke geometry.
- Periodic magnetic node-pair metadata, frozen magnetic submesh preparation, shared-airbox materialization, and supercell artifact comparison scripts exist.
- Static PBC demag has reference/native evidence for reduced periodic classes, open-axis Robin treatment, periodic-pair diagnostics, and primitive-vs-supercell artifact checks.

Remaining:

- Add an explicit managed gate for static PBC equilibrium of the antidot unit cell before any response or eigenfrequency run consumes the equilibrium.
- Promote equilibrium acceptance by physical checks, not by short smoke completion: torque residual, energy monotonicity or stable descent, `|m|=1`, seam continuity, demag energy sign/convergence, and absence of hidden finite-airbox fallback.
- Compare the PBC unit cell against an explicit 2x2 or 3x3 supercell for average magnetization, demag energy density, `H_demag` statistics, seam mismatch, and central-cell torque residual.
- Publish the accepted equilibrium, static demag diagnostics, periodic-pair summary, airbox/z-padding convergence, and provenance as reusable artifacts for driven response and modal/eigenfrequency stages.

## 4. Milestone Map And Progress

| Milestone | Scope | Current progress | Current status |
|---|---|---:|---|
| M0 | Truth consolidation and live plan governance | 100% | This file created; existing docs indexed; update protocol established. |
| M1 | Product split, physics contract, DSL/IR/API semantic spine | 78% | Core semantics exist; audit P0 math/units corrections are now the next blocking documentation and implementation contract. |
| M2 | Driven response artifact/runtime contract | 76% | Response/eigen artifact families and validators exist; audit-required units, matrix-form, and peak-mode provenance must be propagated. |
| M3 | CPU driven response, free and static-periodic no-demag | 75% | Partial production executable; strict managed gates exist; broader validation still needed. |
| M4 | GPU driven response, free and static-periodic no-demag | 60% | Narrow partial production slices exist; parity and dynamic demag remain open. |
| M5 | Static PBC equilibrium and demag stabilization for magnonic-crystal unit cells | 45% | Static PBC demag contract and supporting scripts exist; accepted antidot equilibrium gate is missing. |
| M6 | Periodic-airbox `k=0` driven response with demag | 48% | CPU Schur/provider diagnostic path and honest artifacts exist; production acceptance still requires M5 equilibrium and solved response gates. |
| M7 | Control Room frequency-domain UX | 76% | Explorer, inspectors, charts, resource hooks, and overlay commands exist; authoring and browser proof incomplete. |
| M8 | COMSOL-class modal/eigenfrequency solver | 34% | Contracts, SLEPc-facing pieces, artifact gates exist; gyrotropic pencil/eigenvalue mapping must be fixed before scalable promotion. |
| M9 | Nonzero-k Floquet no-demag production path | 32% | GPU development smoke and metadata validation exist; full production k-path also requires tangent-frame transport policy. |
| M10 | Dynamic Floquet/PBC demag for response and eigen | 22% | Physics note, request fields, validation, and explicit rejections exist; operator not implemented. |
| M11 | Magnetoelastic and multiphysics frequency domain | 15% | Contracts/docs exist; coupled mechanics and elastodynamics remain deferred. |
| M12 | Release hardening, docs, benchmarks, examples | 35% | Many recipes/tests exist; production release matrix is not closed. |

## 5. Detailed Milestones

### M0 - Truth Consolidation And Live Plan Governance

Progress: 100%.

Delivered:

- Existing docs, active plans, physics notes, specs, reports, and COMSOL reference were located.
- Current backend/frontend implementation was audited from the working tree.
- This masterplan now acts as the progress ledger for ongoing rollout.

Exit gate:

- This file exists and is linked from the active masterplan README.
- Future implementation changes update this file before reporting milestone progress.

### M1 - Product Split And Semantic Spine

Progress: 78%.

Delivered:

- Frequency-domain family split is documented in physics notes and active plans.
- Python DSL exposes `Eigenmodes` and `FrequencyResponse`.
- ProblemIR and planner know the two study products.
- Control Room routes modal and driven resources separately.
- COMSOL parity language is aligned: `Eigenfrequency` maps to modal/eigen, `Frequency Domain` maps to driven harmonic response.

Remaining:

- Close audit P0: one phasor convention, one `L/B_alpha` or equivalent operator vocabulary, correct gyrotropic pencil, corrected dynamic-demag sign, `Ms`-correct observables, and damping/linewidth convention.
- Confirm all user-facing copy avoids collapsing modal and response products.
- Keep `frequency_domain_capabilities.v1` aligned with capability matrix rows.
- Add regression tests around any newly exposed UI calculation mode lowering.

Verification:

```bash
cargo test -p fullmag-ir frequency_response
cargo test -p fullmag-plan frequency_response
PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_api.py -k "frequency_response or eigenmodes"
python3 -m pytest scripts/test_frequency_domain_math_contracts.py -q
```

### M2 - Driven Response Artifact And Runtime Contract

Progress: 76%.

Delivered:

- v1 and v2 response sweep artifacts exist.
- Per-frequency point resources and Zarr-backed field payloads are represented.
- Progress, cancel, diagnostics, manifest, periodic-pair, and derived peak-mode validation is in place.
- Managed recipes check required response files for major runtime slices.

Remaining:

- Add artifact fields and validators for `matrix_form`, `phasor_convention`, observable units, `delta_m`/`delta_M` distinction, `Ms`-correct susceptibility and absorbed power, and response-derived peak mode provenance.
- Solved periodic-airbox runs must publish the same complete artifact bundle as bounded failure runs.
- Validator coverage must reject any `completed` run that lacks response fields, manifest, diagnostics, or progress.
- Schema drift must be reflected in API types, resource hooks, and inspectors.

Verification:

```bash
python3 -m pytest scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q
python3 -m pytest scripts/test_verify_fem_frequency_domain_supercell_artifacts.py -q
just verify-fem-frequency-domain-runtime
just verify-fem-frequency-domain-static-periodic-runtime
```

### M3 - CPU Driven Response, Free And Static-Periodic No-Demag

Progress: 75%.

Delivered:

- Native CPU driven response lane exists for gamma/free and k=0 static-periodic magnetic slices.
- Planner and runner reject missing pair metadata and unsupported combinations.
- Runtime artifacts preserve production CPU lane metadata and static-periodic diagnostics.
- Managed recipes cover free, static-periodic, periodic-airbox, spectrum/refined spectrum, z-padding, and supercell flows.

Remaining:

- Broader geometry validation for periodic-pair generation and mesh quality.
- More analytical and supercell parity fixtures.
- Clear separation between no-demag static-periodic production and periodic-airbox dynamic-demag diagnostic work.

Verification:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-runtime
just verify-fem-frequency-domain-static-periodic-runtime
just verify-fem-frequency-domain-periodic-airbox-supercell-runtime
```

### M4 - GPU Driven Response, Free And Static-Periodic No-Demag

Progress: 60%.

Delivered:

- CUDA tangent operator exists for exchange, local precession/mass, Zeeman, uniaxial anisotropy, and damping terms.
- Forced GPU does not silently fall back to CPU/dense validation.
- GPU free no-demag and static-periodic no-demag response runtime recipes exist.
- GPU Floquet no-demag development smoke can carry phase projection metadata and response artifacts.

Remaining:

- CPU/GPU parity gate for the target antidot and static-periodic no-demag cases.
- Strict qualification of all included terms and precision modes.
- Explicit rejection artifacts for GPU periodic-airbox dynamic demag must remain stable.
- No-demag labels must stay visible in UI/provenance.

Verification:

```bash
just verify-fem-frequency-domain-gpu-free-runtime
just verify-fem-frequency-domain-gpu-static-periodic-runtime
just verify-fem-frequency-domain-gpu-static-periodic-parity-runtime
just verify-fem-frequency-domain-gpu-floquet-runtime
```

### M5 - Static PBC Equilibrium And Demag Stabilization

Progress: 45%.

Objective:

- Establish a physically accepted static state for magnonic-crystal unit cells before any harmonic response or eigenfrequency calculation. The reference target is a thin ferromagnetic film unit cell with a centered hole, lateral PBC, open z airbox, static bias field, and static demag enabled through the PBC-compatible airbox contract.

Delivered:

- Static PBC demag physics and validity limits are documented in `docs/physics/0800-fem-static-pbc-demag.md`.
- The target antidot geometry and periodic-airbox constraints are tracked in `docs/plans/active/fullmag_pbc_fem_bloch_airbox_plan.md`.
- Frozen magnetic submesh and periodic pair preparation are scriptable through `scripts/prepare_fmr_frozen_magnetic_submesh.py`.
- Primitive-vs-supercell comparison has a validator in `scripts/verify_fem_frequency_domain_supercell_artifacts.py`.
- Existing static PBC demag evidence covers reduced periodic classes, periodic-pair diagnostics, open-axis Robin treatment, and primitive/supercell artifact comparison for static demag observables.
- Periodic-antidot relaxation runtime validators now require demag runtime provenance, PBC pair metadata, finite final torque, non-negative final demag energy, magnetic-body norm preservation, and GPU device-Poisson provenance for the GPU gate.

Acceptance gates:

1. The mesh publishes complete magnetic `periodic_node_pairs`, periodic boundary-pair translations, material labels, and airbox/open-axis boundary labels.
2. The resolved magnetostatic model is `periodic_airbox_k0` or the static PBC demag equivalent; the run must not fall back to finite isolated-airbox demag.
3. Relaxation reaches a physical equilibrium by torque residual and stable energy behavior, not merely by a low `max_steps` smoke.
4. Magnetization keeps unit length in the magnetic body and has seam mismatch below the documented PBC tolerance.
5. Static `H_demag`, scalar potential, and demag energy satisfy seam, sign, and z-padding convergence checks.
6. The primitive PBC cell agrees with an explicit 2x2 or 3x3 supercell central-cell extraction for average magnetization, demag energy density, `H_demag` statistics, and torque residual.
7. Accepted artifacts include the equilibrium field, demag diagnostics, periodic-pair summary, z-padding/supercell comparison, solver convergence, and requested/resolved provenance.
8. Control Room can inspect the accepted equilibrium and show PBC/demag diagnostics before the user launches response or eigenfrequency analysis.

Required new managed gate:

```bash
just verify-fem-static-pbc-demag-equilibrium-runtime
```

Existing supporting checks:

```bash
just verify-fem-demag-poisson-contract
just verify-fem-frequency-domain-periodic-airbox-z-padding-runtime
just verify-fem-frequency-domain-periodic-airbox-supercell-runtime
python3 scripts/verify_fem_frequency_domain_supercell_artifacts.py .fullmag/reports/frequency-domain-periodic-airbox-supercell-runtime/artifacts
```

### M6 - Periodic-Airbox `k=0` Driven Response With Demag

Progress: 48%.

Delivered:

- Physics contract distinguishes `periodic_airbox_k0` from future `floquet_airbox`.
- CPU path can materialize a shared airbox mesh and magnetic periodic-pair metadata.
- Runner/native path can emit bounded `solve_error` bundles with manifest, diagnostics, progress, periodic pairs, and provenance.
- Verifier can require periodic-airbox CPU demag solved/attempted artifacts and frozen magnetic submesh metadata.
- The current CPU diagnostic path records the matrix-free MFEM demag phi-consistency Schur/provider provenance for the periodic-airbox response slice.

Current blocker:

- This milestone cannot be promoted before M5 accepts the static PBC equilibrium for the same unit cell. Response/eigen stages must consume a proven equilibrium artifact, not a short relaxation smoke.
- The CPU periodic-airbox response path remains a diagnostic/partial-production slice until non-smoke solved response convergence, refined spectrum, and supercell checks pass under managed `just` gates.

Remaining:

- Consume only M5-accepted equilibrium artifacts for response.
- Improve the preconditioner/Schur model for the coupled demag tangent contribution.
- Produce solved single-point acceptance.
- Produce spectrum/refined spectrum acceptance.
- Produce unit-cell vs supercell acceptance.
- Keep GPU periodic-airbox dynamic demag explicitly unavailable until a validated GPU operator exists.

Verification:

```bash
just verify-fem-frequency-domain-periodic-airbox-runtime
just verify-fem-frequency-domain-periodic-airbox-spectrum-runtime
just verify-fem-frequency-domain-periodic-airbox-refined-spectrum-runtime
just verify-fem-frequency-domain-periodic-airbox-z-padding-runtime
just verify-fem-frequency-domain-periodic-airbox-supercell-runtime
```

### M7 - Control Room Frequency-Domain UX

Progress: 76%.

Delivered:

- Resource hooks exist for manifest, eigen artifacts, response artifacts, progress, cancel state, diagnostics, frequency points, and field metadata.
- Explorer exposes calculation modes, FMR, dispersion, eigen, response, comparison, exports, periodic pairs, response fields, and gated response-map nodes.
- Dedicated inspectors exist for result/resource/job/diagnostic nodes.
- Charts render modal spectra, dispersion, response sweeps, FMR peaks, and modal-vs-driven comparison models.
- 3D overlay commands support eigen and response complex field views with phase controls and animation state.

Remaining:

- Authoring controls for frequency-domain stages must be transaction-backed through the canonical Study inspector path.
- Browser smoke must prove selected eigen/response fields render in the unified 3D viewport with a live WebGL buffer.
- UI capability state must show no-demag, static-periodic, dynamic-demag, CPU, GPU, and reference/production limits without ambiguity.
- Response-map UI must remain hidden unless manifest/artifacts prove it exists.

Verification:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SCREENSHOT_SCENES=fdm CONTROL_ROOM_SCREENSHOT_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room screenshot:viewport-3d
```

### M8 - COMSOL-Class Modal/Eigenfrequency Solver

Progress: 34%.

Delivered:

- Modal/eigen product is semantically separate from driven response.
- Native request/result contracts and SLEPc-facing adapter pieces exist.
- Tiny modal validation and dependency diagnostics exist.
- Frequency-window authoring target is documented.
- Eigen artifact writer and runtime verifier cover the current modal artifact bundle.

Remaining:

- Fix the modal algebra before expanding SLEPc: production modal support must use `lambda = i omega` or an explicitly transformed gyrotropic/Hamiltonian operator, not an ambiguous real `K phi = omega G phi` pencil.
- Add the 2-DOF macrospin test for undamped frequency sign/magnitude, conjugate branch, residual mapping, and damping/linewidth convention.
- Implement scalable selected-spectrum modal eigensolver for large FEM meshes.
- Support frequency windows with `frequency_min_hz`, `frequency_max_hz`, and `count` as maximum accepted modes.
- Emit residuals, mass norm, orthogonality, tangent leakage, solver diagnostics, spectral transform, KSP/PC provenance, and stop reason.
- Connect modal native execution to runner and managed runtime proof.
- Add dynamic demag and Floquet modal support only after matching operator contracts exist.

Verification:

```bash
just verify-fem-frequency-domain-eigen-runtime
just verify-fem-frequency-domain-native-contract
python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/frequency-domain-eigen-runtime/artifacts
python3 scripts/verify_fem_frequency_domain_eigen_artifacts.py .fullmag/reports/frequency-domain-eigen-runtime/window-artifacts
```

### M9 - Nonzero-k Floquet No-Demag Production Path

Progress: 32%.

Delivered:

- Floquet metadata validation checks phase consistency.
- Runner can forward a narrow explicit-GPU no-demag/no-DMI Floquet response slice to native code.
- GPU development smoke emits phase-projection metadata and no-demag artifacts.
- Capability matrix describes the slice as narrow/development, not full production.

Remaining:

- Implement or explicitly reject tangent-frame transport. `q_dst = phase*q_src` is valid only when paired tangent frames are identical within tolerance; otherwise the operator must use `phase*(T_dst^T T_src)`.
- Promote only after production validation for exchange graph assembly, reciprocal dispersion/response behavior, pair coverage, and CPU/GPU parity where applicable.
- Keep full periodic exchange-graph assembly, DMI, demag, periodic Poisson, and magnetoelastic response gated until implemented.
- Do not market this as general magnonic-crystal FMR.

Verification:

```bash
just verify-fem-frequency-domain-cpu-floquet-runtime
just verify-fem-frequency-domain-gpu-floquet-runtime
just verify-fem-frequency-domain-gpu-floquet-reciprocal-runtime
```

### M10 - Dynamic Floquet/PBC Demag

Progress: 22%.

Delivered:

- `docs/physics/0828-fem-frequency-domain-floquet-demag.md` defines the target coupled dynamic demag contract.
- Native request structs carry fields for dynamic demag flags, magnetic and magnetostatic constraint counts, periodic-airbox scalar-potential DOFs, and coupled block payloads.
- Native solver validates and rejects unsupported combinations with structured diagnostics.
- GPU dynamic demag is explicitly absent and gated.

Remaining:

- Implement CPU dynamic demag-k operator or coupled `delta_m/delta_phi` block.
- Validate against phase-aware divergence/gradient, gauge, z-padding, supercell, and reciprocal tests.
- Implement GPU only after CPU contract and validation are stable.
- Add modal/eigenfrequency support separately from driven response.

Verification:

```bash
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-gpu-floquet-airbox-unsupported-runtime
```

### M11 - Magnetoelastic And Multiphysics Frequency Domain

Progress: 15%.

Delivered:

- Historical magnetoelastic frequency docs and specs exist.
- Current capability matrix keeps coupled quasistatic, elastodynamic, frequency-domain elastodynamics, and coupled eigenmodes deferred.
- Fullmag has prescribed-strain magnetic field contributions in other FEM workstreams, but that is not two-way frequency-domain mechanics.

Remaining:

- Quasistatic elasticity operator, boundary conditions, rigid-body constraints, residuals, and artifacts.
- Harmonic elastodynamics with mass/damping matrices.
- Coupled magnon-phonon response and coupled eigenmodes with branch tracking.
- UI and artifact contracts for mechanics fields and hybridization diagnostics.

Verification:

```bash
cargo test -p fullmag-plan magnetoelastic
python3 -m json.tool docs/specs/capability-matrix-v0.json
```

### M12 - Release Hardening, Docs, Benchmarks, Examples

Progress: 35%.

Delivered:

- Managed runtime recipes exist for native contracts, driven response, GPU slices, Floquet slices, eigen artifacts, periodic-airbox flows, and supercell comparison.
- Examples exist for CPU free response, GPU free response, static-periodic response, periodic FMR, GPU Floquet no-demag, and eigenmodes.
- Artifact validators are scriptable and covered by Python tests.

Remaining:

- A release table that maps each public example to exact supported capability status.
- Benchmarks for solve time, residual, memory, and transfer behavior per lane.
- User docs that explain COMSOL-like workflows without overclaiming unsupported demag/Floquet/magnetoelastic cases.
- CI recipes that cover narrow runtime gates without requiring broad hardware in every run.

Verification:

```bash
just verify-fem-frequency-domain-runtime-suite
python3 -m pytest scripts/test_frequency_domain_runtime_targets.py -q
python3 -m pytest scripts/test_verify_fem_frequency_domain_runtime_artifacts.py -q
```

## 6. Promotion Rules

A lane moves from `semantic_only` or `reference_executable` to `partial_production_executable` only when all of these are true:

1. Physics note names equations, units, assumptions, boundary conditions, observables, and validation limits.
2. Python DSL and ProblemIR can express the requested intent.
3. Planner accepts exactly the supported slice and rejects nearby unsupported slices.
4. Runner preserves requested and resolved execution.
5. Native backend executes through `backends/fem`, not hidden runner-only numerics.
6. Artifacts include manifest, diagnostics, provenance, response/eigen payloads, and field resources.
7. API facade and resource hooks can read the artifacts.
8. Control Room displays the result and capability status without misleading labels.
9. Managed/container-backed `just` verification passes for native FEM behavior.
10. Capability matrix and this masterplan are updated in the same change.

A lane moves to `validated` only after it also has analytical or cross-solver validation, convergence checks, CPU/GPU parity where relevant, and benchmark evidence for the named geometry/workload.

## 7. Current Highest-Priority Work

1. Close audit P0 mathematical contract in docs and tests before any new production promotion: phasor convention, gyrotropic pencil, demag sign, observable units, damping convention, and tangent-frame transport.
2. Close M5 static PBC equilibrium and demag stabilization for the antidot/magnonic-crystal unit cell.
3. After M5 passes and audit P0 is implemented, close M6 solved single-point and refined-spectrum acceptance for CPU `periodic_airbox_k0` driven response with demag.
4. Keep M4 GPU no-demag/static-periodic slices strict and parity-tested.
5. Finish M7 browser proof for complex eigen/response 3D overlays and transaction-backed stage authoring.
6. Advance M8 native modal/eigenfrequency selected-spectrum path only after the corrected modal pencil and macrospin tests pass.
7. Keep M10 nonzero-k dynamic demag explicitly gated until the real phase-aware demag operator exists.

## 8. Update Log

| Date | Update | Evidence | Verification |
|---|---|---|---|
| 2026-06-30 | Made M5 periodic-antidot static PBC explicit in the public problem contract: `study.pbc(x=True, y=True)` now serializes `ProblemIR.pbc` and derives FEM mesh `x_faces/y_faces` pair requests, while the FEM planner rejects static/time-domain meshes that carry periodic node pairs without `ProblemIR.pbc`. Mesh pair metadata is topology only and no longer acts as an implicit physical PBC switch. | `packages/fullmag-py/src/fullmag/world.py`, `examples/fem_periodic_antidot_relax_exchange_coupled.py`, `examples/fem_periodic_antidot_relax_air_gap.py`, `packages/fullmag-py/tests/test_api.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-plan/src/tests.rs`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with focused Python PBC/API tests, periodic-antidot export tests, focused FEM planner test, diff check, and then the managed `just verify-fem-periodic-antidot-relaxation-gpu-runtime` gate for full GPU PBC proof. |
| 2026-06-30 | Hardened the M5 periodic-antidot relaxation gate toward GPU PBC equilibrium: GPU relaxation qualification metadata now publishes the same final energy and torque observables as CPU, and the periodic-antidot validator requires demag runtime provenance, non-negative demag energy, finite bounded torque, PBC pair metadata, and `device_hypre_poisson` GPU demag policy. | `crates/fullmag-runner/src/types.rs`, `crates/fullmag-runner/src/artifacts.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with focused Python periodic-antidot validator tests, Rust GPU relaxation metadata tests, diff check, and the managed `just verify-fem-periodic-antidot-relaxation-gpu-runtime` gate when running the full GPU PBC proof. |
| 2026-06-30 | Hardened the P0 damping/linewidth convention for modal artifacts: damped `exp(i omega t)` reference modal artifacts now use positive `frequency_imag_hz = Gamma/(2*pi)`, publish `damping_rate_hz` and `linewidth_fwhm_hz = 2*frequency_imag_hz`, and fill `line_width_hz` consistently in dispersion CSV. The eigen artifact validator rejects negative damped `exp_i_omega_t` imaginary frequency and linewidth drift. | `crates/fullmag-runner/src/fem_eigen.rs`, `scripts/verify_fem_frequency_domain_eigen_artifacts.py`, `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`, `docs/specs/frequency-domain-artifacts-v2.md`, `docs/physics/0700-frequency-domain-linearized-llg.md`. | Verify with focused Rust runner tests, Python eigen artifact-validator tests, and `just verify-fem-frequency-domain-eigen-runtime`. |
| 2026-06-30 | Hardened the P0 dynamic-demag Poisson sign contract: the native FEM demag Poisson gate now pins the RHS weak-form source for `laplace(phi) = div(Ms m)` and, in MFEM-stack builds, recovers a manufactured scalar potential to verify `H_demag = -grad(phi)` numerically. This closes the demag-sign subitem without claiming that all P0 audit items are complete. | `backends/fem/tests/demag_poisson_contract.cpp`, `backends/fem/CMakeLists.txt`, `docs/physics/fem_demag_poisson.md`, `docs/physics/0700-frequency-domain-linearized-llg.md`, `docs/physics/0828-fem-frequency-domain-floquet-demag.md`. | Verify with `just verify-fem-demag-poisson-contract`, plus diff/compile checks for the touched contract files. |
| 2026-06-30 | Hardened M9 Floquet tangent-frame transport provenance for the current no-demag phase-projection slice: successful Floquet response artifacts now must report `basis_transport_policy = tangent_frame_identity`, `floquet_tangent_frame_max_mismatch`, and `floquet_tangent_transport_max_nonunitarity`, while frame-mismatch failures report `basis_transport_policy = rejected`. This closes the scalar-phase overclaim for the current identity-frame backend without claiming full `phase*(T_dst^T T_src)` transport. | `backends/fem/src/frequency_domain/driven_response_solver.cpp`, `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`, `scripts/verify_fem_frequency_domain_runtime_artifacts.py`, `scripts/test_verify_fem_frequency_domain_runtime_artifacts.py`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verify with focused Python artifact-validator tests, native frequency-domain contract tests, and managed CPU/GPU Floquet runtime gates. |
| 2026-06-30 | Hardened modal/eigen artifact algebra provenance for the P0 eigenvalue-mapping contract: reference modal bundles now publish `phasor_convention`, `eigenvalue_mapping`, and solver-level `algebraic_form`/`matrix_equation`/`frequency_mapping`, making the current dense reference `K u = lambda M u` lane explicit instead of conflating it with the future gyrotropic production pencil. | `crates/fullmag-runner/src/eigen/artifacts.rs`, `scripts/verify_fem_frequency_domain_eigen_artifacts.py`, `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verify with focused Python eigen artifact-validator tests, Rust artifact writer tests, and `just verify-fem-frequency-domain-eigen-runtime`. |
| 2026-06-30 | Incorporated the solver-plan audit as a blocking P0 documentation contract: phasor/eigen algebra, `mu0` gyrotropic scaling, dynamic-demag sign, `Ms`-correct response observables, damping convention, and tangent-frame transport now gate production promotion. | `audyt_planu_solvera_fem_domena_czestotliwosci.md`, `docs/physics/0700-frequency-domain-linearized-llg.md`, `docs/physics/0600-fem-eigenmodes-linearized-llg.md`, `docs/physics/0710-periodic-and-floquet-boundary-conditions.md`, `docs/physics/0828-fem-frequency-domain-floquet-demag.md`, `docs/specs/frequency-domain-artifacts-v2.md`. | Documentation-only change; verify by content scan and diff check. |
| 2026-06-30 | Added M5 static PBC equilibrium and demag stabilization as the required magnonic-crystal gate before periodic-airbox response or eigenfrequency dynamics. | User correction, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/plans/active/fullmag_pbc_fem_bloch_airbox_plan.md`, existing periodic-airbox scripts and managed checks. | Documentation-only change; verify milestone numbering, content scan, and README link check. |
| 2026-06-30 | Hardened driven-response observable provenance for the P0 units contract: native response artifacts now label current drive-projected susceptibility as `delta_m_over_h_drive` in `m/A` and current absorbed-power output as a proxy that has not applied `mu0 * Ms`; the runtime validator rejects artifacts that omit those fields. | `backends/fem/src/frequency_domain/driven_response_solver.cpp`, `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`, `scripts/verify_fem_frequency_domain_runtime_artifacts.py`, `scripts/test_verify_fem_frequency_domain_runtime_artifacts.py`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verify with focused Python artifact-validator tests and managed native FEM frequency-domain contract gate. |
| 2026-06-30 | Hardened driven-response diagnostics for the P0 algebra/phasor contract: native response diagnostics now publish `matrix_form` and `phasor_convention`, and the runtime validator rejects production response bundles where diagnostics omit them or drift from the manifest phasor convention. | `backends/fem/src/frequency_domain/driven_response_solver.cpp`, `backends/fem/tests/frequency_domain/frequency_domain_contract.cpp`, `scripts/verify_fem_frequency_domain_runtime_artifacts.py`, `scripts/test_verify_fem_frequency_domain_runtime_artifacts.py`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verify with focused Python artifact-validator tests and managed native FEM frequency-domain contract gate. |
| 2026-06-30 | Created live COMSOL-grade masterplan; consolidated existing docs, current backend/frontend state, COMSOL parity requirements, and milestone percentages. | Current worktree, active plan folder, COMSOL manual text extraction, capability matrix, backend/frontend source inspection. | Documentation-only change; verify by content scan and README link check. |
