# Quick Chart bottom-dock closure — 2026-08-03

## Scope

This closure moves the pinned Quick Chart into the transport footer's bottom
dock and gives it a bounded, module-neutral descriptor. It covers pinned table
identity, selected series, display units, SI range, comparison-table identity,
resource loading, footer lifecycle, Explorer/Inspector projection, and command
behavior.

## Delivered contract

- `quick-chart` is a persisted bottom-panel tab owned by the transport footer.
  The chart is mounted only while that tab is active, so its ECharts owner and
  resize observer are released when the user leaves the tab.
- `analysis-plots` remains a `viewport-main` module. Its neutral
  `quick-chart.pin` command writes a descriptor and opens the bottom panel; it
  does not change selection, viewport ownership, camera state, or dirty state.
- A pinned descriptor carries `chartId`, `tableId`, `xAxisId`, full
  `selectedSeriesIds`, SI range, and display-unit preferences. New state never
  writes the legacy `yAxisIds` shape. A bounded parser provides one-version
  read migration for legacy persisted and Explorer values.
- The shared Quick Chart resource view reads only the Quick Chart workspace
  descriptor and table column/row resources. It does not import Analysis or
  Live Charts module state and does not request rows for an unpinned or
  explicitly empty selection.
- Unsupported selected quantities are distinct from an empty selection. The
  renderer retains full series identities, applies compatible display units,
  and restores the pinned SI range on mount, update, and remount.
- Comparison pinning uses the focused table's own table identity and X axis.
  A range is cleared when the compared X axes differ. Frequency-domain pinning
  is explicitly disabled because it is not backed by the supported table
  descriptor contract.
- Point clicks publish a small semantic chart-point selection with source
  `transport-footer`; they do not trigger field, topology, or viewport work.
- Quick Chart fails closed when any selected full series identity is absent
  from the published schema. It does not fetch or render an available subset.
- The compact renderer accepts at most two compatible y-axis unit groups.
  Compatible scales such as `J` and `pJ` share one group; a third physical
  dimension produces an explicit unsupported state with no partially mapped
  series. Values from compatible raw scales are converted into the group's
  representative raw unit before the shared display-unit transform runs.
- Clearing a pinned range on an already mounted renderer performs one explicit
  fit-to-data action. Stable `null` range renders do not repeat that action and
  the separate explicit fit-request contract remains unchanged.

## Evidence

- Task 9 focused regression gate: 71 files, 553 tests passed.
- Fail-closed follow-up TDD gate: 3 files, 19 tests passed; the five new
  assertions were red before the implementation change.
- Fail-closed follow-up regression gate: 69 files, 538 tests passed.
- `corepack pnpm --dir apps/control-room typecheck` passed.
- `git diff --check` passed.
- Architecture scans found no new `yAxisIds` writes, no Analysis/Live/private
  resource imports in the neutral Quick Chart sources, no direct `fetch()`, and
  no selection/viewport/camera/dirty mutation in `quick-chart.pin`.
- React Doctor exited successfully but emitted no report or numeric score; no
  score is inferred.
- A broader unfiltered test invocation reached three inherited failures outside
  this task: the `--fm-secondary` design-token expectation, a stale compute
  audit source-path expectation, and a visualization-debug health-copy
  expectation. Task 9 does not modify those owners.

## Qualification boundary

These checks prove the TypeScript, resource-boundary, state, renderer lifecycle,
and mounted component contracts. Full-shell browser appearance, 3D coexistence,
WebGL continuity, request/byte budgets, and screenshot evidence remain the
dedicated browser qualification task; they are not inferred here.
