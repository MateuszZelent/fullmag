# Frontend v2 - CSS Design System

**Status:** Proposed architecture, visual language revised 2026-11-20
**Date:** 2026-05-11

## 1. Design Position

Frontend v2 must feel like a **premium professional application** — beautiful, dense, and purposeful. Think Figma's polish with COMSOL's depth. The visual system serves sustained scientific work with elegance, not with bare-bones utilitarianism.

Since 2026-11-20 the reference is the glass mockup in `docs/design/inspector-redesign/`: the viewport fills the window and the explorer, Inspector, dock, bars and dialogs are frosted, rounded layers above it. The mockup sets the minimum quality bar; implementations may exceed it. Sections 1a, 2, 3, 6 and 8 below define the binding rules; older audit notes that contradict them are superseded.

### 1a. Visual language 2026-11 (binding)

- **Material:** glass over a live viewport. Layers use a translucent surface token, a backdrop blur/saturation token, a hairline border token and a top highlight token. `prefers-reduced-transparency: reduce` swaps glass for opaque panel surfaces.
- **Recessed fields, raised selection:** inputs, segmented tracks and unselected options sit on a slightly recessed `field` surface tinted from the foreground colour, never bright white in the light theme. The selected option, active tab, active rail icon and selected tree row use the `raised` surface with the `sm` elevation and, where a domain applies, a domain-hue outline.
- **Domain hues:** geometry, material, physics, study, visualization, mesh and definition each own a hue token. The hue marks the identity glyph, open section icon, selected tile and ribbon icon of that domain. Semantic state colours remain separate.
- **Elevation:** three shadows, `sm` for controls and selected options, `md` for panels, popovers and menus, `lg` for dialogs, sheets and the command palette. Values follow the `beautiful-shadows` skill. One shadow strength per element state.
- **Radius scale:** field ≈ 10 px, section ≈ 16 px, panel ≈ 22 px, window ≈ 28 px, pill fully rounded.
- **Typography:** Inter for UI with tabular figures for numbers, JetBrains Mono only for identifiers, paths and code, an italic serif symbol face (STIX Two Text or compatible) for physics symbols. Sentence case labels.
- **Both themes are first class** (Catppuccin Mocha and Latte). Every visual change is reviewed in both, with text contrast ≥ 4.5:1 and UI contrast ≥ 3:1.

### Three-layer CSS strategy

1. **Tokens (`--fm-*` custom properties)** — the source of truth for all visual decisions: colors, spacing, typography, geometry. Dark and light themes swap Catppuccin Mocha/Latte token values.
2. **Tailwind CSS** — utility layer for layout, spacing, and responsive behavior. Tailwind utilities consume tokens where possible (`bg-[var(--fm-bg-panel)]`).
3. **shadcn/ui** — accessible pre-built components and patterns (menu, ribbon controls, command palette, dialogs, dropdowns, context menus, tabs, resizable panels, switches, segmented controls, tooltips). Shared primitives retain their accessible behavior. Each primitive has one visual owner: semantic `fm-*` CSS classes selected by CVA, or token-backed utilities. Do not define competing visual properties in both layers. Button and Tabs use semantic classes; utilities remain available for consumer layout.

Custom `fm-*` classes define shared primitive variants, layout geometry and domain-specific contracts. They do not replace accessible behavior. Migrate one primitive at a time without globally reordering cascade layers.

### Control and tab contract (design audit, 2026-10-26)

- Compact controls are 28 px, regular controls 30 px; interactive hit areas are at least 24 px. Control labels default to 12 px. Scientific data and dense annotations can use documented smaller roles.
- Tabs switch a named content panel. Segmented value choices retain radiogroup/radio semantics; independent toggles retain their own semantics.
- Shared Tabs has line and segmented presentations with one CSS owner. A line tab uses neutral readable text and an accent underline; selected state is not conveyed only by text color. A panel-specific 44 px Inspector row must not become the global minimum height.
- Tab lists preserve visible overflow and keyboard reachability. Enabled hover styles never replace disabled styles, and focus remains visible.
- A segmented radiogroup always offers one keyboard entry when any option is enabled, even if its current value is missing or disabled. Focus fallback does not change the value until the user acts.


### Inspector property rows (revised 2026-11-20, supersedes the 2026-10-27 audit)

Inspector property rows place the label (with an optional physics symbol) and
the control side by side once the Inspector container is at least ≈ 22 rem
wide, and stack them below that width (container queries). Vectors switch to
side by side at ≈ 30 rem. Controls are 28–32 px high on the `field` radius, with
12.5–13 px text. Units live inside the field as a unit menu that converts the
displayed value. Labels, values, units and validation remain visible in both
themes and in narrow panels; read-only values stay distinguishable from editable
controls.

### File ownership

`apps/control-room/app/globals.css` is import-only:

```css
@import "tailwindcss";
@import "../src/design/styles/tokens.css";
@import "../src/design/styles/theme.css";
@import "../src/design/styles/base.css";
@import "../src/design/styles/layout.css";
@import "../src/design/styles/slots.css";
@import "../src/design/styles/header.css";
```

No real token, layout, component, or theme rules belong directly in `globals.css`. If a style is shared, it lives in `src/design/styles/*`; if it is module-specific, it lives beside the module and still consumes `--fm-*` tokens.

### Theme support

Dark and light themes are implemented through a `data-theme` attribute on `<html>`:

```css
:root, [data-theme="dark"] {
  --fm-bg-app: #1e1e2e; /* Catppuccin Mocha Base */
  /* ... Mocha tokens ... */
}

[data-theme="light"] {
  --fm-bg-app: #eff1f5; /* Catppuccin Latte Base */
  /* ... Latte tokens ... */
}
```

Preferencja `light` / `dark` / `system` jest zapisywana pod dotychczasowym kluczem `fullmag.control-room.theme`. Skrypt w head ustala efektywny motyw przed parsowaniem body; System reaguje na `prefers-color-scheme` bez nadpisywania preferencji użytkownika. Style korzystają z tokenów, a komponent sterujący prezentuje wybór i efektywny motyw. Inter i JetBrains Mono są lokalnymi, licencjonowanymi zasobami w `public/fonts`; manifest zawiera źródła i SHA256.

## 2. Surface Model

| Surface | Use |
|---|---|
| `app` | full browser background |
| `chrome` | menu, ribbon, status bar |
| `panel` | explorer, inspector, docks |
| `viewport` | 3D/2D visual surface |
| `overlay` | transient tools, popovers, legends |
| `selected` | active item/selection |
| `glass` / `glass-strong` | frosted chrome, rails, panels, dock, overlays above the viewport |
| `field` | recessed input, segmented track and unselected option surface |
| `raised` | selected option, active tab, active rail icon, selected tree row |
| `stale` | resource exists but is behind revision |
| `degraded` | supported with reduced fidelity |
| `unsupported` | capability gate blocks action |

These states must be visible without relying on color alone.

## 3. Token Families

The color palette is **Catppuccin Mocha** (dark) and **Catppuccin Latte** (light), using the official Catppuccin palette as source of truth: <https://catppuccin.com/palette/>.

Raw Catppuccin hex values belong only in `src/design/styles/tokens.css` and `src/design/styles/theme.css`. Component CSS and React components use semantic `--fm-*` tokens.

```css
:root {
  /* Surfaces — Catppuccin Mocha */
  --fm-bg-app: #1e1e2e;       /* Base */
  --fm-bg-chrome: #181825;     /* Mantle */
  --fm-bg-panel: #1e1e2e;     /* Base */
  --fm-bg-panel-raised: #313244; /* Surface0 */
  --fm-bg-viewport: #11111b;  /* Crust */
  --fm-border-subtle: #313244; /* Surface0 */
  --fm-border-default: #45475a; /* Surface1 */
  --fm-border-strong: #585b70; /* Surface2 */
  --fm-text-primary: #cdd6f4; /* Text */
  --fm-text-secondary: #bac2de; /* Subtext1 */
  --fm-text-muted: #6c7086;   /* Overlay0 */
  --fm-accent: #89b4fa;       /* Blue */
  --fm-accent-strong: #b4befe; /* Lavender */
  --fm-accent-soft: #2a2d52;
  --fm-success: #a6e3a1;      /* Green */
  --fm-warning: #f9e2af;      /* Yellow */
  --fm-danger: #f38ba8;       /* Red */
  --fm-stale: #cba6f7;        /* Mauve */
  --fm-degraded: #fab387;     /* Peach */
  --fm-radius-sm: 4px;
  --fm-radius-md: 6px;
  --fm-space-1: 4px;
  --fm-space-2: 8px;
  --fm-space-3: 12px;
  --fm-space-4: 16px;
  --fm-menu-height: 30px;
  --fm-ribbon-height: 56px;
  --fm-status-height: 26px;
  --fm-panel-header-height: 32px;
  --fm-font-ui: "Inter", "Aptos", sans-serif;
  --fm-font-mono: "JetBrains Mono", "Cascadia Code", monospace;
}
```

If a value appears in more than one component, it needs a token.

Additional token families required by the 2026-11 visual language (names are
indicative; the implementation fixes them in `tokens.css` / `theme.css`):

```css
:root {
  --fm-glass-bg: …;          /* translucent layer surface */
  --fm-glass-strong: …;      /* denser glass for floating bars */
  --fm-glass-line: …;        /* hairline border of a glass layer */
  --fm-glass-highlight: …;   /* inset top highlight */
  --fm-glass-blur: 22px;     /* backdrop blur radius */
  --fm-glass-saturate: 1.7;  /* backdrop saturation */
  --fm-field-bg: …;          /* recessed control surface */
  --fm-raised-bg: …;         /* selected/raised surface */
  --fm-shadow-sm: …; --fm-shadow-md: …; --fm-shadow-lg: …;
  --fm-radius-field: 10px; --fm-radius-section: 16px; --fm-radius-panel: 22px; --fm-radius-window: 28px;
  --fm-hue-geometry: …; --fm-hue-material: …; --fm-hue-physics: …; --fm-hue-study: …;
  --fm-hue-visualization: …; --fm-hue-mesh: …; --fm-hue-definition: …;
  --fm-ease-out-soft: cubic-bezier(.3, .7, .2, 1);
  --fm-duration-micro: 150ms; --fm-duration-panel: 300ms;
  --fm-font-symbol: "STIX Two Text", "Cambria Math", serif;
}
```

## 4. Layout Geometry

All layout classes use the `fm-` prefix for consistency with component classes.

```css
.fm-workspace-shell {
  display: grid;
  grid-template-rows: var(--fm-menu-height) var(--fm-ribbon-height) 1fr var(--fm-status-height);
  height: 100vh;
  width: 100vw;
  overflow: hidden;
  background: var(--fm-bg-app);
  color: var(--fm-text-primary);
  font-family: var(--fm-font-ui);
}

.fm-workspace-body {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(0, 1fr) minmax(260px, 380px);
  min-height: 0;
  overflow: hidden;
}

.fm-workspace-viewport {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--fm-bg-viewport);
}
```

Panel dimensions are bounded. State changes must not cause major layout jumps.

## 5. Component Contracts

| Component class | Contract |
|---|---|
| `.fm-panel` | fixed header, scrollable body, no internal page layout assumptions |
| `.fm-tree-row` | 28px row height, icon, label, optional status, selected state |
| `.fm-ribbon-group` | command group from registry, not local hard-coded callbacks |
| `.fm-command-button` | displays capability, running, disabled, stale, error states |
| `.fm-inspector-section` | collapsible section with label, validation marker, stable controls |
| `.fm-status-pill` | compact semantic status with label and optional revision |
| `.fm-viewport-overlay` | pointer-safe overlay with bounded size |

Interactive primitives such as menus, ribbon buttons, tabs, dropdowns, dialogs, command palette, context menus, switches, segmented controls, and tooltips are implemented through shadcn/ui-style shared components under `src/shared/ui`. Custom `fm-*` classes define Fullmag geometry and scientific state, not replacement accessibility primitives.

## 6. Motion and Micro-Animations

Motion is part of the product quality. It shows what changed, guides the eye and makes the interface feel fluid.

Allowed and encouraged:

- colour, shadow, transform and opacity transitions on interaction (100–200 ms);
- disclosure animation to the natural height (`interpolate-size`, `::details-content`, Radix collapsible/accordion animations);
- entry motion (short translate and fade) for content that appears because the user selected a new target, tab or panel;
- View Transitions when the Inspector target changes;
- sliding indicators for segmented controls, tabs and rails;
- overlay, menu, popover, dialog and sheet open/close animations;
- live-state pulses (running, live) and progress indicators, live ticking counters in telemetry;
- loading skeletons and smooth scrolling.

Limits:

- same-target data refresh, resource invalidation and command ACK never replay entry motion, never remount the Inspector and never change the opacity of persistent controls;
- micro-interactions 100–200 ms, panel and content transitions up to ≈ 320 ms, using the motion tokens;
- no continuously animated workspace grid dimensions and no motion that resizes the viewport canvas in a loop;
- perpetual animation only for state indicators, never as decoration next to numerical data.

Respect `prefers-reduced-motion` by removing translate/fade motion and keeping instant state changes.

## 7. Accessibility

- All icon-only commands need accessible names and tooltips.
- Keyboard focus rings remain visible.
- Menus, ribbon, tree, inspector, and dialogs must be keyboard reachable.
- Warnings combine color, icon/shape, and text.
- Numeric controls show units and bounds.
- Dense UI still keeps pointer targets usable.

## 8. Performance Rules

- `backdrop-filter` belongs on fixed layers (bars, rails, panels, dock, overlays, dialogs, menus). It is not applied per list row, to content scrolling inside a panel, or to elements animated in a loop.
- Glass layers above the viewport must not force canvas re-layout: panel changes pass insets to the viewport instead of resizing its DOM. A glass or shadow change near the viewport needs a browser measurement (steady idle FPS, no idle redraw, live WebGL context).
- Viewport overlays avoid forcing canvas re-layout.
- CSS variables define visual state; React should not re-render large trees just to change a color.
- Long lists use virtualization.
- Charts resize through observed containers, not window-level polling.
