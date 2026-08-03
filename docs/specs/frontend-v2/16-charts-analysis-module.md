# Frontend v2 — Live Charts, Analysis, and Quick Chart

**Status:** Implemented ownership contract; browser qualification pending

**Date:** 2026-08-03

**Phase:** 6 — modules/parity; this document does not declare global cutover

## 1. Product boundary

The workspace exposes three chart surfaces with different user intent and
lifecycle:

| Surface | Owner and slot | Data intent | Lifecycle |
|---|---|---|---|
| **Live Charts** | `live-charts`, `viewport-main` | Active-run scalar time series such as normalized magnetization, energies, torque, and residuals | Follows relevant resource revisions while active; can be paused explicitly |
| **Analysis** | `analysis-plots`, `viewport-main` | Postprocessing of an **explicit selected dataset**, run, stage, or artifact | Loads only the selected identity; never adopts the active table tail |
| **Quick Chart** | `transport-footer`, `panel-bottom` | Compact view of one explicitly pinned table descriptor | Mounted only while its footer tab is active; coexists with the spatial viewport |

The two center modules are active-only. They do not import one another's store,
controller, or components. Quick Chart imports neither center module and does
not select a center tab. The shared implementation boundary is
`src/shared/analysis-charts` plus module-neutral domain contracts.

## 2. Data and scientific-trust contract

HTTP v2 resources are authoritative. Realtime events invalidate resource keys;
they do not carry canonical chart histories. Components use generated transport,
the typed `ControlRoomApi` facade, revision-aware resource hooks, and bounded
binary decoders. They do not call `fetch()`, assemble endpoint strings, poll, or
persist scientific payloads.

Normalized dimensionless quantities retain scale one and never receive an SI
prefix. Axes and tooltips show physical symbols and units. Incompatible physical
dimensions are split into separate panes or explicitly labelled axes. Missing,
unsupported, degraded, stale, loading, refreshing, and ready states remain
distinct; a background refresh retains the previous plot and does not replace it
with a blocking loading surface.

Decoded numeric arrays belong to the resource/cache lease. Stores contain only
bounded identities, display preferences, ranges, and semantic selections.
Local series, cursor, legend, range, and display-unit changes do not trigger a
network request when the required resource window is already available.

## 3. Live Charts ownership

Live Charts owns active-run time-series observation:

- the active table/resource descriptor and revision-aware request composition;
- `selectedSeriesIds` as the only visibility owner, including an empty selection;
- Follow/Pause, bounded range, target-point, and display-unit preferences in
  `fm:live-chart-preferences:v1`;
- retained-data refresh, cursor selection, export, and Live Chart Inspector state.

It does not own spectral analysis, comparison datasets, artifact selection, the
Quick Chart pin, or 3D viewport state.

## 4. Analysis ownership

Analysis requires an explicit dataset or artifact identity before loading data.
Its supported surfaces include dynamics, spectrum, frequency response,
eigenmodes, dispersion, hysteresis, and comparison. The chosen surface must
match the selected resource manifest; a loading or mismatched manifest fails
closed and cannot start another family's requests.

Analysis owns `fm:analysis-view-preferences:v2`, the selected dataset/artifact,
surface-specific semantic series selection, comparison identity, display units,
fixed range, provenance, point selection, and explicit export/pin commands. It
does not expose live-tail controls or reuse Live Charts preferences.

## 5. Quick Chart ownership

`transport-footer` is the only `panel-bottom` manifest owner. Quick Chart uses
`quickChartWorkspaceStore`, a bounded descriptor parser, shared chart contracts,
and table resource hooks. New descriptors contain `selectedSeriesIds`; no new
writer emits `yAxisIds`. Empty selection performs no request and creates no
ECharts instance.

Opening, pinning, zooming, selecting units or series, and closing Quick Chart
must cause zero 3D field/topology requests, camera changes, unchanged-buffer
uploads, or 3D dirty frames. Unmount releases the ECharts instance, observer,
listeners, pending animation frame, and export object URLs.

## 6. Compatibility window

All compatibility paths are bounded, read-only, and have named owners:

| Reader | Owner | Removal gate |
|---|---|---|
| `fm:analysis-chart-preferences:v1` live selection | `liveChartPreferences.ts` | Remove after one released preference schema version writes `fm:live-chart-preferences:v1` and browser migration tests prove no old live identity remains. |
| `comparisonSelectedSeriesKeys` | `analysisViewPreferences.ts` | Remove after one released `analysis-view-preferences:v2` writer uses `selectedSeriesIds` and migration tests prove no stored descriptor depends on the old field. |
| Quick Chart `yAxisIds` | `quickChartWorkspace.ts`; `explorerTypes.ts` admits the same input only | Remove after one released Control Room version writes only `selectedSeriesIds` and migration tests prove no persisted or Explorer descriptor depends on it. |

Compatibility readers never write the old key or field. `apps/legacy_web`
remains reference-only under Phase 6 governance and is not imported or modified.

## 7. Renderer and accessibility

ECharts Canvas remains behind the module-neutral renderer owner. Each mounted
chart or comparison pane owns at most one ECharts instance and disposes every
instance on unmount. A Comparison surface intentionally owns two pane instances
while both panes are mounted. Data animation is off; short chrome transitions
use central Catppuccin Mocha/Latte tokens and respect `prefers-reduced-motion`.

Every chart has a readable title, labelled axes, visible units, DOM summary,
keyboard-accessible series controls, explicit unsupported/degraded reasons, and
a bounded points table. State is not communicated by color alone.

## 8. Acceptance evidence

Unit and architecture tests must prove:

- exact normalized values and no prefixed dimensionless unit;
- every `mx`/`my`/`mz` visibility combination with zero request for local actions;
- retained-data background refresh and no idle or irrelevant-revision work;
- independent module/store/import ownership and active-only center mounting;
- Analysis explicit selection and manifest-family gating;
- Quick Chart active-tab-only mounting, current descriptor writes, cleanup, and
  3D isolation;
- bounded compatibility reads with owner and removal condition;
- typecheck, API/architecture hygiene, and dead-path scans.

Browser qualification must additionally prove Mocha/Latte, reduced motion,
keyboard flows, 200% zoom, lifecycle/memory budgets, and a healthy WebGL context
with a non-zero drawing buffer after returning to 3D. Missing browser evidence is
reported as pending, not inferred from unit tests.
