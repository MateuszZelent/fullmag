# Inspector Design System and Reference Slice Design

**Status:** Accepted direction; implementation gated by the reference slice
**Date:** 2026-07-17
**Supersedes visually:** the card-heavy visual composition described in `2026-07-17-inspector-2-design.md`
**Preserves semantically:** the Inspector 2.0 shell, descriptors, edit sessions, selection guard, resource routing, and transaction behavior

## 1. Decision

Fullmag will not introduce Material UI, Chakra UI, Ant Design, Panda CSS, Vanilla Extract, or another competing component framework to repair the Inspector.

The Control Room already contains the correct foundation:

- Tailwind CSS 4 for composition and token-backed utilities;
- shadcn/ui ownership conventions for application-owned components;
- Radix Primitives for accessible interaction behavior;
- `class-variance-authority` for explicit component variants;
- Catppuccin Mocha/Latte semantic `--fm-*` tokens;
- Lucide for one coherent icon family.

The failure is not missing dependencies. The failure is that these tools are not yet operating as one design system. The current UI is still primarily styled through a large global BEM-like cascade, while Tailwind, CVA, and shared primitives cover only a small part of the component surface.

The approved direction is to build a small Fullmag Design System on the existing stack and prove it on one reference surface: the Visualization Inspector shown in the reported screenshot. Only after that reference slice passes visual review will the remaining Inspector families be migrated.

## 2. Current evidence

The live checkout contains approximately:

- 10,708 lines across `apps/control-room/src/design/styles/*.css`;
- 986 lines in `inspector.css`;
- 562 lines in `inspector-mesh.css`;
- 477 lines in `inspector-frequency-domain.css`;
- 271 lines in `inspector-visualization.css`;
- 178 Inspector, tabs, and accordion base selectors;
- only a small number of React sites using Tailwind layout utilities directly;
- CVA variants in `Button` and `Badge`, but not across the rest of the control vocabulary.

The screenshot exposes the structural result:

1. the Inspector surface contains a bordered `Display Settings` card;
2. that card contains additional bordered cards such as `Render Mode`, `Quantity Source`, `Surface Coloring`, and `Vectors`;
3. the nested levels use nearly identical backgrounds, one-pixel borders, radii, and spacing;
4. hierarchy therefore depends on repeated outlines rather than typography, alignment, whitespace, and controlled contrast;
5. 10–11 px labels and low-contrast disabled states make the panel look washed out;
6. one saturated blue segmented option competes with an otherwise pale surface;
7. domain panels still decide generic control appearance through family CSS.

This produces a paradoxical visual state: too many boxes but too little hierarchy.

## 3. Scope

### 3.1 Reference-slice scope

The first implementation phase covers:

- the token bridge between `--fm-*` and Tailwind 4 `@theme inline`;
- shared density, field, segmented-control, disclosure, select, tabs, and button variants needed by the reference slice;
- Inspector composition primitives for groups, property rows, summary metrics, and section separators;
- the Visualization Inspector `Overview` tab from the reported screenshot;
- exact light and dark theme states;
- enabled, disabled, invalid, dirty, live, stale, and running/locked examples;
- isolated component stories and browser screenshot baselines;
- removal of obsolete generic Visualization Inspector CSS after migration.

### 3.2 Deferred until reference approval

The following families remain unchanged until the reference slice is accepted:

- object general, geometry, material, texture, and interaction;
- object and airbox mesh;
- regions and inheritance views;
- Study stage authoring;
- hysteresis, frequency-domain, and topological-charge panels;
- result, job, resource, and diagnostics panels.

These are not abandoned. They become separate rollout plans using the approved reference primitives.

### 3.3 Non-goals

This work does not:

- change Python DSL, ProblemIR, planner, runtime, OpenAPI, or resource semantics;
- change canonical Inspector selection routing;
- replace `InspectorShell`, `InspectorDescriptor`, or edit-session behavior;
- add a preview image, thumbnail, screenshot, or canvas inside Inspector;
- change viewport rendering quality or solver behavior;
- create a second FDM/FEM Inspector tree;
- add decorative gradients, glassmorphism, oversized cards, or marketing UI.

## 4. Design-system architecture

### 4.1 Layer 1: semantic tokens

`--fm-*` remains the only source of product-specific visual values. Tokens are grouped by purpose rather than component:

- surface: app, chrome, panel, raised, canvas, overlay, selected;
- content: primary, secondary, muted, inverse;
- border: subtle, default, strong, focus;
- action: accent, accent-hover, accent-active, danger;
- state: success, warning, danger, stale, degraded;
- geometry: spacing, radius, control height, panel dimensions;
- typography: UI and mono families, sizes, line heights, weights;
- elevation and motion.

A new top-level Tailwind bridge maps these tokens to utility namespaces with `@theme inline`. It does not duplicate Catppuccin values. For example, `--color-fm-panel` references `--fm-bg-panel`; it does not contain a second color literal.

Raw Catppuccin colors remain legal only in the central theme/token files.

### 4.2 Layer 2: accessible shared controls

Interaction behavior stays in shared Radix/shadcn-style components under `src/shared/ui`.

The reference slice standardizes:

| Primitive | Required variants |
|---|---|
| `Button` | primary, secondary, ghost, danger; sm, md, icon; compact density |
| `Tabs` | line and segmented presentations; compact density |
| `Select` | sm and md; default, invalid, disabled |
| `SegmentedControl` | two to five options; single selection; disabled option support |
| `Field` | inline and stacked; label, control, unit, description, error |
| `Disclosure` | open/closed; optional badge; keyboard-operable |
| `Switch` | compact and regular |
| `Tooltip` | accessible explanation for icon and disabled actions |
| `Badge` / `StatusBadge` | neutral and semantic state variants |

CVA owns finite variants. Tailwind utilities own local layout and token-backed appearance. Raw component-specific colors and large global selector trees are forbidden.

Every primitive exposes `data-slot` and semantic state attributes so composition CSS and tests can address stable contracts without relying on descendant selector accidents.

### 4.3 Layer 3: Inspector composition primitives

Inspector-specific composition stays under `src/modules/inspector/primitives`:

- `InspectorGroup`: a logical section with optional disclosure behavior;
- `InspectorGroupHeader`: title, description, badge, and disclosure affordance;
- `InspectorPropertyGrid`: aligned label/control layout;
- `InspectorPropertyRow`: read-only or interactive property row;
- `InspectorMetricStrip`: compact two- or four-column status summary;
- `InspectorSeparator`: semantic separation without a card surface;
- `InspectorNotice`: validation, stale, degraded, and informational messages.

These components do not fetch data and do not know physics semantics. They only compose shared controls.

### 4.4 Layer 4: domain panels

Domain panels retain:

- resource hooks;
- model builders;
- canonical transaction calls;
- validation logic;
- units and scientific labels;
- capability and runtime locks.

Domain CSS may define layouts that are genuinely specific to the domain, such as a sinc waveform plot, mesh-quality table, frequency chart, vector budget grid, or anisotropy axis editor. It may not redefine generic inputs, selects, tabs, cards, section headers, labels, disabled opacity, focus rings, or action buttons.

## 5. Visual language

### 5.1 Surface hierarchy

The Inspector has at most two persistent surface levels:

1. the Inspector panel surface;
2. an interactive control or a truly raised transient surface.

Ordinary groups do not become cards. A group is expressed through a title, optional description, alignment, spacing, and a separator. Borders surround interactive controls, tables, menus, dialogs, or exceptional status regions—not every logical section.

Nested `.fm-inspector-section` containers are forbidden in migrated panels.

### 5.2 Typography

The compact scientific scale is:

| Role | Size | Weight | Notes |
|---|---:|---:|---|
| Inspector title | 15 px | 600 | one line |
| Group title | 12 px | 600 | normal case, no decorative tracking |
| Field label | 12 px | 500 | secondary content color |
| Control/value | 12–13 px | 400–500 | tabular figures for numbers |
| Metadata/status | 11 px | 500 | never used for primary editable labels |
| Help text | 11 px | 400 | wraps; sufficient contrast |

Ten-pixel text is reserved for exceptional compact badges, never form labels or scientific values.

### 5.3 Geometry

- compact controls: 32 px high;
- regular controls: 36 px high;
- field rows: minimum 36 px;
- horizontal field gap: 12 px;
- group gap: 16 px;
- internal control gap: 8 px;
- control radius: 6 px;
- transient-surface radius: 8 px;
- no 1–2 px spacing as layout rhythm;
- no shadow on ordinary Inspector groups;
- one-pixel borders use semantic border tokens.

### 5.4 States

Disabled controls remain legible. They use a disabled surface, muted border, and readable text rather than reducing the entire control to very low opacity.

Selection and focus are distinct:

- selected: stable accent-soft surface and accent content;
- hover: subtle surface change;
- focus-visible: explicit tokenized ring;
- invalid: danger border plus textual error;
- stale/degraded/unsupported: icon or label plus semantic color;
- running lock: values remain readable and mutation controls explain the lock.

## 6. Reference Visualization Inspector

The shell remains four rows: identity, tabs, scrollable content, action bar. The reference slice changes only the content composition and shared control appearance.

### 6.1 Overview tab

The final order is:

1. `InspectorMetricStrip` with Display Passes, Quantity Source, Mesh Readiness, and Data State;
2. `InspectorGroup` titled `Display`;
3. Render Mode as a compact `SegmentedControl`;
4. Quantity Source as an inline field/select;
5. Surface Coloring as a disclosure group;
6. Vectors as a disclosure group;
7. Wireframe and Points only when supported and relevant;
8. Clipping, Camera, and Advanced as collapsed disclosure groups.

`Display Settings` is not an enclosing card. `Render Mode` and `Quantity Source` are not nested cards. `Surface Coloring` and `Vectors` use separators and disclosure affordances.

### 6.2 Other tabs

- `Properties`: target identity, inheritance, effective/source state, geometry scope, and overrides.
- `Display`: detailed pass controls and appearance settings that do not belong in the overview.
- `Diagnostics`: lazy resource and rendering diagnostics only.

The exact existing tab labels and lazy-loading behavior remain unchanged.

### 6.3 Edit semantics

Visualization remains `liveViewport`:

- controls update the viewport immediately;
- Apply remains unavailable because the state is live;
- Reset restores the exact sparse applied baseline, including child targets and viewport-local preferences;
- initial persisted overrides do not make the panel dirty;
- running locks remain explicit.

## 7. Storybook and visual review

Storybook is a development-only component workshop, not a production styling dependency.

The reference slice includes stories for:

- light and dark theme;
- 360, 416, and 560 px widths;
- normal, hover, focus-visible, disabled, invalid, dirty, stale, degraded, and running states;
- short and long labels;
- no quantity available;
- inherited region state;
- object, region, mesh-part, and airbox visualization targets.

The existing Playwright smoke remains the end-to-end authority. Storybook supplies fast isolated iteration and stable component examples. Local screenshot baselines are sufficient for phase one; adopting a hosted visual-diff service is a separate decision.

## 8. CSS ownership and removal rules

After the reference slice:

- `tokens.css` and `theme.css` own semantic values;
- `tailwind-theme.css` maps semantic values into Tailwind namespaces;
- shared controls own their variants in React/CVA/Tailwind;
- `inspector.css` owns only shell geometry and composition contracts still needed globally;
- `inspector-visualization.css` owns only Visualization-specific data layouts;
- no generic control selector may remain in `inspector-visualization.css`;
- no migrated component may rely on a selector defined only by import order;
- deleted selectors must be proven unreachable before removal;
- temporary compatibility selectors require an owner and removal task in the rollout plan.

Line-count reduction is recorded but is not the acceptance criterion. The acceptance criterion is ownership: one visual decision has one implementation location.

## 9. Validation and acceptance

The reference slice is accepted only when all of the following are true:

1. the reported nested-card composition is gone;
2. light and dark screenshots at 360, 416, and 560 px are reviewed;
3. primary labels and controls remain readable without zoom;
4. there is no horizontal overflow;
5. keyboard focus, tab order, disclosure controls, segmented control, select, and action bar work;
6. disabled controls expose state without becoming illegible;
7. Visualization live/reset semantics remain unchanged and tested;
8. inactive tabs and collapsed diagnostics remain demand-driven;
9. Inspector creates no image, canvas, thumbnail, snapshot, or preview request;
10. TypeScript, ESLint with zero warnings, Vitest, React Doctor, Storybook build, and browser smoke pass;
11. obsolete generic Visualization CSS is removed rather than hidden by stronger overrides;
12. a final screenshot is explicitly approved before any other Inspector family migrates.

## 10. Rollout after the reference gate

If the reference slice is approved, subsequent plans migrate in this order:

1. object general, material, texture, and interaction;
2. object and airbox mesh;
3. regions and inheritance views;
4. Study stage authoring;
5. results, resources, jobs, and diagnostics;
6. hysteresis, frequency-domain, and extension panels;
7. final global CSS deletion and visual-regression gate.

Each family must remove its obsolete CSS in the same change. The application must not accumulate a permanent old/new styling split.
