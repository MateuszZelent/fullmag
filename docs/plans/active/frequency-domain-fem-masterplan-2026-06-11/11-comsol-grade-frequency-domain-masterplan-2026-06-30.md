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
- Do not classify magnetization-only periodic projection as magnetostatic PBC. If `m` is periodic but `phi`/`H_demag` behave like a finite isolated airbox, the result is false or incomplete PBC and cannot promote `periodic_airbox_k0` demag.

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

Progress: 80%.

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
- Static PBC-demag runtime artifacts now distinguish the physical magnetostatic boundary model from the underlying airbox realization: accepted PBC runs must publish `demag_runtime.magnetostatic_boundary_model = "periodic_airbox_k0"`, `poisson_operator = "pbc_reduced_poisson"`, and `periodic_reduction.method = "P^T A P"` with positive periodic node/boundary-pair counts and Robin exclusion of periodic boundary markers.

Remaining:

- Periodic-airbox solved bundle must pass the same observability/provenance requirements as bounded solve-error bundles.
- Artifact validators must be kept in lockstep with any schema evolution; `model="airbox"` plus `boundary_variant="robin"` is not sufficient evidence of magnetostatic PBC unless the periodic-reduction provenance is present.
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

Progress: 76%.

Implemented:

- `docs/physics/0800-fem-static-pbc-demag.md` defines the static/time-domain FEM PBC demag contract for periodic magnetic samples with open airbox direction.
- The active PBC/Bloch plan names the 200 x 200 x 10 nm thin-film antidot unit cell with a centered 50 nm hole as the target magnonic-crystal smoke geometry.
- Periodic magnetic node-pair metadata, frozen magnetic submesh preparation, shared-airbox materialization, and supercell artifact comparison scripts exist.
- Static PBC demag has reference/source-visible evidence for reduced periodic classes, open-axis Robin treatment, periodic-pair diagnostics, and primitive-vs-supercell artifact checks.
- The ordinary managed periodic-antidot CPU and GPU relaxation gates now pass for both `exchange_coupled` and `air_gap` fixtures with same-step `m`, gauge-adjusted `phi`, periodic `H_demag`, balanced normal `B` flux, no artificial side magnetic charge, finite torque/energy telemetry, and CPU/GPU provenance. This closes the previously observed false-PBC `H_demag` seam regression, but it does not close strict M5 production acceptance until z-padding and primitive-vs-supercell reports are supplied for the same accepted workload.
- Strict M5 now has artifact-backed report entry points for z-padding, central-cell extraction, primitive-vs-supercell comparison, preparatory repeated-unit initial-state generation, and a diagnostic managed run that consumes that sampled state through a headless initial-state override with artifact/live metadata provenance. `verify-fem-static-pbc-demag-equilibrium-runtime` rejects missing z-padding plus at least one controlled supercell comparison report before running the ordinary CPU/GPU relaxation gates, the report writer rejects self-comparison or incompatible-workload artifact roots, and the periodic-antidot validator requires report `workload` to match the accepted run and independently rejects over-threshold metrics even when a report declares `status="ok"`. The repeated-state validator path also requires `initial_magnetization_state_override` provenance, a resolvable JSON source state, matching vector counts, and component-wise agreement between the source state and artifact `m_initial.json`. Repeated-state supercell reports now carry `supercell_initial_magnetization_state_override`, and the strict runtime validator can require that report through `FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT`. The supercell report now also requires explicit `fem_static_pbc_supercell_central_cell.v1` extraction provenance. The default extractor selects central-cell nodes from `mesh/node_geometry.v1.json`, computes central-cell `E_demag` by element-centroid magnetic tetrahedron integration, and computes central-cell torque from exported `H_eff`, so global supercell averages cannot masquerade as central-cell agreement. The report also gates relaxation-state comparability through `relaxation_state_mean_deviation_relative_error`, so a failing primitive-vs-3x3 run can distinguish operator/PBC mismatch from a different independently relaxed central-cell state. The 2026-07-01 managed ordinary primitive-vs-3x3 report is now recorded as diagnostic `status="failed"` evidence (`e_demag_density_relative_error=5.183127e-02`, `h_demag_stats_relative_error=3.049715e-02`, large mesh-count mismatch), and the repeated-state wrapper no longer lets that diagnostic report prevent the controlled repeated-state gate from running. The repeated-unit initial-state producer is strict by default and currently exposes that the independent 3x3 remesh is not node-identical to the primitive mesh, so the new repeated-state runtime target is diagnostic preparation for a controlled/frozen fixture rather than M5 closure.

Remaining:

- Keep the explicit managed gate for static PBC equilibrium of the antidot unit cell before any response or eigenfrequency run consumes the equilibrium.
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
| M5 | Static PBC equilibrium and demag stabilization for magnonic-crystal unit cells | 83% | Static PBC intent now flows through `ProblemIR.pbc`/`metadata.pbc`, mesh option propagation is explicit, planner axes must match `ProblemIR.pbc`, `periodic_pairs.v1` now carries domain-aware magnetic/airbox coverage and boundary-face orientation diagnostics through artifacts and the v2 mesh resource, same-step `H_demag`, `H_eff`, gauge-invariant `demag_phi`, and runtime-emitted `diagnostics/fem_static_pbc_demag_seams.v1.json` flux/charge diagnostics are required, GPU minimizer trial states and recovered GPU `H_demag` are projected onto periodic classes, and the ordinary managed CPU/GPU periodic-antidot gates pass for `exchange_coupled` and `air_gap`; strict M5 now has artifact-backed comparison report targets and rejects missing, self-comparison, incompatible-workload, workload-mismatched, over-threshold, or missing-central-extraction reports, and the default supercell extractor computes central-cell demag energy/torque from mesh and field artifacts instead of supplied globals. Supercell reports now also record and gate mesh-independent relaxation-state comparability. A repeated-unit initial-state writer and a headless `--initial-magnetization-state` runtime override with validator-enforced `initial_magnetization_state_override` provenance now exist for controlled/frozen supercell fixtures; the validator also verifies that the recorded JSON source state matches artifact `m_initial.json`, so metadata-only claims cannot pass. The repeated-state managed target now also writes central-cell extraction and a separate primitive-vs-repeated-state supercell report, and that report carries `supercell_initial_magnetization_state_override` so `FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT` can be used as an explicit strict-gate input. `verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime` is now the one-command wrapper that generates z-padding, an ordinary supercell diagnostic report, repeated-state supercell, and runs the strict CPU/GPU equilibrium gate with z-padding plus repeated-state report paths. Supercell prepare and repeated-state runs default `FULLMAG_PBC_RELAX_GMSH_THREADS=1` so the repeated-state file is not invalidated by multithreaded Gmsh node-count drift between two materializations. The repeated-state producer now fills air/non-magnetic nodes with `[0, 0, 0]`, matching native FEM `m` artifacts outside magnetic material, and the managed run passes the initial-state override validator. Supercell reports now include `mapped_central_cell_comparability`, a modulo-periodic nearest-node pointwise comparison for central-cell `m`, `H_demag`, and gauge-adjusted `demag_phi`; mapped pointwise errors, mapped nearest-node distances, and `same_local_discretization=true` are now report thresholds/contract, not only diagnostics. The current independent 3x3 remesh still requires a diagnostic nearest-node tolerance around `1e-8 m`, so it does not close the strict same-local-discretization acceptance. Fresh managed ordinary and repeated-state primitive-vs-3x3 supercell reports exist, but both fail strict thresholds; the repeated-state report now has `same_local_discretization=false` and fails on `h_demag_stats_relative_error=6.591465e-02`, `demag_phi_max_abs_delta_A=4.783996e-05`, `relaxation_state_mean_deviation_relative_error=5.578288e-01`, `mapped_m_p99_l2_delta=2.874209e-02`, `mapped_h_demag_p99_relative_error=2.324448e-01`, `mapped_demag_phi_max_abs_delta_after_offset_A=3.779693e-04`, `mapped_max_nearest_field_node_distance_m=9.740109e-09`, and `mapped_max_nearest_magnetic_node_distance_m=5.135622e-09`, while demag-energy density and central-cell torque are within thresholds. M5 still blocks periodic-airbox frequency response/eigen promotion. |
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

Progress: 73%.

Objective:

- Establish a physically accepted static state for magnonic-crystal unit cells before any harmonic response or eigenfrequency calculation. The reference target is a thin ferromagnetic film unit cell with a centered hole, lateral PBC, open z airbox, static bias field, and static demag enabled through the PBC-compatible airbox contract. The general static/time-domain PBC contract is axis-based, not plane-only: `z` may be periodic for non-fully-periodic cells when at least one other axis remains open and the mesh publishes matching `z_faces` periodic pairs.

Delivered:

- Static PBC demag physics and validity limits are documented in `docs/physics/0800-fem-static-pbc-demag.md`.
- The target antidot geometry and periodic-airbox constraints are tracked in `docs/plans/active/fullmag_pbc_fem_bloch_airbox_plan.md`.
- Frozen magnetic submesh and periodic pair preparation are scriptable through `scripts/prepare_fmr_frozen_magnetic_submesh.py`.
- Primitive-vs-supercell comparison has a validator in `scripts/verify_fem_frequency_domain_supercell_artifacts.py`.
- Existing static PBC demag evidence covers reduced periodic classes, periodic-pair diagnostics, open-axis Robin treatment, and primitive/supercell artifact comparison for static demag observables.
- Static/time-domain PBC is now explicit problem intent: `study.pbc(x=True, y=True, demag="periodic_airbox_k0")` lowers to `ProblemIR.pbc`, the planner rejects periodic FEM mesh pairs without `ProblemIR.pbc`, the planner rejects FEM static/time-domain demag PBC when `ProblemIR.pbc.demag` remains `open`, and runtime metadata publishes top-level `metadata.pbc` copied from the IR.
- Static/time-domain PBC axes are now explicit too: `study.pbc(z=True)` is legal public intent, derives `z_faces`, and the FEM planner rejects meshes whose inferred periodic axes add, remove, or replace the axes declared in `ProblemIR.pbc`. The current antidot examples intentionally use lateral `x/y` PBC with open `z`; this does not limit future supported `z`-periodic non-full-3D cases.
- A planner regression now proves the positive `z` demag case: single-axis `z` FEM demag PBC with open `x/y` airbox boundaries and `ProblemIR.pbc.demag = "periodic_airbox_k0"` plans, while the existing full `x/y/z` demag rejection remains in force for the current non-full-3D airbox slice.
- `examples/fem_periodic_uniform_slab_relax_exchange_coupled.py` and `just verify-fem-static-pbc-demag-uniform-slab-runtime` now provide the minimal false-PBC managed diagnostic before the hole geometry: a uniform exchange-coupled `200 nm x 200 nm x 10 nm` slab with `x/y` `periodic_airbox_k0`, open `z`, a short explicit `max_steps=120` relaxation, CPU validation, and GPU/device-Poisson validation.
- The periodic-pairs artifact writer and validator now require every selected periodic pair to prove shared-airbox node coverage plus non-empty boundary-face pair diagnostics with opposed normals. If the magnetic body crosses a selected seam, as in `exchange_coupled`, the pair must also prove positive magnetic coverage. If the magnetic body is a separated island inside an air gap, as in `air_gap`, `magnetic = 0` is accepted only when the same-step `phi`/`H_demag`, normal `B` flux, and side-charge diagnostics prove magnetostatic continuity.
- Periodic-antidot relaxation examples now request `H_demag`, `H_eff`, and `demag_phi` snapshots, and runtime validators require `metadata.pbc`, the final equilibrium field `m_final.json`, scalar history `scalars.csv` with non-increasing final total energy, the resolved same-step `fields/H_demag/step_*.json`, resolved same-step `fields/demag_phi/step_*.json`, and `mesh/periodic_pairs.v1.json` diagnostic artifacts with explicit `node_pairs`, converged demag Poisson telemetry in `demag_runtime`, PBC pair topology, finite final torque, non-negative final demag energy, magnetic-body norm preservation, final `m`/`H_demag` seam mismatch below tolerance, `demag_phi` seam mismatch below tolerance after removing the best constant offset per periodic pair id, and GPU device-Poisson provenance for the GPU gate.
- The periodic-antidot validator now requires same-step `diagnostics/fem_static_pbc_demag_seams.v1.json` with normal `B` flux and side magnetic charge diagnostics, so a run cannot pass by showing periodic `m` while preserving finite-cell magnetostatic seams.
- The runner now emits the same-step static PBC demag seam diagnostics artifact for FEM static/time-domain `periodic_airbox_k0` demag runs when final `H_demag` and `demag_phi` snapshots are present; incomplete data produces a `status="failed"` artifact rather than silent acceptance.
- The managed periodic-antidot CPU/GPU runtime recipes now pass optional strict M5 comparison reports into the validator through `FULLMAG_PBC_RELAX_Z_PADDING_REPORT` and `FULLMAG_PBC_RELAX_SUPERCELL_REPORT`; when set, the validator requires `fem_static_pbc_z_padding_validation.v1` and `fem_static_pbc_supercell_validation.v1` reports with `status="ok"` plus finite, non-negative, below-threshold static-demag comparison metrics. The z-padding report uses demag-energy relative error, `p99(|H_demag|)` relative error, and `demag_phi` range relative error as acceptance metrics; global `|H_demag|` maximum and absolute `demag_phi` deltas remain diagnostics.
- Strict z-padding reports now prove z-padding geometry, not just two compatible artifact roots: the report writer and runtime validator require an `x/y` periodic, open-`z` workload with matching lateral universe size and a strictly thicker reference open-`z` airbox than the candidate. Same-airbox CPU/GPU ordinary relaxation artifacts cannot masquerade as z-padding convergence evidence. A fresh managed exchange-coupled z-padding run now writes `status="ok"` at `.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json`; strict M5 remains open until the matching primitive-vs-supercell report and full equilibrium gate pass.
- `examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py` and `just verify-fem-static-pbc-demag-z-padding-runtime` now provide the canonical managed path to produce the exchange-coupled z-padding report from a 90 nm open-`z` candidate and a 130 nm open-`z` reference for the same workload.
- Strict supercell reports now prove repeated-cell geometry too: the report writer and runtime validator require lateral `universe_size_m` scaled by `repeat_x/repeat_y`, matching open-`z` `universe_size_m`, and matching lateral air gap, periodic pair ids, and exchange-coupling intent, so a same-size ordinary artifact root cannot masquerade as primitive-vs-supercell validation.
- `examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py` and `just verify-fem-static-pbc-demag-supercell-runtime` now provide the canonical managed path to produce primitive/3x3 supercell artifacts for the exchange-coupled workload and write the strict supercell report from automatically extracted central-cell indices and scalars. `just prepare-fem-static-pbc-demag-supercell-runtime-artifacts` can now produce and ordinary-validate the unit/supercell runtime artifact roots before strict report generation; repeated artifacts are accepted only through explicit `--supercell-repeat 3 3` validation and scaled lateral `universe_size_m`, and repeated FEM artifact roots now include `mesh/node_geometry.v1.json` so central-cell index selection can be audited against node coordinates and magnetic-node masks.
- `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py` and `just write-fem-static-pbc-demag-supercell-central-cell-artifact-auto` now provide the default central-cell extraction artifact producer from `mesh/node_geometry.v1.json`, `metadata.execution_plan.backend_plan.mesh`, `m_final.json`, `H_demag.zarr`, and `H_eff.zarr`; the producer selects magnetic-node and node-aligned field indices from the central repeated cell, computes central-cell demag energy by element-centroid magnetic tetrahedron integration, computes central-cell torque residual from `max(norm(cross(m_i,H_eff_i)))`, validates index ranges against `m_final.json`, `H_demag.zarr`, `H_eff.zarr`, and `demag_phi.zarr`, rejects central scalar values above global supercell `E_demag` or final torque, and does not infer central energy or torque from global supercell totals. The manual target still accepts explicit index lists or index files plus explicit scalar values for external extraction workflows.
- `scripts/compare_fem_static_pbc_equilibrium_artifacts.py` now writes those strict static comparison reports from real artifact roots, rejects self-comparison and incompatible-workload roots, records the compared workload identity, requires `diagnostics/fem_static_pbc_supercell_central_cell.v1.json` for primitive-vs-supercell comparisons, the periodic-antidot validator rejects missing or mismatched report workload metadata, missing central-cell extraction summaries, or over-threshold report metrics, and `just verify-fem-static-pbc-demag-equilibrium-runtime` requires the two report paths before running the ordinary CPU/GPU periodic-antidot gates.
- GPU projected-gradient BB and nonlinear-CG now project every trial magnetisation onto the static periodic representative map after nodal-sphere retraction, so the demag RHS does not see a synthetic seam in `m` during line-search energy evaluation.
- GPU device Poisson demag recovery now projects recovered `H_demag` onto static periodic classes before energy and snapshot diagnostics. This fixes the observed false-PBC state where the GPU run had periodic `m` but a non-periodic `H_demag` seam.
- Fresh managed CPU and GPU periodic-antidot relaxation runs pass the ordinary validator for both `exchange_coupled` and `air_gap`. Latest artifact evidence:
  - CPU `exchange_coupled`: 212 steps, final torque `4630.688509775621 A/m`, `E_total=-2.291265785283922e-18 J`, `max_H_seam=0`, `max_Bn_seam=0`.
  - CPU `air_gap`: 809 steps, final torque `4991.247845003653 A/m`, `E_total=4.8840367289235546e-18 J`, `max_H_seam=0`, `max_Bn_seam=0`, airbox-only side seams with `magnetic=0`.
  - GPU `exchange_coupled`: 179 steps, final torque `4128.4717381323535 A/m`, `E_total=-2.2925217615732664e-18 J`, `max_H_seam=0`, `max_Bn_seam=0`, `demag_operator_mode="device_hypre_poisson"`.
  - GPU `air_gap`: 1183 steps, final torque `4987.821957028258 A/m`, `E_total=4.889581843952544e-18 J`, `max_H_seam=0`, `max_Bn_seam=0`, airbox-only side seams with `magnetic=0`, `demag_operator_mode="device_hypre_poisson"`.

Acceptance gates:

1. The authored problem declares the selected static PBC axes through `ProblemIR.pbc` with `demag = "periodic_airbox_k0"`, the inferred mesh periodic axes match `ProblemIR.pbc.axes`, and the mesh publishes complete shared-airbox `periodic_node_pairs`, magnetic `periodic_node_pairs` for seams where magnetic material crosses the periodic boundary, periodic boundary-face pair translations/orientation diagnostics, material labels, and airbox/open-axis boundary labels. The current antidot acceptance fixture is `x/y` periodic with open `z`; that fixture must not be treated as a solver-wide ban on `z`-periodic non-full-3D cells.
2. The resolved magnetostatic model is `periodic_airbox_k0` or the static PBC demag equivalent; the run must not fall back to finite isolated-airbox demag or accept `ProblemIR.pbc.demag = "open"` for FEM static/time-domain demag PBC.
3. Relaxation reaches a physical equilibrium by torque residual and stable energy behavior, not merely by a low `max_steps` smoke.
4. Magnetization keeps unit length in the magnetic body and has seam mismatch below the documented PBC tolerance.
5. Static `H_demag`, scalar potential, demag energy, and normal `B` flux satisfy seam, sign, gauge, and z-padding convergence checks; `demag_phi` seam diagnostics must remove the best constant offset per periodic pair id before applying the tolerance, and side periodic seams must not exhibit artificial magnetic surface charges.
6. The primitive PBC cell agrees with an explicit 2x2 or 3x3 supercell central-cell extraction for average magnetization, demag energy density, `H_demag` statistics, flux/seam diagnostics, and torque residual.
7. Accepted artifacts include `metadata.pbc`, the equilibrium field, demag diagnostics, periodic-pair summary, z-padding/supercell comparison, solver convergence, and requested/resolved provenance.
8. Control Room can inspect the accepted equilibrium and show PBC/demag diagnostics before the user launches response or eigenfrequency analysis.

Required new managed gate:

```bash
just verify-fem-static-pbc-demag-uniform-slab-runtime
just verify-fem-static-pbc-demag-z-padding-runtime
just verify-fem-static-pbc-demag-supercell-runtime

FULLMAG_PBC_RELAX_Z_PADDING_REPORT=.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json \
FULLMAG_PBC_RELAX_SUPERCELL_REPORT=.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json \
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
2. Close M5 static PBC equilibrium and demag stabilization for the antidot/magnonic-crystal unit cell, starting from a uniform periodic slab false-PBC test before the hole geometry.
3. After M5 passes and audit P0 is implemented, close M6 solved single-point and refined-spectrum acceptance for CPU `periodic_airbox_k0` driven response with demag.
4. Keep M4 GPU no-demag/static-periodic slices strict and parity-tested.
5. Finish M7 browser proof for complex eigen/response 3D overlays and transaction-backed stage authoring.
6. Advance M8 native modal/eigenfrequency selected-spectrum path only after the corrected modal pencil and macrospin tests pass.
7. Keep M10 nonzero-k dynamic demag explicitly gated until the real phase-aware demag operator exists.

## 8. Update Log

| Date | Update | Evidence | Verification |
|---|---|---|---|
| 2026-07-01 | Promoted the repeated-state supercell path from loose diagnostic default to strict same-local preflight. `verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared` now defaults `FULLMAG_PBC_RELAX_REPEATED_STATE_MAX_NEAREST_DISTANCE_M` to `1e-12` instead of `1e-8`, so current independently remeshed primitive/3x3 artifacts fail before the seeded supercell run rather than producing another non-same-local report. The repeated-unit writer now sizes its spatial buckets from primitive magnetic-node density, so strict preflight reports the finite nearest-node blocker instead of `inf`; current artifacts fail at `5.710107e-09 m > 1e-12 m`. The `1e-8` mapping remains possible only by explicitly calling the repeated-unit writer target as diagnostic evidence. | `justfile`, `scripts/write_fem_static_pbc_repeated_unit_initial_state.py`, `scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `PYTHONPATH=packages/fullmag-py/src python3 -m pytest scripts/test_periodic_antidot_relaxation_runtime_targets.py scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py -q`, `just --dry-run verify-fem-static-pbc-demag-supercell-repeated-state-runtime-from-prepared`, strict writer preflight against existing artifacts, `py_compile`, and `git diff --check`. |
| 2026-07-01 | Added the uniform-slab false-PBC managed diagnostic requested by the M5 plan. `examples/fem_periodic_uniform_slab_relax_exchange_coupled.py` is a plain-Python `study.pbc(x=True, y=True, demag="periodic_airbox_k0")` slab without a hole, uses a transverse initial magnetization and short explicit `max_steps=120` so it exercises runtime artifacts without becoming a long equilibrium solve, the artifact validator now accepts `uniform_slab` while still requiring positive magnetic seam coverage for exchange-coupled PBC, and `just verify-fem-static-pbc-demag-uniform-slab-runtime` runs both CPU and GPU/device-Poisson managed validations into `.fullmag/reports/fem-static-pbc-demag-uniform-slab-runtime`. The validator also allows only `1e-24 J` absolute negative roundoff in demag energy, after the GPU uniform slab exposed `E_demag` values at numerical zero. This does not close strict M5; it gives the next solver/debug pass a simpler fixture than antidot. | `examples/fem_periodic_uniform_slab_relax_exchange_coupled.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `PYTHONPATH=packages/fullmag-py/src python3 -m pytest packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py scripts/test_periodic_antidot_relaxation_runtime_targets.py -q`, `py_compile`, `just --dry-run verify-fem-static-pbc-demag-uniform-slab-runtime`, `just verify-fem-static-pbc-demag-uniform-slab-runtime`, and `git diff --check`. |
| 2026-07-01 | Made same-local supercell comparability explicit in the strict-M5 mapped central-cell report. `mapped_central_cell_comparability` now records `same_local_discretization` and `same_local_discretization_limit_m`, and the periodic-antidot validator rejects reports whose boolean flag disagrees with the recorded max nearest-node distances. The current repeated-state 3x3 report regenerates with `same_local_discretization=false` because its nearest-node distances remain `9.740109e-09 m` for field nodes and `5.135622e-09 m` for magnetic nodes against the strict `1e-12 m` limit. This keeps the existing report as negative remesh evidence and defines the executable acceptance shape for a true frozen/same-local supercell fixture. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `.fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with focused writer/validator tests and regenerated repeated-state supercell report; run the full focused strict-M5 group, `py_compile`, and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Added a one-command managed strict-M5 wrapper for the controlled repeated-state path. `verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime` now runs the z-padding report target, ordinary primitive-vs-3x3 supercell report target, repeated-state supercell report target, and then invokes `verify-fem-static-pbc-demag-equilibrium-runtime` with all three report environment variables set. This removes manual report wiring from the strict-M5 proof path but does not relax any physical metric; the wrapper will still fail if any report status or CPU/GPU equilibrium gate fails. | `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN target-contract test and `just --dry-run verify-fem-static-pbc-demag-equilibrium-repeated-state-runtime`; run the full focused strict-M5 group, `py_compile`, and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Fixed strict-M5 report routing in the managed periodic-antidot CPU/GPU loops. Z-padding, ordinary supercell, and repeated-state supercell comparison reports are exchange-coupled workload evidence, so the validators now attach those report requirements only while validating `exchange_coupled`; the `air_gap` fixture still runs as an ordinary PBC/demag smoke and no longer receives mismatched exchange-coupled report inputs. | `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN runtime-target tests and `just --dry-run verify-fem-periodic-antidot-relaxation-runtime` with all three report environment variables; run the full focused strict-M5 group, `py_compile`, and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Fixed the repeated-state initial-state source contract for shared-domain airbox meshes and added mapped central-cell diagnostics to the strict-M5 supercell report. The source writer now fills air/non-magnetic nodes with `[0, 0, 0]`, matching native FEM `m_initial.json` outside magnetic material; before this, the initial-state override validator failed with `max delta 1.0` on exactly the airbox-only node block. After regenerating the source state, the repeated-state runtime artifact passes `--require-initial-magnetization-state-override`, and the report writer reaches the real strict-M5 physics gate. `fem_static_pbc_supercell_validation.v1` now includes `mapped_central_cell_comparability`, which reduces central-cell supercell nodes modulo the primitive lateral periods and compares nearest primitive nodes pointwise for `m`, `H_demag`, and gauge-adjusted `demag_phi`; the runtime validator requires that section and consistency with the top-level mapped metrics. Those mapped metrics and nearest-node distances are now report thresholds, not passive diagnostics. The fresh repeated-state supercell report still has `status="failed"` because `h_demag_stats_relative_error=6.591465e-02`, `demag_phi_max_abs_delta_A=4.783996e-05`, `relaxation_state_mean_deviation_relative_error=5.578288e-01`, `mapped_m_p99_l2_delta=2.874209e-02`, `mapped_h_demag_p99_relative_error=2.324448e-01`, `mapped_demag_phi_max_abs_delta_after_offset_A=3.779693e-04`, `mapped_max_nearest_field_node_distance_m=9.740109e-09`, and `mapped_max_nearest_magnetic_node_distance_m=5.135622e-09` exceed thresholds. Demag-energy density and central-cell torque residual are within thresholds. This confirms the next M5 task is a frozen/same-local-discretization supercell fixture or a real PBC/demag field correction, not metadata plumbing or aggregate-comparison tuning. | `scripts/write_fem_static_pbc_repeated_unit_initial_state.py`, `scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py`, `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `crates/fullmag-cli/src/orchestrator.rs`, `docs/physics/0800-fem-static-pbc-demag.md`, `.fullmag/reports/fem-static-pbc-demag-supercell-repeated-state-runtime/reports/supercell_validation.v1.json`, this masterplan. | Verified with `cargo test -p fullmag-cli initial_magnetization_state_override`, focused writer/validator pytest, `just rebuild-fem-runtime`, managed repeated-state runtime through the initial-state validator, central-cell extraction, repeated-state supercell report generation, and diagnostic report regeneration with mapped comparison metrics. |
| 2026-07-01 | Promoted repeated-state supercell provenance into a first-class strict-M5 report gate. The static supercell report writer now carries `supercell_initial_magnetization_state_override` from the repeated-state supercell artifact metadata, the periodic-antidot validator has `--require-repeated-state-supercell-report`, and the managed CPU/GPU periodic-antidot gates forward `FULLMAG_PBC_RELAX_REPEATED_STATE_SUPERCELL_REPORT` when supplied. This lets strict equilibrium verification require a controlled repeated-state report without relying on directory naming or hand-written report claims. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with focused RED/GREEN tests for repeated-state report provenance and runtime target wiring, plus `just --dry-run verify-fem-static-pbc-demag-equilibrium-runtime` with all three report variables; run the full focused strict-M5 group, `py_compile`, and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Extended the repeated-state strict-M5 managed target from artifact validation to report generation. After the headless repeated-state supercell run passes `--require-initial-magnetization-state-override`, `verify-fem-static-pbc-demag-supercell-repeated-state-runtime` now writes the central-cell extraction artifact for the repeated-state supercell and writes a separate primitive-vs-repeated-state `supercell_validation.v1.json` report. This makes the controlled/frozen-state experiment directly comparable with the ordinary primitive-vs-3x3 report without overwriting the standard M5 report path. | `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_periodic_antidot_relaxation_runtime_targets.py -q -k repeated_state` and `just --dry-run verify-fem-static-pbc-demag-supercell-repeated-state-runtime`; run the full focused strict-M5 group, `py_compile`, and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Hardened the repeated-state runtime consumer gate so metadata alone cannot prove a seeded supercell run. `--require-initial-magnetization-state-override` now requires a JSON source state, resolves `initial_magnetization_state_override.source_path`, checks source vector count against `m_final.json`, requires artifact `m_initial.json`, and rejects any component-wise mismatch between `m_initial.json` and the source state above `1e-12`. This keeps the controlled repeated-state M5 path diagnostic but makes it impossible for hand-edited metadata to masquerade as actual first-stage state consumption. | `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py -q -k "initial_magnetization_state_override or initial_state_override"`; run the full focused strict-M5 group, `py_compile`, `just --dry-run verify-fem-static-pbc-demag-supercell-repeated-state-runtime`, and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Added an opt-in interpolated remesh diagnostic for the M5 primitive-vs-supercell path. `scripts/compare_fem_static_pbc_equilibrium_artifacts.py --include-interpolated-comparison` now writes `interpolated_central_cell_comparability`, reducing central supercell nodes modulo the primitive lateral period and evaluating primitive `m`, `H_demag`, and gauge-adjusted `demag_phi` by linear barycentric interpolation on primitive tetrahedra. `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py` validates the optional schema when present, and `just write-fem-static-pbc-demag-supercell-interpolated-diagnostic-report` exposes the diagnostic path. On the current artifacts the interpolation has full field/magnetic coverage, but still reports `H_demag.p99_relative_error=2.170060e-01`, `demag_phi.max_abs_delta_after_offset_A=1.417297e-04`, and `m.p99_l2_delta=1.072672e-02`, so the M5 mismatch is not only nearest-node remesh error. This does not relax or replace the strict same-local nearest-node gate; interpolation can become acceptance evidence only after explicit coverage/error thresholds are promoted into the M5 contract. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_interpolated_validation.v1.json`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `PYTHONPATH=packages/fullmag-py/src python3 -m pytest scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py scripts/test_periodic_antidot_relaxation_runtime_targets.py -q`, `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile ...`, `just --dry-run write-fem-static-pbc-demag-supercell-interpolated-diagnostic-report unit/artifacts supercell/artifacts 3 3`, and the concrete diagnostic report writer on `.fullmag/reports/fem-static-pbc-demag-supercell-runtime/{unit,supercell}/artifacts`; run the full focused strict-M5 group and `git diff --check` before claiming the slice complete. |
| 2026-07-01 | Added a same-local tiled supercell diagnostic fixture for M5 comparator plumbing. `scripts/write_fem_static_pbc_tiled_supercell_artifact.py` copies a primitive FEM static-PBC artifact into a repeated tiled artifact, scales extensive energy terms, writes node geometry and central-cell extraction provenance from the central copied tile, and is exposed through `just write-fem-static-pbc-demag-tiled-supercell-fixture` / `just verify-fem-static-pbc-demag-tiled-supercell-fixture`. This proves that the strict primitive-vs-supercell comparator accepts a known same-local artifact, but it is not a runtime solve and does not close M5. Real closure still requires a runtime-produced same-local supercell or explicitly validated interpolation plus passing primitive-vs-supercell metrics. | `scripts/write_fem_static_pbc_tiled_supercell_artifact.py`, `scripts/test_write_fem_static_pbc_tiled_supercell_artifact.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `PYTHONPATH=packages/fullmag-py/src python3 -m pytest scripts/test_write_fem_static_pbc_tiled_supercell_artifact.py scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py -q`, `python3 -m py_compile scripts/write_fem_static_pbc_tiled_supercell_artifact.py scripts/test_write_fem_static_pbc_tiled_supercell_artifact.py`, and `just --dry-run verify-fem-static-pbc-demag-tiled-supercell-fixture unit/artifacts supercell/artifacts 3 3`; run the full focused strict-M5 group and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Added provenance and validator enforcement for the repeated-state runtime consumer. The headless `--initial-magnetization-state` loader now records `problem_meta.runtime_metadata.initial_magnetization_state_override` with source path, normalized format, optional dataset/sample index, and loaded vector count before the first stage is planned for live metadata and executed for artifact metadata. The periodic-antidot validator now has `--require-initial-magnetization-state-override`, checks that this block exists, and requires its vector count to match `m_final.json`; the repeated-state managed target uses that flag. This makes repeated-state supercell diagnostics auditable and prevents a file-seeded run from masquerading as a uniform-initial-state relaxation. | `crates/fullmag-cli/src/orchestrator.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py -q -k initial_magnetization_state_override`, `CARGO_TARGET_DIR=/tmp/fullmag-cli-check CARGO_INCREMENTAL=0 RUSTFLAGS='-Cdebuginfo=0' cargo check -p fullmag-cli --tests`, and `cargo test -p fullmag-cli initial_magnetization_state_override_records_runtime_provenance` using the same lightweight target. |
| 2026-07-01 | Added the runtime consumer side for controlled repeated-state M5 experiments. Script mode now accepts `--initial-magnetization-state` plus optional format/dataset/sample-index flags and injects the loaded sampled magnetization as the first-stage continuation state before the initial live-state preview and solver execution. `just verify-fem-static-pbc-demag-supercell-repeated-state-runtime` prepares unit/supercell artifacts, writes the repeated-unit sampled state, then reruns the 3x3 exchange-coupled supercell with that state through the headless managed runtime path. At introduction this was diagnostic infrastructure with a remesh-tolerant `1e-8` default; that default is superseded by the strict `1e-12` preflight entry above, and M5 still requires same-local-discretization or explicitly validated interpolation plus passing primitive-vs-supercell metrics. | `crates/fullmag-cli/src/args.rs`, `crates/fullmag-cli/src/main.rs`, `crates/fullmag-cli/src/orchestrator.rs`, `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_periodic_antidot_relaxation_runtime_targets.py scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py -q`, `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile scripts/test_periodic_antidot_relaxation_runtime_targets.py scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py scripts/write_fem_static_pbc_repeated_unit_initial_state.py`, `cargo fmt`, `CARGO_TARGET_DIR=/tmp/fullmag-cli-check CARGO_INCREMENTAL=0 RUSTFLAGS='-Cdebuginfo=0' cargo check -p fullmag-cli --tests`, `cargo test -p fullmag-cli script_mode_accepts_initial_magnetization_state_flag`, and `cargo test -p fullmag-cli initial_live_state_uses_loaded_initial_magnetization_override` using the same lightweight target. |
| 2026-07-01 | Added a preparatory repeated-unit initial-state producer for strict-M5 supercell fixture work. `scripts/write_fem_static_pbc_repeated_unit_initial_state.py` maps primitive `m_final.json` onto a repeated supercell `mesh/node_geometry.v1.json` by reducing supercell magnetic-node coordinates modulo the primitive lateral periods, writes a sampled `m` state plus `fem_static_pbc_repeated_unit_initial_state.v1` provenance, and is exposed through `just write-fem-static-pbc-demag-repeated-unit-initial-state` with an explicit nearest-node tolerance. The default `1e-12 m` threshold is intentionally strict for same-local-discretization repeated meshes; the current independently remeshed 3x3 artifacts reject at that threshold and only produce a diagnostic state with `max_nearest_distance_m=1e-8`, reporting `max_nearest_unit_node_distance_m=5.710e-9` and `mean_nearest_unit_node_distance_m=1.349e-9`. This prepares the controlled/frozen-supercell experiment but does not close M5 or unblock periodic-airbox response/eigen promotion. | `scripts/write_fem_static_pbc_repeated_unit_initial_state.py`, `scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `.fullmag/reports/fem-static-pbc-demag-supercell-runtime/states/m_repeated_unit.report.json`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py scripts/test_periodic_antidot_relaxation_runtime_targets.py -q`, `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile scripts/write_fem_static_pbc_repeated_unit_initial_state.py scripts/test_write_fem_static_pbc_repeated_unit_initial_state.py`, strict-target rejection at `1e-12 m`, and diagnostic generation at `1e-8 m`; run the full focused strict-M5 group and `git diff --check` before claiming the whole slice complete. |
| 2026-07-01 | Promoted relaxation-state comparability from passive supercell diagnostics to a strict-M5 acceptance metric. `fem_static_pbc_supercell_validation.v1` now includes `relaxation_state_mean_deviation_relative_error` in `metrics` and `thresholds`, and the periodic-antidot validator independently requires `relaxation_state_comparability` plus consistency between that diagnostic section and the metric value. The current managed primitive-vs-3x3 report still fails, now also with `relaxation_state_mean_deviation_relative_error=5.868e-1 > 2.0e-1`, which identifies the next required work as a controlled repeated/frozen-equilibrium or same-local-discretization supercell fixture rather than threshold relaxation. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py -q`, `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile scripts/compare_fem_static_pbc_equilibrium_artifacts.py scripts/validate_fem_periodic_antidot_relaxation_artifacts.py scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, and regeneration of the failing current supercell report. |
| 2026-07-01 | Added relaxation-state diagnostics to the strict-M5 primitive-vs-supercell report. `fem_static_pbc_supercell_validation.v1` now records `relaxation_state_comparability` with primitive and central-cell average magnetization, average-m L2 delta, and node-wise mean/max deviations from the primitive average. This does not relax any acceptance threshold; it makes the current failing 3x3 report distinguish a demag/PBC operator mismatch from a different independently relaxed central-cell state. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with `python3 -m pytest scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py -q` and `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile scripts/compare_fem_static_pbc_equilibrium_artifacts.py scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`; regenerate the managed report and run the full focused strict-M5 group before claiming the slice complete. |
| 2026-07-01 | Ran the strict managed primitive-vs-3x3 supercell path through artifact preparation, automatic central-cell extraction, and report generation. The infrastructure now produces a real `fem_static_pbc_supercell_validation.v1` report without manual index/scalar inputs, and the earlier false `average_m` failure was fixed by excluding airbox nodes from the primitive-cell average. The resulting report still has `status="failed"`: `e_demag_density_relative_error=3.752e-2`, `h_demag_stats_relative_error=6.752e-2`, `demag_phi_max_abs_delta_A=9.072e-5`, and `central_cell_torque_residual_relative_error=5.545e-1`. The report also records mesh-comparability diagnostics: the primitive has 8278 magnetic nodes while the extracted central cell has 3126, so global count comparison is not clean enough to explain the physics metrics alone and a same-local-discretization fixture remains useful. M5 remains the active blocker before continuing to periodic-airbox response/eigen production work. | `.fullmag/reports/fem-static-pbc-demag-supercell-runtime/unit/artifacts`, `.fullmag/reports/fem-static-pbc-demag-supercell-runtime/supercell/artifacts`, `.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/supercell_validation.v1.json`, `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, this masterplan. | Managed `just verify-fem-static-pbc-demag-supercell-runtime` rebuilt and ran both unit and supercell artifacts but failed at strict comparison; focused verification passed with `python3 -m pytest scripts/test_write_fem_static_pbc_supercell_central_cell_artifact.py scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py scripts/test_periodic_antidot_relaxation_runtime_targets.py scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py -q`, `PYTHONPYCACHEPREFIX=/tmp/fullmag-pycache python3 -m py_compile ...`, and `git diff --check`. |
| 2026-07-01 | Removed the manual-scalar bottleneck from the strict-M5 supercell extraction path. `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py` now supports `--auto-central-cell-scalars`, which computes central-cell demag energy by element-centroid magnetic tetrahedron integration using `metadata.execution_plan.backend_plan.mesh`, `m_final.json`, and `H_demag.zarr`, and computes central-cell torque from exported `H_eff.zarr`. The exchange-coupled primitive and 3x3 supercell examples now request `H_eff`, `mesh/node_geometry.v1.json` declares `H_eff` node-index alignment, and `verify-fem-static-pbc-demag-supercell-runtime` no longer requires central-cell scalar environment variables. M5 remains open until fresh strict managed runtime reports pass for the same workload. | `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `crates/fullmag-runner/src/artifacts.rs`, `examples/fem_periodic_antidot_relax_exchange_coupled.py`, `examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN auto-scalar writer tests, runtime-target static tests, and node-geometry validator tests; run the full focused strict-M5 script group, `py_compile`, managed runtime rebuild/proof, and `git diff --check` before claiming this slice complete. |
| 2026-07-01 | Removed the manual-index bottleneck from the strict-M5 supercell extraction path. `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py` now supports `--auto-central-cell-indices`, which requires `mesh/node_geometry.v1.json`, validates node-index alignment for `m`, `H_demag`, and `demag_phi`, and selects central-cell magnetic-node/field indices from the repeated geometry bounds. This made the strict runtime path depend only on the remaining scalar values at that step; the later auto-scalar row above removes that remaining manual input. | `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN auto-selection tests and target-contract tests; run the focused strict-M5 script group, `py_compile`, `just --dry-run verify-fem-static-pbc-demag-supercell-runtime`, and `git diff --check` before claiming this slice complete. |
| 2026-06-30 | Added the missing geometry provenance needed by the strict-M5 supercell preparation workflow. When periodic-antidot runtime metadata carries `supercell_repeat`, `fullmag-runner` now writes `mesh/node_geometry.v1.json` with FEM node coordinates, magnetic-node mask, magnetic node count, and node-index alignment for `m`, `H_demag`, and `demag_phi`. The `--supercell-repeat` validator now requires that artifact and checks its node counts and field alignment. This does not generate the strict report by itself, but it removes the previous audit gap where central-cell index selection had to be inferred outside the artifact root. | `crates/fullmag-runner/src/artifacts.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with focused `fullmag-runner` unit tests for writing the repeated-cell geometry artifact and not writing it for primitive periodic-antidot artifacts, plus validator tests for accepting supercell metadata with node geometry and rejecting missing node geometry; run the focused strict-M5 script group, `py_compile`, `just --dry-run prepare-fem-static-pbc-demag-supercell-runtime-artifacts`, and `git diff --check` before claiming the turn complete. |
| 2026-06-30 | Hardened the strict-M5 supercell preparation target so it validates the artifacts it just produced. `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py` now has an explicit `--supercell-repeat REPEAT_X REPEAT_Y` mode that accepts a prepared repeated artifact only when `problem_name`, `metadata.periodic_antidot_relaxation.supercell_repeat`, and lateral `universe_size_m` match the requested repeat; primitive validation still rejects supercell metadata. `just prepare-fem-static-pbc-demag-supercell-runtime-artifacts` now validates both the primitive artifact and the 3x3 repeated artifact before returning. This still does not close M5 because central-cell extraction and the strict supercell comparison report remain separate. | `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `justfile`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan, `.fullmag/reports/fem-static-pbc-demag-supercell-runtime/*`. | Verified with RED/GREEN supercell validator tests, focused runtime-target static tests, `just --dry-run prepare-fem-static-pbc-demag-supercell-runtime-artifacts`, and the validator run on the fresh 3x3 supercell runtime log with `--supercell-repeat 3 3`; run the full focused strict-M5 script test group and `git diff --check` before claiming this slice complete. |
| 2026-06-30 | Split strict-M5 supercell runtime preparation from strict report generation. `just prepare-fem-static-pbc-demag-supercell-runtime-artifacts` now runs the primitive and 3x3 exchange-coupled supercell managed runtime artifacts without requiring central-cell extraction inputs, while `just verify-fem-static-pbc-demag-supercell-runtime` remains the strict wrapper that requires indices/scalars before writing the central-cell extraction artifact and comparison report. The central-cell writer now accepts comma-separated index lists or files containing comma/newline/JSON index lists. This unblocks preparing the concrete supercell artifact roots needed to determine central-cell extraction data; it does not by itself close M5. | `justfile`, `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `scripts/test_write_fem_static_pbc_supercell_central_cell_artifact.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN file-index parsing and supercell prepare-target static tests; run focused strict-M5 script tests, `py_compile`, `just --dry-run prepare-fem-static-pbc-demag-supercell-runtime-artifacts`, and `git diff --check` before claiming this slice complete. |
| 2026-06-30 | Reworked the strict-M5 static z-padding acceptance metric after the managed candidate/reference run exposed a mesh-dependent global-max outlier. The report writer and runtime validator now gate z-padding on demag-energy relative error, `p99(|H_demag|)` relative error, and `demag_phi` range relative error while retaining global `|H_demag|` maximum and absolute `demag_phi` deltas as diagnostics. The fresh exchange-coupled z-padding artifacts now produce `status="ok"` with `e_demag_relative_error=5.76e-3`, `h_demag_p99_relative_error=5.28e-3`, and `demag_phi_range_relative_error=2.89e-3`; M5 still requires the strict supercell report and full equilibrium gate. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, `.fullmag/reports/fem-static-pbc-demag-equilibrium-runtime/reports/z_padding_validation.v1.json`. | Verified with a RED/GREEN robust-field-stat z-padding report test, validator excessive-robust-H test, and regeneration of the z-padding report from the managed runtime artifacts. |
| 2026-06-30 | Added a canonical strict-M5 supercell runtime path for the exchange-coupled antidot workload. `examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py` expands the primitive workload to a 600 nm x 600 nm x 90 nm 3x3 repeated antidot supercell with the same `x/y` PBC and open `z`, while `just verify-fem-static-pbc-demag-supercell-runtime` runs primitive/supercell artifacts through the managed FEM runtime, writes the explicit central-cell extraction artifact from supplied index/value inputs, and writes the default `fem_static_pbc_supercell_validation.v1` report. This still does not close M5 without fresh runtime data and the full strict equilibrium gate. | `examples/fem_periodic_antidot_relax_exchange_coupled_supercell_3x3.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN Python DSL example export tests, runtime-target static tests including missing-input guard ordering, the focused strict-M5 script group, `py_compile`, `just --dry-run` for the z-padding/supercell targets, expected supercell missing-input rejection, and `git diff --check`; fresh runtime artifacts remain required. |
| 2026-06-30 | Added a canonical strict-M5 z-padding runtime path for the exchange-coupled antidot workload. `examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py` keeps the same 200 nm x 200 nm x 10 nm film and `x/y` PBC as the candidate but increases the open-`z` airbox to 130 nm, while `just verify-fem-static-pbc-demag-z-padding-runtime` runs candidate/reference artifacts through the managed FEM runtime and writes the default `fem_static_pbc_z_padding_validation.v1` report. This still does not close M5 without the fresh supercell report and strict equilibrium gate. | `examples/fem_periodic_antidot_relax_exchange_coupled_z_padding_reference.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN Python DSL example export tests, runtime-target static tests, the focused strict-M5 script group, `py_compile`, `just --dry-run verify-fem-static-pbc-demag-z-padding-runtime`, and `git diff --check`; fresh runtime artifacts remain required. |
| 2026-06-30 | Hardened the strict M5 central-cell extraction producer against impossible scalar inputs: `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py` now reads supercell `metadata.json` and rejects a supplied central-cell demag energy above global supercell `E_demag` or a supplied central-cell torque above global `final_torque_apm`. The producer still does not infer central-cell energy from total supercell energy; it only rejects values that cannot be a central-cell subset statistic. | `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_write_fem_static_pbc_supercell_central_cell_artifact.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN producer tests plus the focused strict M5 script group, `py_compile`, and `git diff --check`; fresh strict runtime reports remain required for production closure. |
| 2026-07-01 | Fixed a likely primitive-vs-supercell PBC-demag mismatch source: native FEM Poisson-Robin airbox now computes the Robin reference radius from non-periodic open-axis extents when periodic node pairs are present, so repeating a cell in periodic `x/y` directions no longer changes the open-`z` Robin impedance. | `backends/fem/cpu/mfem/interactions/demag_poisson_boundary.cpp`, `backends/fem/tests/demag_poisson_contract.cpp`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with `just verify-fem-demag-poisson-contract`, C++ formatting checks, and fresh M5 primitive-vs-supercell runtime reports before claiming closure. |
| 2026-07-01 | Hardened static PBC-demag runtime provenance so `periodic_airbox_k0` cannot be inferred from generic `airbox/robin` metadata. FEM relaxation artifacts now publish the physical magnetostatic boundary model, `pbc_reduced_poisson`, and `P^T A P` periodic-reduction counts; the periodic-antidot validator rejects PBC-demag artifacts without that proof. | `crates/fullmag-runner/src/artifacts.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with `CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-runner demag_profile_metadata`, `PYTHONPATH=packages/fullmag-py/src python3 -m pytest scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py -q`, py_compile, and diff check. |
| 2026-06-30 | Closed the same-size supercell loophole in strict M5 reporting: `scripts/compare_fem_static_pbc_equilibrium_artifacts.py` now requires primitive-vs-supercell reports to compare a unit cell against a repeated artifact whose lateral `universe_size_m` is scaled by `repeat_x/repeat_y` and whose open-`z` size matches the unit cell. The runtime validator now also rejects hand-written z-padding/supercell reports whose workload omits or changes lateral air gap, periodic pair ids, exchange-coupling intent, or required supercell geometry. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with RED/GREEN report-writer and validator tests; rerun the focused strict M5 script group, `py_compile`, `git diff --check`, and strict-target missing-report rejection before claiming the turn complete. |
| 2026-06-30 | Closed the same-airbox z-padding loophole in strict M5 reporting: `scripts/compare_fem_static_pbc_equilibrium_artifacts.py` now requires z-padding reports to compare an `x/y` periodic, open-`z` candidate against a same-lateral-size reference with larger open-`z` `universe_size_m`, and `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py` rejects hand-written z-padding reports that omit or invert that geometry. CPU/GPU ordinary relaxation artifacts with identical airboxes can no longer satisfy the z-padding gate. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verified with focused report-writer and validator RED/GREEN tests, the 63-test strict M5 script group, `py_compile`, and `git diff --check`; fresh strict runtime reports are still required for production closure. |
| 2026-06-30 | Added an explicit central-cell extraction artifact producer for strict M5 supercell comparison. `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py` writes `diagnostics/fem_static_pbc_supercell_central_cell.v1.json` from supplied central-cell magnetic-node indices, field-cell indices, demag energy, and torque residual, validates those indices against resolved `m_final`, `H_demag`, and `demag_phi` artifacts, and is exposed through `just write-fem-static-pbc-demag-supercell-central-cell-artifact`. The producer intentionally does not infer central-cell energy from total supercell energy. | `scripts/write_fem_static_pbc_supercell_central_cell_artifact.py`, `scripts/test_write_fem_static_pbc_supercell_central_cell_artifact.py`, `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verify with producer pytest, runtime-target static tests, the focused strict M5 pytest group, py_compile, strict-target missing-report rejection, and diff check. |
| 2026-06-30 | Added a planner regression proving that M5 FEM static demag PBC is not hard-coded to lateral `x/y` films: a single-axis `z` periodic airbox with open `x/y` boundaries and `ProblemIR.pbc.demag = "periodic_airbox_k0"` plans, while the existing full `x/y/z` rejection remains in place for the current non-full-3D airbox slice. | `crates/fullmag-plan/src/tests.rs`, this masterplan. | Verified with `env CARGO_TARGET_DIR=/tmp/fullmag-cargo-target cargo test -p fullmag-plan fem_static_time_domain_plans_exchange_only_periodic_mesh_pairs -- --nocapture`. |
| 2026-06-30 | Hardened primitive-vs-supercell strict M5 reporting: `scripts/compare_fem_static_pbc_equilibrium_artifacts.py` now requires `diagnostics/fem_static_pbc_supercell_central_cell.v1.json` from the supercell artifact root and computes `m`, `H_demag`, `demag_phi`, demag energy, and torque metrics from that central-cell extraction instead of global supercell statistics. The runtime validator requires the generated report to carry the central-cell extraction summary. This is still infrastructure; fresh strict z-padding and supercell runtime artifacts for the same workload remain required. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verify RED/GREEN with missing-central-cell and global-average masking tests, then run the focused strict M5 pytest group, py_compile, strict-target missing-report rejection, and diff check. |
| 2026-06-30 | Hardened the strict M5 report consumer: the periodic-antidot validator no longer trusts `status="ok"` alone for `fem_static_pbc_z_padding_validation.v1` or `fem_static_pbc_supercell_validation.v1`; it independently rejects static-demag z-padding and primitive-vs-supercell metrics that exceed the strict thresholds. This closes the hand-written/forged-report loophole, but it is still infrastructure and not a fresh strict workload acceptance. | `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, this masterplan. | Verify RED/GREEN with the excessive-metric report tests, then run the focused validator/report/runtime-target pytest group, py_compile, strict-target missing-report rejection, and diff check. |
| 2026-06-30 | Added the strict M5 static-comparison report writer and hardened the strict equilibrium target: `scripts/compare_fem_static_pbc_equilibrium_artifacts.py` now emits `fem_static_pbc_z_padding_validation.v1` and `fem_static_pbc_supercell_validation.v1` from real artifact roots, rejects self-comparison and incompatible-workload roots, records workload identity, the periodic-antidot validator rejects missing or mismatched report workload metadata, `just verify-fem-static-pbc-demag-z-padding-artifacts` and `just verify-fem-static-pbc-demag-supercell-artifacts` expose managed entry points, and `just verify-fem-static-pbc-demag-equilibrium-runtime` now rejects missing report paths instead of silently running only the ordinary CPU/GPU relaxation gates. This is infrastructure for strict M5; it is not yet a fresh strict workload acceptance. | `scripts/compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/test_compare_fem_static_pbc_equilibrium_artifacts.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `justfile`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with focused report-writer tests including self-comparison and workload-mismatch rejection, validator tests for missing/mismatched workload metadata, runtime-target static tests, py_compile, strict-target missing-report rejection, and diff check. |
| 2026-06-30 | Closed the immediate M5 false-PBC GPU seam regression and corrected the air-gap topology rule: ordinary managed CPU/GPU periodic-antidot relaxation gates now pass for both `exchange_coupled` and `air_gap`; GPU recovered `H_demag` is projected onto static periodic classes before energy/snapshot diagnostics; `exchange_coupled` still requires magnetic plus airbox seam coverage, while separated-island `air_gap` accepts airbox-only side seams with `magnetic=0` when `phi`/`H_demag`/normal-flux/side-charge diagnostics pass. Strict M5 production acceptance still requires z-padding and primitive-vs-supercell reports for the same workload. | `backends/fem/gpu/cuda/demag_poisson/stage_compute.cpp`, `backends/fem/tests/relaxation_source_contract.cpp`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verified with `just verify-fem-relaxation-source-contract`, `python3 -m pytest scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py -q`, `just verify-fem-periodic-antidot-relaxation-runtime`, and `just verify-fem-periodic-antidot-relaxation-gpu-runtime`; final sanity checks still required after documentation edits. |
| 2026-06-30 | Made the M5 false-PBC guard runtime-visible: `write_artifacts(...)` now emits `diagnostics/fem_static_pbc_demag_seams.v1.json` for FEM static/time-domain `periodic_airbox_k0` demag runs, deriving `m`, `H_demag`, gauge-adjusted `phi`, normal `B` flux, and side magnetic charge metrics from final fields and periodic mesh pairs. Missing required fields or face pairs produce `status="failed"` artifacts rather than passing by omission. | `crates/fullmag-runner/src/artifacts.rs`, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verified with RED/GREEN `cargo test -p fullmag-runner write_artifacts_persists_static_pbc_demag_seam_diagnostics -- --nocapture`, periodic-pairs artifact regression tests, periodic-antidot validator pytest, py_compile, and diff check; managed CPU/GPU M5 runtime proof remains pending. |
| 2026-06-30 | Hardened the M5 validator against the concrete false-PBC failure mode: accepted periodic-antidot relaxation artifacts now must include same-step `diagnostics/fem_static_pbc_demag_seams.v1.json` with per-pair `m`, `H_demag`, gauge-adjusted `phi`, normal `B` flux, and side magnetic charge metrics. The validator rejects missing seam diagnostics, excessive `b_normal_flux_seam_max_T`, and non-cancelled `side_magnetic_charge_sum_abs_Am`. | `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/frequency-domain-artifacts-v2.md`. | Verified RED/GREEN with focused pytest for the new seam diagnostics tests; run the full validator pytest, py_compile, diff check, and then the managed M5 runtime gate on fresh artifacts. |
| 2026-06-30 | Downgraded/clarified the M5 static-PBC demag wording after the false-PBC audit: reference/source-visible reduced-Poisson evidence no longer reads as production acceptance for the antidot/magnonic-crystal workload, and the plan now explicitly rejects magnetization-only periodic projection when `phi`/`H_demag` still behave like a finite isolated airbox. M5 acceptance now requires same-step `m`, gauge-adjusted `phi`, `H_demag`, normal `B` flux/seam diagnostics, no artificial side-edge magnetic charges, and primitive-vs-supercell agreement for the accepted workload, with a uniform slab false-PBC test before the hole geometry. | User false-PBC audit, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/capability-matrix-v0.md`, this masterplan. | Documentation/status change; verify with content scans for overclaiming terms and `git diff --check`. |
| 2026-06-30 | Propagated the hardened M5 periodic-pairs contract into the v2 mesh resource: `/v2/sessions/current/meshing/mesh/periodic_pairs.v1` now preserves `domain_node_pair_counts` and `boundary_face_pairs` for both live `FemMeshPayload` responses and artifact-file fallback, so Control Room/API consumers can detect magnetic-only false PBC instead of seeing only valid translation residuals. The remaining response-map test fixture now uses a non-HTTP resource key instead of inventing an unimplemented `/v2/...response-map.v2` endpoint. | `crates/fullmag-api/src/schemas/mesh.rs`, `crates/fullmag-api/src/router_v2/handlers/meshing/mesh.rs`, `crates/fullmag-api/src/router_v2/tests.rs`, `apps/control-room/src/kernel/api/generated/openapi-v2.json`, `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`, `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`, `docs/specs/frequency-domain-artifacts-v2.md`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verified with RED/GREEN focused `cargo test -p fullmag-api mesh_periodic_pairs -- --nocapture`, `pnpm --dir apps/control-room generate:api`, `pnpm --dir apps/control-room test src/kernel/api/openapiV2GeneratedContract.test.ts`, `pnpm --dir apps/control-room test src/modules/explorer/builders/buildModelTree.test.ts`, `pnpm --dir apps/control-room typecheck`, `pnpm --dir apps/control-room lint`, `pnpm --dir apps/control-room check:api-hygiene`, and `rustfmt --edition 2021 --check` on touched Rust API files. |
| 2026-06-30 | Propagated the M5 magnetic-plus-airbox PBC diagnostic contract into the runner artifact writer: `mesh/periodic_pairs.v1.json` now emits `domain_node_pair_counts` and `boundary_face_pairs` with face translations and normal-orientation diagnostics, so fresh runtime artifacts have a path to satisfy the hardened validator. | `crates/fullmag-runner/src/artifacts.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with focused runner periodic-pairs artifact tests, periodic-antidot artifact-validator tests, py_compile, diff check, and the managed M5 runtime gate when running full proof. |
| 2026-06-30 | Hardened the M5 periodic-pairs artifact against magnetic-only false PBC: accepted `periodic_pairs.v1` diagnostics now require airbox node-pair coverage plus non-empty opposed-normal boundary-face pairs on every selected seam, and require magnetic coverage only for geometries where magnetic material crosses that seam. | `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with periodic-antidot artifact-validator tests, py_compile, diff check, and the managed M5 runtime gate when running full proof. |
| 2026-06-30 | Made the M5 scalar-potential seam diagnostic gauge-aware: periodic-antidot validation still requires same-step `demag_phi`, but now measures `phi` seam residual after subtracting the best constant offset per periodic pair id, while `m` and `H_demag` remain directly periodic. | `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with the periodic-antidot artifact-validator tests, py_compile, diff check, and the managed M5 runtime gate when running full proof. |
| 2026-06-30 | Tightened the M5 static-PBC acceptance contract after the false-PBC audit: the documented FEM static/time-domain contract now treats PBC as selected-axis physics, including valid `z`-periodic non-full-3D cells, while the current antidot fixture remains explicitly `x/y` periodic with open `z`. The periodic-antidot managed CPU/GPU recipes can now require strict z-padding and primitive-vs-supercell reports through validator flags before accepting the M5 equilibrium gate. | `docs/physics/0800-fem-static-pbc-demag.md`, `justfile`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_periodic_antidot_relaxation_runtime_targets.py`. | Verify with the periodic-antidot artifact-validator tests, runtime-target static tests, py_compile, diff check, and the managed M5 runtime gate when running full proof. |
| 2026-06-30 | Tightened the M5 scalar-potential equilibrium artifact contract: periodic-antidot examples now request `demag_phi`, the export test requires it beside `m` and `H_demag`, and the runtime validator rejects missing, wrong-step, non-finite, or seam-mismatched `fields/demag_phi/step_*.json` artifacts. | `examples/fem_periodic_antidot_relax_exchange_coupled.py`, `examples/fem_periodic_antidot_relax_air_gap.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/capability-matrix-v0.md`. | Verify with periodic-antidot export tests, periodic-antidot artifact-validator tests, py_compile, diff check, and the managed M5 runtime gate when running full proof. |
| 2026-06-30 | Synchronized the M5 static-PBC demag contract across physics and capability docs: static/time-domain FEM demag PBC now requires `ProblemIR.pbc.demag = "periodic_airbox_k0"` in the documented planner contract, while strict GPU periodic demag is described as source-supported but still unqualified until the managed M5 GPU PBC gate proves device Poisson provenance. The M5 artifact contract now requires explicit `node_pairs` in `mesh/periodic_pairs.v1.json` and validates final `m`/`H_demag` seam mismatch across those pairs. | `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/capability-matrix-v0.md`, `backends/fem/tests/cuda_periodic_demag_contract.cpp`, `crates/fullmag-runner/src/artifacts.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`. | Verify with docs scan, diff check, and the existing focused planner/API/validator tests before running the managed M5 gate. |
| 2026-06-30 | Tightened the M5 static-PBC axis contract: public `study.pbc(z=True)` now has an explicit Python DSL regression test for `z_faces`, the FEM planner rejects static/time-domain PBC meshes whose inferred periodic axes do not match `ProblemIR.pbc.axes`, and the antidot examples are documented as intentional 2D film-array PBC cases with open `z`, not as an API limitation. | `packages/fullmag-py/tests/test_api.py`, `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-plan/src/tests.rs`, `examples/fem_periodic_antidot_relax_air_gap.py`, `examples/fem_periodic_antidot_relax_exchange_coupled.py`, `docs/physics/0800-fem-static-pbc-demag.md`, `docs/specs/capability-matrix-v0.md`. | Verify with focused Python PBC/API tests, focused FEM planner test, py_compile, and diff check; managed M5 runtime proof remains separate. |
| 2026-06-30 | Fixed the GPU relaxation PBC seam contract for M5: periodic pair requests are now explicit in exported FEM mesh options and mesh-cache fingerprints, and GPU projected-gradient BB / nonlinear-CG project trial magnetisation onto static periodic classes immediately after retraction before evaluating demag energy. | `packages/fullmag-py/src/fullmag/world.py`, `packages/fullmag-py/src/fullmag/model/problem.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `backends/fem/gpu/cuda/relaxation/pgbb.cpp`, `backends/fem/gpu/cuda/relaxation/nonlinear_cg.cpp`, `backends/fem/gpu/cuda/relaxation/pgbb_kernels.*`, `backends/fem/tests/relaxation_source_contract.cpp`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with periodic-antidot export tests, py_compile, diff check, native relaxation source contract, and the managed GPU PBC runtime gate when running full proof. |
| 2026-06-30 | Tightened the M5 periodic-antidot runtime proof so accepted artifacts must publish top-level `metadata.pbc` copied from `ProblemIR.pbc`, final equilibrium field `m_final.json`, same-step demag field snapshot `fields/H_demag/step_*.json`, scalar history `scalars.csv`, a resolved `mesh/periodic_pairs.v1.json` diagnostic artifact, and converged demag Poisson telemetry; the validator now rejects periodic-antidot runs that only prove mesh periodic-pair topology without the physical PBC intent, only report pair counts in `metadata.json`, omit the field/demag artifacts, publish non-finite field vectors, have mismatched `m_final`/`H_demag` steps, have increasing final total energy, or report `final_residual_norm > relative_tolerance`. | `examples/fem_periodic_antidot_relax_exchange_coupled.py`, `examples/fem_periodic_antidot_relax_air_gap.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `crates/fullmag-runner/src/artifacts.rs`, `scripts/validate_fem_periodic_antidot_relaxation_artifacts.py`, `scripts/test_validate_fem_periodic_antidot_relaxation_artifacts.py`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with periodic-antidot export tests, focused runner artifact metadata test, periodic-antidot artifact-validator tests, runtime-target static tests, diff check, and the managed `just verify-fem-static-pbc-demag-equilibrium-runtime` gate when running the full CPU/GPU PBC proof. |
| 2026-06-30 | Made M5 periodic-antidot static PBC explicit in the public problem contract: `study.pbc(x=True, y=True, demag="periodic_airbox_k0")` now serializes `ProblemIR.pbc` and derives FEM mesh `x_faces/y_faces` pair requests, while the FEM planner rejects static/time-domain meshes that carry periodic node pairs without `ProblemIR.pbc` and rejects FEM demag PBC when `ProblemIR.pbc.demag` remains `open`. Mesh pair metadata is topology only and no longer acts as an implicit physical PBC switch. | `packages/fullmag-py/src/fullmag/world.py`, `examples/fem_periodic_antidot_relax_exchange_coupled.py`, `examples/fem_periodic_antidot_relax_air_gap.py`, `packages/fullmag-py/tests/test_api.py`, `packages/fullmag-py/tests/test_periodic_antidot_relaxation_example.py`, `crates/fullmag-plan/src/fem.rs`, `crates/fullmag-plan/src/tests.rs`, `docs/physics/0800-fem-static-pbc-demag.md`. | Verify with focused Python PBC/API tests, periodic-antidot export tests, focused FEM planner test, diff check, and then the managed `just verify-fem-periodic-antidot-relaxation-gpu-runtime` gate for full GPU PBC proof. |
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
