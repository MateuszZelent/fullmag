# MESH-UI-005 — Authoritative mesh invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unieważniać mesh resources wyłącznie authoritative revision/generation z backendu, nie syntetycznym command ID lub timestampem.

**Architecture:** Accepted command oznacza pending, ale nie tworzy nowej mesh identity. Po atomic commit backend emituje mesh invalidation revision; hooks refetchują HTTP v2 snapshot.

**Tech Stack:** Rust orchestrator/API, TypeScript realtime bridge/resource hooks

## Global Constraints

- Websocket invaliduje, HTTP dostarcza snapshot.
- Nie oznaczać poprzedniej mesh generation jako current po accepted build.
- Cache key obejmuje session, resource scope i authoritative revision.

---

**Finding:** MESH-UI-005, P1.
**Dependencies:** MESH-FEM-007, MESH-API-004 i MESH-UI-003.

### Task 1: RED transition tests

- [ ] Dodać test accepted command bez revision: old mesh pozostaje jawnie stale/pending, ale nie dostaje synthetic revision.
- [ ] Dodać commit event z new revision i failure event bez revision; sprawdzić refetch/cache state.

### Task 2: authoritative bridge

```ts
type MeshInvalidation = { resource: "mesh" | "periodic_pairs" | "build_report"; revision: string; generationId: string };
```

- [ ] Backend emituje event dopiero po commit; `RealtimeInvalidationBridge.ts` invaliduje dokładne scoped keys.
- [ ] Usunąć command ID/timestamp jako mesh revision w geometry lifecycle contributions; uruchomić resource tests, PASS.

### Task 3: governance/gates

- [ ] Uaktualnić ADR `0009-geometry-invalidates-mesh.md` i `0011-resource-first-api.md`; uruchomić resource-first, typecheck, lint i tests.
- [ ] Commit: `git add docs/adr/0009-geometry-invalidates-mesh.md docs/adr/0011-resource-first-api.md crates/fullmag-cli crates/fullmag-api apps/control-room && git commit -m "fix(ui): invalidate mesh from authoritative revisions"`.

**Exit:** command identity nigdy nie udaje mesh revision; current/stale/pending przejścia są deterministyczne i testowane.

