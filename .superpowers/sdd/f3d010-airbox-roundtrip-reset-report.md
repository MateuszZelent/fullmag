# F3D-010 airbox round-trip and reset

## Contract

- `VisualizationTargetStyleOverride` already contains every requested persisted airbox style field; no backend schema, OpenAPI, or generated client change was required.
- Airbox pass visibility and opacity remain mapped to `layers.airbox`; the same normalized target patch is mapped through the canonical override serializer so the target registry remains the shared effective state.
- Browser-only renderer controls remain local: synthetic vectors, primitive visibility, vector centering, and vector surface-offset controls.

## Changes

- Replaced the partial airbox remote/local field lists with the existing complete, schema-aligned target override mapper.
- Added `resetAirboxVisualizationState(currentState)`, which resets all airbox layer defaults and removes only the `scope=airbox` override in one visualization PATCH.
- Wired the reset helper through both the Inspector and Ribbon command path.
- Routed the airbox Ribbon vector density, alpha, color mode, and monochrome color controls through the airbox target instead of global vector style state.

## Verification

- RED: controller tests failed because the omitted style fields were not serialized and the reset helper did not exist.
- GREEN: `pnpm --dir apps/control-room exec vitest run src/kernel/visualization/ObjectVisualizationController.test.ts src/modules/ribbon/ribbonStructure.test.ts` — 128 tests passed.
- `pnpm --dir apps/control-room typecheck` passed.
- Focused ESLint over changed files passed with no warnings.
