# MESH-REGION-017 — Shape-specific Region Inspector fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `subagent-driven-development` (recommended) or `executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Inspector pokazuje i serializuje wyłącznie parametry mające znaczenie dla wybranego shape regionu.

**Architecture:** Model panelu tworzy typed field list z discriminated union shape. React renderuje wspólne pola oraz parametry Box/Sphere/Cylinder bez ukrytych stale values wpływających na eksport.

**Tech Stack:** React/TypeScript, Inspector model tests

## Global Constraints

- Box nie pokazuje radius/axis; Sphere nie pokazuje size/axis; Cylinder pokazuje radius/height/axis.
- Zmiana shape inicjalizuje canonical defaults i usuwa nielegalne draft fields.
- SSR first client render pozostaje stabilny.

---

**Finding:** MESH-REGION-017, P2.

### Task 1: RED render matrix

- [x] Dodano test źródłowy Inspector dla macierzy widoczności Box/Sphere/Cylinder oraz test modelu, że canonical Box patch nie zawiera `radius`, `height` ani `axis`.
- [ ] Uruchomienie RED przed zmianą było zablokowane brakiem zależności w worktree; źródłowa unconditional gałąź `box || cylinder || sphere` została potwierdzona inspekcją.

### Task 2: discriminated model

```ts
type RegionShapeDraft =
  | { kind: "box"; size: [number, number, number] }
  | { kind: "sphere"; radius: number }
  | { kind: "cylinder"; radius: number; height: number; axis: [number, number, number] };
```

- [x] `ObjectRegionGeometryPanel` renderuje Radius wyłącznie dla `cylinder` i `sphere`; Box zachowuje wyłącznie Size X/Y/Z.
- [x] `buildObjectRegionPatch` pozostaje discriminated po `kind`, więc nielegalne pola nie trafiają do canonical API payload.

### Task 3: frontend gates

- [x] Focused Vitest: `ObjectRegionsPanel.test.ts` + `ObjectRegionsPanelModel.test.ts` — 22 passed.
- [ ] Pełny typecheck/lint pozostaje zależny od lokalnych `apps/control-room/node_modules`; bez nich Next/ESLint nie mogą rozwiązać zależności.
- [x] Commit: `aa9356f1 fix(ui): render region fields by shape`.

## Evidence update (2026-07-14)

- [x] UI nie pokazuje już Radius dla Box.
- [x] Canonical payload test potwierdza, że Box serializuje wyłącznie `center`, `kind` i `size`.
- [ ] Browser smoke i pełne frontend gates pozostają częścią globalnego MESH-GATE-001.

**Exit:** Inspector i eksport nie przedstawiają parametrów bez znaczenia dla aktualnego shape.
