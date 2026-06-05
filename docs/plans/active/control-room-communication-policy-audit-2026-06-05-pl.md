# Control Room communication policy audit

Date: 2026-06-05
Scope: `apps/control-room`, `crates/fullmag-api`, `crates/fullmag-session`

## Executive summary

The current Control Room communication model is partly resource-first and partly still accidental.
The core architecture is sound: HTTP v2 owns snapshots and heavy payloads, while WebSocket carries
`hello`, `heartbeat`, `resource.batch_changed`, `resync.required`, and the new lightweight
`scalar.sample` telemetry event. The problem is that not every live UI surface consumes the right
channel yet.

The most important current defects are:

1. Footer telemetry is not driven by `scalar.sample`. It reads `session:status`,
   `/simulation/solver/status`, `/model/scene`, and `/simulation/objects/{object_id}/metrics`.
   This explains why it feels slow while `scalar.sample` may already be arriving over WebSocket.
2. Field vectors are still the dominant heavy traffic source. WebSocket invalidates
   `fields:samples`, and every active matching field-vector resource may issue a binary HTTP GET,
   rate-limited by `field_sample_publish_ms` currently defaulting to 2000 ms.
3. Scalar charts have the right direction: they fetch initial table rows over HTTP/binary and append
   lightweight `scalar.sample` events locally. Footer telemetry should follow the same pattern.
4. `simulation/objects/{object_id}/metrics` is consumed by footer and inspector panels, but no
   dedicated realtime invalidation is currently visible for that endpoint. That makes object metrics
   stale or dependent on unrelated refetch paths.
5. Communication timings exist in code, but they are split between backend constants and frontend
   policy defaults. There is no backend-owned editable/persisted communication-policy resource yet.

This report should be used before implementing the `Tools -> Communication` modal. The modal should
edit one backend-owned policy resource, not a frontend-only override.

## Current timing constants

Backend defaults live in `crates/fullmag-session/src/communication_policy.rs` and are mirrored by
`crates/fullmag-api/src/realtime_policy.rs`.

| Setting | Current default | Current effect |
|---|---:|---|
| `LIVE_REALTIME_HEARTBEAT_SECS` | 15 s | WS heartbeat cadence |
| `LIVE_REALTIME_RECONNECT_MS` | 5000 ms | Frontend reconnect delay after WS close |
| `LIVE_REALTIME_COALESCE_WINDOW_MS` | 250 ms | Default `resource.batch_changed` coalesce window |
| `LIVE_REALTIME_FIELD_SAMPLE_COALESCE_WINDOW_MS` | 2000 ms | Intended field-vector/sample lane window |
| `LIVE_TABLE_ROWS_MIN_REFETCH_MS` | 1000 ms | Minimum HTTP refetch cadence for scalar/table rows |
| `LIVE_SCALAR_TELEMETRY_INTERVAL_MS` | 200 ms | Intended lightweight scalar sample cadence |
| `LIVE_STATUS_REFRESH_MS` | 5000 ms | Minimum HTTP refetch cadence for `session:status` |
| `LIVE_REALTIME_DIAGNOSTICS_SUMMARY_WINDOW_MS` | 5000 ms | Intended diagnostics summary cadence |
| `LIVE_ERROR_RETRY_MS` | 1000 ms | Resource hook retry backoff after errors |
| `LIVE_REALTIME_REPLAY_CAPACITY` | 512 events | WS replay buffer capacity |

Frontend defaults live in `apps/control-room/src/kernel/realtime/communicationPolicy.ts` and are
updated only from the WS `hello.payload.communication_policy`. They currently control frontend
minimum refetch intervals and reconnect delay, but there is no frontend API to patch the backend
policy.

## Current refresh mechanics

The main refresh chain is:

1. Backend changes runtime state.
2. Backend publishes a WebSocket event.
3. `RealtimeClient` receives the event and records diagnostics.
4. `RealtimeInvalidationBridge` maps the event to resource invalidations or local events.
5. `ResourceInvalidationController` updates resource revisions.
6. `useResource` / `useResourceSelector` calls `ResourceRuntimeStore.ensureLoad`.
7. `ResourceRuntimeStore` deduplicates in-flight requests, aborts stale requests, and applies
   `minRefetchIntervalMs`.
8. HTTP JSON or binary resources refetch only if mounted consumers exist.

The important detail: most UI data is not "pushed" into React over WS. WS usually invalidates a
resource. The actual data then comes from HTTP. The exception added recently is `scalar.sample`,
which carries one lightweight scalar row and is already consumed by `AnalysisPlotsModule`.

## WebSocket channels

| Event type | Payload size class | Producer | Current frontend handling | Cadence / window | Intended use |
|---|---|---|---|---|---|
| `hello` | small JSON | `build_current_live_realtime_hello_event` | Updates frontend communication policy, invalidates session scope | On WS connect/reconnect | Initial identity, revisions, policy |
| `heartbeat` | tiny JSON | WS loop in `handle_current_live_realtime_ws` | Diagnostics only, sequence tracking | 15 s | Connection liveness |
| `resource.batch_changed` | small to medium JSON | `publish_current_live_realtime_resource_changes` | Invalidates recommended fetches, prefixes, or field-vector resource keys | 250 ms default, split by QoS lane | Resource freshness signal |
| `scalar.sample` | small JSON | `publish_current_live_realtime_scalar_sample` | Emits `telemetry:scalar-sample` on kernel bus | Intended 200 ms | Live scalar telemetry tick |
| `resync.required` | tiny JSON | WS replay gap handling | Invalidates `session:status` / session scope | On sequence gap | Force HTTP recovery |

## Backend resource-change map

This is the authoritative current backend mapping from `current_live_realtime_changes()`.

| Resource change | Recommended fetch | Frontend invalidation behavior | Current cadence class | Notes |
|---|---|---|---|---|
| `display` | `/v2/sessions/current/visualization/display` | Direct resource invalidation | Lifecycle, 250 ms if coalesced | Display endpoint exists but current UI mostly uses visualization state |
| `visualization_state` | `/v2/sessions/current/visualization/state` | Direct invalidation, with suppression for local optimistic state | Lifecycle, 250 ms if coalesced | Local patches use quiet 600 ms, max latency 2500 ms |
| `workspace` | `/v2/sessions/current/workspace/selection` | Direct invalidation | Lifecycle | Selection/layout/ribbon state |
| `fields:catalog` | `/v2/sessions/current/data/fields` | Direct invalidation | Lifecycle | Light JSON catalog |
| `fields:samples` | none | Broad or quantity-scoped invalidation of matching field-vector resource keys | Field lane, intended 2000 ms | Main source of heavy binary GETs |
| `scalars:table:default:rows` | `/v2/sessions/current/data/tables/default/rows` | Direct invalidation and prefix invalidation | Scalar rows lane, intended 1000 ms | Analysis charts also consume `scalar.sample` |
| `domain` meta | `/v2/sessions/current/data/domain/meta` | Direct invalidation | Lifecycle | 3D domain metadata |
| `domain:topology` | `/v2/sessions/current/data/domain/topology` | Direct invalidation | Lifecycle, normally mesh/build events | Heavy binary topology |
| `artifacts` | `/v2/sessions/current/data/artifacts` | Direct invalidation | Lifecycle | Result/artifact catalog |
| `logs` | `/v2/sessions/current/diagnostics/engine-log` | Direct invalidation | Lifecycle | Footer diagnostics/log dock |
| `diagnostics:solver-profile` | `/v2/sessions/current/diagnostics/solver-profile` | Direct invalidation | Diagnostics lane not separately enforced yet | Optional profiler |
| `mesh` summary | `/v2/sessions/current/meshing/summary` | Direct invalidation | Mesh lifecycle | Mesh panels/explorer/ribbon |
| `mesh` detail fetches | dynamic list in `mesh_resource_fetches` | Direct invalidation | Mesh lifecycle | Includes manifest, reports, quality, policies depending on snapshot |
| `mesh_builds` | `/v2/sessions/current/meshing/builds/current` | Direct invalidation plus dependent mesh/scene/visualization/domain invalidations | Immediate/lifecycle depending caller | Progress and mesh build status |
| `commands` | `/v2/sessions/current/simulation/commands` | Direct invalidation, also status dependent | Immediate lane | Command queue and command completion |
| `stages` | `/v2/sessions/current/simulation/stages/execution` | Direct invalidation, also status dependent | Immediate lane | Study progress tree/progress bars |
| `scene_document` | `/v2/sessions/current/model/scene` | Direct invalidation | Lifecycle | Authoring model, inspector, viewport scene |

## Frontend resource consumers and cadence

### Shell and status

| UI surface | Current resources | Channel | Current cadence | Risk |
|---|---|---|---|---|
| Header `AppMenuBar` | `session:status`, `/simulation/solver/status`, `/visualization/state` | WS invalidation -> HTTP refetch | `session:status` min 5000 ms, solver status no explicit min, visualization state invalidation-driven | Header can lag because status is 5 s limited |
| Status bar | `session:status`, `/simulation/runs/current`, `/simulation/solver/status` | WS invalidation -> HTTP refetch | status min 5000 ms, others invalidation-driven | Runtime state may update faster than session status selectors |
| Startup overlay | `session:status` plus timer | HTTP/status hook plus `setTimeout` tick | Uses `statusRefreshIntervalMs()` = 5000 ms | Acceptable for startup, not live telemetry |

### Footer

| UI surface | Current resources | Channel | Current cadence | Risk |
|---|---|---|---|---|
| Footer telemetry | `session:status`, `/model/scene`, `/simulation/solver/status`, `/simulation/objects/{object_id}/metrics` | Mostly WS invalidation -> HTTP; object metrics lacks clear realtime invalidation | status min 5000 ms, solver status invalidation-driven, object metrics only selected-object/load-driven | Not live enough; not wired to `scalar.sample` |
| Footer diagnostics | `/diagnostics/engine-log`, `/diagnostics/cpu`, `/diagnostics/gpu`, `/diagnostics/solver-profile` | Engine log/solver profile invalidation-driven; CPU/GPU telemetry load on mount only unless invalidated elsewhere | No explicit recurring cadence visible for CPU/GPU | CPU/GPU telemetry may not refresh live |
| Transport log | `RequestDiagnosticsController` local diagnostics | Local append from API/WS diagnostics | Every recorded request/event | Can become noisy unless bounded/sampled |

### 3D visualization

| UI surface | Current resources | Channel | Current cadence | Risk |
|---|---|---|---|---|
| 3D domain meta | `/data/domain/meta` | WS invalidation -> HTTP JSON | Lifecycle | Low risk |
| 3D topology | `/data/domain/topology` | WS invalidation -> binary HTTP with ETag/cache | Mesh/domain lifecycle | Heavy but should be infrequent |
| 3D field vector, full scope | `/data/fields/{quantity}/samples/vector?...` | `fields:samples` WS invalidation -> binary HTTP | min 2000 ms per resource key | Main heavy live traffic |
| 3D airbox field vectors | multiple `/data/fields/{quantity}/samples/vector?...scope_kind=airbox...` | `fields:samples` WS invalidation -> binary HTTP per active key | min 2000 ms per key | Can multiply traffic by airbox parts/scopes |
| 3D quantity/part vectors | collection wrapper over many field-vector requests | `fields:samples` WS invalidation -> multiple binary HTTP GETs | min 2000 ms per collection/key | Needs subscription scoping |
| 3D mesh quality data | `/meshing/meshes/shared-domain/quality-data` | Mesh invalidation -> binary HTTP with cache | Mesh lifecycle | OK if not invalidated during solver steps |
| 3D scene/universe/manifest | `/model/scene`, `/model/universe`, `/meshing/.../manifest` | WS invalidation -> HTTP | Lifecycle | OK |
| Visualization client ACK | POST `/visualization/client-acks` | Client POST, backend emits `visualization_client_acks` immediate WS | Immediate/50 ms deferred `applied` ACK | Debug useful but can spam logs |

### 2D and charts

| UI surface | Current resources | Channel | Current cadence | Risk |
|---|---|---|---|---|
| Analysis plots initial table | `/data/tables/default/columns`, `/data/tables/default/rows.bin` | WS scalar rows invalidation -> binary HTTP | min 1000 ms | Good for snapshot/backfill |
| Analysis plots live scalar row | `scalar.sample` | WS event -> local append, no HTTP | intended 200 ms | Correct pattern |
| Scalar window legacy hook | `/data/scalars` | WS/status-driven HTTP | min 1000 ms | Should be secondary/backfill only |
| Cross-section image | `/meshing/meshes/shared-domain/cross-section-image` | Resource hook with revision in key, binary HTTP | Mesh/visualization revision-driven | OK; not solver-step live |
| Cross-section geometry/quality | `/cross-section`, `/cross-section-quality` | Resource hook with ETag/cache | Mesh/visualization revision-driven | OK |

### Study, commands, progress bars

| UI surface | Current resources | Channel | Current cadence | Risk |
|---|---|---|---|---|
| Study inspector progress | `/simulation/stages/execution`, `/simulation/commands`, `/simulation/runs/current`, `/simulation/solver/status` | WS invalidation -> HTTP | Commands/stages are immediate lane; solver status no explicit min | Good direction, but solver status can be over/under invalidated |
| Ribbon run controls | `session:status`, `/simulation/commands`, `/simulation/stages/execution`, `/simulation/solver/status`, mesh resources | WS invalidation -> HTTP | Status min 5000 ms; commands/stages immediate | Button state may lag if gated mostly by status |
| Explorer model tree progress | `session:status`, scene, mesh build, manifest, quality gates, realized size fields, stages | WS invalidation -> HTTP | Status min 5000 ms; stages immediate | Stage tree OK, status-gated loading can lag |
| Mesh build dialog | session status, mesh build current/latest, mesh summary, manifest, engine log | WS invalidation -> HTTP | Mesh/build lifecycle | OK if build revisions are not per solver step |

### Inspector and authoring panels

| UI surface | Current resources | Channel | Current cadence | Risk |
|---|---|---|---|---|
| Object material panel | `/model/scene`, `/model/materials/{id}`, `/model/objects/{id}/interactions/uniaxial_anisotropy` | HTTP resource hooks, PATCH mutations | Invalidation-driven, no live cadence | OK for authoring |
| Magnetic texture panel | `/model/scene`, `/model/regions`, PATCH object/region/asset, script sync | HTTP resource hooks and mutations | User-driven | OK; do not tie to solver-step cadence |
| Physics interaction panel | `/model/scene`, `/model/objects/{id}/interactions/{kind}` | HTTP resource hooks and PATCH | User-driven | OK |
| Mesh policy panels | mesh policy/report/quality/size-field/topology resources | WS mesh invalidation -> HTTP | Mesh lifecycle | OK if mesh invalidation is not per solver step |
| Object visualization panel | field catalog, visualization state, scene, manifest | WS invalidation -> HTTP | Field catalog lifecycle, visualization state local sync | OK |

## Current root-cause diagnosis

### Why footer telemetry is slow

Footer telemetry does not consume `telemetry:scalar-sample`. It builds its model from:

- `useSessionStatusSelector(selectFooterTelemetryStatus)`;
- `useSceneResource()`;
- `useObjectMetricsResource(objectId)`;
- `useSolverStatusResource({ enabled: Boolean(status) })`.

`session:status` is explicitly rate-limited by `statusRefreshIntervalMs()` = 5000 ms. Solver status can
update faster if invalidated, but the footer model is still mixed with slower status and object metrics.
Object metrics has no visible dedicated realtime invalidation in the current backend resource-change
map. Therefore footer telemetry cannot feel market-data-live even if scalar samples are already being
sent over WebSocket.

### Why vector logs are still huge

Field samples are invalidated by `resource.batch_changed` as `fields:samples`. Because the event has
no `recommended_fetch`, the frontend invalidates matching field-vector resource keys. Active 3D
views can have several matching keys: full magnetization, H_eff airbox, part-scoped vectors, glyphs,
or overlays. Every key then uses binary HTTP GET subject to `fieldVectorMinRefetchIntervalMs()`.
With the current 2000 ms window this is much better than per solver step, but still heavy if many
field-vector resources are mounted.

### Why analysis charts are closer to the right model

Analysis charts load table columns and a binary table snapshot over HTTP, then append `scalar.sample`
from the kernel bus. That gives fast perceived live updates without refetching the whole table every
solver step. This should be the model for footer telemetry as well.

## Professional target architecture

### Channel taxonomy

Use these channel classes in the backend policy resource and `Tools -> Communication` modal:

| Class | Examples | Transport | Default target | User control |
|---|---|---|---|---|
| Connection | `hello`, heartbeat, reconnect, replay | WS | heartbeat 15 s, reconnect 5 s | heartbeat/reconnect/replay capacity |
| Lifecycle control | commands, stages, mesh build, run state | WS invalidation -> HTTP | immediate or 100-250 ms | enable/disable, coalesce ms |
| Lightweight telemetry | `scalar.sample`, solver tick summary, footer live values | WS data tick | 100-250 ms | enable/disable, min interval |
| Scalar table backfill | table rows JSON/bin, scalar windows | HTTP resource | 1000 ms min | enable/disable, min refetch |
| Heavy field samples | vector field samples | WS invalidation -> binary HTTP | 1000-3000 ms default, adaptive | enable/disable, min interval, active quantity/scope only |
| Mesh/topology | domain topology, mesh quality data, manifests | HTTP/binary resource | event-driven only | enable/disable debug fetches, no periodic mode |
| Visualization state | display state, camera/layer patches, ACKs | PATCH/GET + WS invalidation | quiet 600 ms, max 2500 ms | quiet/max latency, ACK enable |
| Diagnostics | engine log, CPU/GPU, solver profile, request log | HTTP resource/local diagnostics | 1-5 s or on demand | enable/disable, sampling |

### Backend-owned communication policy resource

Add one resource:

- `GET /v2/sessions/current/events/communication-policy`
- `PATCH /v2/sessions/current/events/communication-policy`

It should return:

- `revision`;
- `defaults`;
- `effective`;
- `channels`;
- optional `overrides`;
- min/max validation bounds.

It should control backend emission, not only frontend refetch. The backend must apply it to:

- `resource.batch_changed` QoS split windows;
- field sample invalidation cadence;
- scalar sample publish cadence;
- heartbeat cadence;
- replay capacity if possible at startup or next session;
- diagnostics emission;
- optional channel disable switches.

The frontend must update its local policy only from this backend resource and from `hello`, not from
hardcoded local UI-only values.

### Recommended default policy

| Channel | Production default | Reason |
|---|---:|---|
| `scalar.sample` | 200 ms | Smooth enough for footer/charts, cheap payload |
| footer live telemetry render | 200 ms source, UI may render at 5-10 Hz | Human-readable live values without reflow storm |
| scalar table rows backfill | 1000 ms | Backfill and chart history do not need every tick |
| field vectors | 2000 ms while solver active, on demand while idle | Heavy payload, visual state changes slower than solver steps |
| field vector scope | active quantity and active scope only | Avoid multiplying binary GETs |
| commands/stages | immediate or 100 ms | Progress bars and command state should feel live |
| session status | 1000-5000 ms depending role | Keep status thin and not the telemetry source |
| visualization state PATCH | quiet 600 ms, max 2500 ms | Good UI interaction without PATCH spam |
| visualization ACK | enabled in diagnostics, deduped by revision/status | Useful for debugging, noisy if unconditional |
| CPU/GPU diagnostics | 1000-5000 ms only while diagnostics tab open | Not core solver telemetry |

### UI/UX target

The UI should show live data without turning every solver step into a full UI refresh:

1. Footer telemetry should subscribe to a lightweight live telemetry store fed by `scalar.sample`
   or a new `solver.telemetry.sample` event. It should not wait for `/simulation/solver/status`.
2. Analysis charts should keep the current pattern: HTTP/binary snapshot plus WS append.
3. 3D vectors should be adaptive: active quantity/scope only, slow live cadence, and no refetch if
   the viewport is hidden or the layer is disabled.
4. Progress bars should use commands/stages immediate resource invalidation, not scalar tables.
5. Material/mesh/physics authoring panels should remain user-driven and resource invalidation-driven,
   never solver-step-driven.
6. Diagnostics should be opt-in and sampled. Transport log should support channel filters and
   aggregation so debug itself does not become the performance issue.

### Modal design target

The `Tools -> Communication` modal should expose:

- channel toggles: WebSocket events, scalar telemetry, scalar table rows, field vectors, lifecycle,
  diagnostics, visualization ACKs;
- cadence fields: scalar sample ms, table refetch ms, field vector min ms, lifecycle coalesce ms,
  status refresh ms, diagnostics ms, heartbeat ms, reconnect ms;
- current effective policy and revision;
- reset to defaults;
- warning when disabling a channel that can make UI stale;
- no local-only persistence. PATCH the backend resource and let WS invalidation update other clients.

## Implementation order after this report

1. Add backend communication-policy state/resource and patch validation.
2. Add channel toggles and timing fields to `RealtimeCommunicationPolicy`.
3. Apply the policy to backend event publishing and QoS splitting.
4. Add frontend typed API facade and resource hook for the policy resource.
5. Add `Tools -> Communication` modal in the main menu, not the ribbon.
6. Refactor footer telemetry to consume live scalar telemetry instead of relying on solver status
   for fast values.
7. Add tests:
   - backend GET/PATCH policy;
   - backend channel disable/timing behavior;
   - frontend policy parser/resource hook;
   - menu exposes `Tools -> Communication`;
   - footer consumes `telemetry:scalar-sample`;
   - communication-budget smoke asserts field vectors and scalar ticks separately.

## Open verification items

The audit above is source-based. Before claiming production completion, run:

- backend focused realtime tests;
- frontend typecheck;
- frontend tests for realtime invalidation, communication policy, footer telemetry, and app menu;
- browser smoke with live solver to confirm:
  - footer updates at scalar tick cadence;
  - field vectors do not fetch more often than policy;
  - scalar table backfill does not fetch every scalar tick;
  - transport log volume is bounded and filterable.

