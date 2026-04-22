# Resource-first Control Room API v1

- Status: canonical local control-room API contract
- Last updated: 2026-04-21
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Concrete endpoint reference: `docs/specs/control-room-api-endpoint-reference-v1.md`
- Related runtime model: `docs/specs/session-run-api-v1.md`
- Route tree: `docs/specs/control-room-api-tree-v1.md`
- Governing ADR: `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This spec defines the canonical local browser contract for Fullmag's control room.

It replaces the older monolithic `bootstrap` / `poll` / `preview/*` mental model with a
**resource-first, revision-driven API** that keeps physics semantics stable while making the
frontend professional, modular, and performant.

This spec is the source of truth for:

- the current `/v1/live/current/*` contract,
- the canonical split between current mounted endpoints and target-only families,
- the canonical route-family split and tree,
- the split between workspace state and authoring state,
- the split between control plane and data plane,
- frontend API-client and resource-hook rules,
- FDM/FEM unification rules for the control room.

The concrete currently mounted endpoint inventory and per-field schema
definitions live in:

- `docs/specs/control-room-api-endpoint-reference-v1.md`

## 2. Canonical rules

### 2.1 Resource-first, not blob-first

The backend does not publish one giant "world state" blob.

The backend publishes **named resources** with explicit revisions and generation ids.
The frontend fetches resources on demand and caches them by revision.
`GET /v1/live/current/status` stays thin, but its `resources` map is expected to
carry the revision pointers needed to drive follow-up fetches for display,
workspace, mesh, commands, stages, and authoring scene projections.

### 2.2 Thin control plane, binary data plane

The control plane is JSON and lightweight:

- status,
- workspace state,
- authoring metadata and patches,
- capabilities,
- revisions,
- commands,
- display selection,
- artifact indexes,
- diagnostics.

The data plane carries heavy numerical payloads and is binary by default:

- field vectors,
- topology,
- coordinates,
- other large domain payloads.

Heavy fields and topology must not be reintroduced into `status`.

### 2.3 One typed frontend access path

The web app uses one typed API client and one resource-hook layer.

Rules:

- React components do not call `fetch()` directly.
- JSON endpoints go through generated or centrally maintained shared types.
- Binary endpoints go through dedicated codecs.
- Typed API errors are required.
- Request correlation is required.
- Revision-based cache keys are required.

### 2.4 FDM/FEM unification happens below the UI tree

The browser does not branch its top-level control-room tree into separate FDM and FEM products.

Instead:

- resources are discretization-neutral where possible,
- runtime capabilities describe what is available,
- domain adapters convert FDM or FEM resource payloads into renderer-ready geometry,
- UI guards key off capability vocabulary, not backend-specific component forks.

### 2.5 OpenAPI is part of the contract

JSON endpoints are documented through OpenAPI / Swagger and kept in sync with Rust schemas and
frontend shared types.

Binary endpoints must still be present in the API surface, even if OpenAPI only describes them at
the envelope/header level.

### 2.6 Realtime is notification-first

HTTP resources remain the source of truth.

The canonical realtime channel is:

- `GET /v1/live/current/ws`

Rules:

- the websocket is an invalidation and lifecycle notification bus, not a second state API,
- clients reconnect with `after_seq`,
- clients must offer `Sec-WebSocket-Protocol: fullmag.live.v1`,
- heavy field/topology payloads stay on HTTP resource endpoints,
- websocket message schemas are documented through AsyncAPI, not stretched into Swagger.

### 2.6 Migration does not create a second permanent architecture

Feature flags may exist only as short-lived migration scaffolding.

The canonical end-state is one resource-first stack.
Long-lived dual operation of the old bootstrap/poll model and the new resource model is an
architectural regression.
As of `2026-04-21`, the active browser Control Room no longer carries a
compatibility call path to the legacy whole-state snapshot route
`GET /v1/live/current/state`.

## 3. Canonical endpoint families

The canonical local control-room contract lives under versioned resource paths.

The full target tree is specified in:

- `docs/specs/control-room-api-endpoint-reference-v1.md` for currently mounted endpoints
- `docs/specs/control-room-api-tree-v1.md`

The family lists below describe the canonical local contract shape. Concrete
current mounted endpoints, transitional routes, and target-only members are
spelled out in `docs/specs/control-room-api-endpoint-reference-v1.md`.

### 3.1 Control-plane endpoints

```text
GET    /v1/live/current/status
GET    /v1/capabilities
GET    /v1/openapi.json
GET    /v1/asyncapi.json
GET    /v1/docs/swagger
GET    /v1/docs/asyncapi
GET    /v1/live/current/ws
```

`status` must remain thin and carry:

- session/run/solver summary,
- active display selection,
- domain and resource revision map,
- capability map,
- lightweight diagnostics and metrics.

### 3.2 Domain resource endpoints

```text
GET    /v1/live/current/domain/meta
GET    /v1/live/current/domain/topology
GET    /v1/live/current/domain/coordinates
```

Rules:

- `domain/meta` is JSON and discretization-neutral,
- `topology` is optional and binary when the domain has explicit topology,
- `coordinates` is omitted when the domain uses implicit structured coordinates,
- `domain_generation_id` is the cache-invalidating identity boundary.

### 3.3 Quantity and field resource endpoints

```text
GET    /v1/live/current/quantities/catalog
GET    /v1/live/current/fields/catalog
GET    /v1/live/current/fields/:quantity_id/meta
GET    /v1/live/current/fields/:quantity_id/vector
GET    /v1/live/current/scalars
```

Rules:

- quantity metadata is available as a dedicated JSON catalog,
- already computed quantities are treated as data resources,
- `fields/catalog` and field metadata are JSON,
- field vectors are binary by default,
- scalars are windowed/incremental and keyed by revision or cursor,
- `field_revision` and `scalars_revision` are first-class cache signals.

### 3.4 Control/action endpoints

```text
GET    /v1/live/current/workspace/*
PUT    /v1/live/current/workspace/*
GET    /v1/live/current/mesh/summary
GET    /v1/live/current/mesh/builds/active
POST   /v1/live/current/mesh/builds/commands
GET    /v1/live/current/mesh/universe/config
PUT    /v1/live/current/mesh/universe/config
GET    /v1/live/current/mesh/shared-domain/config
PUT    /v1/live/current/mesh/shared-domain/config
GET    /v1/live/current/mesh/shared-domain/manifest
GET    /v1/live/current/mesh/objects/:object_id/config
PUT    /v1/live/current/mesh/objects/:object_id/config
GET    /v1/live/current/authoring/scene
PUT    /v1/live/current/authoring/scene
PATCH  /v1/live/current/authoring/scene
POST   /v1/live/current/authoring/transactions
GET    /v1/live/current/authoring/study/runtime
PATCH  /v1/live/current/authoring/study/runtime
GET    /v1/live/current/authoring/model/materials/:material_id
PATCH  /v1/live/current/authoring/model/materials/:material_id
GET    /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
PATCH  /v1/live/current/authoring/physics/objects/:object_id/interactions/:interaction_kind
GET    /v1/live/current/authoring/model/*
PATCH  /v1/live/current/authoring/model/*
PATCH  /v1/live/current/authoring/physics/*
PATCH  /v1/live/current/authoring/study/*
POST   /v1/live/current/authoring/script/sync
GET    /v1/live/current/display
PUT    /v1/live/current/display
PATCH  /v1/live/current/display
POST   /v1/live/current/commands
```

Rules:

- workspace resources carry selection/ribbon/layout state and must not mutate physics semantics,
- the currently mounted workspace subset is `selection`, `tree/active-node`, `ribbon`, and `layout`,
- `mesh/*` is the canonical family for mounted mesh summary, active build projection, universe/shared-domain/object config,
- `mesh/shared-domain/manifest` is the thin JSON bridge for FEM tree/selection metadata such as
  `mesh_parts` and `object_segments`,
- `POST /mesh/builds/commands` is the canonical remesh enqueue path,
- `authoring/scene` is the canonical full-document authoring resource,
- the intended 3D browser pipeline is three-layered:
  canonical `authoring/scene` for primitives and transforms,
  `mesh/shared-domain/manifest` plus binary topology for realized mesh structure,
  and `display` plus quantity resources for shading/vector overlays,
- the flat `scene/document` placement has been retired from the public router,
- narrow `authoring/*` endpoints are semantic projections over the same scene revision,
- `authoring/study/runtime` is the canonical narrow surface for requested backend/device/precision/mode intent,
- `authoring/model/materials/:material_id` is the first mounted narrow material mutation surface,
- `authoring/physics/objects/:object_id/interactions/:interaction_kind` is the mounted narrow surface
  for object-level term toggles and parameter edits,
- model-builder, inspector, and ribbon edits must land in `authoring/*` or `workspace/*`, not in
  preview endpoints or ad hoc side channels,
- display state is exposed as one readable/mutable consolidated resource,
- `PUT /display` is full replacement while `PATCH /display` is partial mutation,
- `view_mode` and `field_component` are distinct display axes and must not be
  collapsed back into a single mixed `component` token,
- command submission is explicit and structured,
- family-specific command routes are allowed where they keep intent explicit, with
  `mesh/builds/commands` now mounted as the canonical remesh route,
- `POST /commands` accepts only the discriminated `kind` union body,
- public mesh/remesh enqueue is no longer part of the generic `/commands` surface,
- scene/script synchronization must preserve canonical Python and `ProblemIR` semantics.

### 3.5 Supporting resource families

The same architecture applies to:

- `/v1/live/current/artifacts*`
- `/v1/live/current/logs/*`
- `/v1/live/current/eigen/*`
- `/v1/live/current/session/*`
- `/v1/live/current/gpu/*`

They are resource families, not ad hoc side channels.

GPU telemetry must degrade gracefully:

- absence of `nvidia-smi`, a local NVIDIA driver, or a GPU is represented as a thin JSON
  `status: unavailable` resource response,
- telemetry unavailability is not a control-room-fatal 500 path by itself.

## 3.6 Current implementation honesty note

The repository is still in migration.

Implemented and canonical today:

- `status`,
- `domain/meta`,
- `domain/topology`,
- `fields/catalog`,
- `quantities/catalog`,
- `fields/:quantity_id/meta`,
- `fields/:quantity_id/vector`,
- `scalars`,
- `display`,
- `commands`,
- `commands/status`,
- `commands/:command_id`,
- `mesh/summary`,
- `mesh/builds/active`,
- `mesh/builds/commands`,
- `mesh/universe/config`,
- `mesh/shared-domain/config`,
- `mesh/objects/:object_id/config`,
- `runs/current`,
- `stages/execution`,
- `solver/status`,
- `solver/energies/current`,
- `solver/energies/history`,
- `assets/import`,
- `authoring/scene`,
- `authoring/transactions`,
- `authoring/script/source`,
- `authoring/script/sync`,
- `artifacts`,
- `eigen/*`,
- `logs/engine`,
- `gpu/telemetry`,
- `session/export`,
- `session/import/*`,
- `session/checkpoints`,
- `session/recovery`,
- `/v1/health`,
- `/v1/capabilities`,
- `/v1/openapi.json`,
- `/v1/docs/swagger`.

Still mounted but transitional:

- `bootstrap`,
- `state`,
- `poll`,
- `events`,
- `publish`,
- `create`,
- flat `scene`,
- flat `script/sync`,
- flat `artifacts/file`,
- flat `quantities/catalog`,
- WebSocket legacy accelerators.

Still target-only:

- `workspace/tree/expansion`,
- `workspace/viewport-presets`,
- wide `authoring/*` beyond mounted scene/transactions/script routes,
- broader `mesh/*` such as reports, quality, interface resources, history, and last-success projections,
- run history beyond `runs/current`,
- command completion/rejection resources beyond the current queued/dispatched ledger.

## 4. Revision and cache contract

The minimum canonical revision vocabulary is:

- `domain_generation_id`
- `topology_revision` where applicable
- `fields_revision`
- `field_revision`
- `scalars_revision`
- `artifacts_revision`

Rules:

- cache invalidation is revision-driven, not time-driven,
- a domain generation change invalidates incompatible topology, coordinates, and field caches,
- quantity switching should reuse cached field resources when `field_revision` is unchanged,
- the UI must not recompute or re-request already available quantities through preview-control
  commands.

## 5. Frontend structure contract

The intended frontend shape is:

```text
LiveApiClient
  -> endpoint modules
  -> codecs
  -> typed errors
  -> resource cache
  -> request/version/diagnostic interceptors
  -> resource hooks
  -> domain adapters
  -> unified control-room components
```

Required rules:

1. one API client instance per app runtime,
2. one resource-hook layer,
3. one domain-adapter layer,
4. one unified viewport tree,
5. no direct React-component `fetch()` chains,
6. no top-level `if (discretization == "fem")` product split.

Capabilities decide what the UI may do.
Adapters decide how FDM or FEM data is turned into geometry, colors, arrows, slices, and bounds.

## 6. Observability and diagnostics contract

Every request/response pair must support correlation and contract validation.

Minimum requirements:

- `x-request-id` on every request and response,
- `Idempotency-Key` remains distinct from `x-request-id` and is used only for safe retry/dedupe
  on command mutations,
- `x-api-contract-version` on every response,
- structured request logging on the backend,
- contract/version checks in the frontend client,
- typed error mapping for control-room failures,
- optional ETag/revision headers for large binary resources and selected
  heavier JSON read-models where HTTP revalidation materially reduces transfer.

## 7. Anti-regression rules

The following are architectural regressions:

- bringing back `/bootstrap` or `/poll` as the canonical browser contract,
- reintroducing multiple preview mutation endpoints for quantity switching,
- stuffing heavy arrays into `status`,
- duplicating the viewport tree into separate FDM and FEM products,
- keeping old and new API stacks alive indefinitely,
- letting frontend components bypass the shared API client.
