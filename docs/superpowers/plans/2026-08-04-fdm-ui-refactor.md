# FDM/FEM Control Room UI Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor the unified Control Room so FDM and FEM use one workspace/ribbon/viewport while each surface renders the correct grid/topology, mesh/airbox semantics, capabilities, selections, and provenance described in `docs/audits/2026-08-04-fdm-ui-audit.md`.

**Architecture:** Introduce one revision-aware `DomainPresentation`/capability boundary above the existing resource hooks. FDM uses a structured-grid render model plus encoding-aware membership; FEM keeps the shared-domain topology model. Explorer, Inspector, commands, and the unified viewport consume that boundary instead of inferring FEM from generic mesh resources. The work is staged so a browser-verified 3D mesh/grid render is the first release gate.

**Tech Stack:** Next.js 16, React/TypeScript, Zustand kernel/module stores, R3F/Three.js viewport, Vitest, typed v2 `ControlRoomApi`/resource hooks, Rust v2 OpenAPI schemas where a capability/resource contract is missing.

## Global Constraints

- Work directly on the requested `master` checkout and preserve unrelated dirty files.
- Keep one unified FDM/FEM workspace, Explorer, ribbon, command registry, and R3F canvas; do not fork an FDM-only or FEM-only application tree.
- FDM/FEM differences live in domain adapters/render-model builders; renderer layers receive domain-neutral render models, never raw API payloads.
- FDM air/void extent remains available when universe is larger than magnetic support, but it is a role/overlay of one regular FDM grid, not a second FEM airbox topology.
- `u32::MAX` is the canonical FDM inactive sentinel in v2; active/unassigned ID `0` must remain renderable. Legacy v1 compatibility must be explicit and tested.
- Status remains thin; heavy topology/mesh/field payloads use named revisioned v2 resources and binary codecs.
- Requested and resolved backend/device/precision/mode plus fallback/degraded reason remain visible; no hidden fallback.
- All Inspector edits use explicit draft transactions; server resources stay in resource hooks/cache, not module stores.
- All viewport changes use dirty-driven rendering, explicit WebGL/worker disposal, and a browser smoke asserting visible canvas, non-lost WebGL context, and non-zero drawing buffer.
- CSS classes in `apps/control-room` use the `fm-` prefix and consume `--fm-*` tokens.
- Use test-first changes: each production behavior has a failing focused test before implementation, then focused tests, typecheck, and changed-file lint.
- Do not modify native FEM/backend code for this UI refactor; any required v2 schema change must preserve the backend golden-masterplan and be covered by API/OpenAPI tests.

---

## Task 1: Establish the FDM/FEM domain presentation boundary

**Files:**
- Create: `apps/control-room/src/shared/domain/mesh/domainPresentation.ts`
- Create: `apps/control-room/src/shared/domain/mesh/domainPresentation.test.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Modify: `apps/control-room/src/kernel/resources/geometryLifecycleResources.ts`
- Test: existing domain/resource adapter tests under `apps/control-room/src/modules/viewport-3d/` and `apps/control-room/src/kernel/resources/`

**Interfaces:**
- Consumes `DomainMeta`, `StructuredGridDescriptor`, `FdmRegionMembershipResource`, and FEM shared-domain manifest/topology resources.
- Produces a discriminated `DomainPresentation` with `discretization`, `resourceStatus`, `revision/fingerprint`, `fdmGrid` or `femTopology`, and optional FDM `universeOutsideMagneticSupport` role.
- Produces pure helpers `isFdmDomain`, `isFemDomain`, `resolveFdmCellState`, and `domainPresentationKey` used by later tasks. These helpers must not fetch or mutate state.

- [ ] **Step 1: Write failing adapter tests** for FDM with no topology manifest, FDM with a structured grid and membership, FDM universe larger than magnetic support, FEM shared-domain manifest, and stale/missing membership.
- [ ] **Step 2: Run the focused test file** with `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run src/shared/domain/mesh/domainPresentation.test.ts`; confirm failures are missing types/behavior rather than test setup errors.
- [ ] **Step 3: Implement the discriminated presentation and pure cell-state classifier** using the existing resource schemas; keep raw buffers in resource/cache ownership.
- [ ] **Step 4: Run focused adapter/resource tests** and verify no component-level transport or `/v1` fallback is introduced.
- [ ] **Step 5: Have a task reviewer inspect the diff** for resource-first/state ownership and add the task line to `.superpowers/sdd/progress.md` without overwriting the existing FEM ledger.

## Task 2: Finish the P0 FDM membership/render-model path

**Files:**
- Modify: `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.ts`
- Modify: `apps/control-room/src/kernel/api/codecs/index.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.ts`
- Tests: `apps/control-room/src/kernel/api/codecs/fdmRegionMembershipCodec.test.ts`, `apps/control-room/src/modules/viewport-3d/layers/fdmCuboidBuildModel.test.ts`
- Modify/add: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`

**Interfaces:**
- Consumes `DomainPresentation` from Task 1 and the v2 FMRM binary descriptor.
- Produces an encoding-aware `FdmCuboidInstanceModel` that excludes only inactive sentinel cells, retains active ID `0`, carries `regionIds`/mask state, and reports decode errors as explicit degraded status.

- [ ] **Step 1: Add RED tests** for v2 header/kind, legacy v1 normalization, inactive `u32::MAX`, active/unassigned `0`, region IDs, malformed header/length, and a decode-error path that never silently labels the authored full grid as realized membership.
- [ ] **Step 2: Run the two codec/model test files** and confirm each new test fails for the expected missing behavior. Preserve the existing focused test command with `TMPDIR=/tmp`.
- [ ] **Step 3: Implement the smallest codec/model/error-state changes**; do not add a numeric `regionId > 0` heuristic and do not put decoded arrays in React/Zustand state.
- [ ] **Step 4: Run codec/model plus `useViewport3DSceneModel` focused tests** and inspect diagnostics/error paths.
- [ ] **Step 5: Reviewer checks v2 semantics, legacy compatibility, and fallback safety.** Fix all Critical/Important findings before continuing.

## Task 3: Decouple FDM field/vector demand and make 3D mesh visible

**Files:**
- Modify: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/Viewport3DScene.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/layers/BoundsLayers.tsx`
- Modify: `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.ts`
- Modify/add: `apps/control-room/src/modules/viewport-3d/viewport3dDomainAdapter.ts`
- Tests: `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`, `apps/control-room/src/modules/viewport-3d/layers/FdmCuboidLayer.test.ts`, `apps/control-room/src/modules/viewport-3d/model/viewport3DTargets.test.ts`

**Interfaces:**
- Consumes `DomainPresentation`, FDM grid/membership, field resources, and visualization target state.
- Produces FDM-compatible field/vector demand and a domain-neutral render model. FDM must not require `fieldCompatibleTopologyRenderModel`; FEM stale-topology safety remains intact.

- [ ] **Step 1: Add RED tests** with FDM `topology=204`/manifest absent that require selected quantity, scalar colors, vectors/topography demand, and inspect readiness; add FDM domain bounds/target tests with and without an air role.
- [ ] **Step 2: Run those tests** and capture the current FEM-gate failure.
- [ ] **Step 3: Split topology compatibility from FDM grid compatibility** in pure demand/render-model helpers; keep topology rebuilds separate from field-buffer swaps and preserve display budget.
- [ ] **Step 4: Add the FDM universe/magnetic-support overlay** without creating a FEM `airboxParts` topology layer; make target kind and selection bounds consistently `fdm-domain`.
- [ ] **Step 5: Run all focused viewport tests, memory/lifecycle tests, and changed-file lint.** Add/adjust a browser smoke fixture that asserts canvas visibility, `gl.isContextLost() === false`, and drawing-buffer dimensions.
- [ ] **Step 6: Task reviewer verifies no continuous render loop, no resource leak, no hidden fallback, and no cross-module import.**

## Task 4: Refactor Explorer, selection, and Inspector registry

**Files:**
- Modify: `apps/control-room/src/modules/explorer/explorerTypes.ts`
- Modify: `apps/control-room/src/modules/explorer/builders/buildModelTree.ts`
- Modify: `apps/control-room/src/modules/explorer/ExplorerModule.tsx`
- Modify: `apps/control-room/src/modules/explorer/explorerSelection.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorDescriptor.ts`
- Tests: Explorer tree/selection/registry tests under `apps/control-room/src/modules/explorer/` and `apps/control-room/src/modules/inspector/`

**Interfaces:**
- Consumes `DomainPresentation`, mesh/grid resource revisions, and kernel selection state.
- Produces one unified tree with FDM `Grid`, `Mask/Regions`, and optional `Universe outside magnetic support` nodes; FEM keeps shared-domain topology nodes. Every semantic node has an exact Inspector route.

- [ ] **Step 1: Add RED FDM snapshots** for no-air and universe>magnetic-support cases, plus FEM regression snapshots proving shared-domain nodes remain.
- [ ] **Step 2: Add RED selection/registry tests** for `mesh.grid`, FDM cell `(i,j,k)` identity, `mesh.unassigned`, and breadcrumb `object`/`object.root` consistency.
- [ ] **Step 3: Implement builder branching through `DomainPresentation`**, not ad-hoc checks in each panel; remove unconditional FEM Airbox subtree/actions for FDM.
- [ ] **Step 4: Implement exact node kinds/descriptors/selection refs** and route every node to a distinct or domain-aware Inspector; no wildcard Placeholder for semantic nodes.
- [ ] **Step 5: Run Explorer/Inspector focused tests and module architecture searches** (`rg` for cross-module imports, direct fetch, raw `/v2` strings).
- [ ] **Step 6: Reviewer checks one-tree doctrine, SSR/hydration stability, selection ownership, and no FEM labels in FDM fixtures.**

## Task 5: Make Mesh/Airbox/Object/Region/Visualization Inspectors domain-aware

**Files:**
- Modify: `apps/control-room/src/modules/inspector/panels/MeshDetailsPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/mesh-details/useMeshDetailsModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxOverviewPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshParametersPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshOverviewPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshQualityGatesPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshStatisticsPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshTopologyPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/airbox/AirboxMeshBuildPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectMeshPolicyPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectRegionsPanelModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/region/ObjectRegionMeshPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanelModel.ts`
- Tests: corresponding existing panel/model tests plus FDM fixtures for each semantic node.

**Interfaces:**
- Consumes `DomainPresentation`, FDM grid/membership resources, explicit draft transactions, and FEM mesh resources.
- Produces FDM panels with `Nx×Ny×Nz`, origin, cell spacing, active/inactive/background counts, region legend, mask freshness, and grid fingerprint. FEM-only fields (`hmax`, tetra/SICN, Gmsh, FEM order, boundary faces) are hidden or explicitly `not applicable` for FDM.

- [ ] **Step 1: Add RED render tests** for each FDM Inspector showing no FEM-only labels and correct grid metrics; add FEM regression fixtures.
- [ ] **Step 2: Add RED draft tests** proving FDM grid edits use the canonical transaction/resource path and do not serialize FEM element policy.
- [ ] **Step 3: Implement domain-specific view models/panels** while preserving explicit draft state and resource ownership.
- [ ] **Step 4: Adapt Visualization Inspector to FDM grid/cell/region targets** and explicit unsupported/stale/not-materialized states.
- [ ] **Step 5: Run panel tests, typecheck, and targeted ESLint; reviewer checks units, accessibility, copy, and `fm-*` styling.**

## Task 6: Capability-driven interactions, Study provenance, and ribbon commands

**Files:**
- Modify: `apps/control-room/src/shared/domain/physics/interactions.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/PhysicsInteractionPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageAuthoringModel.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyStageInspectorRouter.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonContributions.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonCommands.ts`
- Modify: `apps/control-room/src/kernel/runtime/studyRuntimeCommandContributions.ts`
- Modify: capability/OpenAPI sources only if the current active-session contract cannot carry the lane matrix; regenerate generated types rather than editing them manually.
- Tests: interaction, ribbon, Study authoring/runtime command, and capability resource tests.

**Interfaces:**
- Consumes active-session capability status and `CurrentRunResource` requested/resolved provenance.
- Produces `supported|semantic_only|deferred|unsupported|stale` interaction/command states with reason, backend/device/precision/mode scope, and canonical FDM `multilayer_convolution` option.

- [ ] **Step 1: Add RED capability matrix tests** for FDM/FEM × CPU/GPU × single/double × strict/extended and unsupported eigen/frequency/topography commands.
- [ ] **Step 2: Add RED demag/interaction round-trip tests** proving FDM does not serialize FEM-only policy and `multilayer_convolution` is preserved.
- [ ] **Step 3: Implement one lane/operator catalog and fail-closed validator** used by global/stage authoring, interaction panel, ribbon, and command registry.
- [ ] **Step 4: Render requested/resolved/fallback in durable Study runtime/provenance** without putting heavy payloads in status.
- [ ] **Step 5: Replace static `Build FEM Mesh` with capability-derived copy and gate topography/eigen/frequency commands.
- [ ] **Step 6: Run capability/API/type generation checks and reviewer checks OpenAPI alignment, HTTP-v2 ownership, no hidden fallback, and one ribbon path.**

## Task 7: Field-map scope/revision and lifecycle hardening

**Files:**
- Modify: `apps/control-room/src/modules/field-map/FieldMapModule.tsx`
- Modify: `apps/control-room/src/modules/field-map/renderer/PlanarSurface.tsx`
- Modify: `apps/control-room/src/modules/field-map/renderer/planarColorizer.ts`
- Tests: field-map resource/probe/colorizer/lifecycle tests.

**Interfaces:**
- Consumes the existing `PlanarFieldProbeQuery`, planar field resource cache, occupancy mask and worker lifecycle.
- Produces scope/revision-consistent probe requests and explicit degraded/error state without sharing WebGL resources with `viewport-3d`.

- [ ] **Step 1: Add RED probe tests** requiring scope, stage/snapshot, and revision identity to be forwarded with the raster request.
- [ ] **Step 2: Add RED occupancy-mask test** proving an empty pixel remains empty after worker colorization and hover.
- [ ] **Step 3: Implement stable scope/revision request keys, worker-safe mask ownership, and explicit mask/vector/mesh degraded states.
- [ ] **Step 4: Run field-map tests and idle/lifecycle checks; ensure 2D renderer remains independent from 3D WebGL resources.**

## Task 8: Integration qualification and whole-branch review

**Files:**
- Modify/add only tests, diagnostics, or docs required by findings from Tasks 1–7.
- Update `docs/audits/2026-08-04-fdm-ui-audit.md` status columns/evidence with verified implementation results.

- [ ] **Step 1: Run all focused changed-scope Vitest suites with `env TMPDIR=/tmp pnpm --dir apps/control-room exec vitest run` followed by the explicit changed-file list.**
- [ ] **Step 2: Run `pnpm --dir apps/control-room typecheck` and targeted ESLint over changed files.**
- [ ] **Step 3: Run module/API hygiene searches and relevant resource/contract gates; separate existing baseline failures from new regressions.**
- [ ] **Step 4: Run the required browser smoke/Playwright proof for FDM no-airbox, FDM universe>magnetic-support, and FEM shared-domain: visible canvas, no context loss, non-zero drawing buffer, grid/topology visible, quantity switch and selection.**
- [ ] **Step 5: Generate the whole-branch review package from merge-base and dispatch a final reviewer; fix every Critical/Important finding and re-run coverage.**
- [ ] **Step 6: Inspect `git diff --cached --name-only` separately before any commit; preserve unrelated dirty paths and report exact local/test/browser/runtime qualification boundaries.**

## Final acceptance gates

- P0 browser proof demonstrates FDM mesh/grid rendering and mask semantics before calling the refactor complete.
- FDM no-air and universe>magnetic-support fixtures show no FEM-only mesh policy or misleading shared-domain command.
- FEM shared-domain regressions remain green.
- Every semantic Explorer node has an exact Inspector and stable kernel selection identity.
- Interaction/ribbon/stage commands are capability-scoped and expose reasons for unavailable/deferred paths.
- Requested/resolved execution provenance remains visible and no hidden fallback is introduced.
- Focused tests, typecheck, lint, API/resource hygiene, and browser smoke outputs are recorded in the final handoff.
