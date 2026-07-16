# Microwave Antenna UI and Analysis Implementation Plan

> Supersession note (2026-07-15): RegionalFieldDrive authoring, `H_drive`, and
> Gamma/finite-k regional-drive analysis are governed by ADR 0019, physics note
> 0920, and the 2026-07-15 regional-field implementation plan. This document
> remains canonical for solved-antenna UI and analysis surfaces.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete control-room authoring, staged execution, 3D inspection, CST-style field maps, line cuts, source k-spectrum, and spin-wave response surfaces for the canonical variable-width antenna workflow.

**Architecture:** `apps/control-room` consumes generated OpenAPI transport only through `ControlRoomApi`, revisioned resource hooks, domain adapters, and binary codecs. One unified Explorer/Inspector/ribbon/viewport shell serves FDM and FEM. `viewport-3d` renders procedural authoring intent before meshing and realized topology after solve. A new active-only `field-map` center module renders scalar slice/projection resources; `analysis-plots` renders curves and spectra. Shared chart/raster/domain primitives live under `src/shared`, never in another module.

**Tech Stack:** Next.js 16, React 19, TypeScript, generated OpenAPI v2 client, Vitest, Zustand/kernel stores, Three.js/R3F, ECharts 6, shadcn-style shared primitives, Catppuccin `--fm-*` tokens, Playwright/browser smoke scripts.

## Global Constraints

- This is plan 3 of 3. Start only after the contracts/API plan and the required backend fixture/resource tasks pass.
- New UI writes typed antenna and field-drive transactions. Remove the current `Box` plus raw `current_modules` merge-patch path for new antennas.
- Do not expose `mqs_2p5d_az` in new menus. Compatibility scripts remain inspectable with a read-only legacy badge and approximation warning.
- Variable width means stations along the local current axis. CPW authoring must support a center constriction and asymmetric left/right dimensions without a 2.5D assumption.
- Frozen wire names across all three plans are `quasistatic_conduction_biot_savart_3d`, `antenna_field_solution.v1`, `normalization_current_a`, `stage_local`, `H_ant_basis`, `source-spectrum`, `local-k-spectrum`, and `dynamic-structure-factor`; UI labels may be friendlier but transport values must remain exact.
- One Explorer tree, one command registry, one ribbon, one Inspector registry, and one viewport-main tab host remain authoritative.
- No component-level `fetch()`, no handwritten `/v2` strings outside central API path/generated layers, and no direct generated-client usage from modules.
- HTTP v2 owns state. Websocket events only invalidate exact resources and command states.
- Heavy vectors and rasters stay outside React state. Resource hooks own metadata; codecs and renderer models own bounded typed arrays.
- `H_ant`, `H_ant_basis`, `V_electric`, `J_charge`, and `h_perp` attach only to compatible declared domains. Never color a procedural fallback mesh with a realized field buffer.
- Create ECharts/WebGL/worker resources once per mount, update only on revisions or controls, resize by observer, and dispose on unmount. Idle means no continuous frames.
- Use `fm-` CSS classes and `--fm-*` tokens. Do not add raw Catppuccin colors to components or module CSS.
- Every semantic Explorer child maps to a dedicated Inspector contribution.
- Preserve unrelated worktree changes and keep each commit focused.

---

## Task 1: Complete the handwritten API facade and resource hooks

**Files:**

- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.test.ts`
- Create: `apps/control-room/src/kernel/resources/antennaResources.ts`
- Create: `apps/control-room/src/kernel/resources/antennaResources.test.ts`

- [ ] **Step 1: Write failing facade tests**

Test model projections, revision-aware mutations, stage plan/progress/diagnostics, solution list/detail, existing slice/projection families, line cuts, source spectra, local spectra, and dynamic response.

```typescript
it("requests an antenna solution through the generated path", async () => {
  const api = createTestApi();
  await api.data.antennaSolutions.detail("solution-17", { etag: '"rev-7"' });
  expect(lastRequest()).toMatchObject({
    method: "GET",
    path: "/v2/sessions/current/data/antenna-field-solutions/solution-17",
    headers: { "if-none-match": '"rev-7"' },
  });
});
```

- [ ] **Step 2: Run the facade tests and confirm methods are missing**

Run: `pnpm --dir apps/control-room test -- --run src/kernel/api/ControlRoomApi.test.ts`

Expected: type/test failures for missing antenna resource methods.

- [ ] **Step 3: Add generated-path constants**

Use `openApiV2Path` for every new path. Existing field slice/projection constants remain the single source; do not duplicate route strings in `antennaResources.ts`.

- [ ] **Step 4: Add domain-facing facade groups**

Extend `ControlRoomApi` with:

```typescript
readonly antennas = {
  layouts: {
    list: (options?: RequestOptions) => this.requestJson<AntennaLayoutListResource>(MODEL_ANTENNAS_PATH, options),
    create: (request: AntennaLayoutCreateRequest, options?: RequestOptions) =>
      this.postJson<AntennaLayoutMutationResponse, AntennaLayoutCreateRequest>(MODEL_ANTENNAS_PATH, request, options),
  },
};
```

Implement complete list/create/patch/delete groups for layouts and drives; stage read methods; solution list/detail/projections; field slice/projection/empty-mask methods; line-cut create/detail; and spectrum metadata/tile methods. Reuse standard request, ETag, conflict, cancellation, and error mapping.

- [ ] **Step 5: Add revisioned resource loaders**

`antennaResources.ts` exports stable resource keys and loaders for model, stage, solution, and analysis resources. Each loader supports abort signals, ETag/304, unavailable/stale/error states, and exact resource revision identity.

- [ ] **Step 6: Test missed-event recovery**

Invalidate no local key, advance the fixture HTTP revision, reload from HTTP, and assert the latest state is recovered. Then invalidate one exact spectrum key and assert unrelated field-solution cache entries remain ready.

- [ ] **Step 7: Run API and resource tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/kernel/api/ControlRoomApi.test.ts src/kernel/resources/antennaResources.test.ts
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room typecheck
```

Expected: pass.

- [ ] **Step 8: Commit the facade and hooks**

```bash
git add apps/control-room/src/kernel/api/apiPaths.ts apps/control-room/src/kernel/api/apiTypes.ts apps/control-room/src/kernel/api/ControlRoomApi.ts apps/control-room/src/kernel/api/ControlRoomApi.test.ts apps/control-room/src/kernel/resources/antennaResources.ts apps/control-room/src/kernel/resources/antennaResources.test.ts
git commit -m "feat(control-room): add antenna resource facade"
```

---

## Task 2: Add binary codecs for masks and tiled spectra

**Files:**

- Create: `apps/control-room/src/kernel/api/codecs/u8MaskCodec.ts`
- Create: `apps/control-room/src/kernel/api/codecs/u8MaskCodec.test.ts`
- Create: `apps/control-room/src/kernel/api/codecs/tiledRasterCodec.ts`
- Create: `apps/control-room/src/kernel/api/codecs/tiledRasterCodec.test.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`

- [ ] **Step 1: Write malformed-payload tests first**

Cover short headers, unsupported versions, unsafe dimensions, product overflow, truncated bodies, unexpected component counts, nonfinite axes, tile overlap, and exact-u64 revision preservation.

```typescript
expect(() => decodeTiledRaster(new Uint8Array([0x46, 0x4d]))).toThrow(
  "tiled raster header is truncated",
);
```

- [ ] **Step 2: Implement a bounded u8 mask decoder**

Return dimensions, revision as `bigint`, and a `Uint8Array` view. Validate that the payload length equals the declared cell count before returning.

- [ ] **Step 3: Implement the versioned tiled-raster decoder**

Decode metadata and one requested tile at a time. Return typed axis descriptors and a bounded `Float32Array` or `Float64Array`. Do not assemble an unbounded full matrix automatically.

- [ ] **Step 4: Wire codecs only in the API layer**

Modules receive decoded domain objects through facade/resource loaders; they do not parse `ArrayBuffer` payloads.

- [ ] **Step 5: Run codec tests**

Run: `pnpm --dir apps/control-room test -- --run src/kernel/api/codecs`

Expected: pass.

- [ ] **Step 6: Commit codecs**

```bash
git add apps/control-room/src/kernel/api/codecs apps/control-room/src/kernel/api/ControlRoomApi.ts
git commit -m "feat(control-room): decode antenna raster resources"
```

---

## Task 3: Add shared antenna domain models and validation

**Files:**

- Create: `apps/control-room/src/shared/domain/antenna/antennaTypes.ts`
- Create: `apps/control-room/src/shared/domain/antenna/antennaValidation.ts`
- Create: `apps/control-room/src/shared/domain/antenna/antennaValidation.test.ts`
- Create: `apps/control-room/src/shared/domain/antenna/antennaLoftModel.ts`
- Create: `apps/control-room/src/shared/domain/antenna/antennaLoftModel.test.ts`
- Create: `apps/control-room/src/shared/domain/antenna/antennaStatus.ts`

- [ ] **Step 1: Write validation and geometry-model tests**

Test endpoint stations, monotonic positions, positive widths/gaps/thickness/conductivity, balanced weights, missing returns, asymmetric CPW dimensions, local/global transforms, and a center constriction loft.

```typescript
it("keeps width variation along the current axis", () => {
  const loft = buildCpwLoft(constrictedCpwFixture());
  expect(loft.sections.map((section) => section.u)).toEqual([0, 6e-6, 12e-6]);
  expect(loft.sections[1]?.signalWidthM).toBe(260e-9);
});
```

- [ ] **Step 2: Implement transport-to-domain adapters**

Normalize generated snake-case resources to readonly UI domain models without losing ids, asymmetric stations, terminal selectors, signed weights, revisions, requested/resolved execution, or stale reasons.

- [ ] **Step 3: Implement pure validation**

Return structured diagnostics with path, code, severity, message, and remediation. Do not duplicate server-only mesh/solver validation; distinguish local authoring blockers from server diagnostics.

- [ ] **Step 4: Implement procedural loft models**

Generate signal/ground vertices and triangle indices per conductor part, terminal face polygons, local current arrows, bounds, and pick ids. This is renderer-neutral data, not Three.js geometry.

- [ ] **Step 5: Run domain tests**

Run: `pnpm --dir apps/control-room test -- --run src/shared/domain/antenna`

Expected: pass.

- [ ] **Step 6: Commit shared domain models**

```bash
git add apps/control-room/src/shared/domain/antenna
git commit -m "feat(control-room): model variable-width antennas"
```

---

## Task 4: Replace raw antenna merge patches with typed authoring commands

**Files:**

- Create: `apps/control-room/src/kernel/authoring/antennaCommands.ts`
- Create: `apps/control-room/src/kernel/authoring/antennaCommandContributions.ts`
- Create: `apps/control-room/src/kernel/authoring/antennaCommandContributions.test.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.ts`
- Modify: `apps/control-room/src/kernel/authoring/geometryLifecycleCommandContributions.test.ts`
- Modify: command registration file nearest existing geometry contributions

- [ ] **Step 1: Write failing atomic-transaction tests**

Assert `Add CPW` sends one typed transaction containing layout, stations, balanced symmetric port mode, and scene object identity; assert it never sends `kind: "merge_patch"` with a full `current_modules` array.

- [ ] **Step 2: Implement typed transaction helpers**

Add helpers for create/update/delete layout, add/remove station, add taper, add constriction, add/update port mode, add solved drive, and add regional drive. Every mutation includes `base_revision` and invalidates exact scene/model resources after success.

- [ ] **Step 3: Replace the old microstrip command**

`geometry.add-microstrip-antenna` creates a canonical layout and return plane. Add `geometry.add-cpw-antenna`. Remove the raw `defaultMicrostripAntennaModule` write from the new path.

- [ ] **Step 4: Add capability and selection gates**

Disabled commands return concrete reasons such as missing antenna selection, unsupported variable-width layout, missing return conductor, or stale scene revision.

- [ ] **Step 5: Run authoring tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/kernel/authoring/antennaCommandContributions.test.ts src/kernel/authoring/geometryLifecycleCommandContributions.test.ts
pnpm --dir apps/control-room typecheck
```

Expected: pass.

- [ ] **Step 6: Commit typed authoring**

```bash
git add apps/control-room/src/kernel/authoring
git commit -m "feat(control-room): author typed antenna layouts"
```

---

## Task 5: Build the complete antenna Explorer hierarchy

**Files:**

- Create: `apps/control-room/src/modules/explorer/builders/antennaExplorerNodes.ts`
- Create: `apps/control-room/src/modules/explorer/builders/antennaExplorerNodes.test.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.test.ts`
- Create: `apps/control-room/src/modules/explorer/builders/study/antennaFieldSolveStageNode.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/study/studyExplorerNodes.ts`

- [ ] **Step 1: Write the exact semantic tree test**

Assert nodes for layout, conductors, width profile, ports, mesh, visualization, solved/regional drives, field-solve stage, solution/current/field/projections/diagnostics, field maps, source spectra, and dynamic response.

- [ ] **Step 2: Implement antenna model nodes**

Use resource ids and revisions from domain adapters. Each child gets a unique `kind`, stable id, status, badge, selection ref, and command list. Do not retain one generic `object.antenna` child as the only semantic node.

- [ ] **Step 3: Implement stage and result nodes**

Map every runtime state including stale dependency reasons. Use the same stage record and solution resources; do not duplicate state into Explorer-local stores.

- [ ] **Step 4: Run Explorer tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/explorer/builders/antennaExplorerNodes.test.ts src/modules/explorer/builders/buildModelTree.test.ts
```

Expected: pass.

- [ ] **Step 5: Commit Explorer nodes**

```bash
git add apps/control-room/src/modules/explorer/builders
git commit -m "feat(control-room): expose antenna workflow tree"
```

---

## Task 6: Split the Inspector into semantic antenna panels

**Files:**

- Create: `apps/control-room/src/modules/inspector/panels/antenna/AntennaLayoutPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/antenna/AntennaPortsPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/antenna/AntennaFieldSolveStagePanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/antenna/SolvedAntennaDrivePanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/antenna/RegionalFieldDrivePanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/antenna/AntennaSolutionPanel.tsx`
- Create: corresponding pure model files and focused tests
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Remove after migration: `apps/control-room/src/modules/inspector/panels/AntennaObjectPanel.tsx`
- Remove after migration: `apps/control-room/src/modules/inspector/panels/AntennaObjectPanelModel.ts`

- [ ] **Step 1: Add registry coverage first**

Map every new Explorer kind to its dedicated panel and assert none resolves to `PlaceholderPanel`, `StudyStageInspectorRouter`, or the old generic antenna panel.

- [ ] **Step 2: Implement layout and station editing**

Render kind, length, thickness, conductivity, transform, local frame, station table, minimum dimensions, and diagnostics. Add/remove/taper/constriction buttons invoke registered commands, not local API calls.

- [ ] **Step 3: Implement port editing and overlays**

Render conductor parts, inlet/outlet selectors, signed weights, current sum, symmetric CPW action, and server validation. Selection events request terminal-face/current-arrow overlays through kernel visualization state.

- [ ] **Step 4: Implement stage and solution panels**

Show requested/resolved execution, mesh policy and realized mesh, sampling targets, solver/quadrature policy, progress, residual, current imbalance, validity ratios, signatures, field links, projections, stale reasons, and command completion.

- [ ] **Step 5: Implement separate solved and regional drive panels**

Solved drive shows solution/port, peak current, waveform, time origin, active stages, and the message `Waveform edits reuse the solved spatial basis`. Regional drive shows region, B amplitude, direction, profile, waveform, and active stages only.

- [ ] **Step 6: Remove the generic panel only after all routes pass**

Delete the old files and imports when registry and panel tests demonstrate complete coverage.

- [ ] **Step 7: Run Inspector tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/panels/antenna
pnpm --dir apps/control-room typecheck
```

Expected: pass.

- [ ] **Step 8: Commit semantic Inspectors**

```bash
git add apps/control-room/src/modules/inspector
git commit -m "feat(control-room): inspect antenna workflow semantics"
```

---

## Task 7: Add field-solve stage authoring and runtime controls

**Files:**

- Create: `apps/control-room/src/kernel/authoring/antennaStudyCommands.ts`
- Create: `apps/control-room/src/kernel/authoring/antennaStudyCommandContributions.ts`
- Create: `apps/control-room/src/kernel/authoring/antennaStudyCommandContributions.test.ts`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.test.ts`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.ts`
- Modify: `apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts`

- [ ] **Step 1: Write failing stage-command tests**

Cover add stage, solve selected stage, cancel, refresh stale solution, and run pipeline. Assert the solve payload is:

```typescript
{
  kind: "solve",
  target: { kind: "stage", stage_id: "solve_cpw_field" },
}
```

- [ ] **Step 2: Add typed stage authoring**

Create an `antenna_field_solve` primitive with antenna ref, port modes, mesh policy, box-grid sampling, target refs, solver/quadrature policy, and output id. Validate it precedes every solved drive that references it.

- [ ] **Step 3: Add runtime command completion**

Use the existing simulation command endpoint and completion/invalidation path. Progress is fetched from its resource; websocket events carry only command state and invalidations.

- [ ] **Step 4: Implement stale refresh behavior**

Refresh submits the same canonical stage after showing changed dependency paths. Waveform-only edits must not enable refresh or invalidate the solution.

- [ ] **Step 5: Run stage tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/kernel/authoring/antennaStudyCommandContributions.test.ts src/kernel/runtime/studyRuntimeCommandAdapters.test.ts src/kernel/resources/studyRuntimeResources.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit stage controls**

```bash
git add apps/control-room/src/kernel/authoring/antennaStudyCommands.ts apps/control-room/src/kernel/authoring/antennaStudyCommandContributions.ts apps/control-room/src/kernel/authoring/antennaStudyCommandContributions.test.ts apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.ts apps/control-room/src/kernel/runtime/studyRuntimeCommandAdapters.test.ts apps/control-room/src/kernel/resources/studyRuntimeResources.ts apps/control-room/src/kernel/resources/studyRuntimeResources.test.ts
git commit -m "feat(control-room): control antenna field stages"
```

---

## Task 8: Render procedural and realized antennas in the unified 3D viewport

**Files:**

- Create: `apps/control-room/src/modules/viewport-3d/antenna/antennaViewportAdapter.ts`
- Create: `apps/control-room/src/modules/viewport-3d/antenna/antennaViewportAdapter.test.ts`
- Create: `apps/control-room/src/modules/viewport-3d/antenna/AntennaAuthoringLayer.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/antenna/AntennaTerminalOverlayLayer.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/antenna/AntennaCurrentArrowLayer.tsx`
- Create: `apps/control-room/src/modules/viewport-3d/antenna/AntennaRealizedMeshLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/PrimitiveObjectLayer.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Add focused lifecycle/render tests

- [ ] **Step 1: Write renderer-model tests**

Assert procedural loft part counts, transformed bounds, terminal overlays, signed current directions, stable pick ids, realized topology switch, and strict field-domain compatibility.

- [ ] **Step 2: Add procedural authoring layers**

Convert shared loft buffers to Three.js geometries once per layout revision. Use distinct token-derived signal/ground materials, selection outlines, terminal overlays, and current arrows. Dispose geometries/materials on revision/unmount.

- [ ] **Step 3: Add realized topology routing**

After a ready solution, allow switching to the conductor mesh domain. Attach `V_electric` and `J_charge` only to that topology. Route `H_ant_basis` to its sampling grid or magnetic target projection.

- [ ] **Step 4: Preserve topology/field separation**

Changing waveform or quantity updates field buffers without rebuilding topology. Changing station geometry invalidates procedural geometry and solution state but does not mutate magnetic topology.

- [ ] **Step 5: Ensure dirty-driven rendering**

Invalidate the single R3F canvas on layout, selection, field revision, camera, or overlay changes only. No layer starts its own animation loop.

- [ ] **Step 6: Run viewport unit tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/viewport-3d/antenna src/modules/viewport-3d/viewport3dDomainAdapter.test.ts src/modules/viewport-3d/layers/viewport3DLayerPerformanceContracts.test.ts
pnpm --dir apps/control-room audit:idle-performance
```

Expected: pass.

- [ ] **Step 7: Commit 3D antenna layers**

```bash
git add apps/control-room/src/modules/viewport-3d
git commit -m "feat(control-room): render antenna layouts and fields"
```

---

## Task 9: Extract shared ECharts lifecycle primitives

**Files:**

- Create: `apps/control-room/src/shared/charts/EChartsSurface.tsx`
- Create: `apps/control-room/src/shared/charts/EChartsSurface.test.tsx`
- Create: `apps/control-room/src/shared/charts/chartFrameScheduler.ts`
- Create: `apps/control-room/src/shared/charts/chartFrameScheduler.test.ts`
- Create: `apps/control-room/src/shared/charts/chartSurfaceModel.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.test.tsx`
- Modify: analysis-plots imports

- [ ] **Step 1: Move tests before implementation**

The shared tests must prove one init per mount, option updates only for stable model/revision changes, ResizeObserver resize, dispose on unmount, loading/error overlays, and zero interval-driven redraw.

- [ ] **Step 2: Implement the shared surface**

Use generic `fm-chart-*` classes and accept renderer-ready bounded options plus overlay/accessibility metadata. Do not place product-specific labels or antenna state in the shared component.

- [ ] **Step 3: Migrate analysis-plots**

Replace module-internal lifecycle code with imports from `src/shared/charts`. Keep an optional thin re-export only during the same commit if required to keep intermediate tests compiling; remove it before completion.

- [ ] **Step 4: Run chart tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/shared/charts src/modules/analysis-plots/components/EChartsSurface.test.tsx
pnpm --dir apps/control-room audit:chart-performance
```

Expected: pass.

- [ ] **Step 5: Commit shared chart lifecycle**

```bash
git add apps/control-room/src/shared/charts apps/control-room/src/modules/analysis-plots
git commit -m "refactor(control-room): share chart lifecycle primitives"
```

---

## Task 10: Add the active-only field-map center module

**Files:**

- Create: `apps/control-room/src/modules/field-map/manifest.ts`
- Create: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Create: `apps/control-room/src/modules/field-map/FieldMapView.tsx`
- Create: `apps/control-room/src/modules/field-map/useFieldMapController.ts`
- Create: `apps/control-room/src/modules/field-map/fieldMapModel.ts`
- Create: `apps/control-room/src/modules/field-map/fieldMapModel.test.ts`
- Create: `apps/control-room/src/modules/field-map/FieldMapModule.test.tsx`
- Create: `apps/control-room/src/modules/field-map/fieldMapLifecycle.test.tsx`
- Modify: `apps/control-room/src/modules/registry.ts`
- Modify: `apps/control-room/src/modules/index.test.ts`
- Create: `apps/control-room/src/design/styles/field-map.css`
- Modify: `apps/control-room/app/globals.css` or the existing import aggregator only

- [ ] **Step 1: Write manifest and active-only mount tests**

Assert id `field-map`, slot `viewport-main`, declarative open command, registration, and that `ViewportTabHost` mounts only the active center module.

- [ ] **Step 2: Implement bounded field-map model building**

Accept decoded slice/projection scalar data, mask, arrows, outlines, units, component policy, coordinate axes, and revision. Produce ECharts heatmap/contour/scatter models without storing raw payloads in React state.

- [ ] **Step 3: Implement controls and overlays**

Provide component/magnitude, linear/log/symmetric range, contours, sparse arrows, conductor/magnetic outlines, cursor world-coordinate/value probe, stale/unsupported/empty overlays, and numeric/PNG export commands.

- [ ] **Step 4: Implement resource lifecycle**

The controller fetches only while active, aborts superseded requests, reuses ETags, keeps the renderer instance stable, and reloads on exact field/display/resource revisions. Selection of `mu0 H display` changes presentation units only.

- [ ] **Step 5: Add accessible UI with shared primitives**

Use shared tabs, selects, switches, tooltips, buttons, and segmented controls. Provide keyboard-accessible probe/legend controls and textual min/max/current-value summaries.

- [ ] **Step 6: Run field-map tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/field-map src/kernel/layout/ViewportTabHost.test.tsx src/modules/index.test.ts
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room audit:idle-performance
```

Expected: pass.

- [ ] **Step 7: Commit field-map module**

```bash
git add apps/control-room/src/modules/field-map apps/control-room/src/modules/registry.ts apps/control-room/src/modules/index.test.ts apps/control-room/src/design/styles/field-map.css apps/control-room/app/globals.css
git commit -m "feat(control-room): add antenna field maps"
```

---

## Task 11: Add line cuts and spectra to analysis-plots

**Files:**

- Create: `apps/control-room/src/shared/domain/analysis/antennaSpectrumModels.ts`
- Create: `apps/control-room/src/shared/domain/analysis/antennaSpectrumModels.test.ts`
- Create: `apps/control-room/src/shared/domain/analysis/tiledRasterModel.ts`
- Create: `apps/control-room/src/shared/domain/analysis/tiledRasterModel.test.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisPlotsModel.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`

- [ ] **Step 1: Write domain-model tests**

Test explicit labels, axes/units, source-vs-response separation, local `u-k` raster bounds, `k-omega` tiled loading, line-cut distance axes, range selection, and malformed metadata.

- [ ] **Step 2: Add line-cut workflows**

Create line cuts through the API facade, display distance/value curves with world-coordinate inspection, and retain field id/revision/component/interpolation provenance.

- [ ] **Step 3: Add source spectrum views**

Render `Antenna source spectrum W_H(k)` as a trace and `Local antenna spectrum W_H(u,k)` as a bounded raster. Never label them as excited spin-wave intensity.

- [ ] **Step 4: Add dynamic response view**

Render `Spin-wave response S_m(k,omega)` with explicit k and frequency/omega units, normalization, component policy, time window, run revision, tile-loading state, and probe values.

- [ ] **Step 5: Keep module boundaries clean**

`analysis-plots` imports shared domain/chart primitives and resource hooks only. It never imports `field-map` components, controllers, stores, CSS, or internal models.

- [ ] **Step 6: Run analysis tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/shared/domain/analysis/antennaSpectrumModels.test.ts src/shared/domain/analysis/tiledRasterModel.test.ts src/modules/analysis-plots/AnalysisPlotsModule.test.tsx
pnpm --dir apps/control-room smoke:analysis-plots
pnpm --dir apps/control-room audit:chart-performance
```

Expected: pass.

- [ ] **Step 7: Commit antenna analysis surfaces**

```bash
git add apps/control-room/src/shared/domain/analysis apps/control-room/src/modules/analysis-plots
git commit -m "feat(control-room): plot antenna and spin-wave spectra"
```

---

## Task 12: Register ribbon and context commands across modules

**Files:**

- Modify: `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`
- Modify: antenna, field-map, analysis-plots, and viewport manifests
- Modify: command registry tests nearest each contribution

- [ ] **Step 1: Add command-presence and gating tests**

Assert the exact Geometry, Physics, Study, and Results commands from section 11.3 of the design. Verify menu, ribbon, context menu, and command palette resolve the same ids.

- [ ] **Step 2: Register Geometry commands**

Add Microstrip, CPW, Width Station, Taper, Constriction, Port Mode, and Validate Antenna. Gate by capability and compatible selection.

- [ ] **Step 3: Register Physics and Study commands**

Add Solved Antenna Drive, Regional Field Drive, Edit Waveform, Toggle Drive, Antenna Field Solve, Solve Selected Stage, Refresh Stale Solution, and Run Pipeline.

- [ ] **Step 4: Register Results commands**

Add `J_charge`, `H_ant_basis`, instantaneous `H_ant`, `mu0 H` display, `h_perp`, slice, projection, line cut, source spectrum, and dynamic response. Commands select resources/views; they do not fetch directly.

- [ ] **Step 5: Verify disabled reasons**

Every disabled command exposes a specific reason: missing selection, stale solution, missing target projection, unsupported capability, incompatible domain, or unavailable analysis artifact.

- [ ] **Step 6: Run ribbon/registry tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/modules/ribbon/ribbonStructure.test.ts
pnpm --dir apps/control-room check:architecture-hygiene
```

Expected: pass.

- [ ] **Step 7: Commit unified commands**

```bash
git add apps/control-room/src/modules/ribbon apps/control-room/src/modules/field-map/manifest.ts apps/control-room/src/modules/analysis-plots/manifest.ts apps/control-room/src/modules/viewport-3d/manifest.ts
git commit -m "feat(control-room): register antenna workflow commands"
```

---

## Task 13: Implement stale, unsupported, failed, and degraded product states

**Files:**

- Modify: `apps/control-room/src/shared/domain/antenna/antennaStatus.ts`
- Create: `apps/control-room/src/shared/domain/antenna/antennaStatus.test.ts`
- Modify: antenna resource hooks/controllers
- Modify: antenna Inspector panels
- Modify: field-map and analysis-plots models/views
- Add focused state tests beside each owner

- [ ] **Step 1: Add a complete status matrix test**

Cover `missing`, `stale`, `queued`, `meshing`, `solving_current`, `evaluating_field`, `projecting_targets`, `ready`, `cancelled`, `failed`, `degraded`, and `unsupported`.

- [ ] **Step 2: Render dependency-specific stale reasons**

Show the changed path and old/new revision or signature. Distinguish base-solution staleness, target-projection staleness, and equilibrium-only `h_perp` staleness.

- [ ] **Step 3: Render structured remediation**

Unsupported forced GPU solve offers device-policy correction; missing return offers port/layout edit; topology mismatch offers projection rebuild; failed solve retains residual/iteration/current-balance diagnostics.

- [ ] **Step 4: Prove waveform edits preserve the basis**

The UI updates the drive and instantaneous/analysis resources while leaving the field-solution state and revision ready. Add an exact invalidation-scope test.

- [ ] **Step 5: Run status tests**

Run:

```bash
pnpm --dir apps/control-room test -- --run src/shared/domain/antenna/antennaStatus.test.ts src/kernel/resources/antennaResources.test.ts src/modules/field-map/fieldMapModel.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit product states**

```bash
git add apps/control-room/src/shared/domain/antenna apps/control-room/src/kernel/resources/antennaResources.ts apps/control-room/src/modules/inspector/panels/antenna apps/control-room/src/modules/field-map apps/control-room/src/modules/analysis-plots
git commit -m "feat(control-room): surface antenna lifecycle states"
```

---

## Task 14: Add end-to-end browser workflow and visual verification

**Files:**

- Create: `apps/control-room/scripts/smoke-antenna-workflow.mjs`
- Create: `apps/control-room/src/modules/field-map/antennaWorkflowSmokeScript.test.ts`
- Modify: `apps/control-room/package.json`
- Create: `examples/antenna_cpw_constriction_workspace.py`
- Create: `docs/validation/antenna-cpw-constriction-ui-acceptance.md`

- [ ] **Step 1: Add the smoke script contract test**

Assert `package.json` exposes `smoke:antenna-workflow` and the script checks the full acceptance flow.

- [ ] **Step 2: Implement the browser scenario**

The script must:

1. create a variable-width CPW with a center constriction;
2. validate explicit signal/return ports;
3. add and solve the 1 A field stage;
4. inspect `J_charge` at the constriction;
5. open `H_ant_basis` in 3D and field-map;
6. open source and local k spectra;
7. relax the magnetic target;
8. attach a sinc drive without re-solving the field;
9. run LLG;
10. open `S_m(k,omega)`;
11. export canonical Python;
12. reload and compare normalized layout, stage references, and solution signatures.

- [ ] **Step 3: Assert viewport health**

After every switch back to 3D, assert canvas visibility, `gl.isContextLost() === false`, nonzero drawing buffer, and no startup `THREE.WebGLRenderer: Context Lost` error.

- [ ] **Step 4: Capture visual evidence**

Capture screenshots for the constricted CPW authoring view, current-density map, H-field heatmap, source k-spectrum, and dynamic response. Record expected visual differences and physical labels in the validation note.

- [ ] **Step 5: Add repeated-switch memory checks**

Switch 3D/field-map/analysis at least 30 times, verify only the active center module is mounted, and assert bounded ECharts/WebGL/worker counts and memory growth within the established audit threshold.

- [ ] **Step 6: Run browser proof**

Run:

```bash
pnpm --dir apps/control-room smoke:antenna-workflow
pnpm --dir apps/control-room smoke:viewport-3d
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:chart-performance
```

Expected: all pass with screenshots and validation evidence.

- [ ] **Step 7: Commit acceptance workflow**

```bash
git add apps/control-room/scripts/smoke-antenna-workflow.mjs apps/control-room/src/modules/field-map/antennaWorkflowSmokeScript.test.ts apps/control-room/package.json examples/antenna_cpw_constriction_workspace.py docs/validation/antenna-cpw-constriction-ui-acceptance.md
git commit -m "test(control-room): verify antenna workflow end to end"
```

---

## Task 15: UI-plan final quality gates

- [ ] **Step 1: Run all frontend quality gates**

```bash
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
```

Expected: zero TypeScript errors, zero ESLint warnings, and all tests pass.

- [ ] **Step 2: Run lifecycle and performance gates**

```bash
pnpm --dir apps/control-room test -- --run viewport
pnpm --dir apps/control-room test -- --run viewport-memory-stress
pnpm --dir apps/control-room test -- --run chart
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

Expected: pass.

- [ ] **Step 3: Run architecture searches**

```bash
rg "from ['\"]\.\./" apps/control-room/src/modules
rg 'fetch\(' apps/control-room/src
rg '"/v2/' apps/control-room/src --glob '!kernel/api/generated/**' --glob '!kernel/api/apiPaths.ts'
rg 'mqs_2p5d_az' apps/control-room/src
rg 'current_modules.*merge_patch|merge_patch.*current_modules' apps/control-room/src
rg '#[0-9a-fA-F]{6}' apps/control-room/src/modules apps/control-room/src/design/styles
```

Expected: no cross-module internal imports, direct fetches, module path literals, selectable legacy model, raw current-module authoring patch, or new raw colors.

- [ ] **Step 4: Run full acceptance workflow**

Run the backend managed antenna recipes, start the standard control room, then run `smoke:antenna-workflow`. Confirm no field solve occurs after the waveform-only edit.

- [ ] **Step 5: Verify exact product semantics**

Confirm:

- variable width is visibly along the current axis;
- signal/return currents and directions are explicit;
- `H_ant` quantity selection shows real vector/range on the magnetic target;
- `mu0 H` is a display conversion only;
- source spectra are labeled `W_H`, response is labeled `S_m`;
- FDM/FEM differences appear through capabilities/adapters, not separate UI trees;
- exported Python reimports to equal normalized IR;
- every Explorer child opens a distinct Inspector;
- inactive 3D/field-map/analysis modules are unmounted.

- [ ] **Step 6: Prepare review evidence**

Attach test logs, managed runtime report ids, screenshots, memory/performance audit outputs, OpenAPI generation diff, and the remaining legacy compatibility window. Do not claim full-wave microwave accuracy.
