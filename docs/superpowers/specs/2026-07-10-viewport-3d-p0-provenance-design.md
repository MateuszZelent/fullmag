# Viewport 3D P0 Provenance Design

**Scope:** F3D-001 through F3D-004 from the frontend 3D visualization audit.

## Decision

Topology can remain visible as an explicitly stale wireframe ghost, but it is
field-compatible only when scene, topology, and field identities are exact. An
explicit mismatch between `scene.revision` and
`manifest.source_scene_revision` is always stale; heuristics apply only when
provenance is absent.

`domain_generation_id` is an exact decimal revision token. FMVP v3 payloads
without an equal generation token are rejected before scalar colors, glyphs, or
target field buffers are derived. FMVP v2 is explicitly degraded and never
claims exact compatibility. HTTP field resources stay authoritative; realtime
only advances invalidation when a field-samples event changes generation.

FDM cuboid builds are a local asynchronous state machine. A result is visible
only when its `buildKey` equals the currently requested key. A replaced or
failed request reports `pending` or `error`, never another domain's model.

## Boundaries

- `visualizationDisplayResolution` owns scene/manifest freshness and ghost
  display constraints.
- `viewport3DFieldDomainCompatibility` owns field/topology compatibility and
  mismatch diagnostics.
- Domain adapters, target buffers, and build-key helpers carry exact revision
  tokens; renderer layers consume only the resulting render model.
- `RealtimeInvalidationBridge` parses `domain_generation_id` and invalidates
  HTTP resources; it never transports field payloads.
- FDM build state owns transient request/result/error state, not a server
  snapshot or cache of field arrays.

## Verification

Each finding begins with a failing focused regression test. Final browser proof
requires a visible canvas, live WebGL context, non-zero drawing buffer, stale
ghost rendering without field requests, and no old color/glyph frame after a
generation-only change.
