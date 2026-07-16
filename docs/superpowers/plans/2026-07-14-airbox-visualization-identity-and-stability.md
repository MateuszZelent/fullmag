# Airbox Visualization Identity and Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose one canonical Airbox visualization target and make its histogram, vector rendering, event flow, and connection dialog stable.

**Architecture:** Canonicalize identity at the v2 resource boundary, retain mesh-part ids only as data-plane carriers, and add a defensive frontend selection mapping. Keep field requests resource-first and make hover state value-stable at both producer and consumer boundaries.

**Tech Stack:** Rust/Axum/Serde, React 19, TypeScript, Vitest, React Testing Library, Recharts, Three.js/R3F.

## Global Constraints

- `airbox` is the sole user-facing Airbox visualization target.
- `part:__air__` remains a mesh/data carrier and is not renamed.
- No component-level `fetch()` and no hand-written v2 endpoint strings outside the API facade.
- Preserve current visualization quality and use dirty-driven rendering.
- Write and observe each regression test failing before production edits.
- Do not modify unrelated dirty-worktree files.

---

### Task 1: Canonical backend target registry

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: `SceneDocument.objects`, `FemMeshPayload.mesh_parts`, `VisualizationOverrideState`.
- Produces: `build_visualization_target_registry(...)` with one Airbox, authored objects excluding `__air__`, and only orphan mesh-part fallbacks.

- [ ] Add a router test whose snapshot contains `__air__`, an air-role `part:__air__`, an object-owned magnetic part, and an orphan interface part. Assert exactly one Airbox, no synthetic object, no air part, no owned-part duplicate, and one orphan fallback.
- [ ] Run the focused Rust test and confirm it fails because the registry currently copies every object and part.
- [ ] Add small predicates for synthetic Airbox objects, Airbox carriers, and mesh parts that resolve to scene objects; filter registry construction with them.
- [ ] Re-run the focused Rust test and confirm it passes.

### Task 2: Legacy Airbox override normalization

**Files:**
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Produces: `canonicalize_visualization_overrides(...) -> Vec<VisualizationOverrideState>` used by resource projection and accepted replacement patches.

- [ ] Add tests for canonical-over-legacy precedence and fallback migration from `object/__air__` and `part/part:__air__`.
- [ ] Run them and confirm legacy entries remain visible before the fix.
- [ ] Implement deterministic normalization without changing the OpenAPI schema.
- [ ] Re-run the tests and confirm one canonical override is returned.

### Task 3: Defensive frontend Airbox selection

**Files:**
- Modify: `apps/control-room/src/kernel/selection/visualizationTargetResolver.ts`
- Test: `apps/control-room/src/kernel/selection/visualizationTargetResolver.test.ts`

**Interfaces:**
- Produces: `resolveVisualizationTargetForMeshPart(...)` returning `AIRBOX_VISUALIZATION_TARGET` for roles `air` and `airbox` before consulting registry parts.

- [ ] Add a failing test with an incorrectly published `part:__air__` registry entry and assert `{kind: "airbox", id: "airbox"}`.
- [ ] Implement the role-first canonical mapping.
- [ ] Re-run the focused test.

### Task 4: Correct histogram carrier identity and stable hover events

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/meshSizeHistogramHover.ts`
- Modify: Airbox histogram caller under `apps/control-room/src/modules/inspector/panels/`
- Modify: `apps/control-room/src/modules/inspector/panels/MeshQualityChart.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/meshSizeHistogramHover.test.ts`
- Test: focused chart/viewport tests beside the modified sources.

**Interfaces:**
- `emitMeshSizeHistogramHover({bin, kernel, scope, airboxPartId})` uses the real manifest carrier.
- Hover comparison is based on semantic fields, not object identity.

- [ ] Add a failing test asserting `partId: "part:__air__"` for an Airbox hover.
- [ ] Add a failing test asserting repeated identical tooltip/viewport events preserve state and do not notify twice.
- [ ] Thread the manifest carrier id into the histogram callback.
- [ ] Remove unstable `payload` identity from the tooltip effect trigger by deriving a primitive bin index/key.
- [ ] Add structural equality in the viewport subscriber and preserve the previous state object for duplicates.
- [ ] Re-run focused tests.

### Task 5: Prove canonical Airbox vector rendering

**Files:**
- Modify only if the regression exposes a remaining defect: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.ts`, `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`, or `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDataPlan.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`

**Interfaces:**
- Canonical target settings enable `scope_kind=airbox` requests whose `scope_id` is the carrier part id.
- Explicit or sampled FMVP node indices generate glyph segments on Airbox topology.

- [ ] Add an end-to-end model regression from enabled canonical settings through request planning and decoded scoped field data to nonempty vector segments.
- [ ] Run it and identify whether identity repair alone passes or a lower render-path defect remains.
- [ ] If it fails below identity resolution, make the minimum correction in request/buffer/index mapping.
- [ ] Re-run all Airbox field and render-model tests.

### Task 6: Connect dialog description accessibility

**Files:**
- Modify: `apps/control-room/src/kernel/layout/AppMenuBar.tsx`
- Test: relevant `AppMenuBar` test file.

**Interfaces:**
- `DialogContent aria-describedby="fm-api-connection-error-description"` matches the `DialogDescription` id.

- [ ] Add a failing render assertion for the description relationship.
- [ ] Add the stable id and `aria-describedby`.
- [ ] Re-run the focused test and confirm no Radix warning.

### Task 7: Documentation and full verification

**Files:**
- Modify: `docs/specs/frontend-v2/23-per-object-visualization-control.md`

- [ ] Record the Airbox carrier/non-target invariant and legacy normalization rule in the canonical spec.
- [ ] Run focused Rust and frontend tests for all changed paths.
- [ ] Run `pnpm --dir apps/control-room typecheck`.
- [ ] Run `pnpm --dir apps/control-room lint` with zero warnings.
- [ ] Run `pnpm --dir apps/control-room test`.
- [ ] Run `npx -y react-doctor@latest apps/control-room --verbose --diff`.
- [ ] Run `pnpm --dir apps/control-room audit:idle-performance`.
- [ ] Run the active-session viewport browser smoke and verify visible canvas, `gl.isContextLost() === false`, and nonzero drawing buffer.
- [ ] Run `git diff --check` and inspect only task-owned diffs.

