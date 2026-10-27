# Frontend v2 - CSS Design System

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Design Position

Frontend v2 must feel like a **premium professional application** — beautiful, dense, and purposeful. Think Figma's polish with COMSOL's depth. The visual system serves sustained scientific work with elegance, not with bare-bones utilitarianism.

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

Tasteful motion reinforces interaction feedback and visual hierarchy.

Allowed and encouraged:

- opacity/transform transitions for overlay open/close (150–200ms ease-out);
- subtle scale/highlight on selection change;
- smooth panel resize transitions;
- command progress pulse while a command is active;
- stale-to-fresh resource transition in status indicators;
- hover state transitions on interactive elements (100ms);
- loading skeleton shimmer for async resources;
- smooth scroll in explorer and inspector.

Forbidden:

- layout dimension animations in the workspace grid that trigger reflow;
- perpetual decorative animation near numerical data;
- glassmorphism, parallax, hero sections, or marketing-style effects;
- motion that triggers canvas resize loops;
- animation durations exceeding 300ms for UI state changes.

Respect `prefers-reduced-motion` by disabling transform/opacity transitions, keeping instant state changes.

## 7. Accessibility

- All icon-only commands need accessible names and tooltips.
- Keyboard focus rings remain visible.
- Menus, ribbon, tree, inspector, and dialogs must be keyboard reachable.
- Warnings combine color, icon/shape, and text.
- Numeric controls show units and bounds.
- Dense UI still keeps pointer targets usable.

## 8. Performance Rules

- No expensive blur/noise effects in scroll containers or near canvas.
- Viewport overlays avoid forcing canvas re-layout.
- CSS variables define visual state; React should not re-render large trees just to change a color.
- Long lists use virtualization.
- Charts resize through observed containers, not window-level polling.
