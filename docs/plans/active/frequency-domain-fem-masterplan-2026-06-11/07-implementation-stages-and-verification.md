# 07 - Implementation Stages And Verification

This file orders the work so backend contracts land before UI surfaces that depend on them.

## Stage 0 - Freeze Current Facts

Goal:

- Capture the current backend/API/UI reality before changing behavior.
- Confirm the source-of-truth map in `00-source-of-truth-and-consolidation.md`
  before changing docs or code.

Implementation:

1. Record current `just --list` FEM recipes.
2. Record current frequency-domain and modal code paths:
   - Python DSL,
   - IR,
   - planner,
   - runner,
   - API,
   - Control Room facade,
   - Explorer,
   - inspector,
   - analysis-plots,
   - viewport-3d,
   - `external_solvers/tetmag`,
   - `external_solvers/tetrax`.
3. Explicitly record that `eigenmodes` is not the same solver as `frequency_response`.
4. Reconcile any newly discovered frequency-domain document with
   `00-source-of-truth-and-consolidation.md` before implementation.
5. Add no implementation changes in this stage.

Verification:

- `rg -n "FrequencyResponse|Eigenmodes|frequency_response|eigen" packages/fullmag-py crates apps/control-room/src external_solvers/tetmag external_solvers/tetrax`
- `rg -n "ensure-managed-fem-runtime|rebuild-fem-runtime|fem-gpu-headless|verify-fem-relaxation-runtime" justfile`
- `rg -n "frequency.?domain|FrequencyResponse|eigenfrequency|eigenmodes|response_sweep" docs/physics docs/specs docs/engineering docs/plans docs/reports`

Exit criteria:

- The team agrees which paths are current implementation, which documents are
  canonical, which are historical references, and which implementation pieces
  are missing.

## Stage 1 - Backend Native Contract Skeleton

Goal:

- Add native FEM frequency-domain contracts without changing current solver behavior.

Implementation:

1. Create native `frequency_domain` module under `backends/fem`.
2. Add request/result structs.
3. Add equilibrium/tangent/operator/result enum conversions.
4. Add availability probe.
5. Wire diagnostics only; keep existing runner path as-is.

Verification:

- `just ensure-managed-fem-runtime`
- new managed native contract test recipe
- native unit tests for enum conversion and unavailable status

Exit criteria:

- The native module compiles in the managed FEM container.
- Runtime diagnostics can report native frequency-domain availability.

## Stage 2 - Equilibrium And Tangent Projection

Goal:

- Implement reusable tangent-space preparation.

Implementation:

1. Implement equilibrium import and validation.
2. Implement deterministic tangent basis.
3. Implement full-to-tangent and tangent-to-full projection.
4. Implement equilibrium diagnostics.
5. Add artifact serialization for diagnostics.

Verification:

- Native unit tests for tangent basis.
- Projection property tests.
- Invalid equilibrium rejection test.
- Managed container recipe.

Exit criteria:

- Driven response and modal solvers can consume the same tangent-space state.

## Stage 3 - Native Operator Assembly

Goal:

- Build the production native linearized operator family.
- Add periodic, Floquet, and Bloch enforcement gates needed by FMR and
  dispersion.

Implementation:

1. Implement exchange operator.
2. Implement Zeeman/local field operator.
3. Implement supported DMI operators.
4. Implement supported surface anisotropy operator.
5. Integrate supported demag realization.
6. Add operator diagnostics.
7. Keep unsupported models as explicit errors.
8. Implement or wire the validated periodic pair metadata path used by
   `08-periodic-floquet-bloch-boundary-conditions.md`.
9. Add Floquet/Bloch phase enforcement for supported modal operators.
10. Keep nonzero-k Floquet demag as a hard rejection until dynamic demag-k is
   implemented.

Verification:

- Exchange-only native test.
- Zeeman-only analytic benchmark.
- Demag compatibility tests.
- Floquet dynamic-demag rejection test.
- Floquet phase sign test.
- `Floquet(k=0) == periodic` test.
- Exchange-only reciprocal dispersion test.
- Native/Rust metadata parity test.

Exit criteria:

- A small mesh can assemble a frequency-domain operator with diagnostics.
- Periodic/Floquet requests either enforce the requested constraints or fail
  before runtime with a stable diagnostic.

## Stage 4 - Production FEM Driven Frequency Response Solve

Goal:

- Implement the actual frequency-domain solver: direct harmonic driven response for `StudyIR::FrequencyResponse`.

Implementation:

1. Add `FemFrequencyResponsePlanIR`.
2. Reuse frequency-domain planning infrastructure without copying modal planner code.
3. Implement native complex driven solve at requested frequencies.
4. Add excitation projection and observable reduction.
5. Write response sweep artifacts and manifest entries.
6. Add frequency-point metadata and response field refs.
7. Add response diagnostics.
8. Convert semantic-only planner tests into supported/unsupported response tests.

Verification:

- IR tests for response outputs.
- Planner tests for supported and unsupported response plans.
- Native response smoke test.
- API test serving solver-created `magnetic_response_sweep.v1`.
- Optional comparison against modal reconstruction where assumptions match.
- Managed recipe `just verify-fem-frequency-response-runtime`.

Exit criteria:

- Magnetic-only FEM response sweep is executable and visible through API.

## Stage 5 - Modal Eigenmodes, Dispersion, Linewidths, Absorption

Goal:

- Upgrade the modal companion path without confusing it with the driven frequency-domain solver.

Implementation:

1. Add scalable native CPU modal eigensolve integration.
2. Add target handling for lowest and nearest frequency.
3. Add k/m sampling and branch tracking modeled after local TetraX behavior where compatible.
4. Add mode-profile payloads.
5. Add modal diagnostics.
6. Add linewidth postprocessing.
7. Add absorption-from-modes postprocessing with an explicit label that it is modal reconstruction, not direct response.
8. Write spectrum, modes, branches, dispersion, diagnostics, and modal postprocessing artifacts.
9. Keep legacy artifact compatibility.

Verification:

- Existing `crates/fullmag-runner/tests/physics_validation.rs` eigen tests.
- New native/reference modal parity tests.
- Adapted TetraX-style dispersion reference tests where geometry/interactions match.
- Managed recipe `just verify-fem-eigen-runtime`.
- API tests for generated modal artifacts.

Exit criteria:

- Supported FEM modal runs produce manifest, spectrum, modes, branches/dispersion when requested, diagnostics, provenance, and optional linewidth/absorption postprocessing.

## Stage 6 - Capability And OpenAPI Closure

Goal:

- Make the runtime contract explicit enough for UI gating.

Implementation:

1. Update `docs/specs/capability-matrix-v0.md`.
2. Add precise frequency-domain capability fields.
3. Add manifest, diagnostics, response v2, frequency point, and field registration schemas.
4. Update OpenAPI route handlers.
5. Regenerate Control Room API artifacts.
6. Add backend tests for capability consistency.

Verification:

- OpenAPI generation.
- API tests for every new route.
- `pnpm --dir apps/control-room generate:api`
- `pnpm --dir apps/control-room typecheck`

Exit criteria:

- Frontend can be implemented without raw route strings or guessed schemas.

## Stage 7 - Control Room API Facade And Resource Hooks

Goal:

- Provide typed frontend access to all frequency-domain resources.

Implementation:

1. Add `api.analysis.frequencyDomain`.
2. Add `api.analysis.eigen`.
3. Complete `api.analysis.frequencyResponse`.
4. Add resource hooks for manifest, spectrum, branches, dispersion, mode, diagnostics, response sweep, frequency points, and mode fields.
5. Add hook tests.

Verification:

- `pnpm --dir apps/control-room test -- ControlRoomApi.test.ts`
- `pnpm --dir apps/control-room test -- studyRuntimeResources.test.ts`
- `pnpm --dir apps/control-room typecheck`

Exit criteria:

- React modules can consume every required resource without direct `fetch()`.

## Stage 8 - Explorer Tree

Goal:

- Make frequency-domain authoring and results navigable.

Implementation:

1. Add new `ExplorerNodeKind` values.
2. Add study detail children for eigen and response stages.
3. Add results tree builder from manifest.
4. Add resources tree builder from manifest and resource state.
5. Add jobs tree builder for active frequency-domain commands.
6. Add diagnostics tree builder.
7. Add selection metadata fields.

Verification:

- Explorer builder fixture tests.
- Snapshot test for eigen-only manifest.
- Snapshot test for response-only manifest.
- Snapshot test for combined manifest.
- Test stable IDs for modes, branches, and frequency points.

Exit criteria:

- Explorer shows complete frequency-domain tree with stable IDs and statuses.

## Stage 9 - Inspector Coverage

Goal:

- Add a specific inspector for every frequency-domain node.

Implementation:

1. Add frequency-domain inspector model functions.
2. Add authoring detail inspectors.
3. Add eigen result inspectors.
4. Add response result inspectors.
5. Add resource inspectors.
6. Add job inspectors.
7. Add diagnostics inspectors.
8. Update `inspectorRegistry.tsx`.

Verification:

- Inspector model unit tests.
- Registry test enumerating every frequency-domain node kind.
- Test proving no frequency-domain node routes to `PlaceholderPanel`.
- Accessibility tests for tables and action buttons.

Exit criteria:

- Every Explorer node in the frequency-domain tree opens a domain-specific inspector.

## Stage 10 - Spectrum, Dispersion, Mode Tables, Response Charts

Goal:

- Add professional scientific analysis surfaces.

Implementation:

1. Add eigen spectrum chart model.
2. Add mode table model.
3. Add dispersion chart model.
4. Add branch table model.
5. Add frequency response chart model.
6. Add chart components using existing chart primitives.
7. Wire chart selection events.
8. Wire add-series behavior where applicable.

Verification:

- Chart model tests.
- `AnalysisPlotsModule.test.tsx` additions.
- ECharts option tests.
- Smoke script update for frequency-domain chart surface.
- Chart performance audit remains within idle/refetch budgets.

Exit criteria:

- Spectrum, mode table, dispersion, branch, and response charts render from resource fixtures.

## Stage 11 - 3D Mode And Response Visualization

Goal:

- Plot eigen modes and response fields in the unified 3D viewport.

Implementation:

1. Add analysis mode selection refs.
2. Add visualization state for analysis overlay.
3. Add plot/clear commands.
4. Add mode field resource adapter.
5. Extend viewport scene model for analysis mode fields.
6. Reuse vector field layer.
7. Add complex view controls.
8. Add phase animation.
9. Add colorbar handling for amplitude and phase.

Verification:

- Command tests.
- Viewport resource key tests.
- Scene model tests.
- Resource release tests.
- Browser smoke:
  - canvas visible,
  - WebGL context not lost,
  - drawing buffer non-zero,
  - mode overlay rendered,
  - overlay clears and releases resources.

Exit criteria:

- Selecting "Plot in 3D" on a mode or response point shows the field in the unified 3D viewport.

## Stage 12 - End-To-End Control Room Flow

Goal:

- Prove authoring, execution, result discovery, charting, and 3D visualization work together.

Implementation:

1. Add a small FEM eigen example that completes quickly in the managed runtime.
2. Add a small FEM response example after response execution lands.
3. Add a Control Room smoke that loads a completed artifact directory or runs a small managed example.
4. Exercise Explorer:
   - select stage,
   - select spectrum,
   - select mode,
   - select dispersion branch,
   - select response sweep,
   - select frequency point.
5. Exercise inspector actions:
   - plot mode in 3D,
   - clear mode overlay,
   - export artifacts.

Verification:

- Managed backend runtime recipe.
- Control Room unit tests.
- Control Room typecheck.
- Control Room lint.
- Control Room test suite.
- Browser smoke for chart and viewport.

Commands:

```bash
just verify-fem-frequency-domain-runtime
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room smoke:analysis-plots
CONTROL_ROOM_URL=http://localhost:3101/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Exit criteria:

- A user can author a response stage, run the actual frequency-domain solver, inspect response sweep and frequency points, plot response fields in 3D, and export artifacts.
- A user can author an eigen stage, run the modal solver, inspect spectrum and modes, plot a mode in 3D, and export canonical modal Python/API artifacts.

## Stage 13 - Documentation And Review Closure

Goal:

- Make the feature maintainable.

Implementation:

1. Update physics notes only for semantics that changed.
2. Update `docs/specs/frequency-domain-artifacts-v2.md`.
3. Update `docs/specs/resource-first-control-room-api-v2.md`.
4. Update frontend v2 module docs if new module capabilities or commands are added.
5. Update capability matrix.
6. Add screenshots or smoke artifacts for UI review.
7. Prepare PR description with backend, API, frontend, tests, and known unsupported paths.

Verification:

- Documentation links resolve.
- PR checklist includes every acceptance gate.
- No generated API drift.

Exit criteria:

- The implementation is reviewable without relying on tribal knowledge.

## Rollout Strategy

Recommended PR sequence:

1. Native contract skeleton and diagnostics probe.
2. Tangent/equilibrium/operator native foundations.
3. Driven response solve and artifacts.
4. Modal eigen/dispersion solve and artifacts.
5. Capability/OpenAPI/API facade/resource hooks.
6. Explorer tree and inspector registry.
7. Spectrum/dispersion/mode/response charts.
8. 3D mode and response visualization.
9. End-to-end smoke, docs, and cleanup.

Do not combine backend solver implementation and full frontend UI in one PR. The review surface would be too large and failures would be hard to isolate.

## Runner Eigen Test Migration Strategy

Current state:

- `crates/fullmag-runner/src/fem_eigen.rs` and `crates/fullmag-runner/tests/physics_validation.rs` contain the existing modal eigen validation surface.
- The native production modal backend is future work.

Target state:

- Existing runner eigen tests remain useful as reference-path tests.
- Native modal tests are added without deleting the reference oracle.
- The production backend must prove parity against the reference path on small meshes before it can replace it for larger workloads.

Migration rules:

1. Keep current runner eigen tests as reference-path tests unless a test is explicitly superseded by a better reference oracle.
2. Add native backend tests that compare against the runner reference on small deterministic meshes.
3. Mark tests by lane:
   - `reference_modal_runner`,
   - `native_modal_cpu`,
   - `native_modal_gpu_reference`,
   - `driven_response_cpu`,
   - `driven_response_gpu_future`.
4. Do not delete runner tests when native tests land; demote them only after equivalent native and cross-lane parity gates exist.
5. Preserve artifact compatibility tests for `eigen/spectrum.v2.json`, `eigen/branches.v2.json`, `eigen/dispersion.csv`, and mode metadata.
6. Any changed tolerance must cite the physics note or benchmark record that justifies it.

Verification:

- Existing runner tests pass before and after native modal work.
- Native modal smoke tests pass in the managed FEM container.
- Cross-lane parity test records reference versus native residuals and frequency deltas.

## Global Verification Matrix

Backend:

- native contract tests,
- tangent projection tests,
- operator tests,
- eigen physics validation,
- response physics validation,
- managed `just` runtime recipes.

API:

- OpenAPI route presence,
- manifest tests,
- artifact endpoint tests,
- field binary resource tests,
- realtime invalidation tests.

Frontend API:

- generated type check,
- facade tests,
- resource hook tests,
- no direct route-string test.

Explorer:

- node kind coverage,
- fixture tree snapshots,
- stable ID tests.

Inspector:

- registry coverage,
- model tests,
- accessibility tests,
- command dispatch tests.

Charts:

- chart model tests,
- ECharts option tests,
- selection event tests,
- performance audit.

Viewport:

- resource key tests,
- scene model tests,
- resource release tests,
- WebGL browser smoke.

End-to-end:

- managed FEM response run produces response artifacts,
- managed FEM modal run produces modal artifacts,
- Control Room discovers manifest,
- chart selection opens mode inspector,
- plot-in-3D renders a mode,
- response sweep renders and selects frequency points.

## Final Acceptance Gate

The frequency-domain module is production-ready only when:

- driven frequency-response backend support is real for the supported lanes,
- modal eigen/dispersion support is real for the supported lanes,
- unsupported lanes fail explicitly,
- Python and UI authoring round-trip to the same ProblemIR,
- API resources are typed and revision-driven,
- Explorer exposes the complete result tree,
- every node has an inspector,
- charts and tables render solver-created artifacts,
- 3D mode plotting works in the unified viewport,
- managed `just` verification and Control Room checks pass.
