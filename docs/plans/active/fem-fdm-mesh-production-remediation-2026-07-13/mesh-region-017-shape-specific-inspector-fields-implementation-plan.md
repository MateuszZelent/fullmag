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

- [ ] Dodać model/render tests dla Box, Sphere i Cylinder oraz przełączeń Box -> Sphere -> Cylinder; sprawdzić widoczność, draft payload i canonical export.
- [ ] Potwierdzić RED: Box renderuje obecnie Radius.

### Task 2: discriminated model

```ts
type RegionShapeDraft =
  | { kind: "box"; size: [number, number, number] }
  | { kind: "sphere"; radius: number }
  | { kind: "cylinder"; radius: number; height: number; axis: [number, number, number] };
```

- [ ] Zbudować field list z `kind`; usunąć unconditional Radius row i walidować wyłącznie aktywny wariant.
- [ ] Przy zmianie kind utworzyć canonical draft nowego wariantu bez przenoszenia nielegalnych wartości starego shape.

### Task 3: frontend gates

- [ ] Uruchomić focused Inspector tests, typecheck, zero-warning lint i pełny Vitest.
- [ ] Commit: `git add apps/control-room/src/modules/inspector/panels/region && git commit -m "fix(ui): render region fields by shape"`.

**Exit:** Inspector i eksport nie przedstawiają parametrów bez znaczenia dla aktualnego shape.
