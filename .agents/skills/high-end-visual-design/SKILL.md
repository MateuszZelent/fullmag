---
name: high-end-visual-design
description: "Use when improving Fullmag visual design quality. Applies premium product polish to a scientific control-room UI while preserving OpenAPI/resource architecture, unified viewport behavior, accessibility, and operational density."
---

# Fullmag Visual Design Standard

## Design Position

Fullmag should look like a serious scientific instrument: exact, calm, fast, and trustworthy. Premium here means clear hierarchy, stable layout, crisp interaction, and excellent data readability. It does not mean cinematic landing pages, decorative gradients, or large ornamental cards.

## Visual Principles

- **Operational density:** Users compare stages, quantities, meshes, logs, charts, and diagnostics repeatedly. Prioritize scanning and repeated action.
- **Physical clarity:** Labels, units, coordinate frames, quantity names, revisions, and backend state must be visible where decisions are made.
- **Quiet confidence:** Neutral surfaces, measured contrast, consistent icon stroke, small radius, and deliberate accent colors.
- **Catppuccin discipline:** Dark mode uses Catppuccin Mocha and light mode uses Catppuccin Latte through `--fm-*` tokens. Do not add one-off colors in components.
- **Stable geometry:** Toolbars, viewport controls, tiles, split panes, and tables need fixed or bounded dimensions so state changes do not shift the interface.
- **Honest status:** Loading, stale, degraded, unsupported, failed, and resolved states must be visually distinct.

## Fullmag-Specific Patterns

- Use a single ribbon for command groups. Ribbon buttons, tabs, dropdowns, context menus, command palette, dialogs, switches, segmented controls, and tooltips should come from shadcn/ui-style shared primitives.
- Use docked panels for logs, jobs, problems, live state, charts, artifacts, and inspectors.
- Use segmented controls for quantity/view modes, toggles for overlays, sliders/inputs for numeric thresholds, menus for backend/capability options, and tabs for resource families.
- Keep viewport overlays modular and minimal. They should not cover critical geometry or field data.
- Show units with values and use tabular figures for aligned numeric columns.
- Use semantic status color consistently: selected, running, succeeded, warning, failed, degraded, stale.
- Use `fm-*` classes for Fullmag geometry/state and `--fm-*` tokens for color. Raw Catppuccin hex values belong only in central theme/token CSS.

## Banned Defaults

- Marketing hero layouts inside the workspace.
- Purple/blue gradient atmospheres, floating orbs, bokeh blobs, and decorative glass panels.
- Generic 3-card feature rows, testimonial blocks, pricing-table aesthetics, or marketing funnel page structure.
- Oversized headings inside panels or docks.
- Text that explains how to use obvious controls instead of making the controls discoverable.
- Motion that animates layout dimensions, blocks pointer interaction, or competes with solver/viewport data.

## Accessibility And Interaction

- Preserve keyboard focus rings and logical tab order.
- Use accessible names/tooltips for icon buttons.
- Keep target sizes usable in dense toolbars.
- Do not rely on color alone for warnings or capability state.
- Respect reduced-motion settings for any nonessential animation.

## Performance

- Animate only transform and opacity.
- Keep canvas/Three.js scenes full and responsive without unnecessary React re-renders.
- Separate viewport topology rebuilds from buffer/style changes.
- Avoid expensive blur/noise effects in scrolling or canvas-adjacent surfaces.
- Memoize heavy panels and render layers when resource revisions have not changed.

## Final Check

- The UI reads as a Fullmag control room, not a generic SaaS dashboard.
- Physical state, resource state, and execution state are distinguishable.
- The unified viewport and one ribbon direction remain intact.
- The UI remains Catppuccin Mocha/Latte and shadcn-based, not an ad-hoc component system.
- The design improved clarity without adding architectural drift.
