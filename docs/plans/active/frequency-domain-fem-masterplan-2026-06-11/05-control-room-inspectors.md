# 05 - Control Room Inspectors

## Current State

Current inspector routing:

- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` routes `study.stage.eigenmodes` and `study.stage.frequency_response` to `StudyStageInspectorRouter`.
- `StudyPipelineSection.tsx` renders basic draft fields for eigenmodes and frequency response.
- There are no dedicated result inspectors for eigen spectrum, mode rows, dispersion, branches, response sweeps, response frequency points, or mode-field visualization.

Current UX failure:

- Frequency-domain results cannot be inspected like scientific objects.
- There is no calculation-mode inspector for choosing FMR, dispersion, free modes, driven sweep, or response-map workflows.
- There is no selected mode inspector.
- There is no spectrum chart inspector.
- There is no branch table inspector.
- There is no frequency-response chart inspector.
- There is no "plot this mode in 3D" workflow.
- The UI does not distinguish the driven frequency-response solver from modal eigen/dispersion results.

## Target State

Every Explorer node from `04-control-room-explorer-tree.md` has a specific inspector. The inspector is responsible for one domain object and can include charts, tables, controls, and commands, but it must not own server state directly. Inspectors must label `frequency_response` as the driven solver and `eigenmodes` as the modal solver/result family.

Rules:

- Inspectors use resource hooks and typed models.
- Inspectors do not call `fetch()`.
- Inspectors do not import from `apps/legacy_web`.
- Inspectors do not directly mutate `viewport-3d`; they dispatch commands or update visualization state through kernel services.
- Every inspector has loading, missing, stale, failed, unsupported, and ready states where those states can occur.
- Every inspector uses `fm-` CSS class names and design tokens.

## Inspector Registry Additions

Required registry entries:

```text
frequency-domain-stage
frequency-domain-calculation-mode
frequency-domain-boundary
frequency-domain-periodic-pairs
frequency-domain-k-path
frequency-domain-k-grid
frequency-domain-floquet-phase-preview
frequency-domain-result-overview
frequency-domain-fmr
frequency-domain-fmr-modal-spectrum
frequency-domain-fmr-response-sweep
frequency-domain-fmr-peaks
frequency-domain-dispersion-workflow
frequency-domain-response-map
eigen-result
eigen-spectrum
eigen-modes
eigen-mode
eigen-dispersion
eigen-k-path
eigen-branches
eigen-branch
eigen-diagnostics
eigen-provenance
frequency-response-result
frequency-response-sweep
frequency-response-frequency-points
frequency-response-frequency-point
frequency-response-observables
frequency-response-observable
frequency-response-diagnostics
frequency-response-provenance
frequency-domain-resource
frequency-domain-job
frequency-domain-diagnostics
frequency-domain-periodic-floquet-diagnostics
```

## Authoring Inspectors

### `study.stage.*.calculation_mode`

Inspector: `FrequencyDomainCalculationModeInspector`

Purpose:

- Select and explain the calculation workflow before the user edits low-level fields.

Modes:

- `fmr_modal`: k = 0 modal FMR, lowers to `Eigenmodes`.
- `fmr_response`: k = 0 driven FMR sweep, lowers to `FrequencyResponse`.
- `free_modes`: normal modal spectrum without k-path, lowers to `Eigenmodes`.
- `dispersion_modal`: Bloch/Floquet k-path dispersion, lowers to `Eigenmodes`.
- `response_map`: future driven response over k and frequency, lowers to `FrequencyResponse` and remains capability-gated until implemented.

Fields:

- workflow mode,
- canonical study kind,
- boundary preset,
- k requirement,
- sweep requirement,
- required excitation,
- required artifacts,
- current capability status.

Validation:

- `fmr_modal` requires k = 0 or no k-path.
- `fmr_response` requires a frequency sweep and excitation.
- `dispersion_modal` requires k-path sampling and valid periodic/Floquet metadata.
- `response_map` requires k sampling and frequency sweep but is disabled until the backend supports nonzero-k driven response.
- Changing calculation mode shows a diff of canonical fields that will be patched.

Tables:

- Mode-to-study lowering table.
- Required artifact table.

Commands:

- `study.set-frequency-domain-calculation-mode`
- `study.validate-frequency-domain-calculation-mode`

### `study.stage.eigenmodes`

Inspector: `FrequencyDomainEigenStageInspector`

Purpose:

- Edit and validate the full Eigenmodes stage.

Sections:

- Summary: stage ID, status, capability status, expected result family.
- Calculation mode: FMR modal, free modes, or dispersion modal.
- Equilibrium: provided, relaxed, artifact; artifact path; residual expectation.
- Operator: linearized LLG, include demag, damping, normalization.
- Boundary: free, pinned, periodic, Floquet; k vector; k path.
- Solver: count, target, target frequency, precision, backend/device intent.
- Outputs: spectrum, modes, dispersion, diagnostics.
- Actions: validate, run stage, open latest result, export canonical Python.

Charts:

- None required before solve.

Tables:

- Output request table.
- Capability compatibility table.

Commands:

- `study.run-frequency-domain-stage`
- `analysis.eigen.open-spectrum` when latest result exists.

Verification:

- Invalid count disables run.
- Unsupported Floquet demag displays planner reason.
- Exported Python preserves all authored fields.

### `study.stage.eigenmodes.setup`

Inspector: `FrequencyDomainEigenSetupInspector`

Purpose:

- Narrow editor for count, target, target frequency, backend/device/precision intent.

Fields:

- mode count,
- target type,
- target frequency,
- requested backend,
- requested device,
- requested precision,
- execution mode.

Validation:

- count must be positive integer,
- target frequency must be positive when target is nearest,
- unsupported device shows capability reason.

### `study.stage.eigenmodes.equilibrium`

Inspector: `FrequencyDomainEquilibriumInspector`

Purpose:

- Edit and explain the equilibrium source used for linearization.

Fields:

- equilibrium source,
- artifact selector,
- relaxation prerequisite,
- current state eligibility.

Diagnostics:

- latest equilibrium residuals if a previous result exists.

### `study.stage.eigenmodes.operator`

Inspector: `FrequencyDomainOperatorInspector`

Purpose:

- Edit physical operator options.

Fields:

- operator kind,
- include demag,
- demag realization preview,
- damping policy,
- normalization,
- included energy terms from model.

Diagnostics:

- unsupported energy terms,
- demag compatibility,
- damping support.

### `study.stage.eigenmodes.boundary`

Inspector: `FrequencyDomainBoundaryInspector`

Purpose:

- Edit spin-wave boundary and k sampling.

Fields:

- boundary condition,
- periodic axes,
- Floquet k vector,
- k-path points,
- samples per segment,
- closed path toggle,
- phase convention display.

Validation:

- periodic and Floquet require periodic node pairs.
- Floquet demag support must be explicit.

### `study.stage.eigenmodes.periodic_pairs`

Inspector: `PeriodicPairDiagnosticsInspector`

Purpose:

- Inspect and validate periodic pair metadata used by modal FMR and dispersion.

Data:

- `mesh/periodic_pairs.v1.json` or active mesh snapshot resource,
- pair IDs,
- translations,
- paired/unpaired counts,
- residual diagnostics,
- validation status.

Actions:

- open Floquet phase preview,
- select pair in viewport when supported,
- copy diagnostics summary.

### `study.stage.eigenmodes.k_path`

Inspector: `KPathInspector`

Purpose:

- Edit and validate the k-path used by modal dispersion.

Fields:

- k-point labels,
- k vectors in `rad_per_m`,
- display unit conversion,
- samples per segment,
- endpoint deduplication,
- phase convention preview.

Validation:

- at least two k points for path dispersion,
- positive sample count per segment,
- no nonzero-k Floquet demag unless supported.

### `study.stage.eigenmodes.solver`

Inspector: `FrequencyDomainEigenSolverInspector`

Purpose:

- Show solver engine selection and constraints.

Fields:

- solver target,
- mode count,
- production/reference engine,
- precision,
- device,
- sparse/dense qualification.

Tables:

- requested versus resolved execution when result exists.

### `study.stage.eigenmodes.outputs`

Inspector: `FrequencyDomainEigenOutputsInspector`

Purpose:

- Select expected eigen artifacts.

Fields:

- spectrum scope,
- selected mode indices,
- selected branch IDs,
- selected sample indices,
- dispersion curve output,
- diagnostics output flags.

### `study.stage.eigenmodes.diagnostics`

Inspector: `FrequencyDomainStageDiagnosticsInspector`

Purpose:

- Show authoring-time and latest-run diagnostics for the stage.

Sections:

- validation messages,
- capability messages,
- latest solver diagnostics,
- latest artifact manifest status.

### `study.stage.frequency_response`

Inspector: `FrequencyDomainResponseStageInspector`

Purpose:

- Edit and validate the full Frequency Response stage.

Sections:

- Summary,
- Calculation mode: FMR response, driven sweep, or response map.
- Equilibrium,
- Operator,
- Excitation,
- Frequency sweep,
- Solver,
- Outputs,
- Diagnostics.

Commands:

- `study.run-frequency-domain-stage`
- `analysis.frequency-response.open-sweep`.

### `study.stage.frequency_response.boundary`

Inspector: `FrequencyResponseBoundaryInspector`

Purpose:

- Configure k = 0 periodic response or future Bloch/Floquet response-map boundary semantics.

Fields:

- free versus periodic-zero-phase versus Floquet/Bloch,
- periodic pair requirement,
- k = 0 FMR response mode,
- future nonzero-k response-map capability status.

Validation:

- nonzero-k response map remains unavailable until backend support exists,
- nonzero-k Floquet demag rejects with the same diagnostic as modal Floquet demag.

### `study.stage.frequency_response.periodic_pairs`

Inspector: `PeriodicPairDiagnosticsInspector`

Purpose:

- Reuse the periodic pair diagnostics panel for driven response workflows.

Data:

- same `mesh/periodic_pairs.v1` resource as modal workflows,
- requested response calculation mode,
- response-specific capability status.

### `study.stage.frequency_response.k_grid`

Inspector: `FrequencyResponseKGridInspector`

Purpose:

- Configure future response maps over `(k, f)`.

Current behavior:

- Capability-gated unavailable state until nonzero-k driven response exists.

Target fields:

- k path or k grid,
- frequency sweep,
- k/f sampling density,
- output slice policy.

### `study.stage.frequency_response.excitation`

Inspector: `FrequencyDomainExcitationInspector`

Purpose:

- Edit harmonic drive.

Fields:

- excitation vector in A/m,
- coordinate frame,
- optional antenna/source selector when future antenna coupling is wired,
- normalized drive preview.

Validation:

- vector components must be finite,
- zero vector is invalid for driven response.

### `study.stage.frequency_response.sweep`

Inspector: `FrequencyDomainSweepInspector`

Purpose:

- Edit frequency list.

Fields:

- explicit frequency list,
- range start,
- range stop,
- count,
- linear/log spacing,
- unit display Hz/GHz.

Validation:

- all frequencies positive finite,
- deduplicate or reject duplicates according to finalized DSL behavior.

## Result Inspectors

### `results.frequency_domain.root`

Inspector: `FrequencyDomainResultsOverviewInspector`

Purpose:

- Overview of all available frequency-domain results in the active session.

Data:

- manifest,
- stage list,
- run list,
- capability snapshot,
- missing-artifact state.

Actions:

- open latest eigen spectrum,
- open latest response sweep,
- export all frequency-domain artifacts,
- clear 3D mode overlay.

### `results.frequency_domain.run`

Inspector: `FrequencyDomainRunInspector`

Purpose:

- One solved run summary.

Sections:

- requested versus resolved execution,
- artifacts created,
- runtime duration,
- engine provenance,
- validation status.

### `results.frequency_domain.fmr`

Inspector: `FrequencyDomainFmrInspector`

Purpose:

- Show the FMR workflow result regardless of whether it came from modal k = 0 eigenmodes, driven k = 0 response, or both.

Data:

- calculation mode,
- equilibrium summary,
- k = 0 or periodic-zero-phase boundary summary,
- modal spectrum availability,
- driven sweep availability,
- peak table availability,
- validation status.

Charts:

- compact FMR frequency overview when modal data exists,
- compact response peak overview when driven sweep data exists.

Actions:

- open FMR modal spectrum,
- open FMR response sweep,
- open FMR peaks,
- compare modal resonance and driven response peak.

### `results.frequency_domain.fmr_modal_spectrum`

Inspector: `FmrModalSpectrumInspector`

Purpose:

- Inspect k = 0 modal FMR frequencies and selected mode profiles.

Charts:

- modal spectrum chart,
- optional linewidth chart when damping is included.

Tables:

- mode table with frequency, damping/linewidth, residual, tangent leakage, and field availability.

Actions:

- plot selected FMR mode in 3D,
- add mode to comparison,
- export modal spectrum.

### `results.frequency_domain.fmr_response_sweep`

Inspector: `FmrResponseSweepInspector`

Purpose:

- Inspect driven FMR response over frequency.

Charts:

- amplitude versus frequency,
- phase versus frequency,
- absorbed power versus frequency,
- susceptibility component selector.

Tables:

- frequency-point table,
- peak table with resonance frequency, amplitude, phase, linewidth estimate, and residual.

Actions:

- select frequency point,
- plot response field in 3D when available,
- compare strongest response peak with modal FMR frequency.

### `results.frequency_domain.fmr_peaks`

Inspector: `FmrPeaksInspector`

Purpose:

- Inspect detected or manually selected FMR peaks.

Data:

- peak frequency,
- source: modal or driven response,
- amplitude or mode norm,
- linewidth,
- quality factor,
- validation status,
- linked mode or frequency point.

### `results.frequency_domain.dispersion`

Inspector: `FrequencyDomainDispersionWorkflowInspector`

Purpose:

- Inspect the full dispersion workflow, including k-path, branches, selected modes, and capability diagnostics.

Charts:

- `f(k)` dispersion chart using `path_s_rad_per_m`,
- branch continuity chart,
- optional reciprocal/nonreciprocal comparison chart.

Tables:

- k sample table,
- branch table,
- selected mode table.

Actions:

- open k-path inspector,
- open selected branch,
- plot selected mode in 3D,
- run reciprocal dispersion validation when fixture support exists.

### `results.frequency_domain.response_map`

Inspector: `FrequencyResponseMapInspector`

Purpose:

- Inspect future driven Bloch/Floquet response over `(k, f)`.

Current behavior:

- Shows unavailable/capability-gated state until nonzero-k driven response is implemented.

Target charts:

- k/f intensity map,
- response sweep slice at selected k,
- response versus k at selected frequency.

Actions:

- select k sample,
- select frequency point,
- plot response field in 3D when available.

### `results.eigen.root`

Inspector: `EigenResultOverviewInspector`

Purpose:

- Overview of one eigen stage result family.

Data:

- mode count,
- sample count,
- branch count,
- frequency range,
- k-path summary,
- diagnostics summary,
- latest selected mode.

Actions:

- open spectrum,
- open dispersion,
- open modes table,
- plot selected mode in 3D.

### `results.eigen.study`

Inspector: `EigenStudyResultInspector`

Purpose:

- Link solved result back to the authoring stage and ProblemIR.

Sections:

- stage authoring snapshot,
- ProblemIR hash,
- plan hash,
- mesh/equilibrium references,
- solver engine.

### `results.eigen.spectrum`

Inspector: `EigenSpectrumInspector`

Purpose:

- Plot spectrum and select modes.

Data:

- `eigen/spectrum.v2.json`,
- mode metadata summaries,
- optional diagnostics.

Charts:

- eigenfrequency versus raw mode index,
- imaginary frequency or damping rate when present,
- residual overlay as secondary axis.

Tables:

- mode table with columns:
  - sample,
  - sample label,
  - raw mode,
  - branch,
  - frequency Hz/GHz,
  - imaginary frequency,
  - damping rate,
  - residual,
  - tangent leakage,
  - 3D field availability.

Actions:

- select mode,
- open mode inspector,
- plot mode in 3D,
- add series to analysis plot.

### `results.eigen.modes`

Inspector: `EigenModesTableInspector`

Purpose:

- Mode catalog with filters.

Filters:

- sample index,
- branch ID,
- frequency range,
- residual threshold,
- field availability.

Actions:

- open selected mode,
- plot selected mode in 3D,
- compare selected modes,
- export selected mode metadata.

### `results.eigen.mode`

Inspector: `EigenModeInspector`

Purpose:

- Inspect one mode and control 3D visualization.

Data:

- mode metadata,
- field resource registration,
- diagnostics.

Sections:

- Identity: sample, raw mode, branch, mode ID.
- Frequency: real frequency, imaginary part, damping, target distance.
- Spatial summary: amplitude extrema, component extrema, localization.
- Diagnostics: residual, orthogonality, tangent leakage, convergence.
- Visualization: current 3D overlay state.

Controls:

- Plot in 3D.
- Replace current 3D mode overlay.
- Add as second overlay only in future multi-overlay scope.
- Clear overlay.
- View component: vector, x, y, z, norm.
- Static complex view: real, imaginary, abs/amplitude, and phase remain explicit
  display modes for the stored complex mode.
- Animated view: phase-rotated real is the only required animated modal view.
- Visualization phase slider `0..2*pi` for the currently displayed mode overlay.
- Animate the currently displayed mode by cycling the visualization phase
  through `0..2*pi`.
- Animation rate control in Hz or cycles/s, clamped to a documented safe UI range.
- Play, pause, and reset-to-zero controls for the visualization phase.
- Pause/resume animation without losing the selected `fieldId`, sample, raw mode, branch, component, view, or normalization state.
- Glyph density.
- Surface color quantity for amplitude.
- Normalize glyph length by mode max.

Charts:

- optional compact component amplitude bar chart.

Animation requirements:

- The animation UI belongs to the inspector of the concrete mode that is
  currently displayed in the 3D overlay. Spectrum, branch, and dispersion
  inspectors may offer "plot/animate selected mode" shortcuts, but the canonical
  play/pause/rate/phase controls live in `results.eigen.mode` after the mode is
  selected and its overlay identity is known.
- Animation is allowed only when the selected mode has a ready mode-field resource.
- The inspector must show the active animated mode identity: `fieldId`, sample index, raw mode index, branch ID where available, and phase convention.
- Animation is visualization-only and must not enqueue a solver run or mutate artifacts.
- The animation control updates shared visualization overlay state, not inspector-local state only.
- Animation reconstructs the visible dynamic mode by applying a UI phase offset
  to the stored complex eigenvector. The displayed frame is equivalent to
  `Re(delta_m * exp(i * visualizationPhaseRad))` for the active mode and
  selected component.
- `visualizationPhaseRad` is separate from the physical mode phase stored in
  the complex eigenvector and from the phasor/Floquet phase convention metadata.
  The inspector must label it as visualization phase, not as physical mode phase.
- Static real, imaginary, abs/amplitude, and phase views must not be implemented
  by mutating `visualizationPhaseRad`; they are explicit display modes.
- While playback is active, viewport updates are dirty-driven by the changing
  visualization phase only for the selected mode overlay.
- Stopping animation must stop phase updates, release any timer, and leave the last selected phase visible.
- Switching to another mode while animation is active must retarget the animation to the new mode only after the new mode-field resource is ready; otherwise animation pauses and reports the missing resource.
- Tests must prove static view selection, play, pause, reset-to-zero, visualization
  phase advance, mode switch, clear overlay, viewport dirty invalidation while
  playing, no idle invalidation while paused, and unmount cleanup.

### `results.eigen.dispersion`

Inspector: `EigenDispersionInspector`

Purpose:

- Plot dispersion and branch tracking.

Data:

- `eigen/dispersion.csv`,
- `eigen/branches.v2.json`,
- path metadata.

Charts:

- frequency versus path coordinate,
- branch-colored curves,
- optional raw sample scatter,
- residual or overlap overlay.

Tables:

- k-sample table,
- branch summary table.

Actions:

- select branch,
- select point,
- open mode at point,
- plot selected point mode in 3D,
- export CSV.

### `results.eigen.k_path`

Inspector: `EigenKPathInspector`

Purpose:

- Inspect k-path geometry and sample labels.

Data:

- path points,
- labels,
- sample count,
- closed/open path,
- phase convention.

Charts:

- path coordinate preview.

### `results.eigen.branches`

Inspector: `EigenBranchesInspector`

Purpose:

- Branch table.

Columns:

- branch ID,
- sample coverage,
- frequency min/max,
- mean overlap,
- max branch gap,
- representative mode,
- warnings.

Actions:

- open branch,
- highlight branch in dispersion chart,
- plot representative mode.

### `results.eigen.branch`

Inspector: `EigenBranchInspector`

Purpose:

- Inspect one tracked branch.

Charts:

- frequency versus path coordinate for this branch,
- overlap versus sample.

Tables:

- sample row,
- raw mode index,
- frequency,
- overlap,
- residual,
- mode field availability.

Actions:

- open sample mode,
- plot sample mode in 3D,
- export branch CSV.

### `results.eigen.diagnostics`

Inspector: `EigenDiagnosticsInspector`

Purpose:

- Solver and physics diagnostics.

Sections:

- equilibrium residuals,
- operator diagnostics,
- per-mode residuals,
- orthogonality matrix summary,
- tangent leakage,
- branch tracking diagnostics,
- warning/error list.

Charts:

- residual versus mode,
- tangent leakage versus mode,
- overlap heatmap when branch tracking exists.

### `results.eigen.provenance`

Inspector: `EigenProvenanceInspector`

Purpose:

- Full reproducibility metadata.

Tables:

- requested versus resolved execution,
- native library/build versions,
- mesh/equilibrium artifacts,
- ProblemIR/plan hashes,
- output artifact paths.

### `results.frequency_response.root`

Inspector: `FrequencyResponseResultOverviewInspector`

Purpose:

- Overview of one response result family.

Data:

- sweep count,
- frequency range,
- observables,
- diagnostics summary,
- field resource availability.

### `results.frequency_response.study`

Inspector: `FrequencyResponseStudyResultInspector`

Purpose:

- Link response result back to authoring stage and ProblemIR.

Sections:

- excitation,
- sweep,
- observables,
- solver engine,
- mesh/equilibrium references.

### `results.frequency_response.sweep`

Inspector: `FrequencyResponseSweepInspector`

Purpose:

- Plot driven response.

Data:

- `magnetic_response_sweep.v1` and future v2.

Charts:

- response amplitude versus frequency,
- response phase versus frequency,
- absorbed power versus frequency,
- susceptibility components versus frequency.

Tables:

- frequency point rows with amplitude, phase, power, susceptibility, convergence, field availability.

Actions:

- select frequency point,
- plot response field in 3D,
- add series to analysis plot,
- export sweep.

### `results.frequency_response.progress`

Inspector: `FrequencyResponseProgressInspector`

Purpose:

- Show final or current driven-response sweep progress.
- Distinguish `ready`, `interrupted`, and missing-progress states.

Data:

- `response/progress.v1.json`.
- `/v2/sessions/current/analysis/frequency-domain/response/progress.v1`.

Fields:

- total frequency points,
- completed frequency points,
- written frequency-point artifacts,
- current frequency,
- latest artifact manifest,
- partial artifact availability,
- embedded progress JSON.

### `results.frequency_response.cancel_requested`

Inspector: `FrequencyResponseCancelRequestedInspector`

Purpose:

- Show the explicit cancellation request state for a driven-response sweep.
- Keep `cancel_requested` separate from final `interrupted` progress so the UI can explain that a user/runtime stop request was observed before the sweep wrote its final interrupted bundle.

Data:

- `response/cancel_requested.v1.json`.
- `/v2/sessions/current/analysis/frequency-domain/response/cancel-requested.v1`.

Fields:

- cancel state,
- completed frequency points at cancellation,
- written frequency-point artifacts at cancellation,
- current frequency,
- latest artifact manifest,
- partial artifact availability,
- embedded progress JSON.

Actions:

- open partial response artifacts,
- inspect final interrupted progress,
- inspect cancellation provenance.

### `results.frequency_response.frequency_points`

Inspector: `FrequencyResponseFrequencyPointsInspector`

Purpose:

- Table of solved frequency points.

Filters:

- frequency range,
- observable,
- response amplitude threshold,
- convergence status.

Actions:

- open frequency point,
- plot selected field in 3D.

### `results.frequency_response.frequency_point`

Inspector: `FrequencyResponseFrequencyPointInspector`

Purpose:

- Inspect one frequency solve.

Sections:

- frequency,
- excitation,
- response observables,
- diagnostics,
- field resource.

Controls:

- plot response field in 3D,
- component selector,
- phase selector,
- amplitude/phase/real/imag view.

### `results.frequency_response.observables`

Inspector: `FrequencyResponseObservablesInspector`

Purpose:

- List observables available in the sweep.

Rows:

- observable ID,
- unit,
- component shape,
- chart availability,
- field availability.

### `results.frequency_response.observable`

Inspector: `FrequencyResponseObservableInspector`

Purpose:

- Inspect one observable across the sweep.

Charts:

- observable-specific line chart.

Actions:

- add to analysis plot,
- export observable series.

### `results.frequency_response.diagnostics`

Inspector: `FrequencyResponseDiagnosticsInspector`

Purpose:

- Driven-solve diagnostics.

Charts:

- linear solve residual versus frequency,
- iteration count versus frequency,
- absorbed power sanity check.

### `results.frequency_response.provenance`

Inspector: `FrequencyResponseProvenanceInspector`

Purpose:

- Response reproducibility metadata.

Tables:

- requested/resolved execution,
- excitation,
- sweep,
- artifacts,
- hashes,
- solver engine.

## Resource Inspectors

All resource node kinds map to `FrequencyDomainResourceInspector` with a domain-specific view determined by `selection.kind`.

Required views:

- manifest,
- spectrum,
- branches,
- dispersion,
- diagnostics,
- mode metadata,
- mode field,
- response sweep,
- frequency point,
- response field.

Fields shown:

- resource key,
- artifact path,
- schema version,
- revision,
- cache status,
- last invalidation,
- byte size when available,
- content type,
- linked result node.

Actions:

- open linked result,
- refetch resource,
- copy resource key,
- export artifact when backend supports it.

## Job Inspectors

All job node kinds map to `FrequencyDomainJobInspector`.

Views:

- stage run,
- eigen sample,
- response frequency,
- artifact export.

Fields:

- command ID,
- stage ID,
- run ID,
- status,
- progress,
- current sample/frequency,
- started at,
- duration,
- last error,
- cancellation support.

Actions:

- pause,
- resume,
- stop,
- open partial results if manifest exists.

## Diagnostic Inspectors

### `diagnostics.frequency_domain.capabilities`

Inspector: `FrequencyDomainCapabilitiesInspector`

Shows:

- semantic support,
- reference support,
- production CPU support,
- production GPU support,
- response support,
- visualization support,
- disabled reasons.

### `diagnostics.frequency_domain.equilibrium`

Inspector: `FrequencyDomainEquilibriumDiagnosticsInspector`

Shows:

- max `||m0|-1|`,
- max `|m0 x H0|`,
- RMS residual,
- object breakdown,
- artifact source.

### `diagnostics.frequency_domain.operator`

Inspector: `FrequencyDomainOperatorDiagnosticsInspector`

Shows:

- DOF counts,
- nonzeros,
- energy terms,
- demag realization,
- boundary realization,
- conditioning estimate.

### `diagnostics.frequency_domain.solver`

Inspector: `FrequencyDomainSolverDiagnosticsInspector`

Shows:

- engine,
- convergence,
- residuals,
- iterations,
- timings,
- memory/device information.

### `diagnostics.frequency_domain.artifacts`

Inspector: `FrequencyDomainArtifactDiagnosticsInspector`

Shows:

- all expected artifacts,
- present/missing state,
- schema versions,
- parse errors.

### `diagnostics.frequency_domain.api_resources`

Inspector: `FrequencyDomainApiResourceDiagnosticsInspector`

Shows:

- resource keys,
- hook state,
- cache revisions,
- 404 state,
- stale/loading/error.

### `diagnostics.frequency_domain.visualization`

Inspector: `FrequencyDomainVisualizationDiagnosticsInspector`

Shows:

- active mode field,
- vector payload query,
- colorbar state,
- WebGL buffer status,
- resource release status.

## Inspector Implementation Plan

Files to add:

```text
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainEigenStageInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResponseStageInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResultInspectors.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/EigenSpectrumInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/EigenModeInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyResponseSweepInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainResourceInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainJobInspector.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/FrequencyDomainDiagnosticsInspectors.tsx
apps/control-room/src/modules/inspector/panels/frequency-domain/frequencyDomainInspectorModel.ts
apps/control-room/src/modules/inspector/panels/frequency-domain/frequencyDomainInspectorTypes.ts
```

File sizing:

- `FrequencyDomainResultInspectors.tsx` may group small related result inspectors, but it must not become a catch-all file for every panel.
- Split result inspectors into narrower files once a file crosses roughly 500 lines of non-model UI code or mixes unrelated lifecycles.
- Keep parsing, selection, and chart/table shaping in `frequencyDomainInspectorModel.ts`, not inside React components.
- Treat frontend file-size limits as review triggers, not automatic split commands.

Existing files to change:

- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- `apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`

Step-by-step instructions:

1. Add model-only functions before React components.
2. Write tests for model functions before adding JSX.
3. Add registry entries for every node kind.
4. Add a test that enumerates all frequency-domain node kinds and asserts no placeholder fallback.
5. Add inspector fixtures for missing manifest, eigen-only manifest, response-only manifest, and combined manifest.
6. Add command dispatch tests for plot-in-3D buttons.
7. Add accessibility checks for tables and charts.
8. Keep charts in shared chart components or analysis-plots components; inspectors can embed chart views but should not duplicate chart option logic.

## Inspector Acceptance Gate

This layer is complete only when:

- Selecting every frequency-domain Explorer node opens a domain-specific inspector.
- Spectrum inspector renders chart plus mode table.
- Mode inspector can dispatch plot-in-3D with selected mode field resource.
- Dispersion inspector can select branch and mode point.
- Response sweep inspector renders amplitude and phase charts plus frequency table.
- Diagnostics inspectors expose residuals and provenance without requiring raw artifact inspection.
- Tests prove no frequency-domain selection routes to `PlaceholderPanel`.
