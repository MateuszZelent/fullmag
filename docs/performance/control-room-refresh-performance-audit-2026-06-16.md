# Control Room refresh performance and airbox vector regression audit

Date: 2026-06-16
Location: `docs/performance`

Scope:
- `apps/control-room` workspace refresh and cold-start behavior.
- 3D viewport startup cost, resource fanout, lazy-load boundaries, and interaction performance.
- Urgent airbox vector regression found during the audit.

This report is based on current code inspection plus browser and targeted test evidence. It is intentionally focused on real measured bottlenecks rather than generic "frontend is slow" advice.

## Executive summary

The refresh freeze is not caused mainly by the measured 3D render-model build path. In the smoke run, viewport topology and field render-model totals were approximately `0.1 ms`, with no airbox render workload in the startup phase. The visible stall is dominated by JavaScript evaluation and first-screen shell/resource work: `startup-to-canvas` recorded a `640 ms` long task, `17` long animation frames, and `87` session requests before the first useful viewport state.

The app already has module-level lazy loading in `SlotHost`, so the correct diagnosis is not "there is no lazy loading". The problem is that several lazy-loaded modules immediately import very large registries and panels, and the first screen mounts too many always-on data consumers. The largest current offenders are the eager inspector registry, the monolithic ribbon contribution table, app-menu runtime resources, status bar resources, and footer telemetry.

The urgent airbox vector regression had a separate, concrete cause. The developer `Dev +Z vectors` mode disabled real airbox vector fetches and then inserted synthetic +Z data as if it were the real field. That explains the user-visible symptom: nearly uniform vectors, wrong direction, and color driven by current vector styling rather than actual demag data. The fix makes the mode a fallback only; real backend airbox field vectors now have priority.

## Evidence

### Browser smoke, startup phase

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 CONTROL_ROOM_SMOKE_SKIP_CAMERA_GESTURES=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Result: passed, but with severe startup stalls.

Important values:

| Metric | Value | Interpretation |
|---|---:|---|
| startup phase elapsed | `5708.1 ms` | Cold workspace entry is too slow. |
| startup session requests | `87` | Too many first-screen resource consumers. |
| startup long animation frames | `17` | Browser main thread is blocked repeatedly before canvas is stable. |
| max long task | `640 ms` | A single parse/evaluate/render phase can freeze the browser. |
| max long animation frame | `642 ms` | User-visible refresh jank. |
| long-animation-frame blocking time | `1149.853 ms` | Real main-thread contention, not a cosmetic metric. |
| viewport topology model total | about `0.1 ms` | Not the main startup bottleneck in this run. |
| viewport field model total | about `0.1 ms` | Not the main startup bottleneck in this run. |
| vector glyph total | `0 ms` | Airbox/vector rendering was not the startup freeze source in this run. |
| airbox diagnostic count | `0` | Startup measurement did not exercise airbox vector drawing. |

Top invokers in the browser diagnostics included `main-app.js`, the active `viewport-3d` module chunk, the inspector chunk, and unknown framework/script evaluation frames. This points at code loading/evaluation and first-screen module side effects.

Measurement note: the browser smoke was run against the local development server. The exact chunk names and timing thresholds should not be copied 1:1 into a production budget, but the visible failure mode is still valid: refresh blocks the browser main thread before the workspace becomes interactive.

### Browser smoke, camera interaction phase

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace CONTROL_ROOM_SMOKE_ALLOW_MISSING_SESSION=1 pnpm --dir apps/control-room smoke:viewport-3d
```

Result: failed.

Failure:

```text
Camera right-button pan produced long animation frames
longAnimationFrameCount=3
maxLongAnimationFrameMs=64.80000001192093
```

Interpretation: there is a separate interaction-performance bug during camera panning. It should be tracked separately from refresh startup. It is not enough to fix bundle lazy loading and call the viewport done.

### Static and unit gates

Command:

```bash
pnpm --dir apps/control-room audit:idle-performance
```

Result: passed.

Interpretation: this static gate is useful, but insufficient. It checks that the 3D viewport is not obviously running an always-on frame loop, but it does not catch cold-start chunk evaluation or first-screen resource fanout.

Command:

```bash
pnpm --dir apps/control-room test -- --run computePerformanceAuditScript.test.ts useSessionStatus.performance.test.ts useLayout.performance.test.ts useObjectVisualization.performance.test.ts reactRenderProfiler.test.ts browserActivityDiagnostics.test.ts
```

Result: passed. Because of the package script behavior, this ran the full test suite: `253` test files and `2115` tests.

### Memory churn audit

Command:

```bash
CONTROL_ROOM_URL=http://localhost:3100/workspace pnpm --dir apps/control-room audit:viewport-3d-memory-churn
```

Result: passed.

Important values:

| Metric | Value |
|---|---:|
| switches | `24` |
| heap | `58.8 MB -> 59.3 MB` |
| cache | `2.0 MB -> 2.0 MB` |
| geometries | `7 -> 7` |
| frames | `31 -> 218` |
| field requests | `0` |
| fixture requests | `105` |

Interpretation: cached viewport quantity switching did not show unbounded memory growth in this scenario. This does not disprove other leaks in long live sessions, but it means the current refresh freeze should not be blamed on this path without more evidence.

## Current startup architecture

### What lazy loading already does correctly

`apps/control-room/src/kernel/layout/SlotHost.tsx` wraps module components with `React.lazy`, caches the lazy wrapper by manifest id, and renders through `Suspense`. This means the module component boundary is not the missing layer.

Relevant code:

- `SlotHost.tsx:85-93` creates a cached lazy component from `manifest.component`.
- `SlotHost.tsx:109-129` renders the lazy component through the module error boundary.

Therefore the next optimization layer is not "add lazy loading everywhere". The next layer is to remove heavyweight imports from manifests, registries, and default-mounted module entry points.

### Module registry is still eager

`apps/control-room/src/modules/registry.ts` imports all module manifests at top level:

- app menu
- ribbon
- explorer
- viewport 3D
- cross-section image
- analysis plots
- inspector
- footer
- overlay
- status bar

The registry itself is small, but it makes manifest imports part of startup. A manifest must stay declarative and light. If a manifest imports stores, builders, command tables, or domain code, then module lazy loading is undermined.

### Kernel startup registers many command arrays and starts global connectors

`apps/control-room/src/kernel/KernelProvider.tsx` constructs the kernel and registers global command arrays before the workspace is interactive:

- `SHELL_COMMANDS`
- `GEOMETRY_LIFECYCLE_COMMANDS`
- `STUDY_RUNTIME_COMMANDS`
- `MAGNETIZATION_TEXTURE_COMMANDS`
- `REGION_COMMANDS`
- `VISUALIZATION_TARGET_COMMANDS`
- `ANALYSIS_FIELD_OVERLAY_COMMANDS`
- all manifest-contributed commands

It also mounts startup connectors immediately:

- realtime connector
- global shortcut connector
- visualization registry sync connector
- camera registry sync connector
- browser audit connector
- performance diagnostics connector

The global shortcut connector calls `useRuntimeCommandControlResourceData({ enabled: !startupVisible })`, so runtime command resources become part of startup shortly after the startup overlay is gone.

This is architecturally convenient, but it is not cost-controlled. Startup should register cheap command descriptors immediately and lazy-load expensive handlers/resource contexts only when commands are invoked or when the visible module needs them.

## Code anchors

These are the current code locations that support the findings:

| Area | Current behavior | Code anchor |
|---|---|---|
| Module component lazy loading | `SlotHost` wraps module components with `React.lazy`. | `apps/control-room/src/kernel/layout/SlotHost.tsx:85-129` |
| Eager module manifest registry | all module manifests are imported by the central registry. | `apps/control-room/src/modules/registry.ts:7-29` |
| Kernel command registration | global command arrays and manifest commands are registered in kernel creation. | `apps/control-room/src/kernel/KernelProvider.tsx:86-116` |
| Startup connectors | realtime, shortcut, visualization sync, camera sync, audit, and performance connectors mount immediately. | `apps/control-room/src/kernel/KernelProvider.tsx:355-366` |
| Shortcut runtime resources | shortcut connector loads runtime command-control data after startup overlay hides. | `apps/control-room/src/kernel/KernelProvider.tsx:174-200` |
| Inspector eager imports | inspector registry imports common, study, and frequency-domain panels at top level. | `apps/control-room/src/modules/inspector/inspectorRegistry.tsx:3-129` |
| Frequency-domain panel map | all frequency-domain panel descriptors are built eagerly. | `apps/control-room/src/modules/inspector/inspectorRegistry.tsx:239-429` |
| Ribbon monolith | `RibbonModule` imports one `buildRibbonTabContent` from the monolithic contributions file. | `apps/control-room/src/modules/ribbon/RibbonModule.tsx:72` |
| Ribbon resource gating | runtime resource hooks are tab-gated, so the issue is mostly payload splitting, not total absence of gating. | `apps/control-room/src/modules/ribbon/RibbonModule.tsx:172-232` |
| App menu resources | app menu loads runtime command-control and visualization state on mount. | `apps/control-room/src/kernel/layout/AppMenuBar.tsx:353-423` |
| Status bar resources | status bar loads current run, solver status, mesh manifest, and active mesh build after hydration. | `apps/control-room/src/modules/status-bar/StatusBarModule.tsx:47-86` |
| Footer default tab | footer starts on `telemetry`. | `apps/control-room/src/modules/footer/FooterModule.tsx:57-58` |
| Footer telemetry resources | telemetry loads session status, scene, object metrics, and solver status. | `apps/control-room/src/modules/footer/FooterTelemetry.tsx:49-68` |
| Explorer default resources | model tab loads scene, model metadata, mesh resources, stage execution, and optional hysteresis tree. | `apps/control-room/src/modules/explorer/ExplorerModule.tsx:182-256` |
| Airbox real-data priority | real airbox vectors are fetched when vectors or surface color need field data. | `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:1839-1969` |
| Airbox synthetic fallback | synthetic +Z skips any part that already has real field vectors. | `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts:2040-2106` |
| Airbox developer label | inspector now labels the control as `Dev fallback +Z`. | `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx:754-768` |

## Findings

### F1. Eager inspector registry loads too much code on first inspector mount

Severity: high.

`apps/control-room/src/modules/inspector/inspectorRegistry.tsx` imports almost every panel at top level. The largest issue is the frequency-domain group:

- `FrequencyDomainResultInspectors.tsx`: about `233 KB`.
- `FrequencyDomainInspectorPanel.tsx`: about `122 KB`.

The registry imports more than 70 frequency-domain/study/result inspector components and then builds all frequency-domain panel descriptors. This means selecting nothing, or selecting a simple geometry node, still pays for frequency-domain result inspector code once the inspector module chunk is loaded.

This directly matches the browser trace where the inspector chunk appears in startup long-frame attribution.

Required fix:

1. Convert `InspectorPanelContribution` from an eager `component` contract to a lazy resolver contract, for example:

   ```ts
   type InspectorPanelContribution = {
     id: string;
     title: string;
     selectionKinds: string[];
     loadComponent: () => Promise<{ default: InspectorPanelComponent }>;
   };
   ```

2. Keep tiny panels eager only if they are needed on the default first screen.
3. Split frequency-domain inspectors into separate dynamic modules by family:
   - eigen study/stage inspectors
   - eigen result inspectors
   - FMR result inspectors
   - frequency-response result inspectors
   - diagnostics/resource inspectors
4. Render the selected inspector through `Suspense`.
5. Add a test proving that importing `inspectorRegistry.tsx` does not import `FrequencyDomainResultInspectors.tsx`.

Acceptance criteria:

- Opening `/workspace` with no frequency-domain selection must not evaluate `FrequencyDomainResultInspectors.tsx`.
- Startup smoke should no longer attribute cold-start long frames to the inspector chunk.
- Selecting a frequency-domain node must still render the exact dedicated inspector for that node.

### F2. Ribbon contributions are monolithic and evaluated too early

Severity: high.

`apps/control-room/src/modules/ribbon/RibbonModule.tsx` imports `buildRibbonTabContent` from `ribbonContributions.tsx`.

`ribbonContributions.tsx` is about `155 KB` and includes many icons, command layouts, and domain-specific UI builders. The runtime resource hooks inside `RibbonModule` are already tab-gated, which is good, but the contribution code itself is not tab-split.

Required fix:

1. Split `ribbonContributions.tsx` by top-level tab:
   - `ribbonContributions.view.tsx`
   - `ribbonContributions.geometry.tsx`
   - `ribbonContributions.mesh.tsx`
   - `ribbonContributions.study.tsx`
   - `ribbonContributions.results.tsx`
   - other tabs as needed
2. Replace `buildRibbonTabContent(activeTab, ctx)` with an async tab-content loader cached by tab id.
3. Prefetch the next likely tab on hover/focus, not during workspace mount.
4. Keep `RIBBON_TABS` light and static.

Acceptance criteria:

- Initial workspace load evaluates only the active tab contribution module.
- Switching tabs shows a bounded loading state if needed.
- Startup chunk size and long tasks drop measurably.

### F3. App menu fetches runtime and visualization resources unconditionally

Severity: high.

`apps/control-room/src/kernel/layout/AppMenuBar.tsx` does the following during header mount:

- `useRuntimeCommandControlResourceData()`
- `useVisualizationStateResource({ enabled: true })`
- subscribes to `kernel.visualizationSync`
- builds a command context from runtime data
- uses command enable/active checks for visible menus and quick actions

This makes the application menu a resource consumer even when the user never opens a menu or runs a command. A header needs only a very small session summary at cold start.

Required fix:

1. Split header display state from command execution state.
2. Load runtime command control resources only when:
   - a runtime command dropdown opens,
   - a run-control button is pressed,
   - the command palette opens,
   - or a command explicitly requires runtime resources.
3. Load visualization state only when the registry inspector opens or a visible header control actually needs visualization sync data.
4. For disabled state of quick actions, use cheap session selectors where possible.

Acceptance criteria:

- App menu first render should not issue simulation command-control resource requests.
- The registry inspector still shows full visualization state when opened.
- Runtime command buttons still validate correctly before execution.

### F4. Status bar performs duplicate runtime and mesh resource loading on cold start

Severity: medium-high.

`apps/control-room/src/modules/status-bar/StatusBarModule.tsx` subscribes to several session status selectors, then also loads:

- current run
- solver status
- mesh shared-domain manifest
- mesh build current

For a status bar, this is too much for cold start. It should show a lightweight session state first and hydrate detailed mesh/runtime labels after the viewport is stable.

Required fix:

1. First paint: use only `useSessionStatusSelector`.
2. Defer current-run, solver-status, mesh-manifest, and mesh-build-current requests with an idle/post-canvas gate.
3. Reuse resource data already fetched by visible modules where possible.
4. If exact mesh status is unavailable, show a compact "mesh pending" state rather than blocking startup.

Acceptance criteria:

- Status bar initial render must not add more than one session-status subscription to startup.
- Detailed status appears after first canvas without shifting layout.

### F5. Footer telemetry is the default bottom tab and loads live resources immediately

Severity: medium-high.

`apps/control-room/src/modules/footer/FooterModule.tsx` defaults to `activeTab = "telemetry"`. This mounts `FooterTelemetry` immediately.

`FooterTelemetry.tsx` then loads:

- session status selector
- scene resource
- object metrics resource
- solver status resource
- live scalar sample subscription

This is valuable during a running simulation, but expensive and unnecessary during page refresh. The footer is also below the primary workspace and should not compete with the 3D viewport for first paint.

Required fix:

1. Change default footer tab to a cheap log/summary tab, or render telemetry as a skeleton until after first canvas.
2. Gate `FooterTelemetry` resource hooks behind a footer-visible/after-idle condition.
3. Keep live scalar sample subscription off until telemetry is visible.

Acceptance criteria:

- Cold start does not fetch scene/object metrics from footer telemetry.
- Switching to telemetry still shows live data within a bounded delay.

### F6. Explorer model tab loads many resources at once

Severity: medium.

`ExplorerModule.tsx` correctly gates resources by active tab, but the default `model` tab still reads a large set:

- scene
- regions
- material fields
- couplings
- mesh summary
- current/latest mesh build
- shared-domain manifest
- quality gates
- realized size fields
- stage execution
- optional hysteresis execution tree

It then builds a combined tree snapshot and filters it on every relevant data change.

This is not obviously wrong, because Explorer is a first-screen panel. But it needs a budget. The default visible tree should prioritize the minimal model/study skeleton and load expensive details on expansion.

Required fix:

1. Build first Explorer tree from thin session status + scene only.
2. Lazy-load mesh quality, realized size fields, and detailed mesh manifest when the mesh subtree is expanded.
3. Lazy-load stage execution details when the study subtree is expanded or when a run is active.
4. Add a resource-count budget for the Explorer default tab.

Acceptance criteria:

- Default Explorer startup request count drops without removing visible top-level nodes.
- Expanding Mesh or Study loads the detailed resources on demand.

### F7. Module manifests must be kept declarative

Severity: medium.

The current registry imports all manifests eagerly. That is acceptable only if manifests are tiny metadata objects. Any manifest that imports a store, builder, heavy command list, or runtime policy effectively becomes startup code.

Required fix:

1. Audit every module `manifest.ts`.
2. Keep each manifest to:
   - id
   - title
   - slot
   - component lazy import
   - small static metadata
3. Move contributed commands to lazy command factories if they bring heavy code.
4. Add a static test that prevents manifest imports from pulling known heavy modules.

Acceptance criteria:

- `modules/registry.ts` can be imported without importing inspector panels, ribbon contribution tables, viewport render model code, or frequency-domain result UI.

### F8. Current performance gates miss the actual failure mode

Severity: high.

`audit:idle-performance` passed, but real browser smoke still showed a `640 ms` long task during startup. This means the current gate checks a necessary condition, not the actual product risk.

Required fix:

Add a dedicated startup budget gate:

```text
workspace-startup:
  maxLongTaskMs <= 200 ms
  maxLongAnimationFrameMs <= 250 ms
  longAnimationFrameCount <= 5
  startupSessionRequestCount <= configured budget
  startupToCanvasMs <= configured budget
  topScriptAttribution recorded in artifact
```

The exact thresholds can be relaxed for dev mode initially, but they must exist and trend down.

Threshold note: development and production builds need separate budgets. The first implementation should record both and enforce a warning-level dev budget before making it a hard CI failure.

Acceptance criteria:

- CI or local audit fails when startup regresses into multi-hundred-ms long tasks.
- The artifact lists the top script/chunk contributors.

### F9. Camera pan has a separate interaction-performance regression

Severity: medium-high.

Full viewport smoke without skipping camera gestures failed because right-button pan produced long animation frames.

This is not the same as refresh freeze. It likely sits in one of these paths:

- OrbitControls/change invalidation
- ViewCube or orientation HUD updates
- diagnostics/profiler updates during interaction
- layout/store subscriptions triggered by camera state
- synchronous resource or bounds work triggered by camera changes

Required fix:

1. Add per-phase instrumentation for camera pointer down, move, and up.
2. Record frame duration and top JS attribution during right-button pan.
3. Verify whether store updates are firing on every pointer move.
4. Batch camera registry writes so they do not run per pointer move.

Acceptance criteria:

- Browser smoke without `CONTROL_ROOM_SMOKE_SKIP_CAMERA_GESTURES=1` passes.
- Right-button pan stays under the long-animation-frame threshold.

### F10. The urgent airbox vector regression was a real data-priority bug

Severity: critical for visualization correctness.

Observed symptom:

- airbox vectors appeared
- almost all vectors had a uniform wrong color
- direction looked uniform/wrong
- field no longer represented real demag/airbox vector data

Root cause:

The developer synthetic vector mode was implemented as if it were a replacement for backend data:

1. It disabled real airbox vector loading when enabled.
2. It inserted synthetic +Z vectors into `partFieldVectors` after real data merge.
3. The renderer then drew the synthetic field using current vector styling.

That explains why the viewport showed a uniform artificial field instead of the real field.

Applied fix:

- `airboxFieldVectorEnabled` now stays true whenever vectors or surface color need airbox field data.
- Synthetic airbox +Z is now a fallback only.
- If a real part field vector exists for an airbox part, synthetic data is skipped.
- The inspector label is now `Dev fallback +Z`, making the behavior explicit.

Relevant files:

- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts`
- `apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts`
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx`
- `apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts`

Verification already run:

```bash
pnpm --dir apps/control-room exec vitest run \
  src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
  src/modules/viewport-3d/viewport3dRenderModel.test.ts \
  src/modules/viewport-3d/viewport3dResources.test.ts \
  src/modules/viewport-3d/airboxFieldRoutingSmokeScript.test.ts \
  src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts \
  src/kernel/visualization/ObjectVisualizationController.test.ts
```

Result: passed, `6` files, `177` tests.

Also passed:

```bash
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
git diff --check -- \
  apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.ts \
  apps/control-room/src/modules/viewport-3d/hooks/useViewport3DSceneModel.test.ts \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.tsx \
  apps/control-room/src/modules/inspector/panels/ObjectVisualizationPanel.performance.test.ts
```

Live `curl` against `localhost:3100` could not decode the current field payload because that port refused the connection during the CLI check. The code-level bug was still deterministic and covered by targeted tests.

## Proposed remediation plan

### Milestone 1: Add a real startup budget gate

Goal: make the refresh freeze impossible to miss.

Tasks:

1. Extend the existing viewport smoke or add `audit:workspace-startup`.
2. Record:
   - startup-to-canvas elapsed time
   - long task max
   - long animation frame max
   - long animation frame count
   - startup session request count
   - top script/chunk attribution
3. Save the raw JSON artifact under a deterministic audit path.
4. Add a text summary to Thread Manager or logs for local debugging.

Verification:

- Run against `/workspace`.
- Confirm current build fails or reports warning-level failure with the known `640 ms` long task.
- After later milestones, require the gate to pass.

### Milestone 2: Lazy inspector panels

Goal: do not evaluate frequency-domain/study/result inspector code until the selected node requires it.

Tasks:

1. Introduce lazy inspector contribution type.
2. Convert `resolveInspectorPanel` to return metadata plus a lazy component loader.
3. Split frequency-domain panels by family.
4. Keep placeholder and common object panels light.
5. Add tests that import `inspectorRegistry.tsx` and assert heavy modules are not imported.

Verification:

- Open workspace with no selection and check startup chunks.
- Select a normal object node.
- Select a frequency-domain node.
- Confirm correct inspector renders in each case.
- Confirm startup long-frame attribution no longer names the inspector chunk.

### Milestone 3: Split ribbon contributions by active tab

Goal: the active ribbon tab should be the only ribbon payload on refresh.

Tasks:

1. Split `ribbonContributions.tsx` by tab.
2. Add a cached async tab contribution loader.
3. Keep tab strip static.
4. Add tab switch loading fallback.
5. Prefetch on tab hover/focus.

Verification:

- Initial workspace load evaluates only the active tab module.
- Switching each tab still produces the same command groups.
- Startup smoke shows smaller JS evaluation stalls.

### Milestone 4: Reduce first-screen resource fanout

Goal: lower startup request count before the viewport is stable.

Tasks:

1. App menu:
   - keep session display cheap
   - lazy-load runtime command control data
   - lazy-load visualization state for registry dialog
2. Status bar:
   - render first from session status only
   - defer detailed solver/mesh resources
3. Footer:
   - avoid telemetry as a cold-start data consumer
   - gate telemetry resources by active/visible/after-idle state
4. Explorer:
   - load mesh quality and detailed stage execution on expansion, not initial model tab where possible.

Verification:

- Startup session request count drops from the measured `87`.
- First canvas appears with no layout jump.
- Runtime controls still validate before command execution.

### Milestone 5: Fix camera pan long frames

Goal: make real viewport interaction smooth, not only initial render.

Tasks:

1. Add a dedicated camera interaction performance trace.
2. Inspect pointer move -> camera store -> registry sync path.
3. Batch or defer camera registry persistence.
4. Ensure diagnostics/profiling UI does not re-render per pointer move.

Verification:

- Run full viewport smoke without `CONTROL_ROOM_SMOKE_SKIP_CAMERA_GESTURES=1`.
- Right-button pan passes long-frame threshold.

### Milestone 6: Keep memory monitoring, but do not confuse it with startup freeze

Goal: preserve memory diagnostics while fixing the actual refresh cause.

Tasks:

1. Keep `audit:viewport-3d-memory-churn`.
2. Add longer live-session memory budgets separately.
3. Track resource cache sizes and Three.js geometry/texture counts in Thread Manager.
4. Do not block startup fixes on a speculative leak unless new evidence shows heap growth during refresh.

Verification:

- Quantity switching audit remains bounded.
- Long live-session memory audit can identify cache growth by subsystem.

## Non-findings

These are important because they prevent chasing the wrong path:

1. Module-level lazy loading is already present. The missing optimization is lazy registry/panel/command payload loading.
2. The measured 3D render-model build path was not the startup bottleneck in the smoke run.
3. Cached quantity switching did not show unbounded heap/cache growth in the memory-churn audit.
4. The airbox vector regression was not a backend demag physics issue. It was a frontend data-priority bug introduced by the developer synthetic vector mode.
5. Passing `audit:idle-performance` does not prove acceptable startup performance.

## Second-pass corrections after rereading code

After writing the initial diagnosis, the code was rechecked against the main claims. These corrections are now part of the report:

1. Replace the broad phrase "missing lazy load" with the more precise claim: module components are lazy, but registries, manifests, inspector panels, and ribbon contribution payloads still pull too much code into the cold path.
2. Do not blame `viewport3dRenderModel.ts` for refresh freeze based on the current evidence. The smoke metrics show it was cheap in the measured startup run.
3. Do not claim the airbox vector issue is caused by field normalization or backend magnitude. The deterministic bug was synthetic +Z data taking priority over real data.
4. Keep camera pan as a separate regression from refresh startup. It has its own smoke failure and needs its own trace.
5. Treat footer telemetry and status bar resource reads as product/UX tradeoffs, not simply "bad code". They are useful, but their default timing is wrong for first paint.
6. Treat dev-server timing values as regression evidence, not final production thresholds. The gate must record build mode and compare against the matching budget.

## Immediate next code changes recommended

Order matters:

1. Land and keep the airbox fallback fix.
2. Add the startup budget gate so the refresh freeze is measured in every local verification pass.
3. Lazy-load inspector panels, especially frequency-domain result inspectors.
4. Split ribbon contributions by active tab.
5. Defer app-menu/status-bar/footer noncritical resources until after first canvas or user intent.
6. Fix camera pan long frames with a dedicated interaction trace.

The highest-confidence first implementation is lazy inspector panels, because the current eager imports are explicit, large, and directly visible in the startup chunk path. The safest parallel implementation is the startup budget gate, because it changes diagnostics rather than product behavior and will make all later improvements measurable.
