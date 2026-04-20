# Resource-first Control Room API v1

- Status: canonical local control-room API contract
- Last updated: 2026-04-20
- Parent architecture: `docs/specs/fullmag-application-architecture-v2.md`
- Related runtime model: `docs/specs/session-run-api-v1.md`
- Governing ADR: `docs/adr/0011-resource-first-api.md`

## 1. Purpose

This spec defines the canonical local browser contract for Fullmag's control room.

It replaces the older monolithic `bootstrap` / `poll` / `preview/*` mental model with a
**resource-first, revision-driven API** that keeps physics semantics stable while making the
frontend professional, modular, and performant.

This spec is the source of truth for:

- the current `/v1/live/current/*` contract,
- the split between control plane and data plane,
- frontend API-client and resource-hook rules,
- FDM/FEM unification rules for the control room.

## 2. Canonical rules

### 2.1 Resource-first, not blob-first

The backend does not publish one giant "world state" blob.

The backend publishes **named resources** with explicit revisions and generation ids.
The frontend fetches resources on demand and caches them by revision.

### 2.2 Thin control plane, binary data plane

The control plane is JSON and lightweight:

- status,
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

### 2.6 Migration does not create a second permanent architecture

Feature flags may exist only as short-lived migration scaffolding.

The canonical end-state is one resource-first stack.
Long-lived dual operation of the old bootstrap/poll model and the new resource model is an
architectural regression.

## 3. Canonical endpoint families

The canonical local control-room contract lives under versioned resource paths.

### 3.1 Control-plane endpoints

```text
GET    /v1/live/current/status
GET    /v1/capabilities
GET    /v1/openapi.json
GET    /v1/docs/swagger
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

### 3.3 Field resource endpoints

```text
GET    /v1/live/current/fields/catalog
GET    /v1/live/current/fields/:quantity_id/meta
GET    /v1/live/current/fields/:quantity_id/vector
GET    /v1/live/current/scalars
```

Rules:

- already computed quantities are treated as data resources,
- `fields/catalog` and field metadata are JSON,
- field vectors are binary by default,
- scalars are windowed/incremental and keyed by revision or cursor,
- `field_revision` and `scalars_revision` are first-class cache signals.

### 3.4 Control/action endpoints

```text
PUT    /v1/live/current/display
POST   /v1/live/current/commands
POST   /v1/live/current/scene
POST   /v1/live/current/script/sync
```

Rules:

- display state is updated through one consolidated resource,
- command submission is explicit and structured,
- scene/script synchronization must preserve canonical Python and `ProblemIR` semantics.

### 3.5 Supporting resource families

The same architecture applies to:

- `/v1/live/current/artifacts*`
- `/v1/live/current/logs/*`
- `/v1/live/current/eigen/*`
- `/v1/live/current/session/*`
- `/v1/live/current/gpu/*`

They are resource families, not ad hoc side channels.

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
- `x-api-contract-version` on every response,
- structured request logging on the backend,
- contract/version checks in the frontend client,
- typed error mapping for control-room failures,
- optional ETag/revision headers for large binary resources.

## 7. Anti-regression rules

The following are architectural regressions:

- bringing back `/bootstrap` or `/poll` as the canonical browser contract,
- reintroducing multiple preview mutation endpoints for quantity switching,
- stuffing heavy arrays into `status`,
- duplicating the viewport tree into separate FDM and FEM products,
- keeping old and new API stacks alive indefinitely,
- letting frontend components bypass the shared API client.
