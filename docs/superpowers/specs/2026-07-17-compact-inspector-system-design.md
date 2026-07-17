# Compact Inspector System Design

**Status:** Approved direction; awaiting written-spec review
**Date:** 2026-07-17
**Extends:** `2026-07-17-inspector-design-system-reference-slice-design.md`

## 1. Decision

The entire Control Room Inspector will use a compact desktop-instrument density. The approved target is the denser scientific-tool layout shown by the user: short controls, aligned label/value rows, small gaps, restrained separators, and collapsed secondary sections.

This is not a semantic rewrite. Selection, resource loading, edit sessions, validation, inheritance, transactions, viewport behavior, and runtime locks remain unchanged.

## 2. Scope

The compact system applies to every Inspector family and every shared component rendered inside it:

- shell identity, breadcrumbs, tabs, scroll content, and sticky action bar;
- group headers, disclosures, metric strips, notices, separators, property grids, and property rows;
- buttons, icon buttons, inputs, numeric inputs, text areas, selects, segmented controls, switches, checkboxes, sliders, badges, tooltips, and validation messages;
- Visualization, object, geometry, material, texture, interaction, mesh, region/inheritance, Study, Results, jobs, resources, diagnostics, hysteresis, frequency-domain, and extension panels.

The work does not change public APIs, physics, units, backend behavior, or the unified workspace model. It does not add another UI framework.

## 3. Density contract

The Inspector is a mouse-and-keyboard desktop tool. Visible geometry is compact while interaction remains accessible.

| Element | Contract |
|---|---|
| Compact control | 26 px visible height |
| Multiline/regular control | 30 px minimum visible height |
| Icon button | 26 x 26 px visible button |
| Slider track | 4 px visible track inside a minimum 28 px interaction row |
| Slider thumb | 12 px visible thumb with focus ring |
| Property row | 28 px minimum; grows only for wrapping content |
| Horizontal gap | 6 px |
| Row gap | 4 px |
| Group internal gap | 6 px |
| Group separation | 10 px plus one subtle separator where needed |
| Inspector horizontal padding | 10 px |
| Input/select radius | 7 px |
| Button/segment radius | 8 px |
| Disclosure/raised-region radius | 10 px |
| Group title | 11 px, weight 600 |
| Field label | 10.5–11 px, weight 500 |
| Control/value text | 11 px; numeric values use tabular figures |
| Help/status text | 10 px, never used as the sole primary editable label |

The compact appearance must not shrink keyboard focus indication, slider interaction rows, semantic labels, or error text. Long labels may wrap; controls must not overlap or force horizontal scrolling at 360 px.

### 3.1 Apple-style geometry

Compact does not mean square. The current grid of separately outlined rectangles is rejected. Controls use soft, continuous corners and restrained depth:

- segmented controls have one rounded outer track; segments are separated by spacing or tonal contrast, not individual boxed borders;
- selection uses a softly rounded accent surface with an immediate state transition;
- buttons, inputs, selects, and badges share a coherent corner family instead of unrelated radii;
- toggle collections use rounded tonal cells without strong outlines around every item;
- ordinary section content remains borderless; rounded containers are reserved for interactive groups or genuinely raised regions;
- shadows are limited to transient overlays and the selected segment only when needed to separate it from its track;
- focus rings follow the control contour and remain distinct from selection.

Full capsule geometry is reserved for short binary filters, compact status pills, and similarly small controls. Scientific inputs and wide property fields remain softly rounded rectangles so precision and alignment are preserved.

## 4. Composition

### 4.1 Shell

The identity area becomes one compact block: breadcrumb, icon/title/status, and two-column metadata without decorative empty space. Tabs remain one line. The action bar uses 26 px buttons and the smallest spacing that preserves distinct actions.

### 4.2 Sections

Ordinary groups are not cards. A section consists of a short header row, optional status/badge, content, and a separator only when adjacent groups would otherwise merge visually. Secondary and advanced groups are collapsed by default. A panel may keep a section open when it contains the current selection's primary task.

### 4.3 Property rows

The default layout is an aligned two-column row: label on the left, control or value on the right. Stacked rows are reserved for segmented controls, complex editors, explanations, and narrow-width overflow. Labels align consistently across a group; scientific units remain adjacent to their values.

### 4.4 Controls

Segmented controls use one short 26 px rounded track with inset selected segments. More than four options wrap into an explicit rounded grid instead of compressing labels. Toggle collections use softly filled cells without a hard border on every option. Sliders place label and formatted value on one line with the track immediately below. Switches and checkboxes use shared Radix/shadcn-style primitives. Disabled controls remain readable and explain locks where necessary.

## 5. Ownership

- `--fm-*` tokens remain the source of visual truth.
- Shared controls own size and state variants through CVA/Tailwind and stable `data-slot` contracts.
- Inspector primitives own layout density and alignment.
- Domain panels own only scientific/domain-specific layouts.
- Domain CSS may not redefine generic inputs, selects, sliders, switches, tabs, buttons, or section headers.
- Every custom CSS class keeps the `fm-` prefix.
- Obsolete compatibility selectors are removed in the same family migration once proven unused.

## 6. Migration order

The migration is incremental but the end state covers the complete Inspector:

1. shared compact control variants and Inspector composition primitives;
2. Visualization, including expanded Surface Coloring and Vectors;
3. object identity, geometry, material, texture, and interaction;
4. object mesh, airbox mesh, regions, and inheritance;
5. Study and stage authoring;
6. Results, resources, jobs, and diagnostics;
7. hysteresis, frequency-domain, topological-charge, and extension panels;
8. removal of remaining generic legacy Inspector CSS.

Each step must be independently usable and must not leave a panel half-migrated between old and compact generic controls.

## 6.1 Inspector navigation model

Tabs are reserved for genuinely different user tasks. They are not a mandatory shell decoration and must never be rendered when the panel does not provide distinct tab content.

- Visualization uses one continuous settings surface. Target identity is a compact summary; display, surface, vectors, wireframe, points, geometry scope and opacity are sections; diagnostics and overrides are collapsed at the end.
- Material, Geometry, Physics, Regions and ordinary Study/stage inspectors use one continuous surface with compact disclosure groups.
- Mesh uses task tabs `Policy`, `Quality`, and `History` where those resources exist as distinct views.
- Results use `Overview`, `Data`, `Provenance`, and optional `Diagnostics` only when each tab has real content.
- Dedicated diagnostics may use `Overview`, `Evidence`, and `Raw data`.
- Axis, calculation mode, support mode, sample count and similar value choices use `SegmentedControl`, not navigation tabs.
- The shell derives tabs from the selected panel's declared content. It does not assign generic `Overview / Properties / Diagnostics` tabs to every selection kind.

## 7. Verification

Each migrated family requires:

- contract/component tests for shared primitives and panel composition;
- accessibility checks for names, roles, focus, disabled state, and disclosure behavior;
- light and dark browser screenshots at 360, 416, and 560 px;
- expanded-state screenshots for long sections, segmented grids, sliders, validation, and runtime locks;
- no horizontal overflow or clipped labels;
- unchanged transaction, reset, inheritance, resource-loading, and lazy-loading semantics;
- no new image, canvas, thumbnail, preview, or polling request from Inspector;
- passing TypeScript, ESLint with zero warnings, full Vitest, Storybook build, React Doctor, and Inspector browser smoke.

## 8. Acceptance

The compact Inspector is complete only when:

1. all Inspector families use the shared compact primitives;
2. visible controls and spacing conform to the density contract;
3. no migrated panel presents a square grid of individually outlined controls;
4. expanded Visualization sliders and segmented controls are readable and aligned;
5. secondary sections are collapsed by default where appropriate;
6. no generic old/new styling split remains;
7. all verification gates pass;
8. final representative screenshots are approved by the user.
