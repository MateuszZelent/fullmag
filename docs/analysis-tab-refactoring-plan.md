# Analysis tab refactoring plan — superseded

**Status:** Superseded on 2026-08-03

**Current phase:** frontend-v2 Phase 6 (modules/parity)

**Replacement:**
[`2026-08-02-live-charts-analysis-separation.md`](superpowers/plans/2026-08-02-live-charts-analysis-separation.md)

## Why this plan was superseded

The former plan treated live scalar monitoring, scientific postprocessing, and a
compact dock chart as one Analysis workbench. That combined incompatible data
lifecycles and state ownership. The approved implementation replaces it with
three independent product surfaces:

| Surface | Canonical responsibility |
|---|---|
| **Live Charts** | Center module `live-charts`; follows active-run scalar time series with explicit Follow/Pause and local series visibility. |
| **Analysis** | Center module `analysis-plots`; processes an **explicit selected dataset**, run, stage, or artifact and never adopts the current table implicitly. |
| **Quick Chart** | Bottom-dock content owned by `transport-footer`; displays an explicitly pinned table descriptor while coexisting with 3D. |

This document is retained only as a durable redirect. It is not an active
implementation checklist. The current architectural contract is ADR 0022 and
`docs/specs/frontend-v2/16-charts-analysis-module.md`.

## Preserved invariants

- HTTP v2 resources remain authoritative; realtime is invalidation-only.
- Center surfaces are active-only and release renderer/resource ownership on
  switch.
- Quick Chart is not a mount of `analysis-plots` or `live-charts` and imports
  neither module store.
- Shared chart code stays renderer-neutral and unit-aware.
- New persistence writes use `fm:live-chart-preferences:v1`,
  `fm:analysis-view-preferences:v2`, and `selectedSeriesIds`.
- No chart preference stores decoded arrays, response bodies, renderer options,
  or 3D state.

## Bounded compatibility reads

- Live preference migration is owned by `liveChartPreferences.ts`. Remove the
  old Analysis preference reader after one released preference schema version
  has written `fm:live-chart-preferences:v1` and browser migration tests prove no
  old live identity remains.
- Quick Chart descriptor migration is owned by `quickChartWorkspace.ts`, with
  `explorerTypes.ts` admitting the same legacy input. Remove `yAxisIds` after one
  released Control Room version writes only `selectedSeriesIds` and migration
  tests prove no persisted or Explorer descriptor depends on it.
- Analysis comparison preference migration is owned by
  `analysisViewPreferences.ts`. Remove `comparisonSelectedSeriesKeys` after one
  released `analysis-view-preferences:v2` writer uses `selectedSeriesIds` and
  migration tests prove no stored descriptor depends on the old field.

These paths are read-only and one-version bounded. Their removal gates are part
of the release checklist; they are not permission to maintain dual ownership.

## Governance boundary

This refactor advances Phase 6 chart parity only. `apps/legacy_web` stays
reference-only and unchanged. Global frontend cutover, legacy freeze, and legacy
removal still require `docs/specs/frontend-v2/21-cutover-acceptance.md`; this
completed module separation does not satisfy those gates by itself.
