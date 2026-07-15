# Boundary Faces Explorer and Inspector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a generation-safe Boundary Faces branch under Universe with authoritative backend boundary sets and face descriptors, dedicated Inspector panels, and viewport selection/highlighting.

**Architecture:** A new revisioned JSON resource publishes semantic boundary sets while bounded list/detail resources expose individual realized faces. A backend-owned topology index is cached by topology fingerprint; frontend server state remains in resource hooks, selection stores only generation-scoped identity, Explorer lists sets rather than triangles, and the viewport continues to use binary topology for rendering.

**Tech Stack:** Rust/Axum/Utoipa, Fullmag v2 OpenAPI, TypeScript/React 19, generated openapi-typescript transport, resource hooks, Vitest, React Three Fiber/Three.js, Playwright browser smoke.

## Global Constraints

- `Boundary Faces` is a first-class child of `Universe`, parallel in layout but not semantically equivalent to Airbox.
- Never create one Explorer node or one Three.js object per raw boundary face.
- A face identity is `mesh_id + generation_id + topology_fingerprint + boundary_face_index`.
- Missing FEM mesh returns `204`; `404` means no active workspace and is never retried.
- Components use generated v2 transport and resource hooks; no direct `fetch()` or hand-built endpoint strings.
- Heavy topology stays on the binary data plane.
- Frontend must not infer ownership, markers, conditions, or boundary sets from scene order, labels, or marker zero.
- Visualization settings are presentation-only and do not mutate ProblemIR or physics.
- Preserve unrelated dirty-worktree changes; before every commit run `git diff --cached --name-only` separately and commit only task files.

---

## File structure

**Backend resource ownership**

- Create `crates/fullmag-api/src/boundary_face_index.rs`: bounded topology-fingerprint cache and pure construction/query functions.
- Modify `crates/fullmag-api/src/types.rs`: add `boundary_face_index_store` to `AppState`.
- Modify `crates/fullmag-api/src/schemas/mesh.rs`: boundary capability, set, summary, page, and face descriptor schemas.
- Create `crates/fullmag-api/src/router_v2/handlers/meshing/boundaries.rs`: three typed GET handlers.
- Modify `crates/fullmag-api/src/router_v2/handlers/meshing/mod.rs`, `crates/fullmag-api/src/router_v2/mod.rs`, and `crates/fullmag-api/src/openapi.rs`: handler exports, routes, and OpenAPI schemas.
- Modify `crates/fullmag-api/src/router_v2/tests.rs`: HTTP contract, ETag, pagination, ownership, and absence tests.

**Frontend resource and state boundaries**

- Modify generated `apps/control-room/src/kernel/api/generated/openapi-v2.json` and `openapi-v2-types.ts` only through the existing generator.
- Modify `apps/control-room/src/kernel/api/apiPaths.ts`, `apiTypes.ts`, and `ControlRoomApi.ts`: typed facade.
- Modify `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`: boundary summary/page/detail resource hooks.
- Modify `apps/control-room/src/kernel/selection/selectionTypes.ts`: generation-scoped boundary selection variants and equality.
- Create `apps/control-room/src/kernel/selection/boundaryFaceSelection.ts`: validity and invalidation helpers.

**Explorer, Inspector, viewport**

- Create `apps/control-room/src/modules/explorer/builders/buildBoundaryFacesNodes.ts` and test.
- Modify `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`, `explorerTypes.ts`, and `ExplorerModule.tsx`.
- Create `apps/control-room/src/modules/inspector/panels/boundary-faces/` model, shared display, overview, set, mesh, statistics, quality, topology, faces-table, face-detail, and visualization panels with focused tests.
- Modify `apps/control-room/src/modules/inspector/inspectorRegistry.tsx` and registry tests.
- Modify `apps/control-room/src/modules/viewport-3d/viewport3dSelection.ts`, `Viewport3DModule.tsx`, `layers/MeshPartLayer.tsx`, and `layers/FallbackTopologyMeshLayer.tsx`, extending their existing triangle-picking and indexed-geometry ownership.

---

### Task 1: Record the architecture decision

**Files:**
- Create: `docs/adr/0019-boundary-faces-resource-and-selection.md`
- Modify: `docs/adr/README.md` if it contains the canonical ADR index
- Test: `scripts/ci-resource-first-gates.sh`

**Interfaces:**
- Consumes: approved design `docs/superpowers/specs/2026-07-15-boundary-faces-explorer-inspector-design.md`.
- Produces: the binding distinction between authored geometry, Airbox, semantic boundary sets, and generation-scoped face indices.

- [ ] **Step 1: Write the ADR**

Use the sections `Context`, `Decision`, `Consequences`, `Implementation obligations`, `Migration`, and `Verification`. State these exact decisions:

```markdown
- Explorer exposes semantic boundary sets, not raw topology triangles.
- JSON publishes revisioned semantics; binary topology remains the heavy data plane.
- Face selection is invalid across a generation or topology-fingerprint change.
- Absence of a realized FEM mesh is HTTP 204.
- No frontend inference may replace missing backend ownership.
```

- [ ] **Step 2: Run the architecture/resource gate**

Run: `just resource-first-gates strict`

Expected: `Resource-first gates passed.`

- [ ] **Step 3: Commit only the ADR**

```bash
git add docs/adr/0019-boundary-faces-resource-and-selection.md docs/adr/README.md
git diff --cached --name-only
git commit -m "docs: define boundary face resource semantics"
```

Expected staged paths: only the ADR and ADR index when the index exists.

---

### Task 2: Build the backend boundary index and schemas

**Files:**
- Create: `crates/fullmag-api/src/boundary_face_index.rs`
- Modify: `crates/fullmag-api/src/lib.rs`
- Modify: `crates/fullmag-api/src/types.rs`
- Modify: every `AppState` constructor in `crates/fullmag-api/src/main.rs`, `session.rs`, and `router_v2/tests.rs`
- Modify: `crates/fullmag-api/src/schemas/mesh.rs`
- Test: `crates/fullmag-api/src/boundary_face_index.rs`

**Interfaces:**
- Consumes: `FemMeshPayload.positions`, `elements`, `boundary_faces`, `boundary_markers`, `mesh_parts`, `mesh_id`, `generation_id`, and `fullmag_runner::fem_mesh_topology_fingerprint`.
- Produces:

```rust
pub(crate) struct BoundaryFaceIndexStore;

impl BoundaryFaceIndexStore {
    pub async fn get_or_build(
        &self,
        mesh: &FemMeshPayload,
        topology_fingerprint: &str,
    ) -> Arc<BoundaryFaceIndex>;
}

pub(crate) struct BoundaryFaceIndex {
    pub topology_fingerprint: String,
    pub faces: Vec<BoundaryFaceDescriptorRecord>,
    pub sets: Vec<BoundarySetRecord>,
}
```

- [ ] **Step 1: Write failing pure-index tests**

Add tests for a two-tetrahedron fixture asserting:

```rust
assert_eq!(index.faces[0].parent_element_index, Some(0));
assert_eq!(index.faces[0].marker, 10);
assert_eq!(index.faces[0].node_indices, [0, 1, 2]);
assert!(index.faces[0].area_m2 > 0.0);
assert_eq!(index.sets.iter().find(|set| set.marker == 10).unwrap().face_count, 1);
assert_eq!(index.owner_for_face(0).part_id.as_deref(), Some("part:film"));
```

Add a cache test proving the same fingerprint returns the same `Arc`, a changed fingerprint rebuilds, and the store retains at most two generations.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p fullmag-api boundary_face_index --no-default-features`

Expected: compilation failure because `BoundaryFaceIndexStore` and records do not exist.

- [ ] **Step 3: Implement the minimal index**

Build a sorted-triangle lookup from every tetrahedron face to `(element_index, local_face_index)`. For each published boundary face:

```rust
let key = sorted_face(face);
let parent = tetra_face_owners.get(&key).and_then(|owners| {
    (owners.len() == 1).then_some(owners[0])
});
```

Compute centroid, area, and outward normal from positions and parent-element centroid. Resolve part ownership only from `MeshPartResource` ranges/explicit `boundary_face_indices`; conflicting owners produce `None` plus a degraded reason. Group sets by backend marker and publish stable IDs `marker:<u32>`. Store only the two newest fingerprint entries behind `tokio::sync::RwLock`.

- [ ] **Step 4: Add exact OpenAPI schemas**

Define:

```rust
pub struct MeshBoundaryCapabilitiesResource {
    pub face_listing: bool,
    pub face_inspection: bool,
    pub face_picking: bool,
    pub visualization: bool,
}

pub struct MeshBoundarySetResource {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub marker_ids: Vec<u32>,
    pub face_count: u64,
    pub part_ids: Vec<String>,
    pub object_ids: Vec<String>,
    pub region_ids: Vec<String>,
    pub boundary_condition_ref: Option<String>,
    pub periodic_pair_ids: Vec<String>,
    pub area_m2: Option<f64>,
}

pub struct MeshBoundariesResource {
    pub revision: u64,
    pub mesh_id: String,
    pub generation_id: Option<String>,
    pub topology_fingerprint: String,
    pub boundary_face_count: u64,
    pub boundary_sets: Vec<MeshBoundarySetResource>,
    pub capabilities: MeshBoundaryCapabilitiesResource,
}

pub struct MeshBoundaryFaceDescriptorResource {
    pub mesh_id: String,
    pub generation_id: Option<String>,
    pub topology_fingerprint: String,
    pub boundary_face_index: u32,
    pub marker: u32,
    pub boundary_set_ids: Vec<String>,
    pub node_indices: [u32; 3],
    pub vertices_m: [[f64; 3]; 3],
    pub centroid_m: [f64; 3],
    pub normal: [f64; 3],
    pub area_m2: f64,
    pub parent_element_index: Option<u32>,
    pub part_id: Option<String>,
    pub object_id: Option<String>,
    pub region_id: Option<String>,
    pub boundary_condition_ref: Option<String>,
    pub periodic_pair_id: Option<String>,
    pub status: String,
    pub reason: Option<String>,
}
```

The page schema contains `items`, `offset`, `limit`, `total`, and the same mesh identity fields.

- [ ] **Step 5: Run focused backend tests**

Run: `cargo test -p fullmag-api boundary_face_index --no-default-features`

Expected: all index/cache/schema unit tests pass.

- [ ] **Step 6: Commit the index slice**

```bash
git add crates/fullmag-api/src/boundary_face_index.rs crates/fullmag-api/src/lib.rs crates/fullmag-api/src/types.rs crates/fullmag-api/src/main.rs crates/fullmag-api/src/session.rs crates/fullmag-api/src/router_v2/tests.rs crates/fullmag-api/src/schemas/mesh.rs
git diff --cached --name-only
git commit -m "feat(api): index realized boundary faces"
```

---

### Task 3: Publish boundary summary, page, and detail resources

**Files:**
- Create: `crates/fullmag-api/src/router_v2/handlers/meshing/boundaries.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/meshing/mod.rs`
- Modify: `crates/fullmag-api/src/router_v2/mod.rs`
- Modify: `crates/fullmag-api/src/openapi.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: `BoundaryFaceIndexStore::get_or_build` and schemas from Task 2.
- Produces:

```text
GET /v2/sessions/current/meshing/meshes/shared-domain/boundaries
GET /v2/sessions/current/meshing/meshes/shared-domain/boundary-faces?offset=0&limit=100&boundary_set_id=marker:10
GET /v2/sessions/current/meshing/meshes/shared-domain/boundary-faces/{face_index}
```

- [ ] **Step 1: Write failing router tests**

Cover these exact outcomes:

```rust
// active workspace, no fem mesh
assert_eq!(response.status(), StatusCode::NO_CONTENT);

// realized mesh
assert_eq!(body["boundary_face_count"], 2);
assert_eq!(body["boundary_sets"][0]["id"], "marker:10");

// bounded list
assert_eq!(body["limit"], 1);
assert_eq!(body["items"].as_array().unwrap().len(), 1);

// invalid index
assert_eq!(response.status(), StatusCode::NOT_FOUND);
```

Also assert ETag/304 and that `limit=0` or `limit=1001` returns 422. Use maximum `limit=500`.

- [ ] **Step 2: Run tests and verify RED**

Run: `cargo test -p fullmag-api router_v2::tests::mesh_boundary --no-default-features`

Expected: 404 route-not-found failures.

- [ ] **Step 3: Implement handlers**

Use a typed query:

```rust
#[derive(Deserialize, IntoParams)]
pub struct BoundaryFacePageQuery {
    #[param(minimum = 0)]
    pub offset: Option<u32>,
    #[param(minimum = 1, maximum = 500)]
    pub limit: Option<u16>,
    pub boundary_set_id: Option<String>,
    pub marker: Option<u32>,
}
```

Read the current snapshot once, return 204 before index construction when `fem_mesh` is absent, and use `stable_strong_etag` from the mesh generation/fingerprint/query tuple. Reject a generation mismatch if optional `generation_id`/`topology_fingerprint` query guards do not match current mesh.

- [ ] **Step 4: Register paths and OpenAPI schemas**

Add all three routes to `build_v2_router`, all handlers to `ApiDoc`, and all new schemas to Utoipa components. Do not manually edit generated frontend artifacts in this step.

- [ ] **Step 5: Run backend and OpenAPI tests**

Run:

```bash
cargo test -p fullmag-api mesh_boundary --no-default-features
cargo test -p fullmag-api openapi --no-default-features
```

Expected: all boundary HTTP tests and OpenAPI snapshot/path tests pass.

- [ ] **Step 6: Commit published resources**

```bash
git add crates/fullmag-api/src/router_v2/handlers/meshing/boundaries.rs crates/fullmag-api/src/router_v2/handlers/meshing/mod.rs crates/fullmag-api/src/router_v2/mod.rs crates/fullmag-api/src/openapi.rs crates/fullmag-api/src/router_v2/tests.rs
git diff --cached --name-only
git commit -m "feat(api): publish boundary face resources"
```

---

### Task 4: Generate and expose the frontend resource facade

**Files:**
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Modify: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`
- Test: `apps/control-room/src/kernel/resources/geometryLifecycleResources.test.ts`

**Interfaces:**
- Consumes: OpenAPI operations from Task 3.
- Produces:

```ts
api.meshing.sharedDomain.boundaries(options)
api.meshing.sharedDomain.boundaryFaces({ offset, limit, boundarySetId, marker }, options)
api.meshing.sharedDomain.boundaryFace(faceIndex, { generationId, topologyFingerprint }, options)

useMeshBoundariesResource({ enabled })
useMeshBoundaryFacesResource(query, { enabled })
useMeshBoundaryFaceResource(identity, { enabled })
```

- [ ] **Step 1: Write failing facade tests**

Assert generated paths, encoded query parameters, `204 -> null`, ETag propagation, and that 404 is terminal with one request. Add a resource-hook model test proving `enabled: false` performs zero loads.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts src/kernel/resources/geometryLifecycleResources.test.ts
```

Expected: missing facade/path/hook failures.

- [ ] **Step 3: Regenerate OpenAPI artifacts**

Run `pnpm --dir apps/control-room generate:api`. Do not hand-edit generated files. Verify all three boundary paths appear in both artifacts.

- [ ] **Step 4: Implement paths, facade, and hooks**

Use `openApiV2Path(...)`, the generated transport, and resource keys that include mesh identity plus normalized query. `resolveRevision` returns a tuple/token derived from `revision`, `generation_id`, and `topology_fingerprint`; it must not use `JSON.stringify` on face arrays.

- [ ] **Step 5: Run facade/resource tests and gates**

Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/api/ControlRoomApi.test.ts src/kernel/resources/geometryLifecycleResources.test.ts
just resource-first-gates strict
```

Expected: focused tests pass and resource-first gates pass.

- [ ] **Step 6: Commit transport slice**

Stage only the generated artifacts, API facade/path/types, hooks, and their tests. Commit with:

```bash
git commit -m "feat(control-room): add boundary face resources"
```

---

### Task 5: Add generation-safe boundary selection and Explorer tree

**Files:**
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Create: `apps/control-room/src/kernel/selection/boundaryFaceSelection.ts`
- Test: `apps/control-room/src/kernel/selection/boundaryFaceSelection.test.ts`
- Create: `apps/control-room/src/modules/explorer/builders/buildBoundaryFacesNodes.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildBoundaryFacesNodes.test.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`

**Interfaces:**
- Consumes: `MeshBoundariesResource | null` and session mesh/generation revisions.
- Produces selection variants `type: "boundary-faces"` with kinds defined in the approved spec and:

```ts
export interface BoundaryFaceIdentity {
  meshId: string;
  generationId: string | null;
  topologyFingerprint: string;
  boundaryFaceIndex: number;
}

export function isBoundaryFaceIdentityCurrent(
  identity: BoundaryFaceIdentity,
  resource: MeshBoundariesResource | null,
): boolean;
```

- [ ] **Step 1: Write failing selection tests**

Prove equal identity compares equal; changed mesh ID, generation, fingerprint, or index compares unequal; and a changed generation invalidates the selected face.

- [ ] **Step 2: Write failing tree tests**

Assert the exact fixed child order:

```ts
expect(boundaryFaces.children?.map(({ id }) => id)).toEqual([
  "model:boundary-faces:overview",
  "model:boundary-faces:sets",
  "model:boundary-faces:mesh",
  "model:boundary-faces:faces",
  "model:boundary-faces:visualization",
]);
```

Assert no-mesh status is `unavailable`, two published sets create exactly two set nodes, and a resource with `boundary_face_count: 1_000_000` still creates zero raw-face child nodes.

- [ ] **Step 3: Run tests and verify RED**

Run the two new test files plus `buildModelTree.test.ts`. Expected: missing selection variants and missing `model:boundary-faces`.

- [ ] **Step 4: Implement selection and pure tree builder**

Keep `buildBoundaryFacesNodes` pure. The root is always present under Universe. Create set children only from `boundary_sets`; label and status come from the backend resource. Put the three mesh children `statistics`, `quality`, and `topology` under `model:boundary-faces:mesh`.

- [ ] **Step 5: Connect Explorer through resource hooks**

Enable `useMeshBoundariesResource` only through `shouldLoadRuntimeMeshManifest(modelTabActive, sessionStatusData)`. Pass data/status into the pure builder; never copy the response into Explorer store state.

- [ ] **Step 6: Run focused tests, typecheck, and lint**

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/selection/boundaryFaceSelection.test.ts src/modules/explorer/builders/buildBoundaryFacesNodes.test.ts src/modules/explorer/builders/buildModelTree.test.ts
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Expected: all pass with zero lint warnings.

- [ ] **Step 7: Commit selection and Explorer slice**

Stage only Task 5 files, inspect the staged list separately, and commit:

```bash
git commit -m "feat(control-room): add boundary faces explorer tree"
```

---

### Task 6: Implement dedicated Boundary Faces inspectors

**Files:**
- Create: `apps/control-room/src/modules/inspector/panels/boundary-faces/boundaryFacesInspectorModel.ts`
- Create: `apps/control-room/src/modules/inspector/panels/boundary-faces/boundaryFacesInspectorModel.test.ts`
- Create: `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesPanels.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesPanels.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesTable.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/boundary-faces/BoundaryFacesTable.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorRegistry.test.ts`

**Interfaces:**
- Consumes: boundary summary/page/detail hooks and boundary selection variants.
- Produces one Inspector contribution for every selection kind in the approved spec.

- [ ] **Step 1: Write failing model tests**

Prove model functions preserve SI units, distinguish `unavailable`, `stale`, `degraded`, and `ready`, reject a detail whose topology fingerprint differs from selection, and never substitute guessed ownership.

- [ ] **Step 2: Write failing registry/render tests**

For every kind, assert `resolveInspectorPanel(kind)` returns its dedicated Boundary Faces component. Render overview, set, topology, table, and face detail with fixtures. Assert the table renders at most the requested page and exposes Next/Previous controls without placing the full result in React state.

- [ ] **Step 3: Run tests and verify RED**

Run the three Inspector test files. Expected: missing panels/registry contributions.

- [ ] **Step 4: Implement panels with shared primitives**

Use existing `Accordion`, `InspectorSection`, shared buttons/selects, and `--fm-*` styling. The Faces panel owns only `offset`, `limit`, marker/set filters, and selected row identity. Resource hooks own response data. The Face panel requests detail only when identity matches the current boundary summary.

- [ ] **Step 5: Implement presentation-only visualization controls**

Use the existing visualization controller with a canonical boundary scope ID. Controls: visible, isolate, opacity, filled/wireframe, color by set/marker/condition/ownership, and selection highlight. Do not add physics transactions.

- [ ] **Step 6: Run Inspector tests, typecheck, and lint**

Expected: all focused tests, typecheck, and lint pass.

- [ ] **Step 7: Commit Inspector slice**

```bash
git commit -m "feat(control-room): inspect boundary faces"
```

after staging and separately verifying only Task 6 paths.

---

### Task 7: Connect viewport picking and bounded highlighting

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dSelection.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dSelection.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.test.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Test: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.test.ts`

**Interfaces:**
- Consumes: `BoundaryFaceIdentity`, current boundary summary identity, binary topology face index, and boundary visualization settings.
- Produces `viewportSelectionForBoundaryFace(...)` and one bounded highlight draw range/buffer.

- [ ] **Step 1: Lock the existing picking ownership with source tests**

Assert `MeshPartLayer.tsx` continues to call `resolveMeshPartBoundaryFaceIndexForPick`, `FallbackTopologyMeshLayer.tsx` continues to call `resolveFemPartSelectionByBoundaryFace`, and `Viewport3DModule.tsx` remains the single adapter from part hits to kernel selection. These tests prevent implementation from creating a second picking path or layer.

- [ ] **Step 2: Write failing viewport selection tests**

Given face index 12 and current mesh identity, assert selection kind `boundary-faces.face`, node ID `model:boundary-faces:faces:12`, and the complete generation-scoped reference. Assert absence of current mesh identity returns the existing mesh-part selection instead of an invalid face selection.

- [ ] **Step 3: Write failing render tests**

Prove marker/set isolation filters indexed triangles without one object per face; selected face produces one highlight draw range; changed topology fingerprint drops the highlight; and idle settings do not schedule frames.

- [ ] **Step 4: Run tests and verify RED**

Run selection, render-model/layer, and module tests. Expected: missing boundary selection/highlight behavior.

- [ ] **Step 5: Implement using the existing mesh layer**

Translate the R3F intersection triangle index to the canonical boundary face index already used by topology. Create/reuse one highlight geometry or draw range. Boundary-set filtering uses backend-published marker/set membership and the existing typed topology arrays; it must not scan or allocate while the feature is hidden.

- [ ] **Step 6: Verify focused viewport behavior**

Run all touched viewport tests and `pnpm --dir apps/control-room typecheck`. Expected: pass.

- [ ] **Step 7: Commit viewport slice**

```bash
git commit -m "feat(control-room): select boundary faces in viewport"
```

after staged-path inspection.

---

### Task 8: Production verification and documentation sync

**Files:**
- Modify: `docs/specs/resource-first-control-room-api-v2.md`
- Modify: `docs/specs/frontend-v2/02-module-catalog.md`
- Modify: `docs/superpowers/plans/2026-07-15-boundary-faces-explorer-inspector.md` checkboxes only

**Interfaces:**
- Consumes: completed Tasks 1-7.
- Produces: evidence-backed completion with no stale contract documentation.

- [ ] **Step 1: Run backend formatting and focused tests**

```bash
cargo fmt --all -- --check
cargo test -p fullmag-api boundary_face --no-default-features
```

Expected: pass. If unrelated dirty-worktree compilation blocks the crate, capture the exact file/line and do not modify unrelated code silently.

- [ ] **Step 2: Run frontend production gates**

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
just resource-first-gates strict
```

Expected: zero TypeScript errors, zero ESLint warnings, all Vitest files pass, resource-first gates pass.

- [ ] **Step 3: Run React Doctor on changed code**

```bash
cd apps/control-room
npx -y react-doctor@latest . --verbose --scope changed
```

Classify findings as introduced, pre-existing, false positive, or needs separate work. Fix introduced high-confidence errors only; do not mass-refactor unrelated dirty files.

- [ ] **Step 4: Run browser verification**

Use a controlled fixture with at least two boundary markers and one selected face. Assert:

```text
Boundary Faces exists beside Airbox
raw face count does not expand Explorer children
Faces table is bounded
selecting a row highlights exactly one face
canvas visible
gl.isContextLost() == false
drawingBufferWidth > 0 && drawingBufferHeight > 0
no unexpected 404 request
```

Capture one screenshot showing Explorer, selected face, viewport highlight, and Face Inspector.

- [ ] **Step 5: Update canonical docs**

Document the three resources, 204 semantics, generation-scoped selection, and control/data-plane split. Do not claim boundary-condition authoring if it remains read-only.

- [ ] **Step 6: Run final diff checks**

```bash
git diff --check
git status --short
```

Review every changed line against the approved feature and preserve unrelated modifications.

- [ ] **Step 7: Commit verification/docs only**

```bash
git add docs/specs/resource-first-control-room-api-v2.md docs/specs/frontend-v2/02-module-catalog.md docs/superpowers/plans/2026-07-15-boundary-faces-explorer-inspector.md
git diff --cached --name-only
git commit -m "docs: document boundary face inspection"
```

Expected: only the three documentation paths are staged.
