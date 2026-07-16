# Semantic Render Target–Explorer Invariant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Guarantee that every semantic/pickable 3D render target has exactly one Explorer node and every viewport pick reveals and selects it.

**Architecture:** Build one pure kernel catalog from HTTP v2 scene/manifest data, use it for selection and Explorer fallback nodes, and reject unaddressable carriers at the render-model boundary. Keep transport carrier ids only as hit/data-plane metadata.

**Tech Stack:** React 19, TypeScript, Vitest, Three.js/R3F, Rust/Axum/Serde.

## Global Constraints

- `nodeId` is an Explorer address, never a mesh carrier id.
- `carrierPartId` is transport metadata, never a visualization target.
- `__air__` and Airbox mesh parts map only to canonical `airbox`.
- Orphan renderable parts require visible `Mesh → Unassigned mesh parts` nodes.
- Unaddressable targets fail closed and emit a bounded diagnostic.
- HTTP v2 remains authoritative; WebSocket remains invalidation-only.
- No component-level `fetch()`, no new endpoint, and no continuous render loop.
- Preserve unrelated dirty-worktree changes and do not commit from the shared checkout.

---

### Task 1: Shared semantic target catalog

**Files:**
- Create: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.ts`
- Test: `apps/control-room/src/kernel/selection/semanticRenderTargetCatalog.test.ts`
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`

**Interfaces:**
- Produces: `buildSemanticRenderTargetCatalog(input)` and `resolveSemanticTargetForMeshPart(catalog, part)`.
- Produces: entries containing `targetId`, `targetKind`, `explorerNodeId`, `explorerTabId`, and `carrierIds`.

- [ ] Write tests for `air`, `airbox`, owned object, geometry alias, stale owner, orphan part, synthetic `__air__`, and duplicate carrier ids.
- [ ] Run `env TMPDIR=/tmp pnpm --dir apps/control-room test -- --run src/kernel/selection/semanticRenderTargetCatalog.test.ts` and confirm failures describe the missing catalog.
- [ ] Implement the minimal pure catalog and semantic selection helpers.
- [ ] Re-run the focused test and confirm all cases pass.

### Task 2: Canonical viewport picks

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dSelection.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dSelection.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/Viewport3DModule.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`

**Interfaces:**
- Produces: `viewportSelectionForMeshPart(address, hit)` with semantic `nodeId` and optional `carrierPartId`.

- [ ] Add failing tests proving Airbox and owned FEM picks use canonical Explorer nodes and an orphan uses its explicit fallback node.
- [ ] Run the focused selection/domain tests and observe the carrier-id assertions fail.
- [ ] Replace the manually assembled mesh-part `SelectionRef` with the shared builder.
- [ ] Re-run focused tests and confirm canonical selection behavior.

### Task 3: Explorer fallback nodes and reveal

**Files:**
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Test: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Modify: `apps/control-room/src/modules/explorer/explorerStore.ts`
- Test: `apps/control-room/src/modules/explorer/explorerStore.test.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/explorer/ExplorerTreeView.tsx`
- Test: `apps/control-room/src/modules/explorer/ExplorerTreeView.test.tsx`

**Interfaces:**
- Consumes: catalog fallback entries.
- Produces: `mesh.unassigned` and `mesh.unassigned.part` nodes.
- Produces: `revealExplorerNode(tabId, nodeId, ancestorIds)` and row scrolling.

- [ ] Add failing tree tests for explicit orphan nodes and exactly one Airbox.
- [ ] Add failing store/view tests for tab switch, ancestor expansion, active filter, and scrolling.
- [ ] Build fallback nodes from the catalog and implement value-stable reveal state.
- [ ] Make filtering retain the selected path and make the virtualized tree scroll to the active row.
- [ ] Re-run all focused Explorer tests.

### Task 4: Fail-closed render model and API ownership

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dPrimitiveModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dPrimitiveModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Test: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.ts`
- Test: `apps/control-room/src/modules/viewport-3d/viewport3dDiagnostics.test.ts`
- Modify: `crates/fullmag-api/src/router_v2/handlers/visualization/display.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

**Interfaces:**
- Consumes: catalog addresses and current scene object ids.
- Produces: no scientific layer for an unaddressable carrier and one bounded `unaddressable-render-target` diagnostic.

- [ ] Add failing frontend tests for synthetic `__air__` filtering and unaddressable carrier rejection.
- [ ] Add a failing API test proving a stale owner becomes an orphan fallback instead of a nonexistent object target.
- [ ] Implement the smallest filters/guards and bounded diagnostic deduplication.
- [ ] Re-run focused frontend and API tests.

### Task 5: Composed contract and release gates

**Files:**
- Create: `apps/control-room/src/modules/viewport-3d/semanticRenderTargetExplorerContract.test.ts`
- Modify: the existing viewport browser smoke script only if it lacks click-to-Explorer assertions.
- Modify: `docs/specs/frontend-v2/11-explorer-view.md`
- Modify: `docs/specs/frontend-v2/23-per-object-visualization-control.md`

**Interfaces:**
- Proves every pickable semantic render entry resolves to exactly one Explorer node.

- [ ] Add the composed scene/manifest/catalog/tree/render contract test and observe it fail against the old carrier selection.
- [ ] Make only contract-required corrections until it passes.
- [ ] Run focused selection, Explorer, renderer, Inspector, and API tests.
- [ ] Run `pnpm --dir apps/control-room typecheck`.
- [ ] Run `pnpm --dir apps/control-room lint` with zero warnings.
- [ ] Run `env TMPDIR=/tmp pnpm --dir apps/control-room test`.
- [ ] Run `npx -y react-doctor@latest apps/control-room --verbose --diff` and verify no score regression.
- [ ] Run viewport browser smoke and assert visible canvas, live WebGL context, nonzero drawing buffer, and Airbox/magnetic/orphan click-to-Explorer behavior.
- [ ] Run `git diff --check` and inspect task-owned diffs separately from unrelated shared-worktree changes.

