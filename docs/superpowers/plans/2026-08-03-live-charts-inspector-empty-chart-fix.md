# Live Charts Inspector and Empty Chart Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure entering `Live Charts` automatically selects the chart and opens a useful Inspector, while stale series preferences can never make a data-bearing chart render blank.

**Architecture:** `live-charts` remains the owner of live resource composition and preferences. The kernel selection/layout/command boundaries expose only small identifiers and commands to the Inspector; the Inspector does not import the module. A pure series-selection resolver maps persisted aliases to current resource series and preserves an intentional zero-series selection.

**Tech Stack:** Next.js 16, React, TypeScript, Vitest, Testing Library, Playwright smoke, kernel `SelectionController`/`LayoutController`/`CommandRegistry`, resource hooks, shared shadcn-style primitives.

## Global Constraints

- No new endpoint, polling loop, WebSocket snapshot, or direct component transport.
- HTTP v2 resources remain authoritative; realtime only invalidates resource revisions.
- `live-charts` and `inspector` must not import one another's internals.
- Server rows and decoded arrays remain in resource hooks/adapters, never in workspace stores or local storage.
- An explicit empty `selectedSeriesIds` remains valid and renders `Select at least one signal`.
- All changed CSS classes use the `fm-` prefix and `--fm-*` tokens.
- Preserve unrelated dirty changes in `.superpowers/sdd/*` and any other worktree paths.

---

### Task 1: Reproduce the two reported regressions with focused tests

**Files:**
- Modify: `apps/control-room/src/modules/live-charts/LiveChartsModule.test.tsx`
- Modify: `apps/control-room/src/modules/live-charts/LiveChartsModule.resource.integration.test.tsx`
- Create: `apps/control-room/src/modules/live-charts/liveChartsSelection.test.ts`

**Interfaces:**
- Consumes: current `createLiveChartSelectionHandlers`, `LiveChartSurface`, and resource harness.
- Produces: failing assertions for mount-time selection, stale series aliases, and zero-selection rendering.

- [ ] **Step 1: Write a pure resolver regression test**

Add a test fixture with current IDs `data.table:default:step:mx` and `data.table:default:step:my`, persisted IDs `['mx', 'missing']`, and assert only the current `mx` ID is selected. Add a second test asserting persisted `['missing']` falls back to preset defaults when the preset has defaults, while persisted `[]` stays `[]`.

- [ ] **Step 2: Write the mount-time Inspector regression test**

Mount the Live Charts module harness with an empty selection and a layout controller, then assert the effect selects `kind: 'live.chart'`, sets `panelVisible.right` to `true`, and focuses `panel-right` without requiring a legend click.

- [ ] **Step 3: Write the empty-selection rendering regression test**

Render `LiveChartSurface` with data-bearing series and `selectedSeriesIds={[]}`. Assert it contains `Select at least one signal` and does not create a chart canvas. Render it with a stale non-empty selection after resolver normalization and assert the visible series remains data-bearing.

- [ ] **Step 4: Run only these tests and verify RED**

Run:

```bash
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run \
  src/modules/live-charts/LiveChartsModule.test.tsx \
  src/modules/live-charts/LiveChartsModule.resource.integration.test.tsx \
  src/modules/live-charts/liveChartsSelection.test.ts --pool=threads
```

Expected: the new mount and stale-ID assertions fail before production code changes.

---

### Task 2: Make Live Charts selection and data rendering robust

**Files:**
- Create: `apps/control-room/src/modules/live-charts/liveChartsSelection.ts`
- Modify: `apps/control-room/src/modules/live-charts/useLiveChartsController.ts`
- Modify: `apps/control-room/src/modules/live-charts/LiveChartsModule.tsx`
- Modify: `apps/control-room/src/modules/live-charts/components/LiveChartSurface.tsx`

**Interfaces:**
- Produces:

```ts
export interface LiveChartSeriesIdentity {
  id: string;
  quantity: string;
}

export function resolveLiveChartSelectedSeriesIds(
  persistedIds: readonly string[],
  available: readonly LiveChartSeriesIdentity[],
  defaultIds: readonly string[],
): string[];
```

- [ ] **Step 1: Implement the smallest pure resolver**

Match persisted values by exact `id`, exact `quantity`, or the final colon-delimited column id. Preserve `[]`. If the persisted list is non-empty but resolves to no current series, resolve the preset defaults against the current series; for a preset with no defaults, return `[]`.

- [ ] **Step 2: Use the resolver in the controller**

Replace the inline `flatMap` selection logic with `resolveLiveChartSelectedSeriesIds`. Keep `series` equal to all available series so the legend can display every option, while `selectedSeriesIds` contains only canonical current IDs.

- [ ] **Step 3: Select and open the Inspector on module entry**

In `LiveChartsModule`, add an idempotent effect that selects the current descriptor's chart when the current selection is not a `live.chart` or `live.chart-point`, calls `kernel.layout.setPanelVisible('right', true)`, and focuses `panel-right`. On cleanup it must not clear or overwrite a later selection.

- [ ] **Step 4: Verify Task 2 GREEN**

Rerun the Task 1 command. Expected: all focused tests pass, including the stale-ID and mount-time Inspector cases.

---

### Task 3: Add Inspector controls through the kernel command boundary

**Files:**
- Modify: `apps/control-room/src/modules/live-charts/liveChartsCommandRequests.ts`
- Modify: `apps/control-room/src/modules/live-charts/manifest.ts`
- Modify: `apps/control-room/src/modules/inspector/panels/LiveChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/LiveChartInspectorPanel.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`
- Modify: `apps/control-room/src/kernel/workspace/liveChartPreferences.ts` (only if a read-only selector is required by the existing store boundary)

**Interfaces:**
- Produces command requests for `set-preset`, `set-live-mode`, `toggle-series`, `select-all-series`, and `set-range`.
- Inspector reads only the compact preference snapshot and preset metadata; it does not import `live-charts` components or resource hooks.

- [ ] **Step 1: Add failing Inspector control assertions**

Render the Live Chart panel for a chart selection and assert visible controls for preset, Follow/Pause, `mx`, `my`, `mz`, Select all, and range. Assert clicking a series control requests a kernel command and does not call a transport facade.

- [ ] **Step 2: Implement typed command requests and manifest contributions**

Extend the existing request union and mounted controller handling. Each command updates the module preference after the active module consumes it; Inspector actions never call `fetch` or a module callback prop.

- [ ] **Step 3: Implement the Inspector UI with shared primitives**

Use existing `Select`, `Button`, and checkbox/field primitives. Show current descriptor, selected series, follow state, and fixed range. Keep point provenance below the controls when a point is selected.

- [ ] **Step 4: Verify Inspector tests GREEN**

Run the panel and command-focused tests plus targeted ESLint for changed files.

---

### Task 4: Extend browser smoke and acceptance evidence

**Files:**
- Modify: `apps/control-room/scripts/smoke-live-charts.mjs`
- Modify: `apps/control-room/src/modules/live-charts/liveChartsSmokeScript.test.ts`
- Modify: `docs/reports/2026-08-03-live-charts-analysis-acceptance.md`

- [ ] **Step 1: Add browser assertions before any legend click**

After opening the Live Charts viewport tab, assert the right panel is visible, its title is `Live Chart`, the chart canvas has non-zero dimensions, and at least one current value is visible. Then exercise stale preference aliases and verify the chart remains non-empty.

- [ ] **Step 2: Run the smoke against a production build**

Use the existing fixture routes and browser instrumentation. Record the Inspector screenshot and the exact canvas/value proof alongside the existing Live Charts evidence.

- [ ] **Step 3: Update the acceptance report**

Document the root cause, the Inspector controls, stale-ID behavior, command/resource boundary, and any unrelated baseline failures.

---

### Task 5: Final verification and handoff

- [ ] **Step 1: Run focused Vitest and typecheck**

```bash
env TMPDIR=/tmp corepack pnpm --dir apps/control-room exec vitest run \
  src/modules/live-charts \
  src/modules/inspector/panels/LiveChartInspectorPanel.test.tsx \
  src/modules/inspector/inspectorRegistry.test.tsx --pool=threads
corepack pnpm --dir apps/control-room typecheck
```

- [ ] **Step 2: Run targeted lint, API/architecture hygiene, and `git diff --check`**

Confirm no direct transport or cross-module imports were introduced.

- [ ] **Step 3: Run production build and browser smoke**

Run the existing audit build plus `smoke:live-charts`, `smoke:analysis-quick-chart`, and the relevant 3D WebGL smoke. Verify `contextLost=false` and non-zero drawing buffers.

- [ ] **Step 4: Review staged scope and commit**

Run `git diff --cached --name-only` separately, stage only the fix, tests, plan/report updates, and commit with a descriptive message. Leave unrelated `.superpowers/sdd/*` edits untouched.
