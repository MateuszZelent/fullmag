# Analysis surface integration closure — 2026-08-03

## Scope

This closure removes the remaining legacy Analysis chart boundary and makes the Analysis surface resource-scoped. It covers frequency-domain artifact gating, chart export routing, paired dataset comparison, the Analysis Inspector, and provenance presentation.

## Delivered contract

- Frequency-domain child resources remain disabled while the manifest is loading or unresolved. After a ready manifest resolves a route, only the resource matching the active Analysis surface can load; a route/surface mismatch or a missing required artifact is explicit `unsupported` with no chart series.
- Analysis export requests use the mounted chart identity. Dataset charts use `surface:dataset`; frequency-domain charts use `surface:artifact-resource`; and comparison uses a focused primary or secondary pane identity. A request addressed to another chart is ignored.
- Comparison stores semantic `quantity|unit` keys, never either table's full series IDs. Dataset B remains replaceable and explicitly clearable after selection. Each pane derives its own IDs; initial compatible quantities are selected, and an explicit empty selection is preserved. B's loading, error, and unsupported state is rendered directly rather than misreported as incompatibility.
- Persisted Analysis ranges now drive the shared ECharts `dataZoom` at mount/remount and interaction persists SI bounds back to the descriptor. Persisted display-unit preferences are passed through the shared chart contract and are applied only for compatible unit conversions.
- Frequency Response and Eigenmodes keep their selected-series state in an artifact-derived descriptor, independent of any globally selected data table. First use selects compatible artifact series; an explicit empty artifact selection remains empty.
- Changing or clearing comparison dataset B deterministically rebases a stale focused secondary pane to the primary chart identity before export.
- Display-unit controls are grouped by the raw chart axis unit, emit one merged preference patch for every quantity on that axis, and appear only when compatible display alternatives exist. The available chart-unit catalog includes time/frequency plus `J` and `A/m` prefixes; it intentionally excludes physical `T`↔`A/m` conversion.
- The Analysis Inspector reads `analysisWorkspace` plus Analysis V2 preferences. It reports the selected dataset, surface, range, axes, and series, and no longer exposes Live Chart follow/pause controls.
- The unused Analysis workspace, legacy Analysis preferences, and Analysis energy surface were removed. Live Charts retain their separate preferences and controls.
- Gamma and DSF expose their resource schema revision; hysteresis shows the actual points-resource revision or `revision unavailable` when the resource has no revision.

## Evidence

- Focused Control Room gate: 18 files, 129 tests passed.
- `corepack pnpm --dir apps/control-room typecheck` passed.
- `corepack pnpm --dir apps/control-room audit:compute-performance` passed.
- Browser `smoke:analysis-plots` passed with the host browser runtime for the prior closure. Re-running it for this UI refinement requires a running Control Room at `http://localhost:3100`; no server was available in this verification environment, so this final visual proof remains pending rather than inferred from component tests.
- Negative scan found no legacy Analysis workspace/preferences/energy-surface imports and no `following`/`paused` wording in the Analysis Inspector.
- `git diff --check` passed.

## Qualification boundary

These checks prove TypeScript and mounted/component contract behavior. They do not constitute a browser visual qualification of the complete Control Room shell or scientific qualification of any solver result.
