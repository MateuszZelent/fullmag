# Table Autosave Observables

- Status: canonical
- Owners: Fullmag core
- Last updated: 2026-07-28
- Related ADRs: `docs/adr/0011-resource-first-api.md`, `docs/adr/0013-frontend-v2-module-kernel.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/16-charts-analysis-module.md`

## 1. Problem Statement

Fullmag needs a canonical table autosave contract for live scalar observables.
Users must be able to choose which scalar quantities are sampled during a time
or relaxation study, inspect the samples live in the control room, and export
the same intent through the public Python model. The table is an observable
stream, not a viewport cache and not a backend-specific debug log.

The first production table is `default`. It records solver-state scalar
observables at a simulation-time cadence or an accepted-relaxation-step
cadence. The live UI may display the data as 1D, 2D, or 3D charts, but the
chart state never owns the physical samples.

`Relax` and `Run` stages may also own a complete autosave policy. That policy
selects a named result target, storage layout, file format, table sampling, and
field snapshots. Stage ownership is strict: a policy is active only while its
owning stage executes and cannot leak into a following stage.

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

Time-evolution sampling is triggered by simulation time:

```text
t_current + eps >= t_next_sample
```

When adaptive stepping crosses several requested sample times in one solver
step, the first implementation records the current solver state once and marks
the sample policy as coalesced. It does not invent interpolated physics values.

Relaxation uses an explicit accepted-step cadence:

```text
accepted_step == 0
or accepted_step mod every_steps == 0
or accepted_step is the final accepted state
```

`every_steps` counts accepted solver states only. Rejected line-search,
trust-region, or adaptive-controller candidates are diagnostics, not table
rows. A relaxation table always includes the initial and final state; a final
state already on cadence is not duplicated.

### 2.2 Symbols and SI Units

| Symbol or column | Meaning | SI unit |
|---|---|---|
| `step` | solver step index | `1` |
| `t` | physical simulation time, only for time evolution | `s` |
| `pseudo_time_s` | algorithmic relaxation clock, never physical time | `s` |
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
- A time-evolution cadence is in simulation seconds, not wall-clock seconds.
- A relaxation `every_steps` cadence is dimensionless and counts accepted
  states. It is the compatible coordinate for direct minimizers.
- A direct minimizer does not expose `t=0` as physical time. Its table charts
  default to `step`; pseudo time may be displayed only as `pseudo_time_s`.
- UI decimation is a display/read-model concern; it must preserve the stored
  table values and never become the canonical artifact.
- The browser receives invalidations and cursor metadata over realtime events;
  it fetches row windows through HTTP resources.

### 2.4 Solver attempts are not table-autosave rows

Contract: `LLG-TD-ATTEMPT-V1`.

Solver attempts include rejected candidates and controller decisions that do
not correspond to published physical states. They are recorded in the bounded
`solver_attempts.csv` diagnostic artifact defined by the canonical LLG
time-domain contract. They are not inserted into a user table, resampled at an
output cadence, interpolated, or coalesced.

Table autosave contains accepted-state observables only. Its documented
coalesced behavior when one adaptive step crosses several output times does
not alter, compress, or replace the one-record-per-attempt solver trace.

The live solver read-model may expose the latest accepted-step `Error`,
configured `MaxError`, suggested next `dt`, and rejected-attempt count. In
maximum-error mode `Error` and `MaxError` are absolute embedded vector errors
and may be compared directly. The normalized controller metric `eta` remains
in `solver_attempts.csv`; advanced `atol + rtol` mode must not relabel `eta` as
an absolute error or compare it directly with `atol`.

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

# relaxation stage (canonical table-only shorthand)
study.stages.add_relax(
    stage_id="relax",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
).tableautosave(every_steps=10)

# complete stage-local autosave policy
study.stages.add_relax(
    stage_id="relax-2",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
).autosave(fm.StageAutosave(
    target="main",
    layout="continuous",
    format="zarr",
    table=fm.TableAutosave(
        every_steps=10,
        quantities=["step", "mx", "my", "mz", "e_total"],
    ),
    fields=[fm.FieldAutosave("m", every_steps=100)],
))
```

`TimeEvolution` accepts only a physical-time cadence; `Relaxation` accepts
only `every_steps`. The default column set is:

```text
step, t, mx, my, mz, e_total, max_torque
```

Persistent `study.stages.tableautosave(...)` actions remain readable for
compatibility. New relaxation scripts attach accepted-step sampling directly
to the owning relaxation stage so the cadence cannot leak into later stages.

`FieldAutosave` requires exactly one cadence: `every` for physical-time Run
stages or `every_steps` for accepted-step Relax stages. `StageAutosave`
defaults to `target="main"`, `layout="continuous"`, and `format="zarr"`.
At least one table or field policy is required.

### 4.2 ProblemIR Representation

`SamplingIR` exposes an optional stage autosave policy containing `target`,
`layout = continuous | separate`, `format = zarr | hdf5 | txt`, an optional
table policy, and zero or more field policies. The nested table policy keeps:

- exactly one cadence: `sample_period_s` / `sample_period_policy` or
  `every_steps`
- `quantities`
- `table_id`

The IR field uses SI-clean names and public quantity identifiers. UI-authored
and Python-authored studies must lower to the same IR.

### 4.3 Planner and Capability-Matrix Impact

Planners validate that time cadence is used for physical time evolution and
that accepted-step cadence is used for relaxation. Each requested quantity
must be supported by the resolved backend. Unsupported columns fail clearly;
they are not silently omitted.

Stages joining one continuous target must agree on format and compatible table
and field schemas. Mesh identity, value type, component count, quantity
identity, and chunking must remain compatible. Strict execution rejects a
conflict before opening the target and never silently forks it.

### 4.4 Storage formats and stage layout

| Format | Scalar tables | Spatial fields | Default |
|---|---:|---:|---:|
| Zarr | yes | yes | yes |
| HDF5 | yes | yes | no |
| TXT | yes | no | no |

TXT field autosave is invalid at every public boundary. The error must retain
the user's field configuration for correction; UI authoring must not silently
delete it.

Zarr and HDF5 store numerical payloads once under explicit stage groups:

```text
stages/<stage-index>-<stage-id>/table/<quantity>
stages/<stage-index>-<stage-id>/fields/<quantity>
```

For `layout="continuous"`, the same target also contains a `continuous`
hierarchy with ordered indexes and manifests only. It does not duplicate table
or field arrays. Readers reconstruct the logical sequence from stage-owned
payloads. `layout="separate"` produces one target per stage using the same
internal stage schema.

Every logical sample carries `sample_index`, `stage_index`, `stage_id`,
`stage_kind`, `stage_sample_index`, and `stage_step`. It also carries exactly
the applicable clock coordinate: physical `time_s` for Run or
`accepted_step` for Relax. Relaxation pseudotime is never merged with physical
Run time.

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

`TableResource` is the UI authority for the configured `columns`, `total_rows`
and cadence metadata. The Analysis Inspector reads this summary resource and
never guesses quantity availability from a chart or hard-coded scalar list.

The control room renders charts in the existing `analysis-plots` center module.
Chart zoom, series visibility, axis assignment, and trim range are UI state.
Table samples stay in resource hooks/cache and are fetched by cursor or visible
range with bounded row counts.

Selecting a Relax or Run node exposes the same stage-local policy in its
Inspector Autosave section: enablement, target, continuous/separate layout,
format, table cadence and quantities, and field snapshot entries. It submits a
canonical authoring transaction through the typed API facade. No direct
component transport or separate autosave endpoint is introduced.

At stage entry the runtime activates only the owning policy. At stage exit it
flushes and drains the existing bounded artifact pipeline before committing
the stage manifest. Encoding, compression, HDF5/Zarr writes, and TXT writes
remain outside solver callbacks and GPU control fences. Failed stages preserve
completed samples and record an incomplete marker and stop reason.

## 6. Validation Strategy

### 6.1 Analytical Checks

- Constant magnetization keeps `mx`, `my`, `mz` constant across table rows.
- Fixed-step runs sample exactly at the requested cadence.
- Adaptive-step overshoot emits coalesced samples without interpolation.
- Relaxation with `every_steps=10` emits `0, 10, 20, ...` accepted states and
  one final state; rejected candidates do not alter that sequence.
- Direct minimizer rows cannot be labelled or filtered as physical `t`.

### 6.2 Cross-Backend Checks

- FDM CPU and production FDM report matching default columns for the same small
  problem within existing scalar observable tolerances.
- FEM CPU/GPU report the same public column identifiers when the quantities are
  supported.

### 6.3 Regression Tests

- Python DSL serialization for default and custom `TableAutosave`.
- Python DSL serialization for `StageAutosave` and `FieldAutosave` in Relax
  and Run, including canonical script round-trip.
- ProblemIR serde round-trip for `sampling.table_autosave`.
- Cross-stage continuous-target compatibility and stage-leakage tests.
- Zarr and HDF5 layout/readback tests proving that `continuous` contains no
  duplicate numerical payload.
- TXT continuous/separate tests and TXT/field rejection.
- Bounded artifact-pipeline and solver-callback timing regression tests.
- v2 route tests for cursor, columns, limit, unit metadata, and scalar
  compatibility.
- frontend API facade and resource-hook tests proving bounded fetches and no
  interval polling.
- chart model tests for unit grouping, twin-axis limits, and visible-window
  decimation.
- Python and script-export tests for mutually exclusive `t_sampl` and
  `every_steps`, plus IR validation of ambiguous cadence input.

## 7. Completeness Checklist

- [x] Physics contract
- [ ] Python API
- [ ] ProblemIR
- [ ] Planner
- [ ] Capability matrix
- [ ] FDM backend
- [ ] FEM backend
- [ ] Hybrid backend
- [x] Outputs / observables contract
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
- HDF5 execution is capability-gated by the managed runtime. Strict mode fails
  closed when the writer dependency is unavailable and never falls back to
  Zarr.

## 9. References

- `external_solvers/amumax/src/engine/zarr_table.go`
- `external_solvers/amumax/frontend/src/lib/table-plot/table-plot.ts`
- Apache ECharts dynamic data guide
- Apache ECharts dataset guide
