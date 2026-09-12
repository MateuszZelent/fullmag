---
name: resource-first-api-check
description: "Primary Fullmag v2 browser/API governance skill. Use for changes touching OpenAPI v2, generated frontend transport/types, session facades, resource hooks, realtime invalidation, binary codecs, command completion, workspace/ribbon state, diagnostics, or unified FDM/FEM viewport data paths."
---

# Fullmag Resource-First OpenAPI Check

This is the primary browser/runtime contract for `apps/control-room`. The user instruction and root `AGENTS.md` take precedence. Reuse this skill when already loaded; do not read it twice in one turn.

The contract is:

`runtime state -> OpenAPI v2 -> generated v2 types/transport -> handwritten domain facade -> resource hooks/cache -> adapters/codecs -> one ribbon and unified viewport`

## Scope and current paths

Use the current v2 tree:

- backend routes and schemas: `crates/fullmag-api`;
- OpenAPI generated files: `apps/control-room/src/kernel/api/generated/openapi-v2.json`, `openapi-v2-types.ts`, and `openapi-v2-client.ts`;
- generated client script: `apps/control-room/scripts/generate-v2-client.mjs`;
- handwritten facade, hooks, codecs, and adapters under `apps/control-room/src/kernel/api` and affected modules;
- resource spec: `docs/specs/resource-first-control-room-api-v2.md`.

Do not use `apps/web/src/api` or `apps/web/scripts/generate-v2-client.mjs`; those paths are absent in the current checkout. Treat any `apps/web` reference as legacy evidence and apply cutover governance.

## Non-negotiable contract

1. OpenAPI v2 is executable truth for browser JSON transport. Backend schema, generated types/transport, facades, hooks, and tests move together. Frontend targets `/v2/platform/...` and `/v2/sessions/current/...`; public `/v1/live/current/...` is not a frontend contract.
2. Generated transport is low-level and owns path/request/response typing only. Product semantics remain in handwritten facades, resource hooks, codecs, cache policy, command adapters, and viewport adapters.
3. Status stays thin: ids, capabilities, resource identities, revisions, generation IDs, command summaries, and diagnostics. Never put heavy fields, topology arrays, or UI-only blobs in status.
4. Organize resources by platform model: `platform`, `sessions`, `model`, `meshing`, `simulation`, `data`, `visualization`, `workspace`, `analysis`, `persistence`, and `diagnostics`.
5. Give domain, scene, topology, mesh, fields, quantities, scalars, stages, logs, artifacts, diagnostics, display state, and workspace layout explicit identity, scope, and revision. Mesh/field resources support scoped reads when the UI needs only a selection.
6. Keep one owning read-model per heavy field. Summaries expose ids, revisions, links, or short summaries; the owner carries the payload.
7. Keep capability ownership scoped: process/runtime capabilities in `platform/capabilities`, active-session UI gating in `status.capabilities`, meshing policy in `meshing/capabilities`.
8. Send heavy numerical data through binary codecs and scoped/conditional fetch semantics where appropriate; JSON is the control plane.
9. React components do not own transport. Direct component `fetch()` and direct client access outside the facade/hook layer require an explicit migration reason.
10. Do not hand-build `/v2/...` paths in feature UI. Add missing routes to the contract and regenerate.
11. Keep one workspace and one ribbon command model; FDM/FEM differences belong in capability guards, adapters, codecs, render models, and layer guards.
12. Preserve requested intent and resolved reality: backend/device/precision, degraded mode, fallback rejection, stage stop reason, and provenance.
13. HTTP v2 owns snapshots, commands, binary data, refresh, and recovery. `GET /v2/sessions/current/events/ws` carries lifecycle/completion/revision/invalidation events only, not heavy snapshots.
14. Transitional bridges need an owner, containment, and removal criterion.

## Workflow

1. Identify affected resource family, command, event, codec, scope, and UI consumer.
2. Update backend schema/OpenAPI first, or record why the change is frontend-only.
3. Verify single-owner payload semantics and choose the correct resource family.
4. Run `pnpm --dir apps/control-room generate:api` when the backend schema changes; never edit generated files by hand.
5. Update facades, error mapping, headers, cache keys, hooks, codecs, adapters, commands, docks, inspectors, and viewport layers that consume the resource.
6. Update docs when resource shapes, revision/generation policy, headers, realtime envelopes, or migration policy changes.
7. Add focused tests including stale/degraded/error behavior when the contract can fail.
8. Search for old paths and direct transport before finishing.

Useful checks:

~~~powershell
rg "fetch\(" apps/control-room/src --glob '!kernel/api/**' --glob '!kernel/api/generated/**'
rg "/v1/live/current|/v1/health|/v1/capabilities" apps/control-room/src crates/fullmag-api/src
rg '"/v2/' apps/control-room/src --glob '!kernel/api/**' --glob '!kernel/api/generated/**'
rg "bootstrap|poll|preview" apps/control-room docs/specs
rg "openapi-v2-types|openapi-v2-client|sessionApiPaths|LiveSessionClient|use.*Resource|useField|useTopology" apps/control-room/src
~~~

## Required tests

Choose affected classes only:

- backend route/schema and OpenAPI generation/type-use checks;
- API module and resource hook/cache invalidation tests;
- interceptor request-id, contract-version, retry, and diagnostics tests;
- command completion/rejection tests;
- malformed binary codec tests;
- viewport adapter/render-model tests;
- ribbon command gating and resource consumer tests.

Baseline commands in the current tree:

~~~powershell
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
cargo test -p fullmag-api router_v2 --no-fail-fast
~~~

Run only commands relevant to the changed contract and do not claim a check that was skipped.

## Blockers

Redesign when the change puts heavy payloads in status, makes WebSocket authoritative for full state, adds v2-to-v1 frontend fallback, edits generated clients manually, builds paths in React components, creates an FDM-only/FEM-only app tree, uses preview for published quantity switching, hides fallback, or adds a compatibility bridge without removal criteria.

## Completion report

Report changed resources/commands/events, OpenAPI and generated artifact status, facade/hooks/codecs/adapters, HTTP/WebSocket ownership, unified ribbon/viewport preservation, tests run, and transitional paths remaining.
