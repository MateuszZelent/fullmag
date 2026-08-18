# Visualization Inspector Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć przygaszanie, mruganie, zbędne remounty i nadmiarowe rendery ze wszystkich Inspectorów wizualizacji obiektu i Airboxa zgodnie z sekcją 15 audytu.

**Architecture:** Stan serwerowy pozostaje w `useVisualizationStateResource`, lecz panel ma jednego ownera tego zasobu. Optimistic mutation state jest selekcjonowany per target i per pole; renderowane drzewo zachowuje last-good snapshot dla tej samej tożsamości targetu. Inspector nie używa animacji opacity do sygnalizowania aktualizacji danych.

**Tech Stack:** React 19, TypeScript, `useSyncExternalStore`, Vitest, Playwright, centralny v2 resource runtime.

## Global Constraints

- Zachować jeden wspólny Inspector dla FDM/FEM oraz odrębne kanoniczne targety Object i Airbox.
- Nie kopiować zasobów serwerowych do store modułu.
- Nie ukrywać problemu przez wyższe disabled opacity, dłuższy debounce ani niższą jakość.
- Każda zmiana zachowania przechodzi RED → GREEN.
- Zachować niezwiązane zmiany w dirty worktree.

---

### Task 1: Field-scoped mutation state

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Test: `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.test.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

- [ ] Dodać failing test: mutacja `surfaceColorSource` nie oznacza vectors/wireframe/points jako pending.
- [ ] Uruchomić focused Vitest i potwierdzić oczekiwany RED.
- [ ] Wprowadzić field-scoped mutation descriptor i przekazywać `isFieldPending(field)` zamiast globalnego `pending`.
- [ ] Zachować target-wide status tylko dla komunikatu synchronizacji/reset/retry.
- [ ] Uruchomić focused Vitest i potwierdzić GREEN.

### Task 2: Stable visual lifecycle

**Files:**
- Modify: `apps/control-room/src/design/styles/inspector-visualization.css`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`

- [ ] Dodać failing test zabraniający animacji opacity na overview, dynamicznych sekcjach i accounting rows.
- [ ] Potwierdzić RED.
- [ ] Usunąć `fm-rise`, `fm-fade-in` i opacity z aktualizacji sekcji; pozostawić tylko akcję jawnego otwarcia bez fade.
- [ ] Zachować jeden root panelu podczas refetch tej samej target identity.
- [ ] Potwierdzić GREEN.

### Task 3: Scoped subscriptions and one resource owner

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/VisualizationRegistrySyncController.ts`
- Modify: `apps/control-room/src/kernel/visualization/useVisualizationStateResource.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`
- Test: `apps/control-room/src/kernel/visualization/useVisualizationStateResource.test.tsx`

- [ ] Dodać failing test: zmiana targetu B nie publikuje nowego selected snapshotu dla targetu A.
- [ ] Dodać failing test: jeden panel ma jednego ownera `visualization/state`.
- [ ] Potwierdzić RED.
- [ ] Dodać target-scoped selector mutation status i usunąć drugi `useVisualizationStateResource()` z wrappera.
- [ ] Przekazać dane Planar z pierwszego ownera zasobu.
- [ ] Potwierdzić GREEN.

### Task 4: Stable baseline and derived model

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

- [ ] Dodać failing test dla stabilnego fingerprintu baseline i braku pracy przy samej zmianie mutation status.
- [ ] Potwierdzić RED.
- [ ] Przenieść target-scoped baseline i fingerprint do czystego memoizowanego modelu.
- [ ] Usunąć render-time `structuredClone` i dwa `JSON.stringify`.
- [ ] Potwierdzić GREEN.

### Task 5: Browser regression for Object and Airbox

**Files:**
- Modify: `apps/control-room/scripts/smoke-inspector.mjs`

- [ ] Dodać pomiar dla 20 zmian ustawień każdego targetu: root identity/remount count, scroll, focus, computed opacity, `getAnimations()`, disabled controls, request count i render-profiler count.
- [ ] Uruchomić smoke przed końcową kwalifikacją; naprawić każdą wykrytą regresję w odpowiadającym Task 1–4 kontrakcie.
- [ ] Potwierdzić osobny PASS dla Object i Airbox.

### Task 6: Final verification and audit update

**Files:**
- Modify: `docs/audits/2026-08-17-viewport-3d-orbit-dimming-lifecycle-performance-audit.md`

- [ ] Uruchomić focused i pełne testy Inspectora/resource hooks.
- [ ] Uruchomić typecheck, lint, `audit:idle-performance`, React Doctor i `git diff --check`.
- [ ] Zapisać w audycie dokładne wyniki, braki i browserowe metryki Object/Airbox.
