# Inspector 2.0 Design

**Status:** Accepted
**Date:** 2026-07-17

## Goal

Replace the Control Room Inspector's accumulated square, cramped, panel-specific chrome with one coherent scientific-instrument shell while preserving the canonical resource, transaction, selection, and domain-model boundaries already implemented by individual inspector families.

## Product contract

The Inspector is a persistent right-hand work surface, not a stack of unrelated forms. Its default width is 416 px, its supported range is 360–560 px (also capped at 38 vw), and the existing workspace separator remains the single resize affordance. The separator has a 6 px hit target, double-click restores 416 px, width persists, and viewport resizing is coalesced with `requestAnimationFrame`.

The panel is a four-row grid:

1. an identity header;
2. a 40 px tab row;
3. the only scrolling content region;
4. a 56 px action bar.

The header contains a semantic breadcrumb, icon, title, type badge, canonical status, overflow menu, and at most four metadata values in a 2x2 grid. It never contains an image, canvas, viewport thumbnail, screenshot, or reserved preview area.

## Information architecture

Each selection resolves to an `InspectorDescriptor`. The descriptor supplies identity, status, metadata, at most four tabs, summary metrics, action availability, and edit mode. The existing registry remains the selection-to-panel routing seam; descriptors provide shared chrome and do not replace domain resource adapters or transaction logic.

Visualization uses exactly `Overview`, `Properties`, `Display`, and `Diagnostics`. Overview starts with four compact status tiles (`Display Passes`, `Quantity Source`, `Mesh Readiness`, `Data State`) followed by `Display Settings` expanded and `Clipping`, `Camera`, and `Advanced` collapsed. Other node families use a maximum of four tabs chosen for their domain, with the same shell and primitives.

## Editing and state

Inspector fields declare one of three modes:

- `staged`: changes stay in a local draft until Apply;
- `liveViewport`: visual changes update the viewport immediately but retain an applied baseline for Reset;
- `immediate`: discrete commands execute immediately and never create false dirty state.

The shell receives a small edit-session contract from the active panel: dirty, valid, applying, reset, apply, and an optional disabled reason. Apply is enabled only for a valid dirty staged session. Reset restores the last applied baseline, not arbitrary global visualization defaults. Running or otherwise locked resources keep their values readable and explain why mutation is unavailable. Changing selection with a dirty staged draft presents an explicit Apply/Discard/Cancel decision.

## Visual system

All inspector chrome uses existing `--fm-*` Catppuccin tokens and shared Radix/shadcn-style primitives. Cards use restrained 8 px radii, one-pixel token borders, a small elevation token, and consistent 8/12/16 px spacing. Controls have a 32 px compact target, labels remain readable, numeric content uses tabular figures, and hierarchy comes from spacing, typography, and surface elevation rather than nested grey boxes.

The base Inspector stylesheet owns shell, header, tabs, content, sections, fields, summaries, and action-bar geometry. Family styles own only domain-specific layouts. Duplicate base selectors and appended cascade overrides are removed. Raw colors, one-off controls, 1–2 px layout gaps, and family copies of generic card/form styles are eliminated.

## Architecture boundaries

- `InspectorModule` remains a thin module root.
- `inspectorRegistry` remains the semantic selection routing table.
- New shell/descriptor/edit-session code stays inside the Inspector module unless it is a genuinely reusable UI primitive.
- Existing domain panels keep their resource hooks, model builders, and canonical transactions.
- No Inspector component calls `fetch`, imports another module's internals, or invents physics state.
- Diagnostics remain lazy and do not create polling or viewport work when their tab is inactive.

## Accessibility and interaction

Breadcrumbs are navigable controls where a parent selection exists. Tabs, accordions, menus, dialogs, and tooltips use the shared accessible primitives. Focus rings are visible, icon-only actions have accessible names, disabled actions expose a reason, tab order follows visual order, and keyboard users can reach every edit and action. Narrow-width layouts do not hide controls or cause horizontal scrolling.

## Validation

Completion requires focused tests for descriptor resolution, draft/apply/reset behavior, selection-change protection, width persistence/reset, and running-state locks; full typecheck, zero-warning lint, and test suite; React Doctor with no score regression; and browser proofs at 360, 416, and 560 px covering Overview, Properties, Display, Diagnostics, dirty/apply/reset, running state, scrolling boundaries, and the absence of preview image/canvas/snapshot requests.

