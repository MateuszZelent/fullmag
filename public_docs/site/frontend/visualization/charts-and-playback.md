---
title: Live Charts, Hysteresis, Spectral Plots & Playback
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-frontend-visualization-charts-and-playback)=
# Live Charts, Hysteresis, Spectral Plots & Playback

Control Room v2 unifies time-series monitoring, hysteresis curves, dynamic structure factor
heatmaps, spin-wave / FMR spectra, and saved multi-run comparison across dedicated analysis modules
backed by **ECharts** (`EChartsSurface.tsx`), binary table streaming (`FMTB`), and durable
`SolutionSet` artifact indices.

## Live Simulation Traces (`LiveChartsModule`)

`LiveChartsModule` and `LiveChartsView` (`apps/control-room/src/modules/live-charts/`) plot
real-time and completed table columns with responsive decimation and CSV export:

- **Presets (`LiveChartControls`)**: Switch cleanly between `Magnetization`, `Energy`, `Convergence`, and `Custom` series selections.
- **Axes & Sampling Windows**: Choose the horizontal axis (`xAxisOptions`) and sample window (`Latest samples` follow mode vs. `Last 5,000 samples (decimated)`).
- **Follow / Pause / Fit / CSV Export**: Pausing `Follow` freezes the viewport window for zoom inspection without interrupting the running backend simulation; **CSV** downloads the visible sampled signals.

```{image} /_static/images/ui/charts-live-time-series.png
:alt: Live Charts view plotting magnetization components and energy time-series with preset selector, window controls, and CSV export
:align: center
:width: 100%
```

## Hysteresis Loops and Snapshot Replay (`analysis-hysteresis`, `HysteresisChart`)

Rendered inside `AnalysisPlotsView` (`apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`),
hysteresis curves plot macroscopic $M(B)$ branches with bidirectional cursor synchronization: clicking
any field step along the ascending or descending branch updates global `Selection` (`stageId`,
`snapshotId`, `field_value_mT`, `branch_id`), allowing `PlanarSnapshotNavigator` (2D) and
`HysteresisReplayGlyphLayer` / `Viewport3DModule` (3D) to replay the spatial magnetization state at
that exact bias field.

```{image} /_static/images/ui/charts-hysteresis-loop-playback.png
:alt: Hysteresis loop chart linked with snapshot selection for synchronized 2D/3D spatial replay
:align: center
:width: 100%
```

## Spectral Dispersion, $S(k,f)$, and FMR Plots (`AnalysisPlotsView`)

Frequency-domain and spin-wave post-processing surfaces share `AnalysisPlotsView` and specialized
domain views:

- **$\Gamma$ Spin-Wave Response (`SpinWaveGammaView`)**: Displays sampling metadata ($N$, $t_{\text{sampling}}$, duration, $\Delta f$, Nyquist limit), response trace $\Delta m(t)$, drive/antenna trace $H(t)$, FFT spectra, and interactive spectral peak tables linking clicks back to frequency features.
- **Dynamic Structure Factor $S(k,f)$ (`DynamicStructureFactorView`)**: Interactive keyboard-navigable heatmap (`Log` / `Linear` scale; `S(k,f)` response or `H(k,f)` source spectrum) paired with selectable horizontal **f cut** and vertical **k cut** slices. When the backend serves a bounded decimated heatmap, the view displays an explicit sampling notice so decimated projections are never mistaken for raw full payloads.
- **Eigenmode Dispersion & Driven FMR Curves**: Plots tracked magnon bands $\omega(k)$ and absorbed power / susceptibility curves side by side with `EigenDispersionInspectorPanel` and `FmrResponseSweepInspectorPanel`, enabling one-click spatial mode projection onto the 3D canvas.

```{image} /_static/images/ui/charts-dispersion-and-fmr-spectrum.png
:alt: Spin-wave dispersion Modal fn(k) view in Analysis showing bv_bulk, de_surface, and pssw_1 branches plotted against path_s in Mrad/m
:align: center
:width: 100%
```

## Saved Results Navigator and Comparison (`ResultsNavigatorModule`, `SavedResultsBrowser`)

`SavedResultsBrowser` (`apps/control-room/src/modules/results-navigator/SavedResultsBrowser.tsx`)
and `SavedResultsPlaybackViewport` browse historical project runs, batches, and materialized
`SolutionSet` revisions (`solutionSetResources.ts`). Operators inspect paged scalar tables, open
materialized field snapshots (`SavedMaterializedArtifactRow`) offline, scrub recorded frame sequences,
and trigger overlaid result comparisons across selected datasets.

```{image} /_static/images/ui/results-saved-navigator-comparison.png
:alt: Results Navigator and Analysis comparison browser showing saved SolutionSet revisions and overlaid spectral/time curves
:align: center
:width: 100%
```

## Modules and artifact sources

- **Modules**: `LiveChartsModule`, `AnalysisPlotsModule`, `dispersionAnalysisModule`, `hysteresisAnalysisModule`, `resonanceAnalysisModule`, and `ResultsNavigatorModule`.
- **Binary & paged data**: Time and table traces stream over binary `FMTB` (`tableRowsCodec.ts`) rather than unbounded JSON arrays; decimated projections disclose bounding in UI status chrome.
- **Artifact sources**: Plotted traces correspond to stage `table_autosave`, `autosave`, `hysteresis`, `fft_response`, `eigenmodes`, and `frequency_response` artifacts in Python and saved `.zarr` / `SolutionSet` archives.

## Source-code index

| Responsibility | Repository path | Stable symbol |
|---|---|---|
| Live time-series module & controls | `apps/control-room/src/modules/live-charts/LiveChartsView.tsx` | `LiveChartsView`, `LiveChartControls` |
| Unified analysis plot container | `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx` | `AnalysisPlotsView` |
| Dynamic structure factor $S(k,f)$ heatmap | `apps/control-room/src/modules/analysis-plots/DynamicStructureFactorView.tsx` | `DynamicStructureFactorView` |
| Gamma FFT trace & peak table view | `apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx` | `SpinWaveGammaView` |
| ECharts lifecycle & SVG/PNG surface | `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx` | `EChartsSurface` |
| Saved SolutionSet browser & playback | `apps/control-room/src/modules/results-navigator/SavedResultsBrowser.tsx` | `SavedResultsBrowser` |
