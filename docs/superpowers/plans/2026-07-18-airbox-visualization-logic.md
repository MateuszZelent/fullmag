# Airbox Visualization Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Airbox visualization controls use one predictable state model across the Inspector, ribbon, resource state, and viewport.

**Architecture:** Keep HTTP v2 visualization state canonical and add a small pure target-capability seam in the existing visualization controller layer. Inspector and ribbon consume the same allowed Airbox modes while the viewport retains backward-compatible rendering of explicitly persisted surfaces.

**Tech Stack:** React 19, TypeScript, Vitest, Rust/Axum OpenAPI v2 schemas, existing Fullmag visualization resource and command registry.

## Global Constraints

- Do not change the OpenAPI schema or generated transport shape.
- Preserve existing persisted Airbox surface playback in the renderer.
- Do not add component transport, stores, contexts, or endpoint strings.
- Preserve unrelated dirty-worktree changes.
- Add behavior tests before production edits.

---

### Task 1: Lock the canonical Airbox state

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Modify: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`

- [x] Change tests to require hidden Airbox, configured Wireframe, Surface off.
- [x] Add a test requiring `visible=true` to preserve configured passes.
- [x] Run focused tests and confirm the new assertions fail.
- [x] Align frontend fallback, reset, backend layer, and registry defaults.
- [x] Remove automatic Surface activation and make focused tests pass.

### Task 2: Establish target-specific UI capabilities

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`

- [x] Add failing tests for Airbox primary modes `wireframe|points` and for normal object surface modes.
- [x] Add a pure capability resolver in the kernel visualization layer.
- [x] Keep `off` as a UI state derived from all geometry passes being false.
- [x] Verify focused controller/model tests.

### Task 3: Repair the Inspector composition

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.accessibility.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`
- Modify: `apps/control-room/src/design/styles/inspector-visualization.css`

- [x] Add failing rendered assertions for Visible, one geometry selector, Airbox modes, and one extent control.
- [x] Replace duplicate Surface/Wireframe toggles with Visible and Vectors controls.
- [x] Filter geometry modes by target capability and include Off.
- [x] Remove duplicate vector extent and synthetic-vector developer control.
- [x] Correct effective pass count and vector data-state summaries.
- [x] Verify focused Inspector tests.

### Task 4: Align the ribbon command surface

**Files:**
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`

- [x] Add failing tests for one Airbox geometry radio group and one extent group.
- [x] Replace independent Surface/Wireframe/Points controls with the shared Airbox geometry modes.
- [x] Keep Visible, Vectors, vector style, opacity, and the existing command registry path.
- [x] Verify ribbon tests.

### Task 5: Verify the complete behavior

**Files:**
- Verify only.

- [x] Run focused visualization, Inspector, ribbon, and Airbox renderer tests.
- [x] Run `pnpm --dir apps/control-room typecheck`.
- [x] Run `pnpm --dir apps/control-room lint`.
- [x] Run React Doctor and record the changed-scope score.
- [x] Run the Inspector and viewport browser smoke checks.
- [x] Confirm no OpenAPI/generated transport files changed as part of this correction.
