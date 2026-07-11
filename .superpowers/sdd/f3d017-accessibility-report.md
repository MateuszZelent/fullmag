# F3D-017 accessibility controls

## Scope

Implemented the audited accessible-state remediation in
`ObjectVisualizationPanel`.

## Changes

- Display-pass and vector boolean controls now expose `aria-pressed`.
- Render mode, vector coloring, arrow extent, and geometry scope use labelled
  `radiogroup` / `radio` semantics with `aria-checked`, roving tab stops, and
  Arrow, Home, and End keyboard selection.
- Disabled controls announce whether a save is pending or the relevant display
  pass must first be enabled; this describes configured versus currently
  effective availability without relying on visual styling.
- Color pickers and their text-value inputs now have distinct accessible names.

## TDD evidence

The new renderer/accessibility test was run before implementation and failed
because the semantic controls did not exist. It now verifies toggle state,
disabled descriptions, radio roles/checked state, keyboard navigation, and
color-input names.

## Verification

- `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts` — 74 passed
- `pnpm --dir apps/control-room typecheck` — passed
- `pnpm --dir apps/control-room exec eslint src/modules/inspector/panels/ObjectVisualizationPanel.tsx src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx` — passed
- `git diff --check` — passed
