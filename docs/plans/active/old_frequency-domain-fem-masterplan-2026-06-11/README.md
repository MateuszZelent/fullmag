# Frequency-Domain FEM Masterplan

Date: 2026-06-11

Scope: production-grade FEM frequency-domain driven-response execution and complete Control Room UI support for the related modal products: eigenmodes, dispersion, mode tables, spectrum charts, absorption derived from modes, and 3D mode visualization.

## Current-State Conclusions

The backend is not empty, and the eigenmode path is intentionally not the same product as the driven frequency-response solver. Fullmag has a first-class semantic layer for eigenmodes and frequency response, FEM planning paths, runner/native tests, and v2 artifacts. Active rollout work has promoted limited native MFEM production CPU and GPU driven-response slices for gamma/free-boundary and k = 0 static-periodic magnetic response, including ordinary k = 0 dynamic demag through the backend demag-tangent provider. Nonzero-k Floquet production response, GPU periodic-airbox dynamic demag, and magnetoelastic response remain capability-gated. Eigenmodes, dispersion, linewidths, absorption derived from modes, and 3D mode profiles are companion modal products that must be supported by the UI without being mislabeled as the driven solver.

Baseline code facts verified when this masterplan was created:

- `packages/fullmag-py/src/fullmag/model/study.py` defines public `Eigenmodes` and `FrequencyResponse` classes.
- `packages/fullmag-py/src/fullmag/world.py` exposes flat and staged authoring helpers for eigenmodes and frequency response.
- `crates/fullmag-ir/src/study.rs`, `crates/fullmag-ir/src/eigen_contract.rs`, and `crates/fullmag-ir/src/frequency_response_contract.rs` contain first-class IR contracts for eigen and frequency-response studies.
- `crates/fullmag-plan/src/fem.rs` plans FEM eigenmodes, including demag realization checks, periodic/Floquet constraints, k-path sampling, output validation, and precision restrictions.
- `crates/fullmag-plan/src/lib.rs` rejects `StudyIR::FrequencyResponse` on FDM, while the FEM path can produce a `FemFrequencyResponsePlanIR`. Active rollout work has promoted a limited native MFEM production CPU response slice for gamma-point/free-boundary magnetic response with exchange, Zeeman, uniaxial anisotropy, DMI, and damping; dense validation remains only a validation/reference lane for cases not requiring production-only physics.
- `crates/fullmag-runner/src/fem_eigen.rs` preserves dense/reference modal validation paths, while the native FEM runtime exposes the production modal lane through the managed SLEPc shift-invert integration.
- `crates/fullmag-runner/src/dispatch.rs` writes `eigen/spectrum.v2.json`, `eigen/branches.v2.json`, and `eigen/dispersion.csv` for k-path eigensolves.
- `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs` exposes v2 eigen endpoints, plus legacy compatibility endpoints.
- `crates/fullmag-api/src/router_v2/handlers/analysis/response.rs` exposes `response/magnetic_response_sweep.v1.json` and the v2 response resource family for solver-created artifacts.
- `apps/control-room/src/kernel/api/apiPaths.ts` contains generated path constants for eigen and frequency-response analysis routes.
- `apps/control-room/src/kernel/api/ControlRoomApi.ts` exposes typed eigen, modal compatibility, and frequency-response facade methods instead of raw component fetches.
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts` exposes stable-key resource hooks for manifest, eigen spectrum/branches/dispersion/modes/diagnostics, response sweeps, frequency points, and analysis vector fields.
- `apps/control-room/src/modules/explorer/explorerTypes.ts` and the Explorer builders expose frequency-domain stage/result nodes for modal and driven-response resources without routing result nodes through placeholder inspectors.
- `apps/control-room/src/modules/inspector` exposes dedicated frequency-domain stage/result inspectors, including modal spectrum/mode/dispersion views, driven-response/FMR sweep views, provenance, diagnostics, and missing-resource states.
- `apps/control-room/src/modules/analysis-plots` renders frequency-domain spectrum/dispersion/response series through the analysis plot controller.
- `apps/control-room/src/modules/viewport-3d` consumes analysis-mode field resources and supports phase-controlled 3D modal/response overlays through kernel visualization commands.

Active implementation delta:

- This folder is an active rollout plan, not a frozen audit snapshot. The
  current implementation has already restored the typed API/resource, Explorer,
  inspector, chart, and 3D overlay surfaces described in files 02-08; those
  files remain the target contract for regression checks and future extensions.
- Current Control Room work adds `api.analysis.eigen.*` for modal products while
  preserving compatible modal methods under `api.analysis.frequencyDomain.*`
  during rollout. The required product split remains: modal eigen products are
  not the driven frequency-response solver.
- `examples/fem_eigenmodes_frequency_window.py` has been recovered from the
  abandoned tree and is covered by `just verify-fem-frequency-domain-eigen-runtime`
  so the explicit interval-target eigen artifact path stays exercised.
- `backends/fem/cpu/frequency_domain/mfem_modal_operator_payload.*` has been
  recovered from the abandoned tree and is covered by the managed native
  modal-eigen contract, including dense and sparse MFEM linearized-operator
  payload assembly into the production SLEPc path.
- The Control Room Explorer result tree now restores the abandoned
  response-map result affordance only when `result_manifest` proves
  `response_map` was requested or a response-map artifact/resource exists; the
  ordinary FMR/dispersion tree remains free of unsupported response-map noise.
- The native modal-eigen contract has recovered the abandoned production dense
  contour-window payload test for a multi-mode interval, including certified
  window completeness, two accepted modes, global mode vectors, and contour
  progress emission.

Storage policy:

- JSON is control-plane only: manifests, metadata, summaries, provenance,
  diagnostics, small tables, and links.
- Zarr is the default heavy-data format for frequency-domain mode fields,
  driven-response fields, dense response maps, and future multi-mode tensors.
- HDF5/H5 is allowed as an alternate backend or export format only when the API
  preserves the same named resource semantics.
- Raw `vector.bin` payloads are transitional compatibility exports, not the
  production default.

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

1. `audyt_planu_solvera_fem_domena_czestotliwosci.md`
2. `00-source-of-truth-and-consolidation.md`
3. `01-backend-native-fem-frequency-domain.md`
4. `02-ir-planner-python-capabilities-api.md`
5. `03-artifacts-resources-and-runtime.md`
6. `04-control-room-explorer-tree.md`
7. `05-control-room-inspectors.md`
8. `06-analysis-plots-and-3d-mode-visualization.md`
9. `07-implementation-stages-and-verification.md`
10. `08-periodic-floquet-bloch-boundary-conditions.md`
11. `10-production-interior-window-eigensolver.md`
12. `11-comsol-grade-frequency-domain-masterplan-2026-06-30.md`

## Non-Negotiable Success Criteria

Backend:

- Driven frequency response is the primary frequency-domain solver deliverable.
- FEM eigenmodes are a separate modal companion path that may share the linearized operator contract but must not be treated as the same solver.
- Audit P0 is blocking for new production promotion: one `exp(i omega t)` convention, correct gyrotropic/eigenvalue mapping, dynamic-demag Poisson sign, `Ms`-correct susceptibility and absorbed-power units, damping/linewidth convention, and tangent-frame transport for PBC/Floquet.
- Periodic, Floquet, and Bloch boundary conditions are first-class frequency-domain requirements for FMR and dispersion, not optional frontend flags.
- Static PBC demag/equilibrium for magnonic-crystal unit cells is a required gate before periodic-airbox driven response or eigenfrequency dynamics; a short response smoke is not equilibrium proof.
- Production FEM code lives under the canonical `backends/fem` native tree, not in `crates` and not in `mfem_bridge.cpp`.
- CPU and GPU realizations are separate runtime lanes that share physics semantics but do not share hot-loop state.
- The current dense/reference eigensolver remains a validation path for modal products until the native scalable modal solver passes the validation ladder.
- Frequency response is executable only for explicitly proven lanes: dense FEM validation, current native MFEM production CPU/GPU gamma/free-boundary ordinary dynamic demag through the backend tangent provider, k = 0 static-periodic magnetic slices, and the narrow `periodic_airbox_k0` Schur/provider slice. GPU `periodic_airbox_k0` may execute only through the GPU demag tangent-with-potential provider path; explicit CPU dense/coupled-block payloads remain invalid as GPU proof. Nonzero-k Floquet demag, assembled periodic-airbox GPU coupled-block response, and magnetoelastic response remain rejected until separately qualified.
- Native FEM build and runtime verification use repo `just` recipes, including `verify-fem-frequency-domain-native-contract`, `verify-fem-frequency-domain-runtime`, `verify-fem-frequency-domain-static-periodic-runtime`, `verify-fem-frequency-domain-eigen-runtime`, and the aggregate `verify-fem-frequency-domain-runtime-suite`.

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
