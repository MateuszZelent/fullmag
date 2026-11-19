---
title: Planar Monitors, Dispersion & Frequency-Domain Inspectors
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-inspectors-analysis-and-frequency-domain)=
# Planar Monitors, Dispersion & Frequency-Domain Inspectors

Analysis and frequency-domain inspectors connect authored probe geometries, modal calculations,
response sweeps, and saved `SolutionSet` artifacts to interactive 2D and 3D visual overlays without
blurring authored definitions and realized outputs.

```{image} /_static/images/ui/inspector-planar-monitor-and-frequency.png
:alt: Planar Monitor inspector configuring Mid-Plane RF Monitor (planar_mon_core), 3D and 2D view toggle, nm length unit, and Domain target kind
:align: center
:width: 100%
```

## Planar Monitor Draft and Committed Editors

- **Draft Creation (`PlanarMonitorDraftInspectorPanel`)**: Triggered from the Ribbon **View -> Monitor** action (`RIBBON_CROSS_SECTION_BEGIN_DRAFT_COMMAND`), allowing users to place a preview cut plane in 3D space (assisted by `PlanarMonitorFacePicker`, `PlanarMonitorNormalHandle`, and `PlanarMonitorRotationRings` gizmos), check `planarMonitorDefinitionAvailabilityErrors` and domain bounds, verify `scene_revision` uniqueness against existing monitors, and commit cleanly to `MODEL_PLANAR_MONITORS_PATH`.
- **Committed Monitor Inspector (`PlanarMonitorInspectorPanel`, `PlanarMonitorDefinitionEditor`)**: Edits plane center, normal, in-plane axes/extent, grid sampling resolution, and active 2D overlay layers (`PlanarVisualizationSection`, `PlanarFieldLayerList`), synchronizing camera/visualization focus via `VisualizationContextSwitch`.
- **Legacy Cross-Section Panel (`CrossSectionInspectorPanel`)**: Inspects legacy cross-section cuts and associated quality profiles (`CrossSectionQualityChart`).

## Frequency-Domain Inspectors (`panels/frequency-domain/`)

Spectral and modal analysis selections route to specialized `InspectorOverviewFrame` panels:

- **Eigenmode Dispersion (`EigenDispersionInspectorPanel`)**: Displays point count, tracked branch count, reference comparison status (`matching` vs. mismatch warnings), $f$-range, Bloch $k$-path span and symmetry labels, interactive dispersion plot (`FrequencyDomainDispersionChart`), and branch table (`FrequencyDomainBranchTable`). Selecting a point or branch updates selection focus cleanly across chart, explorer, and inspector.
- **FMR Driven Response Sweep (`FmrResponseSweepInspectorPanel`)**: Summarizes sweep progress (`useFrequencyDomainResponseProgressResource`), response points (`FrequencyDomainResponseChart`, `FrequencyDomainResponsePointTable`), and extracted resonance peaks (`FrequencyDomainFmrPeakTable`), with one-click actions to project a driven response field into 3D (`analysis.frequency-response.plot-response-field-3d`) or launch harmonic phase animation (`analysis.frequency-domain.set-3d-animation`).
- **FMR Peak Detail (`FmrPeakInspector`)**: Shows identity badge, frequency, physical source, canonical target, complex amplitude, absorbed power density, phase, linewidth, provenance, plot readiness diagnostics, and shared 3D display triggers.

```{image} /_static/images/ui/charts-dispersion-and-fmr-spectrum.png
:alt: Spin-wave dispersion Modal fn(k) plot showing bv_bulk, de_surface, and pssw_1 branches versus path_s in Mrad/m
:align: center
:width: 100%
```

## 3D Mode & Spatial Profile Overlay Controls (`ModeVisualizationInspectorPanel`)

When plotting either a Bloch/FEM eigenmode (`source: "eigen-mode"`) or a driven harmonic response
field (`source: "frequency-response"`), `ModeVisualizationInspectorPanel` exposes shared overlay
controls synchronized with the Ribbon's contextual **Analysis** (`analysis-context`) tab:

- View layout selector (`Chart`, `3D field`, `Chart + 3D` via `VisualizationContextSwitch`);
- Phase slider (`0` to $2\pi$ radians, dispatching `analysis.eigen.set-mode-3d-phase` or `analysis.frequency-domain.set-3d-phase`) for visual spatial inspection;
- Complex projection mode (`real`, `imag`, `magnitude`, `phase_rotated_real`), component selector, colormap, vectors, shader, volume clipping, and continuous phase playback rate selector (`0.1 Hz`, `0.25 Hz`, `0.5 Hz`, `1 Hz`, `2 Hz`) — explicitly noted as visual playback rates that never alter physical mode frequencies.

```{image} /_static/images/ui/viewport-3d-eigenmode-spatial-profile.png
:alt: 3D spatial eigenmode profile rendered in the viewport via ModeVisualizationInspectorPanel
:align: center
:width: 100%
```

## Additional Result & Diagnostic Inspectors

- **Live & Analysis Charts (`LiveChartInspectorPanel`, `ChartInspectorPanel`, `QuickChartInspectorPanel`)**: Configure time/stage traces, horizontal axes, window decimation, and CSV exports.
- **Materialized Datasets & Playback (`MaterializedDatasetInspectorPanel`, `SavedResultsPlaybackInspector`)**: Browse paged scalar/table datasets and scrub saved frame timelines without reopening a solver backend.

## Selection routes and Python interoperability

- **Selection routes**: `planar-monitor`, `planar-monitor-draft`, `eigen-dispersion`, `eigen-branch`, `eigen-dispersion-point`, `eigen-mode`, `frequency-response-sweep`, `frequency-response-point`, `fmr-peak`, `mode-visualization`, `chart`, `live-chart`, `materialized-dataset`, and `saved-results-playback`.
- **State boundary**: Monitor definitions commit authoring revisions (`MODEL_PLANAR_MONITORS_PATH`); all frequency-domain and dataset inspectors are read-only (`inspection-only`) result views coupled to visualization state.
- **Python alignment**: Planar monitors, eigenmode studies, Bloch $k$-paths, and driven frequency response sweeps are defined in `packages/fullmag-py` stages and problem definitions. Phase rotation and 3D playback rate controls affect UI visualization state only and do not mutate Python study objects.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Planar monitor draft creation | `apps/control-room/src/modules/inspector/panels/PlanarMonitorDraftInspectorPanel.tsx` | `PlanarMonitorDraftInspectorPanel` |
| Committed monitor editor | `apps/control-room/src/modules/inspector/panels/PlanarMonitorInspectorPanel.tsx` | `PlanarMonitorInspectorPanel` |
| Eigenmode dispersion summary inspector | `apps/control-room/src/modules/inspector/panels/frequency-domain/EigenDispersionInspectorPanel.tsx` | `EigenDispersionInspectorPanel` |
| FMR frequency sweep inspector | `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrResponseSweepInspectorPanel.tsx` | `FmrResponseSweepInspectorPanel` |
| FMR resonance peak inspector | `apps/control-room/src/modules/inspector/panels/frequency-domain/FmrPeakInspector.tsx` | `FmrPeakInspector` |
| 3D eigenmode & response phase controls | `apps/control-room/src/modules/inspector/panels/ModeVisualizationInspectorPanel.tsx` | `ModeVisualizationInspectorPanel` |
| Saved results playback inspector | `apps/control-room/src/modules/inspector/panels/SavedResultsPlaybackInspector.tsx` | `SavedResultsPlaybackInspector` |
