# Analysis surface integration closure — 2026-08-03

## Scope

This closure removes the remaining legacy Analysis chart boundary and makes the Analysis surface resource-scoped. It covers frequency-domain artifact gating, chart export routing, paired dataset comparison, the Analysis Inspector, and provenance presentation.

## Delivered contract

- Frequency-domain child resources remain disabled while the manifest is loading or unresolved. After a ready manifest resolves a route, only the resource matching the active Analysis surface can load; a route/surface mismatch is explicit `unsupported` with no chart series.
- Analysis export requests use the same `surface:dataset` chart identity accepted by the mounted ECharts owner. A request addressed to another chart is ignored.
- Comparison stores semantic `quantity|unit` keys, never either table's full series IDs. Each comparison pane derives its own IDs; initial compatible quantities are selected, and an explicit empty selection is preserved.
- The Analysis Inspector reads `analysisWorkspace` plus Analysis V2 preferences. It reports the selected dataset, surface, range, axes, and series, and no longer exposes Live Chart follow/pause controls.
- The unused Analysis workspace, legacy Analysis preferences, and Analysis energy surface were removed. Live Charts retain their separate preferences and controls.
- Gamma and DSF expose their resource schema revision; hysteresis shows the actual points-resource revision or `revision unavailable` when the resource has no revision.

## Evidence

- Focused Control Room gate: 13 files, 96 tests passed.
- `corepack pnpm --dir apps/control-room typecheck` passed.
- Negative scan found no legacy Analysis workspace/preferences/energy-surface imports and no `following`/`paused` wording in the Analysis Inspector.
- `git diff --check` passed.

## Qualification boundary

These checks prove TypeScript and mounted/component contract behavior. They do not constitute a browser visual qualification of the complete Control Room shell or scientific qualification of any solver result.
