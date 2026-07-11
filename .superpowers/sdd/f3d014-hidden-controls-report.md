# F3D-014: hidden target pass controls

## Scope

Implemented only the audited hidden-target control contract in the Inspector,
Ribbon, and shared visualization command registry. No renderer, FDM, API,
OpenAPI, generated transport, or resource contract changed.

## Required behavior

- `visible=false` keeps every configured pass/style value but makes it
  ineffective.
- Inspector and Ribbon disable pass/style controls while hidden; `Visible` and
  the override reset remain usable.
- Pass-only helper patches do not add `visible: true`.
- Command palette and shortcuts use the same guard, so they cannot bypass a
  hidden target.

## TDD evidence

The initial focused RED run failed in the intended places:

1. `surfaceDisplayPassPatch`, `displayPassTogglePatch`, and
   `renderModeDisplayPatch` emitted `visible: true` for a hidden target.
2. `ObjectVisualizationPanel.tsx` calculated
   `passControlsDisabled = pending`, so hidden targets kept active controls.
3. `visualization.target.set-wireframe-visible` remained enabled and executed
   for a hidden target.

After the minimal implementation, the focused suite passes with 146 tests.

## Implementation

- Removed implicit master-visibility writes from all pass-only Inspector model
  helpers, including the full-geometry fallback helper.
- Derived Inspector pass disablement from `pending || !settings?.visible` and
  applied the hidden gate to quantity and opacity controls as target display
  style. Existing render, surface, point, wireframe, vector, and geometry
  sections already consume the shared section gate.
- Kept `Visible` disabled only by pending work and kept Reset disabled only by
  pending work.
- Marked selected-target Ribbon opacity controls with the existing
  `passControlsDisabled` gate. Its render/color/vector controls already used
  that gate.
- Added `targetPassCommandEnabled`, resolved from the same effective target
  settings (including HTTP v2 visualization-state registry data), and applied
  it to every pass/style mutation command. Only explicit visibility and clear
  overrides retain the base target-availability guard.
- Added regressions that prove a configured wireframe pass is preserved while
  hidden and becomes effective again after only `visible=true`.

## Verification

```text
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts \
  src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts \
  src/kernel/visualization/visualizationCommandContributions.test.ts \
  src/modules/ribbon/ribbonStructure.test.ts

4 files passed, 146 tests passed.

pnpm --dir apps/control-room typecheck
passed.

pnpm --dir apps/control-room exec eslint [8 changed source/test files]
passed with no output.

git diff --check
passed.
```

## Resource-first ownership

This is frontend-only. `GET /v2/sessions/current/visualization/state` remains
the authoritative state snapshot; the command guard reads that existing
resource when present, while websocket semantics remain invalidation-only.
No endpoint, generated OpenAPI type, transport, facade, hook, or codec changed.
