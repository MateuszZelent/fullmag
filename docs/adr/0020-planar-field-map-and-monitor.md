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
   `SceneDocument`. It owns physical target, frame, extent, and operator. The
   planar visualization source is a typed union: `Default` is a
   session-resolved domain slice, while `monitor:{monitor_id}` selects this
   authored model resource. `Default` is never a `PlanarMonitor` and does not
   enter `SceneDocument`, `ProblemIR`, or canonical Python.
2. Keep quantity, component, unit, range, palette, raster resolution, quality,
   opacity, and vector budget in a separate `PlanarViewProfile` and data
   request. The canonical planar range is `auto | manual | symmetric`, with
   manual SI limits and a separate display-unit transform; the profile owns no
   monitor/sampling identity.
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
8. Use the existing canonical visualization target registry as the only owner
   of the Airbox, object, and mesh-part identities that it currently publishes.
   The planar resource stores sparse `target_overrides` keyed by the exact
   registry `scope + scope_id`, but it does not duplicate target labels,
   geometry ownership, carrier identity, or resolver rules. The first contract
   permits only `airbox | object | part`; region, FDM-domain, and native-layer
   support requires an explicit registry/OpenAPI extension and may not use a
   second key scheme. The global planar profile remains the backward-compatible
   fallback. A target override changes only planar presentation for that target;
   it does not mutate the 3D target override, the authored monitor, the resolved
   frame/operator, or the planar sample identity.

This decision partially supersedes ADR 0016 only where ADR 0016 accepted a
static PNG as the first replacement for interactive cross-section inspection.
It preserves ADR 0016's tab host, active-only mounting, resource-first API, and
single-WebGL invariants.

## Consequences

- Monitors round-trip through canonical Python and survive UI rollback.
- `Default` is always available when domain metadata is ready and opens at
  `xy`, position fraction `0.5`; selecting it does not create or mutate a
  monitor.
- One monitor can display every compatible published spatial quantity.
- Runtime-only mesh-part and airbox scopes do not leak discretization identity
  into authored physics.
- FDM and FEM share physical equations while retaining explicit numerical
  implementations.
- Measure-weighted integration and occupancy are required; node-count averaging
  is not a legal fallback.
- 3D and 2D range/palette state can differ without duplicating target identity
  or inspector registration.
- A FEM overlay can distinguish exact selected-target boundary segments from
  mesh interior; it must not infer that boundary from projected float segments.
- The frontend gains a dedicated renderer lifecycle and byte-bounded resource
  caches, but no second GPU context.
- Airbox and magnetic-object planar presentation can be edited independently
  without making Inspector selection a second server-side target registry.
- A wireframe-only target override is presentation state: it does not refetch
  scalar/vector payloads or change sampling `sample_token` and scalar/vector/
  mask/mesh-overlay ETags. It does change visualization-state revision/ETag and
  style-dependent `render.png` identity.

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
- Version the planar overlay representation independently (`FMCS v4`), include
  codec version in its ETag, and retain FDM `204` plus degraded legacy-v3
  decoding instead of manufacturing a boundary overlay.
- Validate FDM and FEM with manufactured fields, refinement invariance, and
  managed runtime reports.
- Prove active-only mount, no idle redraw, worker/object cleanup, bounded memory,
  and healthy 3D WebGL recovery in a real browser.

- Define `PlanarTargetPresentationOverride` as `{scope, scope_id,
  wireframe_style}`. `scope` is `airbox | object | part`, `scope_id` is non-empty,
  and `(scope, scope_id)` is unique. PATCH replaces the complete ordered list;
  omission leaves it unchanged and removing an entry restores global fallback.
- Resolve overrides by exact canonical registry identity. Never match by display
  label, array position, suffix, or the currently selected Explorer row.
- PATCH accepts only identities present in the current canonical registry.
  If a later scene or mesh revision removes a target, its persisted override is
  dormant, emits a diagnostic, and is not applied. Reappearance of the same
  canonical identity reactivates the explicitly authored preference; automatic
  suffix/label remapping and silent pruning are forbidden.
- Prove that changing an Airbox planar override leaves an object override and
  its resource request identity byte-for-byte unchanged, and vice versa.

## Migration

1. Add monitor/IR/sampler/API contracts without changing the existing ribbon.
   Add the session-scoped typed planar source and its v8-to-v9 persistence
   migration without dual-writing `active_monitor_id`.
2. Add hidden `field-map` and resource hooks.
3. Reach scalar/vector/mesh/contour/probe and inspector parity.
4. Point the `2D` command to `field-map`.
5. Keep PNG as export/fallback and remove the competing top-level command.
6. Retain legacy slice/projection endpoints until a separately approved removal
   after compatibility observation.
7. Migrate persisted visualization schema 6 to schema 7 once, translating
   legacy contrast state to canonical planar range state. New HTTP/OpenAPI
   writes do not dual-write aliases.
8. Migrate planar visualization persistence from v8 to v9: a null legacy
   monitor selection becomes `Default`, and a non-null selection becomes an
   authored monitor source. A stale authored ID repairs to `Default` at
   resolution time with a diagnostic.

9. Add sparse per-target planar presentation overrides additively. Existing
   persisted global planar style remains the fallback and is not dual-written.
   A target receives an override only after an explicit target-scoped edit;
   removing that override restores the global fallback.

Rollback may hide `field-map` and restore the static PNG command. It must not
delete authored monitors, change `ProblemIR`, replace conservative FEM
integration with node averaging, or rewrite sparse target overrides into the
global fallback.

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
- Exact Airbox/object target isolation through optimistic update, HTTP ACK,
  Inspector focus/scroll stability, and unchanged planar data request counts.
