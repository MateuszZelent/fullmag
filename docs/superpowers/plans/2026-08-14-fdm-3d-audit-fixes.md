# FDM 3D Audit Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Usunąć potwierdzone błędy próbkowania, inspekcji wielu targetów i single-grid Airbox wireframe bez zmiany kanonicznych targetów wizualizacji.

**Architecture:** Próbkowanie dostaje deterministyczną pulę zastępowalnych indeksów. Inspekcja uzyskuje jednego właściciela końcowego wyniku zdarzenia na poziomie sceny zamiast niezależnych clearów warstw. Single-grid Airbox używa istniejącego proceduralnego `BoundsVolumeWireframe`, zachowując oddzielne opacity bounds i wireframe.

**Tech Stack:** TypeScript, React 19, React Three Fiber, Three.js, Vitest.

## Global Constraints

- Nie zmieniać `AIRBOX_VISUALIZATION_TARGET` ani routingu publicznego Airboxa.
- Nie usuwać deduplikujących `boundsVisible: false` i `shaderVisible: false` z pomocniczego nośnika.
- Zachować demand-driven rendering i jawny cleanup listenerów/RAF/zasobów GPU.
- Każda zmiana zachowania zaczyna się od testu, który zawodzi z właściwej przyczyny.

---

### Task 1: Liniowe próbkowanie minimum membership

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.test.ts`

**Interfaces:**
- Consumes: `sampleFdmDisplayCellIndicesWithMinimumMembership(...)`.
- Produces: ten sam deterministyczny `Uint32Array`, bez kopiowania całego `Set` dla każdej komórki.

- [ ] Dodać test dużego, wypełnionego budżetu z aktywnymi komórkami po końcu próbki.
- [ ] Uruchomić test i potwierdzić awarię przez limit liczby skanowanych kandydatów lub timeout regresyjny.
- [ ] Zastąpić wyszukiwanie pulą deterministycznych kandydatów do wymiany.
- [ ] Uruchomić cały `fdmCuboidBuildModel.test.ts`.

### Task 2: Jeden końcowy wynik inspekcji

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`
- Modify/Create focused helper beside the layer only if it makes arbitration independently testable.
- Test: focused viewport inspection test under `apps/control-room/src/modules/viewport-3d/layers/`.

**Interfaces:**
- Consumes: warstwowe kandydaty `sample`/`clear` dla jednego pointer frame.
- Produces: dokładnie jedno końcowe `sample` dla najbliższego hitu albo jedno `clear`, nigdy clear po trafieniu.

- [ ] Dodać test dwóch targetów, w którym hit jednego i miss drugiego nie kończy się clear.
- [ ] Potwierdzić RED.
- [ ] Wprowadzić scene/canvas-scoped arbitration z cleanupem po unmount.
- [ ] Potwierdzić GREEN oraz brak dodatkowego idle RAF.

### Task 3: Pełny wireframe single-grid Airboxa

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Test: odpowiedni test `BoundsLayers`/source-contract.

**Interfaces:**
- Consumes: `FdmUniverseOutsideSupportOverlayModel`, `VisualizationTargetSettings`, tracker.
- Produces: `BoundsBox` dla bounds oraz `BoundsVolumeWireframe` dla pełnego Airbox wireframe; magnetic-support outline pozostaje osobnym overlayem tylko jeśli wymaga go model.

- [ ] Dodać failing test wymagający `BoundsVolumeWireframe` i trackera.
- [ ] Potwierdzić RED.
- [ ] Zastosować istniejący komponent proceduralnego volume wireframe.
- [ ] Potwierdzić GREEN i poprawne oddzielenie opacity.

### Task 4: Bezpieczna stabilizacja propsów

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Test: istniejące testy sceny/render planu.

**Interfaces:**
- Produces: stałą pustą tablicę region overlays; callbacki stabilizować wyłącznie bez tworzenia cache o nieograniczonym wzroście.

- [ ] Dodać test/source assertion dla stałej pustej kolekcji, jeśli istniejący harness nie mierzy render count.
- [ ] Zamienić literały `[]` na stabilną stałą.
- [ ] Nie zmieniać callbacków bez testu wykazującego istotny churn.

### Task 5: Weryfikacja i dokumentacja

**Files:**
- Modify: `docs/audits/2026-08-14-fdm-3d-visualization-shaders-wireframe-airbox-inspectors-audit.md`

- [ ] Uruchomić focused Vitest, typecheck i `git diff --check`.
- [ ] Uruchomić browser smoke: canvas widoczny, WebGL healthy, wireframe on/off oraz vectors on przy wireframe off.
- [ ] Zaktualizować tabelę audytu o commit/worktree state i rzeczywiste dowody; brak browser proof oznaczyć jako niezakwalifikowany.
