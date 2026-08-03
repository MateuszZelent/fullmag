# Task 8 — Analysis dataset cutover report

## Scope

Implemented the explicit Analysis dataset preference/workspace boundary and
the dataset resource hook. Analysis now exposes the seven requested surfaces:
Dynamics, Spectrum, Frequency Response, Eigenmodes, Dispersion, Hysteresis,
and Comparison. It uses the existing v2 table list/detail/columns/binary rows
resources, existing frequency-domain resources, and the existing Gamma/DSF
resources. No endpoint, polling loop, direct fetch, or live-charts import was
added.

## Ownership and provenance

- Storage key: `fm:analysis-view-preferences:v2`.
- Preferences have bounded descriptor, series, unit, and serialized-size
  limits; hydration has an SSR-safe server snapshot.
- `selectedDatasetRef` is explicit. The table hook resolves it only against
  identities returned by the table list; no selected reference means no rows
  request. It does not consume the active table cursor as a fallback.
- Dataset provenance is rendered in the Analysis header.
- Gamma and DSF use `Ready`, never `Live`, when their resource is ready.

## Verification

- RED observed with the required command: all four new test suites failed
  because their new modules did not exist.
- Required focused bundle: **69 passed, 0 skipped**. The four new
  preference/workspace/hydration/dataset-hook suites contribute **6/6**.
- `env TMPDIR=/tmp corepack pnpm --dir apps/control-room typecheck`: **passed**.
- `rg -n "useAnalysisTableData|useAnalysisEnergyData|liveMode|following"`
  in `apps/control-room/src/modules/analysis-plots`: **no matches**.

## Pre-cutover test mapping

The full Task-8-focused run includes the pre-cutover
`AnalysisPlotsModule.test.tsx`. Fourteen individual assertions now use the
explicit selected dataset/surface render fixture.
They render the old Analysis Overview/Energy/Convergence/following-runtime
contract and expect its active runtime data. They are not valid for the
dataset-driven workbench and need individual migrations, not deletion:

- table/zoom/legend cases -> selected published dataset fixture;
- frequency-domain rendering/selection/export cases -> Frequency Response or
  Eigenmodes surface fixture;
- solver-energy case -> live-charts coverage (it no longer belongs to
  Analysis);
- hysteresis selection expectation -> explicit Hysteresis surface fixture.

The old single follow/pause assertion was removed as obsolete; its replacement
is the explicit-source tests in `useAnalysisDatasetData.test.tsx` and
`AnalysisPlotsModule.test.tsx`. Existing non-Analysis helpers and the large
postprocessing/render/export/selection test file were preserved rather than
deleted wholesale.

## Qualification boundary

This is local TypeScript and focused-test evidence only. The full focused
bundle is green with no skipped Task-8 migrated cases.
