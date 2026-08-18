# Airbox Vector Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przywrócić produkcyjnie bezpieczny domyślny rozmiar strzałek FDM Airbox oraz sprawić, aby szybkie kroki suwaka `Arrow length` w Inspectorze nie uruchamiały osobnej przebudowy glyphów dla każdej klawiszowej zmiany.

**Architecture:** Renderer zachowa adaptacyjne wyznaczanie długości zależne od domeny, liczby glyphów i zakresu, ale builder FDM ponownie zastosuje końcowy limit zależny od zrealizowanego rozmiaru komórki. `NumberField` zachowa lokalny draft podczas interakcji i scali commit-y z jednej klatki animacji do ostatniej wartości, bez opóźnień timerowych i bez zmiany ścieżki `Inspector → Visualization`.

**Tech Stack:** React 19, Radix Slider, Three.js/R3F, Vitest, TypeScript, Next.js 16.

## Global Constraints

- Nie zmieniać wartości domyślnych `vectorLengthScale: 1` ani `vectorBudget: 1200`.
- Sterowanie widocznością i rozmiarem wektorów pozostaje w `Airbox → Visualization` w Inspectorze.
- Nie przywracać ribbonu jako źródła stanu i nie wprowadzać drugiego store'a wizualizacji.
- Zachować rozdział topology/field/style: zmiana długości nie może zmieniać rewizji topologii ani pobierać pola ponownie.
- Zachować niezwiązane zmiany istniejącego dirty worktree.
- Kod i nazwy pozostają po angielsku; plan i raport są po polsku.

---

### Task 1: Regression tests for the two observed failures

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`

**Interfaces:**
- The builder test calls `buildViewport3DFdmCuboid` with a one-cell field and an intentionally oversized request scale.
- The Inspector test renders `NumberField`, controls a fake `requestAnimationFrame`, and asserts that three commit events call `onChange` once with the last value.

- [ ] **Step 1: Write the failing builder test**

Add a test with domain shape `[1, 1, 1]`, spacing `[2, 1, 1]`, one `[1, 0, 0]` vector, `maxVectorGlyphs: 1`, and `vectorScale: 100`. Assert that the generated segment length is at most `1.5` (`0.75 × 2`, plus a floating-point tolerance).

- [ ] **Step 2: Run the builder test and verify the expected failure**

Run from `apps/control-room`:

```bash
./node_modules/.bin/vitest run --pool=forks --no-file-parallelism --maxWorkers=1 src/modules/viewport-3d/layers/fdmCuboidBuildModel.test.ts -t "caps built vector segment length"
```

Expected result before the production fix: the assertion fails because the generated segment still has length `100`.

- [ ] **Step 3: Write the failing NumberField coalescing test**

Render `NumberField` in a DOM root with a fake `requestAnimationFrame`; dispatch three commit events through the Radix slider interaction path and assert that no `onChange` call occurs before the queued frame, then exactly one call occurs with the final value after the frame callback.

- [ ] **Step 4: Run the NumberField test and verify the expected failure**

Run:

```bash
./node_modules/.bin/vitest run --pool=forks --no-file-parallelism --maxWorkers=1 src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx -t "coalesces rapid numeric commits"
```

Expected result before the production fix: each commit event calls `onChange`, so the test observes three calls instead of one.

### Task 2: Restore production glyph safety at the builder boundary

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts`

**Interfaces:**
- `buildViewport3DFdmCuboid` continues receiving the adaptive `request.vectorScale` from the scene model.
- `resolveFdmVectorGlyphScale` becomes the final safety boundary before `buildFdmVectorSegmentsUncached`.

- [ ] **Step 1: Apply the minimal implementation**

Change the builder call from the raw scale:

```ts
request.vectorScale,
```

to:

```ts
resolveFdmVectorGlyphScale(
  model,
  request.vectorScale,
  request.maxVectorGlyphs,
),
```

Keep the cap no larger than `0.75 × max(model.cellSize)` for the production FDM contract. Do not alter the Airbox default setting or the field payload budget.

- [ ] **Step 2: Run builder tests**

Run the focused builder tests again and then the full FDM layer/model tests. Expected result: the new integration assertion and existing helper-cap assertions pass.

### Task 3: Coalesce Inspector NumberField commit events

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`

**Interfaces:**
- `NumberField` still exposes `onValueChange` for local draft display and `onChange` for committed values.
- The committed callback is scheduled through one `requestAnimationFrame`; subsequent commit events before that frame replace the pending value.

- [ ] **Step 1: Implement frame coalescing and cleanup**

Add refs for the pending value and frame handle, keep the latest `onChange` in a ref, schedule only one frame from `onValueCommit`, and cancel the pending frame on unmount. Use a microtask fallback only when `requestAnimationFrame` is unavailable; do not add `setTimeout` or an interval.

- [ ] **Step 2: Run the NumberField interaction test**

Expected result: the test observes one commit for the last slider value and cleanup cancels a pending frame on unmount.

- [ ] **Step 3: Verify the existing Inspector performance contracts**

Run:

```bash
./node_modules/.bin/vitest run --pool=forks --no-file-parallelism --maxWorkers=1 src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts
```

Expected result: all existing draft, accessibility, and no-timer contracts remain green.

### Task 4: Cross-layer verification

**Files:**
- Inspect only: changed files and their tests.

- [ ] **Step 1: Run targeted viewport and Inspector tests**

Run the builder, vector glyph, scene-model, Inspector accessibility, Inspector performance, and visualization-controller tests using the application root and one worker.

- [ ] **Step 2: Run typecheck and lint**

Run:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

Expected result: exit code `0` with no TypeScript or ESLint errors.

- [ ] **Step 3: Run React Doctor on changed files**

Run:

```bash
npx react-doctor@latest --verbose --scope changed apps/control-room
```

Expected result: no score regression caused by this patch.

- [ ] **Step 4: Reproduce through the browser Inspector**

Select `Airbox → Visualization`, enable vectors with the Inspector control, record the default length, press `ArrowRight` ten times, and verify bounded UI response, a single final committed value, no context loss, non-zero drawing buffer, and no runaway glyph-cache/build count. Restore `Arrow length` to `1.0×` and disable vectors through the same Inspector node.

- [ ] **Step 5: Review the diff and report evidence**

Confirm that only the plan, regression tests, builder safety boundary, and NumberField coalescing code changed. Report exact command results and any environmental gate that remains unavailable; do not claim a passing gate without its exit code.
