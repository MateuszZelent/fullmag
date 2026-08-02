# Live Charts and Analysis Separation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a dedicated `Live Charts` center surface for revision-driven histories, leave `Analysis` for explicit dataset/artifact postprocessing, keep `Quick Chart` independent in the bottom dock, and fix dimensionless scaling, series visibility, and refresh flicker.

**Architecture:** Keep HTTP v2 resources authoritative and realtime events as invalidations. Extract module-neutral chart contracts first, then give `live-charts` and `analysis-plots` separate SSR-safe preference stores and active-only controllers; neither module may import the other. Move compact Quick Chart rendering into the existing `transport-footer`, driven only by its pinned descriptor and shared chart/resource contracts.

**Tech Stack:** Next.js 16, React, TypeScript, Zustand-style external stores with `useSyncExternalStore`, ECharts, generated OpenAPI v2 client, Vitest/Testing Library, Playwright browser smoke scripts, Catppuccin `--fm-*` tokens, shadcn/ui primitives.

## Global Constraints

- The approved design and ADR are authoritative: `docs/superpowers/specs/2026-08-02-live-charts-analysis-separation-design.md` and `docs/adr/0022-live-charts-analysis-boundary.md`.
- User-facing names are exactly `Live Charts`, `Analysis`, and `Quick Chart`; module ids remain exactly `live-charts`, `analysis-plots`, and `transport-footer`.
- `Live Charts` follows the active run; `Analysis` always names an explicit selected run, stage, dataset, or artifact and never implicitly follows the active table tail.
- HTTP v2 is the snapshot source of truth. WebSocket events only invalidate resources. Do not add polling, `refreshInterval`, `/live-charts`, or `/analysis-screen` endpoints.
- Normalized `m`, `mx`, `my`, and `mz` are dimensionless, use display factor `1`, axis label `Normalized magnetization m`, and never render `m1`, `u1`, `µ1`, or prefixed unit `1`.
- Do not clamp finite normalized magnetization values; values outside the expected interval remain visible for diagnostics.
- `selectedSeriesIds` is the sole series-visibility owner. Zero selected series is valid and renders `Select at least one signal` without restoring defaults.
- Only an initial load with no payload may cover the chart. Refreshing or stale data keeps the previous canvas, axes, legend, cursor, and layout visible.
- Rapid invalidations are coalesced with at most one active fetch per resource/query identity; settled idle performs zero requests, timers, animation frames, renderer updates, and redraws.
- Server payloads, samples, typed arrays, ECharts options, and canonical simulation data never enter workspace stores or local storage.
- `LiveChartPreferencesV1` and `AnalysisViewPreferencesV2` are separate, versioned, bounded, SSR-safe preference contracts.
- Quick Chart imports neither module store, causes no 3D field/topology fetches or camera changes, and owns no ECharts instance after unmount.
- Only the active heavy `viewport-main` surface is mounted.
- Do not fork FDM and FEM UI trees. Do not change solver equations, runtime scalar values, Python DSL, or `ProblemIR`.
- All CSS classes use the `fm-` prefix; components consume `--fm-*` tokens and shared shadcn/ui-style primitives.
- Preserve unrelated dirty-worktree changes. Before each commit, run `git diff --cached --name-only` as a separate command and stage only files named by that task.
- UI completion requires real browser screenshots and WebGL checks; TypeScript and Vitest alone are not visual proof.

---

## File and ownership map

The implementation creates these boundaries before moving behavior:

- `src/shared/analysis-charts/chartScalePolicy.ts` owns dimension-aware display transforms.
- `src/shared/analysis-charts/chartPresentationState.ts` maps resource status plus payload availability to chart presentation.
- `src/shared/analysis-charts/chartSeriesSelection.ts` owns deterministic selection operations.
- `src/shared/analysis-charts/InteractiveChartSurface.tsx` owns module-neutral chart interaction and ECharts lifecycle.
- `src/shared/domain/analysis/chartSeries.ts` and `scalarTableChart.ts` own neutral series/table adapters.
- `src/kernel/workspace/liveChartPreferences.ts` and `liveChartsWorkspace.ts` own compact Live Charts preferences only.
- `src/kernel/workspace/analysisViewPreferences.ts` and `analysisWorkspace.ts` own compact Analysis preferences only.
- `src/modules/live-charts/` owns active-run table/energy composition, controls, commands, selection, Inspector surface, and its manifest.
- `src/modules/analysis-plots/` owns explicit-source dynamics, spectrum, frequency response, eigenmodes, dispersion, hysteresis, and comparison navigation.
- `src/kernel/workspace/quickChartWorkspace.ts` owns a module-neutral pinned descriptor; `transport-footer` owns its mounted bottom-dock view.

### Task 1: Correct dimensionless chart scaling at the shared renderer boundary

**Files:**
- Create: `apps/control-room/src/shared/analysis-charts/chartScalePolicy.ts`
- Create: `apps/control-room/src/shared/analysis-charts/chartScalePolicy.test.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/chartRenderer.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/chartRenderer.test.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/scientificChartFormatting.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/scientificChartFormatting.test.ts`
- Modify: `apps/control-room/src/shared/domain/analysis/chartUnits.ts`
- Create: `apps/control-room/src/shared/domain/analysis/chartUnits.test.ts`
- Modify: `apps/control-room/src/shared/domain/analysis/chartContracts.test.ts`

**Interfaces:**
- Consumes: `resolveChartUnit(unit: string)` from `chartUnits.ts` and existing `AxisScale`/series render contracts.
- Produces:

```typescript
export type ChartScalePolicy =
  | { kind: "fixed"; factor: number; displayUnit: string }
  | { kind: "si-prefix"; canonicalUnit: string }
  | { kind: "dimensionless"; displayUnit: "" };

export interface ChartDisplayTransform {
  factor: number;
  displayUnit: string;
  formatValue(value: number): string;
}

export function resolveChartScalePolicy(unit: string): ChartScalePolicy;
export function createChartDisplayTransform(
  unit: string,
  extrema: readonly [number, number] | null,
): ChartDisplayTransform;
export function chartAxisName(label: string, transform: ChartDisplayTransform): string;
```

- [ ] **Step 1: Write the failing scientific-regression tests**

Add exact fixtures for normalized and physical magnetization:

```typescript
it("keeps normalized magnetization dimensionless at factor one", () => {
  const transform = createChartDisplayTransform("1", [4.447e-6, 0.97982]);
  expect(transform.factor).toBe(1);
  expect(transform.displayUnit).toBe("");
  expect(transform.formatValue(0.10317)).toBe("0.10317");
  expect(chartAxisName("Normalized magnetization m", transform)).toBe(
    "Normalized magnetization m",
  );
});

it("retains SI scaling for physical magnetization", () => {
  const transform = createChartDisplayTransform("A/m", [1e3, 9e5]);
  expect(transform.factor).not.toBe(1e-3);
  expect(chartAxisName("Magnetization M", transform)).toContain("A/m");
});

it("does not place normalized m and physical M on one axis", () => {
  const value = descriptor();
  value.axes[0] = {
    ...value.axes[0],
    canonicalUnit: "1",
    dimension: "dimensionless",
    displayUnit: "1",
  };
  value.series = [
    { axisId: value.axes[0].id, canonicalUnit: "1", id: "my", label: "my", quantity: "my" },
    { axisId: value.axes[0].id, canonicalUnit: "A/m", id: "M_y", label: "M_y", quantity: "M_y" },
  ];
  expect(() => assertChartDescriptor(value)).toThrow("series[1].canonicalUnit");
});

it.each(["m1", "u1", "µ1", "n1"])(
  "never emits the prefixed dimensionless unit %s",
  (forbidden) => {
    const transform = createChartDisplayTransform("1", [0.10317, 0.97982]);
    expect(chartAxisName("Normalized magnetization m", transform)).not.toContain(forbidden);
  },
);
```

- [ ] **Step 2: Run the focused tests and confirm RED**

Run:

```bash
pnpm --dir apps/control-room test -- src/shared/analysis-charts/chartScalePolicy.test.ts src/shared/analysis-charts/chartRenderer.test.ts src/shared/analysis-charts/scientificChartFormatting.test.ts src/shared/domain/analysis/chartUnits.test.ts src/shared/domain/analysis/chartContracts.test.ts
```

Expected: failure because `createChartDisplayTransform` does not exist and the current renderer produces a milli-prefixed dimensionless axis.

- [ ] **Step 3: Implement one dimension-aware display transform**

Implement the fixed dimensionless branch before SI magnitude selection:

```typescript
export function resolveChartScalePolicy(unit: string): ChartScalePolicy {
  const resolved = resolveChartUnit(unit);
  return resolved?.dimension === "dimensionless"
    ? { kind: "dimensionless", displayUnit: "" }
    : {
        kind: "si-prefix",
        canonicalUnit: resolved?.canonicalUnit ?? unit.trim(),
      };
}

export function createChartDisplayTransform(
  unit: string,
  extrema: readonly [number, number] | null,
): ChartDisplayTransform {
  const policy = resolveChartScalePolicy(unit);
  if (policy.kind === "dimensionless") {
    return {
      factor: 1,
      displayUnit: "",
      formatValue: (value) => formatTooltipValue(value, ""),
    };
  }
  const scale = extrema
    ? axisScaleFromExtrema(extrema[0], extrema[1], true)
    : { factor: 1, prefix: "" };
  return {
    factor: scale.factor,
    displayUnit: `${scale.prefix}${policy.canonicalUnit}`,
    formatValue: (value) =>
      formatScaledTooltipValue(value, policy.canonicalUnit, scale),
  };
}

export function chartAxisName(
  label: string,
  transform: ChartDisplayTransform,
): string {
  return transform.displayUnit ? `${label} [${transform.displayUnit}]` : label;
}
```

Update `computeYScales()` and every renderer formatter to consume the same transform for ticks, tooltips, cursor values, latest-value labels, and PNG-rendered axis names. Keep CSV/TSV export canonical and attach existing canonical unit metadata rather than display-scaled values.

- [ ] **Step 4: Run focused tests and typecheck**

Run the command from Step 2, then:

```bash
pnpm --dir apps/control-room typecheck
```

Expected: all focused tests pass; typecheck exits 0; the fixture `0.10317` remains `0.10317` everywhere and no prefixed dimensionless unit is produced.

- [ ] **Step 5: Commit the isolated correctness fix**

Run `git diff --cached --name-only` separately, stage only Task 1 files, then commit:

```bash
git commit -m "fix(control-room): preserve dimensionless chart values"
```

Rollback: revert this commit only if the shared transform breaks a physical-unit test. Never restore magnitude-based SI prefixing for unit `1`.

### Task 2: Replace overlapping visibility state with `selectedSeriesIds`

**Files:**
- Create: `apps/control-room/src/shared/analysis-charts/chartSeriesSelection.ts`
- Create: `apps/control-room/src/shared/analysis-charts/chartSeriesSelection.test.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/ChartLegend.tsx`
- Modify: `apps/control-room/src/shared/analysis-charts/ChartLegend.test.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisTableSurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.test.tsx`

**Interfaces:**
- Consumes: available series ids from the table/chart model.
- Produces:

```typescript
export function sanitizeSelectedSeriesIds(
  selectedSeriesIds: readonly string[],
  availableSeriesIds: readonly string[],
): string[];
export function toggleSelectedSeriesId(
  selectedSeriesIds: readonly string[],
  seriesId: string,
  selected: boolean,
): string[];
export function soloSeriesId(seriesId: string): string[];
export function selectAllSeriesIds(availableSeriesIds: readonly string[]): string[];
```

- [ ] **Step 1: Write RED tests for all eight component combinations**

```typescript
const ids = ["mx", "my", "mz"];

it.each([
  [], ["mx"], ["my"], ["mz"],
  ["mx", "my"], ["mx", "mz"], ["my", "mz"], ids,
])("preserves the exact selection %j", (selected) => {
  expect(sanitizeSelectedSeriesIds(selected, ids)).toEqual(selected);
});

it("allows the final selected series to be removed", () => {
  expect(toggleSelectedSeriesId(["my"], "my", false)).toEqual([]);
});

it("does not restore defaults when invalid ids sanitize to empty", () => {
  expect(sanitizeSelectedSeriesIds(["missing"], ids)).toEqual([]);
});
```

Add component assertions that one checkbox/legend action immediately changes rendered series and causes zero mocked API calls.

- [ ] **Step 2: Run the focused tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/shared/analysis-charts/chartSeriesSelection.test.ts src/shared/analysis-charts/ChartLegend.test.tsx src/modules/inspector/panels/ChartInspectorPanel.test.tsx src/modules/analysis-plots/AnalysisPlotsModule.test.tsx
```

Expected: failures show the final-series guard and empty-selection fallback.

- [ ] **Step 3: Implement the pure selection reducer and adapt both controls**

```typescript
export function sanitizeSelectedSeriesIds(
  selectedSeriesIds: readonly string[],
  availableSeriesIds: readonly string[],
): string[] {
  const available = new Set(availableSeriesIds);
  return [...new Set(selectedSeriesIds)].filter((id) => available.has(id));
}

export function toggleSelectedSeriesId(
  selectedSeriesIds: readonly string[],
  seriesId: string,
  selected: boolean,
): string[] {
  const next = new Set(selectedSeriesIds);
  selected ? next.add(seriesId) : next.delete(seriesId);
  return [...next];
}
```

Change legend and Inspector props to receive `selectedSeriesIds` plus `onSelectedSeriesIdsChange`. Delete the last-checkbox disabling rule and the `hidden.length === 0 ? chartSeries : ...` fallback. Render exactly `series.filter(({ id }) => selected.has(id))`; when empty, render `Select at least one signal` and no ECharts data series.

- [ ] **Step 4: Run focused tests and verify no network effect**

Run Step 2 and assert all pass. In the component test, record mocked `rowsBinary` calls before and after toggling and require the counts to be equal.

- [ ] **Step 5: Commit**

Run the separate staged-file inspection, then:

```bash
git commit -m "fix(control-room): make chart series selection authoritative"
```

Rollback: shared selection can be reverted independently, but zero-selection support and removal of the last-series guard are correctness requirements and must remain in any alternate implementation.

### Task 3: Model background refresh without replacing retained charts

**Files:**
- Create: `apps/control-room/src/shared/analysis-charts/chartPresentationState.ts`
- Create: `apps/control-room/src/shared/analysis-charts/chartPresentationState.test.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/EChartsCanvasSurface.tsx`
- Modify: `apps/control-room/src/shared/analysis-charts/EChartsCanvasSurface.test.tsx`
- Modify: `apps/control-room/src/shared/analysis-charts/ChartSection.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.test.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisTableSurface.tsx`

**Interfaces:**
- Produces the exact `ChartDataPresentationState` union from the approved design and:

```typescript
import type { ResourceRevision } from "@/kernel/api/apiTypes";

export type ChartDataPresentationState =
  | { kind: "initial-loading" }
  | { kind: "ready"; revision: ResourceRevision }
  | {
      kind: "refreshing";
      visibleRevision: ResourceRevision;
      requestedRevision: ResourceRevision;
    }
  | {
      kind: "paused";
      visibleRevision: ResourceRevision;
      latestKnownRevision: ResourceRevision | null;
    }
  | { kind: "stale"; visibleRevision: ResourceRevision; error: Error }
  | { kind: "empty"; revision: ResourceRevision | null }
  | { kind: "unsupported"; reason: string }
  | { kind: "error"; error: Error };

export interface ChartResourceSnapshot<T> {
  status: "idle" | "loading" | "ready" | "stale" | "error";
  data: T | null;
  visibleRevision: string | number | null;
  requestedRevision: string | number | null;
  error: Error | null;
}

export function deriveChartPresentationState<T>(
  snapshot: ChartResourceSnapshot<T>,
  options: { paused: boolean; latestKnownRevision: string | number | null },
): ChartDataPresentationState;
```

- [ ] **Step 1: Write the state-matrix and retained-canvas tests**

```typescript
it("uses initial-loading only when no usable payload exists", () => {
  expect(deriveChartPresentationState(loading(null), active)).toEqual({
    kind: "initial-loading",
  });
});

it("reports refreshing while retaining the visible revision", () => {
  expect(deriveChartPresentationState(loading(points, "41", "42"), active)).toEqual({
    kind: "refreshing",
    visibleRevision: "41",
    requestedRevision: "42",
  });
});

it("reports stale data with its refresh error", () => {
  const state = deriveChartPresentationState(failed(points, "41", refreshError), active);
  expect(state.kind).toBe("stale");
  expect(state.visibleRevision).toBe("41");
});
```

In `EChartsCanvasSurface.test.tsx`, render ready data, rerender as refreshing 100 times, and assert the same canvas remains, no loading overlay appears, and its bounding box does not change.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/shared/analysis-charts/chartPresentationState.test.ts src/shared/analysis-charts/EChartsCanvasSurface.test.tsx src/modules/analysis-plots/components/EChartsSurface.test.tsx
```

Expected: the current `stale`/`loading` mapping emits `Loading table samples` and covers the retained canvas.

- [ ] **Step 3: Implement the presentation reducer and non-blocking status**

Use payload presence as the first branch. `initial-loading` and `error` are the only states allowed to replace an absent plot. For `refreshing`, keep the canvas and render static text `Updating` beside the visible/requested revision. For `stale`, keep the canvas and show the error plus visible revision. For `paused`, render the retained revision and no activity animation. Respect `prefers-reduced-motion`; do not add a spinner or repeating pulse.

```typescript
const blocksPlot =
  presentation.kind === "initial-loading" ||
  presentation.kind === "error" ||
  presentation.kind === "unsupported";
const keepCanvas = hasRenderableData && !blocksPlot;
```

- [ ] **Step 4: Run tests and renderer lifecycle assertions**

Run Step 2. Expected: 100 refresh rerenders retain one canvas/ECharts owner, no overlay, and no `Loading` text after the initial payload.

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(control-room): keep charts visible during refresh"
```

Rollback: revert only the UI reducer if needed; do not modify resource authority or introduce polling.

### Task 4: Extract module-neutral series adapters and interactive surface

**Files:**
- Create: `apps/control-room/src/shared/domain/analysis/chartSeries.ts`
- Create: `apps/control-room/src/shared/domain/analysis/scalarTableChart.ts`
- Create: `apps/control-room/src/shared/domain/analysis/scalarTableChart.test.ts`
- Create: `apps/control-room/src/shared/analysis-charts/InteractiveChartSurface.tsx`
- Create: `apps/control-room/src/shared/analysis-charts/InteractiveChartSurface.test.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/chartTableModel.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/chartTableModel.test.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/chartDiagnostics.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/energyHistoryAdapter.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/frequencyDomainSeriesAdapter.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/dynamicStructureFactorModel.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/spinWaveGammaModel.ts`

**Interfaces:**
- Produces neutral `ChartSeries`, `ChartPoint`, `ChartInteractionCallbacks`, and `InteractiveChartSurfaceProps` types. The shared surface accepts diagnostics callbacks but imports no module events or workspace stores.

```typescript
export interface ChartSeries {
  id: string;
  label: string;
  unit: string;
  axisLabel: string;
  points: readonly [number, number][];
}

export interface ChartInteractionCallbacks {
  onPointSelected?: (seriesId: string, pointIndex: number) => void;
  onRangeSelected?: (fromSI: number, toSI: number) => void;
  onExportRequested?: (format: "csv" | "tsv" | "png") => void;
}
```

- [ ] **Step 1: Add architecture tests before moving code**

Add a source-boundary test that fails if `src/shared/analysis-charts` imports from `modules/`, and snapshot existing scalar, energy, frequency, Gamma, and dynamic-structure-factor series output.

- [ ] **Step 2: Run focused tests and confirm RED for the missing shared adapter**

```bash
pnpm --dir apps/control-room test -- src/shared/domain/analysis/scalarTableChart.test.ts src/shared/analysis-charts/InteractiveChartSurface.test.tsx src/modules/analysis-plots/chartTableModel.test.ts
```

- [ ] **Step 3: Move neutral logic without changing output**

Move types and pure adapters into `shared/domain/analysis`; leave temporary re-exports in `analysis-plots/chartTableModel.ts` so existing consumers remain source-compatible during the migration:

```typescript
export {
  buildScalarTableSeries,
  type ScalarTableChartInput,
} from "@/shared/domain/analysis/scalarTableChart";
export type { ChartPoint, ChartSeries } from "@/shared/domain/analysis/chartSeries";
```

Move the ECharts wrapper to `InteractiveChartSurface.tsx`, parameterize callbacks, and keep one canvas owner with explicit `dispose()` cleanup.

- [ ] **Step 4: Run focused tests, typecheck, and import-boundary scan**

```bash
pnpm --dir apps/control-room test -- src/shared/domain/analysis/scalarTableChart.test.ts src/shared/analysis-charts/InteractiveChartSurface.test.tsx src/modules/analysis-plots/chartTableModel.test.ts src/modules/analysis-plots/components/EChartsSurface.test.tsx
pnpm --dir apps/control-room typecheck
rg -n 'from "@/modules/' apps/control-room/src/shared/analysis-charts apps/control-room/src/shared/domain/analysis
```

Expected: tests and typecheck pass; `rg` returns no matches.

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor(control-room): share chart render contracts"
```

Rollback: temporary re-exports keep existing consumers working, so this commit can remain even if module cutover is reverted.

### Task 5: Add independent SSR-safe Live Charts preferences and workspace state

**Files:**
- Create: `apps/control-room/src/kernel/workspace/liveChartPreferences.ts`
- Create: `apps/control-room/src/kernel/workspace/liveChartPreferences.test.ts`
- Create: `apps/control-room/src/kernel/workspace/liveChartsWorkspace.ts`
- Create: `apps/control-room/src/kernel/workspace/liveChartsWorkspace.test.ts`
- Create: `apps/control-room/src/kernel/workspace/useLiveChartsWorkspace.ts`
- Create: `apps/control-room/src/kernel/workspace/useLiveChartPreferencesHydration.ts`
- Create: `apps/control-room/src/kernel/workspace/useLiveChartPreferencesHydration.test.tsx`
- Modify: `apps/control-room/src/kernel/workspace/analysisChartPreferences.ts`
- Modify: `apps/control-room/src/kernel/workspace/analysisChartPreferences.test.ts`

**Interfaces:**
- Produces the exact contracts below, plus a compact workspace state with `selectedDescriptorId`, cursor/range view state, and no samples.
- Storage key: `fm:live-chart-preferences:v1`.
- Legacy read key: `fm:analysis-chart-preferences:v1`; it is read once and never written after migration.

```typescript
export type ChartRangePreference =
  | { mode: "follow" }
  | { mode: "tailRows"; rows: number }
  | { mode: "tailTime"; durationS: number }
  | { mode: "fixed"; fromSI: number; toSI: number }
  | { mode: "fullDecimated" };

export interface LiveChartPreferencesV1 {
  schemaVersion: 1;
  descriptors: Record<string, {
    xAxisId: string;
    selectedSeriesIds: string[];
    range: ChartRangePreference;
    liveMode: "following" | "paused";
    targetPoints: 160 | 400 | 800 | 1600 | 3200 | 5000;
    displayUnits: Record<string, string>;
  }>;
}
```

- [ ] **Step 1: Write RED tests for defaults, bounds, migration, and hydration**

```typescript
it("creates normalized magnetization defaults once", () => {
  expect(createDefaultLiveChartPreferences().descriptors.magnetization).toMatchObject({
    xAxisId: "step",
    selectedSeriesIds: ["mx", "my", "mz"],
    range: { mode: "follow" },
    liveMode: "following",
    targetPoints: 800,
  });
});

it("does not repopulate an explicitly empty selection", () => {
  const parsed = parseLiveChartPreferences({
    ...validPreferences,
    descriptors: { magnetization: { ...descriptor, selectedSeriesIds: [] } },
  });
  expect(parsed.descriptors.magnetization.selectedSeriesIds).toEqual([]);
});

it("keeps the server and first client snapshots identical", () => {
  expect(renderServerSnapshot()).toEqual(renderFirstClientSnapshot());
});
```

Also reject non-finite fixed ranges, invalid target point counts, excessive descriptor counts, oversized selected-id arrays, samples, typed arrays, and ECharts option objects.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/kernel/workspace/liveChartPreferences.test.ts src/kernel/workspace/liveChartsWorkspace.test.ts src/kernel/workspace/useLiveChartPreferencesHydration.test.tsx
```

- [ ] **Step 3: Implement bounded parsing and one-time migration**

Implement pure parse/serialize functions and an external store with a stable server snapshot. If the new key is absent, copy only unambiguous old live fields (`xAxisId`, selected/visible Y ids, live mode, target points, compatible range), write the new v1 payload, and never write the old key again; reset ambiguous fields to defaults. `reset()` removes only `fm:live-chart-preferences:v1`.

- [ ] **Step 4: Run tests and scan storage payloads**

Run Step 2 and:

```bash
rg -n "Float64Array|series:|option:" apps/control-room/src/kernel/workspace/liveChartPreferences.ts apps/control-room/src/kernel/workspace/liveChartsWorkspace.ts
```

Expected: all tests pass; scan finds no server samples or renderer state.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control-room): add Live Charts preferences"
```

Rollback: remove the new preference key and store; the old key remains readable and canonical data is untouched.

### Task 6: Build the active-run `live-charts` module behind its manifest

**Files:**
- Create: `apps/control-room/src/modules/live-charts/manifest.ts`
- Create: `apps/control-room/src/modules/live-charts/LiveChartsModule.tsx`
- Create: `apps/control-room/src/modules/live-charts/LiveChartsView.tsx`
- Create: `apps/control-room/src/modules/live-charts/liveChartsViewTypes.ts`
- Create: `apps/control-room/src/modules/live-charts/useLiveChartsController.ts`
- Create: `apps/control-room/src/modules/live-charts/liveChartsModel.ts`
- Create: `apps/control-room/src/modules/live-charts/liveChartsModel.test.ts`
- Create: `apps/control-room/src/modules/live-charts/hooks/useLiveTableData.ts`
- Create: `apps/control-room/src/modules/live-charts/hooks/useLiveTableData.test.tsx`
- Create: `apps/control-room/src/modules/live-charts/hooks/useLiveEnergyData.ts`
- Create: `apps/control-room/src/modules/live-charts/hooks/useLiveEnergyData.test.tsx`
- Create: `apps/control-room/src/modules/live-charts/components/LiveChartSurface.tsx`
- Create: `apps/control-room/src/modules/live-charts/components/LiveChartControls.tsx`
- Create: `apps/control-room/src/modules/live-charts/LiveChartsModule.test.tsx`
- Create: `apps/control-room/src/design/styles/live-charts.css`
- Modify: `apps/control-room/app/globals.css`

**Interfaces:**
- Consumes existing `useTableListResource`, `useTableResource`, `useTableColumnsResource`, `useTableRowsBinaryResource`, runtime status revision, shared scalar-table adapter, scale/selection/presentation contracts, and Live Charts workspace preferences.
- Produces manifest id `live-charts`, slot `viewport-main`, command handlers for open/follow/pause/fit/export, and selection kinds `live.chart`/`live.chart-point` wired in Task 7.

- [ ] **Step 1: Write module/controller tests before implementation**

Cover Magnetization, Energy, Convergence, Custom, explicit empty selection, follow/pause/resume, Tail rows, Tail time, Fixed range, Full decimated, and unsupported/empty/error states. Use the screenshot fixture values and assert exact latest labels.

```typescript
it("renders canonical normalized values and hides unchecked series locally", async () => {
  renderLiveCharts({ mx: 0.97982, my: 0.10317, mz: 4.447e-6 });
  expect(screen.getByText("my 0.10317")).toBeVisible();
  const requests = api.rowsBinary.mock.calls.length;
  await user.click(screen.getByRole("checkbox", { name: "my" }));
  expect(screen.queryByTestId("series-my")).not.toBeInTheDocument();
  expect(api.rowsBinary).toHaveBeenCalledTimes(requests);
});

it("pauses without fetching and resumes with one latest fetch", async () => {
  await user.click(screen.getByRole("button", { name: "Pause" }));
  invalidateTableRevision("43");
  expect(api.rowsBinary).toHaveBeenCalledTimes(initialFetches);
  await user.click(screen.getByRole("button", { name: "Follow" }));
  expect(api.rowsBinary).toHaveBeenCalledTimes(initialFetches + 1);
});
```

- [ ] **Step 2: Run the new tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/modules/live-charts/liveChartsModel.test.ts src/modules/live-charts/hooks/useLiveTableData.test.tsx src/modules/live-charts/hooks/useLiveEnergyData.test.tsx src/modules/live-charts/LiveChartsModule.test.tsx
```

- [ ] **Step 3: Implement active-only live resource composition**

Adapt the current bounded cursor/window logic from `useAnalysisTableData.ts` into `useLiveTableData.ts`; do not duplicate the resource cache or endpoint strings. When inactive or paused, pass `enabled: false` to payload hooks. Keep a compact latest-known revision from status, coalesce invalidations through the existing resource layer, reject old-session responses, and render prior data during refresh.

Implement presets as view descriptors, not new API queries. Magnetization uses one dimensionless pane; convergence separates incompatible dimensions; custom selection groups only compatible dimensions or creates labelled separate panes.

- [ ] **Step 4: Implement the view and token-only styling**

Use shared `InteractiveChartSurface`, `ChartLegend`, shadcn `Select`/buttons/tooltips, and `fm-live-charts*` classes. Import the stylesheet from `app/globals.css`:

```css
@import "../src/design/styles/live-charts.css" layer(fm-modules);
```

No raw Catppuccin hex values, indefinite motion, layout-shifting status, or bespoke checkbox/menu primitives.

- [ ] **Step 5: Run module tests, typecheck, and CSS guards**

```bash
pnpm --dir apps/control-room test -- src/modules/live-charts
pnpm --dir apps/control-room typecheck
rg -n '#[0-9a-fA-F]{3,8}' apps/control-room/src/modules/live-charts apps/control-room/src/design/styles/live-charts.css
rg -n 'className="' apps/control-room/src/modules/live-charts | rg -v 'className="fm-'
```

Expected: module tests/typecheck pass; scan finds no raw hex or unprefixed classes.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(control-room): add Live Charts center module"
```

Rollback: remove the unregistered manifest/module and stylesheet import. Existing Analysis remains functional until Task 8 cutover.

### Task 7: Register Live Charts commands, routing, selection, and Inspector ownership

**Files:**
- Modify: `apps/control-room/src/modules/registry.ts`
- Create: `apps/control-room/src/modules/registry.test.ts`
- Modify: `apps/control-room/src/kernel/events/eventTypes.ts`
- Modify: `apps/control-room/src/kernel/commands/commandTypes.ts`
- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/kernel/selection/SelectionController.test.ts`
- Modify: `apps/control-room/src/kernel/layout/ViewportTabHost.test.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonTabViews.tsx`
- Modify: `apps/control-room/src/modules/ribbon/ribbonStructure.test.ts`
- Create: `apps/control-room/src/modules/inspector/panels/LiveChartInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/LiveChartInspectorPanel.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.test.tsx`

**Interfaces:**
- Adds command source `live-charts` and selection refs:

```typescript
type LiveChartSelection = {
  kind: "live.chart";
  descriptorId: string;
};
type LiveChartPointSelection = {
  kind: "live.chart-point";
  descriptorId: string;
  seriesId: string;
  pointIndex: number;
  revision: string | number;
};
```

- Commands: `live-charts.open`, `.follow`, `.pause`, `.fit`, `.export.csv`, `.export.tsv`, `.export.png`.

- [ ] **Step 1: Write RED registration and routing tests**

Assert registry titles/ids, two distinct center tabs, active-only mounting, exact ribbon commands, selection equality including revision, and Inspector resolution for both live selection kinds. Add a compatibility test that parses one old `analysis:charts:default` live identity into `live.chart` but serializes only the new identity.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/modules/registry.test.ts src/kernel/layout/ViewportTabHost.test.tsx src/kernel/selection/SelectionController.test.ts src/modules/ribbon/ribbonStructure.test.ts src/modules/inspector/inspectorRegistry.test.tsx src/modules/inspector/panels/LiveChartInspectorPanel.test.tsx
```

- [ ] **Step 3: Register manifests, commands, and distinct selection vocabulary**

Add `liveChartsManifest` to `ALL_MODULES`. Add `Live Charts` beside `Analysis` in the center-surface menu; point live observation actions to `live-charts.open` and retain postprocessing actions on `analysis-plots.open`. Register Inspector panels without reusing the generic Analysis selection identity.

Compatibility reader removal condition: delete it after one released preference schema version has written `fm:live-chart-preferences:v1` and browser migration tests prove no old live identity remains. Document the condition beside the reader and in Task 10 docs.

- [ ] **Step 4: Run focused tests and active-only mount assertion**

Run Step 2. In the host test, switch 3D → Live Charts → Analysis → 3D and assert only one heavy center component exists at each step.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control-room): route Live Charts independently"
```

Rollback: unregister `live-charts` and restore the menu entry; compatibility reads remain non-destructive.

### Task 8: Cut Analysis over to explicit datasets and analysis resources

**Files:**
- Create: `apps/control-room/src/kernel/workspace/analysisViewPreferences.ts`
- Create: `apps/control-room/src/kernel/workspace/analysisViewPreferences.test.ts`
- Create: `apps/control-room/src/kernel/workspace/analysisWorkspace.ts`
- Create: `apps/control-room/src/kernel/workspace/analysisWorkspace.test.ts`
- Create: `apps/control-room/src/kernel/workspace/useAnalysisWorkspace.ts`
- Create: `apps/control-room/src/kernel/workspace/useAnalysisViewPreferencesHydration.ts`
- Create: `apps/control-room/src/kernel/workspace/useAnalysisViewPreferencesHydration.test.tsx`
- Create: `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisDatasetData.ts`
- Create: `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisDatasetData.test.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/useAnalysisPlotsController.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisSurfaceTabs.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisTableSurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisEnergySurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/components/AnalysisFrequencySurface.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/DynamicStructureFactorView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/SpinWaveGammaView.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.test.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisWorkbench.test.tsx`
- Remove after migration: `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisTableData.ts`
- Remove after migration: `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisTableData.test.tsx`
- Remove after migration: `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisEnergyData.ts`
- Remove after migration: `apps/control-room/src/modules/analysis-plots/hooks/useAnalysisEnergyData.test.tsx`

**Interfaces:**
- Produces the exact contracts below.
- Storage key: `fm:analysis-view-preferences:v2`.
- `useAnalysisDatasetData({ datasetRef, enabled })` resolves an explicit table/artifact identity and never reads the active live cursor as a fallback.

```typescript
export type AnalysisSurface =
  | "dynamics"
  | "spectrum"
  | "frequency-response"
  | "eigenmodes"
  | "dispersion"
  | "hysteresis"
  | "comparison";

export interface AnalysisDescriptorPreference {
  selectedSeriesIds: string[];
  displayUnits: Record<string, string>;
  range: { fromSI: number; toSI: number } | null;
}

export interface AnalysisViewPreferencesV2 {
  schemaVersion: 2;
  activeSurface: AnalysisSurface;
  selectedDatasetRef: string | null;
  descriptorPreferences: Record<string, AnalysisDescriptorPreference>;
}
```

- [ ] **Step 1: Write RED tests for explicit source ownership**

```typescript
it("does not load table rows without a selected dataset", () => {
  renderAnalysis({ selectedDatasetRef: null });
  expect(api.rowsBinary).not.toHaveBeenCalled();
  expect(screen.getByText("Select a dataset or artifact")).toBeVisible();
});

it("does not follow active table revisions implicitly", () => {
  renderAnalysis({ selectedDatasetRef: "table:run-7:stage-2:table-4" });
  invalidateActiveLiveTable("99");
  expect(api.rowsBinary).toHaveBeenCalledTimes(1);
});

it("labels ready postprocessing as Ready, never Live", () => {
  renderAnalysisGamma(readyGamma);
  expect(screen.getByText("Ready")).toBeVisible();
  expect(screen.queryByText("Live")).not.toBeInTheDocument();
});
```

Add preference tests for all seven surface ids, bounded descriptors/ranges, explicit dataset ref, and SSR-safe hydration.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/kernel/workspace/analysisViewPreferences.test.ts src/kernel/workspace/analysisWorkspace.test.ts src/kernel/workspace/useAnalysisViewPreferencesHydration.test.tsx src/modules/analysis-plots/hooks/useAnalysisDatasetData.test.tsx src/modules/analysis-plots/AnalysisPlotsModule.test.tsx src/modules/analysis-plots/analysisWorkbench.test.tsx
```

- [ ] **Step 3: Implement explicit dataset preference/store and hook**

Use existing table list/detail/columns/binary-row resources to resolve selected table identities. For analysis-family artifacts, retain existing frequency-domain, spin-wave, and hysteresis hooks. Missing capability maps to `unsupported`; missing selected source maps to the stable selection prompt; neither maps to a successful empty chart.

- [ ] **Step 4: Recompose Analysis surfaces without live ownership**

Expose Dynamics, Spectrum, Frequency Response, Eigenmodes, Dispersion, Hysteresis, and Comparison navigation. Wire existing Gamma and dynamic-structure-factor resources through `useSpinWaveGammaResource(activeSurface === "spectrum")` and `useDynamicStructureFactorResource(activeSurface === "dispersion")`. Replace their hardcoded `Live` status with the shared presentation state. Do not add new FFT/eigen/hysteresis computation.

Move current active-run Overview/Dynamics/Convergence and live energy behavior to `live-charts`; delete the old Analysis live hooks only after all imports and tests move.

- [ ] **Step 5: Run focused tests, typecheck, and no-live-follow scan**

```bash
pnpm --dir apps/control-room test -- src/kernel/workspace/analysisViewPreferences.test.ts src/kernel/workspace/analysisWorkspace.test.ts src/modules/analysis-plots
pnpm --dir apps/control-room typecheck
rg -n "useAnalysisTableData|useAnalysisEnergyData|liveMode|following" apps/control-room/src/modules/analysis-plots
```

Expected: tests/typecheck pass; scan returns no implicit live-follow ownership in Analysis.

- [ ] **Step 6: Commit**

```bash
git commit -m "refactor(control-room): make Analysis dataset-driven"
```

Rollback: revert Analysis cutover and keep the correctness fixes from Tasks 1–3. Existing resource APIs and canonical data remain unchanged.

### Task 9: Put independent Quick Chart in the existing bottom dock

**Files:**
- Modify: `apps/control-room/src/kernel/layout/layoutTypes.ts`
- Modify: `apps/control-room/src/kernel/layout/layoutModel.test.ts`
- Modify: `apps/control-room/src/kernel/workspace/quickChartWorkspace.ts`
- Modify: `apps/control-room/src/kernel/workspace/quickChartWorkspace.test.ts`
- Modify: `apps/control-room/src/shared/analysis-charts/QuickChartResourceView.tsx`
- Create: `apps/control-room/src/shared/analysis-charts/QuickChartResourceView.test.tsx`
- Modify: `apps/control-room/src/modules/inspector/panels/QuickChartInspectorPanel.tsx`
- Modify: `apps/control-room/src/modules/footer/FooterModule.tsx`
- Modify: `apps/control-room/src/modules/footer/manifest.test.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisDock.test.tsx`
- Modify: `apps/control-room/src/modules/analysis-plots/manifest.ts`
- Create: `apps/control-room/src/modules/analysis-plots/manifest.test.ts`

**Interfaces:**
- Extends `BottomPanelTabId` with `quick-chart`.
- Replaces `PinnedQuickChart.yAxisIds` with `selectedSeriesIds` and preserves `chartId`, `tableId`, `xAxisId`, range, and display units.
- Quick Chart view consumes only `useQuickChartWorkspace`, shared chart contracts, and table resource hooks.

- [ ] **Step 1: Write RED tests for bottom-dock activation and independence**

Assert `TabsTrigger value="quick-chart"`, active-only mounting, correct empty/pinned states, zero field/topology requests, zero camera changes, zero 3D dirty frames, and ECharts disposal on close. Add an architecture test that scans Quick Chart source and rejects imports from `analysis-plots`, `live-charts`, `useAnalysisPlotsWorkspace`, and `useLiveChartsWorkspace`.

- [ ] **Step 2: Run focused tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/kernel/layout/layoutModel.test.ts src/kernel/workspace/quickChartWorkspace.test.ts src/shared/analysis-charts/QuickChartResourceView.test.tsx src/modules/footer/manifest.test.ts src/modules/analysis-plots/analysisDock.test.tsx src/modules/analysis-plots/manifest.test.ts
```

- [ ] **Step 3: Mount Quick Chart in `transport-footer` only while active**

Add the tab and guard its heavy content exactly like existing footer tabs:

```tsx
<TabsTrigger value="quick-chart">Quick Chart</TabsTrigger>
{activeTab === "quick-chart" ? <QuickChartResourceView /> : null}
```

Migrate descriptors through a pure parser: old `yAxisIds` becomes `selectedSeriesIds` once; new writes contain only `selectedSeriesIds`. Change the Analysis pin command to a module-neutral Quick Chart command/descriptor update, then open the bottom panel without selecting Analysis or changing the spatial viewport.

- [ ] **Step 4: Run tests, typecheck, and architecture scan**

```bash
pnpm --dir apps/control-room test -- src/kernel/workspace/quickChartWorkspace.test.ts src/shared/analysis-charts/QuickChartResourceView.test.tsx src/modules/footer/manifest.test.ts src/modules/analysis-plots/analysisDock.test.tsx
pnpm --dir apps/control-room typecheck
rg -n "analysis-plots|live-charts|useAnalysisPlotsWorkspace|useLiveChartsWorkspace" apps/control-room/src/shared/analysis-charts/QuickChartResourceView.tsx apps/control-room/src/kernel/workspace/quickChartWorkspace.ts
```

Expected: tests/typecheck pass; scan returns no module-store dependency.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(control-room): mount Quick Chart in the bottom dock"
```

Rollback: remove the footer tab and retain pinned descriptor data; no viewport or canonical data migration is involved.

### Task 10: Complete compatibility cleanup and governing documentation

**Files:**
- Modify: `docs/adr/0016-center-viewport-tabbed-surfaces.md`
- Modify: `docs/specs/frontend-v2/01-module-kernel-architecture.md`
- Modify: `docs/specs/frontend-v2/02-module-catalog.md`
- Modify: `docs/specs/frontend-v2/16-charts-analysis-module.md`
- Modify: `docs/analysis-tab-refactoring-plan.md`
- Modify: `docs/adr/0022-live-charts-analysis-boundary.md`
- Modify: `apps/control-room/src/kernel/workspace/analysisChartPreferences.ts`
- Modify: `apps/control-room/src/kernel/workspace/useAnalysisChartPreferencesHydration.ts`
- Modify or remove after import scan: `apps/control-room/src/kernel/workspace/analysisPlotsWorkspace.ts`
- Modify or remove after import scan: `apps/control-room/src/kernel/workspace/useAnalysisPlotsWorkspace.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/chartTableModel.ts`
- Modify: `apps/control-room/src/design/styles/analysis-plots.css`

**Interfaces:**
- No new runtime interface. This task removes obsolete write paths and records the bounded compatibility read/removal gate.

- [ ] **Step 1: Write architecture scans as tests**

Add assertions that docs enumerate both center modules; Analysis docs contain `explicit selected dataset`; no target document describes the mixed workbench; new code writes neither old selection identities nor `fm:analysis-chart-preferences:v1`; all remaining compatibility readers contain the removal condition.

- [ ] **Step 2: Run document/architecture tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/modules/registry.test.ts src/kernel/workspace/liveChartPreferences.test.ts src/kernel/workspace/analysisViewPreferences.test.ts
rg -n "one mixed Analysis|implicit live follow|Analysis.*live table|fm:analysis-chart-preferences:v1" docs/adr/0016-center-viewport-tabbed-surfaces.md docs/specs/frontend-v2/01-module-kernel-architecture.md docs/specs/frontend-v2/02-module-catalog.md docs/specs/frontend-v2/16-charts-analysis-module.md docs/analysis-tab-refactoring-plan.md apps/control-room/src
```

Expected: stale target descriptions and old writes are identified before cleanup.

- [ ] **Step 3: Update docs and remove obsolete ownership**

Document current implementation, one-version compatibility reads, and target ownership separately. Mark the old mixed `Analysis` plan as superseded by the approved design and this implementation plan. Remove dead stores, hooks, wrappers, CSS selectors, and temporary re-exports only after `rg` proves no consumer remains. Do not remove the old read parser until its explicit release gate is satisfied.

- [ ] **Step 4: Run docs and dead-path scans**

```bash
rg -n "useAnalysisPlotsWorkspace|hiddenSeriesIds|yAxisIds" apps/control-room/src/modules/live-charts apps/control-room/src/modules/analysis-plots apps/control-room/src/shared/analysis-charts/QuickChartResourceView.tsx
rg -n "Live Charts|explicit selected dataset|Quick Chart" docs/adr/0016-center-viewport-tabbed-surfaces.md docs/specs/frontend-v2/01-module-kernel-architecture.md docs/specs/frontend-v2/02-module-catalog.md docs/specs/frontend-v2/16-charts-analysis-module.md docs/analysis-tab-refactoring-plan.md
git diff --check
```

Expected: first scan has no obsolete live visibility/store ownership; second scan proves all target docs cover the three surfaces; diff check passes.

- [ ] **Step 5: Commit**

```bash
git commit -m "docs(control-room): publish Live Charts ownership"
```

Rollback: docs and dead-path cleanup revert together; keep bounded legacy readers while the migration window is open.

### Task 11: Add browser, lifecycle, and performance acceptance gates

**Files:**
- Create: `apps/control-room/scripts/smoke-live-charts.mjs`
- Create: `apps/control-room/src/modules/live-charts/liveChartsSmokeScript.test.ts`
- Modify: `apps/control-room/scripts/smoke-analysis-plots.mjs`
- Modify: `apps/control-room/scripts/smoke-analysis-quick-chart.mjs`
- Modify: `apps/control-room/scripts/audit-chart-performance.mjs`
- Modify: `apps/control-room/scripts/audit-idle-performance.mjs`
- Modify: `apps/control-room/scripts/smoke-viewport-3d.mjs`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisPlotsSmokeScript.test.ts`
- Modify: `apps/control-room/src/modules/analysis-plots/analysisPlotsPerformanceAuditScript.test.ts`
- Modify: `apps/control-room/package.json`
- Create during verification, do not commit unless project convention requires it: `.fullmag/reports/live-charts-analysis-acceptance/<timestamp>/`

**Interfaces:**
- Adds package commands `smoke:live-charts` and `smoke:analysis-quick-chart`, and extends existing chart/idle/viewport audits without changing production API contracts.

- [ ] **Step 1: Write script-contract tests before browser code**

Require the Live Charts script to cover exact fixture values, all eight `mx/my/mz` combinations, 100 revisions, zero requests for local toggles/cursor/legend/range actions and irrelevant revisions, pause/resume counts, keyboard-only select/hide/show/solo/reset/pause/follow/point-inspect/export flows, Mocha/Latte, reduced motion, 200% zoom, and screenshots. Require the Analysis script to prove explicit dataset selection and no implicit live refresh. Require Quick Chart + 3D checks and final WebGL assertions.

- [ ] **Step 2: Run script-contract tests and confirm RED**

```bash
pnpm --dir apps/control-room test -- src/modules/live-charts/liveChartsSmokeScript.test.ts src/modules/analysis-plots/analysisPlotsSmokeScript.test.ts src/modules/analysis-plots/analysisPlotsPerformanceAuditScript.test.ts
```

- [ ] **Step 3: Implement deterministic browser gates**

Add `smoke:live-charts` to `package.json`. In the browser scripts, collect request counts by resource family, ECharts instance counts, observers/listeners, animation frames, canvas bounding boxes, screenshots, and WebGL state. Use stable `fm-live-charts*` selectors and fail on any `m1`/prefixed-unit text, loading overlay after initial payload, layout shift, extra fetch, leaked ECharts owner, lost WebGL context, or zero drawing buffer.

- [ ] **Step 4: Run focused and full non-browser verification**

```bash
pnpm --dir apps/control-room test -- src/shared/analysis-charts src/kernel/workspace src/modules/live-charts src/modules/analysis-plots src/modules/footer src/modules/inspector
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room test
pnpm --dir apps/control-room build
```

Expected: every command exits 0. Record actual test counts and warnings in the acceptance report; do not claim a clean result if warnings indicate lifecycle, hydration, accessibility, or resource-contract failures.

- [ ] **Step 5: Run resource-first and architecture gates**

Run the current strict resource/API contract commands. The required outcomes are: generated OpenAPI/types unchanged unless a proven gap was introduced, no direct component `fetch()`, no screen-shaped endpoint, no polling, and no module-to-module imports.

```bash
pnpm --dir apps/control-room check:api-hygiene
just resource-first-gates strict
rg -n "fetch\(|refreshInterval|/live-charts|/analysis-screen" apps/control-room/src/modules/live-charts apps/control-room/src/modules/analysis-plots apps/control-room/src/shared/analysis-charts/QuickChartResourceView.tsx
rg -n 'from "@/modules/(live-charts|analysis-plots)' apps/control-room/src/modules/live-charts apps/control-room/src/modules/analysis-plots apps/control-room/src/shared/analysis-charts/QuickChartResourceView.tsx
```

Expected: both scans return no prohibited production matches.

- [ ] **Step 6: Run live browser and visual proof**

Start the Control Room using its documented launcher, then run:

```bash
pnpm --dir apps/control-room smoke:live-charts
pnpm --dir apps/control-room smoke:analysis-plots
pnpm --dir apps/control-room smoke:analysis-quick-chart
pnpm --dir apps/control-room audit:chart-performance
pnpm --dir apps/control-room audit:idle-performance
pnpm --dir apps/control-room smoke:viewport-3d
```

Expected evidence:

- `mx = 0.97982`, `my = 0.10317`, `mz = 4.447e-6` agree in labels, points, tooltip, cursor, and canonical export;
- all eight visibility combinations render exactly; local toggles issue zero requests;
- 100 revisions keep one visible canvas with no blocking loading state or layout shift and no more than one coalesced table fetch per resource/query consumer;
- irrelevant revisions and local cursor/legend/range controls issue zero requests;
- pause issues zero payload fetches; resume issues exactly one latest fetch;
- Live Charts and Analysis mount separately; Analysis does not follow the active tail;
- Quick Chart coexists with 3D with zero field/topology requests, camera changes, unchanged-buffer uploads, or 3D dirty frames;
- after 100 switches/open-close cycles, ECharts/listener/observer/worker/object-URL/heap counts return to bounded baseline;
- after returning to 3D, `gl.isContextLost()` is `false` and drawing-buffer width/height are greater than zero;
- keyboard-only users can select/hide/show/solo signals, reset the range, pause/follow, inspect a point, and export without relying on color;
- screenshots exist for Live Charts, Analysis, Quick Chart + 3D in Mocha and Latte, plus 200% zoom and reduced motion.

- [ ] **Step 7: Review the screenshots manually**

Inspect every screenshot at original resolution. Reject clipped axis labels, overlapping legends, unreadable units, color-only state, blinking/pulsing status, inconsistent spacing, or a Quick Chart dock that obscures the 3D canvas. Save a short before/after description and the screenshot paths in the acceptance report.

- [ ] **Step 8: Commit verification assets**

Run the separate staged-file inspection, stage only package/script/test changes (not transient screenshots unless repository convention explicitly tracks them), then:

```bash
git commit -m "test(control-room): gate Live Charts lifecycle"
```

Rollback: browser gates may be reverted separately only if their selectors are invalid; production correctness and lifecycle requirements remain mandatory.

## Final integration checklist

- [ ] Resolve the implementation range with `git log --oneline` and verify every planned commit is present.
- [ ] Run `git status --short`, `git diff --check`, and a separate `git diff --cached --name-only`; confirm no unrelated dirty files were staged or altered.
- [ ] Re-run the focused scientific fixtures and the complete Control Room test/typecheck/lint/build suite against the final tree.
- [ ] Re-run all six browser/performance commands from Task 11 against the final build, not an older dev-server process.
- [ ] Confirm the acceptance report distinguishes source tests, browser proof, WebGL proof, performance proof, commit state, push state, and production validation.
- [ ] Request code review using `google-eng-review-practices`; treat correctness, resource ownership, active-only lifecycle, SSR hydration, and visual evidence as blocking review gates.
- [ ] Do not delete compatibility readers until their documented one-version removal condition is met in a separate reviewed change.

## Completion criteria

The refactor is complete only when all requirements in `docs/superpowers/specs/2026-08-02-live-charts-analysis-separation-design.md` map to passing automated or browser evidence. A green source test suite without screenshots, request-count proof, lifecycle counters, and the final WebGL check is incomplete. Rollback may remove the new module routing, but it must never restore dimensionless SI scaling, the final-series guard, empty-selection default restoration, or blocking overlays while retained data exists.
