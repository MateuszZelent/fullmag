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

### 4. Unified FDM/FEM domain contract

Domain endpoints are discretization-neutral. `/domain/meta` returns a
`DiscretizationKind` field and the adapter layer on the frontend decides how
to interpret coordinates and topology.

The control room keeps one UI tree.
FDM/FEM differences are handled through capability maps and domain adapters, not through separate
product branches.

### 5. Consolidated display control

The 10+ legacy preview POST endpoints are replaced by a single
`PUT /display` endpoint that accepts the full `DisplaySelection` update.

### 6. OpenAPI documentation

The new API is documented via utoipa-generated OpenAPI 3.1 spec, accessible
at `/v1/openapi.json` and rendered at `/v1/docs/swagger`.

### 7. Professional API client

The frontend gets a typed `LiveApiClient` with interceptors (request-id,
retry, version-check, diagnostics), a `ResourceCache`, and modular endpoint
modules.

### 8. Feature-flag migration

A `FULLMAG_NEW_API` / `NEXT_PUBLIC_USE_NEW_API` flag allows running old and
new API in parallel during migration. Legacy code is removed once the new
path is validated.

Feature flags are migration scaffolding, not a permanent architecture layer.
The canonical end-state is one resource-first stack with no long-lived dual
operation of bootstrap/poll and resource-first flows.

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
- WebSocket endpoints remain deprecated (polling is the active path).

## Follow-up rule

When the local browser API, cache semantics, OpenAPI contract, or FDM/FEM
adapter boundary changes, update:

- `docs/specs/resource-first-control-room-api-v1.md`
- `docs/specs/session-run-api-v1.md` when runtime semantics changed
- agent guidance in `AGENTS.md`, `.agents/`, and `.github/`

## Migration plan

See `docs/reports/20.04.2026/final_plan/09_migracja_etapy.mdx` for the
10-stage migration plan with acceptance criteria per stage.
