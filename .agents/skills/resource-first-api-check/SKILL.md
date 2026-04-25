---
name: resource-first-api-check
description: "Primary Fullmag v2 browser/API governance skill. Use for any change touching OpenAPI v2, generated frontend transport/types, session API facades, resource hooks, realtime events, binary codecs, command completion, workspace/ribbon state, diagnostics, or unified FDM/FEM viewport data paths."
---

# Fullmag Resource-First OpenAPI Check

## Role

This is the primary guardrail for Fullmag's browser/runtime contract and product architecture.

The current meaning of "resource-first" is not "an endpoint exists for the screen." It is a professional platform contract:

`runtime state -> OpenAPI v2 contract -> generated v2 types/transport -> handwritten domain facade -> resource hooks/cache -> adapters/codecs -> one ribbon and unified viewport`

If any link in that chain is skipped, the change is incomplete.

The product standard is the same standard expected from strong commercial engineering teams: canonical contracts, modular ownership, predictable resource families, typed transport, explicit state ownership, no hidden fallback, no screen-shaped backend APIs, no ad-hoc endpoint strings, and no component-level transport logic.

## When To Use

Use this skill when work touches any of these:

- `crates/fullmag-api` routes, schemas, headers, errors, commands, or status payloads,
- OpenAPI v2 source/spec files or generated files under `apps/web/src/api/generated/openapi-v2*`,
- `apps/web/src/api/client/` modules, `LiveSessionClient`, `sessionApiPaths`, interceptors, errors, cache, or command adapters,
- `apps/web/src/hooks/resources/`,
- `docs/specs/resource-first-control-room-api-v2.md`, endpoint docs, AsyncAPI docs, or v2 cutover docs,
- realtime events, resource invalidation, command completion, or revision/generation semantics,
- field/topology/scalar/artifact binary codecs, scoped mesh/field payloads, or data-plane payloads,
- ribbon commands, workspace docks, center tabs, inspectors, display controls, or viewport resource routing,
- removal of old bootstrap/poll/preview/v1 flows.

## Non-Negotiable Contract

1. **OpenAPI v2 is executable truth for browser JSON transport.**
   Backend schema, generated TypeScript types, generated transport, API modules, hooks, and tests must move together. Browser-facing work targets `/v2/platform/...` and `/v2/sessions/current/...`. Public `/v1/live/current/...` is not a frontend contract.

2. **Generated transport is required, but it is deliberately low-level.**
   `pnpm --dir apps/web generate:api` must regenerate `openapi-v2.json`, `openapi-v2-types.ts`, and `openapi-v2-client.ts`. Generated code owns path/request/response typing only. Product semantics stay in handwritten facades such as `LiveSessionClient`, `ControlRoomApi`, resource hooks, codecs, cache policy, command adapters, and viewport adapters.

3. **Status stays thin.**
   Status carries state, capabilities, resource identities, revisions, generation IDs, command summaries, and diagnostics. It must not carry heavy fields, topology arrays, or UI-only blobs.

4. **The v2 tree is organized by platform model, not by screens.**
   Use the canonical families: `platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`, `workspace`, `analysis`, `persistence`, and `diagnostics`. Do not create screen-shaped or one-off routes when a resource belongs to an existing family.

5. **Resources are named, scoped, and revisioned.**
   Domain, scene, topology, mesh, fields, quantities, scalars, stages, logs, artifacts, diagnostics, display state, and workspace layout are fetched as resources with explicit identity and freshness. Mesh and field resources must support scoped access when the UI only needs an object, part, airbox, or selection.

6. **Every field has one owning read-model.**
   Summary resources may expose ids, revision pointers, links, or short dashboard summaries, but they must not copy full payloads from another family. `status` owns UI gating and revision pointers, `simulation/runs/*` owns run metadata, `simulation/stages/execution` owns the stage tree, `simulation/solver/*` owns solver state and energies, and meshing details are split between summary, builds, semantics, manifest, quality, and report resources.

7. **Capabilities have scoped ownership.**
   `platform/capabilities` describes server/runtime process features. `status.capabilities` is the only active-session UI gating source. `meshing/capabilities` describes meshing policy/build features only and must not drive global UI gating.

8. **Heavy numerical data uses the data plane.**
   Field vectors, large scalar histories, topology buffers, and mesh payloads must use binary codecs, ETag/304, and scoped fetch semantics where appropriate. JSON is control plane.

9. **React components do not own transport.**
   Components use resource hooks, domain facades, and typed client modules. Direct component `fetch()` is a regression. Direct `getLiveSessionClient()` usage outside central facade/hook layers requires an explicit migration note and allowlist entry.

10. **No hand-built endpoint strings in UI modules.**
   Endpoint paths live in generated v2 transport and central path/facade modules. UI code must not construct `/v2/...` strings ad hoc. If an endpoint is missing, add it to the v2 contract and regenerate.

11. **One workspace tree.**
   FDM/FEM differences live behind capability checks, domain adapters, codecs, render models, and layer guards. Do not fork the product into separate FDM and FEM applications.

12. **One ribbon command model.**
   Build/Analyze/Study as separate product surfaces is legacy. Commands belong in the unified ribbon/command registry with explicit capability, intent, completion, and diagnostics.

13. **Requested intent and resolved reality both survive.**
   Execution selection, backend/device/precision, degraded mode, fallback rejection, stage stop reason, and provenance must be visible where relevant.

14. **HTTP v2 is the frontend source of truth; realtime invalidates resources.**
   HTTP resources under `/v2/sessions/current/...` own snapshots, commands, binary data-plane fetches, resource refreshes, and full state recovery. `GET /v2/sessions/current/events/ws` carries lifecycle events, command completion, resource revision changes, and cache invalidation. Websocket/AsyncAPI events must not become a second full-state transport for heavy fields, topology, mesh payloads, artifacts, or session snapshots.

15. **Transitional paths must have removal criteria.**
    Internal runtime bridges, bootstrap/poll remnants, old Analyze components, or compatibility adapters may exist only when named as transitional and actively contained. They must not be exposed as public browser API.

## Workflow

1. Identify every affected v2 family, resource, command, event, codec, scope, and UI consumer.
2. Update backend route/schema and OpenAPI v2 contract first, or prove the change is frontend-only.
3. Keep route ownership professional: choose the right family, use RESTful resource naming, avoid screen-shaped endpoint names, and keep command operations under `simulation/commands`.
4. Verify single-owner field semantics before adding or widening a read-model. If two resources need similar data, one owns the full payload and the other exposes only a summary, id, revision, or link.
5. Regenerate frontend v2 OpenAPI, v2 types, and generated v2 transport with `pnpm --dir apps/web generate:api`.
6. Update handwritten domain facades, API modules, error mapping, request headers, cache keys, and resource hooks. Do not push UI semantics into generated code.
7. Update binary codecs/data-plane readers when heavy payloads change, including scoped mesh/field access.
8. Update adapters, unified viewport layers, display controls, ribbon commands, docks, inspectors, and diagnostics that consume the resource.
9. Update docs/specs when endpoint shapes, resource semantics, headers, realtime envelopes, generation policy, or migration policy changed.
10. Add tests at the narrowest useful layer and include at least one stale/degraded/error path when the contract can fail.
11. Search for old paths and ad-hoc transport before finishing: `/v1/live/current`, `/v1/health`, `/v1/capabilities`, hand-built `/v2` strings in UI code, v1 generated type imports, direct component fetches, and runtime v2-to-v1 fallbacks.

Useful searches:

- `rg "fetch\\(" apps/web`
- `rg "/v1/live/current|/v1/health|/v1/capabilities" apps/web/src apps/web/lib apps/web/components apps/web/features crates/fullmag-api/src`
- `rg '"/v1(?!/internal)' crates/fullmag-api/src/main.rs --pcre2`
- `rg "generated/openapi-types|openapi-v2-types|openapi-v2-client|sessionApiPaths|getLiveSessionClient|LiveSessionClient" apps/web/src`
- `rg '\"/v2/' apps/web/src apps/web/components apps/web/features apps/web/lib --glob '!src/api/generated/**'`
- `rg "bootstrap|poll|preview" apps/web docs/specs`
- `rg "Analyze|StudyBuilder|Build" apps/web/components apps/web/features`
- `rg "openapi-types|LiveSessionClient|use.*Resource|useField|useTopology" apps/web/src apps/web/features apps/web/components`

## Required Test Coverage

Choose the relevant classes:

- backend route/schema contract tests,
- OpenAPI generation/type-use checks,
- generated v2 transport type tests,
- API module tests,
- resource hook/cache invalidation tests,
- interceptor tests for request id, contract version, retry, and diagnostics,
- command completion/rejection tests,
- binary codec malformed-payload tests,
- viewport adapter/layer/render-model tests,
- ribbon command gating tests,
- docking/center-tab/resource consumer tests.

Baseline commands:

- `pnpm --dir apps/web generate:api`
- `cargo test -p fullmag-api router_v2 --no-fail-fast`
- `pnpm --dir apps/web typecheck`
- `pnpm --dir apps/web test:quantity-api-gates`
- `./scripts/ci-resource-first-gates.sh --strict`
- `./scripts/ci/contract_guard.sh --strict`

When lint is requested, distinguish new findings from existing repo-wide React Compiler debt. At minimum, run targeted ESLint over changed frontend files.

## Blockers

Stop and redesign if the change:

- puts heavy field/topology payloads into status,
- adds direct component `fetch()`,
- makes websocket the authoritative source for full state, heavy fields, topology, mesh payloads, or artifacts,
- adds a frontend runtime fallback from v2 to `/v1/live/current/...`,
- adds a new public browser route under `/v1`,
- reintroduces `apps/web/src/api/generated/openapi.json` or `openapi-types.ts`,
- changes generated client code manually instead of changing `apps/web/scripts/generate-v2-client.mjs` and rerunning generation,
- treats generated transport as the place for UI/domain semantics,
- builds endpoint paths directly inside React components or feature UI modules,
- creates a new FDM-only or FEM-only app tree,
- treats preview as the warm quantity-switching path,
- hides fallback from requested execution to another backend/device/precision,
- changes UI semantics without Python DSL and `ProblemIR` round-trip implications,
- updates backend JSON without OpenAPI/generated type alignment,
- adds a compatibility bridge without a removal condition.

## Final Answer Requirements

When this skill is used, report:

- which resources/commands/events changed,
- whether OpenAPI v2, generated v2 types, and generated v2 transport were updated,
- whether generated v2 transport remains the only low-level frontend transport,
- which API modules/hooks/codecs/adapters changed,
- how HTTP v2 remains the source of truth and websocket remains event/invalidation only,
- how the unified ribbon/viewport path was preserved,
- what tests were run,
- any transitional legacy path that remains.
