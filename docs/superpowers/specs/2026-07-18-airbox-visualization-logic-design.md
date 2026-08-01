# Airbox Visualization Logic Design

**Status:** Approved in the 2026-07-18 Visualization Inspector audit

## Goal

Make Airbox display controls predictable and consistent across the Inspector,
ribbon, canonical visualization resource, and viewport without removing the
renderer’s existing ability to replay an explicitly persisted Airbox surface.

## State contract

- `visible` is the master gate and never changes configured display passes.
- Airbox defaults to hidden with `wireframeVisible=true`; enabling it therefore
  reveals a wireframe without synthesizing another pass.
- The Airbox primary geometry choices are `off`, `wireframe`, and `points`.
- `vectorsVisible` is an independent overlay and requires a compatible Airbox
  field path at render time.
- Airbox surface rendering remains readable for existing persisted/runtime
  state, but the normal Inspector and ribbon do not offer it as a primary mode.
- One `geometryScope` control is shown because the current resource contract has
  one shared `geometry_scope` for geometry and vector sampling.
- Bounds remain supported by the renderer but are not a primary Airbox control.
- Developer-only synthetic vectors are not exposed in the production Inspector.

## UI composition

The Display group contains, in order:

1. an always-addressable `Visible` switch;
2. one geometry selector;
3. an independent `Vectors` switch;
4. one contextual quantity selector when surface data or vectors need it.

The Inspector must not render a second Surface/Wireframe toggle strip. Points,
Wireframe, Vectors, Surface Coloring, and quantity controls remain conditional
on the pass that consumes them.

## Degraded states

Stale or unknown topology may resolve the viewport to an edge-only ghost view.
The Inspector displays the warning and disables pass changes while preserving
the requested state. `Visible` remains available so the user is never trapped.

## Resource ownership

HTTP v2 visualization state remains canonical. The controller may hold bounded
optimistic patches and viewport-only preferences, but the Inspector and ribbon
must dispatch through the existing visualization command/resource path. This
change adds no endpoint, schema field, generated transport, store, or context.

## Acceptance criteria

- The Inspector can turn a hidden Airbox on and off.
- Turning Airbox on does not enable Surface.
- Reset produces hidden Airbox + configured Wireframe.
- Inspector and ribbon offer the same Airbox geometry choices.
- Geometry scope appears once per surface.
- Pass count excludes master visibility and includes effective bounds.
- Vector data state is never reported as `Not required` while vectors are on.
- Focused controller, Inspector, ribbon, renderer, typecheck, lint, and browser
  smoke checks pass.
