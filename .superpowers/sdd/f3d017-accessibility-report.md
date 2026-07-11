# F3D-017 accessibility review

## Verdict: Important issue found

### Important — disabled vector controls can announce the wrong prerequisite

`VisualizationVectorsSection` derives `vectorsDisabled` from `pending ||
sectionDisabled("vectors")`, but passes every non-pending disabled state to
`sectionControlDisabledDescription` as though the only cause were a disabled
Vectors pass. `sectionDisabled("vectors")` is also true when the target's
master `Visible` setting is false. In that state, a configured Vectors pass can
already be enabled, yet the disabled radio group and boolean toggles announce
"Enable the Vectors display pass...". Enabling that pass cannot restore the
controls; the user must enable `Visible` first.

This violates the F3D-017 acceptance requirement that disabled reasons
announce the correct state, and the F3D-014 hidden-target contract. Pass the
master visibility into the description helper (or share
`displayControlDisabledDescription`) and announce `Enable Visible...` whenever
the master flag is the gating condition. Add a regression test for
`visible=false` with `vectorsVisible=true`.

## Reviewed and acceptable

- Display/vector boolean buttons expose native disabled state and
  `aria-pressed`.
- Render mode, vector coloring, arrow extent, and geometry scope use labelled
  `radiogroup` / `radio` semantics, checked state, roving tab stop, and Arrow,
  Home, and End keyboard selection.
- Picker and text colour inputs have distinct accessible names.
- The focused accessibility test passes: 5 tests.

No Critical or additional Minor issue found in the supplied diff.

## Follow-up implemented

The vector-control disabled description now follows the effective gate order:
pending save, master `Visible`, then `Vectors`. A hidden target with a
configured vector pass therefore announces `Enable Visible to change display
passes.` before any vector-pass prerequisite. The regression is covered in
`ObjectVisualizationPanel.accessibility.test.tsx`.

### Follow-up verification

- `pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx` — 6 passed
- `pnpm --dir apps/control-room typecheck` — passed
- `pnpm --dir apps/control-room exec eslint src/modules/inspector/panels/ObjectVisualizationPanel.tsx src/modules/inspector/panels/ObjectVisualizationPanelAccessibility.ts src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx` — passed
- `git diff --check` — passed
