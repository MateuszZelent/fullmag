# Resource-first Control Room API v2

- Status: canonical control-room API contract
- Last updated: 2026-05-14
- Compatibility reference: `docs/specs/control-room-api-endpoint-reference-v1.md`
- Runtime model: `docs/specs/session-run-api-v1.md`
- Governing ADR: `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This spec defines the canonical v2 browser contract for Fullmag's control room.

New frontend and backend API work targets:

- `GET /v2/platform/openapi.json`
- `GET /v2/platform/docs/swagger/`
- `/v2/sessions/current/...`

The older public `/v1/live/current/...` tree has been removed. Only
`/v1/internal/live/current/...` may remain as a backend-only runtime bridge; it is not browser API.

## 2. Canonical route families

The API is organized by platform concepts, not by frontend screens:

| Family | Responsibility |
|---|---|
| `platform` | Process health, capabilities, OpenAPI, AsyncAPI |
| `sessions` | Session discovery, current session, thin status, realtime events |
| `model` | Scene, materials, interactions, study, script sync, transactions |
| `meshing` | Meshing capabilities, policies, builds, realized mesh resources |
| `simulation` | Commands, runs, stages, solver status, energies |
| `data` | Quantities, materialized fields, scalar histories, artifacts |
| `visualization` | Canonical renderer display/view state |
| `workspace` | UI shell state: layout, ribbon, selection, active tree node |
| `analysis` | Analysis products such as eigenmodes and dispersion |
| `persistence` | Checkpoints, exports, imports, recovery |
| `diagnostics` | GPU telemetry and engine logs |

The default frontend base path is `/v2/sessions/current`.

## 3. Contract rules

- `GET /v2/sessions/current/status` stays thin: summary, capabilities, and revision pointers only.
- Heavy numerical payloads stay on resource data-plane routes, never in `status`.
- All simulation-control operations go through `POST /v2/sessions/current/simulation/commands`.
- `compute_fields` is a simulation command, not a preview/display mutation. It evaluates active field quantities for the current magnetization, refreshes `data/fields`, and must not advance time, run LLG/relaxation, or mutate magnetization.
- Authoring operations that mutate the canonical scene go through the `model` family, not simulation commands.
- `completion_status` is command outcome, not queue state; public command states are `queued`, `accepted`, `dispatched`, `running`, `completed`, `rejected`, and `failed`.
- `data/quantities` describes supported quantities and preview capability.
- `data/fields` describes materialized field resources; an empty field catalog does not make a quantity unsupported.
- `visualization/display` owns the legacy display-selection projection.
- `visualization/state` owns canonical session-wide renderer state. Its schema version 4 exposes `quantity`, independent `layers`, `domains`, `sampling`, FDM/FEM view policy, trim/clip state, global camera state, vector glyph style, object/part `overrides`, a complete effective target registry for current scene objects/mesh parts, and diagnostics while retaining flat display fields as a compatibility projection.
- `visualization/client-acks` owns bounded, diagnostic frontend feedback for renderer state revisions. Clients `POST` `applied`, `rendered`, or `failed` acknowledgements after consuming `visualization/state`; operators and scripts can `GET` the resource to confirm whether a visible browser applied a requested mode such as `surface` versus `wireframe`.
- `workspace/*` owns shell state only and must not mutate physics semantics.
- `status.capabilities` is the UI gating source of truth; discretization details may drive adapters but must not synthesize capabilities.

## 3.1 Single-owner read-model rules

Each field must have one owning resource. Other resources may expose ids, revision pointers, links,
or short dashboard summaries, but must not copy full read-model payloads from another family.

| Resource | Owns |
|---|---|
| `sessions/current/status` | session/run/solver/display/domain summaries, current-session UI capabilities, resource revisions |
| `model/scene` | canonical authoring `SceneDocument` snapshot |
| `model/transactions` | explicit semantic authoring mutations and committed scene revision |
| `model/objects/*` | object create/patch/delete mutation routes; current object state is read back through `model/scene` |
| `model/geometry/*` | geometry capability, validation, realization, and diagnostic projections derived from the current scene |
| `simulation/runs/current` and `simulation/runs/{run_id}` | run metadata, requested/resolved execution, artifact location, run-level totals |
| `simulation/stages/execution` | full stage tree and stage state |
| `simulation/solver/status` | live solver state: runtime state, step, dt, torque, convergence, warnings |
| `simulation/solver/energies/*` | current and historical energy samples |
| `meshing/summary` | lightweight mesh dashboard summary and revision pointers |
| `meshing/builds` | mesh build history collection |
| `meshing/builds/current` | current build/pipeline state, current resolved build target, and mesh provenance (`source_scene_revision`, `geometry_realization_revision`) |
| `meshing/builds/latest-successful` | last successful build reference or artifact summary plus mesh provenance (`source_scene_revision`, `geometry_realization_revision`) |
| `meshing/semantics` | solver-domain mesh semantics: universe/shared-domain/object configs and solver mesh identity |
| `meshing/meshes/shared-domain/manifest` | mesh identity, mesh provenance, object segments, mesh parts, and tree/selection metadata |
| `meshing/meshes/*/quality`, `meshing/meshes/*/quality/per-element`, `meshing/meshes/*/report`, and `meshing/meshes/*/size-field` | detailed shared-domain, object-scoped, and airbox-scoped quality summaries, binary per-element quality data, reports, and realized size-field diagnostics |
| `visualization/client-acks` | latest client-side acknowledgement per browser viewport for observed visualization-state revisions |

Transitional duplicate fields in meshing schemas are allowed only for current frontend adapters and
must be documented as transitional in OpenAPI schema descriptions. New consumers should read from the
owning resource above.

## 3.2 Capability ownership

Capability resources have distinct scopes:

- `platform/capabilities`: process/runtime/server-level capability matrix.
- `sessions/current/status.capabilities`: the only UI gating source for the active session.
- `meshing/capabilities`: meshing policy/build feature matrix only; it must not drive global UI gating.

## 3.3 Model authoring and Geometry object lifecycle

The `model` family owns canonical authoring state. Geometry object creation is a model transaction first and a mesh build only after the scene commit succeeds.

The control-room Model explorer is object-first. Ferromagnetic objects own the primary navigation path for geometry, regions, magnetic parameters, magnetic texture, mesh, and visualization. Material and magnetization entries may remain reusable assets in `SceneDocument`, but browser modules focus them through the selected object instead of exposing standalone top-level Model branches.

Current object-authoring routes:

| Route | Method | Meaning |
|---|---|---|
| `/v2/sessions/current/model/scene` | `GET` | Read current canonical `SceneDocument`. |
| `/v2/sessions/current/model/scene` | `PUT` | Replace current canonical `SceneDocument`. |
| `/v2/sessions/current/model/scene` | `PATCH` | Apply scene merge patch. |
| `/v2/sessions/current/model/objects` | `POST` | Create a scene object and return the committed scene. |
| `/v2/sessions/current/model/objects/{object_id}` | `PATCH` | Patch object identity, visibility, material/region/magnetization refs, geometry, or transform and return the committed scene. |
| `/v2/sessions/current/model/objects/{object_id}` | `DELETE` | Delete object and return the committed scene. |
| `/v2/sessions/current/model/objects/{object_id}/geometry` | `PATCH` | Patch object geometry and optional transform. |
| `/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}` | `GET` | Read one required or optional interaction entry for the selected object. |
| `/v2/sessions/current/model/objects/{object_id}/interactions/{interaction_kind}` | `PATCH` | Patch one selected-object interaction entry. |
| `/v2/sessions/current/model/materials/{material_id}` | `GET` | Read a material asset referenced by an object. |
| `/v2/sessions/current/model/materials/{material_id}` | `PATCH` | Patch a material asset referenced by an object. Shared-asset semantics are explicit until object-private material assets are introduced. |
| `/v2/sessions/current/model/regions` | `GET` | Read object-derived region resources for the current scene realization. |
| `/v2/sessions/current/model/regions/{region_id}` | `PATCH` | Patch an object-derived region name/visibility and return the committed scene. |
| `/v2/sessions/current/model/transactions` | `POST` | Commit an explicit semantic authoring transaction. |
| `/v2/sessions/current/model/geometry/capabilities` | `GET` | Read backend-owned primitive/CSG capability matrix. |
| `/v2/sessions/current/model/geometry/validation` | `GET` | Read validation diagnostics for the current scene. |
| `/v2/sessions/current/model/geometry/realizations` | `POST` | Create a derived geometry realization snapshot for a requested backend target. |
| `/v2/sessions/current/model/geometry/realizations/current` | `GET` | Read the current derived geometry realization snapshot. |
| `/v2/sessions/current/model/geometry/diagnostics` | `GET` | Read geometry diagnostics for the current scene. |
| `/v2/sessions/current/model/geometry/diagnostics/{diagnostic_id}` | `GET` | Read one geometry diagnostic detail when the backend exposes a stable diagnostic id. |

`POST /model/transactions` supports these authoring transaction kinds:

- `replace_scene`;
- `merge_patch`;
- `patch_object_geometry`;
- `create_object`;
- `delete_object`;
- `rename_object`;
- `commit_object_transform`;
- `patch_universe`.

The response includes `transaction_kind`, `scene_revision`, and `committed_scene`. Direct object and region mutation routes also return the committed scene. Material mutation returns the committed material asset and must invalidate `model/scene` because material changes can synchronize interaction state such as interfacial DMI. There is currently no `GET /v2/sessions/current/model/objects/{object_id}` read route; browser consumers refresh object state from `model/scene` and derive object panels from that snapshot.

Solver/runtime endpoints stay global study/run resources. Per-object physics and mesh authoring uses `model/objects/*`, `model/regions/*`, `model/materials/*`, `model/objects/*/interactions/*`, and `meshing/policies/objects/*`; it must not create screen-shaped solver endpoints for Explorer rows.

Global active effective-field term switches are study authoring state, not object interaction
resources. The control room commits `study.exchange_enabled` and `study.demag_enabled` through
`model/transactions` merge patches; object interaction routes remain for object-local entries such
as interfacial DMI and anisotropy.

Mesh-affecting model changes mark affected objects or the scene as mesh-stale. A frontend may show primitive authoring geometry immediately after a create/edit commit, but solver topology remains owned by `meshing` resources and is current only after mesh-build provenance matches the committed scene revision.

Mesh rebuild uses the existing command path:

```json
{
  "kind": "mesh_build",
  "mesh_target": { "kind": "object_mesh", "object_id": "object-id" },
  "mesh_reason": "geometry_object_edited"
}
```

This request is submitted to `POST /v2/sessions/current/simulation/commands`. Do not document or implement `/v2/sessions/current/meshing/builds/commands` unless the backend adds that route.

## 4. Scoped data access

Mesh and field resources must support scoped fetching so the frontend does not need to download the
full shared-domain mesh or full field arrays for isolation workflows.

Required mesh topology access patterns:

- full shared-domain topology,
- per-object topology,
- per-part topology,
- airbox as a mesh part.

Current mesh build and object-mesh resource routes:

| Route | Method | Meaning |
|---|---|---|
| `/v2/sessions/current/meshing/builds` | `GET` | Read mesh build history. |
| `/v2/sessions/current/meshing/builds/current` | `GET` | Read the active/current mesh build projection. |
| `/v2/sessions/current/meshing/builds/latest-successful` | `GET` | Read the latest successful mesh build projection. |
| `/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element` | `GET` | Read binary `FMMQ` per-element quality arrays for heatmap overlays. |
| `/v2/sessions/current/meshing/meshes/shared-domain/cross-section` | `GET` | Read binary `FMCS` shared-domain cross-section geometry for statistics and advanced inspection. |
| `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality` | `GET` | Read binary `FMQS` quality values for a shared-domain cross-section. |
| `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image` | `GET` | Read a server-rendered PNG preview/export for a shared-domain cross-section. |
| `/v2/sessions/current/meshing/meshes/universe/quality` | `GET` | Read universe/airbox mesh quality diagnostics; when the airbox scope exists, `quality.global` is the airbox quality scope. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/topology` | `GET` | Read object-scoped binary topology when available. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/report` | `GET` | Read object mesh report diagnostics. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/quality` | `GET` | Read object mesh quality diagnostics; when the object marker is known, `quality.global` is the object's mesh-quality scope. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/size-field` | `GET` | Read object realized size-field projection. |

Required field sample scopes:

| Query | Meaning |
|---|---|
| `scope_kind=full` | Full domain sample |
| `scope_kind=object&scope_id=<object_id>` | Object node subset |
| `scope_kind=part&scope_id=<part_id>` | Mesh-part node subset |
| `scope_kind=airbox` | First airbox mesh part |
| `scope_kind=airbox&scope_id=<part_id>` | Explicit airbox part |
| `scope_kind=selection` | Current workspace selection resolved by the backend |

Scope resolution is a backend contract. The frontend may request a selected scope, but it must not
download full-domain data just to filter large FEM payloads client-side.

Primitive geometry displayed before a mesh build is not scoped mesh topology. Object topology routes may return no content or not found until a mesh exists for the requested object. The frontend must distinguish primitive authoring display, stale previous topology, and current solver topology.

## 5. Frontend client policy

OpenAPI v2 and generated TypeScript types are the transport contract.

The frontend should use:

- generated OpenAPI types/client for low-level transport,
- `ControlRoomApi` as the session-scoped API facade,
- resource hooks for caching and invalidation,
- domain adapters for FDM/FEM interpretation,
- binary codecs for FMVP/FMMT payloads.

React components must not call `fetch()` directly and must not hand-roll `/v1` or `/v2` endpoint
strings outside the central API client/facade layer.

Server-rendered image resources, including shared-domain cross-section PNGs, are still v2 resources. Components consume them through `ControlRoomApi` and resource hooks that own ETag handling, object URL creation, and object URL revocation.

Visualization client acknowledgement writes also go through the central facade. The realtime websocket
may invalidate `visualization/client-acks`, but it remains an invalidation stream; the ACK payload
itself is an HTTP resource and is diagnostic feedback, not the source of renderer truth.

For Geometry object authoring, the frontend facade must provide typed handwritten adapters around the current loose `Value` payloads. Generated OpenAPI transport owns path/request/response plumbing only; object forms should use narrow domain models and validators before sending model transactions.

## 6. Compatibility

Post-cutover rules:

- public `/v1/live/current/...` must stay removed,
- OpenAPI v2 is the only browser transport contract,
- frontend direct API allowlists are limited to the central transport/facade boundary,
- contract gates fail on new direct `/v1/live/current` usage in frontend code.
