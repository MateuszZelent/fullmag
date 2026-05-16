# 3D Viewport Phase 5 — Implementation Closure Audit

**Date:** 2026-05-11
**Scope:** `apps/control-room` frontend-v2 3D visualization module implementation against `implementation_plan.md`.
**Verdict:** implementation slice is functionally closed for local code gates, but the overall goal is **not fully proven** until default Turbopack build and browser/canvas smoke can run in an environment that permits Turbopack's process/port binding.

## Objective Restatement

Implement the frontend-v2 3D visualization module according to the corrected Phase 5 plan:

- one modular `viewport-3d` module in the unified workspace,
- one R3F canvas, no split viewport,
- resource-first API facade and hooks,
- decoded binary cache with bounded lifecycle,
- FDM/FEM domain adapters and render model,
- scalar/vector visualization basics,
- picking/selection through kernel contracts,
- diagnostics and memory/idle gates,
- no direct module transport or cross-module imports.

Add the 2026-05-11 per-object visualization requirement:

- expand the frontend-v2 plans with target-scoped visualization ownership;
- allow object, mesh-part fallback, and airbox display settings to be controlled independently;
- expose `Visualization` nodes in explorer;
- expose the complete target display configuration in inspector;
- make the View ribbon `Per selected object` group read and write the same target registry;
- keep the target model reusable for future 2D visualization.

## Prompt-to-Artifact Checklist

| Requirement | Evidence | Status |
|---|---|---|
| Single R3F viewport, demand-driven rendering | `Viewport3DModule.tsx` renders one `<Canvas>` wired to `VIEWPORT_3D_FRAMELOOP = "demand"` from `viewport3dTypes.ts` | Done |
| Module-owned camera state | `apps/control-room/src/modules/viewport-3d/viewport3dStore.ts` stores camera `position` and `target`; R3F controls update that store on interaction end | Done |
| Orientation widget state | `viewport3dStore.ts`, `orientation/magnetizationColor.ts`, `orientation/viewCubeModel.ts`; ViewCube/HSL reference commands are registered in `manifest.ts` | Done |
| Module manifest and kernel registration | `apps/control-room/src/modules/viewport-3d/manifest.ts`, `apps/control-room/src/modules/index.ts` | Done |
| Commands through kernel registry | `viewport-3d.fit`, `viewport-3d.reset-camera`, `viewport-3d.toggle-viewcube`, `viewport-3d.hsl-reference-*`; covered by `manifest.test.ts` | Done |
| Ribbon uses command registry for orientation controls | `ribbonContributions.tsx`, `ribbonTypes.ts`, `RibbonModule.tsx`; covered by `ribbonStructure.test.ts` | Done |
| Modular root and layers | `Viewport3DModule.tsx` is 185 lines; layer/model files are split below hard review thresholds | Done |
| API facade owns endpoint paths | `ControlRoomApi.ts`, `apiPaths.ts`, `apiTypes.ts`; modules use hooks only | Done |
| Binary 200/204/304/ETag behavior | `ControlRoomApi.test.ts` covers ready, not-modified, not-applicable, abort, scoped vector query | Done |
| Bounded decoded resource cache | `ResourceCache.ts`; LRU, byte budget, inflight dedupe, retain/release, dispose; covered by `ResourceCache.test.ts` | Done |
| Resource hooks for viewport data | `viewport3dResources.ts` covers domain meta/topology, field vector, visualization state, shared-domain manifest, scene, universe | Done |
| FDM budget-before-allocation adapter | `viewport3dDomainAdapter.ts`; covered by `viewport3dDomainAdapter.test.ts` | Done |
| FEM object/part/airbox mapping from mesh manifest | `adaptFemSharedDomainManifest`, `resolveFemPartSelectionByBoundaryFace`, `resolveMeshPartBounds` | Done |
| Render model separated from R3F | `viewport3dRenderModel.ts`, `viewport3dFieldMapping.ts` with focused tests | Done |
| Scalar/vector visualization basics | vertex scalar color buffer + vector line segments; covered by `viewport3dFieldMapping.test.ts` and `viewport3dRenderModel.test.ts` | Done |
| Chunked/cancellable field transforms | `buildVertexScalarColorsChunked()` supports chunk size, yield, abort signal | Done |
| Picking and kernel selection | R3F pointer hit maps boundary face to mesh part/object, then calls `useSelection()` | Done |
| Airbox and selection layers | `BoundsLayers.tsx`, `TopologyMeshLayer.tsx`, `FallbackTopologyMeshLayer.tsx`, `MeshPartLayer.tsx` | Done |
| Diagnostics/resource tracking/context loss | `viewport3dDiagnostics.ts`, `CanvasLifecycleProbe`, diagnostics HUD | Done |
| Idle/performance gate | `apps/control-room/scripts/audit-idle-performance.mjs`, package script `audit:idle-performance` | Done |
| Memory stress gate | `viewport-memory-stress.test.ts` | Done |
| No raw module `/v2` strings/direct fetch | `pnpm --dir apps/control-room check:api-hygiene` passed | Done |
| Module boundary hygiene | `rg` checks found no `apps/web`, cross-module imports, `fetch()`, hand-built `/v2` strings, `requestAnimationFrame`, `setInterval`, or always-on frameloop in `src/modules/viewport-3d` | Done |
| OpenAPI generated contract refreshed | `pnpm --dir apps/control-room generate:api` passed | Done |
| Backend v2 resource contract | `cargo test -p fullmag-api router_v2 --no-fail-fast` previously passed, 178 tests; not rerun after the final viewport/ribbon-only slice | Verified earlier |
| Default production build | `pnpm --dir apps/control-room build` fails in sandbox: Turbopack tries to bind a port during CSS processing and receives `Operation not permitted` | Blocked by environment |
| Alternate production bundle check | `pnpm --dir apps/control-room build:webpack` passed | Done as fallback only |
| Browser/canvas smoke script | `pnpm --dir apps/control-room smoke:viewport-3d` exists and checks visible canvas, WebGL context, center pixel, and browser console errors against `CONTROL_ROOM_URL`; readiness waits for the actual canvas instead of `networkidle` | Ready; runtime blocked |
| Smoke/audit script syntax | `node --check apps/control-room/scripts/smoke-viewport-3d.mjs` and `node --check apps/control-room/scripts/audit-idle-performance.mjs` passed | Done |
| Browser/canvas smoke execution | `pnpm --dir apps/control-room smoke:viewport-3d` attempted; Chromium failed with `sandbox_host_linux.cc:41 ... Operation not permitted`; escalation was rejected by session usage limit | Blocked by environment |
| React Doctor | `npx -y react-doctor@latest apps/control-room --verbose --diff` failed with `EAI_AGAIN` in restricted network; escalation was rejected by session usage limit | Blocked by environment |

## Per-Object Visualization Addendum

| Requirement | Evidence | Status |
|---|---|---|
| Plan expanded for target-scoped visualization | `docs/specs/frontend-v2/23-per-object-visualization-control.md`, `22-implementation-plan.md`, `3Dview_plan/implementation_plan.md` | Done |
| Shared target registry | `apps/control-room/src/kernel/visualization/ObjectVisualizationController.ts`, `useObjectVisualization.ts`, `KernelProvider.tsx` | Done |
| Explorer object visualization nodes | `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`, `buildModelTree.test.ts` | Done |
| Inspector target configuration | `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`, `inspectorRegistry.test.tsx` | Done |
| View ribbon `Per selected object` sync | `apps/control-room/src/modules/ribbon/RibbonModule.tsx`, `ribbonContributions.tsx`, `RibbonMenuRenderer.tsx`, `ribbonStructure.test.ts` | Done |
| 3D renderer applies object/part/airbox overrides | `Viewport3DModule.tsx`, `BoundsLayers.tsx`, `TopologyMeshLayer.tsx`, `MeshPartLayer.tsx`, `FallbackTopologyMeshLayer.tsx`, `viewport3dRenderModel.test.ts` | Done |
| Future 2D reuse documented | `15-viewport-2d-module.md`, `23-per-object-visualization-control.md` | Done |

## Verification Evidence

Passed:

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room build:webpack
```

Additional modularity checks:

```bash
rg -n "apps/web|@/modules/(explorer|inspector|ribbon|status-bar|overlay)|\\.\\./(explorer|inspector|ribbon|status-bar|overlay)" apps/control-room/src/modules/viewport-3d
rg -n "fetch\\(" apps/control-room/src/modules/viewport-3d apps/control-room/src/kernel/resources
rg -n '"/v2/|`/v2/' apps/control-room/src/modules/viewport-3d apps/control-room/src/kernel/resources --glob '!**/*.test.ts' --glob '!**/*.test.tsx'
rg -n "requestAnimationFrame\\(|setInterval\\(|frameloop=\"always\"" apps/control-room/src/modules/viewport-3d
```

All four searches returned no matches.

Latest local test result:

```text
Test Files  47 passed (47)
Tests       153 passed (153)
```

Latest file-size check for the viewport module:

```text
Viewport3DModule.tsx                 185 lines
BoundsLayers.tsx                     187 lines
CameraControls.tsx                   130 lines
FallbackTopologyMeshLayer.tsx        136 lines
MeshPartLayer.tsx                    127 lines
TopologyMeshLayer.tsx                 75 lines
VectorFieldLayer.tsx                  66 lines
Viewport3DScene.tsx                  111 lines
```

`react-doctor` is not currently verified. The local run attempted to fetch `react-doctor@latest` and failed with DNS `EAI_AGAIN`; the required network escalation was rejected by session usage limits.

Blocked:

```bash
pnpm --dir apps/control-room build
```

Failure signature:

```text
TurbopackInternalError: Failed to write app endpoint /page
Caused by:
- apps/control-room/app/globals.css [app-client] (css)
- creating new process
- binding to a port
- Operation not permitted (os error 1)
```

The default build must be repeated outside the current sandbox before the Phase 5 goal is marked fully complete.

```bash
pnpm --dir apps/control-room smoke:viewport-3d
```

Failure signature:

```text
browserType.launch: Target page, context or browser has been closed
sandbox_host_linux.cc:41 Check failed: . shutdown: Operation not permitted (1)
```

The required out-of-sandbox rerun was rejected by the session usage limit. The smoke script itself still passes `node --check`.

## Remaining Open Items

1. Run default Turbopack build in an environment that permits Turbopack process/port binding.
2. Run browser/canvas smoke on `/workspace` and verify:
   - one canvas is present,
   - canvas is nonblank,
   - no hydration mismatch,
   - no console errors from R3F/Three.js,
   - HUD diagnostics render,
   - command registry actions fit/reset do not trigger continuous rendering.
3. Use `CONTROL_ROOM_URL=<workspace-url> pnpm --dir apps/control-room smoke:viewport-3d` once a browser runtime is available.
4. Replace the static idle audit with a real runtime frame-count audit once browser automation is available.

## Completion Decision

The per-object visualization frontend slice is closed for code and local gates: docs, registry, explorer, inspector, ribbon synchronization, and 3D object/airbox/part rendering paths are present and tested.

Do not mark the broader Phase 5 viewport objective fully proven yet. The code implementation and local gates are in place, but the plan explicitly requires browser smoke and full app gate evidence. The default Turbopack build and live canvas verification remain environment-blocked.
