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

- [x] Dodano matrix test: scena z `mesh:dirty` unieważnia current mesh, membership i region quality, ale zachowuje `latest_successful`; czysta scena nie unieważnia zasobów meshu.
- [ ] Dodać realtime tests dla scene commit, mesh build success/failure i historical mesh scope.

### Task 2: shared resource mapping

```ts
type RegionInvalidationHint = { objectId: string; regionId: string; resource: "membership" | "quality" | "marker-certificate" | "mesh"; revision: string };
```

- [x] Wspólny typed resource-key builder `regionMeshInvalidationKeys` jest używany przez lokalny mutation path; mapuje current mesh, object topology/report/quality, region quality oraz FDM/FEM membership.
- [x] `latest_successful` nie jest unieważniany, a dirty scene pozostaje rozróżnialna od historycznego artefaktu.
- [ ] Hooks refetchują po revision, nie po command ID ani timestampie.

### Task 3: frontend gates

- [x] Focused resource/realtime/region tests — 64 passed; Control Room typecheck — PASS; targeted ESLint — PASS.
- [ ] Pełny Vitest ma niezależny environment blocker (`spawnSync /usr/local/bin/node EPERM`) w compute-performance audit.
- [ ] Commit: `git add apps/control-room && git commit -m "fix(ui): invalidate region resources by revision"`.

## Evidence update (2026-07-14)

- [x] Lokalny authoring path publikuje authoritative scene revision i unieważnia tylko zasoby bieżącej realizacji oznaczonej `mesh:dirty`.
- [ ] Backend realtime hints, material-only classifier oraz browser proof pozostają otwarte; MESH-REGION-013 nie jest jeszcze produkcyjnie zamknięty.

**Exit:** UI nie może utrzymać cached membership/quality z innej definicji regionu lub mesh generation jako current.
