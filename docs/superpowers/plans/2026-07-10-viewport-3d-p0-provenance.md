# Viewport 3D P0 Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close F3D-001 through F3D-004 so stale topology cannot consume fields, generation changes invalidate compatible data, and late FDM builds cannot render another domain.

**Architecture:** Keep scene/manifest freshness independent from field compatibility. Add one pure compatibility resolver for decoded field/topology identity, propagate exact revision tokens through adapters, target buffers, build keys, and realtime invalidation, then make FDM async state identity-safe.

**Tech Stack:** TypeScript, React 19, Vitest, R3F/Three.js, OpenAPI v2 resource facade, FMVP codec, Rust `fullmag-api` realtime tests.

## Global Constraints

- HTTP v2 resources are authoritative; websocket frames invalidate resources and never carry field payloads.
- `domain_generation_id` is preserved as an exact decimal string; unsafe JavaScript numbers are unknown rather than compatible.
- Stale topology may render only as an edge-only ghost; scalar attributes, points, vector glyphs, and field requests require current topology.
- FDM/FEM differences stay in adapters and render-model builders; no direct module transport or component-level renderer fork.
- Do not rebuild topology for a field-only revision change or lower visualization quality; demand rendering must be idle when settled.
- Every behavior change starts with a focused failing test and is green before commit.

---

### Task 1: Exact scene-to-manifest freshness

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:17-68`
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dTopologyStaleness.test.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts:272-288`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

**Interfaces:**
- Produces `resolveVisualizationTopologyFreshness(scene, manifest): "current" | "stale" | "unknown"`.
- Consumed by inspector freshness and `useViewport3DSceneModel`.

- [ ] **Step 1: Write the failing test**

```ts
expect(resolveVisualizationTopologyFreshness(
  { revision: 12, objects: [{ id: "film", tags: ["mesh:ready"] }] },
  { source_scene_revision: 11, mesh_parts: [{ object_id: "film" }] },
)).toBe("stale");
```

Add a region inspector assertion with the same revisions and expected
`"stale"`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/control-room exec vitest run src/kernel/visualization/visualizationDisplayResolution.test.ts src/modules/viewport-3d/viewport3dTopologyStaleness.test.ts src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts`

Expected: FAIL because revision `12` versus `11` resolves as `current` or
the region result is `null`.

- [ ] **Step 3: Write minimal implementation**

```ts
if (sourceSceneRevision !== null) {
  return sceneRevision === sourceSceneRevision ? "current" : "stale";
}
```

Route all inspector target kinds through this resolver. Retain dirty-geometry
and coverage heuristics only when `source_scene_revision` is absent.

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts \
  apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts \
  apps/control-room/src/modules/viewport-3d/viewport3dTopologyStaleness.test.ts \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.test.ts
git commit -m "fix(viewport): treat explicit mesh provenance mismatch as stale"
```

### Task 2: Separate stale ghost geometry from field-compatible topology

**Files:**
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts:8-114`
- Modify: `apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2282-3455`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx:58-130`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

**Interfaces:**
- Consumes Task 1 freshness.
- Produces `fieldCompatibleTopologyRenderModel`, non-null only for current
  topology.

- [ ] **Step 1: Write the failing test**

```ts
const resolution = resolveVisualizationRenderResolution({
  effectiveSettings: visibleShaderVectorSettings,
  settings: visibleShaderVectorSettings,
  topologyFreshness: "stale",
});
expect(resolution.degradedReasons).toContainEqual(
  expect.objectContaining({ code: "topology-stale" }),
);
expect(resolution.finalSettings).toMatchObject({
  shaderVisible: false, pointsVisible: false, vectorsVisible: false,
  wireframeVisible: true,
});
```

Add a scene-model assertion that stale topology retains geometry but supplies no
field-demand topology, scalar color, vector, range, or field-request input.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/control-room exec vitest run src/kernel/visualization/visualizationDisplayResolution.test.ts src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

Expected: FAIL because stale is currently renderable with normal field settings.

- [ ] **Step 3: Write minimal implementation**

```ts
const topologyRenderModelForGeometry = topologyRenderable ? topologyRenderModel : null;
const fieldCompatibleTopologyRenderModel = topologyCurrent ? topologyRenderModel : null;
```

Use the first value only for topology/ghost layers and the second for every
field resource, demand, scalar-color, vector-glyph, range, and field-model
path. Apply constrained settings to both stale and unknown values.

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/kernel/visualization/visualizationDisplayResolution.ts \
  apps/control-room/src/kernel/visualization/visualizationDisplayResolution.test.ts \
  apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts \
  apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
  apps/control-room/src/modules/viewport-3d/layers/TopologyMeshLayer.tsx \
  apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx
git commit -m "fix(viewport): reject fields for stale topology"
```

### Task 3: Carry domain generation through field identity and realtime invalidation

**Files:**
- Create: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDomainCompatibility.ts`
- Create: `apps/control-room/src/modules/viewport-3d/model/viewport3DFieldDomainCompatibility.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dRenderModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DChunkedScalarColors.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.ts`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`
- Modify: `crates/fullmag-api/src/main.rs`

**Interfaces:**
- Produces `resolveViewport3DFieldDomainCompatibility({ field, domain })`
  with `compatible`, `degraded`, or `mismatch` plus reason.

- [ ] **Step 1: Write the failing test**

```ts
expect(resolveViewport3DFieldDomainCompatibility({
  domain: { domainGenerationId: "43", meshTopologyHash: "h", meshTopologyRevision: "7", pointCount: 4 },
  field: { domainGenerationId: "42", formatVersion: 3, indexing: "full_domain", meshTopologyHash: "h", meshTopologyRevision: "7", pointCount: 4 },
})).toMatchObject({ status: "mismatch", reason: "domain-generation-mismatch" });
```

Add a realtime test with field revision unchanged and generation `7` then
`8`; both events must invalidate the subscribed field resource. Add the
matching Rust emission regression test.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/model/viewport3DFieldDomainCompatibility.test.ts src/modules/viewport-3d/viewport3dRenderModel.test.ts src/modules/viewport-3d/model/viewport3DTargetFieldBuffer.test.ts src/modules/viewport-3d/viewport3dDomainAdapter.test.ts src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.test.ts src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

Expected: FAIL because no central compatibility resolver exists and generation-only
events are suppressed.

- [ ] **Step 3: Write minimal implementation**

```ts
if (field.formatVersion >= 3) {
  if (!field.domainGenerationId || !domain.domainGenerationId) return mismatch("domain-generation-unknown");
  if (field.domainGenerationId !== domain.domainGenerationId) return mismatch("domain-generation-mismatch");
}
```

Replace local topology-only matchers with this resolver. Include generation in
target-buffer identity and every field-dependent build key. Preserve the realtime
generation token and combine it with field-samples invalidation identity. Keep
payload data on HTTP.

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command, then:

```bash
cargo test -p fullmag-api realtime_changes_since_refreshes_field_samples_when_only_domain_generation_changes
cargo test -p fullmag-api asyncapi_document_matches_realtime_rust_schema_names
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/modules/viewport-3d apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts \
  apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts crates/fullmag-api/src/main.rs
git commit -m "fix(viewport): require domain generation compatibility"
```

### Task 4: Make FDM asynchronous build results identity-safe

**Files:**
- Create: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.ts`
- Create: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx:479-614`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:3311-3485`

**Interfaces:**
- Consumes Task 3 FDM domain generation in the FDM build key.
- Produces `FdmCuboidBuildState` with `status`, `buildKey`, `result`, and
  `error`.

- [ ] **Step 1: Write the failing test**

```ts
expect(resolveFdmCuboidBuildState({
  currentBuildKey: "B",
  snapshot: { buildKey: "A", error: null, request: requestA, result: resultA, status: "ready" },
})).toEqual({ buildKey: "B", error: null, result: null, status: "pending" });
```

Add one late-A completion case and one non-abort B rejection case.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --dir apps/control-room exec vitest run src/modules/viewport-3d/layers/fdmCuboidBuildState.test.ts src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts src/modules/viewport-3d/build-engine/viewport3dBuildJobKeys.test.ts`

Expected: FAIL because the helper is absent and the hook returns prior snapshot
data or swallows an error.

- [ ] **Step 3: Write minimal implementation**

```ts
type FdmCuboidBuildStatus = "idle" | "pending" | "ready" | "error";
if (snapshot.buildKey !== currentBuildKey) {
  return { buildKey: currentBuildKey, error: null, result: null, status: "pending" };
}
```

Publish pending before each request, publish a result only when its completed
key remains current, ignore aborts, and publish a non-abort error with no
result. Thread the state error to existing viewport diagnostics and include
generation in the FDM build key.

- [ ] **Step 4: Run test to verify it passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.ts \
  apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildState.test.ts \
  apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.tsx \
  apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts \
  apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts
git commit -m "fix(viewport): hide stale asynchronous FDM builds"
```

## Final Verification

- [ ] `pnpm --dir apps/control-room typecheck`
- [ ] `pnpm --dir apps/control-room lint`
- [ ] `pnpm --dir apps/control-room test`
- [ ] `pnpm --dir apps/control-room audit:idle-performance`
- [ ] `pnpm --dir apps/control-room check:api-hygiene`
- [ ] `./scripts/ci-resource-first-gates.sh --strict`
- [ ] browser proof: current → stale → current and generation-only invalidation,
  visible canvas, live context, positive drawing buffer, stale ghost with zero
  field requests, then no old payload after generation change.
