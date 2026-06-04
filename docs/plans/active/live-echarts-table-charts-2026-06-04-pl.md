# Live ECharts Table Charts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wdrozyc produkcyjny mechanizm tabelarycznego autosave'u i aktualizowanych na zywo wykresow 1D/2D/3D w `apps/control-room`, oparty o Apache ECharts, canonical Python DSL, ProblemIR, runtime table resources i resource-first API v2.

**Architecture:** Fullmag nie kopiuje amumaxowego modelu wysylania calego `TablePlotState` przez WebSocket. Runtime zapisuje append-only table rows, WebSocket publikuje tylko invalidacje i kursory, a UI pobiera przez HTTP tylko brakujace delty albo widoczny zakres wykresu z serwerowa decymacja. `analysis-plots` pozostaje center-surface module w `viewport-main`; prawy inspector edytuje konfiguracje wykresu przez jawny workspace chart-state/controller, bez importow miedzy modulami.

**Tech Stack:** Python DSL w `packages/fullmag-py`, `ProblemIR` w `crates/fullmag-ir`, Rust runtime/API w `crates/fullmag-runner` i `crates/fullmag-api`, OpenAPI v2, generated control-room transport, React 19/Next 16, Apache ECharts, ECharts GL, Vitest, Playwright smoke/audit scripts.

---

## 1. User-Facing Contract

### 1.1 Python DSL

Docelowa skladnia:

```python
relax = fm.Relaxation(
    outputs=[fm.SaveField("m", every=1e-12)],
    table_autosave=fm.TableAutosave(t_sampl=1e-12),
)
```

oraz wariant jawny z custom kolumnami:

```python
relax = fm.Relaxation(
    outputs=[fm.SaveField("m", every=1e-12)],
    table_autosave=fm.TableAutosave(
        t_sampl=5e-13,
        quantities=["step", "t", "mx", "my", "mz", "e_total", "max_torque"],
    ),
)
```

Dodawanie dodatkowych kolumn po inicjalizacji:

```python
autosave = fm.TableAutosave(t_sampl=1e-12, extra_quantities=["e_demag", "max_torque_T"])
```

Reguly:

- `table_autosave` jest opcjonalnym parametrem `__init__` na `Relaxation` i `TimeEvolution`, zgodnym z frozen-dataclass wzorcem (jak `stop`, `dynamics`).
- `t_sampl` jest publicznym aliasem Python DSL, zgodnym z prosba uzytkownika.
- IR uzywa SI-clean pola `sample_period_s`.
- `TableAutosave(t_sampl=...)` wlacza defaultowe kolumny: `step`, `t`, `mx`, `my`, `mz`, `e_total`, `max_torque`.
- `max_torque` jest publicznym aliasem wyswietlania dla kanonicznej wartosci w `A/m`; UI oferuje tez `max_torque_T` jako wariant w teslach.
- `step` nie jest fizyczna quantity, tylko indeks solvera. `t` jest kanonicznym aliasem kolumny czasu symulacji w sekundach; istniejacy `time` w `data/scalars` i `StepStats` jest kompatybilnym aliasem wejsciowym, ale kanoniczna nazwa publiczna to `t`.
- `table_autosave` jest dostepne tylko dla `TimeEvolution` i `Relaxation`. `Eigenmodes` i `FrequencyResponse` nie maja krokow czasowych w sensie table-autosave i sa jawnie wykluczone.
- Bez `table_autosave=...` runtime nie dopisuje okresowych tabel poza juz istniejacymi minimalnymi metrykami statusu. Nie wolno ukrywac kosztow IO pod domyslnym zawsze-wlaczonym zapisem.

### 1.2 UI Authoring

W unified workspace:

- zakladka center surface: `3D` / `Cross-section` / `Charts`;
- aktywna zakladka `Charts` montuje tylko modul `analysis-plots`;
- prawy inspector po wybraniu `Charts` pokazuje:
  - `Table autosave`: enabled, `t_sampl`, columns;
  - `Series`: visible columns, axis assignment, color, line/point mode;
  - `Range`: follow tail, from/to, trim, target points;
  - `Axes`: unit grouping, log/linear, twin-axis policy;
  - `3D`: `lines3D` / `scatter3D` for multi-parameter phase plots.

### 1.3 Runtime Data Contract

Default table row (user-visible columns only; `row_index` i `revision` sa metadata transportu w `TableRowsResource`, nie kolumnami danych):

```text
step, t, mx, my, mz, e_total, max_torque
```

Extended metadata per column:

```text
column_id, quantity_id, label, unit, dimension, component, reduction, value_type
```

Examples:

| column_id | label | unit | dimension | source |
|---|---|---|---|---|
| `step` | step | `1` | count | solver step |
| `t` | t | `s` | time | solver time (canonical alias; `time` accepted as input alias) |
| `dt` | dt | `s` | time | solver timestep (canonical alias; `solver_dt` accepted as input alias) |
| `mx` | mx | `1` | normalized_magnetization | volume average |
| `e_total` | E total | `J` | energy | scalar metrics |
| `e_demag` | E demag | `J` | energy | demag energy |
| `e_ex` | E ex | `J` | energy | exchange energy |
| `e_ext` | E ext | `J` | energy | Zeeman energy |
| `e_ani` | E ani | `J` | energy | anisotropy energy |
| `e_dmi` | E dmi | `J` | energy | DMI energy |
| `max_torque` | max torque | `A/m` | effective_field | alias of `max_torque_Apm` |
| `max_torque_T` | max torque (T) | `T` | effective_field | Tesla variant |
| `max_dm_dt` | max dm/dt | `1/s` | rate | magnetization rate |
| `max_h_eff` | max H eff | `A/m` | effective_field | effective field magnitude |
| `max_h_demag` | max H demag | `A/m` | effective_field | demag field magnitude |

---

## 2. Why Not Copy AmuMax Directly

`external_solvers/amumax` is useful as a product reference:

- `TableAdd`, `TableAutoSave`, X/Y column selection, `maxPoints`, `step`;
- ECharts rendering and simple UI controls;
- table columns with units.

It is not acceptable as Fullmag architecture:

- amumax websocket sends full `tablePlot` state including data;
- one chart has only one X and one Y column;
- unit policy is one Y axis, not multi-series/twin-axis;
- browser downsampling is driven by fixed `step`, not visible range and pixel budget;
- chart state is screen-shaped, not resource-first.

Fullmag keeps the user-visible idea but replaces the transport and data model.

---

## 3. ECharts Decisions

Primary sources checked:

- Apache ECharts dynamic data guide: <https://echarts.apache.org/handbook/en/how-to/data/dynamic-data/>
  - dynamic updates are done through `setOption`, and series should have stable `name` for updates.
- Apache ECharts dataset guide: <https://echarts.apache.org/handbook/en/concepts/dataset/>
  - `dataset` is the right model for 2D table-shaped data and reusable series mapping.
- Apache ECharts `appendData` API: <https://apache.googlesource.com/echarts-doc/+/refs/heads/v4/en/api/echarts-instance.md#appendData>
  - `appendData` is for huge chunked rendering but is not supported with `dataset`, and incremental rendering support is limited to scatter/lines plus selected ECharts GL series.
- ECharts GL docs: <https://ecomfe.github.io/echarts-gl/>
  - 3D charts are provided through `echarts-gl` and WebGL-backed series such as `scatter3D`; `lines3D` support must be verified against the installed `echarts-gl` package API during Task 8 before exposing it as a stable UI mode.

Implementation decision:

- 1D/2D time-series charts use Canvas ECharts, not SVG.
- Normal line charts use `setOption` with bounded visible/decimated data, not `appendData`.
- `dataset` is used for moderate table windows and multi-series mapping.
- For very large histories, server returns a downsampled visible window; the chart replaces the bounded window with `setOption`.
- `appendData` is reserved only for ECharts GL or pure `lines`/`scatter` workloads where the series type officially supports it and where we are not using `dataset`.
- ECharts instances are created once per mounted chart component, resized by `ResizeObserver`, and disposed on unmount.

---

## 4. Resource-First API Design

### 4.1 New Resources

Add these v2 resources under the existing `data` family:

```text
GET /v2/sessions/current/data/tables
GET /v2/sessions/current/data/tables/{table_id}
GET /v2/sessions/current/data/tables/{table_id}/columns
GET /v2/sessions/current/data/tables/{table_id}/rows
GET /v2/sessions/current/data/tables/{table_id}/rows.bin
```

Keep the existing endpoint as a compatibility view:

```text
GET /v2/sessions/current/data/scalars
```

`data/scalars` should read from `data/tables/default/rows` internally until it can be deprecated. It must not fork a second scalar-history owner.

### 4.2 Query Model

`GET .../rows` query:

```text
columns=step,t,mx,my,mz,e_total
cursor=12345
from_row=1000
to_row=25000
from_t=0.0
to_t=1e-9
limit=5000
target_points=1600
decimation=minmax_lttb
include_tail=true
```

Rules:

- `cursor` means "rows strictly after this row cursor/revision".
- `from_row`/`to_row` and `from_t`/`to_t` are visible-range fetches.
- `limit` caps returned rows after range filtering.
- `target_points` is the chart pixel budget, usually chart width times device pixel ratio, clamped by policy.
- `decimation=minmax_lttb` preserves endpoints, extrema, and trend shape better than naive stride.
- If `cursor` is stale because the server compacted old rows, response returns `resync_required: true` and a recommended visible-window request.

### 4.3 JSON Response

```rust
pub struct TableRowsResource {
    pub table_id: String,
    pub revision: u64,
    pub schema_revision: u64,
    pub cursor_start: u64,
    pub cursor_end: u64,
    pub total_rows: u64,
    pub returned_rows: u64,
    pub columns: Vec<TableColumnMeta>,
    pub rows: Vec<Vec<f64>>,
    pub decimation: Option<TableDecimationMeta>,
    pub resync_required: bool,
}
```

`revision` is table freshness. `cursor_end` is the value the client stores for the next delta fetch.

### 4.4 Binary Response

`rows.bin` returns a columnar binary payload for large windows:

```text
FMTB v1 header
table_id
revision
schema_revision
cursor_start
cursor_end
column_count
row_count
column metadata offsets
Float64Array column payloads
```

Frontend decoder lives beside existing codecs:

```text
apps/control-room/src/kernel/api/codecs/tableRowsCodec.ts
apps/control-room/src/kernel/api/codecs/tableRowsCodec.test.ts
```

Use JSON first for small windows and `.bin` when:

- `returned_rows * selected_columns > 50_000`, or
- `response_estimate_bytes > 512 KiB`, or
- UI requests `prefer_binary=true`.

### 4.5 Realtime

WebSocket event stays invalidation-only:

```json
{
  "type": "resource.batch_changed",
  "changes": [
    {
      "resource": "data/tables/default/rows",
      "revision": 12610,
      "recommended_fetch": "/v2/sessions/current/data/tables/default/rows?cursor=12600"
    }
  ]
}
```

No scalar rows, no table data, no chart snapshots in WebSocket frames.

---

## 5. Runtime Storage And Sampling

### 5.1 Table Store

Add an append-only table store in runner/runtime state:

```text
crates/fullmag-runner/src/table_autosave.rs
```

Responsibilities:

- resolve table config from IR;
- evaluate selected quantities from `StepStats` and backend observables;
- append rows on `t_sampl` cadence using robust due checks;
- expose immutable row windows for API snapshots;
- keep bounded in-memory tail plus artifact-backed full history when run output path exists;
- track `revision`, `schema_revision`, `total_rows`, `oldest_available_cursor`.

Do not keep large table histories in React state, status JSON, or WebSocket frames.

### 5.2 Cadence Semantics

Use simulation time, not wall time:

```text
append row when current_t + eps >= next_sample_t
then next_sample_t += t_sampl until it is greater than current_t
```

When adaptive timesteps skip over multiple sample times, append one row at the current solver state and mark `sample_policy="coalesced_to_step"` unless interpolation is explicitly added later. Do not fake interpolated physical values.

### 5.3 Default Quantities

Default table config:

```rust
const DEFAULT_TABLE_COLUMNS: &[&str] = &[
    "step",
    "t",
    "mx",
    "my",
    "mz",
    "e_total",
    "max_torque",
];
```

Quantity resolution:

- `t` -> `StepStats.time`
- `step` -> `StepStats.step`
- `mx/my/mz` -> existing average magnetization metrics
- `e_total` -> existing total scalar energy
- `max_torque` -> `max_torque_Apm`, label `max torque`, unit `A/m`

### 5.4 Artifact Output

The table store writes:

```text
artifacts/tables/default/table.csv
artifacts/tables/default/table.json
artifacts/tables/default/schema.json
```

Large binary/chunked artifacts can follow the existing Zarr discussion later, but the live UI contract must not depend on Zarr for the first production slice.

---

## 6. UI Architecture

### 6.1 Module Boundaries

Use existing module id:

```text
apps/control-room/src/modules/analysis-plots
```

Do not create a separate `charts` app tree. Rename display title from `Analysis` to `Charts` if desired, but preserve module ownership unless an ADR changes the catalog.

Create or modify:

```text
apps/control-room/src/modules/analysis-plots/AnalysisPlotsModule.tsx
apps/control-room/src/modules/analysis-plots/manifest.ts
apps/control-room/src/modules/analysis-plots/components/EChartsSurface.tsx
apps/control-room/src/modules/analysis-plots/components/ChartToolbar.tsx
apps/control-room/src/modules/analysis-plots/components/SeriesLegend.tsx
apps/control-room/src/modules/analysis-plots/components/TablePreviewGrid.tsx
apps/control-room/src/modules/analysis-plots/hooks/useEChartsInstance.ts
apps/control-room/src/modules/analysis-plots/hooks/useLiveTableWindow.ts
apps/control-room/src/modules/analysis-plots/hooks/useChartResizeObserver.ts
apps/control-room/src/modules/analysis-plots/model/chartOptionModel.ts
apps/control-room/src/modules/analysis-plots/model/chartSeriesModel.ts
apps/control-room/src/modules/analysis-plots/model/chartUnits.ts
apps/control-room/src/modules/analysis-plots/model/tableWindowModel.ts
apps/control-room/src/modules/analysis-plots/model/decimationModel.ts
apps/control-room/src/modules/analysis-plots/model/echartsTheme.ts
```

Shared cross-slot chart UI state:

```text
apps/control-room/src/kernel/charts/ChartWorkspaceStore.ts
apps/control-room/src/kernel/charts/chartWorkspaceTypes.ts
apps/control-room/src/kernel/charts/chartWorkspaceCommands.ts
```

Reason: the center chart module and the right inspector both edit the same chart configuration. This is workspace UI state, not server resource data. It may persist layout/preferences, but must not store table rows.

### 6.2 Inspector Integration

Add a chart selection kind:

```typescript
{
  type: "chart-view";
  kind: "analysis.chart";
  nodeId: string;
  chartId: string;
}
```

Modify:

```text
apps/control-room/src/kernel/selection/selectionTypes.ts
apps/control-room/src/modules/inspector/inspectorRegistry.tsx
apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx
apps/control-room/src/modules/inspector/panels/ChartInspectorPanelModel.ts
apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.test.tsx
apps/control-room/src/modules/inspector/panels/ChartInspectorPanelModel.test.ts
```

Inspector edits call chart workspace controller commands. It must not import `analysis-plots` internals.

### 6.3 ECharts Option Policy

2D line chart:

- `xAxis.type = "value"` for `step` and `t`;
- `dataZoom` has `inside` and `slider`;
- `tooltip.trigger = "axis"`;
- `axisPointer.type = "cross"`;
- `animation = false` during live follow;
- `progressive`/`large` options only when they are supported for the selected series;
- `showSymbol = false` by default for dense series;
- series names are stable ids, not labels that change with formatting.

Axis policy:

- same unit and compatible dimension -> same Y axis;
- two different units -> max two Y axes;
- more than two incompatible units -> show disabled/error state before rendering;
- user can pin a series to left/right axis only within compatibility rules;
- unitless normalized quantities (`mx`, `my`, `mz`) share one axis.

3D chart:

- `scatter3D`/`lines3D` only after `echarts-gl` is loaded dynamically; ECharts GL does not have a stable `line3D` series type — use `lines3D` (plural) for connected trajectories and `scatter3D` for point clouds;
- max point budget is stricter than 2D;
- 3D is for phase-space or parameter-space plots, not default time history;
- if selected columns do not provide valid x/y/z dimensions, inspector shows a precise disabled reason.

### 6.4 Visual Design

Use `fm-*` classes and `--fm-*` tokens only.

CSS files:

```text
apps/control-room/src/design/styles/analysis-plots.css
apps/control-room/src/design/styles/inspector.css
```

Design requirements:

- dense scientific instrument look, not dashboard marketing cards;
- axis titles include quantity and unit;
- top toolbar uses shadcn-style primitives and lucide icons;
- legend shows colored swatches, units, live/stale status, latest value;
- range controls use numeric inputs with units and a trim/follow segmented control;
- chart area has stable dimensions and does not resize on data arrival;
- no window-level resize listener; use `ResizeObserver`;
- loading, stale, resync, and unsupported states are visibly distinct.

---

## 7. Implementation Tasks

### Task 1: Physics/Observable Note And Contract Tightening

**Files:**

- Create: `docs/physics/0910-table-autosave-observables.md`
- Modify: `docs/specs/frontend-v2/16-charts-analysis-module.md`
- Modify: `docs/specs/resource-first-control-room-api-v2.md`

- [ ] **Step 1:** Write `docs/physics/0910-table-autosave-observables.md` from `docs/physics/TEMPLATE.md`.

Required sections:

```text
physical problem statement: table autosave records scalar observables during time/relaxation studies
governing equations: no new equations; observables derive from existing StepStats and energy definitions
SI units: s, J, A/m, T, unitless normalized magnetization
FDM interpretation: cell-volume averages and energies from existing FDM metrics
FEM interpretation: node/element observables from existing FEM StepStats and energy terms
CPU/GPU interpretation: same public quantity ids, separate runtime realizations
Python API impact: TableAutosave(t_sampl=...) as __init__ parameter on Relaxation/TimeEvolution
ProblemIR impact: TableAutosaveIR under SamplingIR
OpenAPI impact: data/tables resources, rows.bin codec, realtime invalidation
Validation: cadence, units, row cursor, resource invalidation, chart update
```

- [ ] **Step 2:** Update `docs/specs/frontend-v2/16-charts-analysis-module.md` to replace the proposed SVG/Recharts-neutral plan with the ECharts-backed table-series contract in this plan.

- [ ] **Step 3:** Update `docs/specs/resource-first-control-room-api-v2.md` with `data/tables` ownership, row-window queries, `.bin` payload, and the rule that `data/scalars` is a compatibility projection.

- [ ] **Step 4:** Run documentation guard:

```bash
rg "data/tables|table_autosave|rows.bin|analysis.chart" docs/physics/0910-table-autosave-observables.md docs/specs/frontend-v2/16-charts-analysis-module.md docs/specs/resource-first-control-room-api-v2.md
```

Expected: all four terms are present in the relevant docs.

### Task 2: Python DSL Table Autosave API

**Files:**

- Modify: `packages/fullmag-py/src/fullmag/model/study.py`
- Modify: `packages/fullmag-py/src/fullmag/model/outputs.py`
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Test: `packages/fullmag-py/tests/test_table_autosave.py`

- [ ] **Step 1:** Add failing tests for:
  - `fm.Relaxation(..., table_autosave=fm.TableAutosave(t_sampl=1e-12))` lowers default columns;
  - explicit `quantities=[...]` preserves order;
  - invalid `t_sampl <= 0` fails;
  - unsupported column id fails with the canonical quantity error;
  - script export round-trips the method call.

- [ ] **Step 2:** Add a frozen dataclass in `outputs.py` (alongside `SaveField`, `SaveScalar`):

```python
DEFAULT_TABLE_QUANTITIES: tuple[str, ...] = (
    "step", "t", "mx", "my", "mz", "e_total", "max_torque",
)

@dataclass(frozen=True, slots=True)
class TableAutosave:
    t_sampl: float
    quantities: Sequence[str] = DEFAULT_TABLE_QUANTITIES
    extra_quantities: Sequence[str] = ()

    def __post_init__(self) -> None:
        require_positive(self.t_sampl, "t_sampl")
        merged = list(self.quantities)
        for q in self.extra_quantities:
            q = require_non_empty(q, "extra_quantity")
            if q not in merged:
                merged.append(q)
        normalized = tuple(require_non_empty(q, "quantity") for q in merged)
        if not normalized:
            raise ValueError("table_autosave requires at least one quantity")
        object.__setattr__(self, "quantities", normalized)
        object.__setattr__(self, "extra_quantities", tuple(self.extra_quantities))

    def to_ir(self) -> dict[str, object]:
        return {
            "kind": "table_autosave",
            "sample_period_s": self.t_sampl,
            "quantities": list(self.quantities),
        }
```

- [ ] **Step 3:** Add `table_autosave` as an optional `__init__` parameter on `Relaxation` and `TimeEvolution`.

Implementation direction (consistent with existing `stop`, `dynamics` pattern on frozen dataclasses):

```python
relax = fm.Relaxation(
    outputs=[fm.SaveField("m", every=1e-12)],
    table_autosave=fm.TableAutosave(t_sampl=1e-12),
)
```

`Relaxation.__init__` already uses custom init with `object.__setattr__`; add `table_autosave: TableAutosave | None = None` as another optional parameter. Same for `TimeEvolution`. Do not add to `Eigenmodes` or `FrequencyResponse` — those study types do not have time-stepping table semantics.

- [ ] **Step 4:** Update `to_ir()` for `TimeEvolution` and `Relaxation` so `sampling` contains both existing `outputs` and optional `table_autosave`:

```python
def to_ir(self) -> dict[str, object]:
    sampling: dict[str, object] = {
        "outputs": [output.to_ir() for output in self.outputs],
    }
    if self.table_autosave is not None:
        sampling["table_autosave"] = self.table_autosave.to_ir()
    return {
        "kind": "relaxation",
        ...,
        "sampling": sampling,
    }
```

- [ ] **Step 5:** Run:

```bash
pytest packages/fullmag-py/tests/test_table_autosave.py -q
python3 -m py_compile packages/fullmag-py/src/fullmag/model/study.py packages/fullmag-py/src/fullmag/model/outputs.py packages/fullmag-py/src/fullmag/runtime/script_builder.py
```

Expected: focused tests pass and files compile.

### Task 3: ProblemIR Sampling Contract

**Files:**

- Modify: `crates/fullmag-ir/src/study.rs`
- Modify: `crates/fullmag-ir/src/quantities.rs`
- Modify: `crates/fullmag-ir/src/lib.rs`
- Test: `crates/fullmag-ir/tests/ir_tests.rs`

- [ ] **Step 1:** Add failing Rust tests for serialization, validation, and default table quantities.

- [ ] **Step 2:** Add:

```rust
pub struct TableAutosaveIR {
    pub sample_period_s: f64,
    pub quantities: Vec<String>,
}

pub struct SamplingIR {
    pub outputs: Vec<OutputIR>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub table_autosave: Option<TableAutosaveIR>,
}
```

- [ ] **Step 3:** Validate:
  - `sample_period_s > 0`;
  - at least one quantity;
  - duplicate columns are rejected unless the second entry has a distinct alias;
  - `step`, `t`, `max_torque` aliases are normalized for runtime but preserved for provenance.

- [ ] **Step 4:** Keep legacy `OutputIR::Scalar` as-is. It coexists with the new `TableAutosaveIR`. `OutputIR::Scalar` continues to work for its existing purpose (per-output cadence scalar recording). `TableAutosaveIR` is an orthogonal mechanism that samples all selected quantities at a single unified cadence. Do not introduce `OutputSinkIR::TableRow` — that abstraction is unnecessary for the first slice.

- [ ] **Step 5:** Run:

```bash
cargo test -p fullmag-ir table_autosave --no-fail-fast
cargo test -p fullmag-ir ir_tests --no-fail-fast
```

Expected: new table tests pass; existing IR tests remain green.

### Task 4: Runtime Table Store And Artifacts

**Files:**

- Create: `crates/fullmag-runner/src/table_autosave.rs`
- Modify: `crates/fullmag-runner/src/types.rs`
- Modify: `crates/fullmag-runner/src/scalar_metrics.rs`
- Modify: `crates/fullmag-runner/src/interactive_runtime.rs`
- Modify: `crates/fullmag-runner/src/fdm/cpu/reference.rs`
- Modify as needed in FDM GPU/FEM paths only where they already produce `StepStats`
- Test: `crates/fullmag-runner/src/table_autosave.rs`
- Test: focused runtime tests that currently own scalar rows

- [ ] **Step 1:** Add failing tests for cadence, default columns, cursor windows, schema revision, and stale cursor resync.

- [ ] **Step 2:** Implement `TableAutosaveConfig`, `TableColumnMeta`, `TableRow`, `TableWindow`, and `TableStore`.

- [ ] **Step 3:** Implement row evaluation from `StepStats`:

```rust
match column_id {
    "step" => stats.step as f64,
    "t" | "time" => stats.time,
    "dt" | "solver_dt" => stats.dt,
    "mx" => stats.mx,
    "my" => stats.my,
    "mz" => stats.mz,
    "e_ex" => stats.e_ex,
    "e_demag" => stats.e_demag,
    "e_ext" => stats.e_ext,
    "e_ani" => stats.e_ani,
    "e_dmi" => stats.e_dmi,
    "e_total" => stats.e_total,
    "max_dm_dt" => stats.max_dm_dt,
    "max_h_eff" => stats.max_h_eff,
    "max_h_demag" => stats.max_h_demag,
    "max_torque" | "max_torque_Apm" => stats.max_torque_Apm,
    "max_torque_T" => stats.max_torque_T,
    _ => resolve_global_scalar_value(column_id, stats)?,
}
```

Column aliases: `t`↔`time`, `dt`↔`solver_dt`, `max_torque`↔`max_torque_Apm`. Canonical public names are the shorter forms (`t`, `dt`, `max_torque`). Longer forms are accepted as input aliases for backward compatibility with `data/scalars`.

- [ ] **Step 4:** Wire the store into live runtime publication so `scalars_revision` or new `tables_revision` advances only when rows are appended.

- [ ] **Step 4b:** Migration: `TableStore` becomes the single owner of periodic scalar history. Existing `scalar_rows: Vec<ScalarRow>` in `current_live_state` should be replaced by a `TableStore` reference. The `data/scalars` API handler reads from `TableStore` through its compatibility projection, not from a parallel `scalar_rows` vector. This prevents dual-source-of-truth during the transition.

- [ ] **Step 5:** Write CSV and schema artifacts at run completion. Do not block live UI on artifact IO.

- [ ] **Step 6:** Run focused checks:

```bash
cargo test -p fullmag-runner table_autosave --no-fail-fast
cargo test -p fullmag-runner scalar_metrics --no-fail-fast
```

For native FEM/MFEM/CUDA runtime proof after touching FEM/GPU paths, use repo `just` managed/container recipes, not host-first builds.

### Task 5: API Schemas, Routes, OpenAPI

**Files:**

- Create: `crates/fullmag-api/src/schemas/tables.rs`
- Create: `crates/fullmag-api/src/router_v2/handlers/data/tables.rs`
- Modify: `crates/fullmag-api/src/schemas/mod.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/mod.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/data/scalars.rs`
- Modify: `crates/fullmag-api/src/openapi_v2.rs`
- Modify: `crates/fullmag-api/src/schemas/status.rs`
- Test: `crates/fullmag-api/src/router_v2/tests.rs`

- [ ] **Step 1:** Add failing router tests for:
  - table list;
  - table metadata;
  - columns metadata with units;
  - `rows?cursor=...&columns=...`;
  - `rows?from_t=...&to_t=...&target_points=...`;
  - stale cursor `resync_required`;
  - `data/scalars` compatibility projection;
  - WebSocket invalidation does not carry row data.

- [ ] **Step 2:** Add schemas for `TableListResource`, `TableResource`, `TableColumnMeta`, `TableRowsResource`, `TableDecimationMeta`.

- [ ] **Step 3:** Add `.bin` schema and content type. Keep JSON OpenAPI explicit even if binary route body is `application/octet-stream`.

- [ ] **Step 4:** Add `tables_revision` to status only if it does not duplicate `scalars_revision`. If `scalars_revision` remains the single table freshness pointer, document that name as transitional and add a removal path.

- [ ] **Step 5:** Regenerate control-room API artifacts:

```bash
pnpm --dir apps/control-room generate:api
```

Expected: `openapi-v2.json`, `openapi-v2-types.ts`, and `openapi-v2-client.ts` change from schema source, not manual edits.

- [ ] **Step 6:** Run:

```bash
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room check:api-hygiene
```

### Task 6: Frontend API Facade And Resource Hooks

**Files:**

- Modify: `apps/control-room/src/kernel/api/apiPaths.ts`
- Modify: `apps/control-room/src/kernel/api/apiTypes.ts`
- Modify: `apps/control-room/src/kernel/api/ControlRoomApi.ts`
- Create: `apps/control-room/src/kernel/api/codecs/tableRowsCodec.ts`
- Create: `apps/control-room/src/kernel/api/codecs/tableRowsCodec.test.ts`
- Modify: `apps/control-room/src/kernel/api/codecs/index.ts`
- Create: `apps/control-room/src/kernel/resources/tableResources.ts`
- Create: `apps/control-room/src/kernel/resources/tableResources.test.ts`
- Modify: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.ts`
- Test: `apps/control-room/src/kernel/realtime/RealtimeInvalidationBridge.test.ts`

- [ ] **Step 1:** Add RED tests for table paths, facade methods, JSON rows, binary decode, resource key identity, and invalidation.

- [ ] **Step 2:** Add facade:

```typescript
api.data.tables.list()
api.data.tables.detail(tableId)
api.data.tables.columns(tableId)
api.data.tables.rows(tableId, query)
api.data.tables.rowsBinary(tableId, query)
```

- [ ] **Step 3:** Add resource hooks:

```typescript
useTableListResource()
useTableMetadataResource(tableId)
useTableColumnsResource(tableId)
useTableRowsResource({ tableId, columns, cursor, range, targetPoints, preferBinary })
```

- [ ] **Step 4:** Ensure resource hooks key by `tableId`, selected columns, range, cursor, target points, binary/json mode, and revision.

- [ ] **Step 5:** Remove old scalar-window-only assumptions from `analysis-plots`. `useScalarWindowResource` in `kernel/resources/studyRuntimeResources.ts` becomes a thin deprecation wrapper that delegates to `useTableRowsResource({ tableId: "default", ... })` from `kernel/resources/tableResources.ts`. Existing call sites in `AnalysisPlotsModule.tsx` migrate to the new hook. The wrapper remains until no other consumer references it.

- [ ] **Step 6:** Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/api/codecs/tableRowsCodec.test.ts src/kernel/resources/tableResources.test.ts src/kernel/realtime/RealtimeInvalidationBridge.test.ts
pnpm --dir apps/control-room typecheck
```

### Task 7: Chart Workspace State And Commands

**Files:**

- Create: `apps/control-room/src/kernel/charts/chartWorkspaceTypes.ts`
- Create: `apps/control-room/src/kernel/charts/ChartWorkspaceStore.ts`
- Create: `apps/control-room/src/kernel/charts/chartWorkspaceCommands.ts`
- Create: `apps/control-room/src/kernel/charts/ChartWorkspaceStore.test.ts`
- Modify: `apps/control-room/src/kernel/KernelProvider.tsx`
- Modify: `apps/control-room/src/kernel/types.ts`
- Modify: `apps/control-room/src/kernel/persistence/controlRoomUiState.ts`

- [ ] **Step 1:** Add RED tests proving the store owns only UI preferences:
  - selected chart id;
  - visible series ids;
  - zoom/trim range;
  - live-follow mode;
  - axis assignments;
  - 3D chart mode.

- [ ] **Step 2:** Prove it never stores table row arrays.

- [ ] **Step 3:** Add commands:

```text
analysis-plots.open
analysis-plots.add-series
analysis-plots.remove-series
analysis-plots.set-range
analysis-plots.toggle-follow-tail
analysis-plots.set-axis-assignment
analysis-plots.set-chart-kind
analysis-plots.export-visible-data
```

- [ ] **Step 4:** Persist only chart preferences and layout. Do not persist table data, revisions, or runtime snapshots.

- [ ] **Step 5:** Run:

```bash
pnpm --dir apps/control-room exec vitest run src/kernel/charts/ChartWorkspaceStore.test.ts
rg "rows:" apps/control-room/src/kernel/charts apps/control-room/src/kernel/persistence
```

Expected: tests pass; grep does not show persisted row arrays.

### Task 8: ECharts Module Implementation

**Files:**

- Modify/Create files listed in section 6.1
- Modify: `apps/control-room/package.json`
- Modify: lockfile after package install
- Modify: `apps/control-room/src/design/styles/analysis-plots.css`
- Test: `apps/control-room/src/modules/analysis-plots/*.test.ts`
- Test: `apps/control-room/src/modules/analysis-plots/**/*.test.ts`

- [ ] **Step 1:** Add dependencies:

```bash
pnpm --dir apps/control-room add echarts echarts-gl
```

- [ ] **Step 2:** Add RED tests for `chartUnits.ts`:
  - `mx/my/mz` share one unitless axis;
  - `e_total` and `e_demag` share `J`;
  - `max_torque` and `e_total` require twin axes;
  - three incompatible dimensions produce an unsupported model.

- [ ] **Step 3:** Add RED tests for `chartOptionModel.ts`:
  - stable series ids;
  - `dataZoom` present;
  - live mode disables animation;
  - axis labels include units;
  - 3D mode uses `grid3D`, `xAxis3D`, `yAxis3D`, `zAxis3D`.

- [ ] **Step 4:** Implement `useEChartsInstance`:
  - initialize in client only;
  - use Canvas renderer for 2D;
  - dynamically import `echarts-gl` only for 3D;
  - call `dispose()` on unmount;
  - guard against disposed instance before updates.

- [ ] **Step 5:** Implement `useLiveTableWindow`:
  - on first mount fetch latest visible tail with `target_points`;
  - in follow-tail mode fetch delta with `cursor`;
  - if delta is small, append to local bounded visible buffer;
  - if delta exceeds point budget or server reports resync, fetch visible tail again;
  - on zoom/trim, fetch explicit range, stop follow-tail.

- [ ] **Step 6:** Implement toolbar and legend with shared primitives/icons:
  - follow tail;
  - trim range;
  - export visible;
  - chart kind 2D/3D;
  - target point budget;
  - add/remove series.

- [ ] **Step 7:** Replace current SVG chart cards in `AnalysisPlotsModule.tsx` with ECharts surfaces.

- [ ] **Step 8:** Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/analysis-plots
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
```

### Task 9: Chart Inspector

**Files:**

- Modify: `apps/control-room/src/kernel/selection/selectionTypes.ts`
- Modify: `apps/control-room/src/modules/inspector/inspectorRegistry.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanelModel.ts`
- Create: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanel.test.tsx`
- Create: `apps/control-room/src/modules/inspector/panels/ChartInspectorPanelModel.test.ts`

- [ ] **Step 1:** Add RED tests for resolving `analysis.chart` to `ChartInspectorPanel`.

- [ ] **Step 2:** Add model tests for:
  - changing `t_sampl`;
  - adding/removing quantities;
  - rejecting more than two incompatible axes;
  - trim range validation;
  - 3D x/y/z column validation.

- [ ] **Step 3:** Implement the panel using shared inspector primitives:
  - segmented controls for live/range/3D;
  - checkboxes/toggles for visible series;
  - numeric inputs with units for `t_sampl`, from/to, target points;
  - menus for axis assignment and quantity add.

- [ ] **Step 4:** Commit table-autosave authoring changes through `model/study` or `model/transactions`, not direct local-only session mutation.

- [ ] **Step 5:** Run:

```bash
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/ChartInspectorPanelModel.test.ts src/modules/inspector/panels/ChartInspectorPanel.test.tsx
pnpm --dir apps/control-room typecheck
```

### Task 10: Study Authoring Round Trip

**Files:**

- Modify: `crates/fullmag-api/src/schemas/authoring.rs`
- Modify: `crates/fullmag-api/src/router_v2/handlers/model/study.rs` if present, or current model study handler
- Modify: `packages/fullmag-py/src/fullmag/runtime/script_builder.py`
- Modify: `apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`
- Test matching files

- [ ] **Step 1:** Add tests proving UI-authored table autosave exports canonical Python:

```python
table_autosave=fm.TableAutosave(t_sampl=1e-12, quantities=["step", "t", "mx"])
```

- [ ] **Step 2:** Add tests proving Python-authored table autosave appears in `model/study` and chart inspector.

- [ ] **Step 3:** Preserve requested intent and resolved runtime provenance:
  - requested `t_sampl`;
  - requested columns;
  - resolved supported columns;
  - unsupported columns with explicit diagnostics.

- [ ] **Step 4:** Run:

```bash
pytest packages/fullmag-py/tests/test_table_autosave.py -q
cargo test -p fullmag-api model_study --no-fail-fast
pnpm --dir apps/control-room exec vitest run src/modules/inspector/panels/StudyGlobalAuthoringModel.test.ts
```

### Task 11: Performance, Memory, And Browser Verification

**Files:**

- Create: `apps/control-room/scripts/smoke-live-charts.mjs`
- Create: `apps/control-room/scripts/audit-chart-performance.mjs`
- Modify: `apps/control-room/package.json`
- Create: relevant tests under `apps/control-room/src/modules/analysis-plots`

- [ ] **Step 1:** Add browser smoke:

```bash
pnpm --dir apps/control-room smoke:live-charts
```

Assertions:

- `/workspace` opens;
- `Charts` tab activates;
- no `.fm-viewport-3d__canvas` is mounted while charts are active;
- ECharts canvas is visible and non-zero size;
- a simulated `resource.batch_changed` invalidates table rows;
- the chart requests only delta rows after its cursor;
- zoom switches to visible-range fetch;
- inspector edits series without direct component fetch.

- [ ] **Step 2:** Add performance audit:

```bash
pnpm --dir apps/control-room audit:chart-performance
```

Budgets:

- idle chart redraws: zero after settling;
- idle API polling: zero;
- normal live delta update: one HTTP fetch per table revision batch;
- no chart instance leak after 100 tab switches;
- no unbounded row arrays retained after trim/range changes.

- [ ] **Step 3:** Run final frontend gates:

```bash
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room build
```

If `next typegen` rewrites `apps/control-room/next-env.d.ts`, inspect and revert unrelated generated churn unless the route contract truly changed.

### Task 12: End-To-End Runtime Validation

**Files:**

- Add or update an example script, e.g. `examples/permalloy_table_autosave.py`
- Add runtime verifier script if needed

- [ ] **Step 1:** Run a Python-authored study with:

```python
relax = fm.Relaxation(
    outputs=[fm.SaveField("m", every=1e-12)],
    table_autosave=fm.TableAutosave(t_sampl=1e-12),
)
```

- [ ] **Step 2:** Verify API:

```bash
curl 'http://localhost:8081/v2/sessions/current/data/tables'
curl 'http://localhost:8081/v2/sessions/current/data/tables/default/rows?columns=step,t,mx,my,mz,e_total,max_torque&limit=10'
```

Expected:

- rows contain default columns;
- units are present through metadata;
- row cursors advance;
- no full table data is present in WebSocket frames.

- [ ] **Step 3:** Verify browser:

```bash
CONTROL_ROOM_URL=http://localhost:3101/workspace pnpm --dir apps/control-room smoke:live-charts
```

- [ ] **Step 4:** For FEM/MFEM/CUDA touched runtime paths, final runtime proof must use container-backed `just` recipes, for example:

```bash
just ensure-managed-fem-runtime
just verify-fem-relaxation-runtime
```

Do not report host-only cargo/cmake proof as final FEM runtime proof.

---

## 8. Rollout Strategy

1. **Contract slice:** docs, Python DSL, IR, API schema, generated types.
2. **Runtime slice:** table store, row windows, metadata, compatibility `data/scalars`.
3. **Frontend data slice:** facade, resource hooks, binary codec, invalidation tests.
4. **ECharts slice:** 2D charts, unit axes, live delta, zoom/range, disposal.
5. **Inspector slice:** table autosave authoring and chart configuration.
6. **3D chart slice:** ECharts GL phase-space mode behind capability/config gate.
7. **Performance slice:** browser smoke, chart audit, large-history scenario.

Each slice must be shippable. Do not land a UI-only chart that depends on ad hoc scalar polling.

---

## 9. Acceptance Checklist

- [ ] Python API supports `table_autosave=fm.TableAutosave(t_sampl=...)` on `Relaxation` and `TimeEvolution`.
- [ ] Default table columns are `step`, `t`, `mx`, `my`, `mz`, `e_total`, `max_torque`.
- [ ] UI can add/remove table quantities.
- [ ] UI can edit `t_sampl`.
- [ ] ProblemIR preserves table autosave intent.
- [ ] Runtime appends rows on simulation-time cadence.
- [ ] API exposes table metadata with units.
- [ ] API supports cursor delta fetch.
- [ ] API supports visible-range fetch.
- [ ] API supports server decimation by target points.
- [ ] API has binary row-window path for large windows.
- [ ] WebSocket sends invalidations only, never full table data.
- [ ] ECharts 2D charts update live without refetching full history.
- [ ] ECharts charts support zoom and trim range.
- [ ] Same-unit series can render together.
- [ ] Different-unit series support max two Y axes.
- [ ] More than two incompatible units produce a disabled/error state.
- [ ] ECharts GL 3D mode supports valid x/y/z quantity selections.
- [ ] `viewport-main` tabs switch between 3D and Charts.
- [ ] Inactive `viewport-3d` unmounts while Charts is active.
- [ ] Chart inspector edits chart/table settings.
- [ ] No direct `fetch()` in modules/components.
- [ ] No hand-built `/v2/...` strings outside generated/facade path layer.
- [ ] No table row arrays in Zustand/kernel persisted storage.
- [ ] ECharts instances dispose on unmount.
- [ ] `pnpm --dir apps/control-room typecheck` passes.
- [ ] `pnpm --dir apps/control-room lint` passes with `--max-warnings=0`.
- [ ] `pnpm --dir apps/control-room test` passes.
- [ ] Browser smoke proves visible charts and delta requests.
- [ ] Runtime proof verifies real table rows from a Python-authored run.

---

## 10. Risks And Controls

| Risk | Control |
|---|---|
| Full table refetch on every revision | Cursor delta plus visible-range fetch; smoke asserts request query. |
| Browser memory growth | Bounded visible buffers, server decimation, binary decode disposal, tab-switch stress. |
| Unit-incompatible chart clutter | Unit grouping and max-two-axis guard before rendering. |
| ECharts bundle bloat | Modular imports and dynamic `echarts-gl` only when 3D mode is active. |
| Direct module transport drift | `check:api-hygiene` plus greps for `fetch(` and `/v2/`. |
| Inspector imports chart internals | Shared kernel chart workspace controller; no `inspector -> analysis-plots` imports. |
| Ambiguous `max_torque` units | Canonical alias maps to `A/m`; `max_torque_T` remains explicit. |
| Adaptive timestep sampling ambiguity | Coalesced-to-step policy documented; no fake interpolation. |
| `data/scalars` and `data/tables` split ownership | `data/scalars` becomes compatibility projection over default table. |

---

## 11. Final Verification Commands

Run the narrow checks during slices, then this final gate:

```bash
pytest packages/fullmag-py/tests/test_table_autosave.py -q
cargo test -p fullmag-ir table_autosave --no-fail-fast
cargo test -p fullmag-runner table_autosave --no-fail-fast
cargo test -p fullmag-api router_v2 --no-fail-fast
pnpm --dir apps/control-room generate:api
pnpm --dir apps/control-room check:architecture-hygiene
pnpm --dir apps/control-room check:api-hygiene
pnpm --dir apps/control-room test
pnpm --dir apps/control-room typecheck
pnpm --dir apps/control-room lint
pnpm --dir apps/control-room build
CONTROL_ROOM_URL=http://localhost:3101/workspace pnpm --dir apps/control-room smoke:live-charts
CONTROL_ROOM_URL=http://localhost:3101/workspace pnpm --dir apps/control-room audit:chart-performance
```

If native FEM/MFEM/CUDA paths are touched, add managed runtime proof through the repo `justfile`:

```bash
just ensure-managed-fem-runtime
just verify-fem-relaxation-runtime
```

---

## 12. Self-Audit Against User Requirements

| Requirement | Covered by |
|---|---|
| Live-updated 1D/2D charts using ECharts | Sections 3, 6, Tasks 8, 11 |
| AmuMax-like table data concept | Sections 2, 5 |
| Python/UI quantity selection for table | Sections 1, Tasks 2, 9, 10 |
| `t_sampl` support | Sections 1, 5, Tasks 2, 9 |
| Defaults `step`, `t`, `mx`, `my`, `mz`, `e_total`, `max_torque` | Sections 1, 5 |
| `table_autosave=fm.TableAutosave(t_sampl=...)` | Section 1, Task 2 |
| Efficient incremental UI updates | Sections 4, 5, Tasks 6, 8, 11 |
| Avoid sending full data every N seconds | Sections 4.5, 8, Acceptance |
| Beautiful UI with units/scaling | Sections 6.3, 6.4, Task 8 |
| Multi-series same unit | Section 6.3, Task 8 |
| Max two twin axes for different units | Section 6.3, Task 8 |
| ECharts GL 3D charts | Sections 3, 6.3, Task 8 |
| Zooming and trimming | Sections 1.2, 4.2, 6.3, Tasks 8, 9 |
| Main window tab switch 3D/Charts | Sections 1.2, 6.1, Acceptance |
| Inspector edits chart parameters | Sections 6.2, Task 9 |
| Production verification | Sections 7, 11 |

No known user requirement is intentionally deferred. The only staged part is that ECharts GL 3D mode is behind its own implementation slice so the 2D live table pipeline can ship and be validated first.
