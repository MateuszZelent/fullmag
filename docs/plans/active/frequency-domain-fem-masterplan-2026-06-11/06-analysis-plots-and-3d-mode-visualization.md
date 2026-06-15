# 06 - Analysis Plots And 3D Mode Visualization

## Current State

Analysis plots:

- `apps/control-room/src/modules/analysis-plots` renders scalar/table-oriented charts and hysteresis chart variants.
- It uses ECharts, chart series models, event emission, and chart performance tests.
- It does not currently adapt eigen spectrum, dispersion, branches, mode tables, or response sweeps into chart surfaces.

Viewport 3D:

- `apps/control-room/src/modules/viewport-3d` has resource-driven topology, vector fields, scalar coloring, colorbar, invalidation, and memory-stress tests.
- It already has a binary field-vector resource path for runtime fields.
- It does not know about analysis mode fields or complex frequency-domain phase controls.

Selection bridge:

- `analysis-plots` already emits chart selection events.
- `viewport-3d` already handles some analysis chart selections for hysteresis snapshot routing.
- There is no typed selection for eigen mode, dispersion point, branch, or response frequency point.

## Target State

The UI must provide professional frequency-domain analysis without merging driven response and modal products:

- Calculation-mode aware chart routing for FMR, free modes, modal dispersion, driven sweep, and future response map.
- Eigen spectrum chart with mode selection for the modal solver.
- Mode table with diagnostics and 3D plot commands.
- Dispersion chart with branch-colored lines.
- Branch table and branch detail chart.
- Frequency response chart with amplitude, phase, absorbed power, and susceptibility views for the driven solver.
- Frequency-point table with 3D response-field plotting.
- 3D dynamic mode visualization with complex phase controls.
- Chart selections, table selections, Explorer selections, and viewport overlays remain synchronized through kernel selection and resource state.

## Analysis Plot Data Models

Add model types under `apps/control-room/src/modules/analysis-plots` or shared domain if consumed by inspectors and module views:

```ts
type FrequencyDomainCalculationMode =
  | "fmr_modal"
  | "fmr_response"
  | "free_modes"
  | "dispersion_modal"
  | "response_map";

type EigenSpectrumPoint = {
  sampleIndex: number;
  rawModeIndex: number;
  branchId: string | null;
  frequencyHz: number;
  imaginaryFrequencyHz: number | null;
  dampingRateHz: number | null;
  residualNorm: number | null;
  tangentLeakageMax: number | null;
  modeFieldId: string | null;
};

type EigenDispersionPoint = {
  pathS: number;
  sampleIndex: number;
  rawModeIndex: number;
  branchId: string | null;
  frequencyHz: number;
  residualNorm: number | null;
  overlap: number | null;
};

type FrequencyResponsePoint = {
  frequencyHz: number;
  observableId: string;
  amplitude: number | null;
  phaseRad: number | null;
  absorbedPowerDensity: number | null;
  susceptibility: readonly number[] | null;
  fieldId: string | null;
  residualNorm: number | null;
};

type FmrPeakPoint = {
  frequencyHz: number;
  source: "modal" | "driven_response";
  modeRef: { sampleIndex: number; rawModeIndex: number } | null;
  frequencyPointIndex: number | null;
  amplitude: number | null;
  absorbedPowerDensity: number | null;
  phaseRad: number | null;
  linewidthHz: number | null;
  validationStatus: "pass" | "warn" | "fail" | "unavailable";
};

type ResponseMapPoint = {
  kSampleIndex: number;
  pathS: number;
  frequencyHz: number;
  intensity: number | null;
  phaseRad: number | null;
  fieldId: string | null;
  residualNorm: number | null;
};
```

Rules:

- Chart model functions accept API/resource shapes and return chart-series shapes.
- Chart model functions never read React state.
- Chart model functions drop non-finite points and report dropped counts.
- Units are explicit: Hz internally, GHz only for display.
- Series IDs include result family, stage ID, sample/branch/observable identity.

## Calculation-Mode Chart Routing

Current state:

- Result charts are planned by artifact family, not by calculation workflow.

Target:

- Explorer and inspector selections can open the correct chart surface for the selected calculation mode.

Routing table:

| Selection | Primary chart | Supporting charts |
|---|---|---|
| `fmr_modal` | modal spectrum at k = 0 | mode table, FMR validation, mode overlay |
| `fmr_response` | response sweep chart | peak table, phase chart, susceptibility chart, response-field overlay |
| `free_modes` | eigen spectrum chart | mode table, selected mode overlay |
| `dispersion_modal` | dispersion f(k) chart | branch table, k-path inspector, selected mode overlay |
| `response_map` | k/f intensity map | response sweep slice, frequency point table, response-field overlay |

Implementation steps:

1. Add a calculation-mode adapter that reads manifest `calculation_mode` and returns the correct chart entrypoint.
2. Keep chart models artifact-based; calculation mode chooses which models to compose, not how data is fetched.
3. Add Inspector actions:
   - open FMR chart,
   - open dispersion chart,
   - open response-map chart,
   - plot selected mode or response field in 3D.
4. Emit typed selections that include both calculation mode and canonical resource identity.
5. Keep `analysis-plots` and inspector charts using shared model functions.

Tests:

- `fmr_modal` routes to modal spectrum and mode table.
- `fmr_response` routes to response sweep and peak table.
- `dispersion_modal` routes to f(k) with `path_s` x-axis.
- `response_map` stays unavailable until capability and resources exist.
- Chart selection carries canonical resource IDs, not only UI mode labels.

## Spectrum Chart

Current state:

- No spectrum chart exists in v2.

Target chart:

- x-axis: mode index for single-sample spectra, or grouped sample index plus mode index for multi-sample spectra.
- y-axis: frequency in Hz/GHz.
- optional secondary y-axis: residual norm, damping rate, or tangent leakage.
- click selects a mode.
- double click or command plots mode in 3D.

Implementation steps:

1. Add `eigenSpectrumChartModel.ts`.
2. Add function `buildEigenSpectrumSeries(resource, modeMetadataIndex)`.
3. Add function `buildEigenSpectrumModeTable(resource, modeMetadataIndex, diagnostics)`.
4. Add `EigenSpectrumChart.tsx` using the existing chart surface primitives.
5. Add chart click mapping to `FrequencyDomainSelectionRef`.
6. Emit `charts:series-selected` with a typed eigen mode payload.
7. Keep inspector and analysis-plots module using the same chart model.

Tests:

- maps v2 spectrum rows into finite chart points,
- excludes non-finite values,
- preserves sample/raw mode identity,
- click event maps to `{sampleIndex, rawModeIndex}`,
- chart status reports dropped points and missing mode fields.

## Mode Table

Current state:

- No mode table exists.

Target table:

- It is the primary mode navigation surface for solved eigen results.
- It must be usable without rendering the full 3D viewport.

Columns:

- selected marker,
- sample label,
- sample index,
- raw mode index,
- branch ID,
- frequency GHz,
- imaginary frequency GHz,
- damping rate MHz,
- residual,
- orthogonality,
- tangent leakage,
- field availability,
- engine,
- actions.

Actions:

- open mode inspector,
- plot in 3D,
- add to comparison,
- export metadata.

Tests:

- table rows sort by sample then frequency,
- branch filter hides unrelated modes,
- plot action dispatches the correct mode field ID,
- missing field ID disables plot action with reason.

## Dispersion Chart

Current state:

- The backend writes `eigen/dispersion.csv` and `branches.v2.json`.
- The frontend has no chart for this.

Target chart:

- x-axis: `path_s` for dispersion only. Do not use `path_s` as the x-axis for
  single-sample spectra; spectra use mode index or frequency depending on the
  chart type.
- y-axis: frequency.
- series: one per branch when branch tracking exists.
- fallback: scatter per raw mode when branch tracking is absent.
- high-symmetry labels appear on x-axis when path metadata supplies labels.
- click selects sample/mode.

Implementation steps:

1. Add CSV parser at API or resource layer if the endpoint returns text.
2. Prefer a JSON dispersion resource if backend adds one; otherwise parse CSV in a small, tested adapter.
3. Add `eigenDispersionChartModel.ts`.
4. Build branch-colored series from `branches.v2`.
5. Add fallback raw sample scatter when branches are missing.
6. Add branch highlight support from Explorer selection.
7. Emit typed selection events for dispersion points.

Tests:

- parses dispersion CSV with documented columns,
- maps branches to stable series IDs,
- handles missing branches with raw scatter,
- maps click to sample/mode selection,
- displays path labels.

## Frequency Response Chart Version Strategy

Current state:

- Existing response resources may expose `response/magnetic_response_sweep.v1.json`.
- New response artifacts can add `response/magnetic_response_sweep.v2.json` when
  field payload links, per-frequency metadata, or provenance require a schema
  bump.

Target behavior:

- Build the first chart model against the v1 shape because it is the existing
  compatibility artifact.
- Prefer v2 when the v2 response artifact exists and fall back to v1 only as a
  degraded compatibility path.
- The resource hook must expose the selected artifact version to the chart
  model.
- The chart must render a provenance/version badge: `response.v2` for the
  preferred artifact or `response.v1 compatibility` for fallback.
- If v2 exists but fails validation, do not silently fall back to v1 without a
  warning diagnostic; otherwise bad v2 writers would be hidden.

Tests:

- v2 artifact is preferred when both v1 and v2 exist.
- v1 fallback works when v2 is absent.
- invalid v2 produces a visible degraded-state diagnostic.
- chart provenance badge reports the data source version.

## Branch Table And Branch Detail

Current state:

- Backend can write branch data.
- UI has no branch navigation.

Target:

- Branches are navigable Explorer nodes and table rows.
- Branch inspector shows one branch's mode continuity and overlap quality.

Implementation steps:

1. Add `eigenBranchModel.ts`.
2. Build branch summaries:
   - branch ID,
   - first/last sample,
   - sample coverage,
   - frequency min/max,
   - mean overlap,
   - lowest overlap,
   - gap count,
   - representative mode.
3. Add branch detail chart.
4. Add branch-to-mode selection bridge.

Tests:

- branch summaries compute coverage correctly,
- branch gaps show warnings,
- selecting branch updates dispersion chart highlight.

## Frequency Response Chart

Current state:

- `useMagneticResponseSweepResource()` can load a sweep artifact if present.
- There is no UI chart for the sweep.

Target chart:

- frequency on x-axis.
- selectable y-axis families:
  - amplitude,
  - phase,
  - absorbed power,
  - susceptibility tensor components.
- frequency point click selects a response point.
- plot command displays response field in 3D when field payload exists.

Version strategy:

- Build chart model with v1 response sweep shape as the primary currently available source.
- When v2 response artifacts become available, prefer v2 and fall back to v1 as a degraded compatibility path.
- Resource hooks should attempt v2 first only after the v2 endpoint exists in OpenAPI and generated types.
- Chart status must show a provenance badge indicating v1 or v2 data source.
- Do not mix v1 and v2 points in one series without an explicit migration adapter.

Implementation steps:

1. Add `frequencyResponseChartModel.ts`.
2. Support v1 resource shape first.
3. Add v2 shape support when backend writes it.
4. Add amplitude/phase chart pair.
5. Add observable selector with explicit units.
6. Add frequency-point table.
7. Emit typed selection for frequency points.

Tests:

- v1 sweep maps to amplitude series,
- phase values stay in radians internally,
- frequency values display in GHz without changing data values,
- missing response field disables 3D plotting,
- observable selection changes y-axis grouping correctly.

## Cross-Module Selection Types

Add shared selection refs. In the current Control Room implementation,
`apps/control-room/src/kernel/selection/selectionTypes.ts` already represents
frequency-domain selections as a flat `SelectionRef` branch with
`type: "frequency-domain"` and optional fields such as `analysisRunId`,
`analysisStageId`, `sampleIndex`, `modeIndex`, `branchId`, `frequencyIndex`,
`observableId`, `fieldId`, `resourceRef`, and `calculationMode`. Prefer
extending and testing that existing branch over introducing a parallel
selection hierarchy.

Target semantic selection payloads:

```ts
type FrequencyDomainSelectionRef =
  | {
      type: "analysis-eigen-mode";
      stageId: string;
      runId: string;
      sampleIndex: number;
      rawModeIndex: number;
      branchId: string | null;
      modeFieldId: string | null;
    }
  | {
      type: "analysis-eigen-dispersion-point";
      stageId: string;
      runId: string;
      sampleIndex: number;
      rawModeIndex: number;
      branchId: string | null;
      modeFieldId: string | null;
    }
  | {
      type: "analysis-frequency-response-point";
      stageId: string;
      runId: string;
      frequencyIndex: number;
      frequencyHz: number;
      fieldId: string | null;
    };
```

Rules:

- Explorer, inspector, chart, and viewport use the same selection ref type.
- Selection refs do not contain large data.
- Selection refs carry enough IDs to refetch metadata.
- `moduleSource` records who initiated selection.
- Chart model helpers may expose typed builder functions for eigen modes,
  dispersion points, and response frequency points, but their output must lower
  to the canonical flat `SelectionRef` branch used by Explorer selection.
- Response point selections must include `frequencyIndex`, `fieldId` when
  available, `resourceRef` or artifact path, `observableId` when the chart
  series represents a specific observable, and `calculationMode`.
- Dispersion point selections must include `sampleIndex`, `modeIndex`,
  `branchId`, `fieldId` when available, and `calculationMode`.

## 3D Mode Visualization Target

Current state:

- Viewport can render field vectors for runtime quantities.
- It cannot render analysis mode fields.

Target state:

- Mode field resources are rendered through the same vector-field pipeline as other field resources.
- Complex mode visualization is controlled by visualization state and resource query parameters.
- Mode field visualization exposes the same user-facing display controls as
  ordinary 3D field visualization, with the quantity selector replaced by the
  complex-mode view selector (`real`, `imag`, `abs`, `phase`,
  `phase_rotated_real`).
- Mode visualization settings are shared for the whole modes collection.
  Selecting another eigenmode changes the active field payload and mode
  identity, but must preserve the shader, color, vector, scope, and phase
  control state so users do not have to copy styling from mode to mode.
- Future volume-inspection controls must support render-only clipping/cutaway
  of mode fields, including half/quarter geometry cuts and shader
  transparency. This is needed because eigenmodes can differ throughout the
  volume, not only on the exterior surface; users need to inspect interior
  gradients with a translucent surface or clipped-away section. These controls
  must not change the solver domain, mesh, artifacts, or mode normalization.

Visualization state extension:

```ts
type AnalysisModeOverlayState = {
  enabled: boolean;
  fieldId: string | null;
  sourceFamily: "analysis/eigen" | "analysis/frequency-response";
  sampleIndex: number | null;
  rawModeIndex: number | null;
  branchId: string | null;
  frequencyIndex: number | null;
  view: "real" | "imag" | "abs" | "amplitude" | "phase" | "phase_rotated_real";
  component: "vector" | "x" | "y" | "z" | "norm";
  visualizationPhaseRad: number;
  animatePhase: boolean;
  animationRateHz: number;
  animationStartedAtMs: number | null;
  glyphDensity: number;
  normalizeGlyphs: boolean;
  colorBy: "amplitude" | "phase" | "component" | "none";
  clipMode: "off" | "plane" | "quarter_cut" | "box_cut";
  surfaceOpacityPercent: number;
};
```

Implementation steps:

1. Add analysis mode overlay state to the visualization resource, not to local inspector state only.
2. Add kernel command `analysis.eigen.plot-mode-3d`.
3. Add kernel command `analysis.frequency-response.plot-response-field-3d`.
4. Add kernel command `analysis.frequency-domain.clear-3d-overlay`.
5. Add a viewport resource adapter that maps `fieldId + overlay query` to the existing field-vector resource hook.
6. Extend viewport scene model to include an analysis-mode field layer.
7. Reuse `VectorFieldLayer` where possible.
8. Add a surface scalar color mode for amplitude if the payload can provide scalar amplitude.
9. Keep phase animation dirty-driven:
   - animation updates `visualizationPhaseRad = (visualizationPhaseRad + 2*pi*animationRateHz*dt) mod 2*pi` for the currently displayed `fieldId`,
   - animation state lives in the shared visualization overlay resource so Explorer, inspector, chart, and viewport agree on the active mode,
   - animation may run only for `view=phase_rotated_real` or an explicitly documented animated glyph mode; scalar `phase` view is not animated by pretending the phase data changed,
   - viewport invalidates only while animation is enabled,
   - stopping animation releases the interval and leaves the last phase visible,
   - switching mode clears the old resource subscription before starting the new animation.
10. Ensure switching modes releases previous mode field resource subscriptions.

Tests:

- command writes analysis overlay state with field ID.
- viewport builds field-vector query for analysis mode field.
- changing phase changes resource key or shader uniform according to chosen implementation.
- play/pause advances only the currently displayed mode phase.
- reset-to-zero sets only `visualizationPhaseRad` and leaves mode metadata untouched.
- static real, imaginary, abs/amplitude, and phase display modes remain selectable
  and do not depend on playback.
- animation stops on overlay clear and component unmount.
- switching modes while animation is active does not keep requesting the previous mode-field resource.
- switching modes releases old resource key.
- clearing overlay removes layer.
- browser smoke confirms canvas visible, WebGL context not lost, drawing buffer non-zero, and overlay draw call exists.

## 3D Rendering Semantics

Mode views:

- `real`: real component of complex mode.
- `imag`: imaginary component.
- `abs`/`amplitude`: magnitude of complex vector.
- `phase`: phase scalar, shown as scalar coloring where meaningful.
- `phase_rotated_real`: `Re(delta_m * exp(i * visualizationPhaseRad))`.
- Real, imaginary, abs/amplitude, and phase are static explicit display modes.
  They remain available even when animation controls are disabled.

Glyph semantics:

- Vector glyph direction follows the selected view.
- Glyph length can be normalized per mode or absolute.
- `amplitude` view can use glyph direction from phase-rotated real part with length from amplitude if the UX labels this clearly.
- Surface colorbar appears for amplitude, phase, and component scalar views.

Animation semantics:

- Animation is visualization-only.
- It must not change solver data.
- It animates the currently displayed mode by varying `visualizationPhaseRad` in
  the phase-rotated reconstruction.
- The reconstruction may consume either `real_imag` modal components or
  `amplitude_phase` modal components. For `amplitude_phase`, each component is
  reconstructed as
  `Re(amplitude * exp(i * (modePhaseRad + visualizationPhaseRad)))`; this is
  the expected fast path when the inspector already has amplitude and phase
  maps for the selected mode.
- The canonical animation surface is the selected `results.eigen.mode`
  inspector for the mode already plotted in 3D; charts and tables may only
  route selection into that inspector or dispatch the initial plot command.
- The rendered time-like sequence is
  `visible_delta_m(visualizationPhaseRad) = Re(delta_m_complex * exp(i * visualizationPhaseRad))`.
  The UI phase is a visualization parameter; it is not a physical time-step
  integrator and it does not imply a driven frequency-response solve.
- `visualizationPhaseRad` is separate from the physical mode phase contained in
  the complex eigenvector and separate from phasor/Floquet convention metadata.
  The inspector must show the convention metadata but must not overwrite it when
  playback changes the visualization phase.
- It uses the phasor convention from mode metadata and displays that convention in the inspector.
- It must expose play, pause, visualization phase slider, rate, and reset-to-zero controls in the selected mode inspector.
- It must not use a permanent render loop when animation is disabled.
- It must pause with a visible missing-resource or unsupported-view reason if the current mode-field payload is unavailable.
- It must display the phase convention in the inspector.

## Analysis Module Layout

The `analysis-plots` module should grow from generic table charts into a result-aware analysis surface.

Target sections:

```text
Frequency Domain Analysis
  Result selector
  Eigen Spectrum
  Mode Table
  Dispersion
  Branches
  Frequency Response
  Diagnostics Summary
```

Rules:

- Only the active heavy chart surface mounts.
- Spectrum, dispersion, and response charts share chart primitives.
- Mode table can stay mounted if lightweight.
- The result selector reads the manifest.
- The module does not duplicate the Explorer tree; it provides a chart workspace for selected results.

## Performance Gates

Charts:

- Do not parse large CSV on every render.
- Memoize through resource/model boundaries, not blanket `useMemo` everywhere.
- Avoid mounting all ECharts instances at once.
- Keep chart idle with zero background data refetches.

Viewport:

- No continuous render loop except active phase animation.
- Phase animation stops on unmount and on overlay clear.
- Playback invalidates the 3D viewport only for the selected mode overlay and
  only while the visualization phase is changing.
- Mode switching releases old buffers.
- Binary resources use cache revision rules.
- Large mode payloads must not enter React props as plain arrays if a typed array/resource object is available.

## Acceptance Gate

This layer is complete only when:

- Spectrum chart, mode table, dispersion chart, branch table, and response sweep chart render from resource fixtures.
- Chart selections update Explorer/inspector selection.
- Mode inspector and chart can plot a selected mode in 3D.
- Response point inspector can plot a response field in 3D when payload exists.
- 3D overlay supports static real, imaginary, amplitude/abs, and phase views,
  plus animated phase-rotated real playback for a selected mode.
- Browser smoke proves the 3D overlay renders without WebGL context loss.
