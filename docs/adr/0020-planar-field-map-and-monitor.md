# ADR 0020: Planar field map and canonical monitor

- Status: accepted
- Date: 2026-07-18
- Physics contract:
  `docs/physics/0970-planar-monitor-sampling-and-projection.md`

## Context

Fullmag has server-rendered mesh cross-section PNGs and several field
slice/projection resources, but no single reproducible authoring model or
interactive production 2D spatial field surface. Keeping independent slice
algorithms, a local cross-section draft store, and separate 2D inspectors would
create semantic drift between Python, `ProblemIR`, API, and the browser.

The protected invariants are one Python DSL, one `ProblemIR`, one capability
vocabulary, one resource-first browser API, one workspace tree, and one active
heavy center surface. `viewport-3d` must remain the only WebGL/R3F surface.

## Decision

1. Introduce the canonical `PlanarMonitor` in Python, `ProblemIR`, and
   `SceneDocument`. It owns physical target, frame, extent, and operator.
2. Keep quantity, component, unit, range, palette, raster resolution, quality,
   and vector budget in a separate `PlanarViewProfile` and data request.
3. Make `PlanarSamplingEngine` the only implementation owner for FDM/FEM plane,
   slab, depth, and surface sampling. Existing slice/projection endpoints become
   compatibility adapters.
4. Publish revision-safe monitor model resources and separate bounded planar
   field data resources through OpenAPI v2. WebSocket remains
   invalidation-only.
5. Register `field-map`, shown as **2D View**, in `viewport-main`. It uses
   Canvas 2D and a worker, never Three.js/R3F/WebGL.
6. Keep one inspector registry. Relevant visualization panels derive
   `three-d | planar` from the active center surface and retain independent
   presentation profiles.
7. Migrate `cross-section-image` to export/fallback and remove it as a
   competing top-level workflow only after science, browser, lifecycle, and
   export parity gates pass.

This decision partially supersedes ADR 0016 only where ADR 0016 accepted a
static PNG as the first replacement for interactive cross-section inspection.
It preserves ADR 0016's tab host, active-only mounting, resource-first API, and
single-WebGL invariants.

## Consequences

- Monitors round-trip through canonical Python and survive UI rollback.
- One monitor can display every compatible published spatial quantity.
- Runtime-only mesh-part and airbox scopes do not leak discretization identity
  into authored physics.
- FDM and FEM share physical equations while retaining explicit numerical
  implementations.
- Measure-weighted integration and occupancy are required; node-count averaging
  is not a legal fallback.
- 3D and 2D range/palette state can differ without duplicating target identity
  or inspector registration.
- The frontend gains a dedicated renderer lifecycle and byte-bounded resource
  caches, but no second GPU context.

## Implementation obligations

- Complete the cascade in
  `docs/plans/active/viewport-2d-planar-monitor-production-masterplan-2026-07-18-pl.md`.
- Keep authored monitor definitions independent of quantity and raster
  resolution.
- Preserve requested intent and resolved frame/operator/runtime scope in
  provenance.
- Regenerate OpenAPI transport; modules may not build endpoint strings or call
  `fetch()` directly.
- Use stable capability/error codes for unsupported quantities, basis orders,
  stale revisions, and non-injective surface projections.
- Validate FDM and FEM with manufactured fields, refinement invariance, and
  managed runtime reports.
- Prove active-only mount, no idle redraw, worker/object cleanup, bounded memory,
  and healthy 3D WebGL recovery in a real browser.

## Migration

1. Add monitor/IR/sampler/API contracts without changing the existing ribbon.
2. Add hidden `field-map` and resource hooks.
3. Reach scalar/vector/mesh/contour/probe and inspector parity.
4. Point the `2D` command to `field-map`.
5. Keep PNG as export/fallback and remove the competing top-level command.
6. Retain legacy slice/projection endpoints until a separately approved removal
   after compatibility observation.

Rollback may hide `field-map` and restore the static PNG command. It must not
delete authored monitors, change `ProblemIR`, or replace conservative FEM
integration with node averaging.

## Validation

- Python ↔ `ProblemIR` ↔ `SceneDocument` ↔ canonical Python round-trip.
- Manufactured numerical tests for constant, linear, vector, occupancy,
  surface, and refinement cases.
- Route/OpenAPI/ETag/revision/realtime compatibility tests.
- Frontend module, state ownership, inspector coverage, accessibility, and
  lifecycle tests.
- Managed FDM/FEM runtime reports and browser screenshots/smokes.
- Full typecheck, zero-warning lint, tests, production build, API hygiene, and
  architecture hygiene.

