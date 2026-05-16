# ADR 0011 — Resource-first API migration

**Status:** accepted  
**Date:** 2026-04-20  
**Decision makers:** core team

## Context

Fullmag's frontend–backend communication is built on a monolithic bootstrap
pattern. On first load, a single `GET /v1/live/current/bootstrap` returns the
entire session state—fields, scalars, meshes, quantities, metadata—in one
JSON blob that can range from 50 KB to 500 KB. Incremental updates flow
through `GET /v1/live/current/poll?since_version=X` which carries a delta of
the same monolithic shape.

This design has several consequences:

1. **Slow first paint.** The UI cannot render until the full bootstrap
   arrives, parses, and normalizes (via a 2 000-line `normalize.ts`).
2. **Wasted bandwidth.** Heavy data (field vectors, topology) is re-sent even
   when only scalar counters changed.
3. **Debugging difficulty.** A single wire shape makes it hard to attribute
   latency or errors to a specific resource.
4. **FDM/FEM branching.** Because the bootstrap shape carries both FDM and FEM
   data, the frontend branches on `selectIsFemBackend` in 15+ locations to
   choose renderers, hooks, and stores.
5. **No API contract.** There is no formal specification; wire shapes are
   inferred from `types.ts` and runtime inspection.
6. **Authoring ambiguity.** The bootstrap-era mental model does not make it
   clear where model-tree, inspector, study-pipeline, and ribbon edits belong,
   which encourages ad hoc scene writes and UI-specific side channels.

## Decision

Migrate to a **resource-first API** with the following properties:

### 1. Thin status endpoint

`GET /v1/live/current/status` returns a lightweight (~2–5 KB) JSON object
carrying session state, solver state, display selection, revision map, and
capability map—but **no heavy data** (no field arrays, no topology, no scalar
history).

### 2. On-demand resource fetching

Heavy data is fetched lazily from dedicated resource endpoints:

| Resource | Endpoint | Format |
|----------|----------|--------|
| Domain meta | `GET /domain/meta` | JSON |
| Domain topology | `GET /domain/topology` | Binary FMMT v1 |
| Domain coordinates | `GET /domain/coordinates` | Binary |
| Field catalog | `GET /fields/catalog` | JSON |
| Field vector | `GET /fields/{id}/vector` | Binary FMVP v2 |
| Scalar history | `GET /scalars?since_revision=X` | JSON |

Control-plane JSON and data-plane binary are separate by design.
`status` remains thin; field vectors and topology stay out of the status payload.

### 3. Revision-based cache

Every resource carries a revision (`field_revision`, `domain_generation_id`,
`scalars_revision`). The frontend caches by revision and only re-fetches when
the status endpoint reports a newer revision.

#### 3a. 2026-04-23 addendum: independent revision vocabulary

The canonical status/realtime revision vocabulary is extended with explicit
resource-family pointers:

- `topology_revision`
- `field_catalog_revision`
- `field_revision`
- `slice_revision`
- `artifact_revision`
- `command_completion_revision`

Compatibility aliases may coexist during migration (`fields_revision`,
`artifacts_revision`, `commands_revision`), but new work must consume the
canonical pointers.

`field_revision` updates must not imply `topology_revision` updates.
Component-level field requests must stay component-aware and must not trigger
hidden full-vector fallback fetches.
Slice resources are first-class read paths and remain in the binary data lane.

### 4. Workspace and authoring are first-class resource families

The resource-first split applies not only to runtime data, but also to control-room authoring.

- `workspace/*` carries selection, ribbon state, active node, layout, and similar UI-only state.
- `authoring/*` carries the editable simulation model, materials, magnetization assets, physics
  stacks, study pipeline, and script synchronization.
- `SceneDocument` remains the canonical round-trip authoring document.
- Narrow `authoring/*` routes are allowed only as semantic projections over the same
  `scene_revision`; they must not become a second persistence model.

This prevents model builder, inspector panels, and ribbons from degenerating into a hidden second
architecture outside the API contract.

### 5. Unified FDM/FEM domain contract

Domain endpoints are discretization-neutral. `/domain/meta` returns a
`DiscretizationKind` field and the adapter layer on the frontend decides how
to interpret coordinates and topology.

The control room keeps one UI tree.
FDM/FEM differences are handled through capability maps and domain adapters, not through separate
product branches.

### 6. Consolidated display control

The 10+ legacy preview POST endpoints are replaced by a single
`PUT /display` endpoint that accepts the full `DisplaySelection` update.

2026-04-30 update: `/v2/sessions/current/visualization/state` is the canonical
renderer state resource for new clients. Schema version 4 separates quantity,
layers, domains/scopes, sampling budgets, FDM/FEM policy, trim/clip state,
session-wide camera state, vector glyph style, overrides, and diagnostics.
`/visualization/display` remains the compatibility projection for legacy
display-selection clients. WebSocket events invalidate this HTTP resource; they
do not become a separate visualization state transport.

### 7. OpenAPI documentation

The former v1 API was documented via utoipa-generated OpenAPI 3.1 spec at
`/v1/openapi.json` and rendered at `/v1/docs/swagger`. Those public v1 browser
surfaces are now superseded by v2.

#### 7a. 2026-04-25 addendum: v2 session-scoped API tree

The canonical target API for new control-room work is now v2:

- `GET /v2/platform/openapi.json`
- `GET /v2/platform/docs/swagger/`
- `/v2/sessions/current/...`

V2 organizes the API by platform concepts rather than by frontend screens:
`platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`,
`workspace`, `analysis`, `persistence`, and `diagnostics`.

Public `/v1/live/current/...` has been removed from the browser contract.
Only `/v1/internal/live/current/...` may remain as a backend-only runtime bridge.

OpenAPI v2 and generated TypeScript types are the transport contract. The frontend still keeps a
manual domain facade (`LiveSessionClient`, resource hooks, binary codecs, and adapters) for UI
semantics, caching, and FDM/FEM interpretation.

### 8. AsyncAPI-documented realtime websocket

The canonical realtime channel is:

- `GET /v2/sessions/current/events/ws`

It is explicitly notification-first:

- HTTP resources remain the source of truth,
- clients reconnect with `after_seq`,
- clients offer `Sec-WebSocket-Protocol: fullmag.live.v1`,
- websocket frames carry invalidation/lifecycle events, not heavy field/topology payloads,
- the websocket contract is documented in AsyncAPI at `/v2/platform/asyncapi.json` and `/v2/platform/docs/asyncapi`.

### 8. Professional API client

The frontend gets a typed `LiveApiClient` with interceptors (request-id,
retry, version-check, diagnostics), a `ResourceCache`, and modular endpoint
modules.

### 9. Feature-flag migration

A `FULLMAG_NEW_API` / `NEXT_PUBLIC_USE_NEW_API` flag allows running old and
new API in parallel during migration. Legacy code is removed once the new
path is validated.

Feature flags are migration scaffolding, not a permanent architecture layer.
The canonical end-state is one resource-first stack with no long-lived dual
operation of bootstrap/poll and resource-first flows.
As of `2026-04-21`, the active browser Control Room path no longer depends on
the legacy whole-state snapshot compatibility route.

## Consequences

### Positive
- First load drops from 1–3 s to < 500 ms.
- Quantity switching becomes near-instant (cache hit < 50 ms).
- ~140 KB of legacy frontend code removed (normalize.ts, merge.ts, etc.).
- FDM/FEM branching eliminated from UI components.
- Formal API spec enables type generation and contract testing.
- x-request-id correlation improves debugging.

### Negative
- Dual-running during migration increases short-term complexity.
- Binary endpoints are harder to document in OpenAPI (description-only).
- Existing tests need updating as bootstrap endpoint is removed.

### Neutral
- Binary protocols (FMVP v2, FMMT v1) are unchanged.
- The canonical realtime path is `GET /v2/sessions/current/events/ws`; no legacy websocket compatibility layer remains in the public server.

## Follow-up rule

When the local browser API, cache semantics, OpenAPI contract, or FDM/FEM
adapter boundary changes, update:

- `docs/specs/resource-first-control-room-api-v2.md`
- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/control-room-api-endpoint-reference-v1.md`
- `docs/specs/control-room-api-tree-v1.md`
- `docs/specs/session-run-api-v1.md` when runtime semantics changed
- agent guidance in `AGENTS.md`, `.agents/`, and `.github/`

## Migration plan

See `docs/reports/20.04.2026/final_plan/09_migracja_etapy.mdx` for the
10-stage migration plan with acceptance criteria per stage.
