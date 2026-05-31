# Viewport Realtime Invalidation Architecture Audit - 2026-05-31

## Scope

This audit covers the control-room 3D viewport performance failure where simple
camera interaction triggers `GET /status` churn and refetch/decode of full
field-vector payloads even though the backend is not computing new field data.

Primary evidence sources:

- frontend realtime invalidation path in `apps/control-room/src/kernel/realtime`;
- frontend viewport field-resource hooks in `apps/control-room/src/modules/viewport-3d`;
- backend visualization mutation handlers in
  `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`;
- backend realtime change synthesis in `crates/fullmag-api/src/main.rs`;
- backend status revision synthesis in
  `crates/fullmag-api/src/router_v2/handlers/sessions/status.rs`.

## Executive Summary

The repository already models UI state and data resources as separate HTTP
families, but the realtime aggregation layer breaks that separation.

Two confirmed design faults cause the observed viewport stalls:

1. the backend synthesizes field-vector `recommended_fetch` hints
   independently of the active renderer demand and always promotes them to
   `component=full&scope_kind=full`;
2. the backend uses `snapshot.state_version` as the revision source for
   field-vector invalidation, so unrelated session snapshot rebuilds can look
   like field-data changes.

A third architectural fault keeps the bug alive even if realtime is narrowed:

3. the `data/fields/*` handlers themselves derive `field_revision` and ETags
   from `snapshot.state_version`, so any refetch that reaches the data plane
   can still look fresh under unrelated snapshot churn.

As a result, the frontend can correctly avoid refetching on a direct
`PATCH /visualization/state` camera update, yet still receive a later
`resource.batch_changed` event that falsely announces full field-vector
freshness changes.

## Confirmed Current Architecture

### What is already separated correctly

- `PATCH /v2/sessions/current/visualization/state` only emits realtime changes
  for `/visualization/display` and `/visualization/state`.
- Frontend camera interaction writes through `CameraRegistryController` and
  local viewport store state rather than directly through field-resource hooks.
- The canonical API spec already states that heavy numerical payloads must stay
  on data-plane routes and must not be copied into `status`.

### What is not separated correctly

- The canonical realtime websocket is one shared invalidation bus for UI-plane,
  workspace-plane, and data-plane resources.
- `CurrentLiveRealtimeState` precomputes `field_vector_fetches` for every
  previewable 3D quantity in the snapshot, regardless of active visualization
  demand.
- Those fetch hints are hard-coded to
  `/data/fields/{quantity_id}/samples/vector?component=full&scope_kind=full`.
- `current_live_realtime_change_revision_changed()` decides whether those field
  fetches changed by comparing `previous.fields_revision` against
  `change.revision`.
- `fields_revision` is currently populated from `snapshot.state_version`, which
  is bumped by generic live-sync updates, not only by real field-data changes.

## Concrete Violations

### V-01 - Field invalidation is keyed off a generic session snapshot counter

Current behavior:

- `snapshot.state_version` increments during generic live-sync updates.
- realtime `Fields` changes for exact field-vector fetches reuse that value.
- any code path that rebuilds the session snapshot can therefore publish a fake
  field-data change.

Why this is wrong:

- `state_version` is a transport/session aggregation concern.
- field-vector freshness must be keyed off `field_revision` or a dedicated
  equivalent that changes only when sampled field payloads change.

Required correction:

- field-vector invalidation must compare against `field_revision`, not against a
  generic `fields_revision = state_version`.

### V-02 - Realtime field fetch hints ignore active viewport demand

Current behavior:

- the backend emits full-domain/full-vector fetch hints for all previewable
  quantities.

Why this is wrong:

- the active viewport may only need `component=magnitude`;
- the active viewport may only need one scoped airbox/object/part query;
- the frontend may not be displaying most quantities at all.

Required correction:

- realtime field fetch hints must either:
  - reflect exact active visualization demand, including query string, or
  - be omitted entirely and replaced with a family revision that the frontend
    resolves locally against currently observed resources.

### V-03 - UI-only mutations share a bus with heavy-data invalidation without a hard boundary

Current behavior:

- UI-only visualization updates are emitted correctly at mutation time.
- later live-sync publication can still append field-vector invalidation into
  the same bus because the backend lacks a hard boundary between UI-plane and
  data-plane revision production.

Why this is wrong:

- a camera-only patch should never be able to causally lead to a field-vector
  refetch unless real field data changed.

Required correction:

- UI-plane revision production and data-plane revision production must be
  computed from separate sources of truth, even if they continue to share one
  websocket transport.

### V-04 - Field endpoint ETags are keyed off `snapshot.state_version`

Current behavior:

- `GET /data/fields`, `GET /data/fields/{quantity_id}/meta`, vector, slice,
  projection, matrix, and render endpoints all derive field freshness from
  `snapshot.state_version`.

Why this is wrong:

- even a perfectly narrowed realtime layer cannot prevent false-positive field
  refreshes if the data-plane endpoint itself presents a new ETag for an
  unchanged payload.

Required correction:

- field endpoint revisions and ETags must be derived from tracked field payload
  freshness per quantity and per family, not from the generic session publish
  counter.

## Correct Target Architecture

### Ownership model

- `visualization/*` owns camera, display, layers, active quantity, trim, clip,
  and other renderer policy.
- `workspace/*` owns shell selection/layout/ribbon state.
- `data/fields/*` owns field sample payload freshness.
- `data/scalars` owns scalar history freshness.
- `sessions/current/status` may summarize revision pointers but must not invent
  or amplify data-plane invalidations.

### Realtime model

- one websocket transport is acceptable;
- one shared revision source is not;
- each `RealtimeResourceChange` must be backed by the owner of that resource;
- exact field-vector `recommended_fetch` entries must be opt-in and tied to
  exact changed queries, not to all possible viewport field resources.

### Frontend model

- `RealtimeInvalidationBridge` should treat backend `recommended_fetch` as exact
  hints, not as a license to infer larger invalidation families;
- the frontend may still choose to defer heavy field-resource reload during
  active camera interaction, but that is a second-line mitigation, not the
  primary fix.

## Implementation Instructions

### Backend

1. Replace field-vector realtime change gating so exact vector fetches compare
   against `field_revision` or another payload-derived field-data revision.
2. Stop populating exact field-vector fetch hints from a blanket
   `current_live_field_vector_fetches(snapshot)` inventory.
3. Introduce tracked field revisions in session state so `/data/fields`,
   `/data/fields/{quantity_id}/meta`, vector, slice, projection, matrix, and
   render routes all share the same payload-owned freshness model.
4. Introduce a contract that exact field fetch hints are emitted only when the
   backend can name the changed query precisely.
5. Keep `field_catalog_revision` separate from sample-payload freshness.
6. Keep `snapshot.state_version` as a polling/session aggregation primitive if
   needed, but do not reuse it as data-plane freshness for field vectors.

### Frontend

1. Preserve full query identity in diagnostics so the transport log shows the
   exact field-vector query instead of only the pathname.
2. Continue using scoped/scalar field queries in viewport hooks.
3. Narrow any frontend invalidation promotion rules that still derive
   `/data/fields/*` refreshes from `/data/scalars` changes without a backend
   proof of field freshness change.
4. Add a camera-interaction guard so heavy field refetch/decode is coalesced
   until interaction end if a legitimate field change arrives mid-drag.

## Acceptance Criteria

- Camera-only `PATCH /visualization/state` yields only visualization fetch hints.
- Generic live-sync events that do not change field payloads do not emit
  `/data/fields/{quantity_id}/samples/vector` invalidations.
- Exact field-vector invalidations preserve the active query string.
- Thread Manager no longer shows full-vector decode work caused solely by camera
  interaction.
- Backend and frontend tests prove the separation rather than relying on manual
  inspection.
