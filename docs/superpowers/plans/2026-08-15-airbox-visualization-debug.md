# Airbox Visualization Debug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Przywrócić działające tryby Wireframe i Points dla kanonicznego Airbox oraz zapewnić, że `compute_fields` publikuje pełnodomenowe `H_demag` dostępne przez API.

**Architecture:** Kanoniczny target `airbox` pozostaje jedynym właścicielem ustawień prezentacji, a `fdm-universe-outside-support` jest wyłącznie carrierem renderera i scope danych. Jawna materializacja pól używa pełnej domeny niezależnie od interaktywnego limitu podglądu, dzięki czemu field store i API otrzymują wartości zgodne z bieżącą domeną.

**Tech Stack:** React 19, TypeScript, Three.js/R3F, Vitest, Rust, Fullmag v2 resource API.

## Global Constraints

- Nie zmieniać OpenAPI ani publicznych typów zasobów.
- Nie syntetyzować `H_demag` w frontendzie i nie podstawiać `m`.
- Wireframe i Points muszą działać bez dostępnego pola; Vectors pozostaje fail-closed bez zgodnego `H_demag`.
- Zachować pełną jakość renderowania i istniejące limity interaktywne.
- Nie dotykać zmian w `.impl-racetrack` ani `external_solvers/3`.

---

### Task 1: Kanoniczny stan renderowania Airbox

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

**Interfaces:**
- Consumes: `airboxSettings: VisualizationTargetSettings`, `fdmAirboxPassPlan: FdmAirboxPassPlan`.
- Produces: renderer extent i inactive-cell geometry sterowane tym samym targetem `airbox`; debug target `airbox` przypisany do carriera `fdm-universe-outside-support`.

- [ ] **Step 1: Write the failing tests**

```ts
expect(sceneSource).toContain("settings={airboxSettings}");
expect(sceneSource).not.toContain("settings={fdmUniverseOutsideSupportSettings}");
expect(targetsBlock).toContain('carrierIds.add("fdm-universe-outside-support")');
expect(targetsBlock).toMatch(/AIRBOX_VISUALIZATION_TARGET\.id[\s\S]*fdmAirboxDebugRenderPass/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

Expected: FAIL, ponieważ extent overlay czyta ustawienia legacy carriera, a kanoniczny target nie ma przypisanego carriera/debug passu.

- [ ] **Step 3: Implement the minimal renderer fix**

Przekazać `airboxSettings` do `FdmUniverseOutsideSupportLayer`, usunąć nieużywany prop `fdmUniverseOutsideSupportSettings` z modelu/sceny oraz dla single-grid FDM przypisać kanonicznemu targetowi carrier `fdm-universe-outside-support` i `fdmAirboxDebugRenderPass`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

Expected: PASS.

### Task 2: Pełnodomenowa materializacja `compute_fields`

**Files:**
- Modify: `crates/fullmag-cli/src/live_workspace.rs`
- Modify: `crates/fullmag-cli/src/interactive_runtime_host.rs`
- Modify: `crates/fullmag-cli/src/orchestrator.rs`
- Test: `crates/fullmag-cli/src/live_workspace.rs`
- Test: `crates/fullmag-cli/src/interactive_runtime_host.rs`
- Test: `crates/fullmag-cli/src/orchestrator.rs`

**Interfaces:**
- Consumes: `fullmag_runner::LivePreviewRequest` i `field_materialization_quantity_ids()`.
- Produces: `full_field_materialization_request(request) -> LivePreviewRequest`, zachowujące rewizję i quantity, ale ustawiające `component="3D"`, `all_layers=true`, `x_chosen_size=0`, `y_chosen_size=0`, `auto_scale_enabled=false`, `max_points=0`.

- [ ] **Step 1: Write the failing tests**

```rust
let request = full_field_materialization_request(LivePreviewRequest::default());
assert!(request.all_layers);
assert!(!request.auto_scale_enabled);
assert_eq!(request.max_points, 0);
assert_eq!(request.x_chosen_size, 0);
assert_eq!(request.y_chosen_size, 0);
```

Testy strukturalne obu ścieżek komendy mają dodatkowo wymagać wywołania `full_field_materialization_request` przed `snapshot_vector_fields` lub `snapshot_problem_vector_field_batch`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/airbox-visualization-debug cargo test -p fullmag-cli full_field_materialization_request -- --nocapture`

Expected: FAIL, helper nie istnieje.

- [ ] **Step 3: Implement the minimal materialization fix**

Wspólny helper tworzy request pełnodomenowy. Użyć go w `InteractiveRuntimeHost::compute_current_fields` oraz `refresh_problem_preview_state`; zwykłe display preview nadal zachowuje interaktywny limit.

- [ ] **Step 4: Run tests to verify they pass**

Run: `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/airbox-visualization-debug cargo test -p fullmag-cli full_field_materialization_request -- --nocapture`

Expected: PASS.

### Task 3: Weryfikacja kontraktu i runtime

**Files:**
- Verify only: frontend i Rust files from Tasks 1-2.

**Interfaces:**
- Consumes: poprawiony renderer i pełnodomenowy field cache.
- Produces: dowód testowy, typowy i przeglądarkowy bez utraty kontekstu WebGL.

- [ ] **Step 1: Run focused frontend verification**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/Viewport3DScene.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts src/modules/viewport-3d/layers/fdmAirboxPassPlan.test.ts`

Expected: PASS.

- [ ] **Step 2: Run typecheck**

Run: `pnpm --dir apps/control-room typecheck`

Expected: exit 0.

- [ ] **Step 3: Run focused Rust verification**

Run: `CARGO_INCREMENTAL=0 CARGO_TARGET_DIR=/tmp/fullmag-zfn2-build/cargo-targets/airbox-visualization-debug cargo test -p fullmag-cli compute_fields -- --nocapture`

Expected: PASS.

- [ ] **Step 4: Verify the live v2 resources and WebGL sequence**

Na świeżo uruchomionym runtime potwierdzić: katalog zawiera `H_demag`; scoped meta/vector dla `scope_kind=airbox&scope_id=airbox` zwracają 200; `wireframe on -> wireframe off -> points on -> vectors on` commitują osobne klatki; canvas jest widoczny, `gl.isContextLost() === false`, drawing buffer jest niezerowy, a frame Vectors ma niezerową liczbę glyphów.

- [ ] **Step 5: Review the final diff**

Run: `git diff --check` oraz `git status --short`.

Expected: tylko pliki planu, Airbox renderera/debug i materializacji pól; istniejące zmiany submodułów pozostają nietknięte.
