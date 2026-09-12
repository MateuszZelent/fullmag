---
name: frontend-v2-api-hygiene
description: "Use when modifying the apps/control-room API facade, OpenAPI generation, resource hooks, realtime invalidation, commands, binary codecs, or module data fetching."
---

# Frontend v2 API Hygiene

Use this with `resource-first-api-check` when a change touches the control-room transport boundary. The user instruction and root `AGENTS.md` take precedence. If the resource-first skill is already loaded, reuse it.

## Required checks

1. Read `docs/specs/frontend-v2/03-api-integration-layer.md` and identify affected resource families, commands, events, scopes, and codecs.
2. Prove that the change uses generated OpenAPI v2 transport plus the handwritten facade/resource-hook layer.
3. Keep HTTP resources authoritative and WebSocket invalidation-only.
4. Keep status thin: ids, capabilities, revisions, summaries, and diagnostics; heavy fields/topology belong to the data plane.
5. Keep modules free of direct transport and endpoint strings.
6. Regenerate API artifacts when backend schema changes.

## Banned patterns

- direct `fetch()` or an HTTP client inside modules/components;
- hand-built `/v2/...` strings outside the API facade/generated transport;
- `/v1/live/current`, bootstrap, poll, or legacy preview as a canonical path;
- resource hooks without revision selectors;
- WebSocket frames carrying full resource snapshots;
- generated client edits by hand.

## Verification

Use the narrowest applicable checks:

```powershell
rg "fetch\\(" apps/control-room/src --glob '!kernel/api/**' --glob '!kernel/api/generated/**'
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src
rg "/v2/" apps/control-room/src --glob '!kernel/api/**' --glob '!kernel/api/generated/**'
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
```

Use `pnpm --dir apps/control-room check:api-hygiene` when the change is covered by that repository gate. If a relevant command is unavailable, record the missing evidence and continue any authorized work; do not invent a passing result or a new mandatory ritual.
