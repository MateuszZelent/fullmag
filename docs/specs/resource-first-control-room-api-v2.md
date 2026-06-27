# Resource-first Control Room API v2

- Status: canonical control-room API contract
- Last updated: 2026-05-31
- Compatibility reference: `docs/specs/control-room-api-endpoint-reference-v1.md`
- Runtime model: `docs/specs/session-run-api-v1.md`
- Governing ADR: `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This spec defines the canonical v2 browser contract for Fullmag's control room.

New frontend and backend API work targets:

- `GET /v2/platform/openapi.json`
- `GET /v2/platform/docs/swagger/`
- `/v2/sessions/current/...`

Version vocabulary has two deliberately separate axes:

- OpenAPI `info.version` is the Swagger document/catalog version and is currently `2.0.0`.
- Runtime compatibility uses `x-api-contract-version: 1.0.0` on HTTP responses and
  `contract_version: "1.0.0"` in realtime envelopes. Browser clients validate this runtime
  contract version, not the Swagger `info.version`.

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
- `data/tables/{table_id}/rows` owns table-shaped scalar histories for charts.
  The default chart table is `data/tables/default/rows`; `data/scalars` is a
  compatibility projection until all scalar-history consumers migrate.
- `visualization/display` owns the legacy display-selection projection.
- `visualization/state` owns canonical session-wide renderer state. Its schema version 4 exposes `quantity`, independent `layers`, `domains`, `sampling`, FDM/FEM view policy, trim/clip state, global camera state, vector glyph style, object/part `overrides`, a complete effective target registry for current scene objects/mesh parts, and diagnostics while retaining flat display fields as a compatibility projection.
- `visualization/client-acks` owns bounded, diagnostic frontend feedback for renderer state revisions. Clients `POST` `applied`, `rendered`, or `failed` acknowledgements after consuming `visualization/state`; operators and scripts can `GET` the resource to confirm whether a visible browser applied a requested mode such as `surface` versus `wireframe`.
- `workspace/*` owns shell state only and must not mutate physics semantics.
- `status.capabilities` is the UI gating source of truth; discretization details may drive adapters but must not synthesize capabilities.

## 3.1 Realtime invalidation rules

The canonical websocket remains an invalidation bus, not a payload stream. That
contract has stricter ownership rules than the HTTP routes:

- `resource.batch_changed` may only announce resources whose underlying payload
  freshness actually changed.
- UI-plane revisions and data-plane revisions must stay independent even when
  they share one websocket envelope.
- `visualization/display`, `visualization/state`, and `workspace/*` are
  UI-plane resources. Their mutations must not advance `field_revision`,
  `fields_revision`, `scalars_revision`, `mesh_revision`, `mesh_build_revision`,
  or `domain_generation_id`.
- `fields_revision` is a field-family freshness signal, not a generic snapshot
  counter. It must advance only when materialized field payloads can change.
- `field_revision` owns binary field sample freshness
  (`/data/fields/{quantity_id}/samples/vector`, slice, projection, and related
  derivative resources). A camera-only patch must never cause a
  `field_revision`-equivalent invalidation.
- `scalars_revision` owns scalar-history/table freshness only during the
  transition to named table resources. Scalar appends may trigger downstream
  field invalidation only when the backend also proves that the materialized
  field payload changed.
- `recommended_fetch` must be derived from resources that actually changed. The
  backend must not emit blanket fetch hints for every possible viewport field
  vector just because a session snapshot was rebuilt.
- `recommended_fetch` must preserve the real query identity of the resource,
  including scope and component. If the backend cannot name the exact affected
  field query, it must omit the fetch hint rather than over-invalidate with a
  made-up full-domain/full-vector request.
- `data/fields/*` HTTP freshness validators such as `revision`, `field_revision`,
  and response ETags must be derived from field payload freshness plus query
  scope, not from generic publish counters such as `snapshot.state_version`.
- Family-level field sample invalidation must remain distinct from field catalog
  invalidation. When the backend knows only that some field payload changed, it
  should emit a semantic field-samples change instead of fabricating an exact
  catalog fetch or blanket full-vector fetch list.
- Realtime coalescing may merge many changes into one envelope, but coalescing
  must not widen scope. A coalesced camera/display update must still remain a
  camera/display update.

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
| `data/tables/default/rows` | table-shaped scalar history for ECharts windows, including `cursor`, `from_row`/`to_row`, `from_t`/`to_t`, `limit`, `target_points`, `decimation`, and `include_tail` query identity; JSON rows are the control-plane/debug view, while `rows.bin` is the production data-plane payload for chart values |
| `data/scalars` | compatibility projection of the default scalar table, not a second scalar-history owner |
| `data/artifacts` | artifact index entries; entries may expose optional region-owned authoring provenance summaries (`scene_revision`, authored region count, material field count, coupling count, blocked/deferred diagnostic counts) but must not inline heavy artifact payloads |
| `data/material-fields` and `data/material-fields/{field_id}` | material-parameter field data catalog and per-assignment realized sample payloads for authored material fields; detail resources may include typed realized material-field asset metadata (`asset_id`, `artifact_path`, mesh identity, location, component count, source kind, algorithm, timing), while `model/material-fields` remains the summary/status resource |
| `data/mesh-region-membership/{region_id}` and `data/mesh-region-memberships` | realized-region membership indices for current FEM mesh parts, with explicit `object_segments` fallback when no mesh-part entry exists and typed Box/Cylinder/Sphere geometry projection for authored regions without mesh parts; topology remains owned by mesh topology resources, and the list resource exposes available memberships plus unresolved authored region ids without moving heavy topology into status |
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

Realtime invalidation follows the same single-owner rule. `visualization/state`
may project the current active quantity, camera, and layer policy, but it does
not own field payload freshness; `data/fields/*` does. Conversely,
`data/fields/*` does not own camera or workspace-shell freshness.

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
| `/v2/sessions/current/model/regions` | `GET` | Read authored object-region resources from the canonical scene. |
| `/v2/sessions/current/model/realized-regions` | `GET` | Read geometry-realized body-region resources derived from the current scene realization. |
| `/v2/sessions/current/model/couplings` | `GET` | Read authored couplings, runtime capability/blocker status, and mesh-backed source/target endpoint resolution diagnostics, including FEM `boundary_face_indices`/`boundary_marker_ids` when a surface selector resolves to marker-backed faces. Surface resolution is a preview and does not imply that the selected backend implements the coupling operator; markerless surface previews report `missing_boundary_markers`. |
| `/v2/sessions/current/model/couplings` | `POST` | Create an authored coupling with `base_revision` precondition and return the committed scene. |
| `/v2/sessions/current/model/couplings/{coupling_id}` | `PATCH` | Patch an authored coupling with `base_revision` precondition and return the committed scene. Coupling identity is path-owned and not patchable. |
| `/v2/sessions/current/model/couplings/{coupling_id}` | `DELETE` | Delete an authored coupling with `base_revision` precondition and return the committed scene. |
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

`delete_object` also removes authored couplings whose object, surface, or
region endpoint references the deleted object, so the committed scene cannot
retain dangling coupling endpoints. The response includes `transaction_kind`,
`scene_revision`, and `committed_scene`. Direct object and region mutation
routes also return the committed scene. Material mutation returns the committed
material asset and must invalidate `model/scene` because material changes can
synchronize interaction state such as interfacial DMI. There is currently no
`GET /v2/sessions/current/model/objects/{object_id}` read route; browser
consumers refresh object state from `model/scene` and derive object panels from
that snapshot.

Solver/runtime endpoints stay global study/run resources. Per-object physics and mesh authoring uses `model/objects/*`, `model/regions/*`, `model/materials/*`, `model/objects/*/interactions/*`, and `meshing/policies/objects/*`; it must not create screen-shaped solver endpoints for Explorer rows.

Global active effective-field term switches are study authoring state, not object interaction
resources. The control room commits `study.exchange_enabled` and `study.demag_enabled` through
`model/transactions` merge patches; object interaction routes remain for object-local entries such
as interfacial DMI and anisotropy.

Mesh-affecting model changes mark affected objects or the scene as mesh-stale. A frontend may show primitive authoring geometry immediately after a create/edit commit, but solver topology remains owned by `meshing` resources and is current only after mesh-build provenance matches the committed scene revision.

### Production mesh build management

Mesh build management distinguishes policy intent, accepted command, active build, latest successful build, and rendered viewport revision. Policy resources store requested authoring intent. Build resources expose resolved execution reality and published mesh revisions. Viewport acknowledgements are diagnostics and must not become the source of mesh truth.

Mesh rebuild uses the existing command path:

```json
{
  "kind": "mesh_build",
  "mesh_target": { "kind": "object_mesh", "object_id": "object-id" },
  "mesh_reason": "geometry_object_edited"
}
```

This request is submitted to `POST /v2/sessions/current/simulation/commands`. Do not document or implement `/v2/sessions/current/meshing/builds/commands` unless the backend adds that route.

### Hysteresis Workflow Resources

Hysteresis workflows expose endpoints for planning, execution progress, points data, and loop metrics:

| Route | Method | Meaning |
|---|---|---|
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/plan` | `GET` | Read planned schedule of field values, segments, and targets |
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/protocol` | `GET` | Read initial protocol (saturation, zero-field) and sweep mode |
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/orientation` | `GET` | Read field orientation vector, angle, and coordinate frame |
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/saturation` | `GET` | Read auto-saturation probe results, thresholds, and override decisions |
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/settle-pipeline` | `GET` | Read planned settle pipeline step sequence and conditional branches |
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/progress` | `GET` | Read overall point progress and status counters |
| `/v2/sessions/current/simulation/stages/{stage_id}/hysteresis/execution-tree` | `GET` | Read live window of completed, active, and queued points in the explorer |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/points` | `GET` | Read revisioned resource envelope for resolved point averages, field projections, and convergence status |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/metrics` | `GET` | Read revisioned loop metrics resource (remanence, coercivity, bias, energy loss area) |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/saturation` | `GET` | Read revisioned auto-saturation analysis resource with executed probe points, thresholds, status, and decision reason |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/adaptive-refinement` | `GET` | Read revisioned adaptive-refinement resource with candidates, inserted points, and settle trace |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/branches` | `GET` | Read revisioned branch metadata resource indexing forward, return, recoil, and minor branch relations |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/minor-loops` | `GET` | Read revisioned minor loop resource with specifications, closure status, and recoil metrics |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/reversal-fields` | `GET` | Read revisioned reversal-fields resource with recoil start indices |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/bookmarks` | `GET`, `POST` | Read and create session-owned bookmarked hysteresis points for Explorer/Inspector navigation |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/settle-trace` | `GET` | Read revisioned stage-level settle trace, including preparation and saturation-probe rows without measured point ids |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}` | `GET` | Read detailed result summary for a single point and its snapshot ref |
| `/v2/sessions/current/analysis/hysteresis/{stage_id}/steps/{point_id}/settle-trace` | `GET` | Read step-by-step trace of solver algorithms run for relaxation of this point |

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

FEM vector field payloads use versioned FMVP. FMVP v3 includes
`domain_generation_id`, mesh topology revision/hash, scope kind/id, an indexing
mode, and `node_indices` for explicit or sampled non-full-domain payloads.
Clients must preserve `domain_generation_id` and mesh topology revision as
exact revision tokens. JavaScript clients must not coerce FMVP v3 `u64`
metadata into `number`, because valid backend revisions may exceed
`Number.MAX_SAFE_INTEGER`.
`sampled_node_indices` payloads are valid for vector glyph placement only;
surface shaders require `full_domain` or `explicit_node_indices` data that can
be matched to the target topology. FMVP v2 remains a legacy full-domain
compatibility format and must not be treated as proof for scoped FEM surface
mapping.

The same rule applies to realtime fetch hints. If the active viewport consumes
`component=magnitude&scope_kind=airbox&scope_id=part:__air__`, the invalidation
system must prefer that scoped query. It must not fall back to
`component=full&scope_kind=full` unless that exact resource changed and the
frontend explicitly depends on it.

Primitive geometry displayed before a mesh build is not scoped mesh topology. Object topology routes may return no content or not found until a mesh exists for the requested object. The frontend must distinguish primitive authoring display, stale previous topology, and current solver topology.

## 5. Frontend client policy

OpenAPI v2 and generated TypeScript types are the transport contract.

The frontend should use:

- generated OpenAPI types/client for low-level transport,
- `ControlRoomApi` as the session-scoped API facade,
- resource hooks for caching and invalidation,
- realtime invalidations as hints that preserve resource ownership boundaries,
  not as permission to refetch unrelated heavy resources,
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
