# Resource-First API Endpoint Reference Rollout Plan

- Status: active
- Last updated: 2026-04-21
- Scope: API documentation, contract stabilization, frontend cutover planning
- Parent specs:
  - `docs/specs/resource-first-control-room-api-v1.md`
  - `docs/specs/control-room-api-tree-v1.md`
  - `docs/specs/session-run-api-v1.md`
  - `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This plan sequences the next documentation and contract work for the local
resource-first control-room API.

Execution status as of `2026-04-21`:

- the canonical endpoint reference document has been added,
- parent architecture/spec documents have been linked to it,
- agent/copilot guidance has been updated to treat it as a canonical reference,
- the remaining open work is now the code-facing contract backlog from
  Phases 4 and 5.

The immediate goal is not "write some API notes". The goal is to produce one
professional, field-complete endpoint reference that:

1. documents every currently implemented resource-first endpoint,
2. documents every field of every current request and response schema,
3. marks every endpoint as canonical, transitional, or target-only,
4. records the binary data-plane contracts,
5. makes the remaining `bootstrap` / `poll` dependency explicit,
6. gives the frontend a clear path to remove `useSessionStream`.

## 2. Verified current state

### 2.1 Implemented canonical v1 routes

The currently implemented resource-first router in
`crates/fullmag-api/src/router_v1/mod.rs` exposes:

```text
GET    /v1/health
GET    /v1/capabilities
GET    /v1/live/current/status
GET    /v1/live/current/domain/meta
GET    /v1/live/current/domain/topology
GET    /v1/live/current/quantities/catalog
GET    /v1/live/current/fields/catalog
GET    /v1/live/current/fields/:quantity_id/meta
GET    /v1/live/current/fields/:quantity_id/vector
GET    /v1/live/current/scalars
GET    /v1/live/current/display
PUT    /v1/live/current/display
PATCH  /v1/live/current/display
POST   /v1/live/current/commands
POST   /v1/live/current/assets/import
GET    /v1/live/current/artifacts
GET    /v1/live/current/artifacts/:artifact_id
GET    /v1/live/current/eigen/spectrum
GET    /v1/live/current/eigen/mode
GET    /v1/live/current/eigen/dispersion
GET    /v1/live/current/eigen/branches
GET    /v1/live/current/logs/engine
GET    /v1/live/current/gpu/telemetry
POST   /v1/live/current/session/export
POST   /v1/live/current/session/import/inspect
POST   /v1/live/current/session/import/commit
GET    /v1/live/current/session/checkpoints
GET    /v1/live/current/session/recovery
POST   /v1/live/current/session/recovery/clear
GET    /v1/openapi.json
GET    /v1/docs/swagger
```

### 2.2 Transitional routes still mounted

The legacy server entrypoint in `crates/fullmag-api/src/main.rs` still mounts:

```text
GET    /healthz
GET    /v1/meta/vision
GET    /v1/live/current/bootstrap
GET    /v1/live/current/state
GET    /v1/live/current/poll
GET    /v1/live/current/events
POST   /v1/live/current/publish
POST   /v1/live/current/create
GET    /v1/live/feature-flags
GET    /v1/live/current/commands/next
GET    /v1/live/current/control/wait
POST   /v1/live/current/state/export
POST   /v1/live/current/state/import
POST   /v1/live/current/script/sync
POST   /v1/live/current/scene
GET    /v1/live/current/artifacts/file
GET    /v1/docs/physics
GET    /v1/quantities/catalog
POST   /v1/run
GET    /ws/live/current
GET    /ws/live/:run_id
```

These routes must be documented honestly as transitional or legacy-only. They
must not appear as the canonical browser contract.

### 2.3 Frontend migration status

The typed `LiveApiClient` now covers the implemented v1 families for:

- status,
- domain,
- fields,
- scalars,
- display,
- commands,
- artifacts,
- eigen,
- gpu,
- session persistence,
- quantities,
- scene helper calls.

The control-room tree already uses a typed `controlRoomApi` wrapper for
commands, display, artifacts, binary field fetches, topology fetches, GPU
telemetry, and session persistence helpers.

The remaining hard legacy dependency is concentrated in:

- `apps/web/lib/useSessionStream.ts`
- `apps/web/lib/liveApiClient.ts`

This is good progress, but it is not yet a full cutover.

## 3. Main deliverables

### 3.1 New canonical endpoint reference

Create:

- `docs/specs/control-room-api-endpoint-reference-v1.md`

This new spec becomes the field-complete endpoint reference for the local
resource-first API.

For every endpoint, the document must include:

1. category,
2. canonicality:
   - canonical,
   - transitional,
   - target-only,
3. method and path,
4. purpose,
5. request headers,
6. path parameters,
7. query parameters,
8. request body schema,
9. response body schema,
10. per-field meaning,
11. units where applicable,
12. revision or generation semantics,
13. cache and invalidation notes,
14. binary codec notes when applicable,
15. status codes and degraded responses,
16. migration notes when the endpoint supersedes a legacy route.

### 3.2 Parent spec updates

Update:

- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/session-run-api-v1.md`
- `docs/specs/control-room-api-tree-v1.md`
- `docs/specs/README.md`

These updates must:

- link the new endpoint reference,
- distinguish implemented versus target-only families,
- keep the current singleton local-live contract honest,
- explicitly point at the transitional appendix while `bootstrap/poll` still
  exists.

### 3.3 Legacy decomposition appendix

Add an appendix section to the new endpoint reference that maps the legacy
`SessionState` blob to resource-first families.

Each legacy field must be classified as one of:

- already covered by a canonical v1 endpoint,
- still covered only by transitional transport,
- target-only planned family with no endpoint yet,
- intentionally retired with no resource-first replacement.

## 4. Endpoint taxonomy and field inventory

This section is the checklist for the field-complete documentation pass.

### 4.1 System and contract surfaces

#### `GET /v1/health`

Document `HealthResponse` field by field:

- `status`
- `uptime_seconds`
- `api_contract_version`
- `active_session`

#### `GET /v1/capabilities`

Document `HostCapabilityMatrix` field by field:

- `profile_version`
- `engines[]`

Document each `HostEngineEntry` field:

- `backend`
- `device`
- `precision`
- `mode`
- `runtime_family`
- `runtime_version`
- `worker`
- `status`
- `status_reason`
- `public`
- `stability`

Document the `EngineAvailabilityStatus` value space:

- `available`
- `missing_runtime`
- `missing_driver`
- `missing_library`
- `feature_gated`
- `experimental`

#### `GET /v1/openapi.json`
#### `GET /v1/docs/swagger`

Document these as contract discovery endpoints rather than business resources.

### 4.2 Live status and revision signals

#### `GET /v1/live/current/status`

Document `LiveStatus` field by field:

- `api_contract_version`
- `runtime_bundle_version`
- `session`
- `run`
- `solver`
- `display`
- `domain`
- `resources`
- `capabilities`
- `energies`
- `metrics`

Document `SessionSummary` fields:

- `session_id`
- `name`
- `created_at`
- `workspace_root`

Document `RunSummary` fields:

- `run_id`
- `stage_index`
- `stage_label`
- `stage_count`
- `started_at`
- `solver_steps`
- `solver_time`

Document `SolverSummary` fields:

- `state`
- `algorithm`
- `dt`
- `max_torque`
- `converged`

Document `DisplaySelection` fields:

- `active_quantity_id`
- `view_mode`
- `field_component`
- `colormap`
- `auto_contrast`
- `contrast_min`
- `contrast_max`
- `vector_glyphs`
- `vector_density`
- `slice_mode`
- `slice_layer`
- `max_points`
- `x_chosen_size`
- `y_chosen_size`

Document `DomainSummary` fields:

- `generation_id`
- `discretization`
- `cell_count`

Document `ResourceRevisionMap` fields:

- `fields_revision`
- `scalars_revision`
- `domain_generation_id`
- `artifacts_revision`
- `engine_log_revision`
- `display_revision`

Document `CapabilityMap` fields:

- `structured_grid`
- `explicit_topology`
- `binary_fields`
- `cell_fields`
- `node_fields`
- `scalar_history`
- `eigen_modes`
- `gpu_telemetry`
- `preview_2d`
- `preview_3d`
- `algorithms_available`

Document `EnergySummary` fields:

- `total`
- `exchange`
- `demag`
- `zeeman`
- `anisotropy`
- `dmi`

Document `MetricsSummary` fields:

- `uptime_seconds`
- `total_steps`
- `steps_per_second`

### 4.3 Domain resources

#### `GET /v1/live/current/domain/meta`

Document `DomainMeta` fields:

- `domain_id`
- `discretization`
- `generation_id`
- `dimension`
- `coordinate_system`
- `units`
- `bounds`
- `counts`
- `grid`
- `element_type`

Document nested `Bounds3` fields:

- `min`
- `max`

Document nested `DomainCounts` fields:

- `cells`
- `nodes`
- `elements`
- `boundary_faces`

Document nested `StructuredGridDescriptor` fields:

- `shape`
- `origin`
- `spacing`

#### `GET /v1/live/current/domain/topology`

Document:

- `200` binary FMMT payload for explicit FEM topology,
- `204 No Content` for implicit FDM topology,
- `domain_generation_id` as the invalidation boundary,
- the relationship between `domain/meta.discretization` and topology presence.

#### Target-only domain routes to reserve in docs

Mark as target-only and not yet implemented:

- `GET /v1/live/current/domain/coordinates`
- `GET /v1/live/current/domain/regions`
- `GET /v1/live/current/domain/active-mask`

### 4.4 Quantities, fields, and scalars

#### `GET /v1/live/current/quantities/catalog`

Document `QuantityCatalogResponse` fields:

- `schema_version`
- `quantities`

Document `QuantityCatalogEntry` fields:

- `id`
- `label`
- `description`
- `shape`
- `unit`
- `location`
- `domain`
- `n_comp`
- `normalization_hint`
- `interactive_preview`
- `supports_preview_2d`
- `supports_preview_3d`
- `supports_history`
- `supports_export`
- `quick_access_label`
- `scalar_metric_key`

#### Transitional `GET /v1/quantities/catalog`

Document as a transitional mirror of the canonical
`/v1/live/current/quantities/catalog` wire shape.

#### `GET /v1/live/current/fields/catalog`

Document `FieldCatalog` fields:

- `revision`
- `domain_generation_id`
- `quantities`

Document `FieldDescriptor` fields:

- `quantity_id`
- `label`
- `kind`
- `components`
- `location`
- `unit`
- `field_revision`
- `domain_generation_id`
- `available`

#### `GET /v1/live/current/fields/:quantity_id/meta`

Document `FieldMeta` fields:

- `quantity_id`
- `label`
- `kind`
- `components`
- `location`
- `unit`
- `field_revision`
- `domain_generation_id`
- `stats`

Document `FieldStats` fields:

- `min`
- `max`
- `mean`

Document the current honesty note:

- `stats` is currently `null` in the implemented handler,
- the shape exists in the contract and must still be described,
- a later endpoint or richer handler may materialize stats without changing the
  family split.

#### `GET /v1/live/current/fields/:quantity_id/vector`

Document:

- FMVP v2 binary payload,
- `quantity_id` path parameter,
- current in-memory source precedence:
  - `latest_fields`,
  - `preview_cache`,
  - `m` fallback from live magnetization,
- content type,
- revision coupling to `field_revision` and `domain_generation_id`.

#### `GET /v1/live/current/scalars`

Document query parameters:

- `since_revision`
- `limit`

Document `ScalarWindow` fields:

- `revision`
- `total_rows`
- `returned_rows`
- `columns`
- `rows`

Document the exact column vocabulary:

- `step`
- `time`
- `solver_dt`
- `mx`
- `my`
- `mz`
- `e_ex`
- `e_demag`
- `e_ext`
- `e_ani`
- `e_dmi`
- `e_total`
- `max_dm_dt`
- `max_h_eff`
- `max_h_demag`
- `max_torque_Apm`
- `max_torque_T`

#### Target-only field routes to reserve in docs

Mark as target-only and not yet implemented:

- `GET /v1/live/current/fields/:quantity_id/stats`
- `GET /v1/live/current/fields/:quantity_id/availability`

### 4.5 Display and command surfaces

#### `GET /v1/live/current/display`
#### `PUT /v1/live/current/display`
#### `PATCH /v1/live/current/display`

Document full `DisplaySelection` fields:

- `active_quantity_id`
- `view_mode`
- `field_component`
- `colormap`
- `auto_contrast`
- `contrast_min`
- `contrast_max`
- `vector_glyphs`
- `vector_density`
- `slice_mode`
- `slice_layer`
- `max_points`
- `x_chosen_size`
- `y_chosen_size`

Document partial `DisplayPatch` fields:

- `active_quantity_id`
- `view_mode`
- `field_component`
- `colormap`
- `auto_contrast`
- `contrast_min`
- `contrast_max`
- `vector_glyphs`
- `vector_density`
- `slice_mode`
- `slice_layer`
- `max_points`
- `x_chosen_size`
- `y_chosen_size`

Document response `DisplaySelection` as a normalized current selection resource.

Document the current behavior honestly:

- `GET` returns the current display resource,
- `PUT` is full replacement and rejects incomplete bodies,
- `PATCH` remains the partial-mutation route,
- `view_mode` and `field_component` are separate fields in both docs and code.

#### `POST /v1/live/current/commands`

Document request headers:

- `Idempotency-Key`
- `x-request-id`

Document `StructuredCommandRequest` variants and fields:

- `run`
  - `until_seconds`
  - `max_steps`
  - `integrator`
  - `fixed_timestep`
- `relax`
  - `until_seconds`
  - `max_steps`
  - `torque_tolerance`
  - `energy_tolerance`
  - `relax_algorithm`
  - `relax_alpha`
  - `fixed_timestep`
  - `max_error`
- `pause`
- `resume`
- `stop`
- `skip`
- `remesh`
  - `mesh_options`
  - `mesh_target`
  - `mesh_reason`
- `save_vtk`
- `solve`
- `close`

Document `LegacyCommandRequest` fields:

- `command`
- `params`

Document `CommandResponse` fields:

- `accepted`
- `command_id`
- `error`

Document the migration rule:

- structured `kind` requests are canonical,
- legacy `command + params` is transitional input compatibility.

### 4.6 Assets, artifacts, and analysis

#### `POST /v1/live/current/assets/import`

Document `ImportSessionAssetRequest` fields:

- `file_name`
- `content_base64`
- `target_realization`

Document `SessionAssetImportResponse` fields:

- `asset_id`
- `session_id`
- `stored_path`
- `target_realization`
- `summary`

Document `ImportedAssetSummary` fields:

- `file_name`
- `file_bytes`
- `kind`
- `bounds`
- `triangle_count`
- `node_count`
- `element_count`
- `boundary_face_count`
- `note`

Document `BoundsSummary` fields:

- `min`
- `max`
- `size`

#### `GET /v1/live/current/artifacts`

Document `ArtifactEntry` fields:

- `path`
- `kind`

#### `GET /v1/live/current/artifacts/:artifact_id`

Document:

- `artifact_id` path semantics,
- path sanitization rules,
- content-type derivation by file extension,
- the difference between artifact index and artifact bytes.

#### `GET /v1/live/current/eigen/spectrum`
#### `GET /v1/live/current/eigen/mode`
#### `GET /v1/live/current/eigen/dispersion`
#### `GET /v1/live/current/eigen/branches`

Document `EigenModeQuery` fields:

- `index`
- `sample_index`

Document `EigenDispersionResponse` fields:

- `csv_path`
- `path_metadata`
- `rows`

Document `EigenDispersionRow` fields:

- `mode_index`
- `kx`
- `ky`
- `kz`
- `frequency_hz`
- `angular_frequency_rad_per_s`

Document the honesty note:

- `spectrum`, `mode`, and `branches` currently proxy artifact JSON payloads,
- these are resource families, not independent storage systems,
- the endpoint reference must describe the current artifact-backed reality.

### 4.7 Diagnostics and telemetry

#### `GET /v1/live/current/logs/engine`

Document the current JSON envelope:

- `entries`
- `total`

Also document the current source type:

- `entries[]` are `EngineLogEntry` items from the live snapshot transport.

#### `GET /v1/live/current/gpu/telemetry`

Document `GpuTelemetryResponse` fields:

- `status`
- `reason`
- `sample_time_unix_ms`
- `devices`

Document `GpuTelemetryDevice` fields:

- `index`
- `name`
- `utilization_gpu_percent`
- `utilization_memory_percent`
- `memory_used_mb`
- `memory_total_mb`
- `temperature_c`

Document degraded success semantics:

- `status: unavailable` is a valid `200` response,
- lack of local NVIDIA telemetry is not a control-room-fatal error.

### 4.8 Session persistence

#### `POST /v1/live/current/session/export`

Document `SessionExportRequest` fields:

- `profile`
- `name`
- `compression`
- `ui_state`

Document `SessionExportResponse` fields:

- `session_id`
- `profile`
- `fms_base64`
- `size_bytes`

#### `POST /v1/live/current/session/import/inspect`

Document `SessionImportInspectRequest` fields:

- `fms_base64`

Document `SessionImportInspectResponse` fields:

- `inspection`

Document `SessionInspection` fields:

- `format_version`
- `session_id`
- `name`
- `profile`
- `created_by_version`
- `created_at`
- `saved_at`
- `run_count`
- `latest_checkpoint`
- `restore_class`
- `warnings`
- `total_size_bytes`

#### `POST /v1/live/current/session/import/commit`

Document `SessionImportCommitRequest` fields:

- `fms_base64`
- `restore_mode`

Document `SessionImportCommitResponse` fields:

- `session_id`
- `restore_class`
- `warnings`
- `ui_state`

#### `GET /v1/live/current/session/checkpoints`

Document `CheckpointListResponse` fields:

- `checkpoints`

Document `CheckpointEntry` fields:

- `checkpoint_id`
- `step`
- `time_s`
- `created_at`

#### `GET /v1/live/current/session/recovery`

Document `RecoveryListResponse` fields:

- `snapshots`

Document `RecoveryEntry` fields:

- `session_id`
- `name`
- `saved_at`
- `profile`

#### `POST /v1/live/current/session/recovery/clear`

Document `RecoveryClearResponse` fields:

- `cleared`

Document enum vocabularies used by the persistence flow:

- `SaveProfile`
  - `compact`
  - `solved`
  - `resume`
  - `archive`
  - `recovery`
- `RestoreClass`
  - `exact_resume`
  - `logical_resume`
  - `initial_condition_import`
  - `config_only`
- `CompressionProfile`
  - `speed`
  - `balanced`
  - `smallest`

### 4.9 Common error envelope

Document `ApiErrorResponse` fields:

- `error`
- `message`
- `request_id`

The endpoint reference must state when handlers currently return raw binary,
plain artifact bytes, typed JSON, or error JSON.

## 5. Legacy blob decomposition checklist

The old `SessionState` transport currently carries these top-level fields:

- `state_version`
- `session_protocol_version`
- `capability_profile_version`
- `session`
- `run`
- `live_state`
- `runtime_status`
- `capabilities`
- `metadata`
- `mesh_workspace`
- `stage_execution`
- `scene_document`
- `script_builder`
- `model_builder_graph`
- `scalar_rows`
- `scalar_rows_total`
- `engine_log`
- `quantities`
- `fem_mesh`
- `latest_fields`
- `artifacts`
- `display_selection`
- `preview_config`
- `preview`
- `command_status`
- `step_update_v2`

The reference rollout must map each of them as follows.

### 5.1 Already covered by canonical or near-canonical v1 families

- `session`
  - covered partially by `status.session`
- `run`
  - covered partially by `status.run`
- `capabilities`
  - covered by `GET /v1/capabilities` and `status.capabilities`
- `scalar_rows`
  - covered by `GET /v1/live/current/scalars`
- `engine_log`
  - covered by `GET /v1/live/current/logs/engine`
- `quantities`
  - covered by `GET /v1/live/current/quantities/catalog`
- `fem_mesh`
  - split across `domain/meta` and `domain/topology`
- `latest_fields`
  - split across `fields/catalog`, `fields/:quantity_id/meta`, and
    `fields/:quantity_id/vector`
- `artifacts`
  - covered by `GET /v1/live/current/artifacts`
- `display_selection`
  - covered by `status.display` and `GET/PUT/PATCH /display`

### 5.2 Still legacy-only or contract-gap resources

- `metadata`
  - no dedicated canonical resource yet
- `mesh_workspace`
  - target family exists in the API tree, implementation absent
- `stage_execution`
  - runtime execution resource is still missing as a first-class canonical
    family
- `scene_document`
  - target `authoring/scene`, implementation absent
- `script_builder`
  - target `authoring/*` projections, implementation absent
- `model_builder_graph`
  - target `authoring/builder/graph`, implementation absent
- `command_status`
  - no canonical `command status` read-model endpoint yet

### 5.3 Fields that must be retired rather than preserved

- `preview_config`
  - should dissolve into `display` plus local viewport state
- `preview`
  - should dissolve into cached field/domain resources and local render adapters
- monolithic `live_state`
  - should dissolve into thin `status`, `scalars`, `fields`, and dedicated
    runtime resources

### 5.4 Fields that need careful split decisions

- `runtime_status`
  - some meaning belongs in `status.solver`,
  - some meaning may need a dedicated runtime-state resource,
  - this must be resolved before `useSessionStream` is removed
- `step_update_v2`
  - should not survive as a second transport theory,
  - either it becomes an internal bridge object derived from canonical
    resources or it is replaced

## 6. Implementation phases

### Phase 1. Freeze the verified endpoint inventory

Work:

- create the new endpoint reference file,
- copy in the currently implemented route inventory,
- mark every route as canonical, transitional, or target-only,
- add headers and binary codec sections.

Done when:

- every currently mounted v1 route is listed exactly once,
- every legacy route is listed exactly once in a transitional appendix,
- no route is described as canonical unless it is actually mounted.

### Phase 2. Write the field-complete endpoint reference

Work:

- add field tables for every current JSON schema,
- add explicit query and path parameter tables,
- add binary payload notes for FMVP v2 and FMMT,
- add degraded-response notes for telemetry and no-topology cases.

Done when:

- every field named in Section 4 is documented,
- scalar column order is explicit,
- enum vocabularies are explicit,
- units and revision semantics are called out.

### Phase 3. Add the legacy-to-resource mapping appendix

Work:

- map `SessionState` fields to resource-first families,
- flag resource gaps blocking control-room cutover,
- identify which old fields are transitional compatibility only.

Done when:

- `ControlRoomContext` dependencies can be traced to either:
  - a canonical endpoint,
  - a documented transitional dependency,
  - or a missing endpoint family on the active backlog.

### Phase 4. Stabilize missing canonical families

Work:

- keep `/v1/quantities/catalog` transitional until the remaining callers and
  docs are fully retired,
- define first-class resource shapes for:
  - `workspace/*`,
  - `authoring/*`,
  - `mesh/*`,
  - runtime stage execution,
  - command status read models,
- update the route tree and parent specs accordingly.

Done when:

- the missing-family backlog is explicit and prioritized,
- no UI-critical resource remains unnamed in the target API tree.

### Phase 5. Frontend cutover and legacy retirement

Work:

- replace `useSessionStream` consumers with store/resource hooks,
- stop treating `bootstrap/poll` as a data source for control-room UI,
- remove or isolate the remaining legacy shim,
- add tests for the cutover path.

Done when:

- `currentLiveApiClient` is no longer needed by the main control-room tree,
- `bootstrap/poll` is not needed for normal control-room rendering,
- the docs can move legacy transport from "transitional current" to
  "deprecated removal path".

## 7. Required documentation style

The endpoint reference must be written in a professional reference-manual style.

Required style rules:

1. group endpoints by product-facing category, not by source file,
2. keep canonical versus transitional status visually obvious,
3. use field tables for JSON schemas instead of prose-only descriptions,
4. call out units explicitly for physics and telemetry values,
5. distinguish revision ids from human timestamps,
6. distinguish summary resources from heavy binary payloads,
7. keep OpenAPI-generated schema names aligned with prose names,
8. include honest notes where the implementation is narrower than the target
   architecture.

## 8. Acceptance criteria

This rollout is complete only when:

1. `docs/specs/control-room-api-endpoint-reference-v1.md` exists and is field
   complete for all current endpoints,
2. the parent specs link to it and stay honest about current versus target
   coverage,
3. the route tree clearly marks implemented, transitional, and target-only
   families,
4. the docs explain the remaining blockers to deleting `bootstrap/poll`,
5. OpenAPI, Rust schemas, and prose documentation use the same vocabulary,
6. no current endpoint added in code remains undocumented.

## 9. Immediate next step

The next change after this plan should be the first full pass of:

- `docs/specs/control-room-api-endpoint-reference-v1.md`

That pass should cover all currently implemented v1 endpoints before expanding
into target-only authoring or mesh families.
