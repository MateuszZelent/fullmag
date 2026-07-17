# Inspector Design System Reference Slice Report

**Date:** 2026-07-17  
**Branch:** `codex/inspector-2-refactor`  
**Reference surface:** Visualization Inspector, Overview tab  
**User approval:** pending

## Baseline

The pre-refactor frontend baseline is green:

```text
pnpm --dir apps/control-room test
Test Files  362 passed (362)
Tests       3506 passed (3506)
```

The design-style inventory before the reference slice contains 10,708 CSS lines. The largest Inspector-related files are:

| File | Lines |
|---|---:|
| `src/design/styles/inspector.css` | 986 |
| `src/design/styles/inspector-mesh.css` | 562 |
| `src/design/styles/inspector-frequency-domain.css` | 477 |
| `src/design/styles/inspector-visualization.css` | 271 |
| `src/design/styles/inspector-study.css` | 261 |

The reference source starts with nested compatibility sections at these exact call sites:

| Source | Lines | Baseline role |
|---|---:|---|
| `ObjectVisualizationPanel.tsx` | 786–839 | `Display Settings` enclosing five child sections |
| `ObjectVisualizationPanel.tsx` | 841–857 | Clipping, Camera, and Advanced cards |
| `ObjectVisualizationTargetSection.tsx` | 152–302 | Display Passes card |
| `ObjectVisualizationTargetSection.tsx` | 318–327 | Render Mode card |
| `ObjectVisualizationTargetSection.tsx` | 385–469 | Surface Coloring card |
| `ObjectVisualizationTargetSection.tsx` | 642–664 | Quantity Source card |
| `ObjectVisualizationTargetSection.tsx` | 762–901 | Vectors card |

The seven existing Inspector 2.0 comparison screenshots are ignored runtime artifacts under `apps/control-room/.fullmag/reports/inspector-2-browser/`:

1. `inspector-360.png`
2. `inspector-416.png`
3. `inspector-560.png`
4. `visualization-overview-416.png`
5. `visualization-properties-416.png`
6. `visualization-display-416.png`
7. `visualization-diagnostics-416.png`

## Ownership inventory

| Area | Before | Reference owner | Status |
|---|---|---|---|
| Product color and state values | `theme.css` | `theme.css` plus token aliases | complete |
| Geometry and density values | `tokens.css` and component CSS | `tokens.css` | complete |
| Tailwind utility names | absent | `tailwind-theme.css` | complete |
| Shared control variants | mixed global CSS and component classes | shared CVA primitives | complete |
| Inspector group and row composition | `InspectorSection` card cascade | Inspector composition primitives | complete |
| Visualization Overview | nested panel sections | `ObjectVisualizationOverview` | complete |
| Visualization domain layout | `inspector-visualization.css` | domain-only selectors | complete |

## Selector deletion inventory

The five Inspector/shared CSS files retain 162 unique `fm-*` selectors after the reference migration. Source-reachability tests remain the deletion gate for global compatibility selectors used by unmigrated families.

| Deleted selector family | Replacement owner |
|---|---|
| `fm-inspector-summary-*` (six selectors) | `InspectorMetricStrip` local Tailwind composition |
| `fm-inspector-section__empty-copy` | local semantic help-text utilities in `ObjectVisualizationOverview` |
| `fm-inspector-checkbox-wrap` | `FormField` composed through `InspectorPropertyRow` |

`inspector-visualization.css` now contains only Visualization layouts (display toggles, color controls, vector/mesh-part controls, scientific ranges, and axis controls). It does not define generic Inspector sections, shared inputs/selects, buttons, tabs, or segmented-control chrome.

## Storybook evidence

`pnpm --dir apps/control-room build:storybook` completes successfully with Storybook 10.5.2 and the official Next.js/Vite adapter. The workshop contains isolated SegmentedControl states and deterministic Visualization Overview states without mounting the kernel or opening network connections.

## Browser and screenshot evidence

The live browser smoke produced these required screenshots under `apps/control-room/.fullmag/reports/inspector-2-browser/`:

- `visualization-overview-light-360.png`
- `visualization-overview-light-416.png`
- `visualization-overview-light-560.png`
- `visualization-overview-dark-360.png`
- `visualization-overview-dark-416.png`
- `visualization-overview-dark-560.png`
- `visualization-overview-light-disabled-416.png`
- `visualization-overview-dark-degraded-416.png`

An additional `visualization-overview-controls-light-416.png` records the scrolled Render Mode and Quantity Source geometry rather than hiding those controls below the fixed action bar.

Manual review findings after the second visual pass:

| Criterion | Evidence |
|---|---|
| Surface hierarchy | Four metrics use a border-light 2×2 strip; Display is the only initially expanded control group. |
| Text readability | Group headings are 13 px, field labels are at least 12 px, and live browser measurement rejects smaller labels. |
| Control alignment | Display passes use a stable three-column grid; Render Mode uses the full content width; Quantity Source has one label rather than a nested `Quantity source / Source` pair. |
| Disabled readability | Inputs keep opaque semantic text, border, and background tokens; browser proof requires opacity at least 0.7. |
| Light/dark parity | All accepted widths were captured in both themes with the same geometry. |
| 360 px wrapping | No horizontal overflow; the target metadata stacks, metrics remain 2×2, and segmented labels wrap inside their control. |
| Nested cards | No nested `.fm-inspector-section`; ordinary groups have computed `box-shadow: none`. |
| Remaining reference issue | The live runtime used for proof reports Mesh Readiness `Ready`; the deterministic degraded state remains isolated in the `DegradedMesh` Storybook story. |

## Verification log

| Gate | Result | Evidence |
|---|---|---|
| Pre-change full Vitest baseline | pass | 362 files, 3506 tests |
| Reference contract RED | pass | 4 expected failures: missing token bridge, missing Overview component, and legacy target controls |
| Focused component tests | pass | 72 files, 982 tests across Inspector and shared controls |
| TypeScript | pass | `typecheck`, zero errors after final callback stabilization |
| ESLint | pass | zero warnings with `--max-warnings=0` |
| Full Vitest | pass | 366 files, 3522 tests |
| Storybook build | pass | Storybook 10.5.2 static build |
| React Doctor | pass with reviewed warnings | score improved 76 → 84; zero errors, four stable React-setter false positives, six pre-existing mixed-export warnings |
| Inspector browser smoke | pass | 0 console errors, 0 preview requests, widths 360/416/560, light/dark, Reset verified |

## Known issues

Storybook isolation, browser screenshots, and the final full-suite gates remain outstanding. Broader Inspector families intentionally retain their compatibility styling until the reference slice is approved.

## Recommendation

Pending implementation and visual review. Broader Inspector migration is prohibited until the reference screenshots receive explicit user approval.
