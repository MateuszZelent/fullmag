# Independent Viewport Render Channels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every 3D visualization pass independently visible and transparent while separating physical region rendering from outline-only diagnostics.

**Architecture:** Extend the canonical v2 resolved target contract, map it into one pure frontend render plan, and make every FEM/FDM/airbox renderer consume that plan. Region diagnostics become a separate viewport-local outline channel and primitive geometry remains a field-free pre-mesh fallback.

**Tech Stack:** Rust/Axum/Utoipa OpenAPI v2, TypeScript, React, React Three Fiber, Three.js, Vitest, Playwright.

## Global Constraints

- HTTP v2 is the source of truth; generated transport remains the only low-level browser transport.
- New target writes use nested layer opacity fields; flat `display.opacity` is read-only compatibility input.
- Topology geometry is not rebuilt for quantity, component, palette, range, or opacity changes.
- Every CSS class remains `fm-` prefixed and every visual token remains `--fm-*` based.
- WebGL resources remain tracked, dirty-driven, and disposed on unmount.

---

### Task 1: Extend resolved target opacity semantics

**Files:**
- Modify: `crates/fullmag-api/src/schemas/visualization_state.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Modify: `crates/fullmag-api/src/router_v2/tests.rs`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2.json`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-types.ts`
- Regenerate: `apps/control-room/src/kernel/api/generated/openapi-v2-client.ts`

**Interfaces:**
- Produces resolved `surface_opacity`, `wireframe_opacity`, `point_opacity`, `bounds_opacity`, and `vector_alpha` values.
- Accepts legacy `display.opacity` only as fallback for missing `display.surface.opacity`.

- [x] Add a failing router/schema test asserting independent layer opacity values and legacy surface fallback.
- [x] Run the focused Rust test and confirm the new fields are missing.
- [x] Add the resolved fields and resolve each from its own layer/override.
- [x] Regenerate OpenAPI artifacts from the backend schema.
- [x] Run focused API tests and generated-contract checks.

### Task 2: Make the frontend target model explicit

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.test.ts`
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts`
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts`
- Modify matching inspector/ribbon consumers under `apps/control-room/src/modules/inspector` and `apps/control-room/src/kernel/visualization`.

**Interfaces:**
- Produces `surfaceOpacityPercent`, `wireframeOpacityPercent`, `pointOpacityPercent`, `boundsOpacityPercent`, and `vectorAlphaPercent`.
- `visualizationStatePatchFromTargetPatch` emits nested surface/points/bounds/wireframe patches.

- [x] Add failing controller tests for independent resolution and nested writes.
- [x] Run focused Vitest and confirm the explicit fields are absent.
- [x] Replace ambiguous `opacityPercent` with `surfaceOpacityPercent` and add point/bounds opacity fields.
- [x] Update defaults, normalization, inheritance, patch/reset, inspector, and ribbon mappings.
- [x] Run controller, display-resolution, and inspector tests.

### Task 3: Introduce the shared target render plan

**Files:**
- Create: `apps/control-room/src/modules/viewport-3d/layers/viewport3DTargetRenderPlan.ts`
- Create: `apps/control-room/src/modules/viewport-3d/layers/viewport3DTargetRenderPlan.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/viewport3DLayerSettings.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/VectorFieldLayer.tsx`

**Interfaces:**
- Produces `resolveViewport3DTargetRenderPlan(settings, profile)` with independent `surface`, `wireframe`, `points`, `vectors`, and `bounds` channel plans.
- Each channel plan contains `visible` and `opacity`; vectors also contain the resolved style.

- [x] Add failing tests that vary surface opacity while every other channel remains unchanged.
- [x] Run the focused test and confirm current helpers couple the values.
- [x] Implement the pure plan and channel-local material-profile multiplication.
- [x] Make vector material opacity consume only vector alpha.
- [x] Run render-plan and vector style tests.

### Task 4: Separate region diagnostics from physical target settings

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/regionOverlayMode.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/regionOverlayMode.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/regionOverlayModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/RegionOverlayLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/RegionMeshOverlayLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`

**Interfaces:**
- Produces `RegionDiagnosticOverlayState { visible, source }` with default `{ visible: false, source: "auto" }`.
- Region overlay models expose outline style only and accept no `VisualizationTargetSettings` resolver.

- [x] Add failing state/model tests for default-off, source selection, and outline-only diagnostics.
- [x] Run focused tests and confirm filled target-driven models still exist.
- [x] Remove target visualization settings from diagnostic model construction.
- [x] Remove diagnostic surface meshes/materials and retain authored/realized edge geometry and picking.
- [x] Split toolbar visibility from source selection and keep selection side-effect free.
- [x] Run region mode/model/layer/scene tests.

### Task 5: Migrate all unified 3D carriers to the render plan

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FallbackTopologyMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx`
- Modify relevant colocated tests.

**Interfaces:**
- Consumes `resolveViewport3DTargetRenderPlan` uniformly for FEM, FDM, fallback topology, and airbox.
- Primitive fallback consumes only primitive/solid authored settings and no field model.

- [x] Add failing per-carrier tests proving surface opacity does not affect wireframe, points, vectors, or bounds.
- [x] Run focused tests and observe the current coupled props.
- [x] Replace direct opacity helpers and surface-derived vector props with render-plan channels.
- [x] Preserve topology/material lifecycle keys and primitive mesh-readiness exclusion.
- [x] Run all changed layer tests.

### Task 6: Prove field-style hot updates and region inheritance

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.test.ts`
- Modify existing region visualization inheritance tests in `apps/control-room/src/kernel/visualization`.

**Interfaces:**
- Component/palette changes update the surface material/buffer revision without changing topology identity.
- Region target resolution remains parent-effective plus sparse local override and renders only mapped mesh parts.

- [x] Add failing regression tests for topology-stable component updates and inherited region settings.
- [x] Run the focused tests and confirm any missing contract.
- [x] Correct adapters/resolvers without adding component-local inheritance.
- [x] Run the focused scene-model and inheritance tests.

### Task 6A: Restore the monochrome pre-mesh Primitive channel

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationTargetSection.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx`
- Modify relevant colocated tests.

**Interfaces:**
- Produces viewport-local `primitiveVisible`, `primitiveMonoColor`, and `primitiveOpacityPercent` preferences.
- Renders authored/bounds-derived monochrome geometry only while the object has no current mesh carrier.

- [x] Add tests for the pre-mesh capability gate and independent primitive style.
- [x] Expose the `Primitive` chip plus monochrome color and opacity controls in Geometry context.
- [x] Keep primitive preferences out of HTTP target overrides and field/material paths.
- [x] Verify that current mesh readiness suppresses the primitive pass.

### Task 7: Full verification and browser proof

**Files:**
- Modify or add the existing Control Room viewport browser smoke under `apps/control-room` only if the required assertions are absent.
- Update: `docs/specs/frontend-v2/23-per-object-visualization-control.md`.

**Interfaces:**
- Browser proof asserts one visible canvas, healthy WebGL, non-zero drawing buffer, component update, independent opacity, and no filled region diagnostic material.

- [x] Run focused viewport, region, inspector, and API tests.
- [x] Run `pnpm --dir apps/control-room typecheck`.
- [x] Run `pnpm --dir apps/control-room lint -- --max-warnings=0`.
- [x] Run `pnpm --dir apps/control-room test`.
- [x] Run the repository resource-first and contract guards applicable to `apps/control-room`.
- [x] Run the viewport browser smoke and capture the final screenshot/report.
- [x] Run React Doctor and compare its score with the pre-change baseline.
- [x] Audit every requirement in the design against current code and evidence.

## Completion evidence (2026-07-18)

- `CARGO_TARGET_DIR=/tmp/fullmag-codex-target cargo test -p fullmag-api visualization_state_ --no-fail-fast`: 15 passed.
- `pnpm --dir apps/control-room test`: 387 files and 3683 tests passed.
- `pnpm --dir apps/control-room typecheck` and `pnpm --dir apps/control-room lint`: passed.
- `./scripts/ci-resource-first-gates.sh --strict` and `./scripts/ci/contract_guard.sh --strict`: passed.
- `pnpm --dir apps/control-room audit:idle-performance`: passed.
- viewport camera-only smoke: visible WebGL canvas, live context, and non-zero drawing buffer confirmed; Inspector smoke passed.
- React Doctor reports no finding in the changed visualization/viewport implementation. Its two remaining warnings are pre-existing array-index keys in `AddFieldDriveStageInspector.tsx`, outside this plan.
