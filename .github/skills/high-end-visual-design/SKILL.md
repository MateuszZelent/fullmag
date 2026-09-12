---
name: high-end-visual-design
description: "Use when improving apps/control-room visual design quality while preserving scientific readability, accessibility, resource architecture, and operational density."
---

# Fullmag Visual Design Standard

Use this skill for visual design changes in the scientific control room. The user instruction and root `AGENTS.md` take precedence. Reuse `gpt-taste` or the motion skill when already loaded instead of repeating their guidance.

## Visual principles

- Treat Fullmag as a scientific instrument: exact, calm, fast, and trustworthy.
- Prioritize scanning of stages, quantities, meshes, logs, charts, and diagnostics.
- Keep labels, units, coordinate frames, revisions, quantities, and backend state visible where decisions occur.
- Use Catppuccin Mocha/Latte through `--fm-*` tokens; raw colors belong only in central theme files.
- Use `fm-*` classes.
- Keep geometry stable during state changes with bounded, responsive constraints; do not use fixed dimensions that break narrow layouts.
- Distinguish loading, stale, degraded, unsupported, failed, running, and resolved states without relying on color alone.

## Fullmag patterns

- One ribbon and one unified viewport; use docked panels for logs, jobs, problems, live state, charts, artifacts, and inspectors.
- Use shared shadcn/ui-style primitives for menus, ribbon, tabs, dropdowns, command palette, dialogs, context menus, switches, segmented controls, and tooltips.
- Show values with SI units and tabular figures.
- Keep overlays modular and away from critical geometry.
- Keep persistent Inspector roots, focus, scroll, drafts, and last-good content stable during refresh and command acknowledgement. Do not animate their opacity.

## Scientific charts

- Use physical axes, units, quantity names, resource and provenance context.
- Use selectors, split charts, or explicit dual axes for incompatible quantities.
- Format named fields with units; never show raw tuples or arrays in tooltips.
- Distinguish diagnostic mode-index views from physical intensity spectra.
- Bound dense data with pagination, virtualization, decimation, or an explicit sample budget; never hide valid data with an unexplained `slice(0, n)`.

## Accessibility and performance

Preserve keyboard focus and tab order, accessible names, usable targets, reduced motion, and non-color status cues. Animate only transform/opacity where permitted, avoid expensive blur in scroll/canvas-adjacent surfaces, memoize or adapt heavy chart models, and release ECharts, observers, subscriptions, workers, object URLs, and large buffers on unmount.

Verify the smallest relevant visual/browser regression and measurement. A 3D viewport change also needs the repository WebGL proof; a chart or layout-only change does not require unrelated 3D suites.
