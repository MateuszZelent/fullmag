# MESH-REGION-013 — Region resource invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Region mutation i mesh commit invalidują dokładnie membership, quality, marker certificate i zależne viewport resources.

**Architecture:** Backend emituje revision-bearing invalidation hints wynikające z MESH-REGION-011. Realtime bridge mapuje je na centralne resource keys; lokalny mutation path używa tej samej mapy, a refetch zawsze pobiera authoritative HTTP snapshot.

**Tech Stack:** Rust API events, TypeScript resource hooks/Zustand/realtime

## Global Constraints

- Websocket payload nie zastępuje danych zasobu.
- Cache keys obejmują session, object/region scope i właściwą revision.
- Brak invalidation wszystkich mesh resources dla metadata-only edit.

---

**Finding:** MESH-REGION-013, P1.
**Dependencies:** MESH-REGION-011/012.

### Task 1: RED invalidation matrix

- [ ] Odwrócić oczekiwania w `regionAuthoringInvalidation.test.ts`: shape/policy invaliduje membership, quality i current mesh; material edit invaliduje coefficients/membership zgodnie z classifierem; rename nie invaliduje topologii.
- [ ] Dodać realtime tests dla scene commit, mesh build success/failure i historical mesh scope.

### Task 2: shared resource mapping

```ts
type RegionInvalidationHint = { objectId: string; regionId: string; resource: "membership" | "quality" | "marker-certificate" | "mesh"; revision: string };
```

- [ ] Rozszerzyć backend event hints i centralny typed resource-key builder; usunąć ręczne, niepełne listy z panelu.
- [ ] Mesh commit invaliduje membership/quality dla nowej generation, failure pozostawia old historical cache i oznacza current request stale.
- [ ] Hooks refetchują po revision, nie po command ID ani timestampie.

### Task 3: frontend gates

- [ ] Uruchomić focused resource/realtime/region tests, `pnpm --dir apps/control-room typecheck`, lint i pełny Vitest.
- [ ] Commit: `git add crates/fullmag-api apps/control-room && git commit -m "fix(ui): invalidate region resources by revision"`.

**Exit:** UI nie może utrzymać cached membership/quality z innej definicji regionu lub mesh generation jako current.
