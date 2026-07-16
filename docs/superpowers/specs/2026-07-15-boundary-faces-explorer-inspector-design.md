# Boundary Faces Explorer and Inspector Design

**Status:** Approved design pending written-spec review  
**Date:** 2026-07-15

## Product problem

The unified workspace exposes Airbox under Universe, but it does not expose the
realized mesh boundary as an inspectable semantic surface. Raw FEM boundary
triangles are currently available only through topology and mesh-part payloads.
They must not leak into Unassigned Mesh, be presented as authored geometry, or
be expanded into an unbounded Explorer list.

The workspace needs one stable Boundary Faces branch that lets a user inspect
boundary sets, topology, provenance, and individual realized faces without
confusing physical authoring semantics with numerical storage layout.

## Decision

Add `Boundary Faces` as a first-class child of `Universe`, parallel in the tree
to `Airbox` but semantically distinct from it:

```text
Universe
├── Airbox
└── Boundary Faces
    ├── Overview
    ├── Boundary Sets
    │   └── <revisioned boundary-set nodes>
    ├── Mesh
    │   ├── Statistics
    │   ├── Quality
    │   └── Topology
    ├── Faces
    └── Visualization
```

Airbox remains a physical domain. Boundary Faces is a revisioned view of the
boundary of the realized mesh. It is not a `SceneObject`, mesh part, authored
region, or fallback entry under Unassigned Mesh.

The Explorer lists semantic boundary sets, never every raw triangle. The
`Faces` node opens a bounded, paginated or virtualized Inspector table. A table
row or viewport pick may select one realized face.

## Stable identity

A realized face reference is valid only inside one topology generation:

```text
mesh_id + generation_id + topology_fingerprint + boundary_face_index
```

Selection stores this small reference and optional semantic owner identifiers.
It does not store topology buffers, face arrays, resource snapshots, or derived
geometry. A mesh generation or topology fingerprint change invalidates the face
selection instead of silently reusing the numeric index.

Boundary-set identities are backend-published stable IDs scoped to the same
mesh generation. The frontend must not infer set identity from array order,
scene-object order, marker zero, or labels.

## Resource-first API contract

Add a thin JSON control-plane resource:

```text
GET /v2/sessions/current/meshing/meshes/shared-domain/boundaries
```

The response contains:

- resource and mesh revision;
- mesh ID, generation ID, and topology fingerprint;
- total boundary-face count;
- boundary-set descriptors with stable ID, label, kind, marker IDs, face count,
  owning part/object/region references when known, boundary-condition reference,
  periodic/interface classification, and bounded aggregate geometry statistics;
- capability flags for face listing, face inspection, picking, and visualization.

The resource returns `204 No Content` when no realized FEM mesh exists and `404`
only when there is no active workspace. It supports ETag/304. React components
consume it through generated OpenAPI types, `ControlRoomApi`, and a resource
hook; they do not build URLs or call `fetch()` directly.

Heavy face indices and topology remain on the binary data plane. Add bounded
backend-owned JSON face-descriptor resources:

```text
GET /v2/sessions/current/meshing/meshes/shared-domain/boundary-faces
GET /v2/sessions/current/meshing/meshes/shared-domain/boundary-faces/{face_index}
```

The list query requires an explicit page limit and may filter by boundary-set
ID or marker. The single-face descriptor publishes the authoritative parent
element, part/object/region ownership, marker, vertices, centroid, outward
normal, area, boundary-set membership, periodic/interface relation, and
boundary-condition reference when available. Unsupported fields are nullable
and accompanied by capability/status information; the frontend never guesses.

The backend resolves `boundary face -> parent element/part/object/region` for
the descriptor resources. The single-face endpoint owns this lookup with the
current FMMT encoding. A future versioned binary topology extension may
accelerate bulk clients, but it must preserve the same semantic result.

## Explorer behavior

`Boundary Faces` is always present under Universe so the product structure is
stable. Before mesh realization it has `unavailable` status and explains that a
mesh build is required. Resource hooks remain disabled until session status
publishes the relevant FEM mesh or generation revision, preventing expected
absence from producing request storms.

`Boundary Sets` contains only backend-published semantic groups. `Faces` is one
navigation node, not a child per triangle. Counts and badges are derived from
the boundary resource revision. Stale data is marked stale and is never merged
with a newer topology generation.

## Inspector behavior

Every new selection kind has its own registered Inspector contribution:

- `boundary-faces.root`: availability, face/set counts, mesh identity, revision,
  provenance, and capability state;
- `boundary-faces.sets`: boundary-set summary and filtering entry point;
- `boundary-faces.set`: marker and ownership data, condition/periodic status,
  aggregate area and normal information, and visualization controls;
- `boundary-faces.mesh`: mesh identity and boundary-specific mesh summary;
- `boundary-faces.mesh.statistics`: counts and bounded aggregate statistics;
- `boundary-faces.mesh.quality`: boundary quality metrics published by backend;
- `boundary-faces.mesh.topology`: topology format, fingerprint, generation, and
  mapping availability;
- `boundary-faces.faces`: paginated/virtualized face table with filters;
- `boundary-faces.face`: authoritative details for one selected face;
- `boundary-faces.visualization`: visible, isolate, opacity, wireframe/filled,
  color mode by set/marker/condition/ownership, and selection highlight.

Unavailable capabilities render explicit read-only explanations. Authoring a
boundary condition is outside this feature unless an existing canonical
ProblemIR transaction already supports it; visualization controls remain
client display state and never mutate physics.

## Viewport behavior

Boundary visualization consumes the existing topology resource and a bounded
render model keyed by topology fingerprint. It may color or isolate faces by
backend-published boundary-set membership. Picking returns the stable realized
face reference. Selection highlighting must not copy full topology into React
state or create one Three.js object per face.

The renderer remains demand-driven and preserves current quality defaults.
Changing Boundary Faces visibility or coloring invalidates only the relevant
render pass. Unmount releases GPU buffers, subscriptions, and workers according
to the existing viewport lifecycle contract.

## State ownership

- Boundary metadata and face descriptors: resource cache/hooks.
- Current selection: kernel selection store, identity only.
- Expanded nodes and face-table filters/page: Explorer or Inspector module UI
  state.
- Visibility/color/isolation preferences: canonical visualization controller.
- Binary topology and GPU resources: resource cache and viewport renderer.
- No canonical simulation or mesh snapshot is copied into a module store.

## Error and lifecycle behavior

- No mesh: stable unavailable UI, no boundary request.
- `204`: valid empty/unavailable resource state, not an error or retry target.
- `404`: no active workspace; terminal and not retried.
- Network, 408, 429, 502-504: use the existing bounded GET retry policy.
- Generation mismatch: discard the response and invalidate face selection.
- Face outside published range: explicit unavailable selection state.
- Missing ownership/mapping: degraded Inspector with backend reason; no frontend
  inference.

## Architecture record

Create `docs/adr/0019-boundary-faces-resource-and-selection.md` before changing
OpenAPI. It records the distinction between authored geometry, Airbox, semantic
boundary sets, and realized face indices; the resource-first control/data-plane
split; generation-scoped selection; and the prohibition on raw-face Explorer
expansion.

## Verification

Backend and contract tests must prove:

- `204` before FEM mesh realization;
- revision, generation, fingerprint, counts, sets, and ETag behavior;
- bounded pagination and invalid-index handling;
- authoritative parent/ownership mapping and nullable degraded cases;
- OpenAPI regeneration and resource-first gates.

Frontend tests must prove:

- the exact Universe tree shape and selection kinds;
- no boundary API request without a compatible mesh revision;
- no raw face children in Explorer regardless of face count;
- correct Inspector registration for every new selection kind;
- generation-safe face selection and invalidation;
- bounded/virtualized face rendering;
- viewport selection/highlight without per-face Three.js objects;
- typecheck, lint, full tests, React Doctor diff review, and browser smoke with a
  visible non-empty WebGL canvas and stable context.

## Migration and compatibility

Existing FMMT topology remains valid for rendering. The new JSON resources add
semantic inspection and ownership without changing authored physics. Any future
binary topology version must be capability-gated and retain the JSON semantic
contract. Literal `__air__` or `__airbox__` aliases remain compatibility inputs
only and never define Boundary Faces identity.

The feature is complete only when the backend resource, generated transport,
resource hooks, Explorer, Inspector, viewport selection, and verification all
ship together. A frontend-only synthetic branch is not an acceptable partial
implementation.
