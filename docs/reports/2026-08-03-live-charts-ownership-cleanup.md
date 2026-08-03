# Live Charts ownership cleanup report

Date: 2026-08-03

## Scope and migration boundary

Task 10 of the Live Charts/Analysis separation was completed in frontend-v2
Phase 6 (modules/parity). `apps/legacy_web` remained reference-only and was not
modified. This work does not declare global cutover, legacy freeze, parity, or
legacy removal.

The governing docs now define three independent surfaces:

- **Live Charts** — active-run time series in the center;
- **Analysis** — postprocessing for an explicit selected dataset, run, stage, or
  artifact in the center;
- **Quick Chart** — an explicitly pinned table descriptor in the bottom dock.

## Compatibility inventory

| Reader | Status | Removal condition |
|---|---|---|
| old Analysis live preference key | bounded and read-only | One released preference schema version has written `fm:live-chart-preferences:v1`, and browser migration tests prove no old live identity remains. |
| Analysis `comparisonSelectedSeriesKeys` preference field | bounded and read-only | One released `analysis-view-preferences:v2` writer uses `selectedSeriesIds`, and migration tests prove no stored descriptor depends on the old field. |
| Quick Chart `yAxisIds` descriptor | bounded and read-only | One released Control Room version writes only `selectedSeriesIds`, and migration tests prove no persisted or Explorer descriptor depends on it. |

No old writer remains. `analysisPlotsWorkspace`, `analysisChartPreferences`, and
their hydration hooks have no file or consumer. Import scans also proved the old
Analysis Quick Chart dock, legacy legend, status-pill, workbench, and quantity
availability CSS selectors were unreferenced before removal.

Follow-up review found that `TableColumnList` still renders
`.fm-analysis-plots__column-id`; its exact token-based selector remains in
`analysis-plots.css` and a selector-reference regression test protects it. The
other selectors listed above remain removed.

## Verification

- consolidated focused gate: 22 files, 210/210 tests passed;
- follow-up ownership/design review gate: 6 files, 101/101 tests passed;
- ownership architecture test: 15/15 passed;
- registry, preference, Quick Chart, Explorer, manifest, and chart CSS tests:
  100/100 passed;
- Analysis dataset/comparison/controller and Quick Chart integration tests:
  91/91 passed;
- design-token and focused component tests: 15/15 passed;
- API-path fixture tests: 5/5 passed;
- Control Room typecheck: passed;
- architecture hygiene: passed;
- API hygiene: passed;
- `git diff --check`: passed.

The design-style gate exposed an undefined `--fm-secondary` token in Live Charts;
it now uses the canonical `--fm-text-secondary` token. API hygiene exposed four
test fixtures with hand-built `/v2/...` strings; they now consume `apiPaths`
constants. Neither correction changes runtime contracts.

Independent review also corrected the renderer wording: a Comparison surface
mounts two panes, so ownership is one ECharts instance per mounted chart/pane,
with every instance disposed on unmount.
