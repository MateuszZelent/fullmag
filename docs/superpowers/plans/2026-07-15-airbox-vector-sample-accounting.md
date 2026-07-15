# Airbox Vector Sample Accounting Implementation Plan

> **Execution note:** implement this plan task-by-task with test-first checkpoints and preserve the existing resource-first viewport architecture.

**Goal:** Make Airbox points, vector sampling, vector rendering, and Inspector accounting use the same effective air-only carrier, with measured FMVP and renderer counts.

**Architecture:** Add one pure shared mesh-part selection adapter that subtracts magnetic membership from air carriers and derives the matching surface subset. Feed that selection into topology render models, point geometry, vector selection, Inspector budget limits, and the Airbox field request. Extend the existing demand-driven visualization-debug adoption receipt with a logical glyph count so the Inspector can show decoded and adopted counts without another field request or a new API route.

**Tech stack:** TypeScript, React 19, Three.js/R3F, Vitest, Playwright browser smoke, HTTP v2/FMVP v3.

---

### Task 1: Define the canonical air-only carrier

**Files:**
- Create: `apps/control-room/src/shared/domain/mesh/visualizationNodeSelection.ts`
- Create: `apps/control-room/src/shared/domain/mesh/visualizationNodeSelection.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.test.ts`

1. Write failing tests for a raw air carrier containing magnetic interface nodes and assert full and surface air-only selections exclude them.
2. Implement a pure selection builder over explicit/range node membership and surface faces.
3. Add `fullNodeSelection` to each topology part render model and derive it for airbox parts from all magnetic parts.
4. Assert vector selection consumes the shared full/surface selection and rejects inconsistent scoped payloads larger than the carrier.

**Verify:** run the two focused Vitest files.

### Task 2: Use the canonical carrier for Points and budgets

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

1. Write failing tests proving Airbox `Points -> Full` uses the derived selection and the reference manifest budget resolves to 10,586 rather than 16,940.
2. Select `fullNodeSelection` in the point layer for Full mode and `surfaceNodeSelection` for Surface mode.
3. Reuse the shared selection adapter in the Inspector range calculation.
4. Remove the manifest-derived displayed-glyph estimate from the panel model.

**Verify:** run the two focused Vitest files.

### Task 3: Remove the 1,200 sample cap

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

1. Replace the old cap test with a failing reference-carrier test asserting 10,586 survives both the 1,200 legacy cap and session `max_glyphs=16,384`.
2. Make the Airbox budget resolver clamp only to the effective carrier count.
3. Feed the derived carrier count to both the field query `max_samples` and field-demand plan.
4. Preserve the session-wide interactive limit for non-Airbox/fallback paths.

**Verify:** run `useViewport3DSceneModel.test.ts` and inspect the serialized query assertion.

### Task 4: Publish decoded and adopted logical counts

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/vectorGlyphBuildModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DRenderAdoptionRegistry.ts`
- Modify: corresponding focused tests

1. Write failing tests showing zero-magnitude samples do not create segments/glif instances and do not inflate adoption.
2. Compact vector segments so each logical segment is visible and non-zero.
3. Add bounded `itemCount`/logical glyph count to vector adoption receipts and include it in semantic equality/stale identity behavior.
4. Publish decoded `pointCount` and adopted logical count through the existing visualization-debug snapshot; validate field/resource/build identities before exposing adopted values.

**Verify:** run render-model, glyph-build, vector-layer, adoption-registry, and visualization-debug focused tests.

### Task 5: Show measured Inspector accounting

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Modify: corresponding tests

1. Write failing model tests for `available`, `decoded`, and `adopted` values, `waiting` states, and stale identity rejection.
2. Demand the existing visualization-debug snapshot only for the selected target.
3. Render separate rows: `Available air-only nodes`, `Decoded field samples`, and `Adopted arrows`; count one shaft+head pair as one arrow.
4. Reject decoded counts above the effective carrier and clear adoption on topology/resource/build mismatch.

**Verify:** run Inspector model and render tests.

### Task 6: Full verification and live browser proof

**Files:**
- Modify if needed: `apps/control-room/scripts/smoke-viewport-3d-mixed-targets.mjs`
- Update evidence under: `apps/control-room/.artifacts/viewport-3d-browser-audit/`

1. Run all focused tests from Tasks 1-5.
2. Run `pnpm --dir apps/control-room typecheck`.
3. Run `pnpm --dir apps/control-room lint -- --max-warnings=0` (or the repo-equivalent zero-warning command).
4. Run `pnpm --dir apps/control-room test`.
5. Run viewport memory-stress and idle-performance gates.
6. Use the current localhost workspace to verify a visible canvas, non-lost WebGL context, non-zero drawing buffer, exactly one Airbox FMVP request, request `max_samples=10586`, and matching Inspector decoded/adopted counts.

