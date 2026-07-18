# Canonical Visualization Startup Defaults

**Status:** implemented
**Date:** 2026-07-18

## Goal

Define predictable first-display behavior without allowing browser defaults to
override visualization settings explicitly authored in Python.

## Contract

### Magnetic objects

When no explicit visualization configuration exists, a magnetic object starts
with its target visible and only the physical surface channel enabled. Surface
coloring uses `orientation` (HSL). Wireframe, points, vectors, bounds, and
primitive fallback are disabled.

### Airbox and non-magnetic targets

When their target display is enabled without an explicit visualization
configuration, Airbox and every other non-magnetic target start with every
render pass disabled: surface, wireframe, points, vectors, bounds, and
primitive fallback. The target master visibility remains enabled, so a user can
turn on exactly the desired pass without the UI creating an unsolicited
wireframe or surface.

### Explicit authoring wins

An explicit Python visualization state is canonical. Its target/layer/style
values take precedence over the above defaults, including `visible`, every
layer's `visible`, surface color source, palette, quantity, vector style, and
per-layer opacity. No browser preference, inspector initialization, or v2
resolver may replace an explicit value with a startup default.

## Ownership and data flow

The v2 visualization-state resource owns canonical defaults and any Python
authored values. The API resolves settings into target settings. The frontend
controller remains a pure consumer of that resource, retaining only
viewport-local preferences such as primitive preview style. Websocket events
only invalidate the resource; they do not supply a second visualization state.

## Implementation boundary

Update canonical v2 default layers for Airbox/non-magnetic targets, and align
the frontend fallback constants and resolver tests. Do not add a second browser
state flag or provenance field: presence of target/layer/style values already
expresses explicit authoring.

## Validation

- API tests prove default object HSL surface-only settings.
- API tests prove default Airbox/non-magnetic all-pass-off settings.
- API tests prove nested explicit Python-style overrides supersede defaults.
- Controller tests prove the resolved resource is consumed unchanged.
- Typecheck, lint, focused API/frontend tests, and resource-first gates pass.
