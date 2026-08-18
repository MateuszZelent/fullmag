# Resource-first Control Room API v2

- Status: canonical control-room API contract
- Last updated: 2026-07-19
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
| `diagnostics` | GPU/CPU telemetry, engine logs, and revisioned solver/publisher performance diagnostics |

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

### Planned M0–M3 spin-transport projections

The spin-transport runtime contract reserves typed projections over the one
canonical `SceneDocument`:

```text
/v2/sessions/current/model/current-transports
/v2/sessions/current/model/spin-transports
/v2/sessions/current/model/spin-interfaces
/v2/sessions/current/model/spin-torques
/v2/sessions/current/model/oersted-fields
```

These routes are **planned**, not asserted as implemented by this spec update.
When implemented, collection routes use `GET`/`POST`, item routes use
`GET`/`PATCH`/`DELETE`, mutations require `base_revision`, and responses return
the committed scene plus `scene_revision`. A stale revision returns
`409 revision_conflict`. The projections must not create a second physics
model or permit a raw merge patch to lose tagged-union variants.

Stable quantity ids remain `V_electric`, `J_charge`, `H_oe`, `torque_stt`, and
`torque_sot`. Planned detailed ids include `spin_potential`,
`spin_current_tensor`, `spin_flux_normal`, `torque_zhang_li`,
`torque_slonczewski`, `torque_transport`, and `torque_spin_total`. A rank-2
spin current uses the existing FMVP data plane with `n_comp=9` and versioned
`row_major_Q_ia` metadata; it is never flattened semantically into a vector.
Solver residuals, balance errors, refresh counts, and requested/resolved lane
belong in thin diagnostics/manifests, while numerical arrays stay under
`data/fields`.

## 3.1 Realtime invalidation rules

The canonical websocket remains an invalidation bus, not a payload stream. That
contract has stricter ownership rules than the HTTP routes:

- `resource.batch_changed` may only announce resources whose underlying payload
  freshness actually changed.
- Simulation preparation changes use resource family `simulation` with
  `resource_id = "preparation"` and carry only the preparation revision plus
  the canonical HTTP fetch hint. The
  websocket never carries the preparation stage list, execution summaries,
  bounded log tail, or failure body.
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
| `simulation/preparation` | bounded startup preparation aggregate: canonical stage order/status, current progress, stage timing, requested/resolved execution summaries, safe log tail, and safe failure correlation |
| `simulation/stages/execution` | full stage tree and stage state, including tolerance-qualified completion duration |
| `simulation/solver/status` | live solver state: runtime state, algorithm, step, algorithm-appropriate `dt`, exact torque, separate RHS norm, convergence, stop reason/metric/unit, warnings |
| `diagnostics/solver-profile` | opt-in bounded phase profile plus explicit solver, end-to-end, and successful-publication rate objects |
| `simulation/solver/energies/*` | current and historical energy samples |
| `data/tables/default/rows` | table-shaped scalar history for ECharts windows, including `cursor`, `from_row`/`to_row`, `from_t`/`to_t`, `limit`, `target_points`, `decimation`, and `include_tail` query identity; JSON rows are the control-plane/debug view, while `rows.bin` is the production data-plane payload for chart values |
| `data/scalars` | compatibility projection of the default scalar table, not a second scalar-history owner |
| `data/artifacts` | artifact index entries; entries may expose optional region-owned authoring provenance summaries (`scene_revision`, authored region count, material field count, coupling count, blocked/deferred diagnostic counts) but must not inline heavy artifact payloads |
| `data/material-fields` and `data/material-fields/{field_id}` | material-parameter field data catalog and per-assignment realized sample payloads for authored material fields; detail resources may include typed realized material-field asset metadata (`asset_id`, `artifact_path`, mesh identity, location, component count, source kind, algorithm, timing), while `model/material-fields` remains the summary/status resource |
| `data/mesh-region-membership/{region_id}` and `data/mesh-region-memberships` | realized-region membership indices for current FEM mesh parts, with explicit `object_segments` fallback when no mesh-part entry exists and typed Box/Cylinder/Sphere geometry projection for authored regions without mesh parts; topology remains owned by mesh topology resources, and the list resource exposes available memberships plus owner-qualified `unresolved_regions[]` entries without moving heavy topology into status |
| `data/fdm-region-memberships` and `data/fdm-region-membership[/{region_id}]` | thin realized FDM membership descriptor plus full or region-scoped binary FMRM payloads. The descriptor owns grid/legend identity and an optional exact `magnetic_support` summary derived from the realized active and region masks: cell-edge support bounds and active, inactive, and active-unassigned cell counts. Legacy artifacts may omit the summary; consumers then fail closed instead of inferring support from authored or domain bounds. The binary payload remains the owner of per-cell membership. |
| `meshing/summary` | lightweight mesh dashboard summary and revision pointers |
| `meshing/builds` | mesh build history collection |
| `meshing/builds/current` | current build/pipeline state, current resolved build target, and mesh provenance (`source_scene_revision`, `geometry_realization_revision`) |
| `meshing/builds/latest-successful` | last successful build reference or artifact summary plus mesh provenance (`source_scene_revision`, `geometry_realization_revision`) |
| `meshing/semantics` | solver-domain mesh semantics: universe/shared-domain/object configs and solver mesh identity |
| `meshing/meshes/shared-domain/manifest` | mesh identity, mesh provenance, object segments, mesh parts, and tree/selection metadata |
| `meshing/meshes/*/quality`, `meshing/meshes/*/quality/per-element`, `meshing/meshes/*/report`, and `meshing/meshes/*/size-field` | detailed shared-domain, object-scoped, and airbox-scoped quality summaries, binary per-element quality data, reports, and realized size-field diagnostics |
| `visualization/client-acks` | latest client-side acknowledgement per browser viewport for observed visualization-state revisions |

### Simulation preparation contract

`GET /v2/sessions/current/simulation/preparation` returns the current
`SimulationPreparationResource`, or `404` while no preparation snapshot is
available. The aggregate exposes the canonical nine preparation stage ids,
explicit aggregate/stage/log enums, optional backend-reported progress in the
inclusive range `0..100`, monotonic-derived stage durations, requested and
resolved execution summaries, at most 200 bounded safe log entries, and an
optional safe failure with a diagnostics correlation id.

Stage ordering is defined by the aggregate `revision` and canonical stage
sequence, not by Unix wall-clock ordering. If the system wall clock moves
backward while a stage is active, the transition continues, `duration_ms`
remains monotonic-derived, the raw observed Unix timestamp is preserved, and
the stage exposes `clock_adjustment` with the observed timestamp, stage-start
timestamp, and backward delta. The runtime must not silently clamp or retry a
preparation transition after a wall-clock adjustment.

`GET /v2/sessions/current/status` exposes only
`resources.simulation_preparation_revision`; it does not copy preparation
content. Detailed mesh state remains owned by `meshing/builds/current`, and
full engine logs remain owned by `diagnostics/engine-log`.

Preparation snapshot updates emit the existing `resource.batch_changed`
envelope with `resource = "simulation"`, `resource_id = "preparation"`, the
new revision, and the canonical
`recommended_fetch = "/v2/sessions/current/simulation/preparation"`. HTTP v2
remains authoritative; the event is cache invalidation only.

FDM membership realization has an independent
`region_membership_revision`; neither `mesh_revision` nor
`domain_generation_id` substitutes for it. A revision change emits a
`resource.batch_changed` entry with `resource = "domain"`,
`resource_id = "fdm-region-memberships"`, the current domain generation, and
`recommended_fetch = "/v2/sessions/current/data/fdm-region-memberships"`.
The event carries no descriptor or mask data. HTTP v2 remains authoritative,
and the recommended fetch invalidates the descriptor and its revision-scoped
binary membership consumers.

### Relaxation solver contract

The simulation resources expose one algorithm-specific relaxation contract:

- defaults are `torque_tolerance_apm=1e-4` (`A/m`) and `max_steps=50000`;
- only `llg_overdamped` carries integrator, `dt`, damping override, and
  `max_relaxation_time_s`; PG-BB/NCG hide and reject those fields, and their
  accepted line-search step has unit `m/A`;
- `tangent_plane_implicit` is unavailable in strict mode and on forced GPU;
  extended mode may show the CPU/MFEM development resolution and warning;
- `max_torque_Apm` is the exact fresh accepted-state `max |m x H_eff|` in
  `A/m`; `max_torque_T` is its equivalent in `T`, while
  `max_rhs_norm_per_s` is separate and has unit `1/s`;
- stage execution owns `status`, `converged`, reason, typed metric/value/unit,
  threshold, and diagnostics. Budget exhaustion is completed/non-converged;
  numerical stagnation is failed/non-converged. Table rows and artifacts do
  not infer completion.
- `time_to_tolerance_seconds` uses stage start/completion timestamps only
  when `status=completed`, `converged=true`, the reason and canonical metric
  kind/name form a coherent torque or energy tolerance, both value and
  threshold are finite and non-negative, and `value <= threshold`; it is absent
  for gradient/numerical stagnation, `max_steps`, time budgets, cancellation,
  skipped, stopped, failed, missing, mismatched, or non-finite records.
- solver and end-to-end rates share the same closed profiler window and source
  revision. Successful-publication rate is the accepted-step delta between
  ordered same-run successful HTTP endpoints divided by their completion span;
  duplicates and out-of-order endpoints are ignored, while a run change resets
  the zero-count boundary. Each rate is
  `{ value, window_step_count, window_wall_time_ns, source_revision }`.
- deprecated `status.metrics.steps_per_second` is only an end-to-end scalar
  alias. Without a closed monotonic profiler span it is null; status never
  carries the full rate objects.

The named `diagnostics/solver-profile` resource also preserves the native
transaction and demag timing counters for each sampled step. RK transaction
fields distinguish host enqueue/capture/restore wall time, device elapsed time,
captured bytes, and rollback/commit counts. HYPRE fields distinguish host API
wall time, dependency-event enqueue time, device elapsed solve time, event-wait
count, and timed-solve count. `timing_semantics` labels each counter as
`exclusive`, `inclusive`, `overlapped`, `enqueue_only`, or `device_elapsed`;
clients must not add counters with different semantics to reconstruct a wall
time. The profile resource is opt-in and bounded; missing timing samples are
represented by zero counters plus an empty semantic list and are not evidence
that a zero-time operation was measured.

The Study Explorer node and its Inspector consume these typed v2 resources
through the generated transport, handwritten facade, and resource hooks. They
do not construct endpoints or reinterpret torque units. HTTP v2 remains the
snapshot source of truth; websocket events only invalidate the affected
status, stage-execution, or solver-status resource.

Transitional duplicate fields in meshing schemas are allowed only for current frontend adapters and
must be documented as transitional in OpenAPI schema descriptions. New consumers should read from the
owning resource above.

Realtime invalidation follows the same single-owner rule. `visualization/state`
may project the current active quantity, camera, and layer policy, but it does
not own field payload freshness; `data/fields/*` does. Conversely,
`data/fields/*` does not own camera or workspace-shell freshness.

### Field materialization freshness

Field catalog descriptors and `data/fields/{quantity_id}/meta` own the
materialization state for each quantity. Both resources expose
`source_step`, `source_revision`, `materialized_at_unix_ms`,
`stale_by_steps`, `materialization_wall_time_ns`, and `state`, where `state`
is one of `complete`, `stale_complete`, `pending`, or `error`.

- `complete` means the materialized payload was produced from the current
  solver step.
- `stale_complete` means a complete payload remains available, but its
  `source_step` precedes the current solver step by `stale_by_steps`.
- `pending` means the selected quantity is being materialized and no complete
  payload for that quantity is available yet.
- `error` is reserved for an explicit materialization failure; it must not be
  inferred from ordinary staleness.

A client must retain and render `stale_complete` data while its topology
generation remains compatible. A quantity switch resolves to the last
complete frame for that quantity or to explicit `pending`; waiting must not
clear an otherwise compatible viewport payload. The thin session status owns
only field-family revision pointers and never copies these per-quantity
freshness fields.

### Target-scoped field availability

`GET /v2/sessions/current/data/fields/{quantity_id}/availability` is the
control-plane read model for deciding whether one concrete viewport target can
use a field carrier. It accepts optional `target_id`, `scope_kind`, `scope_id`,
and `owner_object_id` query parameters. `scope_kind` defaults to `full` and
supports `full`, `object`, `region`, `part`, `layer`, and `airbox`.

The response identifies `quantity_id`, `target_id`, `scope_kind`, the optional
scope and carrier identities, `generation`, and an optional field `revision`.
Its boolean fields describe backend facts: `supported`, `materialized`, and
`pending`. `state` is one of `supported`, `materializing`, `ready`, `stale`,
or `unavailable`; `reason_code` is optional and machine-readable. A missing
carrier is not replaced by a common-grid carrier for a dedicated multilayer
Airbox target. The resource never contains `adopted`: renderer adoption is a
frontend fact and must remain outside the backend availability contract.

This resource is a thin readiness query, not a field payload. HTTP v2 remains
the source of truth; realtime events may invalidate this resource, but must
not carry its full snapshot or any field samples.

## 3.2 Capability ownership

Capability resources have distinct scopes:

- `platform/capabilities`: process/runtime/server-level capability matrix.
- `sessions/current/status.capabilities`: the only UI gating source for the active session.
- `meshing/capabilities`: meshing policy/build feature matrix only; it must not drive global UI gating.

`status.capabilities.active_lane` is the planner-owned operation snapshot for
the current session. It carries authored ProblemIR intent, the effective
execution request after managed-launcher/environment overrides, an optional
resolved lane only when backend, discretization, device, precision, and mode
were explicitly resolved, provenance for both intent layers, planner source identity, qualification as a separate
non-claim, and stable operation entries with `state`, `reason_code`, `reason`,
and `requires`. `reason_code` is machine-readable and version-stable;
human-readable `reason` text may evolve. The active-lane snapshot schema is
`active-lane-capabilities.v2`.
The operation state vocabulary is `supported | semantic_only | deferred |
unsupported | stale`. Missing planner capabilities produce `source.kind =
unavailable`, `resolved = null`, and `stale` for every operation; clients must
not reconstruct support from `domain.discretization`, engine-name heuristics,
or platform/meshing capabilities.

`active_lane.authored`, `active_lane.requested`, and `active_lane.resolved`
must be labelled in the UI as **Authored request**, **Effective request**, and
**Resolved**. In particular, `FULLMAG_FDM_EXECUTION=gpu` may produce authored
`device=cpu`, effective `device=gpu`, and resolved `device=gpu`; collapsing
those values destroys launcher-override provenance.

## 3.3 Model authoring and Geometry object lifecycle

### Planar monitor model and field resources

`PlanarMonitor` is canonical model state, not a visualization-only draft. It
round-trips through `SceneDocument`, `ProblemIR`, and canonical Python:

```text
GET    /v2/sessions/current/model/planar-monitors
POST   /v2/sessions/current/model/planar-monitors
GET    /v2/sessions/current/model/planar-monitors/{monitor_id}
PATCH  /v2/sessions/current/model/planar-monitors/{monitor_id}
DELETE /v2/sessions/current/model/planar-monitors/{monitor_id}
POST   /v2/sessions/current/model/planar-monitors/{monitor_id}/duplicate
```

The planar visualization source is a separate session resource and never uses
`monitor_id = "default"` as a sentinel:

```json
{
  "source": {"kind": "default"},
  "default_slice": {
    "plane": "xy",
    "position_fraction": 0.5,
    "operator": {"kind": "plane_sample"}
  }
}
```

`source.kind = "default"` is resolved from the current published domain at
data-plane request time. It is not persisted in `SceneDocument`, `ProblemIR`,
or canonical Python. `source.kind = "monitor"` contains the authored monitor
ID and is resolved through the model resource. Public v9 patches validate a
finite `position_fraction` in `[0,1]` and a positive finite slab thickness;
legacy v8 persistence input is migrated privately and is never dual-written
as `active_monitor_id`.

Mutations carry `expected_scene_revision`, use the canonical scene transaction
owner, update script export, and emit invalidation. Monitor JSON contains only
physical target, frame, extent, and operator. Quantity and presentation state
are not model fields.

Spatial data uses separate revisioned resources:

```text
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/meta
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/scalar
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/vectors
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/empty-mask
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/mesh-overlay
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/probe
GET /v2/sessions/current/data/fields/{quantity_id}/planar-monitors/{monitor_id}/render.png
```

`meta` is fetched before heavy payloads and supplies resolved frame/operator,
shape, canonical URLs/ETags, revisions, occupancy, source/sampling execution,
basis/integration order, and diagnostics. Scalar/vector/mask/overlay resources
are bounded binary payloads using existing codecs where semantically valid.
`mesh_overlay_descriptor` rozróżnia `geometry_source=fem_topology` z
`codec=fmcs.v4` od `geometry_source=fdm_structured_grid` z `codec=fmfg.v1`.
FDM publikuje proceduralny centralny przekrój nośnika dla legalnego
`monitor_target`, ale nie publikuje target boundaries. ETag overlay wiąże
sample identity z konkretnym codec; zmiana warstwy prezentacji nie zmienia
`sample_token`.
Resolution is limited to `16..2048` per axis and vector budget to
`0..10000` before allocation.

The query may select a live field or a validated stage/snapshot pair. A
runtime-only `monitor_target | mesh_part | airbox` scope only narrows the
physical target and is keyed by current mesh revision. Stable error reasons
distinguish missing materialization, unsupported quantity/basis/scope,
non-injective surface projection, stale monitor/mesh/field revisions, and
sampling budget exhaustion.

Existing `/samples/slice` and `/projection` resources remain compatibility
adapters to the same `PlanarSamplingEngine` until a separately approved removal.
They are not a second numerical implementation.

The canonical source-specific data-plane families are the target contract for
Task 3 of the active default-slice implementation plan. They are **planned,
not executable at this document revision**: until the typed backend handlers,
OpenAPI generation, and resource hooks land, only the existing
`planar-monitors/{monitor_id}` family is a live implementation. A client must
not synthesize or request these paths before that task's route tests pass.

The planned families are:

```text
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/meta
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/scalar
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/vectors
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/empty-mask
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/mesh-overlay
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/probe
GET /v2/sessions/current/data/fields/{quantity_id}/planar-default/render.png
```

These routes and the existing `planar-monitors/{monitor_id}` family dispatch
to one typed source resolver and one sampler. Metadata publishes source kind,
resolved frame/operator, domain generation, and canonical child links; it does
not invent monitor hash/revision fields for `Default`.

The session-scoped `visualization/state.planar` resource owns range and raster
opacity. Its schema-7 range is `{ mode: auto|manual|symmetric, min, max }`;
manual limits are finite ordered SI values and the other modes carry null
limits. Display-unit conversion is a client presentation transform. Schema-6
`auto_contrast` and `contrast_*` are persisted migration input only and never
new browser/OpenAPI write aliases. `mesh-overlay` remains the existing data
route: `FMCS v4` adds parallel segment-kind bytes (`mesh_interior`, exact
`target_boundary`, or `unclassified_degenerate`) and a representation-specific
ETag. `FMCS v3` has no boundary proof and is degraded; FDM returns `204` with
an unavailable descriptor. The sample token and canonical query identity do
not change.

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

### Microwave antenna field-basis resources

The canonical antenna workflow is defined by physics note 0950 and ADR 0017.
It keeps authoring, stage lifecycle, field solutions, numerical fields, and
analysis products in their existing resource families.

Single-owner rules:

| Resource | Owns |
|---|---|
| `model/scene` | canonical antenna layouts, port modes, solved drives, regional drives, and study-stage authoring |
| `model/antennas` and `model/field-drives` | typed projections and semantic mutations over the same scene revision; not independent stores |
| `simulation/stages/execution` | full `AntennaFieldSolve` stage state in the common stage tree |
| `simulation/stages/{stage_id}/antenna-field-solve/*` | antenna-specific plan, progress, and diagnostics |
| `data/antenna-field-solutions/{solution_id}` | immutable solution manifest, signatures, provenance, and links to heavy fields |
| `data/fields` | `V_electric`, `J_charge`, `H_ant_basis`, instantaneous `H_ant`, and derived `h_perp` field resources |
| `analysis/antenna-excitation/{solution_id}/*` | source and local k-spectrum products |
| `analysis/spin-wave-response/{run_id}/*` | time-domain magnetization response products such as the dynamic structure factor |

Typed model projections:

```text
GET    /v2/sessions/current/model/antennas
POST   /v2/sessions/current/model/antennas
PATCH  /v2/sessions/current/model/antennas/{antenna_id}
DELETE /v2/sessions/current/model/antennas/{antenna_id}
GET    /v2/sessions/current/model/field-drives
POST   /v2/sessions/current/model/field-drives
PATCH  /v2/sessions/current/model/field-drives/{drive_id}
DELETE /v2/sessions/current/model/field-drives/{drive_id}
```

Every model mutation uses `base_revision` and returns the new
`scene_revision`. New control-room code does not rewrite the loose
`current_modules.modules` array through a raw merge patch.

An antenna field solve is submitted through the existing simulation command
route with `kind="solve"` and a stage target. The API does not add a separate
antenna command family.

Stage details:

```text
GET /v2/sessions/current/simulation/stages/{stage_id}/antenna-field-solve/plan
GET /v2/sessions/current/simulation/stages/{stage_id}/antenna-field-solve/progress
GET /v2/sessions/current/simulation/stages/{stage_id}/antenna-field-solve/diagnostics
```

Solution and analysis resources:

```text
GET /v2/sessions/current/data/antenna-field-solutions
GET /v2/sessions/current/data/antenna-field-solutions/{solution_id}
GET /v2/sessions/current/data/antenna-field-solutions/{solution_id}/projections
GET /v2/sessions/current/analysis/antenna-excitation/{solution_id}/source-spectrum
GET /v2/sessions/current/analysis/antenna-excitation/{solution_id}/local-k-spectrum
GET /v2/sessions/current/analysis/spin-wave-response/{run_id}/dynamic-structure-factor
```

Heavy conductor, field, and spectrum arrays stay out of JSON manifests and
status. V/J/H fields use the existing field vector, slice, and projection data
plane. Large source-spectrum and k-omega matrices use a versioned tiled raster
codec with thin JSON axis/unit metadata. The existing
`projection/profile` remains a depth profile through one raster pixel and is
not reused as an arbitrary spatial line cut; line cuts are revisioned analysis
products under `analysis/field-line-cuts`.

Every field advertises a `domain_ref`: V and J live on conductor topology,
field bases may live on an antenna inspection grid, and LLG projections live
on a concrete magnetic target topology. Matching point counts do not make
different domains compatible.

The websocket announces exact command lifecycle and changed resource
revisions. Geometry, port, mesh, and target changes may invalidate solution
resources. A waveform-only edit invalidates model/drive state but does not
advance the antenna field-solution or field-basis revision.

### Planar topological-charge analysis resource

The canonical physical and numerical contract is
`docs/physics/0940-topological-charge-observable.md`. The browser resource is:

```text
GET /v2/sessions/current/analysis/extensions/objects/{object_id}/topological-charge
```

This is an object-scoped analysis resource over materialized magnetization and
mesh/domain resources. It is not an object metric, visualization state, shader
output, or authoring mutation.

The production query is typed and closed:

| Parameter | Values | Rule |
|---|---|---|
| `plane` | `auto`, `xy`, `xz`, `yz` | `auto` resolves the thinnest magnetic-object extent; ties use `xy`, then `xz`, then `yz`; the response returns requested and resolved plane plus the canonical ordered support frame |
| `support` | `midplane`, `layer_profile` | `midplane` is the default; profile evaluation is explicit |
| `profile_samples` | `auto` or integer `3..257` | optional; legal only for `layer_profile`; omission resolves to `auto` for a profile; ignored parameters are a `400`, not a silent fallback |
| `snapshot_id` | canonical snapshot id | selects the same magnetization snapshot as the field data-plane resolver |
| `stage_id` | canonical stage id | optional scope validation for `snapshot_id` |
| `method` | `berg_luescher_oriented_triangles_v2` | the only production method in this resource version |

`quantity_id` is not user-selectable in the production contract: this
observable consumes canonical `m`. A future dimensional-`M` method needs a
separate versioned normalization contract.

`stage_id` without `snapshot_id` is a `400`. With no snapshot id, the source is
the captured current materialized `m` revision. The endpoint never substitutes
a preview field or an arbitrary latest persisted snapshot.

The response is versioned as `topological_charge.v2` and separates:

- computation `status` from scientific `trust`;
- requested support from resolved support and ordered frame;
- scalar charge from the full physical-coordinate layer profile;
- integral validity from nearest-integer qualification;
- source provenance from cache identity.

Scientific `status` is one of `ready`, `no_current_magnetization`,
`empty_support`, `invalid_magnetization`, `degenerate_support`,
`under_resolved`, `unsupported_geometry`, or `unsupported_discretization`.
`idle`, `loading`, `stale`, and `error` belong to the frontend resource
lifecycle, not to this successful HTTP payload. Invalid queries return `400`,
missing object/snapshot/stage identities return `404`, provenance races return
`409`, and unexpected failures return `500`.

Status and trust precedence follow physics note 0940 exactly. In particular,
`under_resolved` retains a diagnostic charge with
`trust=diagnostic_resolution`; missing, invalid, empty, degenerate, and
unsupported results have no charge and use `trust=unavailable`.

The response must include object id, requested/resolved plane and support,
ordered axes and normal, field revision and storage domain, field-node mapping
identity, mesh revision and generation, domain generation, scene revision,
snapshot/stage identity, discretization and FEM order, method version, resource
revision digest, actual computation timestamp, support topology diagnostics,
boundary diagnostics, resolution diagnostics, warnings, and every requested
profile sample with `coordinate_m` and `integration_weight_m`.

`nearest_integer` and `integer_error` are present only when `trust=qualified`.
The resource does not expose `polarity`; polarity and vorticity require their
own texture classifiers.

Only planar FDM supports and tetrahedral FEM P1 supports are legal. Curved
surfaces, high-order FEM, full 3D topological flux, and Hopf index return typed
unsupported status. The backend must not use global FDM data for an object
request, match compact FEM fields by array length, use arbitrary coplanar tetra
faces as an implicit layer, or use renderer/preview topology as a production
support.

The cache lookup precedes support construction and computation. Cache identity
includes object, field, mesh, domain, scene, exact current-or-snapshot source
identity, requested and resolved support, and method version. The live-session
read lock is released before cache lookup and numerical work.

HTTP v2 remains authoritative. Both exact `m` sample changes and broad field
sample invalidations invalidate this analysis family. Mesh, domain, object
scope, and snapshot changes do the same. WebSocket events carry only invalidation
identity and revision; they never carry `Q`, profiles, or support triangles.

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
| `/v2/sessions/current/meshing/meshes/shared-domain/quality-gates` | `GET` | Read revision-bound generic mesh gates plus typed mixed-certificate quality evidence. |
| `/v2/sessions/current/meshing/meshes/shared-domain/quality/per-element` | `GET` | Read binary `FMMQ` per-element quality arrays for heatmap overlays. |
| `/v2/sessions/current/meshing/meshes/shared-domain/cross-section` | `GET` | Read binary `FMCS` shared-domain cross-section geometry for statistics and advanced inspection. |
| `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/quality` | `GET` | Read binary `FMQS` quality values for a shared-domain cross-section. |
| `/v2/sessions/current/meshing/meshes/shared-domain/cross-section/image` | `GET` | Read a server-rendered PNG preview/export for a shared-domain cross-section. |

The three cross-section resources are currently tet4-only. When the active FEM
mesh contains prism, pyramid, or another non-tetrahedral cell, they return HTTP
`409` with the typed `ApiErrorResponse.code` value
`mixed_topology_not_supported`. Clients must present that state explicitly and
must not reinterpret the first four nodes as a tetrahedron or repeatedly retry
the unsupported request at the same mesh revision.
| `/v2/sessions/current/meshing/meshes/universe/quality` | `GET` | Read universe/airbox mesh quality diagnostics; when the airbox scope exists, `quality.global` is the airbox quality scope. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/topology` | `GET` | Read object-scoped binary topology when available. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/report` | `GET` | Read object mesh report diagnostics. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/quality` | `GET` | Read object mesh quality diagnostics; when the object marker is known, `quality.global` is the object's mesh-quality scope. |
| `/v2/sessions/current/meshing/meshes/objects/{object_id}/size-field` | `GET` | Read object realized size-field projection. |

The shared-domain quality-gates resource retains its generic `gates`
projection for compatibility and separately owns a typed `mixed_certificate`
sidecar. That sidecar is derived only from the accepted mixed-layer topology
certificate and binds its evidence to the current mesh `revision` and live
`topology_fingerprint`. Each family row names the certificate metric, family,
fifth percentile, acceptance threshold, pass/fail result, minimum order-2
Jacobian in cubic metres, and positive-Jacobian result. The API must not derive
or synthesize missing per-family values from generic mesh statistics.

Mixed-certificate evidence is `valid` only when the certificate is accepted,
its fingerprint matches the live topology, every published family has complete
finite evidence, and all current mixed-cell families are represented. Missing,
rejected, malformed, or fingerprint-mismatched evidence returns an explicit
`unavailable`, `rejected`, or `stale` sidecar with no family rows. Consumers
must fail closed and must not reuse evidence from an earlier mesh revision.

`meshing/builds/current.mixed_layer_topology_rejection` is the typed failure
surface for the latest mixed-P1 attempt. It always preserves the rejection
category and reason when published and may additionally carry backend-supplied
missing capability IDs, requested/resolved execution tuples, explicit
no-fallback evidence, and the explicit `free_tetrahedral` alternative. Those
optional fields are pass-through evidence: the API and frontend must not infer
them from prose or promote an unsupported execution lane. A rejected build is
not a solver-accepted topology certificate.

Wymagane zakresy próbek pola:

| Domena backendu | `scope_kind` | `scope_id` | Rozwiązany nośnik |
|---|---|---|---|
| FEM | `full` | Pominięty | Pełna domena węzłowa |
| FEM | `object` | Wymagany identyfikator obiektu | Podzbiór węzłów kwalifikowany właścicielem; zgodność samej geometrii nie wystarcza |
| FEM | `part` | Wymagany identyfikator części siatki | Podzbiór węzłów części siatki |
| FEM | `airbox` | Opcjonalny identyfikator części powietrznej | Jawna część powietrzna albo pierwsza kanoniczna część airbox |
| FEM | `selection` | Pominięty | Bieżące zaznaczenie workspace rozwiązane przez backend |
| Jednosiatkowy FDM | `full` | Pominięty | Pełna siatka komórek |
| Jednosiatkowy FDM | `object` | Wymagany identyfikator obiektu | Komórki należące do bieżących wpisów legendy FMRM obiektu |
| Jednosiatkowy FDM | `region` | Wymagany identyfikator regionu | Komórki zgodne z wpisem bieżącej legendy regionów FMRM |
| Jednosiatkowy FDM | `airbox` | Opcjonalny | Komórki oznaczone jako powietrze przez bieżące członkostwo FMRM |
| Wielowarstwowy FDM | `full` | Pominięty | Połączony payload warstw natywnych w kolejności artefaktu |
| Wielowarstwowy FDM | `object` | Wymagany identyfikator magnesu/obiektu | Natywny payload warstwy obiektu bez projekcji na siatkę wspólną |
| Wielowarstwowy FDM | `layer` | Wymagany identyfikator warstwy natywnej | Payload nazwanej warstwy natywnej bez projekcji na siatkę wspólną |

Pozostałe kombinacje kończą się błędem bez niejawnego fallbacku. Jednosiatkowy
FDM nie przyjmuje `part`, `layer` ani `selection`, a wielowarstwowy FDM nie
przyjmuje `region`, `part`, `airbox` ani `selection`. Bieżący artefakt
wielowarstwowy nazywa każdą warstwę natywną przez `magnet_name` jej właściciela,
więc `object` i `layer` mogą wybrać ten sam natywny payload. Rozwiązany
`scope_kind` zachowuje jednak dokładnie żądaną tożsamość i nie może być
przepisywany z `object` na `layer`.

Scope resolution is a backend contract. The frontend may request a selected scope, but it must not
download full-domain data just to filter large FEM payloads client-side.

Payloady wektorowego pola w FMVP v3 używają 48-bajtowego nagłówka zewnętrznego,
po którym występuje wyrównany blok metadanych `FMMI`. Metadane w wersji 2 mają
następujący układ little-endian:

| Offset metadanych | Typ | Znaczenie |
|---:|---|---|
| 0 | 4 bajty | Magic `FMMI` |
| 4 | `u16` | Wersja metadanych, dokładnie `2` |
| 6 | `u16` | Pole zastrzeżone, zero |
| 8 | `u16` | Długość `domain_generation_id` w bajtach UTF-8 |
| 10 | 6 bajtów | Pole zastrzeżone, zera |
| 16 | `u64` | Rewizja topologii siatki albo nośnika |
| 24 | 32 bajty | Hash topologii siatki albo nośnika FDM |
| 56 | `u32` | Kod indeksowania pola |
| 60 | `u32` | Liczba zakodowanych indeksów węzłów/komórek |
| 64 | `u16` | Długość `scope_kind` w bajtach UTF-8 |
| 66 | `u16` | Długość `scope_id` w bajtach UTF-8 |
| 68 | zmienny | `scope_kind`, `scope_id`, dokładny `domain_generation_id`, następnie indeksy `u32` little-endian; dopełnienie zerami do wielokrotności 8 bajtów |

`domain_generation_id` jest nieprzezroczystym tekstem, a nie rewizją liczbową.
Jego bajty UTF-8 w FMVP metadata v2 muszą dokładnie odpowiadać zasobowi JSON i
nagłówkowi `x-fullmag-domain-generation-id`. Klient zachowuje ten tekst bez
parsowania, normalizacji i konwersji liczbowej. Liczbowa rewizja topologii nadal
ma typ `u64`; klient JavaScript musi dekodować ją bez utraty precyzji, na
przykład do tekstu dziesiętnego albo `bigint`, ponieważ może przekroczyć
`Number.MAX_SAFE_INTEGER`.

FMVP v3 przenosi również rodzaj/identyfikator zakresu, tryb indeksowania oraz
`node_indices` dla jawnych lub próbkowanych payloadów niepełnej domeny. Dla
nośników FDM są to numery porządkowe komórek; dla natywnego payloadu
wielowarstwowego są lokalne względem siatki wybranej warstwy.
`sampled_node_indices` payloads with a complete `node_indices` mapping and
matching mesh topology are valid for vector glyph placement and the
`surface_faces`/`thickness_average_z` surface projection modes. Raw nodal
surface coloring still requires complete field coverage. FMVP v2 remains a
legacy full-domain compatibility format and must not be treated as proof for
scoped FEM surface mapping.

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

## 7. Persistent observation source contract

HTTP v2 pozostaje źródłem prawdy dla bieżących i historycznych obserwacji;
websocket przenosi tylko lifecycle, completion i invalidation. Istnieje jeden
field data plane dla `Current` i `Frame`, z tym samym codec, scope, ETag i
typed error vocabulary. WebSocket nie niesie pól, topologii, ramek ani pełnego
stanu sesji.

Każde żądanie `ComputeQuantities` wskazuje `ObservationSource` i listę
`quantity_ids`. `Current` używa pełnego `AcceptedStateRef`, czyli trwałego
content-bound `AcceptedStateId` oraz lokalnej `AcceptedStateGeneration`;
`Frame` używa immutable frame ID i trwałego accepted-state ID. Clock jest
częścią digestu. Stale generation odrzuca komendę przed compute.

Historyczne compute jest obsługiwane przez odrębny `ObservationRuntime` bez
step/run/publisher API i nigdy nie swapuje `LiveRuntime`. Availability jest
niezależne od cache/materialization. Brak primary carriera zwraca typed
`unsupported_missing_primary_state`. `ComputeFields` i `ComputeEnergies`
mogą być przejściowymi command aliases, ale wszystkie payloady przechodzą przez
jeden `ComputeQuantities` i jeden field data plane.

Autosave frame jest observation source, nie resume checkpointem. `.fms`
powstaje wyłącznie po jawnym Save/Save As/Export; import waliduje kandydacki
runtime i wykonuje jeden atomowy swap albo nie zmienia aktywnej sesji. Task 0
nie zmienia OpenAPI ani generowanych typów/transportu: opisuje obowiązek
późniejszej implementacji, więc żadna runtime capability nie jest promowana.
