# Live Charts and Analysis Separation Design

- Status: approved for implementation planning
- Date: 2026-08-02
- Baseline: `4d68d8fe286b6f6e8f60edb17e179751f713f09a` on `master`

Scope: `apps/control-room`, shared chart contracts, resource state presentation, center-surface routing, chart preferences, tests, and governing frontend documentation.

## Goal

Separate observation of a running simulation from scientific postprocessing:

- `Live Charts` is a central workspace surface for revision-driven scalar histories of the active run;
- `Analysis` is a separate central workspace surface for dynamics, spectra, frequency response, eigenmodes, dispersion, hysteresis, comparisons, and other analysis of selected datasets or artifacts;
- `Quick Chart` remains a compact optional chart in the bottom dock while the 3D viewport stays active.

The first implementation must also correct three defects visible in the supplied screenshot:

1. normalized magnetization values such as `my = 0.10317` are displayed as values near `103` or `1000` with the invalid axis unit `m1`;
2. disabling `mx`, `my`, or `mz` does not reliably remove the series from the plot;
3. the chart repeatedly presents a blocking `Loading` state while fresh data is fetched, even though a usable previous revision remains available.

This is a frontend architecture and scientific-presentation change. It does not change solver equations, table values, Python authoring, or `ProblemIR`.

## Product terminology

The user-facing name is **Live Charts** and the module id is `live-charts`.

Rejected names:

- `Live Metrics` is ambiguous because a metric may mean a scalar simulation observable or a platform/runtime performance measurement;
- `Telemetry` conflicts with the existing bottom-dock telemetry surface for communication and performance;
- `Live Meters` is not established scientific-product language;
- retaining `Analysis` for both running signals and postprocessing preserves the current ambiguity.

`Analysis` remains the user-facing name and `analysis-plots` remains its module id. A later rename of the internal id would add migration cost without improving the user contract.

## Verified baseline and root causes

### Dimensionless magnetization is incorrectly SI-scaled

`chartRenderer.ts::computeYScales()` chooses one `AxisScale` from numeric extrema, and `scientificChartFormatting.ts::axisScaleFromExtrema()` uses the geometric mean of the smallest and largest non-zero magnitudes. For values near `0.10` and `0.98`, the representative magnitude is below `0.5`, so the generic formatter selects the `milli` prefix. Unit `1` then becomes `m1`, while displayed values are divided by `10^-3`.

The numeric samples supplied by the runtime remain correct. The defect is in the display transform.

### Series selection has two conflicting owners

The current workbench uses both:

- `yAxisIds` for Inspector column selection; and
- `hiddenSeriesIds` for legend visibility.

`TableColumnList.tsx::nextYAxisIdsForToggle()` refuses to remove the final Y series. `AnalysisTableSurface.tsx` treats an empty filtered hidden list as meaning every series is visible. Sanitization can also repopulate defaults when the selected Y list becomes empty. Consequently, the model cannot represent the valid state “no visible series” consistently.

### Background refresh is presented as blocking load

`markResourceLoading()` correctly retains existing data and reports it as `stale`, but `AnalysisTableSurface.tsx::statusPrimary()` maps both `loading` and `stale` to `Loading`, and `EChartsSurface.tsx::tableSeriesRenderModel()` assigns the blocking message `Loading table samples` to both states. Every relevant revision therefore produces visible loading churn even though the old revision can remain rendered.

The transport direction itself is sound: HTTP v2 owns resource snapshots and realtime events invalidate revisions. The refactor changes presentation and view-state ownership, not that source-of-truth rule.

## Alternatives considered

### A. Separate central `Live Charts` and `Analysis` modules

This is the selected design. Each module has one workflow, its own small view state, and active-only lifecycle. Both consume shared chart primitives and revision-aware resource hooks.

Benefits:

- the workspace label matches the user's intent;
- live-follow state cannot leak into artifact analysis;
- analysis tools do not complicate the hot live-update path;
- each module can be mounted, tested, and measured independently.

Cost:

- module registration, selection routing, commands, preferences, tests, and documentation must migrate together;
- shared chart code must be kept module-neutral.

### B. Keep one module with Live and Analysis modes

This would reduce file movement, but it would retain one controller and preference model for unrelated lifecycles. It also leaves the top-level name ambiguous. Rejected.

### C. Put all live charts only in the bottom dock

This preserves the central surface for Analysis but is too constrained for comparing several scalar families, inspecting exact values, configuring ranges, and exporting data. The bottom dock remains appropriate for Quick Chart only. Rejected as the primary live experience.

## Architecture decision

```text
runtime scalar table
  -> generated v2 transport / ControlRoomApi
  -> revision-aware resource hook and binary codec
  -> bounded canonical table window
  -> LiveChartDataModel
  -> shared ChartRenderModel
  -> ECharts Canvas owner

selected run/stage/dataset/artifact
  -> typed data or analysis resource hook
  -> analysis-domain adapter
  -> shared ChartRenderModel
  -> ECharts Canvas owner

realtime event
  -> resource invalidation only
  -> coalesced HTTP refresh
```

The following ownership rules are mandatory:

- server payloads and decoded `Float64Array` values stay in resource hooks/cache or a component-local reducer, never in a Zustand/kernel workspace store;
- `Live Charts` owns only compact view preferences for live scalar histories;
- `Analysis` owns only compact analysis-surface and selected-dataset preferences;
- shared chart code owns unit/display policy, neutral render models, renderer lifecycle, export, legend primitives, and bounded points-table presentation;
- modules do not import one another;
- Quick Chart consumes shared contracts and a descriptor, not either module's store;
- HTTP v2 remains the snapshot source of truth and WebSocket remains event/invalidation only;
- no polling or `refreshInterval` is introduced.

## Module boundaries

### `live-charts`

`apps/control-room/src/modules/live-charts/` will own:

- the manifest with `id: "live-charts"`, title `Live Charts`, and slot `viewport-main`;
- active-run scalar-table composition;
- Follow, Pause, Tail rows, Tail time, Fixed range, and Full decimated controls;
- signal-family presets and custom signal selection;
- latest values, live cursor, selected range, resource revision, and freshness presentation;
- the live-specific Inspector panel and selection refs;
- live-specific commands and versioned view preferences.

Default signal families are:

- Magnetization: normalized `mx`, `my`, `mz`;
- Energy: published energy terms with compatible dimensions;
- Convergence: torque, residual, and energy-delta families shown in separate compatible panes or axes;
- Custom: an explicit user selection subject to dimension/unit compatibility.

The module must not own FFT, spectral transforms, eigenmode computation, dispersion, hysteresis postprocessing, or multi-run comparison.

### `analysis-plots`

`apps/control-room/src/modules/analysis-plots/` will own analysis of an explicit selected source rather than implicit live-follow state.

Its product surfaces are:

- Dynamics for a selected run, stage, dataset, or canonical table artifact;
- Spectrum / FFT;
- Frequency Response / FMR;
- Eigenmodes;
- Dispersion;
- Hysteresis;
- future dataset comparison surfaces.

Analysis may read a dataset produced by a still-running session, but it does not automatically follow the active table tail. The selected resource identity and revision remain explicit. Missing analysis capability is `unsupported`, not an empty successful chart.

### Quick Chart

Quick Chart remains mounted by the `transport-footer` bottom-dock owner while active. It consumes a compact descriptor containing resource identity, X selection, selected series, and display preferences.

Opening, closing, pinning, cursor movement, local zoom, unit conversion, and series selection must produce:

- zero 3D field or topology fetches;
- zero camera changes;
- zero unchanged-buffer uploads;
- zero 3D dirty frames;
- no additional long-lived ECharts owner after unmount.

## Scientific unit and scaling contract

Axis scaling is selected from quantity dimension and display policy, not from magnitude alone.

```typescript
type ChartScalePolicy =
  | { kind: "fixed"; factor: number; displayUnit: string }
  | { kind: "si-prefix"; canonicalUnit: string }
  | { kind: "dimensionless"; displayUnit: "" };
```

Rules:

- normalized magnetization `m`, `mx`, `my`, and `mz` uses `dimensionless` with factor `1`;
- its axis label is `Normalized magnetization m`, with component identities in the legend;
- its tooltip shows `my: 0.10317`, not `103.17 m1`;
- no SI prefix is concatenated with unit `1` or an empty dimensionless unit;
- physical magnetization `M` in `A/m` remains a separate quantity and may use SI display prefixes;
- time, field, energy, frequency, wavevector, and other physical units may use explicit or automatic SI display scaling;
- ticks, tooltip values, cursor summaries, accessible summaries, and image export use the same display transform;
- CSV/TSV exports keep canonical values and canonical units, with display policy in provenance;
- normalized magnetization is not clamped. Finite values outside the expected physical interval remain visible and may generate a diagnostic.

## Single series-selection contract

`selectedSeriesIds` is the only visibility owner for a live chart descriptor.

It replaces the current overlapping meanings of `yAxisIds` and `hiddenSeriesIds` for live series. X-axis selection remains separate.

Rules:

- checking a signal adds its id to `selectedSeriesIds`;
- unchecking a signal removes it immediately from the render model;
- unchecking does not stop refresh of other selected signals;
- selecting or hiding a signal performs zero fetch when the required columns are already in the cached table window;
- zero selected series is valid and renders the stable empty state `Select at least one signal` without an ECharts data series;
- `Solo` replaces the selection with one id; `Show all` explicitly selects all compatible ids;
- the legend and Inspector render and mutate the same state;
- invalid or unavailable ids are removed during descriptor validation without repopulating defaults;
- defaults are applied only when creating a new descriptor or explicitly resetting preferences.

Analysis renderers may use a semantically equivalent `selectedSeriesIds` field, but Analysis and Live Charts do not share a mutable store.

## Refresh and lifecycle state model

The UI distinguishes payload availability from refresh activity.

```typescript
type ChartDataPresentationState =
  | { kind: "initial-loading" }
  | { kind: "ready"; revision: ResourceRevision }
  | { kind: "refreshing"; visibleRevision: ResourceRevision; requestedRevision: ResourceRevision }
  | { kind: "paused"; visibleRevision: ResourceRevision; latestKnownRevision: ResourceRevision | null }
  | { kind: "stale"; visibleRevision: ResourceRevision; error: Error }
  | { kind: "empty"; revision: ResourceRevision | null }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; error: Error };
```

Presentation rules:

- only `initial-loading` may replace an absent chart with a skeleton or loading surface;
- `refreshing` keeps the previous Canvas, axes, legend, cursor, and layout visible;
- background refresh uses a small, non-blocking, non-pulsing `Updating` status beside revision metadata and does not overlay the plot;
- `stale` keeps the last usable data and shows the failed refresh plus the visible revision;
- `error` is reserved for a state with no usable payload;
- `paused` freezes the visible revision, does not fetch newer payloads, and may retain only a small latest-known revision pointer;
- Resume produces exactly one latest-resource fetch;
- rapid invalidations are coalesced by the resource layer, with at most one active request per resource/query identity;
- an aborted or old-session response never replaces the current view;
- settled idle produces zero requests, timers, animation frames, renderer updates, or redraws.

No persistent animation is used for Live status. Motion is limited to short state transitions and respects reduced-motion preferences.

## Workspace, commands, and selection

The center tab host registers both manifests and mounts only the active one:

```text
viewport-main
  - viewport-3d
  - cross-section-image / field-map where eligible
  - live-charts
  - analysis-plots
```

Required commands include:

- `live-charts.open`;
- `live-charts.follow`;
- `live-charts.pause`;
- `live-charts.fit`;
- `live-charts.export.{csv,tsv,png}`;
- existing Analysis commands retained under `analysis-plots.*` only when they operate on Analysis;
- Quick Chart pin/open commands remain separate and module-neutral.

Selection refs distinguish `live.chart`, `live.chart-point`, `analysis.chart`, and analysis-specific point/mode identities. Compatibility parsing may read old `analysis:charts:default` live selections during one migration version, but new writes use live identities. The bridge must have tests and an explicit removal condition.

## API and resource impact

The first migration is frontend-only unless a coverage audit proves that Analysis cannot address a selected run, stage, dataset, or artifact through existing v2 resources.

No screen-shaped endpoint such as `/live-charts` or `/analysis-screen` may be added. If a resource gap is proven:

- live scalar history belongs to the existing `data/tables` family;
- derived scientific results belong to the existing `analysis` family;
- the backend route/schema, OpenAPI v2, generated types, generated transport, handwritten facade, resource hook, codec, and tests change together;
- large histories remain on the bounded binary data plane;
- HTTP remains authoritative and realtime carries invalidation only.

## Preferences and migration

Create independent, versioned, SSR-safe preferences:

```typescript
type ChartRangePreference =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed"; fromSI: number; toSI: number }
  | { mode: "fullDecimated" };

type AnalysisSurface =
  | "dynamics"
  | "spectrum"
  | "frequency-response"
  | "eigenmodes"
  | "dispersion"
  | "hysteresis"
  | "comparison";

interface AnalysisDescriptorPreference {
  selectedSeriesIds: string[];
  displayUnits: Record<string, string>;
  range: { fromSI: number; toSI: number } | null;
}

interface LiveChartPreferencesV1 {
  schemaVersion: 1;
  descriptors: Record<string, {
    xAxisId: string;
    selectedSeriesIds: string[];
    range: ChartRangePreference;
    liveMode: "following" | "paused";
    targetPoints: 160 | 400 | 800 | 1600 | 3200 | 5000;
    displayUnits: Record<string, string>;
  }>;
}

interface AnalysisViewPreferencesV2 {
  schemaVersion: 2;
  activeSurface: AnalysisSurface;
  selectedDatasetRef: string | null;
  descriptorPreferences: Record<string, AnalysisDescriptorPreference>;
}
```

Migration rules:

- old live-table settings are copied once into `LiveChartPreferencesV1`;
- analysis-specific settings remain in the Analysis preference model;
- an ambiguous old field is reset to its documented default rather than guessed;
- invalid ids, excessive descriptor counts, oversized arrays, and non-finite ranges are rejected or bounded;
- hydration uses `useSyncExternalStore` server snapshots or an explicit hydration gate;
- no samples, typed arrays, ECharts options, server resources, or canonical simulation data enter local storage;
- reset removes view preferences only.

## Implementation sequence

1. Add regression tests for dimensionless scaling, zero selected series, each `mx/my/mz` toggle, and background refresh with retained data.
2. Introduce dimension-aware `ChartScalePolicy` and make ticks, tooltips, axes, cursor summaries, and export consume one display transform.
3. Introduce the single `selectedSeriesIds` model and remove live use of `hiddenSeriesIds` plus the last-series guard.
4. Derive `ChartDataPresentationState` from resource status plus payload availability and remove blocking refresh overlays.
5. Add `live-charts` manifest, store/preferences, controller, table hook composition, view, Inspector panels, commands, events, and tests.
6. Move current active-table Overview/Dynamics/Convergence behavior and live energy histories into `live-charts`, preserving resource-first hooks and bounded data.
7. Reduce `analysis-plots` to explicit dataset/artifact analysis and retain frequency-domain, eigenmode, dispersion, hysteresis, and analysis-specific dynamics workflows.
8. Migrate Quick Chart descriptors to shared contracts without importing either module store.
9. Migrate preferences, selection refs, commands, explorer nodes, and center-tab registration; delete compatibility code after its stated removal gate passes.
10. Update ADR 0016, the module catalog, chart/analysis spec, active plans, and command/selection documentation so no document continues to describe one mixed Analysis workbench as the target.
11. Run focused tests, full Control Room verification, resource-first gates, browser/visual checks, and lifecycle/performance audits before deleting old paths.

The detailed implementation plan must name the exact files, interfaces, RED/GREEN tests, commands, expected results, commit boundaries, and rollback for each task.

## Validation and acceptance

### Scientific correctness

- a fixture containing `mx = 0.97982`, `my = 0.10317`, and `mz = 4.447e-6` renders those values consistently in latest-value labels, chart points, tooltip, cursor summary, and exported canonical data;
- normalized magnetization never produces `m1`, `µ1`, or another prefixed dimensionless unit;
- normalized magnetization axes use factor `1` regardless of the visible component combination;
- physical `M [A/m]` and normalized `m` cannot share a mislabeled axis.

### Series behavior

- toggling each of `mx`, `my`, and `mz` removes or restores the line immediately;
- all eight visible/hidden combinations for three components are covered;
- zero selected series remains empty and does not restore defaults;
- a local toggle performs zero HTTP requests;
- updates continue for all remaining selected series.

### Refresh behavior

- initial load without payload shows a stable loading surface;
- at least 100 consecutive relevant revisions keep the plot visible without loading overlay or layout shift;
- each relevant coalesced revision causes no more than one table fetch per resource/query consumer;
- irrelevant revisions, local controls, cursor, legend, and settled idle cause zero fetches;
- failed refresh preserves the prior revision with a visible stale/error explanation;
- pause performs no payload fetch and resume performs exactly one latest fetch.

### Module and lifecycle behavior

- `Live Charts` and `Analysis` appear as distinct center tabs;
- only the active heavy center module is mounted;
- Analysis has no implicit live-follow subscription;
- Quick Chart can coexist with 3D without field/topology requests or 3D dirty frames;
- after switching back to 3D, `gl.isContextLost()` is false and drawing-buffer dimensions are non-zero;
- repeated switching and Quick Chart open/close return ECharts instances, listeners, observers, workers, object URLs, and heap to the bounded baseline.

### UX and accessibility

- browser screenshots cover `Live Charts`, `Analysis`, Quick Chart with 3D, Mocha, and Latte;
- keyboard users can select a signal, hide/show/solo series, reset range, pause/follow, inspect exact points, and export;
- status and selection do not rely only on color;
- 200% zoom and reduced motion remain usable;
- all new CSS classes use the `fm-` prefix and all colors use `--fm-*` tokens.

### Required verification classes

- focused Vitest unit/component tests for scale policy, selection, presentation state, stores, preferences, commands, and module routing;
- Control Room typecheck and complete test suite;
- strict resource-first and contract guards;
- analysis/live chart browser smoke with screenshot evidence;
- chart idle/performance audit and 100-switch lifecycle audit;
- viewport smoke proving active WebGL after returning from chart surfaces.

Passing source tests alone is not visual or runtime proof.

## Documentation and ADR obligations

This design requires a new ADR because it adds a long-lived center module and changes workspace routing and ownership. ADR 0022 records the decision. Implementation must also update:

- `docs/adr/0016-center-viewport-tabbed-surfaces.md`;
- `docs/specs/frontend-v2/01-module-kernel-architecture.md` where examples enumerate center modules;
- `docs/specs/frontend-v2/02-module-catalog.md`;
- `docs/specs/frontend-v2/16-charts-analysis-module.md`;
- `docs/analysis-tab-refactoring-plan.md`, which currently assumes one mixed workbench;
- relevant active plans, commands, selection vocabularies, smoke scripts, and audit documentation.

Documents must distinguish current implementation, transitional compatibility, and target architecture.

## Rollback

The refactor proceeds in independently testable commits. Until cutover acceptance:

- existing v2 table and analysis resources remain unchanged;
- shared renderer contracts remain backward-compatible for existing consumers;
- the `live-charts` manifest can be removed to restore the old center-tab set;
- compatibility readers may restore old preferences without writing obsolete identities;
- no canonical data is migrated or deleted.

Rollback must not reintroduce incorrect `m1` scaling, the inability to represent zero selected series, or blocking loading overlays during retained-data refresh. Those are correctness fixes independent of the module split.

## Non-goals

- changing micromagnetic equations or runtime-computed scalar values;
- adding new FFT, eigensolver, hysteresis, or comparison physics;
- replacing ECharts without a failed measured performance gate and a separate decision;
- adding polling or treating WebSocket samples as authoritative history;
- forking FDM and FEM UI trees;
- changing Python DSL or `ProblemIR`;
- modifying unrelated dirty backend, solver, documentation, or external-solver work.
