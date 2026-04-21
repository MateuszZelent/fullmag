# Control-Room API Endpoint Reference v1

- Status: canonical current endpoint reference for the local resource-first control-room API
- Last updated: 2026-04-21
- Parent architecture: `docs/specs/resource-first-control-room-api-v1.md`
- Route tree: `docs/specs/control-room-api-tree-v1.md`
- Related runtime model: `docs/specs/session-run-api-v1.md`
- Governing ADR: `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This document is the field-complete reference for the currently mounted local
resource-first control-room API.

Use it when you need:

- the concrete current endpoint inventory,
- request and response field definitions,
- revision and generation semantics,
- binary payload notes,
- honest separation between canonical, transitional, and target-only routes.

This document does not replace the target route tree.

- `docs/specs/control-room-api-tree-v1.md` remains the target route tree.
- This file describes the concrete current endpoints and the current migration
  boundary.

## 2. Status Legend

| Status | Meaning |
|---|---|
| `canonical` | Mounted now and part of the intended local browser contract |
| `transitional` | Mounted now, but legacy compatibility only |
| `target-only` | Part of the target route tree, not mounted yet |

## 3. Cross-Cutting Contract Rules

### 3.1 Control plane vs data plane

- JSON control plane:
  - status,
  - capabilities,
  - metadata,
  - revisions,
  - display selection,
  - command envelopes,
  - artifact indexes,
  - telemetry,
  - session persistence.
- Binary data plane:
  - field vectors,
  - FEM topology,
  - future heavy domain payloads.

### 3.2 Global headers

| Header | Direction | Required | Meaning |
|---|---|---|---|
| `x-request-id` | request + response | yes for v1 middleware | Correlation id. Client may send it; server echoes or generates one. |
| `x-api-contract-version` | response | yes for v1 middleware | Current contract version. Implemented value is `1.0.0`. |
| `Idempotency-Key` | request | command mutations only | Safe retry / dedupe key for `POST /v1/live/current/commands`. |

### 3.3 Revision vocabulary

| Signal | Type | Meaning |
|---|---|---|
| `domain_generation_id` | `u64` | Cache-invalidating identity boundary for realized domain/topology compatibility |
| `fields_revision` | `u64` | Current field-family revision advertised by `status` |
| `field_revision` | `u64` | Per-quantity field revision carried in field metadata |
| `scalars_revision` | `u64` | Scalar-history revision |
| `artifacts_revision` | `u64` | Artifact index revision |
| `engine_log_revision` | `u64` | Engine-log revision |
| `display_revision` | `u64` | Display-selection revision |

### 3.4 Binary codec names

| Payload | Codec | Content-Type |
|---|---|---|
| `GET /v1/live/current/fields/:quantity_id/vector` | FMVP v2 | `application/octet-stream` |
| `GET /v1/live/current/domain/topology` | FMMT v1 | `application/octet-stream` |

### 3.5 Timestamp conventions

The current API is not yet fully normalized on timestamp encoding.

- Some resources use explicit Unix milliseconds as integers, for example
  `sample_time_unix_ms`.
- Some status summary fields currently expose Unix-millisecond values encoded
  as strings, for example `status.session.created_at`.
- Persistence inspection types use structured timestamps originating from
  `chrono::DateTime<Utc>` and serialize as standard timestamp strings.

Clients must not assume one timestamp encoding across every family.

## 4. System and Contract Endpoints

### 4.1 `GET /v1/health`

- Status: `canonical`
- Purpose: process-level health and contract-version probe
- Request body: none
- Response body: `HealthResponse`

#### Response fields

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `status` | `string` | Health summary | Implemented value is currently `ok`. |
| `uptime_seconds` | `u64` | Current wall-clock uptime value used by the health handler | This is a coarse process-health number, not run duration. |
| `api_contract_version` | `string` | Current API contract version | Implemented value is currently `1.0.0`. |
| `active_session` | `bool` | Whether an active current-live workspace exists | `true` means `/v1/live/current/*` resources have a backing workspace. |

### 4.2 `GET /v1/capabilities`

- Status: `canonical`
- Purpose: discover locally available runtime engines independently of the
  current active session
- Request body: none
- Response body: `HostCapabilityMatrix`

#### `HostCapabilityMatrix`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `profile_version` | `string` | Version of the host capability profile | Used to version the capability inventory itself. |
| `engines` | `HostEngineEntry[]` | Available and unavailable engine entries discovered from runtime manifests | May include non-public or degraded engines. |

#### `HostEngineEntry`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `backend` | `string` | Backend family such as `fdm` or `fem` | Public execution vocabulary, not low-level library naming. |
| `device` | `string` | Device class such as `cpu`, `gpu`, or `auto` | Host-level capability statement. |
| `precision` | `string` | Precision mode such as `single` or `double` | Host-level capability statement. |
| `mode` | `string` | Execution mode such as `strict` or `extended` | Matches the public execution vocabulary. |
| `runtime_family` | `string` | Runtime bundle family name | Used for packaging/runtime discovery. |
| `runtime_version` | `string` | Runtime bundle version | Runtime manifest value. |
| `worker` | `string` | Worker binary or entrypoint name | Runtime implementation detail exposed for diagnostics. |
| `status` | `EngineAvailabilityStatus` | Current availability state | See enum values below. |
| `status_reason` | `string | null` | Human-readable reason for degraded/unavailable status | Optional. |
| `public` | `bool` | Whether this engine is part of the intended public execution surface | `false` may indicate internal or gated paths. |
| `stability` | `string` | Stability channel such as `production` or `experimental` | Manifest value. |

#### `EngineAvailabilityStatus`

| Value | Meaning |
|---|---|
| `available` | Runtime is available for use |
| `missing_runtime` | Runtime bundle is missing |
| `missing_driver` | Required device driver is missing |
| `missing_library` | Required shared library is missing |
| `feature_gated` | Present but gated off by feature policy |
| `experimental` | Present but explicitly experimental |

### 4.3 `GET /v1/openapi.json`

- Status: `canonical`
- Purpose: machine-readable OpenAPI contract export
- Request body: none
- Response body: OpenAPI 3.1 JSON document

Notes:

- This is a discovery endpoint, not a product data resource.
- JSON route schemas are generated from Rust/utoipa registrations.
- Binary routes are represented at the descriptive level only.

### 4.4 `GET /v1/docs/swagger`

- Status: `canonical`
- Purpose: interactive Swagger UI for the current OpenAPI export
- Request body: none
- Response body: HTML application

Notes:

- This is a contract discovery surface.
- It is useful for manual inspection, not a canonical data source for clients.

### 4.5 `GET /v1/asyncapi.json`

- Status: `canonical`
- Purpose: machine-readable AsyncAPI draft for the canonical realtime websocket
- Request body: none
- Response body: AsyncAPI 2.x JSON document

Notes:

- This documents websocket message families, replay semantics, and subprotocol expectations.
- HTTP remains documented in OpenAPI; AsyncAPI does not replace resource docs.

### 4.6 `GET /v1/docs/asyncapi`

- Status: `canonical`
- Purpose: lightweight human-readable landing page for the realtime AsyncAPI draft
- Request body: none
- Response body: HTML page with handshake summary and link to `/v1/asyncapi.json`

### 4.7 `GET /v1/live/current/ws`

- Status: `canonical`
- Purpose: low-latency realtime invalidation and lifecycle notifications for the current live workspace
- Request body: none
- Query params:
  - `after_seq: u64` — optional resume cursor; server replays events strictly newer than this sequence number when available
- Required request header:
  - `Sec-WebSocket-Protocol: fullmag.live.v1`
- Response:
  - `101 Switching Protocols` on successful upgrade
  - `404` when no active current-live workspace exists
  - `400` when the websocket subprotocol is missing or unsupported

Rules:

- websocket frames are notification-first; clients fetch canonical resources over HTTP after invalidation,
- heavy fields and topology do not ride on this websocket by default,
- the server sends `hello`, `heartbeat`, `resource.batch_changed`, and `resync.required`,
- reconnect uses `after_seq`; when replay is unavailable the server emits `resync.required`.

## 5. Live Status Endpoint

### 5.1 `GET /v1/live/current/status`

- Status: `canonical`
- Purpose: thin summary of the active local-live workspace and its revision map
- Request body: none
- Response body: `LiveStatus`

Rules:

- `status` must remain thin.
- Heavy arrays must not appear here.
- Cache invalidation starts here and fans out to named resources.

#### `LiveStatus`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `api_contract_version` | `string` | API contract version reported by the handler | Implemented value is `1.0.0`. |
| `runtime_bundle_version` | `string` | Runtime/session protocol bundle version | Comes from the active live snapshot. |
| `session` | `SessionSummary` | Thin session summary | See below. |
| `run` | `RunSummary | null` | Thin run summary | Null when no run is materialized yet. |
| `solver` | `SolverSummary` | Current solver state summary | Thin runtime-facing summary only. |
| `display` | `DisplaySelection` | Current normalized display selection | Shared with the display mutation family. |
| `domain` | `DomainSummary` | Thin realized-domain summary | Not a replacement for `domain/meta`. |
| `resources` | `ResourceRevisionMap` | Current revision map for resource families | Cache invalidation spine for the browser. |
| `capabilities` | `CapabilityMap` | Thin current-live capability flags | Distinct from host-wide `/v1/capabilities`. |
| `energies` | `EnergySummary` | Thin energy summary derived from the latest step | Values are optional. |
| `metrics` | `MetricsSummary` | Thin runtime metrics | Summary-level only. |

#### `SessionSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `session_id` | `string` | Active session identifier | Stable for the active session lifetime. |
| `name` | `string` | Current problem or session display name | Currently derived from `problem_name`. |
| `created_at` | `string` | Current implementation's creation timestamp string | Today this is the session start time encoded as a Unix-millisecond string, not RFC3339. |
| `workspace_root` | `string` | Local filesystem root of the active workspace | Diagnostics/provenance path, not a browser-derived path. |

#### `RunSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `run_id` | `string` | Current run identifier | Stable for the active run lifetime. |
| `stage_index` | `u32` | Active stage index | Defaults to `0` when stage execution data is absent. |
| `stage_label` | `string` | Active stage label/kind | Empty string when unavailable. |
| `stage_count` | `u32` | Number of stages in the current execution summary | `0` when unavailable. |
| `started_at` | `string` | Current implementation's run-start timestamp string | Today this is a Unix-millisecond string, not RFC3339. |
| `solver_steps` | `u64` | Total solver steps executed so far | Thin summary only. |
| `solver_time` | `f64` | Solver time accumulated so far | SI seconds. |

#### `SolverSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `state` | `string` | Solver runtime state | Current value space is implementation-defined, for example `idle`, `running`, `paused`, `finished`, `error`. |
| `algorithm` | `string | null` | Active solver algorithm label | Currently often null. |
| `dt` | `f64 | null` | Latest solver time step | SI seconds. |
| `max_torque` | `f64 | null` | Latest maximum torque | Current handler populates torque in tesla-equivalent field-space using the step summary's `max_torque_T`. |
| `converged` | `bool | null` | Whether the latest step reports completion/convergence | Summary flag only. |

#### `DisplaySelection`

This same schema appears in `status.display`, as the response body of
`GET /v1/live/current/display`, and as the response body of display writes.

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `active_quantity_id` | `string` | Quantity currently selected for visualization | Quantity identifier, for example `m`. |
| `view_mode` | `DisplayViewMode` | Current visualization mode | Value space below. |
| `field_component` | `FieldComponent` | Selected vector component | Value space below. |
| `colormap` | `string` | Presentation colormap id | Presentation-only option. |
| `auto_contrast` | `bool` | Whether automatic contrast scaling is enabled | Presentation/state bridge. |
| `contrast_min` | `f64 | null` | Lower contrast bound | Quantity-dependent numeric value. |
| `contrast_max` | `f64 | null` | Upper contrast bound | Quantity-dependent numeric value. |
| `vector_glyphs` | `bool` | Whether vector glyph rendering is enabled | Presentation-only option. |
| `vector_density` | `u32` | Vector downsampling / glyph density factor | Current runner selection uses `every_n`. |
| `slice_mode` | `string` | Slice selection mode | Current values are `single` or `all`. |
| `slice_layer` | `i32` | Selected slice layer index | Current layer index in UI/runtime selection. |
| `max_points` | `u32` | Maximum points budget for preview/downsampling | Visualization performance control. |
| `x_chosen_size` | `u32` | Chosen X display sample size | Preview/display tuning field. |
| `y_chosen_size` | `u32` | Chosen Y display sample size | Preview/display tuning field. |

#### `DisplayViewMode`

| Value | Meaning |
|---|---|
| `2d` | 2D visualization mode |
| `3d` | 3D visualization mode |

#### `FieldComponent`

| Value | Meaning |
|---|---|
| `x` | X component |
| `y` | Y component |
| `z` | Z component |
| `magnitude` | Vector magnitude |

#### `DomainSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `generation_id` | `u64` | Current realized domain generation id | Cache invalidation boundary for domain-compatible data. |
| `discretization` | `string` | Realized discretization kind | Implemented values are currently `fdm` or `fem`. |
| `cell_count` | `u64` | Thin size proxy for the active domain | FDM: structured cell count. FEM: current implementation uses element count. |

#### `ResourceRevisionMap`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `fields_revision` | `u64` | Field-family revision | Current implementation uses snapshot state version. |
| `scalars_revision` | `u64` | Scalar-history revision | Current implementation uses total scalar row count. |
| `domain_generation_id` | `u64` | Domain generation id | Same identity boundary used by domain resources. |
| `artifacts_revision` | `u64` | Artifact index revision | Current implementation uses artifact count. |
| `engine_log_revision` | `u64` | Engine-log revision | Current implementation uses engine-log entry count. |
| `display_revision` | `u64` | Display selection revision | Bumped when display selection is updated. |

#### `CapabilityMap`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `structured_grid` | `bool` | Whether the current domain uses an implicit structured grid | Typically true for FDM. |
| `explicit_topology` | `bool` | Whether explicit topology is available | Typically true for FEM. |
| `binary_fields` | `bool` | Whether heavy field transport is binary-capable | Current implementation is true. |
| `cell_fields` | `bool` | Whether cell-located fields are supported | Current implementation is true. |
| `node_fields` | `bool` | Whether node-located fields are supported | Current implementation is tied to FEM support. |
| `scalar_history` | `bool` | Whether scalar history is available | Current implementation is true. |
| `eigen_modes` | `bool` | Whether live capability flags advertise eigenmode support | This is a capability bit, not a direct route inventory. |
| `gpu_telemetry` | `bool` | Whether GPU telemetry route is expected to be useful | Telemetry may still degrade to `status: unavailable`. |
| `preview_2d` | `bool` | Whether 2D preview/display mode is supported | Current implementation is true. |
| `preview_3d` | `bool` | Whether 3D preview/display mode is supported | Current implementation is true. |
| `algorithms_available` | `string[]` | Advertised algorithm names | Current implementation may leave this empty. |

#### `EnergySummary`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `total` | `f64 | null` | Total energy summary | Current step summary value. |
| `exchange` | `f64 | null` | Exchange energy summary | Current step summary value. |
| `demag` | `f64 | null` | Demagnetizing energy summary | Current step summary value. |
| `zeeman` | `f64 | null` | External-field/Zeeman energy summary | Current step summary value. |
| `anisotropy` | `f64 | null` | Anisotropy energy summary | Current step summary value. |
| `dmi` | `f64 | null` | DMI energy summary | Current step summary value. |

#### `MetricsSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `uptime_seconds` | `u64` | Seconds elapsed since session start | Derived from wall clock and the active session start time. |
| `total_steps` | `u64` | Latest solver step count | Thin summary value. |
| `steps_per_second` | `f64 | null` | Average steps per second | Computed from `total_steps / uptime_seconds` when uptime is non-zero. |

## 6. Domain Resource Endpoints

### 6.1 `GET /v1/live/current/domain/meta`

- Status: `canonical`
- Purpose: realized domain metadata for the active workspace
- Request body: none
- Response body: `DomainMeta`

#### `DomainMeta`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `domain_id` | `string` | Domain identifier | Current implementation uses `current`. |
| `discretization` | `string` | Realized discretization kind | Current values are `fdm` or `fem`. |
| `generation_id` | `u64` | Domain generation id | Cache-invalidating identity boundary for domain-compatible resources. |
| `dimension` | `u8` | Geometric dimension | Current implementation uses `3`. |
| `coordinate_system` | `string` | Coordinate system label | Current implementation uses `cartesian`. |
| `units` | `map<string, string>` | Units map for domain geometry quantities | Current implementation includes at least `length: "m"`. |
| `bounds` | `Bounds3` | Realized domain bounds | See nested table below. |
| `counts` | `DomainCounts` | Size counts for cells/nodes/elements/faces | Depends on discretization. |
| `grid` | `StructuredGridDescriptor | null` | Structured-grid descriptor | Present for FDM-like domains, omitted for explicit FEM meshes. |
| `element_type` | `string | null` | Explicit element type label | Current FEM implementation uses `tetrahedron`; omitted for FDM. |

#### `Bounds3`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `min` | `[f64; 3]` | Lower XYZ bound | SI metres. |
| `max` | `[f64; 3]` | Upper XYZ bound | SI metres. |

#### `DomainCounts`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `cells` | `u64 | null` | Structured cell count | Used for FDM-like domains. |
| `nodes` | `u64 | null` | Explicit node count | Used for FEM-like domains. |
| `elements` | `u64 | null` | Explicit element count | Used for FEM-like domains. |
| `boundary_faces` | `u64 | null` | Explicit boundary-face count | Used for FEM-like domains. |

#### `StructuredGridDescriptor`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `shape` | `[u32; 3]` | Structured grid shape | Grid cell counts. |
| `origin` | `[f64; 3]` | Structured grid origin | SI metres. Current implementation uses a placeholder origin when only live-step grid data is available. |
| `spacing` | `[f64; 3]` | Structured grid spacing | SI metres. Current implementation uses a placeholder spacing when only live-step grid data is available. |

### 6.2 `GET /v1/live/current/domain/topology`

- Status: `canonical`
- Purpose: explicit FEM topology payload when the realized domain has explicit
  topology
- Request body: none
- Response body:
  - `200 application/octet-stream` with FMMT v1 payload,
  - `204 No Content` when explicit topology is not applicable,
  - error JSON when no active workspace exists

Notes:

- FDM-like domains return `204 No Content`.
- FEM-like domains return FMMT v1 bytes.
- Clients must key topology caches by `domain_generation_id`.

### 6.3 Target-only domain routes

These routes are part of the target route tree but are not mounted yet:

| Route | Status | Intended purpose |
|---|---|---|
| `GET /v1/live/current/domain/coordinates` | `target-only` | Explicit coordinate buffer for non-implicit domains |
| `GET /v1/live/current/domain/regions` | `target-only` | Region/material ownership mapping |
| `GET /v1/live/current/domain/active-mask` | `target-only` | Active mask / visibility-compatible solver-domain mask |

## 7. Quantities, Fields, and Scalars

### 7.1 `GET /v1/live/current/quantities/catalog`

- Status: `canonical`
- Purpose: canonical quantity catalog for the local resource-first control-room
  contract
- Request body: none
- Response body: `QuantityCatalogResponse`

Current implementation note:

- The payload is currently static/catalog-driven rather than session-specific.
- The route is still part of the current-live contract because the browser
  consumes it alongside the other local control-room resources.

#### `QuantityCatalogResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `schema_version` | `string` | Quantity catalog schema version | Version of the wire schema itself. |
| `quantities` | `QuantityCatalogEntry[]` | Catalog entries exposed to the UI | Built from the canonical quantity-spec table. |

#### `QuantityCatalogEntry`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `id` | `string` | Quantity identifier | Stable quantity key, for example `m`. |
| `label` | `string` | Human-readable quantity label | UI-facing display label. |
| `description` | `string` | Human-readable quantity description | Short semantic description from the quantity spec table. |
| `shape` | `string` | Quantity shape | For example vector field, scalar field, or global scalar. |
| `unit` | `string` | Quantity unit string | SI-oriented display string when applicable. |
| `location` | `string` | Spatial support location | For example cell, node, or global. |
| `domain` | `string` | Quantity domain scope | For example full domain, magnetic domain, node domain. |
| `n_comp` | `u8` | Number of components | `1` for scalar, `3` for vector, etc. |
| `normalization_hint` | `string` | Visualization normalization hint | UI/display helper. |
| `interactive_preview` | `bool` | Whether the quantity can be shown interactively | Current live-UI capability hint. |
| `supports_preview_2d` | `bool` | Whether 2D preview is supported | Capability flag. |
| `supports_preview_3d` | `bool` | Whether 3D preview is supported | Capability flag. |
| `supports_history` | `bool` | Whether history/trace support is available | Quantity-level capability flag. |
| `supports_export` | `bool` | Whether export is supported | Quantity-level capability flag. |
| `quick_access_label` | `string | null` | Optional short label for quick-access UI | Optional presentation hint. |
| `scalar_metric_key` | `string | null` | Optional scalar-metric linkage key | Used to associate scalar table/plot series. |

### 7.2 `GET /v1/quantities/catalog`

- Status: `transitional`
- Purpose: legacy flat quantity catalog route kept for short-term compatibility
- Request body: none
- Response body: `QuantityCatalogResponse`

Migration note:

- This route now mirrors the canonical current-live quantity catalog wire
  shape.
- The canonical browser route is `GET /v1/live/current/quantities/catalog`.

### 7.3 `GET /v1/live/current/fields/catalog`

- Status: `canonical`
- Purpose: list currently available field resources and their revisions
- Request body: none
- Response body: `FieldCatalog`

#### `FieldCatalog`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `revision` | `u64` | Catalog revision | Current implementation uses snapshot state version. |
| `domain_generation_id` | `u64` | Domain generation id | Used to invalidate incompatible field caches. |
| `quantities` | `FieldDescriptor[]` | Available field descriptors | Current handler merges `latest_fields` and preview-cache availability. |

#### `FieldDescriptor`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `quantity_id` | `string` | Quantity identifier | Stable field key. |
| `label` | `string` | Human-readable label | Derived from quantity spec when known. |
| `kind` | `string` | API field kind | For example `vector_field` or scalar-field-like kinds. |
| `components` | `u8` | Number of components | Derived from quantity metadata. |
| `location` | `string` | Spatial location | For example cell or node. |
| `unit` | `string` | Unit string | Display/provenance-facing unit. |
| `field_revision` | `u64` | Revision for this field entry | Current implementation uses snapshot state version. |
| `domain_generation_id` | `u64` | Domain generation id for this field entry | Must match compatible domain data. |
| `available` | `bool` | Whether the field is available now | Current implementation emits `true` for catalog entries it exposes. |

### 7.4 `GET /v1/live/current/fields/:quantity_id/meta`

- Status: `canonical`
- Purpose: metadata for one field quantity without transferring heavy vector
  payloads
- Path parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `quantity_id` | `string` | Quantity identifier |

- Response body: `FieldMeta`

#### `FieldMeta`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `quantity_id` | `string` | Quantity identifier | Matches the requested path parameter. |
| `label` | `string` | Human-readable label | Derived from quantity spec when known. |
| `kind` | `string` | API field kind | Derived from quantity spec when known. |
| `components` | `u8` | Number of components | Derived from quantity spec when known. |
| `location` | `string` | Spatial location | For example cell or node. |
| `unit` | `string` | Unit string | Display/provenance-facing unit. |
| `field_revision` | `u64` | Field revision | Current implementation uses snapshot state version. |
| `domain_generation_id` | `u64` | Domain generation id | Used to invalidate incompatible field caches. |
| `stats` | `FieldStats | null` | Optional summary statistics | Current handler currently returns `null`. |

#### `FieldStats`

| Field | Type | Meaning |
|---|---|---|
| `min` | `f64` | Minimum value |
| `max` | `f64` | Maximum value |
| `mean` | `f64` | Mean value |

Honesty note:

- `FieldStats` is part of the schema.
- The current handler returns `stats: null`.
- Clients must treat stats as optional.

### 7.5 `GET /v1/live/current/fields/:quantity_id/vector`

- Status: `canonical`
- Purpose: heavy binary field payload for one quantity
- Path parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `quantity_id` | `string` | Quantity identifier |

- Response body:
  - `200 application/octet-stream` with FMVP v2 payload,
  - `404` when the field is not available

Current source precedence:

1. `latest_fields`
2. preview cache
3. special-case fallback for `m` from live magnetization

Notes:

- Clients must treat the payload as opaque FMVP v2 bytes.
- Cache compatibility depends on both `field_revision` and
  `domain_generation_id`.

### 7.6 `GET /v1/live/current/scalars`

- Status: `canonical`
- Purpose: scalar-history window for the active workspace
- Query parameters:

| Parameter | Type | Meaning | Notes |
|---|---|---|---|
| `since_revision` | `u64 | null` | Return rows after this revision | Current handler interprets this as a zero-based row offset into accumulated rows. |
| `limit` | `u64 | null` | Maximum number of returned rows | Optional window size clamp. |

- Response body: `ScalarWindow`

#### `ScalarWindow`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `revision` | `u64` | Scalar-history revision | Current implementation uses total accumulated row count. |
| `total_rows` | `u64` | Total rows available server-side | Includes rows not returned in the current window. |
| `returned_rows` | `u64` | Number of rows returned in this response | Window size. |
| `columns` | `string[]` | Ordered scalar column vocabulary | See exact order below. |
| `rows` | `number[][]` | Row-major numeric payload | Each row matches the `columns` order exactly. |

#### Scalar column order

| Column | Meaning | Units / notes |
|---|---|---|
| `step` | Solver step index | Dimensionless count |
| `time` | Physical or pseudo-time | SI seconds |
| `solver_dt` | Solver time step | SI seconds |
| `mx` | Average X magnetization component | Dimensionless |
| `my` | Average Y magnetization component | Dimensionless |
| `mz` | Average Z magnetization component | Dimensionless |
| `e_ex` | Exchange energy summary | Current scalar trace value |
| `e_demag` | Demagnetizing energy summary | Current scalar trace value |
| `e_ext` | External/Zeeman energy summary | Current scalar trace value |
| `e_ani` | Anisotropy energy summary | Current scalar trace value |
| `e_dmi` | DMI energy summary | Current scalar trace value |
| `e_total` | Total energy summary | Current scalar trace value |
| `max_dm_dt` | Maximum magnetization time derivative | Current scalar trace value |
| `max_h_eff` | Maximum effective field magnitude | Current scalar trace value |
| `max_h_demag` | Maximum demagnetizing field magnitude | Current scalar trace value |
| `max_torque_Apm` | Maximum torque in A/m convention | Current scalar trace value |
| `max_torque_T` | Maximum torque in tesla convention | Current scalar trace value |

### 7.7 Target-only quantity and field routes

| Route | Status | Intended purpose |
|---|---|---|
| `GET /v1/live/current/fields/:quantity_id/stats` | `target-only` | Dedicated stats resource when stats become richer or independently cacheable |
| `GET /v1/live/current/fields/:quantity_id/availability` | `target-only` | Dedicated availability probe resource |

### 7.8 `GET /v1/live/current/runs/current`

- Status: `canonical`
- Purpose: current run read-model for the active local-live workspace
- Request body: none
- Response body: `CurrentRunResource`

Notes:

- Returns `404` when a workspace exists but no run is currently materialized.
- This is the singleton local-live projection of the broader run model from
  `docs/specs/session-run-api-v1.md`.

### 7.9 `GET /v1/live/current/stages/execution`

- Status: `canonical`
- Purpose: explicit stage-execution read-model for the current run
- Request body: none
- Response body: `StageExecutionResource`

Notes:

- Returns `404` when the active workspace does not expose stage execution data.
- This route closes one of the major gaps between thin `status` and the former
  monolithic `/state` snapshot.

### 7.10 `GET /v1/live/current/solver/status`

- Status: `canonical`
- Purpose: detailed solver read-model derived from runtime status, latest step,
  execution-plan metadata, and engine-log diagnostics
- Request body: none
- Response body: `SolverStatusResource`

Current implementation notes:

- `runtime_state` prefers the live-step status when present and otherwise falls
  back to `runtime_status.code`.
- `algorithm` and `integrator` are currently projected from
  `metadata.execution_plan.backend_plan`.
- `last_error` and `warnings` are derived from the current engine-log tail.

### 7.11 `GET /v1/live/current/solver/energies/current`

- Status: `canonical`
- Purpose: current solver energy sample without fetching the full scalar table
- Request body: none
- Response body: `SolverEnergyCurrentResource`

Notes:

- Returns `404` when no solver energy sample is available yet.
- Current implementation prefers the latest scalar row and falls back to the
  latest live-step envelope when scalar history is still empty.

### 7.12 `GET /v1/live/current/solver/energies/history`

- Status: `canonical`
- Purpose: energy-only history projection derived from scalar rows
- Query parameters:

| Parameter | Type | Meaning | Notes |
|---|---|---|---|
| `limit` | `usize | null` | Return only the most recent N rows | Optional truncation for lightweight dashboards. |

- Response body: `SolverEnergyHistoryResource`

Notes:

- This is a resource-focused projection over the broader scalar history.
- It does not replace `GET /v1/live/current/scalars` when the caller needs the
  full scalar vocabulary.

### 7.13 `GET /v1/live/current/commands/status`

- Status: `canonical`
- Purpose: current command queue and dispatch ledger for the active workspace
- Request body: none
- Response body: `CommandQueueStatusResource`

Current implementation honesty note:

- Today this route exposes the API host's accepted command ledger with
  `queued` and `dispatched` states.
- It does not yet expose authoritative `completed` or `rejected` execution
  events from the runtime host.
- This is still a real improvement over opaque queue polling because the
  browser can now inspect the current command ledger as a named resource.

### 7.14 `GET /v1/live/current/commands/:command_id`

- Status: `canonical`
- Purpose: fetch one command submission / dispatch record by id
- Path parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `command_id` | `string` | Command identifier returned by `POST /v1/live/current/commands` |

- Response body: `CommandDetailResource`

Notes:

- Returns `404` when the command id is not present in the current in-memory
  ledger.
- The current mounted detail view exposes submission parameters relevant to
  `run`, `relax`, `pause`, `resume`, `stop`, `skip`, and `remesh` flows.

### 7.15 `GET /v1/live/current/authoring/scene`

- Status: `canonical`
- Purpose: canonical full-document authoring route for the active workspace
- Request body: none
- Response body: JSON `SceneDocument`

Current implementation note:

- Today this route is the canonical mounted alias over the same scene document
  committed by `GET/PUT /v1/live/current/scene/document`.
- The intent is to move browser clients to `authoring/scene` while keeping the
  older flat scene route only as transitional compatibility.

### 7.16 `PUT /v1/live/current/authoring/scene`

- Status: `canonical`
- Purpose: replace the canonical full-document authoring scene
- Request body: JSON `SceneDocument`
- Response body: JSON `SceneDocument`

Notes:

- Invalid payloads return `400`.
- The committed scene still flows through the same canonical scene validation
  and rewrite path used by the existing scene document commit helper.

### 7.17 `PATCH /v1/live/current/authoring/scene`

- Status: `canonical`
- Purpose: apply a merge-patch style coarse authoring mutation over the current
  `SceneDocument`
- Request body: `ScenePatchRequest`
- Response body: JSON `SceneDocument`

#### `ScenePatchRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `merge_patch` | `json object` | Merge patch applied over the current `SceneDocument` JSON representation | Current implementation uses recursive object merge semantics and full document revalidation before commit. |

Honesty note:

- This is a coarse patch surface during migration.
- It is not yet the final narrow `authoring/model/*` or `authoring/physics/*`
  mutation family.
- It still materially improves over mandatory full-document replacement for
  simple authoring commits.

### 7.18 `POST /v1/live/current/authoring/transactions`

- Status: `canonical`
- Purpose: canonical coarse-grained authoring commit surface
- Request body: `AuthoringTransactionRequest`
- Response body: `AuthoringTransactionResponse`

#### `AuthoringTransactionRequest`

Current mounted variants:

| Variant | Meaning |
|---|---|
| `replace_scene` | Commit a full `SceneDocument` as one authoring transaction |
| `merge_patch` | Commit a merge patch over the current `SceneDocument` |

#### `AuthoringTransactionResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `transaction_kind` | `string` | Executed transaction kind | Current values mirror the request discriminator. |
| `scene_revision` | `u64` | Revision of the committed scene | Taken from the committed `SceneDocument`. |
| `committed_scene` | `json object` | Full committed `SceneDocument` | Returned so the browser can resynchronize local authoring state. |

Current implementation note:

- This is the mounted canonical commit surface, but it is still coarse-grained.
- Long-term narrow authoring transactions for model/material/magnetization/study
  projections are still planned.

### 7.18.1 `GET /v1/live/current/authoring/study/runtime`

- Status: `canonical`
- Purpose: fetch the requested runtime selection stored in the canonical
  authoring scene
- Request body: none
- Response body: `StudyRuntimeResource`

#### `StudyRuntimeResource`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `backend` | `string | null` | Optional backend marker already stored on `SceneDocument.study` | Transitional carry-over from the full scene contract. |
| `requested_backend` | `string` | Requested solver family / discretization | Values such as `auto`, `fdm`, or `fem`. |
| `requested_device` | `string` | Requested execution device | Values such as `auto`, `cpu`, or `gpu`. |
| `requested_precision` | `string` | Requested numeric precision | Values such as `double` or `single`. |
| `requested_mode` | `string` | Requested execution mode | Values such as `strict`, `extended`, or `hybrid`. |
| `requested_cpu_threads` | `u32 | null` | Requested CPU thread override | `null` means auto / runtime default. |

### 7.18.2 `PATCH /v1/live/current/authoring/study/runtime`

- Status: `canonical`
- Purpose: patch the requested runtime selection without replacing the full
  `SceneDocument`
- Request body: `StudyRuntimePatchRequest`
- Response body: `StudyRuntimeResource`

#### `StudyRuntimePatchRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `requested_backend` | `string?` | Replace requested backend selection | Optional partial mutation field. |
| `requested_device` | `string?` | Replace requested device selection | Optional partial mutation field. |
| `requested_precision` | `string?` | Replace requested precision selection | Optional partial mutation field. |
| `requested_mode` | `string?` | Replace requested execution mode | Optional partial mutation field. |
| `requested_cpu_threads` | `u32 | null` | Replace or clear requested CPU thread override | Omit to keep unchanged, set `null` to restore auto. |

Current implementation note:

- This route is the first narrow canonical projection over `SceneDocument.study`
  used for runtime-selection authoring.
- It lets browser runtime-selection edits avoid coarse `POST /authoring/transactions`
  when only requested execution intent changed.

### 7.18.3 `GET /v1/live/current/authoring/model/materials/{material_id}`

- Status: `canonical`
- Purpose: fetch one canonical material asset from the current authoring scene
- Request body: none
- Response body: `MaterialResource`

#### `MaterialResource`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `id` | `string` | Canonical material asset id | Shared with `SceneObject.material_ref`. |
| `name` | `string` | Material display name | Stable authoring label. |
| `properties.Ms` | `f64 | null` | Saturation magnetization | SI units: A/m. |
| `properties.Aex` | `f64 | null` | Exchange stiffness | SI units: J/m. |
| `properties.alpha` | `f64` | Gilbert damping | Dimensionless. |
| `properties.Dind` | `f64 | null` | Interfacial DMI coefficient | Current UI-facing material field. |

### 7.18.4 `PATCH /v1/live/current/authoring/model/materials/{material_id}`

- Status: `canonical`
- Purpose: patch one canonical material asset without replacing the full
  `SceneDocument`
- Request body: `MaterialPatchRequest`
- Response body: `MaterialResource`

#### `MaterialPatchRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `name` | `string?` | Replace material display name | Optional partial mutation field. |
| `properties.Ms` | `f64 | null` | Replace or clear saturation magnetization | Omit to keep unchanged. |
| `properties.Aex` | `f64 | null` | Replace or clear exchange stiffness | Omit to keep unchanged. |
| `properties.alpha` | `f64?` | Replace Gilbert damping | Omit to keep unchanged. |
| `properties.Dind` | `f64 | null` | Replace or clear interfacial DMI coefficient | Omit to keep unchanged. |

Current implementation note:

- This route narrows one of the most frequently edited `SceneDocument.materials`
  mutations into a first-class authoring resource.
- It is still backed by commit-time scene revalidation, so the canonical source
  of truth remains the whole `SceneDocument`.
- Current backend behavior also synchronizes `interfacial_dmi.params.dind` for
  objects bound to the patched material, so material edits no longer need a
  coarse full-scene commit just to keep DMI parameters aligned.

### 7.18.5 `GET /v1/live/current/authoring/physics/objects/{object_id}/interactions/{interaction_kind}`

- Status: `canonical`
- Purpose: fetch one object-scoped physics interaction from the current authoring scene
- Request body: none
- Response body: `ObjectInteractionResource`

#### `ObjectInteractionResource`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `object_id` | `string` | Canonical scene object id | Matches `SceneObject.id`. |
| `interaction_kind` | `string` | Interaction discriminator | Current values: `exchange`, `demag`, `interfacial_dmi`, `uniaxial_anisotropy`. |
| `present` | `bool` | Whether the optional interaction currently exists on the object | `exchange` and `demag` are effectively always present. |
| `enabled` | `bool` | Current enabled state | Required terms remain enabled. |
| `params` | `json object` | Term-specific authoring parameters | Examples: `{ "dind": ... }`, `{ "ku1": ..., "axis": [...] }`. |

### 7.18.6 `PATCH /v1/live/current/authoring/physics/objects/{object_id}/interactions/{interaction_kind}`

- Status: `canonical`
- Purpose: create, update, toggle, or remove one object-scoped physics interaction
- Request body: `ObjectInteractionPatchRequest`
- Response body: `ObjectInteractionResource`

#### `ObjectInteractionPatchRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `present` | `bool?` | Optional create/remove signal | `false` removes optional interactions; required interactions reject removal. |
| `enabled` | `bool?` | Optional enabled-state update | Used for object-panel toggles. |
| `params` | `json object?` | Optional full replacement of term parameters | Current mounted use covers `interfacial_dmi` and `uniaxial_anisotropy`. |

Current implementation note:

- This is the first canonical `authoring/physics/*` route mounted in the public v1 API.
- `MaterialPanel` now uses it for object-level interaction toggles and uniaxial parameter edits.

### 7.19 `GET /v1/live/current/authoring/script/source`

- Status: `canonical`
- Purpose: fetch the current canonical Python source for the active workspace
- Request body: none
- Response body: `ScriptSourceResponse`

#### `ScriptSourceResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `script_path` | `string` | Local path of the active script entrypoint | Current source of truth path for script-backed workspaces. |
| `source` | `string` | Current script source text | Full current Python source. |
| `bytes` | `usize` | Source byte length | Convenience summary for UI tooling. |

### 7.20 `POST /v1/live/current/authoring/script/sync`

- Status: `canonical`
- Purpose: rewrite canonical Python from the current authoring state
- Request body: `ScriptSyncRequest`
- Response body: `ScriptSyncResponse`

Current implementation note:

- This route currently delegates to the same rewrite helper that previously sat
  behind the removed public flat route `POST /v1/live/current/script/sync`.
- The authoring route is now the canonical mounted placement for browser calls.

## 8. Display and Commands

### 8.1 `GET /v1/live/current/display`

- Status: `canonical`
- Purpose: fetch the current display resource
- Request body: none
- Response body: `DisplaySelection`

### 8.2 `PUT /v1/live/current/display`

- Status: `canonical`
- Purpose: replace the current display resource
- Request body: `DisplaySelection`
- Response body: `DisplaySelection`

### 8.3 `PATCH /v1/live/current/display`

- Status: `canonical`
- Purpose: patch the current display selection
- Request body: `DisplayPatch`
- Response body: `DisplaySelection`

Current honesty note:

- `GET` and `PATCH` are now mounted alongside `PUT`, so `display` behaves as a
  normal readable/mutable resource family.
- `PUT` is full-resource replacement and rejects incomplete bodies.
- `PATCH` remains the partial-mutation route for UI flows that only own a subset
  of display fields today.

#### `DisplaySelection`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `active_quantity_id` | `string` | Quantity to display | Required for `PUT` and always present in responses. |
| `view_mode` | `DisplayViewMode` | Visualization mode | Canonical display mode: `2d` or `3d`. |
| `field_component` | `FieldComponent` | Vector component selection | Distinct from `view_mode`; never carries `3D`. |
| `colormap` | `string` | Presentation colormap id | Presentation-only display state. |
| `auto_contrast` | `bool` | Auto-contrast toggle | Required on `PUT` and always present in responses. |
| `contrast_min` | `f64 | null` | Lower contrast bound | Null means runtime/UI-managed bound. |
| `contrast_max` | `f64 | null` | Upper contrast bound | Null means runtime/UI-managed bound. |
| `vector_glyphs` | `bool` | Vector glyph toggle | Presentation-only display state. |
| `vector_density` | `u32` | Vector density/downsampling factor | Required on `PUT` and always present in responses. |
| `slice_mode` | `string` | Slice mode | Current values are `single` or `all`. |
| `slice_layer` | `i32` | Slice layer index | Negative inputs are clamped to zero internally. |
| `max_points` | `u32` | Maximum point budget | Required on `PUT` and always present in responses. |
| `x_chosen_size` | `u32` | Chosen X display sample size | Required on `PUT` and always present in responses. |
| `y_chosen_size` | `u32` | Chosen Y display sample size | Required on `PUT` and always present in responses. |

#### `DisplayPatch`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `active_quantity_id` | `string | null` | Quantity to display | Optional patch field. |
| `view_mode` | `DisplayViewMode | null` | Visualization mode | Optional patch field. |
| `field_component` | `FieldComponent | null` | Vector component selection | Optional patch field; distinct from `view_mode`. |
| `colormap` | `string | null` | Presentation colormap id | Optional patch field. |
| `auto_contrast` | `bool | null` | Auto-contrast toggle | Optional patch field. |
| `contrast_min` | `f64 | null` | Lower contrast bound | Optional patch field. |
| `contrast_max` | `f64 | null` | Upper contrast bound | Optional patch field. |
| `vector_glyphs` | `bool | null` | Vector glyph toggle | Optional patch field. |
| `vector_density` | `u32 | null` | Vector density/downsampling factor | Optional patch field. |
| `slice_mode` | `string | null` | Slice mode | Current values are `single` or `all`. |
| `slice_layer` | `i32 | null` | Slice layer index | Optional patch field. |
| `max_points` | `u32 | null` | Maximum point budget | Optional patch field. |
| `x_chosen_size` | `u32 | null` | Chosen X display sample size | Optional patch field. |
| `y_chosen_size` | `u32 | null` | Chosen Y display sample size | Optional patch field. |

Response `DisplaySelection` uses the exact schema documented in Section 5.1.

### 8.4 `POST /v1/live/current/commands`

- Status: `canonical`
- Purpose: enqueue an explicit runtime or mesh command for the active workspace
- Request headers:

| Header | Required | Meaning |
|---|---|---|
| `x-request-id` | recommended | Correlation id |
| `Idempotency-Key` | optional | Safe retry / dedupe key |

- Request body: `CommandRequest`
- Response body: `CommandResponse`

#### `StructuredCommandRequest`

The canonical request body is the discriminated `kind` union.

##### Variant: `run`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `kind` | literal `run` | Discriminator | Required |
| `until_seconds` | `f64` | Target runtime horizon | SI seconds |
| `max_steps` | `u64 | null` | Optional step cap | Count |
| `integrator` | `string | null` | Optional integrator selection | User-facing runtime choice |
| `fixed_timestep` | `f64 | null` | Optional fixed time step | SI seconds |

##### Variant: `relax`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `kind` | literal `relax` | Discriminator | Required |
| `until_seconds` | `f64 | null` | Optional runtime horizon | SI seconds |
| `max_steps` | `u64 | null` | Optional step cap | Count |
| `torque_tolerance` | `f64 | null` | Torque stop criterion | Current runtime-specific numeric threshold |
| `energy_tolerance` | `f64 | null` | Energy stop criterion | Current runtime-specific numeric threshold |
| `relax_algorithm` | `string | null` | Relaxation algorithm selection | User-facing relax configuration |
| `relax_alpha` | `f64 | null` | Relaxation damping/alpha hint | Numeric runtime control |
| `fixed_timestep` | `f64 | null` | Optional fixed time step | SI seconds |
| `max_error` | `f64 | null` | Optional numerical error threshold | Runtime-specific numeric threshold |

##### Variant: `pause`

| Field | Type | Meaning |
|---|---|---|
| `kind` | literal `pause` | Pause the active runtime |

##### Variant: `resume`

| Field | Type | Meaning |
|---|---|---|
| `kind` | literal `resume` | Resume a paused runtime |

##### Variant: `stop`

| Field | Type | Meaning |
|---|---|---|
| `kind` | literal `stop` | Stop the active runtime |

##### Variant: `skip`

| Field | Type | Meaning |
|---|---|---|
| `kind` | literal `skip` | Skip the current stage or current blocking wait state |

##### Variant: `remesh`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `kind` | literal `remesh` | Discriminator | Required |
| `mesh_options` | `json | null` | Optional mesh-options payload | Currently untyped JSON bridge payload. |
| `mesh_target` | `MeshCommandTarget | null` | Optional explicit remesh target | See variant table below. |
| `mesh_reason` | `string | null` | Optional human-readable remesh reason | Provenance/diagnostic hint. |

##### `MeshCommandTarget`

| Shape | Meaning |
|---|---|
| `{ "kind": "study_domain" }` | Remesh study-domain/shared solve mesh |
| `{ "kind": "adaptive_followup" }` | Remesh adaptive follow-up target |
| `{ "kind": "airbox" }` | Remesh airbox target |
| `{ "kind": "object_mesh", "object_id": "..." }` | Remesh one object-local mesh target |

##### Variants without extra fields

| Variant | Meaning |
|---|---|
| `save_vtk` | Write VTK-style output/export |
| `solve` | Start or continue solve pipeline |
| `close` | Close the active session/workspace |

#### `LegacyCommandRequest`

The handler still accepts a legacy body shape for migration compatibility.

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `command` | `string` | Legacy command name | Transitional compatibility field. |
| `params` | `json` | Legacy loose parameter map | Transitional compatibility field. |

Migration rule:

- Structured `kind` bodies are canonical.
- Legacy `command + params` input remains transitional compatibility only.

#### `CommandResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `accepted` | `bool` | Whether the command was accepted | Current handler returns `true` on success. |
| `command_id` | `string` | Stable queued command identifier | Generated as `fm-<uuid>`. |
| `error` | `string | null` | Error description when applicable | Usually absent on success. |

Idempotency note:

- When `Idempotency-Key` is supplied, the server caches recent responses and
  returns the same `CommandResponse` for duplicate keys.

## 9. Assets, Artifacts, and Analysis

### 9.1 `POST /v1/live/current/assets/import`

- Status: `canonical`
- Purpose: import a session asset into the active current-live workspace
- Request body: `ImportSessionAssetRequest`
- Response body: `SessionAssetImportResponse`

#### `ImportSessionAssetRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `file_name` | `string` | Uploaded filename | Original asset filename. |
| `content_base64` | `string` | Base64-encoded file bytes | Request-body transport envelope. |
| `target_realization` | `string` | Intended target realization family | For example geometry/mesh-realization target. |

#### `SessionAssetImportResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `asset_id` | `string` | Stored asset identifier | Server-side asset id. |
| `session_id` | `string` | Owning session id | Active session identity. |
| `stored_path` | `string` | Stored asset path | Local workspace/session-store path. |
| `target_realization` | `string` | Realization family actually targeted | Echoes resolved target family. |
| `summary` | `ImportedAssetSummary` | Thin import summary | See below. |

#### `ImportedAssetSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `file_name` | `string` | Original file name | Echoed summary field. |
| `file_bytes` | `usize` | File size in bytes | Payload size summary. |
| `kind` | `string` | Imported asset kind | Runtime/import classification. |
| `bounds` | `BoundsSummary | null` | Optional geometric bounds summary | Present when the asset kind supports bounds extraction. |
| `triangle_count` | `usize | null` | Optional triangle count | For surface-like assets. |
| `node_count` | `usize | null` | Optional node count | For mesh-like assets. |
| `element_count` | `usize | null` | Optional element count | For mesh-like assets. |
| `boundary_face_count` | `usize | null` | Optional boundary-face count | For mesh-like assets. |
| `note` | `string | null` | Optional import note | Human-readable extra import detail. |

#### `BoundsSummary`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `min` | `[f64; 3]` | Lower XYZ bound | SI metres. |
| `max` | `[f64; 3]` | Upper XYZ bound | SI metres. |
| `size` | `[f64; 3]` | Bounding-box extent | SI metres. |

### 9.2 `GET /v1/live/current/artifacts`

- Status: `canonical`
- Purpose: artifact index for the active workspace
- Request body: none
- Response body: `ArtifactEntry[]`

#### `ArtifactEntry`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `path` | `string` | Artifact-relative path | Treat as opaque artifact identifier from the browser perspective. |
| `kind` | `string` | Artifact kind | High-level artifact classification. |

### 9.3 `GET /v1/live/current/artifacts/:artifact_id`

- Status: `canonical`
- Purpose: fetch artifact bytes or text for one indexed artifact
- Path parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `artifact_id` | `string` | Artifact-relative identifier/path |

- Response body:
  - `200` bytes with content-type inferred from file extension,
  - `404` when the artifact cannot be resolved

Current content-type rules:

| Extension | Content-Type |
|---|---|
| `.json` | `application/json; charset=utf-8` |
| `.csv` | `text/csv; charset=utf-8` |
| `.txt` | `text/plain; charset=utf-8` |
| other | `application/octet-stream` |

Path semantics:

- The handler treats the artifact identifier as a sanitized relative artifact
  path.
- Clients should treat the value as opaque and URL-encode it when needed.
- Artifact index lookup and artifact byte retrieval are intentionally separate
  resources.

### 9.4 Eigen analysis endpoints

The eigen routes are current resource families that project artifact-backed
analysis results into stable read endpoints.

#### `GET /v1/live/current/eigen/spectrum`

- Status: `canonical`
- Purpose: fetch eigen spectrum metadata from the active artifact set
- Response body: artifact-backed JSON value

Current artifact search order:

1. `eigen/spectrum.json`
2. `eigen/metadata/eigen_summary.json`

#### `GET /v1/live/current/eigen/mode`

- Status: `canonical`
- Purpose: fetch one eigen mode payload
- Query parameters:

| Parameter | Type | Meaning |
|---|---|---|
| `index` | `u32` | Mode index |
| `sample_index` | `u32 | null` | Optional k-sample index for multi-k/path solves |

- Response body: artifact-backed JSON value

Current path rule:

- With `sample_index`, the handler first looks for
  `eigen/modes/sample_<sample>/mode_<index>.json`.
- If absent, it falls back to the legacy single-sample path
  `eigen/modes/mode_<index>.json`.

#### `GET /v1/live/current/eigen/dispersion`

- Status: `canonical`
- Purpose: fetch structured dispersion data derived from artifact files
- Response body: `EigenDispersionResponse`

#### `EigenDispersionResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `csv_path` | `string` | Relative artifact path for the source CSV | Current value is `eigen/dispersion/branch_table.csv`. |
| `path_metadata` | `json | null` | Optional structured path metadata | Present when `eigen/dispersion/path.json` exists. |
| `rows` | `EigenDispersionRow[]` | Parsed dispersion rows | See field names below. |

#### `EigenDispersionRow`

Important serialization note:

- The row object uses `camelCase` JSON field names.
- The response envelope uses snake_case field names.

| JSON field | Type | Meaning | Units / notes |
|---|---|---|---|
| `modeIndex` | `u32` | Mode index | Integer mode id |
| `kx` | `f64` | Wave-vector X component | Rad/m |
| `ky` | `f64` | Wave-vector Y component | Rad/m |
| `kz` | `f64` | Wave-vector Z component | Rad/m |
| `frequencyHz` | `f64` | Frequency | Hz |
| `angularFrequencyRadPerS` | `f64` | Angular frequency | Rad/s |

#### `GET /v1/live/current/eigen/branches`

- Status: `canonical`
- Purpose: fetch tracked branch metadata when available
- Response body: artifact-backed JSON value

Honesty note:

- `spectrum`, `mode`, and `branches` currently proxy artifact JSON payloads.
- These routes are stable browser-facing read resources, but they are not a
  second storage system separate from artifacts.

## 10. Diagnostics and Telemetry

### 10.1 `GET /v1/live/current/logs/engine`

- Status: `canonical`
- Purpose: fetch the current engine-log resource
- Request body: none
- Response body: ad hoc JSON envelope

#### Response envelope

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `entries` | `EngineLogEntry[]` | Engine log entries | Sourced from the active live snapshot. |
| `total` | `usize` | Number of entries in the current log resource | Current implementation uses `entries.len()`. |

#### `EngineLogEntry`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `timestamp_unix_ms` | `u128` | Entry timestamp | Unix epoch milliseconds. |
| `level` | `string` | Log severity | For example `info`, `warn`, `error`. |
| `message` | `string` | Log message text | Human-readable message. |

### 10.2 `GET /v1/live/current/gpu/telemetry`

- Status: `canonical`
- Purpose: fetch current GPU telemetry or a degraded unavailable response
- Request body: none
- Response body: `GpuTelemetryResponse`

#### `GpuTelemetryResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `status` | `string` | Telemetry availability state | For example `ok` or `unavailable`. |
| `reason` | `string | null` | Optional unavailable/degraded reason | Present when telemetry cannot be sampled. |
| `sample_time_unix_ms` | `u128` | Sampling timestamp | Unix epoch milliseconds. |
| `devices` | `GpuTelemetryDevice[]` | Telemetry entries per device | Empty when unavailable. |

#### `GpuTelemetryDevice`

| Field | Type | Meaning | Units / notes |
|---|---|---|---|
| `index` | `u32` | Device index | Integer GPU index |
| `name` | `string` | Device name | Human-readable GPU name |
| `utilization_gpu_percent` | `f64` | GPU core utilization | Percent |
| `utilization_memory_percent` | `f64` | Memory-controller utilization | Percent |
| `memory_used_mb` | `f64` | Used device memory | MB |
| `memory_total_mb` | `f64` | Total device memory | MB |
| `temperature_c` | `f64 | null` | Device temperature | Celsius |

Degraded-success rule:

- `status: unavailable` is a valid `200` response.
- Lack of local NVIDIA telemetry is not a control-room-fatal error.

## 11. Session Persistence Endpoints

### 11.1 `POST /v1/live/current/session/export`

- Status: `canonical`
- Purpose: export the active workspace/session to a portable `.fms` payload
- Request body: `SessionExportRequest`
- Response body: `SessionExportResponse`

#### `SessionExportRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `profile` | `SaveProfile` | Save-profile selection | Required. |
| `name` | `string | null` | Optional session name override | Optional. |
| `compression` | `CompressionProfile | null` | Optional compression policy override | Optional. |
| `ui_state` | `json | null` | Optional frontend UI-state snapshot | Optional persisted workspace/UI payload. |

#### `SessionExportResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `session_id` | `string` | Exported session id | Owning session id. |
| `profile` | `SaveProfile` | Save profile actually used | Echoed/resolved export profile. |
| `fms_base64` | `string` | Base64-encoded `.fms` archive bytes | Portable file payload. |
| `size_bytes` | `usize` | Encoded archive size in bytes | Byte-count summary. |

### 11.2 `POST /v1/live/current/session/import/inspect`

- Status: `canonical`
- Purpose: inspect a portable `.fms` archive before committing to import
- Request body: `SessionImportInspectRequest`
- Response body: `SessionImportInspectResponse`

#### `SessionImportInspectRequest`

| Field | Type | Meaning |
|---|---|---|
| `fms_base64` | `string` | Base64-encoded `.fms` archive bytes |

#### `SessionImportInspectResponse`

| Field | Type | Meaning |
|---|---|---|
| `inspection` | `SessionInspection` | Compatibility and content inspection result |

#### `SessionInspection`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `format_version` | `string` | Session file-format version | Format identifier of the inspected archive. |
| `session_id` | `string` | Session id encoded in the archive | Archived session identity. |
| `name` | `string` | Archived session name | Human-readable name. |
| `profile` | `SaveProfile` | Save profile used to create the archive | Governs expected completeness. |
| `created_by_version` | `string` | Fullmag version that created the archive | Version/provenance field. |
| `created_at` | `datetime string` | Session creation timestamp | UTC timestamp serialization. |
| `saved_at` | `datetime string` | Archive save timestamp | UTC timestamp serialization. |
| `run_count` | `usize` | Number of runs represented | Current v1 typically uses one run. |
| `latest_checkpoint` | `CheckpointSummary | null` | Latest checkpoint summary | Optional. |
| `restore_class` | `RestoreClass` | Restorability class | See enum below. |
| `warnings` | `string[]` | Compatibility or downgrade warnings | Human-readable advisory list. |
| `total_size_bytes` | `u64` | Archive size | Bytes. |

#### `CheckpointSummary`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `checkpoint_id` | `string` | Checkpoint identifier | Archive-level checkpoint id. |
| `step` | `u64` | Solver step at checkpoint | Count. |
| `time_s` | `f64` | Solver time at checkpoint | SI seconds. |
| `study_kind` | `string` | Study/stage kind | Provenance label. |

### 11.3 `POST /v1/live/current/session/import/commit`

- Status: `canonical`
- Purpose: commit a portable `.fms` archive into the local session store and
  materialize it as the current workspace
- Request body: `SessionImportCommitRequest`
- Response body: `SessionImportCommitResponse`

#### `SessionImportCommitRequest`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `fms_base64` | `string` | Base64-encoded `.fms` archive bytes | Required. |
| `restore_mode` | `string | null` | Optional requested restore mode | Current accepted strings are `resume`, `initial_condition`, `config_only`. |

#### `SessionImportCommitResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `session_id` | `string` | Restored session id | Active session identity after commit. |
| `restore_class` | `RestoreClass` | Effective restoration class | Actual restored capability level. |
| `warnings` | `string[]` | Warnings emitted during commit | Human-readable advisory list. |
| `ui_state` | `json | null` | Optional restored UI-state snapshot | Present when UI state was restored from the archive. |

### 11.4 `GET /v1/live/current/session/checkpoints`

- Status: `canonical`
- Purpose: list checkpoints for the active current workspace
- Response body: `CheckpointListResponse`

#### `CheckpointListResponse`

| Field | Type | Meaning |
|---|---|---|
| `checkpoints` | `CheckpointEntry[]` | Checkpoints available for the active workspace |

#### `CheckpointEntry`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `checkpoint_id` | `string` | Checkpoint identifier | Current workspace checkpoint id. |
| `step` | `u64` | Solver step | Count. |
| `time_s` | `f64` | Solver time | SI seconds. |
| `created_at` | `string` | Checkpoint creation timestamp | Timestamp string as emitted by the persistence layer. |

### 11.5 `GET /v1/live/current/session/recovery`

- Status: `canonical`
- Purpose: list recovery snapshots known to the local session store
- Response body: `RecoveryListResponse`

#### `RecoveryListResponse`

| Field | Type | Meaning |
|---|---|---|
| `snapshots` | `RecoveryEntry[]` | Recovery snapshots known to the local store |

#### `RecoveryEntry`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `session_id` | `string` | Recovery snapshot session id | Store identity. |
| `name` | `string` | Recovery snapshot name | Human-readable name. |
| `saved_at` | `string` | Recovery snapshot time | Timestamp string from the store. |
| `profile` | `SaveProfile` | Recovery snapshot profile | Usually `recovery`, but documented as the general enum. |

### 11.6 `POST /v1/live/current/session/recovery/clear`

- Status: `canonical`
- Purpose: clear recovery snapshots from the local session store
- Response body: `RecoveryClearResponse`

#### `RecoveryClearResponse`

| Field | Type | Meaning |
|---|---|---|
| `cleared` | `usize` | Number of cleared recovery snapshots |

### 11.7 Persistence enum vocabularies

#### `SaveProfile`

| Value | Meaning |
|---|---|
| `compact` | Script + scene + UI, without solver data |
| `solved` | Compact plus selected solved-state payloads |
| `resume` | Solved plus exact checkpoint payloads for continuation |
| `archive` | Resume plus full artifact/checkpoint/history coverage |
| `recovery` | Internal fast recovery snapshot profile |

#### `RestoreClass`

| Value | Meaning |
|---|---|
| `exact_resume` | Bitwise-identical continuation is possible |
| `logical_resume` | Compatible logical continuation is possible, but not bitwise-identical |
| `initial_condition_import` | Saved fields can be used as a new initial condition |
| `config_only` | Only configuration/project state is restored; solver must start fresh |

#### `CompressionProfile`

| Value | Meaning |
|---|---|
| `speed` | Favor encode/decode speed |
| `balanced` | Balanced compression profile |
| `smallest` | Favor smallest output size |

## 12. Common Error Envelope

### 12.1 `ApiErrorResponse`

| Field | Type | Meaning | Notes |
|---|---|---|---|
| `error` | `string` | Error category/code | Short machine-facing category string. |
| `message` | `string` | Human-readable error description | Main diagnostic message. |
| `request_id` | `string | null` | Correlation id | Present when the request id is available for the failure path. |

Current transport rule:

- JSON control-plane endpoints return JSON error envelopes.
- Binary endpoints return binary on success and JSON errors on failure.
- Artifact byte routes return typed text/binary content on success and JSON
  errors on failure.

## 13. Transitional Endpoint Appendix

The following routes are transitional compatibility routes or recently retired
legacy routes that still matter for migration planning. They must not be
treated as the canonical browser contract.

| Route | Status | Current role | Canonical replacement or destination |
|---|---|---|---|
| `GET /healthz` | `transitional` | Legacy health probe | `GET /v1/health` |
| `GET /v1/meta/vision` | `transitional` | Legacy repo/application vision summary | No direct product-data replacement required |
| `GET /v1/live/current/bootstrap` | `transitional` | Monolithic initial session blob | `GET /v1/live/current/status` plus named resources |
| `GET /v1/live/current/state` | `transitional` | Legacy whole-state snapshot | Named resources under `/v1/live/current/*` |
| `GET /v1/live/current/poll` | `transitional` | Legacy delta polling over whole-state blobs | Status polling plus revision-driven resource fetches |
| `GET /v1/live/current/events` | `removed from public router` | Former legacy current-live event stream | Use `GET /v1/live/current/ws` for realtime notices; canonical reads stay resource-first |
| `POST /v1/live/current/publish` | `internalized` | Former public publish bridge for the monolithic live snapshot | Internal runner bridge: `POST /v1/internal/live/current/snapshot` |
| `POST /v1/live/current/create` | `removed from public router` | Former legacy workspace bootstrap/create helper | Future explicit session/workspace creation contract |
| `GET /v1/live/feature-flags` | `transitional` | Legacy diagnostics/feature-flag probe | Diagnostics policy only; not part of the canonical browser contract |
| `GET /v1/live/current/commands/next` | `removed from public router` | Former legacy pull-based command queue consumption | Structured command queue behind `POST /commands` plus future read models |
| `GET /v1/live/current/control/wait` | `internalized` | Former public blocking wait channel for the runner bridge | Internal runner bridge: `GET /v1/internal/live/current/control/wait` |
| `POST /v1/live/current/script/sync` | `removed from public router` | Former legacy flat script-sync placement | `POST /v1/live/current/authoring/script/sync` |
| `GET/PUT /v1/live/current/scene/document` | `transitional` | Legacy flat scene-document placement | `GET/PUT /v1/live/current/authoring/scene` |
| `GET /v1/live/current/artifacts/file` | `removed from public router` | Former legacy artifact-file fetch route | `GET /v1/live/current/artifacts/:artifact_id` |
| `GET /v1/docs/physics` | `transitional` | Legacy physics docs listing | Remains separate from the control-room runtime contract |
| `GET /v1/quantities/catalog` | `transitional` | Legacy flat quantity catalog route kept for short-term compatibility | `GET /v1/live/current/quantities/catalog` |

## 14. Target-Only Family Appendix

These families belong to the target tree but are not mounted yet as
resource-first families in the current server.

| Family | Status | Purpose |
|---|---|---|
| `/v1/live/current/workspace/*` | `target-only` | Workspace-only UI state such as selection, ribbon, layout, tree expansion, viewport presets |
| wider `/v1/live/current/authoring/*` families beyond mounted scene/script routes | `target-only` | Canonical model/material/magnetization/physics/study/builder authoring resources |
| `/v1/live/current/mesh/*` | `target-only` | Mesh policy, reports, quality, history, per-object and shared-domain mesh resources |
| `/v1/live/current/domain/coordinates` | `target-only` | Explicit coordinate buffers for non-implicit domains |
| `/v1/live/current/domain/regions` | `target-only` | Region/material ownership mappings |
| `/v1/live/current/domain/active-mask` | `target-only` | Explicit active-mask data |
| `/v1/live/current/fields/:quantity_id/stats` | `target-only` | Dedicated stats resource |
| `/v1/live/current/fields/:quantity_id/availability` | `target-only` | Dedicated availability resource |
| richer command completion/rejection resource | `target-only` | Authoritative runtime completion and rejection events beyond the current queued/dispatched ledger |
| run history beyond `/runs/current` | `target-only` | Persistent run list and historical run summaries |

The complete target tree remains documented in
`docs/specs/control-room-api-tree-v1.md`.

## 15. Legacy `SessionState` Decomposition Appendix

The old monolithic `SessionState` transport carried many unrelated concerns in
one blob. The mapping below shows where each field belongs in the
resource-first architecture.

| Legacy field | Current or target family | State |
|---|---|---|
| `state_version` | status/resource revision vocabulary | transitional summary signal |
| `session_protocol_version` | `status.runtime_bundle_version` | partially covered |
| `capability_profile_version` | `/v1/capabilities.profile_version` | partially covered |
| `session` | `status.session` | partially covered |
| `run` | `status.run` | partially covered |
| `live_state` | status + fields + scalars + `solver/status` + `solver/energies/*` | partially decomposed |
| `runtime_status` | `status.solver` + `solver/status` | partially covered |
| `capabilities` | `status.capabilities` and `/v1/capabilities` | covered in split form |
| `metadata` | future dedicated metadata resource | contract gap remains |
| `mesh_workspace` | future `/v1/live/current/mesh/*` | target-only |
| `stage_execution` | `GET /v1/live/current/stages/execution` | covered |
| `scene_document` | `GET/PUT /v1/live/current/authoring/scene` | covered |
| `script_builder` | future `/v1/live/current/authoring/*` projections | target-only |
| `model_builder_graph` | future `/v1/live/current/authoring/builder/graph` | target-only |
| `scalar_rows` | `GET /v1/live/current/scalars` | covered |
| `scalar_rows_total` | `GET /v1/live/current/scalars.total_rows` | covered |
| `engine_log` | `GET /v1/live/current/logs/engine` | covered |
| `quantities` | `GET /v1/live/current/quantities/catalog` | covered |
| `fem_mesh` | `domain/meta` + `domain/topology` | covered in split form |
| `latest_fields` | `fields/catalog`, `fields/:quantity_id/meta`, `fields/:quantity_id/vector` | covered in split form |
| `artifacts` | `GET /v1/live/current/artifacts` | covered |
| `display_selection` | `status.display` + `GET/PUT/PATCH /display` | covered |
| `preview_config` | display selection plus local viewport state | should retire as independent transport field |
| `preview` | cached field/domain resources plus local adapters | should retire as independent transport field |
| `command_status` | future command-status read model | target-only |
| `step_update_v2` | derived internal bridge or future explicit runtime-step resource | unresolved cutover detail |

## 16. Immediate Documentation Rule

When adding or changing a currently mounted local control-room endpoint:

1. update this reference,
2. update `docs/specs/resource-first-control-room-api-v1.md`,
3. update `docs/specs/control-room-api-tree-v1.md` if route-family placement changed,
4. update `docs/specs/session-run-api-v1.md` if runtime semantics changed,
5. keep legacy dependencies explicit instead of silently extending dual-stack
   behavior.
