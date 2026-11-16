---
title: Outputs
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-root)=
# Outputs

Outputs turn solver results into inspectable scientific artifacts: fields and scalars, quantity
selection, eigenmodes and spectra, dispersion and response, step snapshots, and autosave tables.

```{toctree}
:maxdepth: 1

fields-and-scalars
quantities
modes-and-spectra
dispersion-and-response
snapshots
autosave
```
## Control Room crosswalk

Inspect live and saved outputs across four coordinated Control Room surfaces:

- **Stage Autosave & Table Cadence (`Model Explorer -> Stages -> <stage> -> Autosave`)**: `AutosaveStageInspector` and `TableAutosaveStageInspector` manage scalar and snapshot intervals for editable stages.
- **2D Planar Field Map & Monitors (`FieldMapModule`, `PlanarMonitorInspectorPanel`)**: Interactive `XY`/`XZ`/`YZ` cross-sections, vector streamlines, contours, line-profile cuts, multi-layer overlays, and tiled multislice panels (`PlanarMultisliceGrid`).
- **Live Charts & Spectral Analysis (`LiveChartsView`, `AnalysisPlotsView`)**: FMTB-backed magnetization/energy curves, $M(B)$ hysteresis loops, dynamic structure factor $S(k,f)$ heatmaps, and FMR spectra.
- **Saved Results Navigator (`SavedResultsBrowser`)**: Browse durable `SolutionSet` runs, scrub snapshots offline, and compare historical runs side by side.

Output formats or sampling rules without a matching inspector control are `TODO: frontend support`; this index does not imply that every publication artifact is authorable in the UI. See {doc}`/frontend/capability-register`, {doc}`/frontend/visualization/planar-2d-and-monitors`, and {doc}`/frontend/visualization/charts-and-playback`.

```{image} /_static/images/ui/planar-2d-field-map-overview.png
:alt: Control Room 2D Planar Field Map showing slice plane controls, vector field overlay, and live coordinate readout
:align: center
:width: 100%
```

```{image} /_static/images/ui/results-saved-navigator-comparison.png
:alt: Control Room Results Navigator and comparison plots browsing saved SolutionSet revisions
:align: center
:width: 100%
```

## API and source scope

This navigation page has no standalone output function. Terminal pages own exact Python calls, artifact semantics, limitations, bibliography, and source-code indexes.

## Source-code index

This is a navigation page and introduces no standalone implementation symbol. The exact source-code index is maintained by the selected terminal page.
