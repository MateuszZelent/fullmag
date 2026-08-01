# Inspector Design System Reference Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the Fullmag design-system foundation and prove it by rebuilding the Visualization Inspector without nested cards, visual cascade debt, or changes to canonical visualization behavior.

**Architecture:** Preserve the existing Inspector 2.0 shell, descriptor, selection, resource, and edit-session architecture. Add a Tailwind 4 bridge over canonical `--fm-*` tokens, move finite shared-control variants into application-owned shadcn/Radix/CVA primitives, introduce border-light Inspector composition primitives, and migrate only the Visualization Inspector as the reference slice. Stop at an explicit screenshot approval gate before migrating any other Inspector family.

**Tech Stack:** Next.js 16, React 19, TypeScript 5.8, Tailwind CSS 4, Radix Primitives, shadcn/ui ownership conventions, class-variance-authority, Catppuccin Mocha/Latte tokens, Vitest, Storybook 10, Playwright, React Doctor.

## Global Constraints

- Preserve all unrelated and pre-existing dirty-worktree changes.
- Do not change Python DSL, ProblemIR, planner, runtime, OpenAPI, resource, selection, or visualization persistence semantics.
- Keep Next.js at version 16 and React at version 19.
- Keep `apps/control-room/app/globals.css` import-only.
- Keep `--fm-*` tokens as the source of truth; raw Catppuccin values remain only in central theme/token files.
- Use Tailwind for local composition, CVA for finite variants, Radix for accessible behavior, and `fm-*` classes only for stable Fullmag geometry or domain contracts.
- Do not introduce Material UI, Chakra UI, Ant Design, Panda CSS, Vanilla Extract, styled-components, or Emotion.
- Do not add a preview image, canvas, viewport thumbnail, screenshot, or reserved preview area to Inspector.
- Preserve the four-row Inspector shell, 416 px default width, 360–560 px range, exact Visualization tabs, edit-session semantics, and dirty-selection guard.
- Keep Visualization in `liveViewport` mode and restore its exact sparse applied baseline on Reset.
- Keep diagnostics and inactive tabs demand-driven.
- Do not migrate a second Inspector family before the reference screenshot is explicitly approved.
- Every migrated component must delete the obsolete generic CSS it replaces; do not hide old rules beneath stronger overrides.
- All interactive controls must preserve visible focus, accessible names, keyboard operation, reduced-motion behavior, and readable disabled states.
- Every task must end with focused tests and a surgical commit containing only that task's files.

---

## File responsibility map

### New files

| File | Responsibility |
|---|---|
| `apps/control-room/src/design/styles/tailwind-theme.css` | Top-level `@theme inline` bridge from canonical `--fm-*` tokens to Tailwind utility namespaces |
| `apps/control-room/src/shared/ui/controlVariants.ts` | Shared CVA recipes for control size, density, tone, validation, and disabled geometry |
| `apps/control-room/src/shared/ui/SegmentedControl.tsx` | Accessible single-selection segmented control used by Render Mode |
| `apps/control-room/src/shared/ui/SegmentedControl.test.tsx` | Keyboard, selection, disabled, and class-variant coverage |
| `apps/control-room/src/modules/inspector/primitives/InspectorGroup.tsx` | Border-light Inspector group/disclosure composition |
| `apps/control-room/src/modules/inspector/primitives/InspectorPropertyRow.tsx` | Aligned label/control/value/unit layout |
| `apps/control-room/src/modules/inspector/primitives/InspectorMetricStrip.tsx` | Compact two- or four-metric summary strip |
| `apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx` | Semantic and structural tests for Inspector composition primitives |
| `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx` | Reference Overview composition only; no resource hooks or persistence logic |
| `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts` | Static ownership rules for token bridge, migrated components, and forbidden nested-card debt |
| `apps/control-room/.storybook/main.ts` | Storybook Next.js/Vite integration and story discovery |
| `apps/control-room/.storybook/preview.tsx` | Fullmag global styles, light/dark decorators, and viewport presets |
| `apps/control-room/src/shared/ui/SegmentedControl.stories.tsx` | Shared-control visual states |
| `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.stories.tsx` | Reference Inspector stories for themes, widths, states, and target kinds |
| `docs/reports/2026-07-17-inspector-design-system-reference-slice.md` | Execution evidence, selector deletion inventory, screenshots, gates, and approval status |

### Existing files modified by the reference slice

| File | Responsibility after modification |
|---|---|
| `apps/control-room/app/globals.css` | Imports Tailwind, the top-level theme bridge, token layers, primitives, modules, and no direct rules |
| `apps/control-room/src/design/styles/tokens.css` | Non-color semantic geometry, density, typography, elevation, and motion tokens |
| `apps/control-room/src/design/styles/theme.css` | Catppuccin Mocha/Latte semantic color values |
| `apps/control-room/src/shared/ui/Button.tsx` | CVA-backed shared button variants |
| `apps/control-room/src/shared/ui/Tabs.tsx` | Radix tabs with `line` and `segmented` presentations plus stable `data-slot` attributes |
| `apps/control-room/src/shared/ui/Select.tsx` | Radix select consuming shared control variants |
| `apps/control-room/src/modules/inspector/primitives/FormField.tsx` | Compatibility form API composed from shared control and property-row contracts |
| `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx` | Resource/controller ownership and tab routing; delegates Overview composition |
| `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx` | Domain controls composed with shared groups/rows; no generic card chrome |
| `apps/control-room/src/design/styles/inspector.css` | Inspector shell geometry and compatibility rules for unmigrated families |
| `apps/control-room/src/design/styles/inspector-visualization.css` | Visualization-only data layouts; no generic sections, controls, tabs, fields, or card styling |
| `apps/control-room/src/modules/inspector/inspectorCssContract.test.ts` | Existing global Inspector CSS safety rules extended with reference-slice ownership checks |
| `apps/control-room/scripts/smoke-inspector.mjs` | End-to-end widths, themes, structure, keyboard, live/reset, network, and screenshot proof |
| `apps/control-room/package.json` | Storybook scripts and development dependencies |

---

### Task 1: Freeze the reference contract with failing tests and evidence

**Files:**
- Create: `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorCssContract.test.ts`
- Create: `docs/reports/2026-07-17-inspector-design-system-reference-slice.md`
- Inspect: `apps/control-room/src/design/styles/*.css`
- Inspect: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Inspect: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`

**Interfaces:**
- Consumes: the accepted design at `docs/superpowers/specs/2026-07-17-inspector-design-system-reference-slice-design.md`.
- Produces: executable source-ownership rules and a baseline report used by every later task.

- [ ] **Step 1: Record the baseline inventory in the report**

Run:

```bash
wc -l apps/control-room/src/design/styles/*.css | sort -n
rg -n '^\.fm-inspector|^\.fm-tabs|^\.fm-accordion' apps/control-room/src/design/styles/*.css
rg -n '<InspectorSection' apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx
```

Write the measured totals, the exact nested section call sites, and the paths to the existing seven Inspector screenshots into the report. Mark the reference approval state as `pending`.

- [ ] **Step 2: Add the failing source contract**

Create the complete test:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const appRoot = join(import.meta.dirname, "../../..");
const read = (path: string) => readFileSync(join(appRoot, path), "utf8");

describe("Inspector design-system reference contract", () => {
  it("loads a top-level Tailwind bridge over Fullmag tokens", () => {
    const globals = read("app/globals.css");
    const bridge = read("src/design/styles/tailwind-theme.css");

    expect(globals).toContain('@import "../src/design/styles/tailwind-theme.css";');
    expect(bridge).toContain("@theme inline");
    expect(bridge).toContain("--color-fm-panel: var(--fm-bg-panel)");
    expect(bridge).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
  });

  it("keeps the reference overview free of nested card sections", () => {
    const overview = read(
      "src/modules/inspector/panels/ObjectVisualizationOverview.tsx",
    );

    expect(overview).toContain("InspectorGroup");
    expect(overview).toContain("InspectorMetricStrip");
    expect(overview).not.toContain("InspectorSection");
    expect(overview).not.toMatch(/<(?:img|canvas)\b/i);
  });

  it("keeps Visualization family CSS domain-specific", () => {
    const css = read("src/design/styles/inspector-visualization.css");

    expect(css).not.toMatch(
      /\.fm-(?:inspector-section|inspector-input|inspector-select|tabs-trigger|button)\b/,
    );
  });

  it("uses shared controls for the reference composition", () => {
    const targetSections = read(
      "src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx",
    );

    expect(targetSections).toContain("SegmentedControl");
    expect(targetSections).toContain("InspectorPropertyRow");
    expect(targetSections).not.toContain("fm-inspector-segmented");
  });
});
```

- [ ] **Step 3: Extend the existing CSS contract with anti-regression assertions**

Add assertions that migrated Visualization source cannot emit nested `.fm-inspector-section`, family CSS cannot define generic controls, and `tailwind-theme.css` cannot contain raw colors.

- [ ] **Step 4: Run focused tests and verify red state**

Run:

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/inspectorDesignSystemContract.test.ts \
  src/modules/inspector/inspectorCssContract.test.ts
```

Expected: the new contract fails because `tailwind-theme.css` and `ObjectVisualizationOverview.tsx` do not exist and Visualization still uses the old composition.

- [ ] **Step 5: Commit the red contract and baseline report**

```bash
git add \
  apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts \
  apps/control-room/src/modules/inspector/inspectorCssContract.test.ts \
  docs/reports/2026-07-17-inspector-design-system-reference-slice.md
git commit -m "test: lock inspector design system reference contract"
```

---

### Task 2: Bridge Fullmag tokens into Tailwind 4

**Files:**
- Create: `apps/control-room/src/design/styles/tailwind-theme.css`
- Modify: `apps/control-room/app/globals.css`
- Modify: `apps/control-room/src/design/styles/tokens.css`
- Modify: `apps/control-room/src/design/styles/theme.css`
- Test: `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts`
- Test: `apps/control-room/src/design/styles/designStyles.test.ts`

**Interfaces:**
- Consumes: canonical `--fm-*` semantic tokens.
- Produces: Tailwind utilities such as `bg-fm-panel`, `text-fm-primary`, `border-fm-subtle`, `h-fm-control-sm`, `rounded-fm-control`, and `shadow-fm-overlay` without duplicating color values.

- [ ] **Step 1: Add missing semantic geometry and state tokens**

Add these non-color tokens to `tokens.css`:

```css
:root {
  --fm-control-height-sm: 32px;
  --fm-control-height-md: 36px;
  --fm-field-row-min-height: 36px;
  --fm-radius-control: 6px;
  --fm-radius-surface: 8px;
  --fm-font-size-field-label: 12px;
  --fm-font-size-control: 12px;
  --fm-font-size-help: 11px;
  --fm-line-height-control: 1.35;
  --fm-disabled-opacity: 1;
}
```

Add semantic disabled tokens to both light and dark theme blocks in `theme.css` by aliasing existing Catppuccin-backed surface, border, and text tokens. Do not add new raw palette values outside those central blocks.

Use the same semantic aliases in both theme blocks so disabled controls keep full text rendering while their surface, border, and label communicate the state:

```css
--fm-bg-disabled: var(--fm-bg-muted);
--fm-border-disabled: var(--fm-border-muted);
--fm-text-disabled: var(--fm-text-muted);
```

- [ ] **Step 2: Create the Tailwind bridge**

Create:

```css
@theme inline {
  --color-fm-app: var(--fm-bg-app);
  --color-fm-chrome: var(--fm-bg-chrome);
  --color-fm-panel: var(--fm-bg-panel);
  --color-fm-raised: var(--fm-bg-panel-raised);
  --color-fm-canvas: var(--fm-bg-canvas);
  --color-fm-overlay: var(--fm-bg-overlay);
  --color-fm-selected: var(--fm-bg-selected);
  --color-fm-disabled: var(--fm-bg-disabled);
  --color-fm-disabled-border: var(--fm-border-disabled);
  --color-fm-primary: var(--fm-text-primary);
  --color-fm-secondary: var(--fm-text-secondary);
  --color-fm-muted: var(--fm-text-muted);
  --color-fm-disabled-text: var(--fm-text-disabled);
  --color-fm-subtle: var(--fm-border-subtle);
  --color-fm-border: var(--fm-border-default);
  --color-fm-strong: var(--fm-border-strong);
  --color-fm-accent: var(--fm-accent);
  --color-fm-accent-soft: var(--fm-accent-soft);
  --color-fm-success: var(--fm-success);
  --color-fm-warning: var(--fm-warning);
  --color-fm-danger: var(--fm-danger);
  --color-fm-stale: var(--fm-stale);
  --color-fm-degraded: var(--fm-degraded);
  --spacing-fm-control-sm: var(--fm-control-height-sm);
  --spacing-fm-control-md: var(--fm-control-height-md);
  --radius-fm-control: var(--fm-radius-control);
  --radius-fm-surface: var(--fm-radius-surface);
  --shadow-fm-overlay: var(--fm-shadow-elevated);
  --font-fm-ui: var(--fm-font-ui);
  --font-fm-mono: var(--fm-font-mono);
  --text-fm-label: var(--fm-font-size-field-label);
  --text-fm-control: var(--fm-font-size-control);
  --text-fm-help: var(--fm-font-size-help);
}
```

- [ ] **Step 3: Import the bridge at top level**

Place the import directly after Tailwind and before layered application styles:

```css
@import "tailwindcss";
@import "../src/design/styles/tailwind-theme.css";
@import "../src/design/styles/tokens.css" layer(fm-tokens);
@import "../src/design/styles/theme.css" layer(fm-tokens);
```

Keep the remainder of `globals.css` import-only and in its existing order.

- [ ] **Step 4: Run token and design-style tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/inspectorDesignSystemContract.test.ts \
  src/design/styles/designStyles.test.ts
```

Expected: the token bridge assertions pass; reference-component assertions remain red.

- [ ] **Step 5: Run a production CSS build smoke**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room build:webpack
```

Expected: Tailwind recognizes every mapped namespace and the Next.js production build succeeds.

- [ ] **Step 6: Commit the token bridge**

```bash
git add \
  apps/control-room/app/globals.css \
  apps/control-room/src/design/styles/tailwind-theme.css \
  apps/control-room/src/design/styles/tokens.css \
  apps/control-room/src/design/styles/theme.css \
  apps/control-room/src/design/styles/designStyles.test.ts
git commit -m "refactor: bridge Fullmag tokens into Tailwind"
```

---

### Task 3: Establish shared control variants and SegmentedControl

**Files:**
- Create: `apps/control-room/src/shared/ui/controlVariants.ts`
- Create: `apps/control-room/src/shared/ui/SegmentedControl.tsx`
- Create: `apps/control-room/src/shared/ui/SegmentedControl.test.tsx`
- Modify: `apps/control-room/src/shared/ui/Button.tsx`
- Modify: `apps/control-room/src/shared/ui/Tabs.tsx`
- Modify: `apps/control-room/src/shared/ui/Select.tsx`
- Test: `apps/control-room/src/shared/ui/Button.test.tsx`

**Interfaces:**
- Produces: `controlVariants`, `controlTextVariants`, `SegmentedControlOption<T>`, and `SegmentedControl<T>`.
- Consumes: Tailwind token utilities from Task 2 and existing `cn` helper.

- [ ] **Step 1: Write SegmentedControl behavior tests**

Cover all of these cases:

```tsx
it("selects an enabled option and exposes radiogroup semantics", async () => {
  const onValueChange = vi.fn();
  render(
    <SegmentedControl
      aria-label="Render mode"
      options={[
        { label: "Shaded", value: "shaded" },
        { label: "Wire", value: "wire" },
      ]}
      value="shaded"
      onValueChange={onValueChange}
    />,
  );

  await userEvent.click(screen.getByRole("radio", { name: "Wire" }));
  expect(onValueChange).toHaveBeenCalledWith("wire");
  expect(screen.getByRole("radiogroup", { name: "Render mode" })).toBeVisible();
});

it("does not select a disabled option", async () => {
  const onValueChange = vi.fn();
  render(
    <SegmentedControl
      aria-label="Render mode"
      options={[{ disabled: true, label: "Points", value: "points" }]}
      value="wire"
      onValueChange={onValueChange}
    />,
  );

  await userEvent.click(screen.getByRole("radio", { name: "Points" }));
  expect(onValueChange).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Verify the focused test fails**

```bash
pnpm --dir apps/control-room exec vitest run src/shared/ui/SegmentedControl.test.tsx
```

Expected: FAIL because `SegmentedControl` does not exist.

- [ ] **Step 3: Implement shared CVA recipes**

Create `controlVariants.ts` with one complete finite recipe:

```ts
import { cva } from "class-variance-authority";

export const controlVariants = cva(
  [
    "inline-flex min-w-0 items-center rounded-fm-control border",
    "border-fm-subtle bg-fm-canvas text-fm-primary",
    "font-fm-ui text-fm-control outline-none",
    "transition-[background-color,border-color,color,box-shadow] duration-150",
    "hover:border-fm-border focus-visible:ring-2 focus-visible:ring-fm-accent",
    "disabled:cursor-not-allowed disabled:border-fm-subtle",
    "disabled:bg-fm-disabled disabled:text-fm-disabled-text",
  ],
  {
    variants: {
      density: {
        compact: "h-fm-control-sm gap-2 px-2",
        regular: "h-fm-control-md gap-2 px-3",
      },
      invalid: {
        false: "",
        true: "border-fm-danger focus-visible:ring-fm-danger",
      },
    },
    defaultVariants: {
      density: "compact",
      invalid: false,
    },
  },
);
```

- [ ] **Step 4: Implement SegmentedControl**

Use a native radiogroup contract with roving browser focus through radio inputs or Radix Toggle Group if added explicitly. The public API is:

```ts
export interface SegmentedControlOption<T extends string> {
  disabled?: boolean;
  label: string;
  value: T;
}

export interface SegmentedControlProps<T extends string> {
  "aria-label": string;
  disabled?: boolean;
  options: readonly SegmentedControlOption<T>[];
  value: T;
  onValueChange: (value: T) => void;
}
```

Render one `role="radiogroup"`, one keyboard-focusable `role="radio"` per option, `aria-checked`, disabled semantics, and token-backed active/focus/hover states. Add `data-slot="segmented-control"` and `data-slot="segmented-control-item"`.

- [ ] **Step 5: Normalize Button, Tabs, and Select ownership**

Keep their existing public APIs. Add stable `data-slot` attributes, move finite size/presentation variants into CVA, and replace generic appearance classes with token-backed Tailwind utilities. Preserve existing `fm-*` classes only where tests or non-migrated consumers still require compatibility.

Add `presentation?: "line" | "segmented"` to `TabsList`; default to `line`. Do not change selection state ownership or Radix behavior.

- [ ] **Step 6: Run shared primitive tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/shared/ui/Button.test.tsx \
  src/shared/ui/SegmentedControl.test.tsx \
  src/shared/ui/ThemeSwitcher.test.tsx
```

Expected: all focused shared-control tests pass.

- [ ] **Step 7: Run accessibility-focused lint and typecheck**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Expected: zero errors and zero warnings.

- [ ] **Step 8: Commit shared control primitives**

```bash
git add \
  apps/control-room/src/shared/ui/controlVariants.ts \
  apps/control-room/src/shared/ui/SegmentedControl.tsx \
  apps/control-room/src/shared/ui/SegmentedControl.test.tsx \
  apps/control-room/src/shared/ui/Button.tsx \
  apps/control-room/src/shared/ui/Button.test.tsx \
  apps/control-room/src/shared/ui/Tabs.tsx \
  apps/control-room/src/shared/ui/Select.tsx
git commit -m "refactor: establish shared control variants"
```

---

### Task 4: Add border-light Inspector composition primitives

**Files:**
- Create: `apps/control-room/src/modules/inspector/primitives/InspectorGroup.tsx`
- Create: `apps/control-room/src/modules/inspector/primitives/InspectorPropertyRow.tsx`
- Create: `apps/control-room/src/modules/inspector/primitives/InspectorMetricStrip.tsx`
- Create: `apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/FormField.tsx`
- Modify: `apps/control-room/src/modules/inspector/primitives/InspectorSection.tsx`

**Interfaces:**
- Produces: `InspectorGroup`, `InspectorPropertyRow`, `InspectorPropertyGrid`, `InspectorMetricStrip`, and `InspectorMetric`.
- Consumes: shared controls from Task 3.
- Compatibility: `InspectorSection` remains available for unmigrated panels during the gated rollout.

- [ ] **Step 1: Write structural and accessibility tests**

Tests must assert:

- a static group renders a semantic section and heading;
- a collapsible group exposes one button with `aria-expanded`;
- a group body does not emit another card surface;
- a property row associates label and control;
- metric strips render two or four metrics without interactive-card semantics;
- group headers and values remain keyboard reachable in visual order.

Use this explicit nested-card regression assertion:

```tsx
const { container } = render(
  <InspectorGroup title="Display">
    <InspectorPropertyGrid>
      <InspectorPropertyRow label="Quantity source">
        <button type="button">m</button>
      </InspectorPropertyRow>
    </InspectorPropertyGrid>
  </InspectorGroup>,
);

expect(container.querySelectorAll("[data-slot='inspector-group']")).toHaveLength(1);
expect(container.querySelector(".fm-inspector-section")).toBeNull();
```

- [ ] **Step 2: Verify tests fail before implementation**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/primitives/InspectorComposition.test.tsx
```

Expected: FAIL because the new primitives do not exist.

- [ ] **Step 3: Implement InspectorGroup**

Use a semantic `<section>` for static groups. Use a native heading button or shared Radix Accordion composition for disclosure groups. Required DOM contract:

```tsx
<section data-slot="inspector-group" data-collapsible={collapsible || undefined}>
  <header data-slot="inspector-group-header">
    <div data-slot="inspector-group-heading">
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
    </div>
    {badge ? <Badge variant="secondary">{badge}</Badge> : null}
  </header>
  <div data-slot="inspector-group-content">{children}</div>
</section>
```

The implementation uses spacing and a bottom separator. It does not add a raised background, box shadow, or enclosing border.

- [ ] **Step 4: Implement property and metric primitives**

`InspectorPropertyRow` accepts:

```ts
interface InspectorPropertyRowProps {
  children: ReactNode;
  description?: string;
  label: string;
  unit?: string;
}
```

It renders a minimum 36 px two-column row, a 12 px label, an optional wrapping description, a control/value region, and an optional unit. Numeric values use tabular figures.

`InspectorMetricStrip` accepts exactly two or four `InspectorMetric` entries and uses a responsive two-column grid at 360 px and four columns only when content width permits.

- [ ] **Step 5: Recompose FormField without changing its public API**

Make `FormField` delegate label/control/description geometry to `InspectorPropertyRow`. Keep text, number, textarea, select, and checkbox discriminated unions unchanged. Keep existing class names only as compatibility hooks for unmigrated domain panels; new appearance comes from shared control variants.

- [ ] **Step 6: Correct InspectorSection compatibility documentation**

Document that `InspectorSection` is a compatibility surface for unmigrated families and cannot be nested in migrated panels. Do not remove it in the reference phase.

- [ ] **Step 7: Run composition and existing panel tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/primitives/InspectorComposition.test.tsx \
  src/modules/inspector/panels/ObjectMaterialPanel.test.tsx \
  src/modules/inspector/panels/ObjectMeshPolicyPanel.test.tsx
```

Expected: new composition tests and compatibility consumers pass.

- [ ] **Step 8: Commit Inspector composition primitives**

```bash
git add \
  apps/control-room/src/modules/inspector/primitives/InspectorGroup.tsx \
  apps/control-room/src/modules/inspector/primitives/InspectorPropertyRow.tsx \
  apps/control-room/src/modules/inspector/primitives/InspectorMetricStrip.tsx \
  apps/control-room/src/modules/inspector/primitives/InspectorComposition.test.tsx \
  apps/control-room/src/modules/inspector/primitives/FormField.tsx \
  apps/control-room/src/modules/inspector/primitives/InspectorSection.tsx
git commit -m "refactor: add inspector composition primitives"
```

---

### Task 5: Build the Visualization Overview reference composition

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`

**Interfaces:**
- Consumes: existing resolved panel state and callbacks from `useObjectVisualizationPanelState`; shared controls from Task 3; composition primitives from Task 4.
- Produces: `ObjectVisualizationOverview`, a pure composition component with no resource hooks and no persistence calls.
- Preserves: `liveViewport` edits, exact sparse baseline Reset, child-region propagation, field-catalog demand loading, and existing tab IDs.

- [ ] **Step 1: Write the reference component tests**

Tests must cover:

- exact metric labels: Display Passes, Quantity Source, Mesh Readiness, Data State;
- one top-level `Display` group;
- Render Mode uses `SegmentedControl`;
- Quantity Source uses a shared field/select control;
- Surface Coloring and Vectors use disclosure groups;
- Clipping, Camera, and Advanced default closed;
- no `InspectorSection` or `.fm-inspector-section` output;
- no `img` or `canvas` output;
- disabled quantity remains readable;
- inherited region state exposes source information without creating an editable override;
- 360 px markup contains no fixed content width.

- [ ] **Step 2: Verify reference tests fail**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx \
  src/modules/inspector/inspectorDesignSystemContract.test.ts
```

Expected: FAIL because the reference component does not exist and old section composition remains.

- [ ] **Step 3: Define a pure props boundary**

The reference component receives resolved values and callbacks only. Use an explicit interface containing:

```ts
export interface ObjectVisualizationOverviewProps {
  dataState: string;
  displayPassCount: number;
  meshReadiness: "ready" | "degraded" | "not-required";
  quantitySource: string;
  renderMode: VisualizationTargetSettings["renderMode"];
  renderModeOptions: readonly SegmentedControlOption<
    VisualizationTargetSettings["renderMode"]
  >[];
  quantityDisabled: boolean;
  onRenderModeChange: (
    value: VisualizationTargetSettings["renderMode"],
  ) => void;
  surfaceColoring: ReactNode;
  vectors: ReactNode;
  wireframe?: ReactNode;
  points?: ReactNode;
  clipping: ReactNode;
  camera: ReactNode;
  advanced: ReactNode;
}
```

Do not pass the kernel, API client, controller, resource facade, or raw session status into the pure component.

- [ ] **Step 4: Implement the exact Overview order**

Compose:

```tsx
<div data-slot="object-visualization-overview" className="grid min-w-0 gap-4">
  <InspectorMetricStrip metrics={metrics} />
  <InspectorGroup title="Display">
    <InspectorPropertyGrid>
      <InspectorPropertyRow label="Render mode">
        <SegmentedControl
          aria-label="Render mode"
          options={renderModeOptions}
          value={renderMode}
          onValueChange={onRenderModeChange}
        />
      </InspectorPropertyRow>
      <InspectorPropertyRow label="Quantity source">
        {quantityControl}
      </InspectorPropertyRow>
    </InspectorPropertyGrid>
  </InspectorGroup>
  {surfaceColoring}
  {vectors}
  {wireframe}
  {points}
  {clipping}
  {camera}
  {advanced}
</div>
```

The real implementation builds `metrics` and `quantityControl` from typed props. Do not introduce local copies of resource or persistence state.

- [ ] **Step 5: Convert Visualization domain sections to plain groups**

In `ObjectVisualizationTargetSection.tsx`:

- replace the Render Mode section wrapper with one property row using `SegmentedControl`;
- replace Quantity Source with one property row using the shared Select or compatibility FormField composition;
- replace Surface Coloring, Vectors, Wireframe, Points, Geometry Scope, Opacity, and Overrides wrappers with `InspectorGroup`;
- retain every existing capability check, disabled reason, unit label, patch callback, field-catalog trigger, and child-region behavior;
- preserve all existing exported section function names used by tests or other panels.

- [ ] **Step 6: Route only the Overview tab through the reference component**

Keep Properties, Display, and Diagnostics on their existing composition in this phase. Replace the Overview `TabsContent` body with `ObjectVisualizationOverview` and pass existing resolved data and callbacks. Do not change `useRegisterInspectorEditSession` or the exact applied-baseline implementation.

- [ ] **Step 7: Run Visualization behavior, accessibility, and performance tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts \
  src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts \
  src/modules/inspector/inspectorDesignSystemContract.test.ts
```

Expected: all reference, behavior, accessibility, performance, baseline-reset, and source-ownership tests pass.

- [ ] **Step 8: Commit the pure reference composition**

```bash
git add \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts
git commit -m "refactor: rebuild visualization inspector overview"
```

---

### Task 6: Remove obsolete Visualization and generic Inspector CSS

**Files:**
- Modify: `apps/control-room/src/design/styles/inspector.css`
- Modify: `apps/control-room/src/design/styles/inspector-visualization.css`
- Modify: `apps/control-room/src/design/styles/tabs.css`
- Modify: `apps/control-room/src/design/styles/accordion.css`
- Modify: `apps/control-room/src/design/styles/primitives.css`
- Modify: `apps/control-room/src/modules/inspector/inspectorCssContract.test.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts`
- Modify: `docs/reports/2026-07-17-inspector-design-system-reference-slice.md`

**Interfaces:**
- Consumes: migrated component ownership from Tasks 3–5.
- Produces: one reachable selector per retained compatibility contract and no generic control styling in Visualization family CSS.

- [ ] **Step 1: Generate a before-deletion selector inventory**

```bash
rg -o '\.fm-[A-Za-z0-9_-]+' \
  apps/control-room/src/design/styles/inspector.css \
  apps/control-room/src/design/styles/inspector-visualization.css \
  apps/control-room/src/design/styles/tabs.css \
  apps/control-room/src/design/styles/accordion.css \
  apps/control-room/src/design/styles/primitives.css \
  | sort -u > /tmp/inspector-reference-selectors-before.txt
```

Record the count and classify selectors in the report as shell, shared primitive, compatibility, Visualization domain, or unreachable.

- [ ] **Step 2: Delete migrated generic rules from family CSS**

Remove Visualization-owned copies of:

- section/card border, radius, background, and shadow;
- section title typography;
- generic input/select/checkbox appearance;
- tabs and segmented-control chrome;
- generic field label/value geometry;
- disabled opacity and focus-ring rules;
- spacing rules now owned by composition primitives.

Retain only genuine Visualization layouts such as vector budget, mesh-part lists, color-scale rows, and specialized numeric grids.

- [ ] **Step 3: Reduce global compatibility rules surgically**

Use source reachability before deleting a rule from `inspector.css`, `tabs.css`, `accordion.css`, or `primitives.css`. Unmigrated panels may continue to consume compatibility rules. Do not restyle those panels during this task.

- [ ] **Step 4: Prohibit cascade reintroduction**

Extend contract tests so `inspector-visualization.css` cannot define generic section/control selectors and `ObjectVisualizationOverview.tsx` cannot emit compatibility classes. Assert that every retained family selector is reachable from Visualization source.

- [ ] **Step 5: Run CSS and component contracts**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/inspector/inspectorCssContract.test.ts \
  src/modules/inspector/inspectorDesignSystemContract.test.ts \
  src/design/styles/designStyles.test.ts
pnpm --dir apps/control-room lint
```

Expected: zero failures and zero warnings.

- [ ] **Step 6: Generate the after-deletion inventory and update the report**

Run the same selector command into `/tmp/inspector-reference-selectors-after.txt`, compare both files, and record every deleted selector plus its replacement owner. Do not claim success from line-count reduction alone.

- [ ] **Step 7: Commit CSS ownership cleanup**

```bash
git add \
  apps/control-room/src/design/styles/inspector.css \
  apps/control-room/src/design/styles/inspector-visualization.css \
  apps/control-room/src/design/styles/tabs.css \
  apps/control-room/src/design/styles/accordion.css \
  apps/control-room/src/design/styles/primitives.css \
  apps/control-room/src/modules/inspector/inspectorCssContract.test.ts \
  apps/control-room/src/modules/inspector/inspectorDesignSystemContract.test.ts \
  docs/reports/2026-07-17-inspector-design-system-reference-slice.md
git commit -m "refactor: remove visualization inspector style debt"
```

---

### Task 7: Add Storybook as the isolated design-system workshop

**Files:**
- Create: `apps/control-room/.storybook/main.ts`
- Create: `apps/control-room/.storybook/preview.tsx`
- Create: `apps/control-room/src/shared/ui/SegmentedControl.stories.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.stories.tsx`
- Modify: `apps/control-room/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: shared primitives and pure reference component.
- Produces: `pnpm --dir apps/control-room storybook` and `pnpm --dir apps/control-room build:storybook`.
- Runtime boundary: no Storybook package enters the production dependency set or application bundle.

- [ ] **Step 1: Add pinned development dependencies and scripts**

Install one Storybook 10.5 minor across the CLI, framework adapter, and accessibility addon. Keep every package under `devDependencies`, not `dependencies`:

```bash
pnpm --dir apps/control-room add --save-dev \
  storybook@^10.5.0 \
  @storybook/nextjs-vite@^10.5.0 \
  @storybook/addon-a11y@^10.5.0
```

Add the scripts without replacing existing scripts:

```json
{
  "scripts": {
    "storybook": "storybook dev -p 6006",
    "build:storybook": "storybook build"
  }
}
```

- [ ] **Step 2: Configure story discovery and aliases**

Use the official Next.js/Vite adapter. It reads the application's Next.js and TypeScript configuration, including the existing `@/*` alias, so do not duplicate that alias in a custom `viteFinal` hook:

```ts
import type { StorybookConfig } from "@storybook/nextjs-vite";

const config: StorybookConfig = {
  stories: ["../src/**/*.stories.tsx"],
  addons: ["@storybook/addon-a11y"],
  framework: {
    name: "@storybook/nextjs-vite",
    options: {},
  },
};

export default config;
```

If `build:storybook` later proves that an application alias is unresolved, diagnose that concrete import and add the smallest `viteFinal` mapping for it. Do not add speculative alias configuration before the build fails.

- [ ] **Step 3: Configure Fullmag theme decorators**

`preview.tsx` imports `app/globals.css`, exposes a Light/Dark toolbar control, applies `data-theme` to the story root, and defines 360, 416, and 560 px viewport presets. It must not mock network data globally:

```tsx
import type { Preview } from "@storybook/nextjs-vite";
import "../app/globals.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Fullmag color theme",
      toolbar: {
        icon: "paintbrush",
        items: [
          { value: "light", title: "Light" },
          { value: "dark", title: "Dark" },
        ],
      },
    },
  },
  initialGlobals: {
    theme: "light",
  },
  decorators: [
    (Story, context) => (
      <div
        data-theme={context.globals.theme}
        style={{
          minHeight: "100vh",
          background: "var(--fm-bg-app)",
          color: "var(--fm-text-primary)",
        }}
      >
        <Story />
      </div>
    ),
  ],
  parameters: {
    viewport: {
      options: {
        inspector360: {
          name: "Inspector 360",
          styles: { width: "360px", height: "900px" },
        },
        inspector416: {
          name: "Inspector 416",
          styles: { width: "416px", height: "900px" },
        },
        inspector560: {
          name: "Inspector 560",
          styles: { width: "560px", height: "900px" },
        },
      },
    },
  },
};

export default preview;
```

- [ ] **Step 4: Add shared-control stories**

Create stories for normal, selected, disabled, mixed-disabled, long-label, light, and dark SegmentedControl states.

- [ ] **Step 5: Add reference Overview stories**

Create pure-prop stories for:

- airbox normal;
- airbox with disabled quantity;
- object with surface coloring;
- inherited region;
- degraded mesh;
- running/locked controls;
- long scientific labels;
- all three accepted widths in both themes.

Every story uses deterministic props and actions. It does not mount the kernel or make HTTP/WebSocket requests.

- [ ] **Step 6: Build Storybook**

```bash
pnpm --dir apps/control-room build:storybook
```

Expected: static Storybook build completes with zero missing-token, alias, or accessibility configuration errors.

- [ ] **Step 7: Commit the design-system workshop**

```bash
git add \
  apps/control-room/.storybook/main.ts \
  apps/control-room/.storybook/preview.tsx \
  apps/control-room/src/shared/ui/SegmentedControl.stories.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationOverview.stories.tsx \
  apps/control-room/package.json \
  pnpm-lock.yaml
git commit -m "chore: add inspector design system workshop"
```

---

### Task 8: Extend browser proof for visual and interaction acceptance

**Files:**
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`
- Modify: `apps/control-room/package.json` only if the existing smoke command changes
- Modify: `docs/reports/2026-07-17-inspector-design-system-reference-slice.md`

**Interfaces:**
- Consumes: the live Control Room workspace and reference Visualization Inspector.
- Produces: deterministic screenshots and JSON proof for width, theme, structure, interaction, and network constraints.

- [ ] **Step 1: Add structural browser assertions**

Assert in the live Inspector Overview:

- exactly one `[data-slot='object-visualization-overview']`;
- exactly one Display group;
- no `.fm-inspector-section .fm-inspector-section` nesting;
- no horizontal overflow;
- no `img` or `canvas` inside Inspector;
- no thumbnail, screenshot, snapshot, or preview request caused by Inspector;
- content scroll does not move header, tabs, or action bar.

- [ ] **Step 2: Add visual-geometry assertions**

Use `getComputedStyle` and bounding boxes to assert:

- primary field labels are at least 12 px;
- interactive controls are at least 32 px high;
- disabled text has non-transparent color and no whole-control opacity below 0.7;
- group spacing is at least 12 px;
- the Overview contains no ordinary group box shadow;
- the segmented control fits within 360 px without clipping.

- [ ] **Step 3: Add theme and width screenshots**

Capture deterministic files:

```text
visualization-overview-light-360.png
visualization-overview-light-416.png
visualization-overview-light-560.png
visualization-overview-dark-360.png
visualization-overview-dark-416.png
visualization-overview-dark-560.png
visualization-overview-light-disabled-416.png
visualization-overview-dark-degraded-416.png
```

- [ ] **Step 4: Exercise keyboard and live/reset behavior**

Use keyboard navigation to move through tabs, Render Mode, Quantity Source, Surface Coloring disclosure, Vectors disclosure, Reset, and Focus. Change a live display value, verify Reset enables, activate Reset, and verify the exact initial sparse override and viewport preference state returns.

- [ ] **Step 5: Run browser smoke**

```bash
pnpm --dir apps/control-room smoke:inspector
```

Expected JSON includes zero console errors, zero preview requests, all eight required screenshots, widths `[360, 416, 560]`, themes `["light", "dark"]`, and `visualizationReset: "verified"`.

- [ ] **Step 6: Inspect every screenshot manually**

Record in the report:

- surface hierarchy;
- text readability;
- control alignment;
- disabled readability;
- light/dark parity;
- 360 px wrapping;
- absence of nested cards;
- any remaining visual issue with its exact selector/component owner.

- [ ] **Step 7: Commit the browser acceptance proof**

```bash
git add \
  apps/control-room/scripts/smoke-inspector.mjs \
  apps/control-room/package.json \
  docs/reports/2026-07-17-inspector-design-system-reference-slice.md
git commit -m "test: add inspector reference visual proof"
```

---

### Task 9: Run final gates and stop at the reference approval checkpoint

**Files:**
- Modify: `docs/reports/2026-07-17-inspector-design-system-reference-slice.md`
- Inspect: complete branch diff
- Do not modify: other Inspector family panels during this task

**Interfaces:**
- Consumes: all reference-slice tasks.
- Produces: a factual go/no-go packet for user visual approval.

- [ ] **Step 1: Run focused reference tests**

```bash
pnpm --dir apps/control-room exec vitest run \
  src/shared/ui/SegmentedControl.test.tsx \
  src/modules/inspector/primitives/InspectorComposition.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationOverview.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx \
  src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts \
  src/modules/inspector/inspectorCssContract.test.ts \
  src/modules/inspector/inspectorDesignSystemContract.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 2: Run full frontend gates**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room build:storybook
```

Expected: zero TypeScript errors, zero ESLint warnings, zero Vitest failures, and a successful Storybook build.

- [ ] **Step 3: Run React Doctor**

```bash
cd apps/control-room
npx -y react-doctor@latest . --verbose --scope changed
```

Expected: no issue attributable to the reference slice and no score regression against the pre-task baseline.

- [ ] **Step 4: Run final live browser proof**

```bash
pnpm --dir apps/control-room smoke:inspector
```

Expected: zero console errors, zero preview requests, all structural/interaction checks green, and all required screenshots present.

- [ ] **Step 5: Inspect worktree integrity**

Run as separate commands:

```bash
git diff --check
git diff --cached --name-only
git status --short
git diff --stat
```

Confirm unrelated changes, especially example simulation scripts, remain untouched by the reference-slice commits.

- [ ] **Step 6: Complete the report**

Record:

- exact commands and outputs;
- before/after selector ownership inventory;
- before/after CSS line counts as secondary evidence;
- Storybook story list;
- screenshot paths;
- accessibility and keyboard results;
- live/reset semantic results;
- known issues with severity and owner;
- recommendation: approve, revise, or reject.

The approval field remains `pending user review` even when all automated gates pass.

- [ ] **Step 7: Commit final evidence**

```bash
git add docs/reports/2026-07-17-inspector-design-system-reference-slice.md
git commit -m "docs: report inspector reference slice evidence"
```

- [ ] **Step 8: Stop before broader migration**

Present the light and dark 416 px screenshots plus narrow/wide comparisons to the user. Do not begin object, mesh, region, Study, result, or analysis migration until the user explicitly approves the reference appearance.

---

## Reference gate exit criteria

The phase is complete only when:

- all nine tasks are checked;
- the Visualization Overview no longer renders nested cards;
- shared controls own their visual variants;
- the Tailwind bridge references canonical Fullmag tokens without duplicating palette values;
- obsolete Visualization generic CSS is deleted;
- exact sparse Reset semantics remain tested and working;
- Storybook and live browser proofs pass in both themes and all accepted widths;
- full frontend gates and React Doctor pass;
- the user has reviewed the screenshots.

If the user requests visual revisions, update the reference primitives and repeat Tasks 6–9. If the user approves, create separate rollout plans in the order listed in the accepted design document; do not append the entire migration to this plan.
