# Control Room Frontend Audit - 2026-05-30

## Scope

Audited frontend: `apps/control-room`.

Primary change surface reviewed:

- removal of the legacy `viewport-2d` module;
- new `ViewportTabHost` center-surface lifecycle;
- new `cross-section-image` module and resource/API path;
- new `analysis-plots` module;
- ribbon, explorer, inspector, layout, resource, generated API, design styles, smoke scripts, and frontend-v2 specs affected by the change.

The audit used both whole-tree mechanical scans and targeted manual review of the files that own runtime behavior. Generated OpenAPI artifacts were included for contract drift checks and excluded from style/hardcode rankings where they would dominate the results without adding frontend design signal.

## Evidence Collected

Inventory:

- 474 frontend files under `apps/control-room` after excluding `node_modules`, `.next`, and `tsconfig.tsbuildinfo`.
- 139,688 total lines in that same inventory, dominated by generated API JSON/types.
- Current tracked diff over `apps/control-room` plus related frontend specs: 100 files, 939 insertions, 3,737 deletions. This does not include untracked new modules such as `src/modules/analysis-plots`, `src/modules/cross-section-image`, and `src/kernel/layout/ViewportTabHost.tsx`.

Verification:

| Command | Result |
|---|---|
| `pnpm --dir apps/control-room run check:architecture-hygiene` | pass |
| `pnpm --dir apps/control-room run check:api-hygiene` | pass |
| `pnpm --dir apps/control-room test` | pass, 171 files / 972 tests |
| `pnpm --dir apps/control-room lint` | pass, with Babel deopt warning for `src/shared/brand/FullmagLogoVector.tsx` |
| `pnpm --dir apps/control-room typecheck` | pass |
| `pnpm --dir apps/control-room build` | pass outside sandbox; sandboxed run failed on Turbopack process/port restriction |
| `pnpm --dir apps/control-room smoke:cross-section-workflow` | fail |

The smoke failure is real runtime evidence, not a compile-only concern:

```text
Error: Inspector cross-section draft editor timed out after 20000ms.
Last error: text=InspectorNo selectionSelect an explorer node.
```

## Executive Assessment

The center-tab architecture is directionally sound: `ViewportTabHost` mounts only the active `viewport-main` manifest, API access is still centralized, architecture/API hygiene checks pass, and the production build succeeds.

However, this frontend should not be treated as merge-ready. The current runtime smoke for the new cross-section workflow fails, and several user-facing controls now advertise behavior that is not actually represented by the server-rendered PNG path. The most serious issues are correctness and validation gaps around the `viewport-2d` replacement, not basic TypeScript/lint health.

## Findings

### F-01 - P0 - Cross-section workflow smoke fails after `2D Cross`

Evidence:

- `apps/control-room/scripts/smoke-cross-section-workflow.mjs:80-101` clicks `ribbon.cross-section.begin-draft`, waits for the draft row, then waits for inspector text `Cut Frame`.
- Runtime result: the draft row appears, but the inspector remains `No selection`.
- `apps/control-room/src/modules/ribbon/ribbonCommands.ts:347-367` intends to call `context.selection?.set(...)` with `kind: "mesh.cross-section.draft"`.
- `apps/control-room/src/modules/inspector/inspectorRegistry.tsx:92-99` registers `mesh.cross-section.draft` to `CrossSectionInspectorPanel`.
- `apps/control-room/src/modules/inspector/InspectorModule.tsx:17-25` renders the observed `No selection` state only when the selection has no registered panel.

Impact:

The primary user path for creating a cross-section image is broken in the browser. Users can click the ribbon action and see explorer state change, but the editor workflow does not become active. This also means the smoke never reaches image generation, tab behavior, or download validation.

Recommendation:

Debug command execution and selection propagation for `ribbon.cross-section.begin-draft`. Add a regression assertion that the selection snapshot becomes `mesh.cross-section.draft` after the action, before the smoke proceeds to form editing.

### F-02 - P1 - Scalars chart plots `time`, not a scalar

Evidence:

- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx:15-16` loads energy history and scalar window.
- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx:101-113` chooses the first column where `column !== "step"`.
- `crates/fullmag-api/src/router_v2/handlers/data/scalars.rs:61-94` returns default columns in this order: `step`, `time`, `solver_dt`, `mx`, `my`, `mz`, ..., `e_total`.

Impact:

The `Scalars` card will default to `time` as the y value and label the chart `sample / time`. That is misleading as an analysis plot and hides the useful scalar series users expect.

Recommendation:

Request explicit scalar columns from the hook, or exclude axis/metadata columns (`step`, `time`, `solver_dt`) before choosing a default. Prefer a user-selectable scalar with a deterministic fallback such as `e_total`, `mx`, or the first physical observable present.

### F-03 - P1 - Ribbon still exposes stale live-2D controls after deleting `viewport-2d`

Evidence:

- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:719-930` still defines a large `2D Slice` group with Quantity, Vectors, Airbox, Layers, Quality, and Plane controls.
- `apps/control-room/src/modules/ribbon/ribbonContributions.tsx:2269-2465` wires the dynamic 2D slice menus to `RIBBON_VISUALIZATION_PATCH_STATE_COMMAND`, i.e. the old `visualizationState.slice` path.
- `apps/control-room/src/modules/index.ts` no longer registers `viewport-2d`; the new center modules are `cross-section-image` and `analysis-plots`.
- `docs/adr/0016-center-viewport-tabbed-surfaces.md:35-40` explicitly requires replacing `viewport-2d` registration and commands with cross-section image commands.

Impact:

Users can change controls that no longer have a live 2D viewport implementation behind them. Some settings affect the 3D cut frame, while others do not feed the PNG request at all. This creates false affordances and makes support/debugging difficult.

Recommendation:

Replace the stale 2D slice group with controls that map directly to the cross-section draft/image query, or hide/disable unsupported live-2D controls with an explicit product decision. The ribbon should not expose controls that only mutate retired state.

### F-04 - P1 - Cross-section rotation is displayed and persisted but not used by image generation

Evidence:

- `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.tsx:133-162` exposes `Rotation`.
- `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts:252-282` persists `rotationDegrees` and `frameRotationDegrees` on the saved plot.
- `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.tsx:104-117` sends `colorScale`, `filterExpression`, `metric`, `plane`, `positionPercent`, `resolution`, `shrinkFactor`, and `wireframe`, but not rotation.
- `apps/control-room/src/kernel/api/apiTypes.ts:52-62` has no rotation field in `CrossSectionImageQuery`.
- `apps/control-room/src/modules/inspector/panels/CrossSectionDraftEditor.tsx:237-247` omits `rotationDegrees` from `draftPatchAffectsFrame`, so changing rotation does not queue the same visualization sync path as plane/position/metric.

Impact:

The UI can show `Universe / 17 deg` while the generated PNG is still axis-aligned. This is a silent correctness bug: the saved plot metadata and rendered artifact disagree.

Recommendation:

Either remove/label rotation as 3D-preview-only, or add rotation to the backend image query, generated OpenAPI types, cache key normalization, `CrossSectionImageModule`, and smoke assertions.

### F-05 - P1 - ADR-required non-3D tab memory/canvas validation is missing

Evidence:

- `docs/adr/0016-center-viewport-tabbed-surfaces.md:40` requires browser smoke and memory audits proving non-3D tabs have no mounted 3D canvas, no `Viewport3DModule` render measures, no 3D-only resource loads, and no 3D client acknowledgements.
- `apps/control-room/scripts/smoke-cross-section-workflow.mjs:76-78` starts by waiting for `.fm-viewport-3d canvas`.
- `apps/control-room/scripts/smoke-cross-section-workflow.mjs:156-174` validates PNG visibility and that the PNG resource was requested, but does not assert zero 3D canvas nodes after switching to cross-section image.
- `apps/control-room/package.json:8-25` has 3D memory/profile audits and `smoke:cross-section-workflow`, but no replacement center-tab memory audit for the retired `audit:viewport-2d-cross-section-performance`.

Impact:

The architecture claim that non-3D center tabs unload 3D work is not proven by CI. A regression could keep the WebGL canvas or 3D data hooks alive while cross-section/image tabs are active and still pass the current unit suite.

Recommendation:

Add a browser audit that switches among `3D Scene`, `Cross-Section`, and `Analysis`, then asserts DOM canvas counts, performance measures, resource request families, and visualization client acknowledgements per tab.

### F-06 - P2 - Design token drift: undefined CSS variables are used

Evidence:

- `apps/control-room/src/design/styles/analysis-plots.css:20` uses `var(--fm-bg-surface)`.
- `apps/control-room/src/design/styles/theme.css:6-38` and `:45-77` define background tokens, but not `--fm-bg-surface`.
- Whole-style scan also found undefined tokens used by existing styles: `--fm-bg-elevated`, `--fm-bg-hover`, `--fm-bg-muted`, `--fm-border-muted`, `--fm-font-size-2xs`, `--fm-mesh-build-progress`, `--fm-refresh-progress`, and `--depth`.

Impact:

The new analysis plot panel background falls back to transparent. Existing undefined tokens indicate design-system drift that can produce theme-specific visual bugs without TypeScript or lint failures.

Recommendation:

Add a CSS token validation test that extracts `var(--*)` uses and fails unless the token is defined or explicitly allowed as a local/custom-property input such as `--pct`.

### F-07 - P2 - Module root error boundaries are still absent

Evidence:

- `docs/specs/frontend-v2/01-module-kernel-architecture.md:8-19` says the kernel owns error boundaries around module roots.
- `apps/control-room/src/kernel/layout/SlotHost.tsx:60` wraps modules in `Suspense`, but there is no `ErrorBoundary`.
- A direct source search for `ErrorBoundary`, `componentDidCatch`, and `getDerivedStateFromError` under `apps/control-room/src` returned no implementation.

Impact:

A render exception in any lazy module can tear down more of the shell than intended. This matters more now that center tabs mount heterogeneous surfaces with independent data dependencies.

Recommendation:

Add a kernel-owned module root boundary around `MountedModule`, record module id/slot diagnostics, and provide a contained retry/remount action.

### F-08 - P2 - Cross-section draft name cannot be cleared while editing

Evidence:

- `apps/control-room/src/kernel/workspace/crossSectionWorkspace.ts:285-293` sanitizes every draft update with `name: draft.name.trim() || DEFAULT_DRAFT.name`.
- The draft editor uses a controlled input, so deleting the field immediately restores `Draft Cross-Section`.

Impact:

This is a small but visible UX defect. Users cannot temporarily clear the field to type a replacement from scratch.

Recommendation:

Allow the in-progress draft name to be empty and apply the fallback only on commit or blur.

### F-09 - P2 - Analysis tab fetches runtime data unconditionally when mounted

Evidence:

- `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx:15-16` calls both `useSolverEnergyHistoryResource(240)` and `useScalarWindowResource({ limit: 240 })` without status gating.
- `apps/control-room/src/kernel/resources/studyRuntimeResources.ts:295-309` already exposes `shouldLoadRuntimeScalars`, which gates scalar loading on a positive `scalars_revision`.

Impact:

Opening the analysis tab can issue avoidable requests when no scalar data exists yet. This is lower risk than the workflow break, but it conflicts with the resource-first/status-revision pattern used elsewhere.

Recommendation:

Use the session status selector and pass `enabled` to analysis resources until the relevant revision is present. Render an empty state from status rather than using failed/empty resource calls as control flow.

### F-10 - P2 - Object URL lifecycle is implemented but not directly tested

Evidence:

- `apps/control-room/src/modules/cross-section-image/CrossSectionImageModule.tsx:120-135` creates and revokes a blob URL.
- `docs/adr/0016-center-viewport-tabbed-surfaces.md:44-46` requires frontend API/resource tests to cover `URL.revokeObjectURL`.
- Source search found `URL.revokeObjectURL` in implementation paths, but no dedicated test assertion for cross-section image revocation.

Impact:

The code is currently correct by inspection, but the exact lifecycle requirement can regress without a test failure.

Recommendation:

Extract `useObjectUrl` or test `CrossSectionImageModule` with mocked `URL.createObjectURL` / `URL.revokeObjectURL` and data changes/unmount.

### F-11 - P3 - Frontend file-size governance is not enforced on several active files

Evidence:

- `docs/specs/frontend-v2/01-module-kernel-architecture.md:179-187` sets hard review thresholds: React component 250 lines, kernel service 300 lines, viewport renderer 400 lines.
- Current line counts include:
  - `src/modules/ribbon/ribbonContributions.tsx`: 4,291 lines;
  - `src/kernel/api/ControlRoomApi.ts`: 1,728 lines;
  - `src/modules/viewport-3d/Viewport3DModule.tsx`: 823 lines.
- `src/modules/ribbon/ribbonContributions.tsx` is also part of this change surface, so its existing size now directly affects the 2D replacement work.

Impact:

The ribbon is difficult to audit precisely because static data, command wiring, menu normalization, runtime dynamic builders, and multiple feature domains live in one file. This contributed to stale 2D controls surviving the `viewport-2d` removal.

Recommendation:

Do not block the current fix solely on broad refactoring, but split the touched ribbon 2D/cross-section group into a focused contribution module before adding more center-surface behavior.

### F-12 - P3 - Very large inline logo asset slows tooling

Evidence:

- `pnpm --dir apps/control-room lint` passed but emitted Babel's deoptimization warning for `src/shared/brand/FullmagLogoVector.tsx`.
- `src/shared/brand/FullmagLogoVector.tsx` is 1,048,440 bytes despite being only 58 lines.

Impact:

This does not break runtime behavior, but it slows lint/build transforms and adds noise to verification output.

Recommendation:

Move the logo to a static SVG asset or a smaller generated component, and keep the React wrapper thin.

## Positive Findings

- `apps/control-room/src/kernel/layout/ViewportTabHost.tsx:24-85` renders only the active `viewport-main` module via one keyed `MountedModule`.
- Layout tests cover active fallback and inactive module behavior through `ViewportTabHost.test.tsx`.
- API access for the new image endpoint is centralized through generated OpenAPI path/types and `ControlRoomApi`; direct component `fetch()` was not found in the new modules.
- `useObjectUrl` revokes the previous blob URL on data changes/unmount by inspection.
- Architecture hygiene, API hygiene, lint, typecheck, unit tests, and production build all pass.

## Recommended Fix Order

1. Fix F-01 first and make `smoke:cross-section-workflow` pass again.
2. Add the missing ADR center-tab audit from F-05 before claiming the 2D replacement is performance-complete.
3. Fix correctness mismatches F-02, F-03, and F-04 before exposing the new tabs as user-ready.
4. Add token validation and object URL lifecycle tests for F-06 and F-10.
5. Split the ribbon cross-section/2D contribution enough that future changes are auditable.

## Current Readiness

Not merge-ready for the cross-section/analysis replacement as-is. The compile/test baseline is strong, but the browser workflow and ADR-specific lifecycle proof are not yet acceptable.
