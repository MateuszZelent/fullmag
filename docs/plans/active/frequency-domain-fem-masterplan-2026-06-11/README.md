# Frequency-Domain FEM Masterplan

Date: 2026-06-11

Scope: production-grade FEM frequency-domain driven-response execution and complete Control Room UI support for the related modal products: eigenmodes, dispersion, mode tables, spectrum charts, absorption derived from modes, and 3D mode visualization.

## Current-State Conclusions

The backend is not empty, but the existing eigenmode path is not the same thing as the frequency-domain solver. Fullmag already has a first-class semantic layer for eigenmodes and frequency response, a FEM eigen planning path, runner tests, and v2 eigen artifacts. The missing core feature is a production-native FEM driven frequency-response solver. Eigenmodes, dispersion, linewidths, absorption-from-modes, and 3D mode profiles are companion modal products that must be supported by the UI without being mislabeled as the driven solver.

Baseline code facts verified when this masterplan was created:

- `packages/fullmag-py/src/fullmag/model/study.py` defines public `Eigenmodes` and `FrequencyResponse` classes.
- `packages/fullmag-py/src/fullmag/world.py` exposes flat and staged authoring helpers for eigenmodes and frequency response.
- `crates/fullmag-ir/src/study.rs`, `crates/fullmag-ir/src/eigen_contract.rs`, and `crates/fullmag-ir/src/frequency_response_contract.rs` contain first-class IR contracts for eigen and frequency-response studies.
- `crates/fullmag-plan/src/fem.rs` plans FEM eigenmodes, including demag realization checks, periodic/Floquet constraints, k-path sampling, output validation, and precision restrictions.
- `crates/fullmag-plan/src/lib.rs` rejects `StudyIR::FrequencyResponse` on FDM, while the FEM path can produce a `FemFrequencyResponsePlanIR`. Active rollout work has promoted a limited native MFEM production CPU response slice for gamma-point/free-boundary magnetic response with exchange, Zeeman, uniaxial anisotropy, DMI, and damping; dense validation remains only a validation/reference lane for cases not requiring production-only physics.
- `crates/fullmag-runner/src/fem_eigen.rs` executes a transitional CPU baseline and a small dense GPU path, writes legacy eigen artifacts, and participates in v2 dispersion artifact generation through dispatch.
- `crates/fullmag-runner/src/dispatch.rs` writes `eigen/spectrum.v2.json`, `eigen/branches.v2.json`, and `eigen/dispersion.csv` for k-path eigensolves.
- `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs` exposes v2 eigen endpoints, plus legacy compatibility endpoints.
- `crates/fullmag-api/src/router_v2/handlers/analysis/response.rs` exposes `response/magnetic_response_sweep.v1.json`, but the executable driven solver is not implemented.
- `apps/control-room/src/kernel/api/apiPaths.ts` contains generated path constants for eigen and frequency-response analysis routes.
- At the original audit point, `apps/control-room/src/kernel/api/ControlRoomApi.ts` exposed only `analysis.frequencyResponse.magneticSweepV1()` for frequency-domain analysis and did not expose an `analysis.eigen` facade. Active rollout work may already have added `analysis.frequencyDomain.*` and `analysis.eigen.*`; files 02-08 remain the target contract.
- At the original audit point, `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` had `useMagneticResponseSweepResource()` but no eigen spectrum, branch, dispersion, or mode hooks. Active rollout work may already have added some of these hooks; the required hook list in doc 02 remains authoritative.
- At the original audit point, `apps/control-room/src/modules/explorer/explorerTypes.ts` contained `study.stage.eigenmodes` and `study.stage.frequency_response`, but no result node kinds for eigen spectra, dispersion branches, mode rows, response sweeps, or mode-field payloads. Active rollout work may already have added these node kinds; doc 04 remains the coverage target.
- `apps/control-room/src/modules/explorer/builders/study/eigenmodesStageNode.ts` and `frequencyResponseStageNode.ts` build shallow stage nodes only.
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` routes spectral stages to `StudyStageInspectorRouter`, but result nodes do not exist.
- `apps/control-room/src/modules/inspector/panels/StudyPipelineSection.tsx` has basic draft fields for eigenmodes and frequency response, but it does not expose professional result inspection.
- `apps/control-room/src/modules/analysis-plots` is currently scalar/table/hysteresis-oriented and does not render eigen spectra, dispersion, mode tables, or driven-response charts.
- `apps/control-room/src/modules/viewport-3d` has a mature resource-driven vector-field rendering path, but no analysis-mode field source or mode-phase visualization path.

Active implementation delta:

- This folder is an active rollout plan, not a frozen audit snapshot. If a later
  implementation adds `api.analysis.frequencyDomain`, frequency-domain Explorer
  node kinds, or inspector/chart stubs, the target requirements in files 02-08
  still decide whether the work is complete.
- Current Control Room work adds `api.analysis.eigen.*` for modal products while
  preserving compatible modal methods under `api.analysis.frequencyDomain.*`
  during rollout. The required product split remains: modal eigen products are
  not the driven frequency-response solver.

## Local External Solver Audit

The reference implementation must be based on the local solver sources in `external_solvers`, not only on web references.

Verified local facts:

- `external_solvers/tetrax/tetrax/experiments/eigen/solve.py` implements an `eigenmodes(...)` experiment using a finite-element dynamic-matrix method.
- `external_solvers/tetrax/tetrax/experiments/eigen/dynamic_matrix.py` defines `DynamicMatrix`, a complex linear operator diagonalized with sparse eigensolve machinery.
- `external_solvers/tetrax/tetrax/experiments/eigen/result.py` defines `EigenResult` with spectrum dataframe, mode profiles, plotting, linewidths, perturbation, and absorption postprocessing.
- `external_solvers/tetrax/tetrax/experiments/eigen/postprocessing/absorption.py` calculates dynamic susceptibility from an existing eigensystem and an antenna. This is modal postprocessing, not a direct driven linear solve.
- `external_solvers/tetrax/doc/usage/experiments.rst` documents eigenmodes as spin-wave normal modes and absorption as a method on `EigenResult`.
- `external_solvers/tetmag/specs/ProgramSpecs.h` defines `Hdynamic` with pulse, sweep, and RF drive fields.
- `external_solvers/tetmag/main/TheLLG.cpp` applies RF, pulse, and sweep fields inside time-domain LLG effective-field evaluation.
- `external_solvers/tetmag/codemeta.json` describes high-frequency oscillations and dynamic switching, which are useful references for driven excitation UX and FEM time-domain validation, not a drop-in frequency-domain eigensolver.

Correct product distinction:

- `frequency_response` is the actual frequency-domain driven solver: solve the harmonic linearized LLG response at requested drive frequencies and output complex response observables.
- `eigenmodes` is the modal dynamic-matrix/eigensystem product: solve normal modes, dispersion, mode profiles, linewidths, and mode-derived absorption.
- Tetmag is a local reference for FEM LLG dynamics with RF/pulse/sweep excitation and demag/FEM/BEM structure.
- TetraX is the local reference for dynamic-matrix eigenmodes, spin-wave dispersion, mode profiles, linewidths, and modal absorption workflows.
- Control Room must expose both products under a broader frequency-domain analysis family, but it must not call eigenmodes the frequency-domain solver.

Browsed literature references still useful for the modal/FEM dynamic-matrix side:

- https://arxiv.org/abs/2210.16564
- https://arxiv.org/abs/2207.01519

## Folder Map

Read in this order:

1. `00-source-of-truth-and-consolidation.md`
2. `01-backend-native-fem-frequency-domain.md`
3. `02-ir-planner-python-capabilities-api.md`
4. `03-artifacts-resources-and-runtime.md`
5. `04-control-room-explorer-tree.md`
6. `05-control-room-inspectors.md`
7. `06-analysis-plots-and-3d-mode-visualization.md`
8. `07-implementation-stages-and-verification.md`
9. `08-periodic-floquet-bloch-boundary-conditions.md`

## Non-Negotiable Success Criteria

Backend:

- Driven frequency response is the primary frequency-domain solver deliverable.
- FEM eigenmodes are a separate modal companion path that may share the linearized operator contract but must not be treated as the same solver.
- Periodic, Floquet, and Bloch boundary conditions are first-class frequency-domain requirements for FMR and dispersion, not optional frontend flags.
- Production FEM code lives under the canonical `backends/fem` native tree, not in `crates` and not in `mfem_bridge.cpp`.
- CPU and GPU realizations are separate runtime lanes that share physics semantics but do not share hot-loop state.
- The current dense/reference eigensolver remains a validation path for modal products until the native scalable modal solver passes the validation ladder.
- Frequency response is executable only for explicitly proven lanes: the dense FEM validation lane may emit response artifacts, while the production native driven solver remains incomplete until it writes validated direct-harmonic response artifacts through the managed runtime path.
- Native FEM build and runtime verification use repo `just` recipes, with a new managed frequency-domain verification recipe added before production rollout.

Frontend:

- Every frequency-domain Explorer node maps to exactly one inspector; no node is allowed to fall through to `PlaceholderPanel`.
- Control Room exposes explicit calculation workflow modes such as FMR, modal dispersion, free eigenmodes, driven frequency sweep, and future Bloch/Floquet response map; these modes lower to canonical `Eigenmodes` or `FrequencyResponse` studies instead of becoming hidden solver types.
- Periodic pair diagnostics, Floquet phase preview, k-path setup, FMR k=0 setup, and Bloch/Floquet capability errors are visible in Control Room.
- Existing v2 API rules remain intact: no direct `fetch()` in React components, no hand-written endpoint strings outside the API facade, and no direct legacy imports.
- Eigen spectrum, dispersion, branch, mode, response sweep, and diagnostics data load through typed API facade methods and resource hooks.
- Mode plotting in 3D is a resource/visualization selection, not an imperative import from inspector or chart into `viewport-3d`.
- Spectrum charts, mode tables, response charts, and 3D mode overlays stay synchronized through kernel selection and events.
- UI behavior is verified with unit tests, resource tests, analysis chart tests, and a browser smoke that proves the 3D mode overlay renders with a live WebGL buffer.

## Definition Of Done

This masterplan is complete when implementation can be broken into reviewable pull requests where each PR has:

- one explicit scope,
- exact touched layers,
- exact tests,
- no hidden generated-artifact drift,
- no frontend placeholders for frequency-domain result nodes,
- no backend semantic shortcuts that diverge from the physics notes.
