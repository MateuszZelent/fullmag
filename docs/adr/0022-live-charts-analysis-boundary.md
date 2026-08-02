# ADR 0022: Separate Live Charts from Analysis

- Status: accepted
- Date: 2026-08-02

## Context

The `analysis-plots` center module currently combines active-run scalar monitoring with scientific postprocessing. This gives one surface two different lifecycles: revision-following live data and explicitly selected analysis datasets or artifacts. It also makes the name `Analysis` misleading for users who only want to observe `mx`, `my`, `mz`, energies, torque, or residuals while a stage runs.

The current composition has produced user-visible correctness and lifecycle defects: normalized magnetization can be displayed with a nonsensical SI-prefixed unit such as `m1`, series selection has conflicting Inspector and legend owners, and retained-data refresh is presented as blocking `Loading` churn.

The product invariants remain one workspace, one center-surface host, one typed resource-first browser contract, one shared chart renderer boundary, and one unified FDM/FEM UI tree.

## Decision

Add a `live-charts` module titled **Live Charts** in `viewport-main`. It owns active-run scalar histories and Follow/Pause/range behavior.

Keep `analysis-plots` titled **Analysis** in `viewport-main`, but restrict it to analysis of an explicit selected run, stage, dataset, or artifact: dynamics, spectra, frequency response, eigenmodes, dispersion, hysteresis, and comparisons.

Keep Quick Chart as optional `transport-footer` content that can coexist with the 3D viewport. It consumes shared chart contracts and compact descriptors, not another module's store.

Both center modules use active-only mounting and shared chart primitives. HTTP v2 remains the source of resource snapshots; realtime events only invalidate resources. No screen-shaped endpoint or polling interval is introduced.

Normalized magnetization uses a dimension-aware fixed display scale of one. Live series visibility has one owner, `selectedSeriesIds`, and permits zero selected series. Background refresh retains the prior plot and never uses a blocking loading overlay.

## Consequences

- The workspace gains distinct `Live Charts` and `Analysis` center tabs.
- Live state and preferences no longer share ownership with analysis-dataset state.
- The `analysis-plots` module becomes simpler but commands, selection refs, preferences, explorer nodes, tests, and documentation require coordinated migration.
- Shared chart contracts must remain module-neutral.
- Quick Chart remains independent and must not affect 3D resources or render lifecycle.
- Existing table and analysis resource families are reused unless a separate coverage audit proves a semantic gap.
- FDM and FEM continue through the same modules, capabilities, adapters, and resource contracts.

## Implementation obligations

- Implement the approved design in `docs/superpowers/specs/2026-08-02-live-charts-analysis-separation-design.md`.
- Add the `live-charts` manifest, view state, controller, resource composition, commands, Inspector surfaces, selection identities, preferences, and tests.
- Remove implicit live-follow responsibility from `analysis-plots`.
- Replace overlapping live `yAxisIds`/`hiddenSeriesIds` visibility with one selected-series contract.
- Add dimension-aware chart scaling and retained-data refresh presentation before module cutover.
- Preserve generated transport/facade/hooks, bounded binary table data, HTTP truth, and realtime invalidation.
- Update ADR 0016, the module catalog, chart spec, old Analysis hardening plan, active plans, and verification scripts.
- Contain any compatibility reader behind a documented version/removal gate; new writes use the new identities.

## Validation

- Regression fixtures prove exact normalized magnetization values and no prefixed dimensionless units.
- All `mx`/`my`/`mz` visibility combinations work locally with zero network requests.
- Repeated relevant revisions update in the background without overlay flicker; idle and irrelevant revisions do no work.
- Module tests prove active-only center mounting and independent state ownership.
- Browser smoke proves distinct tabs, correct values, background refresh, Quick Chart plus 3D isolation, and healthy WebGL after returning to 3D.
- Typecheck, Control Room tests, resource-first gates, chart performance/idle audits, and lifecycle/memory audits pass.

## Migration and rollback

Implement in independently testable commits. Migrate old live-table preferences once into the new versioned live preference model. Read old live selection identities only during the bounded compatibility window; never write them after cutover.

Before final deletion, preserve the ability to unregister `live-charts` and restore the previous center-tab set without changing canonical server data. Rollback may restore the previous module arrangement, but it must not restore incorrect dimensionless scaling, conflicting series ownership, or blocking refresh overlays.
