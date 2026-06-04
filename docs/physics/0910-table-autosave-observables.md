# Table Autosave Observables

- Status: draft
- Owners: Fullmag core
- Last updated: 2026-06-04
- Related ADRs: `docs/adr/0011-resource-first-api.md`, `docs/adr/0013-frontend-v2-module-kernel.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/16-charts-analysis-module.md`

## 1. Problem Statement

Fullmag needs a canonical table autosave contract for live scalar observables.
Users must be able to choose which scalar quantities are sampled during a time
or relaxation study, inspect the samples live in the control room, and export
the same intent through the public Python model. The table is an observable
stream, not a viewport cache and not a backend-specific debug log.

The first production table is `default`. It records solver-step scalar
observables at a simulation-time cadence. The live UI may display the data as
1D, 2D, or 3D charts, but the chart state never owns the physical samples.

## 2. Physical Model

### 2.1 Governing Equations

The table does not introduce a new micromagnetic equation. It samples reduced
observables produced by the active study at solver states:

```text
m = M / M_s
<m_i>(t_k) = volume_average(m_i(x, t_k))
E_total(t_k) = E_ex + E_demag + E_ext + E_ani + E_dmi + ...
max_torque(t_k) = max_x |torque proxy(x, t_k)|
```

Sampling is triggered by simulation time:

```text
t_current + eps >= t_next_sample
```

When adaptive stepping crosses several requested sample times in one solver
step, the first implementation records the current solver state once and marks
the sample policy as coalesced. It does not invent interpolated physics values.

### 2.2 Symbols and SI Units

| Symbol or column | Meaning | SI unit |
|---|---|---|
| `step` | solver step index | `1` |
| `t` | simulation time | `s` |
| `dt` | solver timestep | `s` |
| `mx`, `my`, `mz` | volume averaged normalized magnetization components | `1` |
| `e_total` | total magnetic energy | `J` |
| `e_ex`, `e_demag`, `e_ext`, `e_ani`, `e_dmi` | energy contributions | `J` |
| `max_torque` | canonical max torque display alias | `A/m` |
| `max_torque_T` | max torque in tesla-equivalent display units | `T` |
| `max_dm_dt` | maximum magnetization-rate norm | `1/s` |
| `max_h_eff`, `max_h_demag` | maximum field magnitudes | `A/m` |

`time` and `solver_dt` remain accepted compatibility aliases for `t` and `dt`.
Public authoring and UI labels use `t` and `dt`.

### 2.3 Assumptions and Approximations

- Table autosave samples reduced observables at solver states only.
- It is disabled unless the user requests `table_autosave`.
- The sampling cadence is in simulation seconds, not wall-clock seconds.
- UI decimation is a display/read-model concern; it must preserve the stored
  table values and never become the canonical artifact.
- The browser receives invalidations and cursor metadata over realtime events;
  it fetches row windows through HTTP resources.

## 3. Numerical Interpretation

### 3.1 FDM

FDM backends already compute scalar reductions for solver status and energy
history. Table autosave reuses the same reduced quantities and stores selected
columns in append-only row order. The CPU reference path remains the oracle for
energy and magnetization reductions.

### 3.2 FEM

FEM backends expose the same public column identifiers. Backend-specific
integration and weighting stay below the scalar observable boundary. The table
contract does not expose MFEM, hypre, libCEED, mesh-part, or device-residency
details.

### 3.3 Hybrid

Hybrid execution must publish one resolved table schema per output table. If a
future hybrid run combines backend families, provenance records the resolved
source of each column.

## 4. API, IR, and Planner Impact

### 4.1 Python API Surface

The public DSL adds:

```python
fm.TableAutosave(t_sampl=1e-12)
study.table_autosave(t_sampl=1e-12)
```

`TimeEvolution` and `Relaxation` accept `table_autosave=...`. The default
column set is:

```text
step, t, mx, my, mz, e_total, max_torque
```

### 4.2 ProblemIR Representation

`SamplingIR` gains an optional `table_autosave` field with:

- `sample_period_s`
- `quantities`
- `table_id`

The IR field uses SI-clean names and public quantity identifiers. UI-authored
and Python-authored studies must lower to the same IR.

### 4.3 Planner and Capability-Matrix Impact

Planners validate that the requested study has a time-like progression and that
each requested quantity is supported by the resolved backend. Unsupported
columns fail clearly or are reported as degraded in provenance; they are not
silently omitted.

## 5. Runtime, OpenAPI, and UI Impact

Runtime owns append-only table rows and schema metadata. The v2 data family owns
the browser contract:

```text
GET /v2/sessions/current/data/tables
GET /v2/sessions/current/data/tables/{table_id}
GET /v2/sessions/current/data/tables/{table_id}/columns
GET /v2/sessions/current/data/tables/{table_id}/rows
GET /v2/sessions/current/data/tables/{table_id}/rows.bin
```

`rows.bin` uses `FMTB.v1.row-major-f64le`: magic `FMTB`, version `1`, a
little-endian flags word, revision/schema/cursor counters, row and column
counts, then row-major `f64` values. Flags bit 0 carries `resync_required` so a
binary-only chart consumer can discard stale cursor state without falling back
to the JSON row payload.

`GET /v2/sessions/current/data/scalars` stays a compatibility view over the
default table. Status carries only `scalars_revision` and resource pointers.
WebSocket events carry invalidations only, never full table rows.

The control room renders charts in the existing `analysis-plots` center module.
Chart zoom, series visibility, axis assignment, and trim range are UI state.
Table samples stay in resource hooks/cache and are fetched by cursor or visible
range with bounded row counts.

## 6. Validation Strategy

### 6.1 Analytical Checks

- Constant magnetization keeps `mx`, `my`, `mz` constant across table rows.
- Fixed-step runs sample exactly at the requested cadence.
- Adaptive-step overshoot emits coalesced samples without interpolation.

### 6.2 Cross-Backend Checks

- FDM CPU and production FDM report matching default columns for the same small
  problem within existing scalar observable tolerances.
- FEM CPU/GPU report the same public column identifiers when the quantities are
  supported.

### 6.3 Regression Tests

- Python DSL serialization for default and custom `TableAutosave`.
- ProblemIR serde round-trip for `sampling.table_autosave`.
- v2 route tests for cursor, columns, limit, unit metadata, and scalar
  compatibility.
- frontend API facade and resource-hook tests proving bounded fetches and no
  interval polling.
- chart model tests for unit grouping, twin-axis limits, and visible-window
  decimation.

## 7. Completeness Checklist

- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [ ] Outputs / observables
- [ ] OpenAPI v2 and generated frontend transport
- [ ] ECharts control-room UI
- [ ] Tests / benchmarks
- [ ] Documentation

## 8. Known Limits and Deferred Work

- The first implementation stores the live table from existing scalar rows and
  extends runtime sampling afterward.
- `rows.bin` is the production path for large windows, but JSON row windows are
  acceptable for the first small-window route tests.
- ECharts GL 3D series must stay behind a capability/config gate until the
  installed `echarts-gl` package is verified in `apps/control-room`.

## 9. References

- `external_solvers/amumax/src/engine/zarr_table.go`
- `external_solvers/amumax/frontend/src/lib/table-plot/table-plot.ts`
- Apache ECharts dynamic data guide
- Apache ECharts dataset guide
