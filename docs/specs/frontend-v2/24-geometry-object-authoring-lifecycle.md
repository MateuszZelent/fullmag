# Frontend v2 - Geometry Object Authoring Lifecycle

**Status:** Implementation plan
**Date:** 2026-05-12

## 1. Goal

The Geometry context must let the user add a new physical object to the canonical scene, inspect and edit its primitive parameters, transform it, and then rebuild the mesh that makes it usable by solver and field visualizations.

This workflow is not a local viewport feature. It is a synchronized authoring flow across:

- `SceneDocument` and v2 `model` transactions;
- mesh dirty state, mesh build commands, and mesh resources;
- explorer selection;
- inspector draft editing;
- Geometry and Mesh ribbon commands;
- 3D primitive/mesh visualization;
- future 2D slice/profile visibility rules.

## 2. Non-Negotiables

1. `SceneDocument` is the canonical scene source. The frontend must not create a second geometry graph in a module store.
2. A newly added object starts as a committed scene object with primitive realization, not as a solver mesh.
3. After object creation or geometry/transform edits, the object is mesh-stale until a successful mesh build proves that the mesh was generated from the same scene revision.
4. Primitive display and fallback wireframe are explicit visualization states for unmeshed geometry, not fake solver topology.
5. Mesh build is a backend command. The UI may request it and show progress, but it must not synthesize production mesh locally.
6. Explorer, inspector, ribbon, viewport, and future 2D modules use the same object id, selection ref, visualization target id, and resource revisions.
7. HTTP v2 resources remain source of truth. Realtime events invalidate resources only.

## 3. Current Backend Contract To Build On

The live v2 contract already exposes the necessary backbone:

| Purpose | Contract |
|---|---|
| Read canonical scene | `GET /v2/sessions/current/model/scene` |
| Replace or patch canonical scene | `PUT` / `PATCH /v2/sessions/current/model/scene` |
| Create object directly | `POST /v2/sessions/current/model/objects` |
| Patch/delete object directly | `PATCH` / `DELETE /v2/sessions/current/model/objects/{object_id}` |
| Commit authoring transaction | `POST /v2/sessions/current/model/transactions` |
| Patch object geometry | `PATCH /v2/sessions/current/model/objects/{object_id}/geometry` |
| Read geometry capabilities/validation/diagnostics | `/v2/sessions/current/model/geometry/*` |
| Read visualization state | `GET /v2/sessions/current/visualization/state` |
| Patch visualization state | `PATCH /v2/sessions/current/visualization/state` |
| Submit mesh build | `POST /v2/sessions/current/simulation/commands` with `kind: "mesh_build"` |
| Target object mesh build | `mesh_target: { kind: "object_mesh", object_id }` |
| Read mesh build progress | `GET /v2/sessions/current/meshing/builds/current` |
| Read shared-domain mesh manifest | `GET /v2/sessions/current/meshing/meshes/shared-domain/manifest` |
| Read object topology | `GET /v2/sessions/current/meshing/meshes/objects/{object_id}/topology` |
| Read object mesh report/quality/size-field | `/v2/sessions/current/meshing/meshes/objects/{object_id}/*` |

Frontend v2 still needs handwritten facade methods and resource hooks for most of these paths. Generated transport alone is not enough for module code.

Direct object mutation routes currently return the full committed `SceneDocument`; there is no `GET /v2/sessions/current/model/objects/{object_id}` read resource. Object refresh therefore comes from `model/scene` plus derived meshing/diagnostic resources.

## 4. Object Lifecycle

| State | Meaning | Owner | UI behavior |
|---|---|---|---|
| `draft-new` | User picked a primitive and is editing initial values before commit. | Inspector local draft. | Viewport may show a draft overlay. No explorer object exists yet unless the backend supports temporary draft resources. |
| `committing` | Create transaction was submitted. | Command/transaction adapter. | Disable duplicate submit, show pending state, keep draft visible. |
| `primitive-only` | Object exists in `SceneDocument`; no solver mesh for the object exists yet. | `model/scene`. | Select the new object, switch Geometry view preset to primitive display, show simplified wireframe fallback if wireframe is enabled. |
| `mesh-stale` | Object geometry, transform, material/region mesh-affecting data, or universe changed after last successful mesh build. | `model/scene` tags plus mesh build provenance. | Badge object and mesh controls as stale; allow primitive editing; enable `mesh.build-selected` and shared-domain build commands. |
| `mesh-building` | Backend mesh build command is running. | `simulation/commands` and `meshing/builds/current`. | Keep primitive display available; show progress and prevent treating old topology as current for the edited object. |
| `mesh-ready` | Mesh resources include the object for the current scene revision. | `meshing` resources. | 3D can render solver mesh/topology; object inspector links report, quality, and size-field resources. |
| `mesh-failed` | Last build failed or validation blocks mesh build. | `meshing/builds/current` and geometry diagnostics. | Keep primitive display, show the blocking diagnostic in inspector and mesh ribbon. |

`primitive-only` and `mesh-stale` are valid authoring states. They are not errors. Solver execution must still respect backend authoring gates and block runs when geometry realization or mesh state is invalid.

## 5. Add Object Flow

1. User enters the `Geometry` context and chooses a primitive command such as `geometry.add-box`, `geometry.add-cylinder`, `geometry.add-sphere`, or another backend-supported primitive.
2. The command opens or focuses the Geometry object inspector with a `draft-new` object form.
3. The draft contains object id/name, primitive type, dimensions, position, rotation, material reference, optional region name, magnetization reference, and mesh policy defaults where the current capability permits them.
4. The viewport shows a draft primitive overlay only from draft data. It is visibly marked as uncommitted and must not affect solver resources.
5. On Apply, the frontend submits the current OpenAPI-backed create path: either `POST /v2/sessions/current/model/transactions` using the `create_object` transaction shape or `POST /v2/sessions/current/model/objects` through the same facade layer. The request includes the current scene revision as `base_revision`.
6. If the backend rejects the transaction, the inspector keeps the draft and pins the error to the relevant field or section.
7. If the backend commits, the frontend invalidates `model/scene`, status/revision state, geometry diagnostics, visualization state where needed, and mesh summary/build resources.
8. The explorer selects the committed object id.
9. The 3D viewport switches the new object target to primitive display. It must not wait for mesh topology before showing the object.
10. The Mesh ribbon exposes `Build selected` for the object and explains that the current object has no current mesh.

## 6. Primitive Display And Fallback Wireframe

The new object cannot start in solver-mesh mode because no production mesh exists yet. The 3D viewport therefore needs two separate geometry inputs:

| Input | Source | Use |
|---|---|---|
| Primitive realization | `model/scene` plus geometry realization/capability adapters | Immediate authoring display for boxes, cylinders, spheres, imported primitives, and backend-supported primitive families. |
| Solver topology | `meshing/meshes/*/topology` and shared-domain manifest | Post-build mesh/field visualization. |

Primitive display rules:

- New committed objects default to primitive display in the Geometry context.
- Primitive display can render shaded primitive surfaces, bounds, transform handles, and selection highlights.
- Wireframe mode for an unmeshed object uses a simplified procedural wireframe derived from the primitive parameters and transform.
- The simplified wireframe must be visually labeled as primitive/fallback when the mesh is missing or stale.
- The fallback wireframe never supplies field sampling, mesh quality, finite-element topology, or solver provenance.
- When a current solver mesh exists, mesh mode can show object topology and the wireframe layer can use mesh edges.
- Switching primitive/wireframe/shaded display is a visualization change and must not rebuild topology.

## 7. Inspector Contract

The Geometry object inspector owns only drafts and form state. It reads committed data from `model/scene` and resource hooks.

Required sections:

- identity: object id, name, region name;
- primitive geometry: type-specific dimensions and SI units;
- transform: position, rotation, scale where supported;
- material/magnetization references;
- mesh status: primitive-only, stale, building, ready, failed;
- mesh policy link: jump to object mesh settings when available;
- diagnostics: geometry validation, realization blockers, mesh build errors;
- provenance: scene revision and last mesh build source scene revision when available.

Edits that affect geometry, transform, material mesh semantics, region mapping, universe bounds, or mesh policy require explicit transaction semantics. Safe visualization preferences can still auto-apply through `visualization/state`.

## 8. Explorer Contract

The explorer derives Geometry nodes from `model/scene`; it never owns object data.

Required object subtree:

```text
 Model
   + Objects
     + <object name>
       + Geometry
       + Material
       + Physics
       + Mesh
       + Visualization
```

Selection rules:

- selecting `<object name>` opens the Geometry object inspector by default in the Geometry context;
- selecting `Geometry` focuses primitive parameters and transform;
- selecting `Mesh` focuses object mesh settings or report;
- selecting `Visualization` focuses the target visualization panel for `object:<object_id>`;
- viewport picking emits the same object selection ref;
- deleting an object clears selection if the deleted object was selected.

Status badges:

- primitive-only;
- mesh stale;
- mesh building;
- mesh ready;
- mesh failed;
- validation blocked.

## 9. Ribbon And Command Contract

Commands are registered once and rendered by menu, ribbon, context menu, shortcuts, and command palette.

Required Geometry commands:

| Command id | Scope | Behavior |
|---|---|---|
| `geometry.add-box` | Geometry context | Opens new box draft; no server mutation until Apply. |
| `geometry.add-cylinder` | Geometry context | Opens new cylinder draft when capability is supported. |
| `geometry.add-sphere` | Geometry context | Opens new sphere draft when capability is supported. |
| `geometry.commit-object-draft` | Inspector draft | Submits create/patch transaction. |
| `geometry.delete-object` | Object selection | Submits delete transaction and clears stale selection. |
| `geometry.focus-primitive` | Object selection | Sets viewport preset to primitive display for selected object. |

Required Mesh commands:

| Command id | Scope | Behavior |
|---|---|---|
| `mesh.build-selected` | Object selection | Submits `kind: "mesh_build"` with `mesh_target: { kind: "object_mesh", object_id }` when the backend supports object-targeted build. |
| `mesh.build-shared-domain` | Mesh context | Submits shared-domain build when the current discretization requires one conforming solver mesh. |
| `mesh.open-object-report` | Object mesh node | Opens object mesh report/quality inspector. |

Button states must explain whether the command is disabled because of missing capability, missing object selection, pending transaction, stale scene revision, validation blocker, or running mesh build.

## 10. Backend Synchronization

The frontend implementation must add facade/resource coverage for:

- `model.scene()` and revision-aware `useSceneResource()`;
- `model.commitTransaction()` for create/patch/delete/rename/transform transactions;
- `model.geometryCapabilities()`, `model.geometryValidation()`, and `model.geometryDiagnostics()`;
- object mutation helpers for `/model/objects`, `/model/objects/{object_id}`, and `/model/objects/{object_id}/geometry`;
- mesh build command adapter for `kind: "mesh_build"`;
- `useMeshBuildCurrent()`, `useObjectTopology(objectId)`, `useObjectMeshReport(objectId)`, and `useObjectMeshQuality(objectId)`;
- visualization state hook with per-target object defaults.

Realtime resource changes invalidate these hooks. WebSocket payloads must not become the object or mesh source of truth.

## 11. 3D Viewport Contract

`viewport-3d` receives a domain-neutral render model containing both authoring primitive data and solver topology references.

Required render layers:

- primitive object surface;
- primitive fallback wireframe;
- solver object mesh surface;
- solver wireframe;
- transform gizmo/handles when enabled;
- selection highlight;
- stale/blocked overlay badge.

Layer precedence:

1. In Geometry context, an object with no current mesh renders from primitive realization.
2. In Mesh/Results contexts, a mesh-ready object may render solver topology by default.
3. A mesh-stale object may show previous mesh only if the UI marks it stale and keeps primitive display available.
4. Field/scalar/vector layers attach only to current solver topology and published field resources, never to primitive fallback geometry.

## 12. Future 2D Contract

The 2D module does not invent a separate object store.

Rules:

- before mesh/field resources exist, 2D slice/profile commands for the new object are disabled with a clear primitive-only explanation;
- after mesh build, 2D object scope uses the same object id and resource scopes as 3D;
- object/airbox visualization target ids stay shared with 3D unless a mode-specific 2D override is required by slice semantics;
- a stale mesh revision must be visible in 2D independently from 3D.

## 13. Implementation Plan

### Phase A - Contract And Resource Hooks

- [x] Add missing `ControlRoomApi.model` facade methods for `model/transactions`, object patch/delete, geometry capabilities, validation, diagnostics, and realization resources.
- [x] Add revision-aware hooks for scene, geometry validation/diagnostics, mesh build current/latest, object topology/report/quality, and visualization state.
- [x] Add command adapter helpers for `create_object`, `patch_object_geometry`, `commit_object_transform`, `delete_object`, and `mesh_build`.
- [x] Add tests proving modules do not construct `/v2/...` strings and do not call `fetch()`.

### Phase B - Selection, Explorer, And Inspector

- [x] Add pure explorer tree builders for object subtrees, Geometry/Mesh/Visualization child nodes, and mesh status badges.
- [x] Add kernel selection refs for object, object geometry, object mesh, and object visualization nodes.
- [x] Implement Geometry object inspector draft flow for create, patch geometry, commit transform, delete, and failed commit retention. Current coverage includes primitive draft selection, committed-object draft initialization, local SI validation, create-object Apply Draft, patch geometry, commit transform, delete object, resource invalidation, committed object selection, and failed transaction retention.
- [ ] Add inspector tests for draft isolation, base revision conflict, backend validation error display, and successful resource refresh. Current pure coverage includes draft isolation, committed draft initialization, base revision capture, local validation, transaction payload building, and backend validation message extraction; render-level failed commit display remains open because the app currently has no React Testing Library dependency.

### Phase C - Ribbon Commands

- [x] Register Geometry primitive commands and Mesh build commands in the command registry.
- [x] Render the commands through ribbon, menu/context menu, shortcut, and command palette surfaces without module-local callbacks.
- [x] Add command-state tests for missing capability, missing selection, validation blocker, running mesh build, accepted command, rejected command, and failed command. Current coverage includes missing capability disabled state, missing selection disabled state, validation blocker disabled state, running object mesh build disabled state, accepted selected mesh build, rejected mesh build result, create draft success/failure retention, delete transaction success, disabled command execution guard, ribbon disabled-state projection, shortcut scope resolution, and command-palette toggle dispatch.

### Phase D - 3D Primitive And Mesh Visualization

- [x] Extend the 3D render model with authoring primitive realization entries separate from solver topology entries.
- [x] Implement primitive shaded and simplified wireframe layers.
- [x] Add fallback labels for primitive-only and mesh-stale states.
- [x] Keep topology rebuilds tied to topology revisions only; primitive parameter changes rebuild only the affected primitive geometry. Current coverage includes topology render memo isolation from scene changes plus stable per-object primitive geometry keys across unrelated scene revisions.
- [ ] Add viewport tests for new object primitive display, fallback wireframe without topology, mesh-ready switch, stale previous mesh labeling, selection highlight, and layer disposal. Current coverage includes primitive-only display, stale previous mesh labeling, mesh-ready fallback suppression, primitive selection bounds, and selection highlight rendering; layer disposal remains open for primitive/fallback layers.

### Phase E - Mesh Build Integration

- [x] Submit selected-object mesh build via `simulation/commands`.
- [ ] Track `meshing/builds/current`, command completion, mesh revision, and mesh build revision through resource invalidation. Accepted selected-object build now invalidates `meshing/builds/current` and object topology/report/quality resources using the accepted `command_id`; successful-build realtime invalidation now refreshes dependent read models, but command-detail/provenance reconciliation remains open until the backend exposes a command-completion resource/event for this flow.
- [x] Re-read `model/scene`, mesh manifest, object topology/report/quality, and visualization state after build completion. `RealtimeInvalidationBridge` now treats `meshing/builds/latest-successful` as the successful-build completion signal and invalidates scene, shared-domain manifest, visualization state, and subscribed object topology/report/quality/size-field resources.
- [x] Prove successful mesh build clears the stale badge only when build provenance matches the current scene revision. Current primitive render-model tests cover stale previous mesh labeling when `source_scene_revision` lags and fallback suppression only when it matches the current scene revision.

### Phase F - 2D Readiness

- [ ] Gate 2D object slice/profile commands on mesh/field resource availability.
- [ ] Reuse object selection refs and visualization target ids.
- [ ] Add tests that primitive-only objects show a disabled 2D explanation rather than blank panels.

## 14. Verification Checklist

- `pnpm --dir apps/control-room generate:api` after any backend schema change.
- `pnpm --dir apps/control-room typecheck`.
- `pnpm --dir apps/control-room lint -- --max-warnings=0`.
- `pnpm --dir apps/control-room test`.
- `pnpm --dir apps/control-room check:api-hygiene`.
- focused tests for scene transaction hooks, explorer tree builders, inspector drafts, command registry gates, 3D primitive layers, mesh build invalidation, and future 2D gating.
- browser smoke: create box, edit dimensions, rotate, verify primitive display, enable fallback wireframe, build mesh, verify object topology replaces primitive mesh mode without losing selection.

## 15. Known Contract Gaps

- Generated OpenAPI types for scene/geometry `Value` payloads are too loose for safe authoring forms. The frontend needs narrow handwritten domain types and validators at the facade/adapter boundary until backend schemas become fully typed.
- There is no per-object read endpoint; object inspectors and explorer nodes refresh from `model/scene`.
- `mesh_build` is submitted through `simulation/commands`; do not document a `/meshing/builds/commands` route unless the backend adds it.
- Rename can affect mesh/build revisions through the backend scene mesh signature even when the object is not tagged `mesh:dirty`; UI stale badges should use revision/provenance in addition to tags.

## 16. Deferred Work

- Boolean CSG production authoring remains disabled until backend realization, diagnostics, region mapping, and mesh provenance are production-ready.
- Full transform gizmo editing can land after numeric inspector transactions if the same transaction and draft model is used.
- 2D primitive preview can be added later; the first 2D contract only needs honest disabled/stale states before mesh and field resources exist.
