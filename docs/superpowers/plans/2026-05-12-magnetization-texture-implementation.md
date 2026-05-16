# Magnetization Texture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a backend-backed v2 magnetization texture workflow where object, region, and ribbon assignment are equivalent and the inspector/viewport expose editable texture state.

**Architecture:** Backend owns object/region assignment and magnetization asset content. Frontend resolves object/region/ribbon actions into one target model, edits a local draft for live preview, and persists through v2 API facade methods on Apply.

**Tech Stack:** Rust Axum/utoipa schemas and model handlers, React/Next control-room frontend, command registry ribbon, resource cache invalidation, Vitest, Rust tests.

---

## File Structure

- Modify `crates/fullmag-api/src/schemas/authoring.rs`: add region magnetization patch and typed magnetization asset patch request.
- Modify `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`: add asset GET/PATCH route handlers, extend region patch without unnecessary mesh dirty state.
- Modify `crates/fullmag-api/src/router_v2/tests.rs`: add backend route tests for region assignment and asset transform/params patching.
- Modify `apps/control-room/src/kernel/api/apiPaths.ts`: add magnetization asset path helper.
- Modify `apps/control-room/src/kernel/api/apiTypes.ts`: add frontend request/response types.
- Modify `apps/control-room/src/kernel/api/ControlRoomApi.ts`: add `getMagnetizationAsset` and `patchMagnetizationAsset`.
- Modify `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`: add shared magnetization invalidation helpers only if current local resource patterns require it.
- Create `apps/control-room/src/modules/magnetization-texture/types.ts`: target, draft, preset, mapping, transform types.
- Create `apps/control-room/src/modules/magnetization-texture/targetResolver.ts`: object/region selection to canonical target.
- Create `apps/control-room/src/modules/magnetization-texture/draftModel.ts`: scene/regions/assets to editor model and patch builders.
- Create `apps/control-room/src/modules/magnetization-texture/texturePresets.ts`: first-release preset catalog.
- Create `apps/control-room/src/modules/magnetization-texture/resourceInvalidation.ts`: shared invalidation keys after apply.
- Create `apps/control-room/src/modules/magnetization-texture/MagnetizationTextureEditor.tsx`: shared inspector editor.
- Modify `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx`: host shared editor with object target.
- Modify `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanel.tsx`: keep region overview but expose region texture route through registry/tree.
- Modify `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`: route region texture selection to shared texture editor.
- Modify `apps/control-room/src/modules/explorer/explorerTypes.ts`, `buildModelTree.ts`, `sceneModelTreeAdapter.ts`: region texture node and summaries.
- Modify `apps/control-room/src/modules/ribbon/ribbonContributions.tsx` and command contribution wiring: replace static texture actions with command ids that resolve target.
- Modify viewport model files under `apps/control-room/src/modules/viewport-3d/`: add authored texture preview model after shared draft contract exists.

## Task 1: Backend Region Texture Assignment

**Files:**
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

- [ ] **Step 1: Write failing backend test for region `magnetization_ref` patch**

Add a test that creates or loads a scene object with a derived region, calls `PATCH /v2/sessions/current/model/regions/{region_id}` with `{ "magnetization_ref": "mag-region" }`, and asserts the returned region resource/scene has that region override without marking geometry-only mesh dirty.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test -p fullmag-api region_magnetization_ref -- --nocapture`

Expected: FAIL because `RegionPatchRequest` ignores or rejects `magnetization_ref`.

- [ ] **Step 3: Extend `RegionPatchRequest`**

Add:

```rust
#[serde(default, skip_serializing_if = "Option::is_none")]
pub magnetization_ref: Option<Option<String>>,
```

Use a nullable option so JSON `null` can clear inheritance and a string can assign an override.

- [ ] **Step 4: Patch region magnetization without blanket mesh dirty**

In `patch_authoring_region`, update the region/object model so `magnetization_ref` changes the region assignment and does not call `mark_object_mesh_dirty(object)` unless `name` or `enabled` semantics still require it.

- [ ] **Step 5: Run focused Rust test and verify GREEN**

Run: `cargo test -p fullmag-api region_magnetization_ref -- --nocapture`

Expected: PASS.

## Task 2: Backend Magnetization Asset GET/PATCH

**Files:**
- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/authoring.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

- [ ] **Step 1: Write failing backend test for asset patch**

Add a test that patches an existing `magnetization_assets[]` entry with preset params, mapping, and `texture_transform`, then reloads the scene and asserts the asset content persists.

- [ ] **Step 2: Run the focused Rust test and verify RED**

Run: `cargo test -p fullmag-api magnetization_asset_patch -- --nocapture`

Expected: FAIL because no `/model/magnetization-assets/{asset_id}` handler exists.

- [ ] **Step 3: Add typed patch schema**

Add `MagnetizationAssetPatchRequest` with `base_revision`, optional label/kind/preset fields/mapping/texture transform values represented as `serde_json::Value` where the authoring type is already JSON-shaped.

- [ ] **Step 4: Add GET/PATCH handlers and route wiring**

Add `GET` and `PATCH` for `/v2/sessions/current/model/magnetization-assets/{asset_id}`. Use existing scene loading and `upsert_magnetization_asset` patterns, return committed scene or asset with revision consistently with nearby model handlers.

- [ ] **Step 5: Run focused Rust test and verify GREEN**

Run: `cargo test -p fullmag-api magnetization_asset_patch -- --nocapture`

Expected: PASS.

## Task 3: Frontend API Facade

**Files:**
- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Test: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`

- [ ] **Step 1: Write failing API facade test**

Add assertions that `api.model.getMagnetizationAsset("mag-1")` calls the new GET path and `api.model.patchMagnetizationAsset("mag-1", payload)` calls PATCH with the provided optimistic payload.

- [ ] **Step 2: Run focused Vitest and verify RED**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/kernel/api/ControlRoomApi.test.ts`

Expected: FAIL because facade methods are missing.

- [ ] **Step 3: Add path and types**

Add a `modelMagnetizationAssetPath(assetId)` helper and request/response interfaces for magnetization asset patches.

- [ ] **Step 4: Implement facade methods**

Add `getMagnetizationAsset` and `patchMagnetizationAsset` under `api.model`.

- [ ] **Step 5: Run focused Vitest and verify GREEN**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/kernel/api/ControlRoomApi.test.ts`

Expected: PASS.

## Task 4: Shared Target And Draft Model

**Files:**
- Create: `apps/control-room/src/modules/magnetization-texture/types.ts`
- Create: `apps/control-room/src/modules/magnetization-texture/targetResolver.ts`
- Create: `apps/control-room/src/modules/magnetization-texture/draftModel.ts`
- Create: `apps/control-room/src/modules/magnetization-texture/texturePresets.ts`
- Test: `apps/control-room/src/modules/magnetization-texture/targetResolver.test.ts`
- Test: `apps/control-room/src/modules/magnetization-texture/draftModel.test.ts`

- [ ] **Step 1: Write failing target resolver tests**

Test object magnetic texture selection, region texture selection, and ribbon selection context all resolve to the same canonical target shapes.

- [ ] **Step 2: Write failing draft model tests**

Test object assignment, region inheritance, region override, transform editing payloads, and preset parameter payloads.

- [ ] **Step 3: Run focused Vitest and verify RED**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/modules/magnetization-texture`

Expected: FAIL because the module does not exist.

- [ ] **Step 4: Implement minimal shared model**

Implement target types, resolver, first preset catalog (`uniform`, `random_seeded`, `vortex`), draft conversion, validation, and patch builders.

- [ ] **Step 5: Run focused Vitest and verify GREEN**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/modules/magnetization-texture`

Expected: PASS.

## Task 5: Inspector Integration

**Files:**
- Create: `apps/control-room/src/modules/magnetization-texture/MagnetizationTextureEditor.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Test: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Test: `apps/control-room/src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts`

- [ ] **Step 1: Write failing inspector routing/editor tests**

Assert object and region texture selections route to the texture editor and build the expected apply payloads.

- [ ] **Step 2: Run focused Vitest and verify RED**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts`

Expected: FAIL for region route/editor model gaps.

- [ ] **Step 3: Implement shared editor host**

Render assignment, preset, vector, mapping, transform, preview, Apply, Revert, and Refresh sections using existing inspector primitives and available shadcn-compatible UI.

- [ ] **Step 4: Wire object and region targets**

Make object and region hosts call the shared editor with the correct canonical target and API facade methods.

- [ ] **Step 5: Run focused Vitest and verify GREEN**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/panels/ObjectMagneticTexturePanelModel.test.ts`

Expected: PASS.

## Task 6: Explorer Region Texture Nodes

**Files:**
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/sceneModelTreeAdapter.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Test: `apps/control-room/src/modules/explorer/explorerSelection.test.ts`

- [ ] **Step 1: Write failing explorer tests**

Assert each region has a `Magnetic Texture` child and selecting it resolves to the region target without changing viewport render mode state.

- [ ] **Step 2: Run focused Vitest and verify RED**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/modules/explorer`

Expected: FAIL for missing region texture node.

- [ ] **Step 3: Implement tree and selection metadata**

Add `object.region-magnetic-texture` or equivalent kind, preserving object texture behavior and adding region summary badges for inherited/override.

- [ ] **Step 4: Run focused Vitest and verify GREEN**

Run: `cd apps/control-room && ./node_modules/.bin/vitest run src/modules/explorer`

Expected: PASS.

## Task 7: Ribbon Commands

**Files:**
- Create or modify command contribution file under `apps/control-room/src/modules/magnetization-texture/commands.ts`
- Modify: `apps/control-room/src/kernel/layout` or module registration path that registers module commands
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Test: add focused command tests near existing command contribution tests

- [ ] **Step 1: Write failing command tests**

Assert uniform/random/vortex commands are enabled for object and region texture targets, disabled without a target, and call the same apply facade path as inspector assignment.

- [ ] **Step 2: Run focused Vitest and verify RED**

Run the focused command test file with Vitest.

Expected: FAIL because commands do not exist.

- [ ] **Step 3: Register commands and replace decorative ids**

Implement command ids such as `magnetization-texture.assign-uniform`, `magnetization-texture.assign-random-seeded`, `magnetization-texture.assign-vortex`, `magnetization-texture.transform-reset`, and route ribbon actions to those ids.

- [ ] **Step 4: Run focused Vitest and verify GREEN**

Run the focused command test file with Vitest.

Expected: PASS.

## Task 8: Viewport Draft And Committed Preview

**Files:**
- Modify viewport model/resource files under `apps/control-room/src/modules/viewport-3d/`
- Create preview resolver under `apps/control-room/src/modules/magnetization-texture/previewModel.ts`
- Test: focused preview model tests and existing viewport render model tests

- [ ] **Step 1: Write failing preview model tests**

Assert committed object texture, region override, and local draft overlay resolve to expected preview payloads.

- [ ] **Step 2: Run focused Vitest and verify RED**

Run preview and viewport render model tests.

Expected: FAIL because preview model does not exist.

- [ ] **Step 3: Implement preview resolver and render model bridge**

Add authored magnetization preview payload to primitive/object render model without mixing it with solver field glyphs.

- [ ] **Step 4: Run focused Vitest and verify GREEN**

Run preview and viewport render model tests.

Expected: PASS.

## Task 9: Full Validation And Completion Audit

**Files:**
- Modify: `docs/superpowers/specs/2026-05-12-magnetization-texture-design.md` only if implementation changes the accepted contract.

- [ ] **Step 1: Run frontend gates**

Run:

```bash
cd apps/control-room && npm run typecheck
cd apps/control-room && npm run lint
cd apps/control-room && npm run test
cd apps/control-room && npm run check:api-hygiene
cd apps/control-room && npm run build
```

- [ ] **Step 2: Run backend gates**

Run the focused Rust API tests added for region texture assignment and magnetization asset patching.

- [ ] **Step 3: Run diff hygiene**

Run: `git diff --check`

- [ ] **Step 4: Complete prompt-to-artifact audit**

Use the checklist in `docs/superpowers/specs/2026-05-12-magnetization-texture-design.md` and map each requirement to implemented files and passing test output.

- [ ] **Step 5: Report unresolved gaps**

If viewport browser smoke or any gate cannot run, document the exact command, failure, and risk instead of claiming completion.

## Self-Review

- Spec coverage: all object, region, ribbon, inspector, backend, viewport, save/apply, shadcn-compatible UI, and validation requirements are mapped to tasks.
- Placeholder scan: no task is intentionally left as a follow-up; any narrower implementation must update the spec and checklist before claiming completion.
- Type consistency: canonical target/draft model is introduced before inspector, explorer, ribbon, and viewport integrations depend on it.
