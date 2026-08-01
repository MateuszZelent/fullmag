# Atomic Viewport Scalar Transition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the last fully renderable scalar surface visible until a replacement color mode has completed GPU upload, then promote the replacement atomically.

**Architecture:** Mesh topology remains unchanged. Each mesh-part carrier retains uploaded vertex-color and shader-attribute candidates under a topology-compatible carrier identity; a pure resolver selects the requested pipeline when ready and otherwise selects the previously committed compatible pipeline. Adoption receipts describe the selected visible buffer, so overlays and colorbars do not claim that pending data is already displayed.

**Tech Stack:** React 19, TypeScript, React Three Fiber, Three.js, Vitest.

## Global Constraints

- HTTP v2 remains the source of field data and WebSocket remains invalidation-only.
- Field/style changes update render buffers and materials without rebuilding topology.
- No large typed arrays enter React or Zustand state.
- Mesh-color fallback is allowed only when no compatible uploaded scalar surface exists.

---

### Task 1: Reproduce cross-pipeline fallback

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.test.ts`

**Interfaces:**
- Consumes: uploaded `ScalarColorBuffer` candidates for vertex-color and shader pipelines.
- Produces: regression expectations for stable carrier retention and committed-pipeline selection.

- [x] Add a failing test proving a previous shader buffer remains selected while a requested vertex-color buffer is pending.
- [x] Add a failing test proving a previous vertex-color buffer remains selected while a requested shader buffer is pending.
- [x] Run the focused tests and confirm failure is caused by the missing atomic resolver.

### Task 2: Implement atomic visible-buffer promotion

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/layers/MeshPartLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DScalarColorUpload.ts`

**Interfaces:**
- Consumes: `visibleScalarColors`, `visibleShaderScalarColors`, and the requested upload pipeline.
- Produces: `resolveMeshPartCommittedScalarColorState(...)` returning the single visible buffer and material pipeline.

- [x] Make the retention identity stable across color-mode and palette requests while preserving part, topology, projection, and vertex-count compatibility.
- [x] Retain a compatible uploaded buffer when a replacement cannot yet produce an upload plan.
- [x] Select the requested pipeline only after its upload becomes visible; otherwise keep the other compatible pipeline.
- [x] Drive material choice, vertex-color enablement, and adoption receipts from the committed state.
- [x] Run the focused tests and confirm they pass.

### Task 3: Verify frontend contracts

**Files:**
- Verify only; no generated transport or API schema changes.

**Interfaces:**
- Consumes: the existing resource hooks and binary field codec.
- Produces: evidence that the unified viewport remains type-safe, lint-clean, demand-rendered, and WebGL-healthy.

- [x] Run viewport-focused Vitest tests.
- [x] Run `pnpm --dir apps/control-room typecheck`.
- [x] Run `pnpm --dir apps/control-room lint`.
- [x] Run React Doctor and the available idle/WebGL viewport smoke gates.
- [x] Inspect the final diff and confirm that OpenAPI, generated transport, and backend resources are unchanged.
