# Compact Inspector System Completion Report

**Date:** 2026-07-17
**Branch:** `codex/inspector-2-refactor`
**Scope:** Visualization reference slice followed by the approved migration of every Control Room Inspector family

## Delivered system

The Inspector now uses one compact composition system throughout:

- canonical `--fm-*` tokens bridged into Tailwind 4;
- application-owned CVA/Radix shared controls;
- `InspectorGroup`, `InspectorPropertyRow`, and `InspectorMetricStrip` composition;
- softly rounded, border-light groups without nested card stacks;
- one continuous Visualization surface with independent geometry and vector display controls;
- compact object, mesh, airbox, region, Study, hysteresis, results, diagnostics, and extension panels;
- no production use of the obsolete `InspectorSection` compatibility primitive.

The Visualization display state has one drawable-geometry source of truth:

`Shaded | Shaded+ | Wire | Points | Off`

`Vectors` remains an independent overlay. Selecting `Off` disables surface, wireframe, and points without changing vector visibility. The 360 px presentation uses the compact visible label `Shaded+`, while its accessible name and tooltip remain `Shaded plus wireframe`.

## Semantic invariants

The migration did not change Python DSL, ProblemIR, planner, runtime, OpenAPI, resource loading, selection routing, edit sessions, inheritance, persistence, transactions, viewport quality, or solver behavior.

Visualization remains live. Reset restores the applied sparse baseline, including target overrides and viewport-local preferences. The browser smoke explicitly verifies that `Off` survives the resource update and does not alter the vector overlay.

## Compatibility-debt deletion

Current source evidence:

```text
rg -n 'InspectorSection|fm-inspector-section' apps/control-room/src
```

Only negative contract assertions and unrelated function names remain. There is no production component import, JSX element, CSS selector, or compatibility file.

The following planned legacy selectors have no component usage or remaining definitions:

- `fm-radio-group`
- `fm-visualization-range`
- `fm-inspector-segmented`
- nested `fm-inspector-section` selectors

## Production gates

| Gate | Result | Evidence |
|---|---|---|
| TypeScript | pass | `pnpm --dir apps/control-room typecheck` |
| ESLint | pass | `pnpm --dir apps/control-room lint`, zero warnings |
| Full Vitest | pass | 365 files, 3599 tests |
| Storybook | pass | Storybook 10.5.2 production build, 1889 modules |
| Browser smoke | pass | widths 360/416/560, light/dark, no horizontal overflow, live/reset and dirty-selection guard verified |
| Diff hygiene | pass | `git diff --check` |
| React Doctor | pass with reviewed warnings | exit 0, score 83, zero errors; one positional Radix Slider thumb-key warning and six pre-existing mixed-export warnings |

The React Doctor slider warning is a false-positive risk for a positional Radix multi-thumb control: thumb identity is defined by its stable position, while equal numerical values are legal and therefore cannot safely be used as keys. The mixed-export warnings concern the existing Inspector edit-session and dirty-selection APIs; splitting them is unrelated to visual migration and would change module ownership without improving this task.

## Browser evidence

Screenshots are generated under `apps/control-room/.fullmag/reports/inspector-2-browser/`:

- `visualization-overview-light-360.png`
- `visualization-overview-dark-360.png`
- `visualization-overview-light-416.png`
- `visualization-overview-dark-416.png`
- `visualization-overview-light-560.png`
- `visualization-overview-dark-560.png`
- `visualization-overview-controls-light-416.png`
- `visualization-surface-coloring-light-416.png`
- `visualization-vectors-controls-light-416.png`
- `visualization-vectors-controls-dark-416.png`
- `visualization-overview-light-disabled-416.png`

Manual review confirmed:

- no horizontal overflow at 360 px;
- no segmented-label overflow after the `Shaded+` repair;
- readable labels and disabled states in both themes;
- stable compact action bar;
- no square outlined card grid;
- ordinary groups have no shadow;
- no Inspector image, canvas, thumbnail, snapshot, or preview request.

## Family migration inventory

| Family | Status |
|---|---|
| Visualization | complete |
| Object authoring and physics | complete |
| Mesh policy and mesh details | complete |
| Airbox | complete |
| Regions and inherited settings | complete |
| Study and all stage types | complete |
| Hysteresis | complete |
| Frequency-domain results and resources | complete |
| Visualization diagnostics | complete |
| Extensions, including topological charge | complete |

Static design-system contracts enumerate these families and reject reintroduction of `InspectorSection`, legacy Accordion composition, and obsolete Visualization control chrome.
