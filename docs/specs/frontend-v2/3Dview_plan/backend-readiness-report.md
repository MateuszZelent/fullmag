# Backend Readiness Report — 3D Viewport Phase 5

**Date:** 2026-05-11
**Scope:** Does the Rust backend need changes to support the new frontend 3D viewport?
**Verdict:** The backend is **ready for Phase 5a viewport integration** after the 2026-05-11 backend pass. Remaining items are P1/P2 extensions, not blockers for the first 3D viewport.

---

## 1. Executive Summary

The backend already serves all the fundamental data the 3D viewport needs:

| Data | Backend endpoint | Format | Status |
|---|---|---|---|
| FEM nodes (positions) | `GET /data/domain/topology` | FMMT binary | ✅ Ready |
| FEM elements (tet indices) | `GET /data/domain/topology` | FMMT binary | ✅ Ready |
| FEM boundary faces | `GET /data/domain/topology` | FMMT binary | ✅ Ready |
| FEM element/boundary markers | `GET /data/domain/topology` | FMMT binary | ✅ Ready |
| FEM object/part/airbox mapping | `GET /meshing/meshes/shared-domain/manifest` | JSON | ✅ Ready |
| FEM per-object topology | `GET /meshing/meshes/objects/{id}/topology` | FMMT binary | ✅ Ready |
| FEM per-part topology | `GET /meshing/meshes/parts/{id}/topology` | FMMT binary | ✅ Ready |
| FDM grid shape + physical spacing/bounds | `GET /data/domain/meta` | JSON | ✅ Ready |
| Field vectors (all quantities) | `GET /data/fields/{id}/samples/vector` | FMVP binary | ✅ Ready |
| Field scoping (object/part/airbox/selection) | `scope_kind` + `scope_id` query params | FMVP binary | ✅ Ready |
| Visualization state | `GET /visualization/state` | JSON | ✅ Ready |
| Scene objects | `GET /model/scene` | JSON | ✅ Ready |
| Universe / airbox config | `GET /model/universe` | JSON | ✅ Ready |
| ETag + 304 caching | `If-None-Match` / `conditional_binary_response` | Headers + OpenAPI | ✅ Ready |
| 204 for FDM topology | `GET /data/domain/topology` returns 204 | Status code | ✅ Ready |
| Viewport resource invalidation | `resource.batch_changed.recommended_fetch` | WebSocket event metadata | ✅ Ready |

**The new frontend can build the complete mesh visualization from the data the backend already serves.** For FEM, the FMMT binary contains positions, elements, boundary faces, and markers — that's everything needed to render the boundary surface of a tetrahedral mesh. For FDM, the grid metadata provides shape, which together with field values is enough to render instanced cuboids.

---

## 2. What the FMMT binary actually contains

The FMMT topology codec (`crates/fullmag-api/src/field_store.rs:44-91`) serializes `FemMeshPayload` into:

```
Header (32 bytes):
  [0..4]   magic "FMMT"
  [4]      version = 1
  [5]      kind = 1 (f64+u32)
  [6..8]   padding
  [8..12]  node_count (u32 LE)
  [12..16] element_count (u32 LE)
  [16..20] boundary_face_count (u32 LE)
  [20..24] element_marker_count (u32 LE)
  [24..28] boundary_marker_count (u32 LE)
  [28..32] reserved

Data:
  positions:        node_count × 3 × f64   (XYZ per node, SI meters)
  indices:          element_count × 4 × u32 (tet vertex indices)
  boundary_faces:   boundary_face_count × 3 × u32 (triangle vertex indices)
  element_markers:  element_marker_count × u32
  boundary_markers: boundary_marker_count × u32
```

The frontend `topologyCodec.ts` decodes this into `DecodedTopology`:
- `positions: Float64Array` — node coordinates in SI meters
- `indices: Uint32Array` — tetrahedral element connectivity (4 vertices per tet)
- `boundaryFaces: Uint32Array` — boundary triangle connectivity (3 vertices per face)
- `elementMarkers: Uint32Array`
- `boundaryMarkers: Uint32Array`

**This is sufficient to build the 3D mesh visualization.** `boundaryFaces` gives the visible surface triangles of the tet mesh, and `positions` gives node coordinates. The FEM adapter uses `buildFemBoundaryGeometry()` to create a `THREE.BufferGeometry` directly from these arrays.

---

## 3. What the FMVP binary contains for field data

The FMVP field codec (`crates/fullmag-api/src/field_store.rs:11-42`) serializes field values:

```
Header (48 bytes):
  [0..4]   magic "FMVP"
  [4]      version = 2
  [5]      kind = 1 (f64)
  [6]      nComp (1 for scalar, 3 for vector)
  [7]      padding
  [8..12]  reserved
  [12..16] value_count (u32 LE)
  [16..20] grid_x (u32 LE)
  [20..24] grid_y (u32 LE)
  [24..28] grid_z (u32 LE)
  [28..44] quantity_id (UTF-8 padded to 16 bytes)
  [44..48] reserved

Data:
  values: value_count × f64
```

Decoded into `DecodedFieldVector`:
- `values: Float64Array` — interleaved `[mx,my,mz, mx,my,mz, ...]` for vectors
- `grid: [nx, ny, nz]` — grid dimensions
- `nComp: number` — components per point (3 for vector, 1 for scalar/magnitude)
- `quantityId: string`
- `pointCount: number`

**For FEM:** `pointCount == node_count`. Values are per-node. Color mapping applies per-vertex colors.
**For FDM:** `pointCount == cell_count`. Values are per-cell. Color mapping applies per-instance colors.

The backend already supports `component` query param (`full`, `magnitude`, `x`, `y`, `z`) and `scope_kind` + `scope_id` for scoped field fetching.

---

## 4. Object/part/airbox mapping is already served

`MeshSharedDomainManifestResource` (from `GET /meshing/meshes/shared-domain/manifest`) contains:

```typescript
mesh_parts: MeshPartResource[] = [{
  id: string,
  label: string,
  role: "air" | "magnetic_object" | "interface" | "outer_boundary",
  object_id: string | null,
  geometry_id: string | null,
  material_id: string | null,
  boundary_face_start: number,
  boundary_face_count: number,
  boundary_face_indices: number[],
  node_start: number,
  node_count: number,
  node_indices: number[],
  surface_faces: number[][],
  bounds_min: number[] | null,
  bounds_max: number[] | null,
}]
```

This is exactly what the FEM adapter needs:
- `role == "air"` → airbox part
- `role == "magnetic_object"` → magnetic object part
- `object_id` → links to scene object
- `boundary_face_start` + `boundary_face_count` → which boundary faces belong to this part
- `surface_faces` → explicit surface triangles for this part

**No backend change needed for object/part/airbox identification.**

---

## 5. P0: FDM physical spacing

**Status after implementation:** done.

`GET /v2/sessions/current/data/domain/meta` now reads FDM `cell_size` from `snapshot.metadata.artifact_layout.cell_size` when `artifact_layout.backend == "fdm"`. It returns:

- `grid.spacing` in SI meters,
- `grid.origin = [0, 0, 0]`,
- `bounds.max = origin + grid_shape * spacing`.

The regression test is `domain_meta_uses_fdm_physical_cell_size_for_grid_and_bounds` in `crates/fullmag-api/src/router_v2/tests.rs`.

### Historical issue

In `crates/fullmag-api/src/router_v2/handlers/data/domain.rs:77-85`:

```rust
let grid = if !is_fem && grid_shape.iter().any(|v| *v > 0) {
    Some(StructuredGridDescriptor {
        shape: grid_shape,
        origin: [0.0, 0.0, 0.0],
        spacing: [1.0, 1.0, 1.0],  // ← HARDCODED
    })
} else {
    None
};
```

And bounds are also hardcoded to grid-index space:

```rust
Bounds3 {
    min: [0.0, 0.0, 0.0],
    max: [
        grid_shape[0] as f64,
        grid_shape[1] as f64,
        grid_shape[2] as f64,
    ],
}
```

The actual physical cell size is available in `FdmPlanIR.cell_size: [f64; 3]` (SI meters), but the domain meta handler doesn't have access to it. The `SessionStateResponse` / `current_live_state` snapshot stores the live step data but not the original plan.

### Impact

Without physical spacing:
- FDM cuboids render in grid-index space, not physical space
- Aspect ratio is wrong (a 100nm × 100nm × 5nm sample looks cubic)
- Axis labels, bounds box, and hover coordinates are unitless
- Mixed FDM+FEM comparison is impossible (different coordinate systems)

### Implemented fix

The current live metadata already carries `artifact_layout.cell_size` from the planned FDM layout. `DomainMeta` now serves that value:

```rust
StructuredGridDescriptor {
    shape: grid_shape,
    origin: [origin_x, origin_y, origin_z],  // typically [0, 0, 0]
    spacing: [cell_size_x, cell_size_y, cell_size_z],  // SI meters
}
```

And update bounds accordingly:

```rust
Bounds3 {
    min: [origin_x, origin_y, origin_z],
    max: [
        origin_x + grid_shape[0] as f64 * cell_size_x,
        origin_y + grid_shape[1] as f64 * cell_size_y,
        origin_z + grid_shape[2] as f64 * cell_size_z,
    ],
}
```

No renderer may treat FDM grid index coordinates as physical coordinates when this metadata is present.

---

## 6. P1: Improvements (not blockers)

### P1.1 FDM active mask in domain meta

`FdmPlanIR.active_mask: Option<Vec<bool>>` tells which cells are geometry-active vs void. The 3D viewport needs this to render only the physical cells. Currently this is not exposed via `DomainMeta` or any domain endpoint.

**Option A:** Add `active_mask` as a separate binary endpoint (e.g., `GET /data/domain/active-mask` returning a compact bitfield or boolean array).

**Option B:** Include `has_active_mask: bool` in `DomainMeta` and add the mask to `StructuredGridDescriptor` or a companion resource.

**Frontend workaround until fixed:** Render all cells and check field values for zero-magnitude vectors to infer inactive cells. Works for magnetization but loses accuracy for other quantities.

### P1.2 FDM region mask

`FdmPlanIR.region_mask: Vec<u32>` assigns each cell to a material region. This is analogous to FEM element markers. Not currently exposed through any API endpoint. Needed for:
- Per-object coloring in multi-material FDM simulations
- Object picking in FDM (currently the plan says "render as one magnetic domain and report degraded object picking")

**Effort:** Small. Add as a binary resource or include in `DomainMeta`.

### P1.3 FMMT version 2 with boundary-face-to-element mapping

The current FMMT v1 binary does not include a mapping from boundary faces back to their parent tetrahedral elements. For Phase 5 this is explicitly deferred (field-value probing requires this mapping). When probing is implemented:

The backend would need to add to FMMT v2:
- `boundary_face_element_map: Vec<u32>` — for each boundary face, the index of the parent element

**Not a blocker for Phase 5.** The plan explicitly defers probing.

### P1.4 OpenAPI `If-None-Match` header typing

**Status after implementation:** done for Phase 5 cacheable binary resources.

OpenAPI now declares optional `If-None-Match` header parameters for:

- `GET /v2/sessions/current/data/domain/topology`,
- `GET /v2/sessions/current/data/fields/{quantity_id}/samples/vector`,
- `GET /v2/sessions/current/meshing/meshes/shared-domain/topology`,
- `GET /v2/sessions/current/meshing/meshes/objects/{object_id}/topology`,
- `GET /v2/sessions/current/meshing/meshes/parts/{part_id}/topology`.

`pnpm --dir apps/control-room generate:api` regenerated `openapi-v2.json` and `openapi-v2-types.ts`; the generated operation parameter types no longer use `header?: never` for those operations.

### P1.5 Exact viewport invalidation

**Status after implementation:** done for Phase 5 resource hooks.

Realtime `resource.batch_changed` events now include exact `recommended_fetch` values for:

- `data/domain/topology`,
- full-domain field-vector resources for available 3D quantities,
- shared-domain manifest,
- shared-domain topology,
- per-object topology,
- per-part topology.

The frontend v2 invalidation controller also supports prefix invalidation, so the existing `/v2/sessions/current/data/fields` family event refreshes subscribed scoped field-vector resources.

---

## 7. What does NOT need backend changes

| Concern | Why no backend change needed |
|---|---|
| FEM mesh rendering | FMMT has positions + boundary faces — sufficient for surface rendering |
| FEM object/part/airbox mapping | `MeshSharedDomainManifestResource.mesh_parts` provides complete mapping |
| Field visualization (scalar + vector) | FMVP binary with `component` and `scope_kind` query params |
| Field scoping | Backend already supports `full`/`object`/`part`/`airbox`/`selection` scopes |
| ETag caching + 304 | `conditional_binary_response()` already implemented |
| 204 for FDM topology | `get_domain_topology()` returns 204 when `fem_mesh` is None |
| Visualization state | Layers, quantity, sampling, clip — all served via JSON |
| WebSocket invalidation | Exact `recommended_fetch` entries now cover viewport topology/field/mesh resources |
| Per-object/per-part topology | Endpoints exist: `/meshing/meshes/objects/{id}/topology`, `/meshing/meshes/parts/{id}/topology` |

---

## 8. Summary table

| # | Item | Priority | Backend change | Effort | Blocker? |
|---|---|---|---|---|---|
| 1 | FDM physical spacing in `DomainMeta` | P0 | Implemented from `artifact_layout.cell_size` | Done | No |
| 2 | FDM `active_mask` exposure | P1 | New binary endpoint or meta field | Small | No — workaround possible |
| 3 | FDM `region_mask` exposure | P1 | New binary endpoint or meta field | Small | No — single-domain rendering works |
| 4 | FMMT v2 with face→element map | P2 | New FMMT version with extra section | Medium | No — probing deferred |
| 5 | OpenAPI `If-None-Match` header params | P2 | Implemented for Phase 5 binary endpoints | Done | No |
| 6 | Exact viewport realtime invalidation | P1 | Implemented for topology, fields, manifest, object/part topology | Done | No |

**Bottom line:** Phase 5a no longer has a backend P0 blocker. Remaining backend work is quality/depth: FDM active/region masks and future probing support.
