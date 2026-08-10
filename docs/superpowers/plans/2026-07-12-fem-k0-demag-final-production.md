# FEM K0 Dynamic-Demag Final Production Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Production-qualify FEM K0 dynamic-demag eigensolve on CPU and GPU and deliver the complete Python/UI authoring, Spectrum, mode-field artifact, and unified 3D viewport workflow.

**Architecture:** One physics-first request flows through Python DSL, ProblemIR, legality-first planning, accepted equilibrium and periodic-mesh certificates, native MFEM assembly, certified Schur eigensolve, artifacts-v2, OpenAPI v2 resources, ControlRoom resource hooks, Analysis Plots, mode inspectors, and the unified 3D viewport. CPU and GPU share the managed real-split `real_frequency_rotated` pencil, units, block residuals, validation scope, and artifacts; they use independent MFEM/PETSc/SLEPc/hypre runtime realizations and never share hidden device state.

**Tech Stack:** Python 3, Rust, C++20, MFEM, PETSc/SLEPc, hypre, CUDA, Axum/OpenAPI v2, Next.js 16, React, TypeScript, Zustand, R3F/Three.js, Zarr/binary field codecs, Playwright, container-backed `just` recipes.

## Global Constraints

- Canonical physics is `L q = lambda B_alpha q`, `lambda=i omega`, `delta_m=Tq`, and `delta_H_demag=-grad(delta_phi)`.
- The managed PETSc/SLEPc runtime is real scalar: selected spectrum uses `R(L)y=omega R(i B_alpha)y` with `tau=omega_target`; real targeting on the original imaginary-axis pencil is forbidden.
- The first qualified scope is P1, `alpha=0`, double precision, uniform material fields, `k=(0,0,0)`, x/y periodicity, and an open-z shared magnetic-plus-airbox domain.
- Static `H_demag0` belongs to the accepted equilibrium and must never substitute for the dynamic Frechet action on `delta_m`.
- Robin and Dirichlet use `gauge_policy=none`; pure Neumann uses `mean_zero_augmented`.
- Fully 3D periodic K0, nonzero-k dynamic demag, nonzero-k DMI, damping, and nonuniform-texture production qualification remain fail-closed.
- Synthetic and dense one-thread paths remain validation-only and cannot emit production claims.
- Strict GPU requests never fall back to CPU; auto fallback is legal only for the identical physical contract and must be explicit in plan and provenance.
- Production artifacts use `assembly_kind=mfem_weak_form_shared_domain` and bind one content-addressed `frequency_domain_validation_scope.v1`.
- Heavy mode fields use the binary data plane; status and analysis JSON remain thin and revisioned.
- Control Room uses generated OpenAPI v2 transport, `ControlRoomApi`, resource hooks, domain adapters, one command registry, Analysis Plots, and one unified viewport.
- Viewport rendering is demand-driven, topology lifetime is independent from field-buffer lifetime, and all WebGL resources are disposed on unmount.
- Native FEM builds and runtime proof start and finish with repository container-backed `just` recipes.
- Capability promotion occurs only after DOD-01 through DOD-14 pass for the exact CPU or GPU scope.

## Current recovery status (2026-08-05)

The implementation portion of this plan is substantially present in the
recovery worktree: the Python/ProblemIR/planner contracts, ABI v3, shared-domain
CPU Schur route, GPU PETSc/SLEPc CUDA adapter, runner cancellation/progress,
artifacts-v2 sidecars, performance/evidence verifiers, Spectrum/mode-field UI,
and unified-viewport resource tests are in source. Focused Rust/Python tests,
the masterplan pack check, Control Room typecheck, and 134 focused UI tests
pass in the current worktree.

The unchecked boxes below remain an acceptance checklist, not a claim that
the feature is production-qualified. A fresh managed runtime export is still
blocked by `.fullmag/runtimes/.fem-gpu-host.export.lock`; the current runtime
pointer is stale for the dirty source snapshot. Until that lock is resolved,
the fresh CPU/GPU solve, mesh/airbox convergence, parity/performance,
executed-device residency, browser-native mode-field proof, scope catalog and
DOD-01..DOD-14 release record remain open. The plan is FEM-only: FDM has
time-domain/FFT spectrum analysis but no modal Eigenmodes/FrequencyResponse
eigensolve lane under this scope.

## Production Deliverables

1. Canonical Python/UI/ProblemIR round-trip for K0 periodic-airbox modal demag.
2. Accepted `EquilibriumArtifact.v6`, `LinearizationState.v6`, and `periodic_mesh_certificate.v6` materialized and consumed by native assembly.
3. Real shared-domain MFEM blocks, certified Schur reduction, complex-frequency selected spectrum, and complete native mode results.
4. Persistent GPU modal engine with device-resident vectors, basis, operator, preconditioner, and hot loop.
5. Complete artifacts-v2 bundle, scope catalog, validation sidecars, OpenAPI v2 resources, and binary mode-field data plane.
6. Production Spectrum, mode table, diagnostics, mode selection, and 3D real/imag/magnitude/phase visualization.
7. Independent physics, convergence, CPU/GPU parity, performance, residency, negative-control, browser, and release evidence.

---

### Task 1: Align canonical docs, ADR decisions, and production scope

**Files:**
- Modify: `docs/physics/0830-fem-poisson-airbox-modal-eigen.md`
- Modify: `docs/physics/0831-fem-dynamic-pencil-modal-response-and-krylov.md`
- Modify: `docs/architecture/backend-golden-masterplan.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/12_adr_decisions.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/18_poisson_airbox_eigensolve_cpu_gpu_implementation.md`
- Modify: `docs/plans/active/fd_sovler_masterplan/documentation_manifest.json`
- Regenerate: `docs/plans/active/fd_sovler_masterplan/fd_solver_plan_FULL_PACK_COMSOL_ALIGNED_V5.md`
- Test: `scripts/build_fd_solver_masterplan_full_pack.py`

**Interfaces:**
- Consumes: approved design `docs/superpowers/specs/2026-07-12-fem-k0-demag-cpu-gpu-production-design.md`.
- Produces: one canonical K0 CPU/GPU scope and one documented PETSc/SLEPc target representation.

- [ ] Add failing documentation assertions that require K0 CPU stages P1-P6, GPU stages G1-G4, DOD-01 through DOD-14, Spectrum, mode fields, and viewport proof.
- [ ] Run `python3 scripts/build_fd_solver_masterplan_full_pack.py --check` and record the expected failure caused by changed normative inputs.
- [ ] Update the physics note, backend masterplan, ADR-017, chapter 18, and manifest so they agree on the managed real-split `real_frequency_rotated` pencil and `tau=omega_target`.
- [ ] Regenerate with `python3 scripts/build_fd_solver_masterplan_full_pack.py --write`.
- [ ] Run `python3 scripts/build_fd_solver_masterplan_full_pack.py --check`; expect zero drift.
- [ ] Commit with `git commit -m "docs: freeze production K0 modal demag scope"`.

### Task 2: Close Python DSL, SceneDocument, and ProblemIR round-trip

**Files:**
- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/world.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/scene_document.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/validate.rs`
- Test: `packages/fullmag-py/tests/test_problem_ir.py`
- Test: `packages/fullmag-py/tests/test_scene_document_roundtrip.py`
- Test: `crates/fullmag-ir/src/tests.rs`

**Interfaces:**
- Consumes: public `Eigenmodes` and existing `MagnetostaticBoundaryConditionIR`.
- Produces: canonical `Eigenmodes` fields `include_demag`, `magnetostatic_bc`, target/window, k sampling, equilibrium source, and requested execution intent.

- [ ] Write failing Python and Rust tests for `periodic_airbox_k0` with demag, periodic spin-wave BC, exactly zero k, frequency window, and strict CPU/GPU intent.
- [ ] Write negative tests for nonzero k, missing `Demag()`, open magnetic BC, fully periodic 3D K0, single precision, damping, and conflicting legacy fields.
- [ ] Extend `Eigenmodes` serialization and `StudyIR::Eigenmodes` so `magnetostatic_bc=periodic_airbox_k0` round-trips without backend implementation names.
- [ ] Extend canonical validation to emit stable reason tokens for every rejected combination.
- [ ] Run `pytest packages/fullmag-py/tests/test_problem_ir.py packages/fullmag-py/tests/test_scene_document_roundtrip.py -q` and `cargo test -p fullmag-ir`.
- [ ] Commit with `git commit -m "feat: round-trip K0 modal demag semantics"`.

### Task 3: Close Control Room study authoring and Python export

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/EigenmodesStageInspector.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/stages/FrequencyDomainCalculationModeSection.tsx`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/StudyAuthoringSmokeScript.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/StageInspectors.test.tsx`

**Interfaces:**
- Consumes: Task 2 canonical fields.
- Produces: UI-authored request and exported Python script with identical normalized semantics.

- [ ] Add failing tests that author K0 periodic-airbox demag on CPU and GPU and compare the exported Python/IR payload with the Python-authored equivalent.
- [ ] Add unavailable-state tests for missing shared-domain mesh, certificate, accepted equilibrium, and strict GPU prerequisites.
- [ ] Expose physics-first controls for demag, magnetostatic BC, equilibrium source, frequency window/count, device, and precision through shared primitives and the command registry.
- [ ] Keep backend engine names read-only in diagnostics; do not expose PETSc/SLEPc/CUDA as common authoring fields.
- [ ] Run `pnpm --dir apps/control-room test -- --run StudyStageAuthoringModel StageInspectors StudyAuthoringSmokeScript` and `pnpm --dir apps/control-room typecheck`.
- [ ] Commit with `git commit -m "feat: author K0 modal demag in Control Room"`.

### Task 4: Materialize and consume equilibrium and periodic-mesh v6 certificates

**Files:**
- Modify: `backends/fem/include/frequency_domain/equilibrium_state.hpp`
- Modify: `backends/fem/src/frequency_domain/equilibrium_state.cpp`
- Modify: `backends/fem/include/frequency_domain/mesh_symmetry_certificate.hpp`
- Modify: `backends/fem/src/frequency_domain/mesh_symmetry_certificate.cpp`
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Test: `backends/fem/tests/frequency_domain/operator_contract_test.cpp`
- Test: `crates/fullmag-runner/src/fem_eigen.rs`

**Interfaces:**
- Consumes: accepted equilibrium artifact, five signatures, full magnetic/scalar equivalence classes, and open-z boundary labels.
- Produces: `LinearizationState.v6` and `periodic_mesh_certificate.v6` keyed to the exact solve signature.

- [ ] Add failing tests for missing acceptance, torque/norm failure, stale signatures, missing `phi0` when required, incomplete corner classes, frame-cycle failure, scalar-class failure, and changed mesh invalidation.
- [ ] Materialize `LinearizationState.v6` with `m0`, `H_eff0`, `H_demag0`, conditional `phi0`, tangent frames, acceptance tolerances, producer run ID, and content hashes.
- [ ] Materialize complete magnetic and scalar periodic equivalence classes with orientation, translation, seam, frame, and topology diagnostics.
- [ ] Require native modal assembly to consume the exact certificate IDs rather than node-pair metadata alone.
- [ ] Run `just verify-fem-frequency-domain-native-contract` and focused runner tests; expect all negative controls to reject with stable tokens.
- [ ] Commit with `git commit -m "feat: consume K0 modal equilibrium and mesh certificates"`.

### Task 5: Implement legality-first planner and exact capability resolution

**Files:**
- Modify: `crates/fullmag-plan/src/fem.rs`
- Modify: `crates/fullmag-plan/src/tests.rs`
- Modify: `docs/specs/capability-matrix-v0.md`
- Modify: `docs/specs/capability-matrix-v0.json`
- Test: `crates/fullmag-plan/src/tests.rs`

**Interfaces:**
- Consumes: Tasks 2-4 canonical request and certificates.
- Produces: exactly one resolved engine: CPU selected spectrum or `gpu_modal_device_krylov`, plus requested/resolved provenance.

- [ ] Add failing tests for strict CPU, strict GPU, auto, allowed identical-physics fallback, unavailable prerequisites, unsupported precision, and illegal K0/nonzero-k certificate reuse.
- [ ] Resolve legality before heuristics; require exact equilibrium, mesh, operator, BC/gauge, target, precision, and device certificates.
- [ ] Emit requested and resolved device/precision/engine, `fallback_used`, `fallback_reason`, and a stable `selection_reason`.
- [ ] Keep current capability cells unvalidated until Tasks 11-14 provide production evidence.
- [ ] Run `cargo test -p fullmag-plan`.
- [ ] Commit with `git commit -m "feat: plan production K0 modal engines"`.

### Task 6: Version the native request and multi-mode result ABI

**Files:**
- Modify: `backends/fem/include/frequency_domain/modal_eigen_request.hpp`
- Modify: `backends/fem/include/frequency_domain/modal_eigen_result.hpp`
- Modify: `native/include/fullmag_fem.h`
- Modify: `crates/fullmag-fem-sys/src/lib.rs`
- Modify: `crates/fullmag-runner/src/native_fem/frequency_domain.rs`
- Test: `backends/fem/tests/frequency_domain/modal_eigen_contract_test.cpp`
- Test: `crates/fullmag-fem-sys/src/lib.rs`

**Interfaces:**
- Consumes: Task 5 resolved plan and Task 4 certificate IDs.
- Produces: append-only request ABI and owned multi-mode result arrays containing eigenvalues, q, reconstructed phi, Cartesian delta-m, residuals, cluster metadata, and diagnostics.

- [ ] Add failing layout, prefix-size, nullability, overflow, unknown-enum, partial-result, and release-idempotency tests.
- [ ] Add fixed-value enums for execution target, scalar representation, spectral transform, result status, and field representation.
- [ ] Define result counts and buffers explicitly: `mode_count`, `q_dof_count`, `phi_dof_count`, `mode_lambda`, `mode_q_complex`, `mode_phi_complex`, `mode_delta_m_xyz_complex`, and `mode_residuals`.
- [ ] Add one release function that frees every owned result buffer exactly once and accepts a zero/empty result.
- [ ] Separate CPU native availability from the Rust `fem-gpu` feature gate.
- [ ] Run `just verify-fem-frequency-domain-native-contract` and `cargo test -p fullmag-fem-sys`.
- [ ] Commit with `git commit -m "feat: define multi-mode FEM eigen ABI"`.

### Task 7: Assemble real shared-domain MFEM K0 descriptor blocks

**Files:**
- Create: `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.hpp`
- Create: `backends/fem/cpu/frequency_domain/operators/poisson_airbox_shared_domain.cpp`
- Create: `backends/fem/tests/frequency_domain/poisson_airbox_shared_domain_test.cpp`
- Modify: `backends/fem/CMakeLists.txt`

**Interfaces:**
- Consumes: Task 4 `LinearizationState.v6` and periodic certificate.
- Produces: scaled and unscaled `A_qq`, `A_qphi`, `A_phiq`, `P`, `B_qq`, Dirichlet map or mean-zero vector, and immutable operator digest.

- [ ] Add failing P1 manufactured Robin, Dirichlet, and pure-Neumann tests with independent quadrature/sign oracles.
- [ ] Add reciprocity/energy-variation tests for `A_qphi` and `A_phiq`, including a sign-flip negative control that must fail.
- [ ] Assemble scalar Laplacian and Robin boundary mass on the full shared domain, magnetic coupling only on magnetic regions, and tangent LLG blocks from the accepted equilibrium.
- [ ] Apply full equivalence-class reduction to magnetic and scalar true DOFs; do not reduce by node pairs only.
- [ ] Publish exact units, ordering, scaling, region maps, BC/gauge tuple, and digests.
- [ ] Run `just verify-fem-frequency-domain-native-contract`.
- [ ] Commit with `git commit -m "feat: assemble real K0 Poisson modal blocks"`.

### Task 8: Implement certified Schur reduction and CPU selected-spectrum solve

**Files:**
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_schur_matshell.cpp`
- Modify: `backends/fem/cpu/frequency_domain/poisson_airbox_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/slepc_modal_eigen.cpp`
- Modify: `backends/fem/cpu/frequency_domain/production_cpu_modal_eigen.cpp`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_schur_matshell_test.cpp`
- Test: `backends/fem/tests/frequency_domain/poisson_airbox_modal_eigen_slepc_test.cpp`

**Interfaces:**
- Consumes: Task 7 descriptor and Task 6 request.
- Produces: finite selected modes with native q/phi/delta-m and original blockwise residuals.

- [ ] Add failing descriptor-versus-Schur, gauge-versus-pinned, finite/infinite classification, conjugate-pair, multiplicity, window-completeness, and wrong-axis target tests.
- [ ] Solve `phi(q)=-P^-1 A_phiq q`, apply `L_eff q=A_qq q+A_qphi phi(q)`, and keep algebraic modes outside the Krylov space.
- [ ] Implement the Task 1 spectral representation exactly and record sigma/tau, EPS/ST/KSP/PC, iterations, convergence reason, and completeness.
- [ ] Reconstruct phi and Cartesian delta-m for every accepted mode and compute unscaled `r_q`, `r_phi`, and `r_gauge`; never cap these with SLEPc residuals.
- [ ] Reject any mode failing the exact production tolerance or finite/positive-branch policy.
- [ ] Run `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc`, and `just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell`.
- [ ] Commit with `git commit -m "feat: solve certified K0 modes on CPU"`.

### Task 9: Implement persistent device-resident GPU modal solve

**Files:**
- Create: `backends/fem/gpu/cuda/frequency_domain/modal_krylov.hpp`
- Create: `backends/fem/gpu/cuda/frequency_domain/modal_krylov.cu`
- Create: `backends/fem/tests/frequency_domain/gpu_modal_krylov_test.cpp`
- Modify: `backends/fem/src/frequency_domain/modal_eigen_solver.cpp`
- Modify: `backends/fem/gpu/cuda/frequency_domain/driven_response_gpu.cu`
- Modify: `backends/fem/CMakeLists.txt`

**Interfaces:**
- Consumes: Tasks 6-8 canonical descriptor, shift, and CPU oracle.
- Produces: `gpu_modal_device_krylov` with persistent device resources, multi-mode results, and transfer/residency telemetry.

- [ ] Add failing tests for operator/action CPU parity, restart, locking, degeneracy, cancellation, happy/unhappy breakdown, NaN/stagnation, context signature reuse/invalidation, and no per-iteration full-vector transfers.
- [ ] Move modal ownership out of `driven_response_gpu.cu`; keep the dense one-thread path under an explicit validation-only adapter.
- [ ] Allocate PETSc CUDA vectors, Krylov basis, Schur/Poisson workspace, preconditioner, locking state, and result buffers once per exact operator signature.
- [ ] Execute device-capable MatShell/MatNest, hypre-device preconditioning, and SLEPc with the same spectral representation and acceptance rules as CPU.
- [ ] Reconstruct and certify q/phi/delta-m without hidden host solves; permit only bounded scalar checkpoint transfers recorded in telemetry.
- [ ] Run `just rebuild-fem-runtime`, `just ensure-managed-fem-runtime`, the GPU modal native target, and Compute Sanitizer gate.
- [ ] Commit with `git commit -m "feat: solve certified K0 modes on GPU"`.

### Task 10: Publish complete artifacts-v2 and validation-scope bindings

**Files:**
- Modify: `crates/fullmag-runner/src/fem_eigen.rs`
- Modify: `crates/fullmag-runner/src/eigen/artifacts.rs`
- Modify: `crates/fullmag-runner/src/eigen/diagnostics.rs`
- Modify: `crates/fullmag-runner/src/artifacts.rs`
- Modify: `docs/specs/frequency-domain-artifacts-v2.md`
- Modify: `scripts/verify_fem_frequency_domain_eigen_artifacts.py`
- Test: `scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`

**Interfaces:**
- Consumes: Task 6 native multi-mode result and Tasks 8-9 diagnostics.
- Produces: manifest, spectrum, branches, solver diagnostics, per-mode metadata, Zarr fields, validation sidecars, scope binding, and partial/failure bundles.

- [ ] Add failing verifier tests for missing native vectors, fabricated modes, stale hashes, missing sidecars, invalid scope catalog digest, absent block residuals, hidden fallback, wrong units, and contradictory completion state.
- [ ] Remove the runner fallback that fabricates uniform mode vectors.
- [ ] Publish `spectrum.v2.json`, `branches.v2.json`, per-mode metadata, q/phi provenance, and Cartesian `mode_fields.zarr` with mesh/topology IDs, units, representation, revision, and field IDs.
- [ ] Add `validation_artifact_manifest.v1` sidecars for CSV and Zarr and an accepted `verified_coverage_of` binding for every production evidence artifact.
- [ ] Preserve partial modes and diagnostics on cancellation/failure with `complete=false` and explicit stop reason.
- [ ] Run focused Rust tests and `python3 -m unittest scripts/test_verify_fem_frequency_domain_eigen_artifacts.py`.
- [ ] Commit with `git commit -m "feat: publish production K0 modal artifacts"`.

### Task 11: Close OpenAPI v2, generated transport, resources, and binary data plane

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/handlers/analysis/frequency_domain.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/fields.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-paths.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Test: `apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts`

**Interfaces:**
- Consumes: Task 10 artifact bundle.
- Produces: thin revisioned spectrum/branches/diagnostics/mode-meta resources and binary vector samples for selected mode fields.

- [ ] Add failing API tests for complete, partial, failed, unavailable, malformed, stale-revision, missing-mode, and invalid-Zarr cases.
- [ ] Keep mode metadata in analysis JSON and serve Cartesian mode vectors through `/v2/sessions/current/data/fields/{field_id}/samples/vector` with ETag and topology identity.
- [ ] Expose methods only through generated transport plus `ControlRoomApi.analysis.frequencyDomain` and revision-aware resource hooks.
- [ ] Regenerate with `pnpm --dir apps/control-room generate:api`; do not edit generated files manually.
- [ ] Run `cargo test -p fullmag-api router_v2 --no-fail-fast`, `pnpm --dir apps/control-room test -- --run ControlRoomApi studyRuntimeResources`, and API hygiene searches.
- [ ] Commit with `git commit -m "feat: expose K0 modal spectrum and fields over v2"`.

### Task 12: Deliver production Spectrum, Modes, diagnostics, and capability UI

**Files:**
- Modify: `apps/control-room/src/shared/domain/analysis/frequencyDomainChartModels.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainTables.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainCharts.tsx`
- Modify: `apps/control-room/src/modules/explorer/builders/frequencyDomainExplorerNodes.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx`
- Test: matching `.test.ts` and `.test.tsx` files in the same directories

**Interfaces:**
- Consumes: Task 11 resource hooks and exact capability/validation state.
- Produces: Spectrum chart/table, mode selection, provenance/diagnostics inspectors, and explicit degraded/error states.

- [ ] Add failing UI tests for physical Hz axes, units, mode count, residuals, multiplicity, selected mode, requested/resolved CPU/GPU, exact validated scope, partial/failed/unavailable states, and corrupt-resource rejection.
- [ ] Build chart models from bounded resource data; preserve stable renderer options and avoid raw arrays in React state.
- [ ] Make chart/table selection publish canonical mode-field selection through kernel commands/events, not cross-module imports.
- [ ] Gate CPU/GPU readiness from active-session capabilities and artifact validation state, never route presence.
- [ ] Show assembly, equilibrium/certificate identity, BC/gauge, spectral transform, residual blocks, stop reason, and residency without reconstructing semantics from labels.
- [ ] Run focused chart/inspector/explorer tests, `pnpm --dir apps/control-room typecheck`, and targeted lint.
- [ ] Commit with `git commit -m "feat: deliver production K0 spectrum and mode inspectors"`.

### Task 13: Render selected modes in the unified 3D viewport

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/FrequencyDomainModeDisplayControls.tsx`
- Modify: `apps/control-room/src/kernel/visualization/analysisFieldOverlayCommandContributions.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/buildViewport3DRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorGlyphLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/ScalarFieldLayer.tsx`
- Test: matching mode-display, command, scene-model, render-model, and viewport tests
- Browser: create or extend `apps/control-room/scripts/audit-viewport-3d-memory-churn.mjs`

**Interfaces:**
- Consumes: Task 11 binary Cartesian mode field and Task 12 selected mode identity.
- Produces: demand-driven real, imaginary, magnitude, phase-rotated, surface-color, and vector-glyph visualization on current solver topology.

- [ ] Add failing tests for component/representation selection, phase rotation, missing topology, incompatible revision, selection switch, and disposal on mode/tab/unmount changes.
- [ ] Adapt binary mode fields into the domain-neutral viewport render model; keep FEM-specific interpretation outside R3F layers.
- [ ] Update field buffers without rebuilding topology, use `frameloop="demand"`, and retain no large typed arrays in React/Zustand state.
- [ ] Dispose replaced geometries, materials, textures, GPU buffers, subscriptions, observers, and workers.
- [ ] Add browser smoke assertions for visible canvas, non-lost WebGL context, nonzero drawing buffer, selected-mode visual difference, phase-change visual difference, and bounded memory across repeated mode switches.
- [ ] Run viewport, viewport-memory-stress, chart, idle-performance, browser smoke, typecheck, lint, and full Control Room tests.
- [ ] Commit with `git commit -m "feat: visualize K0 eigenmodes in unified viewport"`.

### Task 14: Qualify physics, convergence, parity, performance, readiness, and release

**Files:**
- Modify: `examples/fem_eigen_k0_kittel_periodic_airbox.py`
- Create: `examples/fem_eigen_k0_kittel_periodic_airbox_gpu.py`
- Modify: `scripts/verify_fem_eigen_k0_periodic_airbox_convergence.py`
- Create: `scripts/verify_fem_eigen_k0_periodic_airbox_cpu_gpu_parity.py`
- Create: `scripts/verify_fem_eigen_k0_periodic_airbox_performance.py`
- Create: `scripts/verify_fem_frequency_domain_production_dod.py`
- Modify: `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_matrix.json`
- Modify: `docs/plans/active/fd_sovler_masterplan/25_frequency_domain_readiness_scope_catalog.json`
- Modify: `justfile`
- Test: matching `scripts/test_*.py` files

**Interfaces:**
- Consumes: Tasks 1-13 complete implementation and artifacts.
- Produces: immutable exact-scope CPU/GPU readiness records and `frequency_domain_production_dod.v1` with DOD-01 through DOD-14 evidence.

- [ ] Add verifier negative controls for analytical leakage into assembly/target/selection, duplicated convergence rows, stale artifact hashes, CPU data copied into GPU results, hidden fallback, fake device residency, absent sidecars, and UI claims beyond capability.
- [ ] Run K0-1 Larmor, K0-2 local stiffness, manufactured Poisson, reciprocity, full/Schur, selected-window, finite-mode, modal/driven resonance, and real-film K0-3 field-sweep gates.
- [ ] Run at least three independent mesh levels and at least three independent airbox-padding levels; fit `M_eff`, uncertainty, conditioning, observed convergence, and separate mesh/truncation budgets.
- [ ] Run identical-signature CPU/GPU block, action, eigenvalue, modal-overlap, residual, accepted/rejected outcome, and artifact parity.
- [ ] Run three distinct DOF sizes, persistent-context reuse/invalidation, hot-loop allocation, transfer trace, memory envelope, cancellation, Compute Sanitizer, and bounded scaling gates.
- [ ] Add managed recipes `verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu`, `verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu`, and `verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-release` with fresh-artifact cleanup and independent verifiers.
- [ ] Run the production release recipe from a clean container runtime; require expected negative controls to fail.
- [ ] Update readiness cells only with accepted scope-catalog bindings and generate `frequency_domain_production_dod.v1` containing immutable evidence for DOD-01 through DOD-14.
- [ ] Run the masterplan full-pack drift check and all backend/API/frontend quality gates one final time.
- [ ] Commit with `git commit -m "feat: qualify production K0 modal demag CPU and GPU"`.

## Final Evidence Sequence

```bash
just rebuild-fem-runtime
just ensure-managed-fem-runtime
just inspect-managed-fem-frequency-domain-deps
just verify-fem-frequency-domain-native-contract
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-dense-oracle
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-cpu-slepc
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-schur-matshell
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-cpu
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-gpu
just verify-fem-frequency-domain-eigen-k0-poisson-airbox-production-release
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room audit:idle-performance
python3 scripts/build_fd_solver_masterplan_full_pack.py --check
```

Completion is prohibited unless every command succeeds on fresh evidence, the browser smoke proves Spectrum-to-mode-to-viewport behavior, and `frequency_domain_production_dod.v1` records passing evidence for all DOD-01 through DOD-14 for both exact CPU and exact GPU scopes.

## Recovery implementation status (2026-08-05)

The source and control-room contracts are now present for the bounded FEM K0
shared-domain dynamic-demag lane. The production evidence boundary is kept
explicit: existing artifacts and source-visible PETSc/SLEPc CUDA code are not
fresh qualification for the current dirty source snapshot, and the FDM
planner still rejects native `Eigenmodes` and `FrequencyResponse` studies.
FDM can continue to produce a time-domain FFT spectrum; that is not an FDM
modal eigensolver or a mode-field result.

The performance gate now has a real producer, not only a verifier:
`scripts/capture_fem_eigen_k0_periodic_airbox_performance.py`. It executes an
explicit managed `just` command once per configured DOF case, measures wall
time and child peak RSS itself, requires each command to emit hash-addressable
native diagnostics with hot-loop counters, packages cancellation and Compute
Sanitizer artifacts, and invokes the fail-closed
`verify_fem_eigen_k0_periodic_airbox_performance.py` before writing the final
proof. It refuses missing measurements, failed commands, stale output files,
unsupported paths, non-managed commands, or inferred residency. The managed
per-case producer is
`run-fem-frequency-domain-eigen-k0-poisson-airbox-performance-case`; the
orchestrating capture recipe is
`capture-fem-frequency-domain-eigen-k0-poisson-airbox-performance`, which first
ensures the managed runtime and then invokes the producer for each size,
cancellation, and Compute Sanitizer phase.

This producer closes the evidence-generation gap but does not manufacture the
missing qualification. The release gate remains blocked until the managed
runtime export lock is cleared and a fresh clean/identified runtime supplies
CPU/GPU convergence, parity, three-size scaling, cancellation, Sanitizer, DOD,
and browser Spectrum-to-mode-to-viewport evidence for the exact source
snapshot.
