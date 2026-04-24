---
name: resource-first-api-check
description: "Primary Fullmag browser/API governance skill. Use for any change touching OpenAPI, generated frontend types, API client modules, resource hooks, realtime events, binary codecs, command completion, workspace ribbon commands, docks, or unified FDM/FEM viewport data paths."
---

# Fullmag Resource-First OpenAPI Check

## Role

This is the primary guardrail for Fullmag's browser/runtime contract.

The old meaning of "resource-first" was not "some endpoints under `/v1/live/current`." The current meaning is stricter:

`runtime state -> OpenAPI contract -> generated types -> typed API client -> resource hooks/cache -> adapters/codecs -> one ribbon and unified viewport`

If any link in that chain is skipped, the change is incomplete.

## When To Use

Use this skill when work touches any of these:

- `crates/fullmag-api` routes, schemas, headers, errors, commands, or status payloads,
- OpenAPI source/spec files or `apps/web/src/api/generated/openapi-types.ts`,
- `apps/web/src/api/client/` modules, interceptors, errors, cache, or command adapters,
- `apps/web/src/hooks/resources/`,
- `docs/specs/resource-first-control-room-api-v1.md`, endpoint docs, or AsyncAPI docs,
- realtime events, resource invalidation, command completion, or revision/generation semantics,
- field/topology/scalar/artifact binary codecs or data-plane payloads,
- ribbon commands, workspace docks, center tabs, inspectors, display controls, or viewport resource routing,
- migration away from bootstrap/poll/preview flows.

## Non-Negotiable Contract

1. **OpenAPI is executable truth for browser JSON.**
   Backend schema, generated TypeScript types, API modules, hooks, and tests must move together.

2. **Status stays thin.**
   Status carries state, capabilities, resource identities, revisions, generation IDs, command summaries, and diagnostics. It must not carry heavy fields, topology arrays, or UI-only blobs.

3. **Resources are named and revisioned.**
   Domain, scene, topology, mesh, fields, quantities, scalars, stages, logs, artifacts, diagnostics, display state, and workspace layout are fetched as resources with explicit identity and freshness.

4. **Heavy numerical data uses the data plane.**
   Field vectors, large scalar histories, topology buffers, and mesh payloads must use binary codecs or an explicitly justified transport. JSON is control plane.

5. **React components do not own transport.**
   Components use resource hooks and typed client modules. Direct component `fetch()` is a regression.

6. **One workspace tree.**
   FDM/FEM differences live behind capability checks, domain adapters, codecs, render models, and layer guards. Do not fork the product into separate FDM and FEM applications.

7. **One ribbon command model.**
   Build/Analyze/Study as separate product surfaces is legacy. Commands belong in the unified ribbon/command registry with explicit capability, intent, completion, and diagnostics.

8. **Requested intent and resolved reality both survive.**
   Execution selection, backend/device/precision, degraded mode, fallback rejection, stage stop reason, and provenance must be visible where relevant.

9. **Realtime invalidates resources.**
   Websocket/AsyncAPI events should identify changed resources and revisions. They should not become a second full-state transport unless explicitly designed and documented.

10. **Transitional paths must have removal criteria.**
    Bootstrap, poll, preview, old Analyze components, or compatibility bridges may exist only when named as transitional and actively contained.

## Workflow

1. Identify every affected resource, command, event, codec, and UI consumer.
2. Update backend route/schema and OpenAPI contract first, or prove the change is frontend-only.
3. Regenerate frontend types using the repo's established generator.
4. Update typed API modules, error mapping, request headers, cache keys, and resource hooks.
5. Update binary codecs/data-plane readers when heavy payloads change.
6. Update adapters, unified viewport layers, display controls, ribbon commands, docks, and inspectors that consume the resource.
7. Update docs/specs when endpoint shapes, resource semantics, headers, realtime envelopes, or migration policy changed.
8. Add tests at the narrowest useful layer and include at least one stale/degraded/error path when the contract can fail.
9. Search for old paths before finishing.

Useful searches:

- `rg "fetch\\(" apps/web`
- `rg "bootstrap|poll|preview" apps/web docs/specs`
- `rg "Analyze|StudyBuilder|Build" apps/web/components apps/web/features`
- `rg "openapi-types|LiveApiClient|use.*Resource|useField|useTopology" apps/web/src apps/web/features apps/web/components`

## Required Test Coverage

Choose the relevant classes:

- backend route/schema contract tests,
- OpenAPI generation/type-use checks,
- API module tests,
- resource hook/cache invalidation tests,
- interceptor tests for request id, contract version, retry, and diagnostics,
- command completion/rejection tests,
- binary codec malformed-payload tests,
- viewport adapter/layer/render-model tests,
- ribbon command gating tests,
- docking/center-tab/resource consumer tests.

## Blockers

Stop and redesign if the change:

- puts heavy field/topology payloads into status,
- adds direct component `fetch()`,
- creates a new FDM-only or FEM-only app tree,
- treats preview as the warm quantity-switching path,
- hides fallback from requested execution to another backend/device/precision,
- changes UI semantics without Python DSL and `ProblemIR` round-trip implications,
- updates backend JSON without OpenAPI/generated type alignment,
- adds a compatibility bridge without a removal condition.

## Final Answer Requirements

When this skill is used, report:

- which resources/commands/events changed,
- whether OpenAPI and generated types were updated,
- which API modules/hooks/codecs/adapters changed,
- how the unified ribbon/viewport path was preserved,
- what tests were run,
- any transitional legacy path that remains.
