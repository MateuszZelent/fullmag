---
name: frontend-v2-api-hygiene
description: Use when modifying frontend v2 API facade, OpenAPI generation, resource hooks, realtime invalidation, commands, binary codecs, or module data fetching.
---

# Frontend v2 API Hygiene

Use this with `resource-first-api-check` for `apps/control-room`.

## Required Checks

1. Read `docs/specs/frontend-v2/03-api-integration-layer.md`.
2. Identify affected v2 resource families, commands, events, and codecs.
3. Prove the change uses generated OpenAPI v2 transport plus handwritten facade/resource hooks.
4. Keep HTTP resources authoritative and WebSocket invalidation-only.
5. Keep status thin: ids, capabilities, revisions, summaries, diagnostics; no heavy fields/topology.
6. Keep modules free of direct transport and endpoint strings.
7. Regenerate API artifacts when backend schema changes.

## Banned Patterns

- `fetch()` or HTTP clients inside modules/components;
- hand-built `/v2/...` strings outside API facade/generated transport;
- `/v1/live/current`, `bootstrap`, `poll`, or legacy preview as a canonical path;
- resource hooks without revision selectors;
- WebSocket frames carrying full resource snapshots;
- generated client edits by hand.

## Verification

```bash
rg "fetch\\(" apps/control-room/src
rg "/v1/live/current|bootstrap|poll|preview" apps/control-room/src
rg "/v2/" apps/control-room/src --glob '!src/kernel/api/**' --glob '!src/kernel/api/generated/**'
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
```

If commands cannot run yet, state that and add the missing gate to the implementation plan.
