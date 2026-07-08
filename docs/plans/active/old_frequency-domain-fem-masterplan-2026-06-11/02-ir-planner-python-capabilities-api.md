# 02 - IR, Planner, Python, Capabilities, API

## Current State

The semantic contract exists, but it is split across layers and not fully executable.

Python:

- `packages/fullmag-py/src/fullmag/model/study.py` defines `Eigenmodes` and `FrequencyResponse`.
- `Eigenmodes` validates output presence, operator, target, count, equilibrium options, k sampling, normalization, damping policy, and spin-wave boundary condition serialization.
- `FrequencyResponse` validates output presence, positive finite frequencies, finite excitation field, equilibrium options, k sampling, normalization, damping policy, and spin-wave boundary conditions.
- `packages/fullmag-py/src/fullmag/world.py` exposes staged helpers and flat entrypoints for eigenmodes and frequency response.
- `packages/fullmag-py/src/fullmag/runtime/script_builder.py` can export frequency-domain studies back to Python.

IR:

- `crates/fullmag-ir/src/study.rs` defines eigen operator, target, equilibrium source, k sampling, normalization, damping policy, and study variants.
- `crates/fullmag-ir/src/eigen_contract.rs` defines k-points, phase convention, mode tracking, spectrum output, mode output, dispersion output, and diagnostics output.
- `crates/fullmag-ir/src/frequency_response_contract.rs` defines excitation, sweep, response observables, and response study fields.
- `crates/fullmag-ir/src/lib.rs` validates eigen and frequency-response outputs.

Planner:

- `crates/fullmag-plan/src/fem.rs` plans FEM eigenmodes.
- `crates/fullmag-plan/src/lib.rs` rejects FDM frequency response explicitly and routes supported FEM response cases into `FemFrequencyResponsePlanIR`. Active rollout work executes the supported gamma/free-boundary magnetic slice through native MFEM production CPU when available and keeps dense validation as the reference/validation lane.
- Planner tests cover many eigen cases, FEM frequency response planning, production-slice gating, FDM response rejection, and time-integrator settings ignored by direct harmonic response.

Capability:

- `docs/specs/capability-matrix-v0.md` exposes frequency-domain booleans but keeps many as `false`.
- Current capability language does not yet distinguish reference modal eigen, production modal eigen, driven response, modal postprocessing, and mode-field visualization readiness.

API:

- `crates/fullmag-api/src/router_v2/handlers/analysis/eigen.rs` serves legacy and v2 eigen artifacts.
- `crates/fullmag-api/src/router_v2/handlers/analysis/response.rs` serves `magnetic_response_sweep.v1`.
- `crates/fullmag-api/src/openapi_v2.rs` includes those routes.
- `apps/control-room/src/kernel/api/apiPaths.ts` includes generated constants for all current eigen and response routes.
- `apps/control-room/src/kernel/api/ControlRoomApi.ts` exposes frequency-response sweep but not eigen routes.

## Target State

The frequency-domain analysis family must have one complete contract from Python to UI, while preserving the distinction between the direct driven solver and the modal solver:

- Python DSL can author `frequency_response` as the driven harmonic solver.
- Python DSL can author `eigenmodes` as the modal dynamic-matrix/eigensystem product.
- ProblemIR round-trips every supported field.
- Planner produces executable FEM plans for supported response cases and supported modal cases through separate plan types.
- Capabilities expose not just a boolean, but the exact readiness of each lane.
- OpenAPI documents response artifacts, modal artifacts, and field-like payload resources without merging their schemas.
- Control Room generated types and facade methods cover every endpoint the UI uses.
- Frontend resource hooks consume facade methods only.

## Target Contract Vocabulary

Use this vocabulary across Python, IR, planner, runtime, API, and frontend:

- `frequency_domain`: umbrella analysis family, not one solver.
- `calculation_mode`: UI/workflow preset that configures canonical studies; it is not a backend solver kind.
- `fmr_modal`: k = 0 modal FMR workflow implemented as `Eigenmodes`.
- `fmr_response`: k = 0 driven FMR sweep implemented as `FrequencyResponse`.
- `free_modes`: modal eigenmodes without Bloch/Floquet k-path sampling.
- `dispersion_modal`: Bloch/Floquet k-path eigenmode workflow implemented as `Eigenmodes`.
- `response_map`: future driven response over `(k, f)` implemented as `FrequencyResponse` once nonzero-k Floquet response is supported.
- `frequency_response`: driven harmonic response solve and the actual frequency-domain solver.
- `eigenmodes`: modal dynamic-matrix/eigensystem solve.
- `spectrum`: eigenfrequency list at one sample or many samples.
- `mode`: spatial complex dynamic magnetization profile.
- `branch`: tracked mode identity across k-path samples.
- `dispersion`: frequency versus path coordinate or k coordinate.
- `response_sweep`: direct driven response observables versus frequency.
- `frequency_point`: one driven response solve at one frequency.
- `mode_field`: field-like data-plane resource for 3D rendering, backed by
  Zarr by default and optionally HDF5/H5 with identical resource semantics.
- `phase_convention`: phasor and Floquet sign convention.
- `equilibrium_residual`: equilibrium quality metric before linearization.
- `tangent_leakage`: violation of the tangent constraint.
- `resolved_solver_engine`: actual native/reference engine used.
- `requested_execution`: user intent.
- `resolved_execution`: backend/device/precision actually used.

Calculation mode lowering rules:

- `fmr_modal` lowers to `StudyIR::Eigenmodes` with `k_sampling=None` or explicit `k=0`, periodic zero-phase boundary when requested, and FMR validation metadata.
- `fmr_response` lowers to `StudyIR::FrequencyResponse` with k = 0, a frequency sweep, explicit excitation, and response observables such as amplitude, phase, susceptibility, and absorbed power.
- `free_modes` lowers to `StudyIR::Eigenmodes` without k-path sampling and without periodic/Floquet requirements unless separately selected.
- `dispersion_modal` lowers to `StudyIR::Eigenmodes` with `k_sampling=KPath` or equivalent sample list, Floquet/Bloch boundary data, branch tracking, and dispersion output.
- `response_map` lowers to `StudyIR::FrequencyResponse` with a k grid/path plus frequency sweep; it remains capability-gated until nonzero-k driven response is implemented.
- The exported Python script must express the canonical study, not a UI-only calculation mode enum, unless a public Python helper is intentionally added with round-trip tests.

## Implementation Stage C1 - Python DSL Audit And Tightening

Current state:

- `Eigenmodes` and `FrequencyResponse` exist and serialize to IR.
- `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
  uses UI draft fields such as `targetFrequency`, while tests still preserve
  compatibility with the legacy target alias `near_frequency`; Python supports
  canonical `nearest` in `Eigenmodes.to_ir()`.

Target state:

- Python DSL names, UI draft names, IR names, planner names, and exported script names are aligned or explicitly translated at boundaries.

Instructions:

1. Build a table of public names from `packages/fullmag-py/src/fullmag/model/study.py`, `packages/fullmag-py/src/fullmag/world.py`, and `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`.
2. Identify every alias that exists only for compatibility.
3. Keep the public Python API stable unless a contradiction with physics notes exists.
4. Normalize UI-only names at the UI authoring boundary, not in backend code.
5. Treat `near_frequency` as a compatibility alias only; canonical exported
   Python and ProblemIR must use `nearest` plus `target_frequency`.
6. Add Python tests for:
   - eigen lowest target,
   - eigen nearest target,
   - k-vector legacy alias,
   - k-path sampling object,
   - frequency response two-point sweep,
   - unsupported output types.
7. Add script export tests proving UI-authored eigen and frequency-response stages export canonical Python.
8. Do not add backend-specific knobs to the public constructor unless they are under an explicit backend-hint object.

Verification:

- Targeted Python tests for `packages/fullmag-py`.
- Existing script export tests remain stable.
- Round-trip JSON snapshots contain canonical `kind` values.

## Implementation Stage C2 - IR Contract Completion

Current state:

- Eigen IR is rich enough for the current reference path.
- Frequency-response IR is first-class but not yet executable.
- Magnetoelastic observables exist as response enum values but the magnetic-only solver cannot implement them.

Target state:

- IR distinguishes supported magnetic-only response from future magnetoelastic response without changing public names later.

Instructions:

1. Add a response support discriminator if needed:
   - `physics_family: magnetic_llg`
   - future `physics_family: magnetoelastic_quasistatic`
   - future `physics_family: magnetoelastic_elastodynamic`
2. Keep existing enum values stable, but planner must reject observables outside the selected physics family.
3. Add `FrequencyResponseDiagnosticsOutputIR` if diagnostics cannot be represented by current outputs.
4. Add explicit mode-field output metadata if 3D visualization needs preselected modes or frequency points.
5. Keep heavy arrays out of ProblemIR.
6. Add validation for:
   - finite positive frequency list,
   - finite excitation field,
   - non-empty observables,
   - response output compatibility with physics family,
   - k-sampling compatibility with demag and boundary condition constraints.

Verification:

- `crates/fullmag-ir/tests/ir_tests.rs` gains response diagnostics and unsupported-observable tests.
- Existing eigen validation tests remain unchanged unless a bug is discovered.

## Implementation Stage C3 - Planner Executable Frequency Response

Current state:

- `StudyIR::FrequencyResponse` can plan supported FEM response cases.
- FDM frequency response remains explicitly rejected.
- The native MFEM/hypre/libCEED response solver is partially executable on CPU for the gamma-point/free-boundary magnetic slice; GPU, demag, nonzero-k Floquet/Bloch, periodic/Floquet enforcement, and magnetoelastic response remain unavailable.

Target state:

- Planner produces `FemFrequencyResponsePlanIR` for supported FEM magnetic-only cases.
- Planner still rejects unsupported FDM, unsupported magnetoelastic, unsupported Floquet demag, unsupported GPU, and unsupported precision cases explicitly.

Instructions:

1. Add `FemFrequencyResponsePlanIR` next to `FemEigenPlanIR` or in the same FEM plan module if the plan fields mostly overlap.
2. Reuse shared resolver functions for:
   - FEM mesh asset,
   - shared-domain object regions,
   - magnetic material parameters,
   - energy term support,
   - demag realization,
   - spin-wave boundary conditions,
   - periodic/Floquet metadata,
   - precision validation.
3. Do not duplicate modal planner logic by copy-paste. Extract only the shared operator/equilibrium/mesh planning pieces that are actually shared by modal and response solves.
4. Add response-specific fields:
   - excitation vector,
   - sweep values,
   - response observables,
   - output artifact plan.
5. Preserve requested intent and resolved execution in plan provenance.
6. Keep explicit unsupported-target errors for all combinations outside the proven FEM validation lane until the production native solver exists.
7. Convert the existing test `frequency_response_is_first_class_ir_but_not_executable_yet` into narrower tests:
   - supported FEM response plans once backend flag is enabled,
   - unsupported backend still rejects,
   - unsupported observables reject,
   - missing demag realization rejects when include demag is true,
   - Floquet dynamic demag rejects.
8. Keep the planner validation path explicit that `StudyIR::FrequencyResponse` has no time integrator. The shared planner control helper returns `integrator=None` for frequency response and still skips time-integrator alias, fixed/adaptive timestep, and adaptive-integrator compatibility validation for this study kind.

Verification:

- `cargo test -p fullmag-plan` through the managed FEM recipe where native FEM dependencies matter.
- Plan JSON snapshot includes response excitation, frequencies, observables, and provenance.

## Implementation Stage C4 - Capability Matrix Upgrade

Current state:

- Capability matrix exposes broad booleans such as `supports_frequency_response`.
- `eigen_modes` exists in API status capabilities.
- The frontend cannot tell whether modal results are reference-only, production-ready, GPU-ready, response-ready, modal-postprocessing-ready, or visualization-ready.

Target state:

- Capabilities are explicit enough to drive UI enablement without guessing.

Required capability fields:

```text
frequency_domain.modal.reference_cpu
frequency_domain.modal.production_cpu
frequency_domain.modal.production_gpu
frequency_domain.modal.k_path
frequency_domain.modal.mode_tracking
frequency_domain.modal.mode_field_payload
frequency_domain.modal.linewidths
frequency_domain.modal.absorption_from_modes
frequency_domain.boundary.static_periodic
frequency_domain.boundary.floquet_modal
frequency_domain.boundary.floquet_response
frequency_domain.boundary.periodic_pair_diagnostics
frequency_domain.demag.static_periodic_pbc
frequency_domain.demag.floquet_dynamic_k
frequency_domain.dispersion.k_path
frequency_domain.dispersion.branch_tracking
frequency_domain.validation.fmr_k0
frequency_domain.response.magnetic_cpu
frequency_domain.response.magnetic_gpu
frequency_domain.response.frequency_sweep
frequency_domain.response.mode_projected
frequency_domain.response.magnetoelastic_quasistatic
frequency_domain.response.magnetoelastic_elastodynamic
frequency_domain.visualization.modal_spectrum_chart
frequency_domain.visualization.modal_dispersion_chart
frequency_domain.visualization.mode_table
frequency_domain.visualization.mode_3d_overlay
frequency_domain.visualization.response_sweep_chart
frequency_domain.visualization.response_field_3d_overlay
```

Rules:

- Keep any existing flat booleans for compatibility until all consumers migrate.
- Add a nested capability resource for precise frontend gating.
- Every disabled UI command must show the capability reason and the missing backend lane.
- Capability values must distinguish:
  - unavailable,
  - semantic-only,
  - reference,
  - production,
  - experimental,
  - disabled-by-build.

Verification:

- `docs/specs/capability-matrix-v0.md` updated before implementation.
- API status test proves old and new capability fields are coherent.
- Control Room capability hook tests prove disabled commands show exact reasons.

## Implementation Stage C5 - OpenAPI And Backend Routes

Current state:

- Eigen v2 JSON routes exist.
- Response v1 JSON route exists.
- Mode field data-plane resources for 3D visualization do not exist as canonical analysis resources.

Target state:

- OpenAPI has all JSON control-plane resources and data-plane field resources
  needed for professional UI. Large arrays are stored in Zarr by default;
  HDF5/H5 is an alternate backend/export with the same public resource
  contract.

Required existing routes to keep:

```text
GET /v2/sessions/current/analysis/eigen/spectrum.v2
GET /v2/sessions/current/analysis/eigen/branches.v2
GET /v2/sessions/current/analysis/eigen/dispersion.csv
GET /v2/sessions/current/analysis/eigen/modes/{sample_index}/{mode_index}
GET /v2/sessions/current/analysis/frequency-response/magnetic-sweep.v1
```

Required new or formalized resources:

```text
GET /v2/sessions/current/analysis/frequency-domain/manifest.v1
GET /v2/sessions/current/analysis/eigen/diagnostics.v2
GET /v2/sessions/current/analysis/frequency-response/magnetic-sweep.v2
GET /v2/sessions/current/analysis/frequency-response/frequency-points/{frequency_index}
GET /v2/sessions/current/data/fields/{field_id}/samples/vector
```

Mode-field rule:

- Mode profiles and driven response profiles are registered as field-like data resources with `source_family = analysis/eigen` or `source_family = analysis/frequency-response`.
- The viewport uses the existing field-vector data-plane resource path after
  the manifest maps a mode or frequency point to a `field_id`. The HTTP
  response may be binary, but the artifact storage default is Zarr, not raw
  JSON arrays.
- The UI must not fetch large mode vectors from JSON mode metadata.

Instructions:

1. Add an analysis manifest that indexes all frequency-domain result artifacts from the active run.
2. Include resource keys, artifact paths, schema versions, revision values, sample indices, raw mode indices, branch IDs, and field IDs.
3. Keep JSON mode endpoint focused on metadata and small summaries.
4. Register mode field payloads in the data-plane field catalog and record
   `storage_format = zarr` plus the Zarr array path in metadata/provenance.
5. Add OpenAPI schemas for:
   - frequency-domain manifest,
   - eigen spectrum v2 typed shape,
   - branches v2 typed shape,
   - eigen diagnostics v2 typed shape,
   - response sweep v1/v2,
   - frequency point metadata,
   - analysis field source metadata.
6. Regenerate Control Room API types after OpenAPI changes.

Verification:

- API tests for manifest empty state, eigen-only state, response-only state, and combined eigen/response state.
- OpenAPI generation test proves the new paths are present.
- Control Room generated path constants include all new paths.

## Implementation Stage C6 - Control Room API Facade

Current state:

- `ControlRoomApi.analysis.frequencyResponse.magneticSweepV1()` exists.
- There is no `ControlRoomApi.analysis.eigen` facade.
- There is no `ControlRoomApi.analysis.frequencyDomain` family container.
- During active implementation, if `ControlRoomApi.analysis.frequencyDomain`
  is added first and contains modal endpoint methods, treat that as an
  intermediate state unless the namespace decision is explicitly accepted and
  covered by facade/resource tests.

Target state:

- Every frontend resource hook uses a typed facade method.
- Existing `api.analysis.frequencyResponse.magneticSweepV1()` remains unchanged for backward-compatible v1 sweep access.
- New `api.analysis.frequencyDomain` is the umbrella family namespace for manifest and cross-family resources.
- New `api.analysis.eigen` groups modal products such as spectrum, branches, dispersion, diagnostics, and mode metadata.
- Namespace compatibility rule: the existing `frequencyResponse` namespace is
  not removed; `frequencyDomain` is the family container; `eigen` is the modal
  product namespace unless an explicit ADR/spec amendment chooses the
  all-under-umbrella shape.

Required facade methods:

```ts
api.analysis.frequencyDomain.manifestV1()
api.analysis.eigen.spectrumV2()
api.analysis.eigen.branchesV2()
api.analysis.eigen.dispersionCsv()
api.analysis.eigen.modeV2(sampleIndex, modeIndex)
api.analysis.eigen.diagnosticsV2()
api.analysis.frequencyResponse.magneticSweepV1()
api.analysis.frequencyResponse.magneticSweepV2()
api.analysis.frequencyResponse.frequencyPoint(frequencyIndex)
api.analysis.frequencyResponse.fieldMeta(frequencyIndex)
```

Instructions:

1. Add types in `apps/control-room/src/kernel/api/apiTypes.ts` only after OpenAPI types exist or schema stubs are explicitly justified.
2. Add facade methods in `ControlRoomApi.ts`.
3. Use generated `apiPaths.ts` constants only.
4. Add `ControlRoomApi.test.ts` cases for every method, including path parameter substitution.
5. Ensure 404 artifacts are handled by resource hooks, not hidden in the facade.

Verification:

- `pnpm --dir apps/control-room test -- ControlRoomApi.test.ts`
- `pnpm --dir apps/control-room typecheck`

## Implementation Stage C7 - Resource Hooks

Current state:

- `useMagneticResponseSweepResource()` exists.
- Eigen resources are not wrapped.

Target state:

- Frequency-domain UI consumes resources through hooks with stable keys and revision behavior.

Required hooks:

```ts
useFrequencyDomainManifestResource()
useEigenSpectrumV2Resource()
useEigenBranchesV2Resource()
useEigenDispersionCsvResource()
useEigenModeV2Resource(sampleIndex, modeIndex)
useEigenDiagnosticsV2Resource()
useMagneticResponseSweepResource()
useMagneticResponseSweepV2Resource()
useFrequencyResponsePointResource(frequencyIndex)
useAnalysisModeFieldVectorResource(fieldId, query)
```

Instructions:

1. Place hooks in the central resource layer, not inside individual panels.
2. Reuse `ignoreMissingResource` for optional artifacts.
3. Use stable resource keys containing sample/mode/frequency identifiers.
4. Do not keep server data in module-local Zustand state.
5. Expose loading, stale, missing, and error states separately.
6. Add tests asserting hooks call the facade and use stable keys.

Verification:

- `studyRuntimeResources.test.ts` or a dedicated frequency-domain resources test.
- Resource cache tests for mode switching and repeated mode selection.

## Contract Acceptance Gate

This layer is complete only when:

- Python, IR, planner, OpenAPI, API facade, and resource hooks use the same vocabulary.
- Supported FEM response planning no longer reports semantic-only once native response execution is available.
- Unsupported response paths still fail before execution.
- Generated API artifacts are updated and committed with the source OpenAPI changes.
- Frontend code has no raw `/v2/...` strings for frequency-domain routes outside the API layer.
