# Frontend v2 - Charts and Analysis Module

**Status:** Proposed architecture
**Date:** 2026-05-11

## 1. Purpose

The `charts` module shows scalar histories, energy terms, convergence, selected probes, line profiles, and frequency/eigenmode analysis series. It is a data inspection module, not a hidden computation engine.

## 2. Chart Sources

| Source | Resource family |
|---|---|
| scalar history | `data/tables/default/rows` (`data/scalars` compatibility projection) |
| energy terms | `simulation/solver` or scalar resources |
| stage convergence | `simulation/stages` |
| probe/profile | `data/fields` slice/profile resources |
| eigen spectrum | `analysis/eigenmodes` |
| frequency response | `useMagneticResponseSweepResource()` over `ControlRoomApi.analysis.frequencyResponse.magneticSweepV1()` (`magnetic-sweep.v1` for `response/magnetic_response_sweep.v1.json`) |
| mesh quality histogram | `meshing/quality` |

Charts consume resources through hooks and can request commands for analysis only through command registry.

## 3. Module Structure

```text
charts/
  manifest.ts
  ChartsModule.tsx
  store.ts
  components/
    ChartDock.tsx
    EChartsSurface.tsx
    ScalarHistoryChart.tsx
    EnergyChart.tsx
    ConvergenceChart.tsx
    SpectrumChart.tsx
    MeshQualityChart.tsx
  hooks/
    useScalarSeries.ts
    useAnalysisSeries.ts
    useChartResize.ts
  model/
    chartSeriesModel.ts
    chartUnits.ts
```

## 4. Store Ownership

Chart store owns:

- visible series ids;
- chart layout within the dock;
- zoom/brush ranges;
- display density;
- selected cursor point;
- local legend expansion.

Chart store does not own scalar histories, artifacts, analysis datasets, or field data.

## 5. Series Contract

```typescript
export interface ChartSeries {
  id: string;
  label: string;
  quantity: string;
  unit: string;
  xUnit: string;
  source: ResourceRef;
  status: ResourceStatus;
  points: readonly ChartPoint[];
}
```

Series ids include resource identity and quantity. This allows cache reuse and prevents collisions between runs or stages.

## 6. Performance

- Charts request only visible or needed ranges when resources support range queries.
- Scalar-history charts request table row values through
  `useTableRowsBinaryResource` and table schema through table metadata/columns
  resources. The stable query identity is `cursor`, optional row/time ranges,
  `limit`, `targetPoints`, `decimation`, and `includeTail`.
- Large scalar-history windows are decimated server-side for the visible chart
  budget. Client adapters may further shape rows into ECharts datasets, but
  they must not invent hidden polling loops or duplicate table ownership.
- Resize uses `ResizeObserver`, not polling.
- ECharts instances are created once per chart component and disposed on unmount.
- Scalar updates do not force viewport re-render.

## 7. Cross-Module Behavior

Allowed events:

- `charts:series-selected`;
- `charts:range-selected`;
- `charts:add-series-requested`;
- `workspace:selection-changed` when selecting a stage/artifact/point.

Charts must not import viewport internals to add a probe/profile. The viewport emits the request or command registry handles it.

## 8. Tests

Required tests:

- scalar resource becomes chart series with correct units;
- chart decimation preserves endpoints and extrema where required;
- brush range is local state and does not mutate resources;
- unmount disposes chart instance;
- adding a series from viewport event uses command/event path.
