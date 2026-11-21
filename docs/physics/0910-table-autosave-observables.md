# Table Autosave Observables

- Status: canonical
- Owners: Fullmag core
- Last updated: 2026-07-31
- Related ADRs: `docs/adr/0011-resource-first-api.md`, `docs/adr/0013-frontend-v2-module-kernel.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/16-charts-analysis-module.md`

(problem-statement)=

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

(governing-equations)=

### 2.1 Governing Equations

The table does not introduce a new micromagnetic equation. It samples reduced
observables produced by the active study at solver states:

```{math}
:label: eq-table-normalized-m
\mathbf{m}=\mathbf{M}/M_s
```

```{math}
:label: eq-table-moment-average
\langle m_i\rangle(t_k)=
\frac{\int_{\Omega_F} M_s(\mathbf{x})m_i(\mathbf{x},t_k)\,\mathrm{d}V}
     {\int_{\Omega_F} M_s(\mathbf{x})\,\mathrm{d}V}
```

```{math}
:label: eq-table-total-energy
E_{\mathrm{total}}(t_k)=E_{\mathrm{ex}}+E_{\mathrm{demag}}+
E_{\mathrm{ext}}+E_{\mathrm{ani}}+E_{\mathrm{dmi}}+\cdots
```

```{math}
:label: eq-table-max-torque
\tau_{\max}(t_k)=\max_{\mathbf{x}}\lvert\boldsymbol{\tau}(\mathbf{x},t_k)\rvert
```

The quantity catalog defines reduced magnetization. The FDM CPU demag
implementation constructs physical magnetization using the local saturation
magnetization. The weighted reducer retains zero magnetization samples with
positive weight. FDM CPU assembles the total from its enabled energy terms
and evaluates the torque proxy over free spins when frozen spins are present.
The source map records the scope of each observation.

Time-evolution sampling is triggered by simulation time:

```{math}
:label: eq-table-time-cadence
t + \epsilon \ge t_{\mathrm{next}}
```

(table-time-origin-contract)=

When adaptive stepping crosses several requested sample times in one solver
step, the first implementation records the current solver state once and marks
the sample policy as coalesced. It does not invent interpolated physics values.
The contract requires a scalar sample due at a Run stage origin (`t=0`) to use
the actual initialized solver state before integration, with the row remaining
at the origin instead of shifting to the first accepted step. The initial
scalar event consumes the due schedule, so the first accepted row does not
duplicate that sample. A native FEM LLG stage starting at physical time zero
enqueues its initialized scalar state into the physical-time StageAutosave
table before integration. This requires an initial native snapshot even for a
table-only stage. The table event has its own artifact job, so legacy scalar
traces continue to count accepted integration steps. Direct minimizers retain
their accepted-step sampling contract. The origin event described here applies
to a fresh stage at physical time zero. Native CPU/GPU output qualification
for this emission path is pending.

Relaxation uses an explicit accepted-step cadence:

```{math}
:label: eq-table-accepted-step-cadence
k = 0 \quad\lor\quad k \bmod n = 0 \quad\lor\quad k = k_{\mathrm{final}}
```

`every_steps` counts accepted solver states only. Rejected line-search,
trust-region, or adaptive-controller candidates are diagnostics, not table
rows. A relaxation table always includes the initial and final state; a final
state already on cadence is not duplicated.

(symbols-and-si-units)=

### 2.2 Symbols and SI Units

| Exact token | Meaning | SI unit |
|---|---|---|
| $\mathbf{m}$ | normalized magnetization | $1$ |
| $\mathbf{M}$ | magnetization | $\mathrm{A\,m^{-1}}$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $m_i$ | normalized magnetization component | $1$ |
| $i$ | Cartesian component index | $1$ |
| $\langle m_i\rangle$ | magnetic-moment average component | $1$ |
| $t_k$ | accepted sample time | $\mathrm{s}$ |
| $\Omega_F$ | active ferromagnetic domain | $\mathrm{m^3}$ |
| $\mathbf{x}$ | spatial position | $\mathrm{m}$ |
| $\mathrm{d}V$ | volume measure | $\mathrm{m^3}$ |
| $E_{\mathrm{total}}$ | total magnetic energy | $\mathrm{J}$ |
| $E_{\mathrm{ex}}$ | exchange energy | $\mathrm{J}$ |
| $E_{\mathrm{demag}}$ | demagnetizing energy | $\mathrm{J}$ |
| $E_{\mathrm{ext}}$ | external-field energy | $\mathrm{J}$ |
| $E_{\mathrm{ani}}$ | anisotropy energy | $\mathrm{J}$ |
| $E_{\mathrm{dmi}}$ | DMI energy | $\mathrm{J}$ |
| $\tau_{\max}$ | maximum torque proxy magnitude | $\mathrm{A\,m^{-1}}$ |
| $\boldsymbol{\tau}$ | torque proxy | $\mathrm{A\,m^{-1}}$ |

| Symbol or column | Meaning | SI unit |
|---|---|---|
| `step` | solver step index | `1` |
| `t` | physical simulation time, only for time evolution | `s` |
| `pseudo_time_s` | algorithmic relaxation clock (telemetry) | `s` |
| `dt` | solver timestep | `s` |
| `mx`, `my`, `mz` | global magnetic-moment averaged normalized magnetization components over all active ferromagnets; zero-valued active samples remain in the denominator | `1` |
| `e_total` | total magnetic energy | `J` |
| `e_ex`, `e_demag`, `e_ext`, `e_ani`, `e_dmi` | energy contributions | `J` |
| `max_torque` | canonical max torque display alias | `A/m` |
| `max_torque_T` | max torque in tesla-equivalent display units | `T` |
| `max_dm_dt` | maximum magnetization-rate norm | `1/s` |
| `max_h_eff`, `max_h_demag` | maximum field magnitudes | `A/m` |
| $\epsilon$ | cadence comparison tolerance, equal to `1e-9` times the sample period | `s` |
| $t_{\mathrm{next}}$ | next requested physical-time sample | `s` |
| $k$ | accepted solver-step index | `1` |
| $n$ | accepted-step cadence `every_steps` | `1` |
| $k_{\mathrm{final}}$ | terminal accepted solver-step index | `1` |

The accepted table cadence for relaxation is `every_steps`. The Python
quantity list and runtime column catalog expose `pseudo_time_s` only as
relaxation telemetry outside the table.

`time` and `solver_dt` remain accepted compatibility aliases for `t` and `dt`.
Public authoring and UI labels use `t` and `dt`.

(assumptions-and-validity)=

### 2.3 Assumptions and Approximations

- Table autosave samples reduced observables at solver states only.
- The global magnetization domain is the union of active ferromagnetic material;
  airbox and inactive samples are excluded. The denominator is the magnetic
  moment measure `M_s dV`, or the backend-equivalent lumped FEM measure.
- An active sample with `m=(0,0,0)` is still part of the domain and contributes
  its positive measure to the denominator. It is not treated as missing data.
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

(discrete-realization)=

## 3. Numerical Interpretation

### 3.1 FDM

FDM backends already compute scalar reductions for solver status and energy
history. Table autosave reuses the same reduced quantities and stores selected
columns in append-only row order. The CPU reference path remains the oracle for
energy and magnetization reductions. For every accepted state, including direct
minimizer (`projected_gradient_bb` and `nonlinear_cg`) states, `mx/my/mz` are
populated from the current magnetization before the row is stored; they must
never be copied from an uninitialized step-stat snapshot.
FDM uses the cell measure multiplied by `M_s`; the same reducer is used for
the global step statistics and the table row.

### 3.2 FEM

FEM backends expose the same public column identifiers. Backend-specific
integration and weighting stay below the scalar observable boundary. The
reduction is the magnetic-region volume/moment average (lumped FEM measure,
including $M_s$ where it varies), not a node-count average. Object-scoped
columns use the same formula restricted to the object's owned magnetic
elements; object scope is never substituted for the global default. The table
contract does not expose MFEM, hypre, libCEED, mesh-part, or device-residency
details.

### 3.3 Hybrid

Hybrid execution must publish one resolved table schema per output table. If a
future hybrid run combines backend families, provenance records the resolved
source of each column.

## 4. API, IR, and Planner Impact

(python-api)=

### 4.1 Python API Surface

The public DSL adds:

```python
# %% Create a study and a magnetic sample
import fullmag as fm

study = fm.study("stage-autosave-example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

film = study.geometry(fm.Box(size=(100e-9, 50e-9, 5e-9), name="film"))
film.Ms = 8.0e5
film.Aex = 1.3e-11
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))

# %% Save time samples during Run
study.stages.add_run(until=5e-12, stage_id="run").autosave(
    fm.StageAutosave(table=fm.TableAutosave(t_sampl=1e-12))
)

# %% Save accepted states during relaxation
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

`study.tableautosave(enabled=False)` (or `fm.tableautosave(enabled=False)`)
clears the persistent table for subsequent declarations without inserting an
authored stage. Disabling cannot be combined with a cadence, quantities or a
custom table ID. Canonical SceneDocument export preserves each Run's table
cadence, columns, expressions and ID, including a missing/null table after an
enabled one. This changes neither field output nor the numerical trajectory.
The IR and OpenAPI representations remain unchanged: no table is represented
by the absence of `sampling.table_autosave`.

Persistent `study.stages.tableautosave(...)` actions remain readable for
compatibility. New relaxation scripts attach accepted-step sampling directly
to the owning relaxation stage so the cadence cannot leak into later stages.

`FieldAutosave` requires exactly one cadence: `every` for physical-time Run
stages or `every_steps` for accepted-step Relax stages. `StageAutosave`
defaults to `target="main"`, `layout="continuous"`, and `format="zarr"`.
At least one table or field policy is required.

(problem-ir)=

### 4.2 ProblemIR Representation

`SamplingIR` exposes an optional stage autosave policy containing `target`,
`layout = continuous | separate`, `format = zarr | hdf5 | txt`, an optional
table policy, and zero or more field policies. The nested table policy keeps:

- exactly one cadence: `sample_period_s` / `sample_period_policy` or
  `every_steps`
- `quantities`
- `expressions`: explicit object/quantity additions such as `disk.m`; a vector
  expands to `disk.mx`, `disk.my`, and `disk.mz`
- `table_id`

The IR field uses SI-clean names and public quantity identifiers. UI-authored
and Python-authored studies must lower to the same IR.

The autosave constructor parameters lower as follows.

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `TableAutosave.t_sampl` | `float or 'auto' or None` | `None` | $\mathrm{s}$ | exactly one cadence; finite positive number or auto | physical-time period | shared authoring; runtime unqualified | `sampling.table_autosave.sample_period_s or sampling.table_autosave.sample_period_policy` |
| `TableAutosave.every_steps` | `int or None` | `None` | $1$ | exactly one cadence; positive integer, not bool | accepted-step period | shared authoring; runtime unqualified | `sampling.table_autosave.every_steps` |
| `TableAutosave.quantities` | `Sequence[str] or None` | `None` | $1$ | nonempty supported ids; aliases normalized; duplicates removed | base column order; None selects default columns | shared authoring; runtime unqualified | `sampling.table_autosave.quantities` |
| `TableAutosave.extra_quantities` | `Sequence[str]` | `()` | $1$ | supported ids; appended and deduplicated | extra columns | shared authoring; runtime unqualified | `sampling.table_autosave.quantities` |
| `TableAutosave.expressions` | `Sequence[str]` | `()` | $1$ | nonempty text without whitespace; runtime checks object.m syntax | explicit object columns | shared authoring; runtime unqualified | `sampling.table_autosave.expressions` |
| `TableAutosave.table_id` | `str` | `'default'` | $1$ | stripped nonempty text | table identity | shared authoring; runtime unqualified | `sampling.table_autosave.table_id` |
| `FieldAutosave.quantity` | `str` | `required` | $1$ | nonempty SaveField-supported id | field identity; values keep quantity SI unit | shared authoring; runtime unqualified | `sampling.stage_autosave.fields[].quantity` |
| `FieldAutosave.every` | `float or 'auto' or None` | `None` | $\mathrm{s}$ | exactly one cadence; finite positive number or auto | physical-time field period | shared authoring; runtime unqualified | `sampling.stage_autosave.fields[].every_seconds or sampling.stage_autosave.fields[].sample_period_policy` |
| `FieldAutosave.every_steps` | `int or None` | `None` | $1$ | exactly one cadence; positive integer, not bool | accepted-step field period | shared authoring; runtime unqualified | `sampling.stage_autosave.fields[].every_steps` |
| `StageAutosave.target` | `str` | `'main'` | $1$ | alphanumeric first character; then letters, digits, dot, underscore, or hyphen | output target | shared authoring; runtime unqualified | `sampling.stage_autosave.target` |
| `StageAutosave.layout` | `str` | `'continuous'` | $1$ | continuous or separate | stage layout | shared authoring; runtime unqualified | `sampling.stage_autosave.layout` |
| `StageAutosave.format` | `str` | `'zarr'` | $1$ | zarr, hdf5, or txt; txt rejects fields | storage format | shared authoring; runtime unqualified | `sampling.stage_autosave.format` |
| `StageAutosave.table` | `TableAutosave or None` | `None` | $1$ | correct object type; table or fields required | table policy | shared authoring; runtime unqualified | `sampling.stage_autosave.table` |
| `StageAutosave.fields` | `Sequence[FieldAutosave]` | `()` | $1$ | correct object types; unique quantities; table or fields required | field policies | shared authoring; runtime unqualified | `sampling.stage_autosave.fields` |

`StageAutosave.table` uses the same table keys under `sampling.stage_autosave.table`.

(round-trip-and-failure-semantics)=

### 4.3 Planner and Capability-Matrix Impact

Planners validate that time cadence is used for physical time evolution and
that accepted-step cadence is used for relaxation. Each requested quantity
must be supported by the resolved backend. Unsupported columns fail clearly;
they are not silently omitted.

Stages joining one continuous target must agree on format and compatible table
and field schemas. Mesh identity, value type, component count, quantity
identity, and chunking must remain compatible. Strict execution rejects a
conflict before opening the target and never silently forks it.
Unsupported combinations fail closed. Requested columns are never silently
omitted.

Canonical export preserves requested intent and resolved execution separately.
Validation errors reject invalid cadence or unavailable quantities.

### 4.4 Storage formats and stage layout

| Format | Scalar tables | Spatial fields | Default |
|---|---:|---:|---:|
| Zarr | yes | yes | yes |
| HDF5 | yes | yes | no |
| TXT | yes | no | no |

TXT field autosave is invalid at every public boundary. The error must retain
the user's field configuration for correction; UI authoring must not silently
delete it.

Zarr writes the numerical payloads under these stage-owned paths:

```text
<target>.zarr/stages/stage_<index:04>_<stage-id>/table
<target>.zarr/stages/stage_<index:04>_<stage-id>/fields/<quantity>
```

The table is a single two-dimensional array with columns ordered by
`table/.zattrs.quantities`. The stage writer creates uncompressed Zarr v2
arrays of shape `[sample, width]` with dtype `<f8`. HDF5 writes a stage
`table` matrix and the column order in `table_quantities_json` when table
rows exist.

Zarr continuous layout appends references in `continuous/index.jsonl`.
HDF5 stores one `continuous/stage_<index:04>_index_json` dataset per stage.
Separate layout creates stage-specific targets. Both continuous indexes
reference stage-owned payloads and carry `target_sample_index`, `stage_id`,
`stage_index`, `stage_sample_index`, `sample_kind`, `coordinate`, and
`payload_ref`. For field entries, `stage_sample_index` is the ordinal across
the stage's field samples and `payload_ref` identifies the array row for its
quantity. The coordinate records physical `time_s` for Run or
`accepted_step` for Relax.

(implementation-mapping)=

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

The default table columns and live telemetry use the global `mx`, `my`, and
`mz` values. An added expression is explicit object scope and is labelled with
its object id and `weighting=Ms_times_measure`; no UI fallback may replace a
global sample with a selected-object sample.

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
completed samples. A writer-close marker alone does not establish solver
success; an error before the solver returns an authoritative completion record
must not be relabelled as convergence or assigned a fabricated stop reason.

### Wynik etapu w samowystarczalnym Zarr

Flaga manifestu `complete` opisuje zakończenie zapisu próbek. Nie zastępuje
wyniku solvera i nie potwierdza konwergencji. Opcjonalny `completion` zachowuje
autorytatywny `StageCompletionIR`: `status`, `converged`, `reason` oraz metrykę
z wartością i progiem, jeśli solver je podał. `None` oznacza brak takiego
potwierdzenia; limit kroków nie staje się zbieżnością przez zamknięcie writera.
Dotyczy to wspólnego toru artefaktów FDM CPU, FDM GPU, FEM CPU i FEM GPU,
bez zmiany kryteriów zatrzymania poszczególnych solverów.

Po opróżnieniu kolejki finalizacja wiąże wynik i końcową provenance z dokładną
instancją etapu zwróconą przez writer: `target`, `stage_id`, `stage_index`.
Manifest tego etapu i odpowiadający wpis `<target>.autosave.json` muszą
zachować ten sam wynik i resolution wykonania. Ponowne użycie `stage_id`
nie uprawnia do zmiany wcześniejszej instancji. Wspólny root wieloetapowego
Zarr nie otrzymuje płaskiego `completion` bieżącego etapu. Zwykłe strumieniowe
field-Zarr otrzymują wynik tylko pod dokładnymi ścieżkami otwartymi przez
bieżący writer; ich istniejący kontrakt identyfikuje etap przez `stage_id`,
bez wymyślonego indeksu etapu.

Finalizacja zmienia metadane po drain. Nie dopisuje odczytów pól GPU,
nie zmienia chunków, kształtu tablic, indeksów próbek ani backpressure.
Kontrole regresyjne muszą obejmować wspólny i osobny katalog autosave,
różne resolution kolejnych etapów, powtórzony identyfikator, torque,
limit kroków i brak completion. Dowody źródłowe i testy writera nie zastępują
kwalifikacji pełnego biegu na urządzeniu.

(validation)=

## 6. Validation Strategy

### 6.1 Analytical Checks

- Constant magnetization keeps `mx`, `my`, `mz` constant across table rows.
- Fixed-step runs sample exactly at the requested cadence.
- Adaptive-step overshoot emits coalesced samples without interpolation.
- Relaxation with `every_steps=10` emits `0, 10, 20, ...` accepted states and
  one final state; rejected candidates do not alter that sequence.
- A nonuniform accepted state publishes `mx/my/mz` equal to the spatial
  component averages in both the global row and the per-object row.
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
- Direct-minimizer scalar-row regression with nonuniform magnetization,
  including the per-object scalar map.
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

(limitations)=

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

(scientific-bibliography)=

## 9. References

- `external_solvers/amumax/src/engine/zarr_table.go`
- `external_solvers/amumax/frontend/src/lib/table-plot/table-plot.ts`
- Apache ECharts dynamic data guide
- Apache ECharts dataset guide

(source-code-index)=

## 10. Source Code Index

| Repository path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyBuilder` | Configure and explicitly clear the table for subsequent declarations without an authored stage. |
| `packages/fullmag-py/src/fullmag/runtime/script_builder.py` | `_render_scene_sampling_outputs` | Preserve per-Run table sampling and missing/null table state during canonical capture. |
| `packages/fullmag-py/src/fullmag/model/study.py` | `class TableAutosave` | Validate public cadence and lower it into table-autosave IR. |
| `packages/fullmag-py/tests/test_table_autosave.py` | `test_time_evolution_table_autosave_lowers_default_columns_to_sampling_ir` | Verify physical-time table cadence lowers to `SamplingIR`. |
| `packages/fullmag-py/tests/test_table_autosave.py` | `test_relaxation_table_autosave_lowers_accepted_step_cadence` | Verify accepted-step cadence lowers to `SamplingIR`. |
| `crates/fullmag-ir/src/study.rs` | `TableAutosaveIR` | Store the canonical cadence and selected table quantities. |
| `crates/fullmag-runner/src/scalar_metrics.rs` | `moment_weighted_average_magnetization` | Compute the magnetic-moment-weighted global magnetization components. |
| `crates/fullmag-runner/src/table_autosave.rs` | `append_if_due` | Apply physical-time or accepted-step cadence to solver-state samples. |
| `crates/fullmag-runner/src/table_autosave.rs` | `append_final_if_needed` | Append the terminal accepted relaxation state once. |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `append_scalar` | Append StageAutosave rows when the artifact pipeline receives scalar stats. |
| `crates/fullmag-runner/src/table_autosave.rs` | `table_store_persists_averaged_components_from_accepted_direct_step` | Verify scalar magnetization values are taken from the accepted state. |
| `crates/fullmag-runner/src/table_autosave.rs` | `table_store_appends_on_simulation_time_cadence` | Verify initial sampling and coalesced physical-time cadence. |
| `crates/fullmag-runner/src/table_autosave.rs` | `table_store_appends_initial_periodic_and_final_accepted_steps` | Verify accepted-step initial, periodic, and terminal rows. |
| `crates/fullmag-runner/src/dispatch.rs` | `native_fem_requires_initial_snapshot` | Request initialized native FEM stats for live, minimizer, field, and physical-time table consumers. |
| `crates/fullmag-runner/src/dispatch.rs` | `native_fem_should_initialize_stage_autosave_table` | Admit the scalar origin event for a fresh physical-time FEM LLG stage. |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `record_stage_autosave_scalar` | Enqueue initialized scalar stats for the StageAutosave table. |
| `crates/fullmag-runner/src/artifact_pipeline.rs` | `initial_stage_autosave_table_scalar_does_not_write_legacy_scalar_trace` | Verify the table origin event through the artifact writer. |
| `crates/fullmag-runner/src/dispatch.rs` | `record_native_fem_initial_field_snapshots` | Capture scheduled initial field data without emitting a table scalar row. |
| `crates/fullmag-runner/src/dispatch.rs` | `native_fem_initial_snapshot_is_lazy_for_headless_time_domain` | Verify current native FEM initial-output admission behavior. |
| `docs/physics/0910-table-autosave-observables.md` | `DOC-ANCHOR:table-time-origin-contract` | Physical-time origin sampling and current native FEM qualification scope. |
| `crates/fullmag-ir/src/study.rs` | `StageCompletionIR` | Autorytatywny wynik solvera i opcjonalna metryka zatrzymania. |
| `crates/fullmag-runner/src/autosave_storage.rs` | `StageManifest` | Oddzielny marker zamknięcia writera i opcjonalny wynik etapu. |
| `crates/fullmag-runner/src/autosave_storage.rs` | `StageManifestIdentity` | Dokładna instancja etapu zapisana przez writer. |
| `crates/fullmag-runner/src/artifacts.rs` | `finalize_streamed_stage_artifacts` | Finalizacja po drain wyłącznie dla artefaktów wskazanych przez writer. |
| `crates/fullmag-runner/src/autosave_storage.rs` | `finalize_stage_completion` | Zgodny wynik i provenance właściwego manifestu, wpisu aggregate i metadanych próbek. |
| `crates/fullmag-runner/src/autosave_zarr.rs` | `write_bytes_atomic` | Wspólny atomowy zapis metadanych i dokładne bajty rollbacku, z adapterem Windows. |
| `crates/fullmag-quantities/src/catalog.rs` | `CATALOG` | Declare QuantityId::M as the reduced dimensionless magnetization vector with unit-vector normalization. |
| `crates/fullmag-engine/src/fdm/cpu/fields/demag.rs` | `demag_field_from_vectors_ws_with_output_mask` | Supply active demag sources as scale(magnetization[source], self.ms_at(source)), which implements physical M = Ms times reduced m. |
| `crates/fullmag-engine/src/fdm/shared/problem.rs` | `ms_at` | Select cell saturation magnetization from ms_field or the material saturation_magnetisation fallback. |
| `packages/fullmag-py/src/fullmag/model/study.py` | `class FieldAutosave` | Validate a SaveField quantity and exactly one cadence; lower to field policy IR. |
| `packages/fullmag-py/src/fullmag/model/study.py` | `class StageAutosave` | Validate target, layout, format, nested object types and unique fields; reject empty policy and TXT fields. |
| `packages/fullmag-py/src/fullmag/_validation.py` | `normalize_sampling_period` | Accept auto or a finite positive numeric period; reject booleans and invalid values. |
| `packages/fullmag-py/src/fullmag/_validation.py` | `auto_sinc_sampling_policy_ir` | Serialize auto_sinc_cutoff with the current Nyquist guard factor 1.3. |
| `packages/fullmag-py/src/fullmag/model/study.py` | `_require_supported_table_quantity` | Strip quantity text, normalize aliases, and reject unsupported table ids. |
| `packages/fullmag-py/src/fullmag/model/study.py` | `_normalize_table_expression` | Accept nonempty expression text without whitespace or a handle with table_expression; runtime applies the narrower object.m grammar. |
| `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveField` | Reject a quantity outside the current known field ids. |
| `crates/fullmag-ir/src/study.rs` | `SamplingIR` | Own optional table_autosave and stage_autosave beside outputs. |
| `crates/fullmag-ir/src/study.rs` | `StageAutosaveIR` | Represent nested autosave policies; validate_for_study rejects stage cadence mismatch and TXT fields. |
| `crates/fullmag-runner/src/table_autosave.rs` | `from_ir` | Construct table columns and cadence; reject unresolved automatic sampling or unsupported quantities. |
| `crates/fullmag-runner/src/table_autosave.rs` | `table_column_meta` | Define current scalar ids, aliases, units and reductions; pseudo_time_s is not an accepted table column here. |
| `crates/fullmag-runner/src/table_autosave.rs` | `table_column_value` | Forward selected StepStats components, energy and torque without recomputing physics. |
| `crates/fullmag-runner/src/table_autosave.rs` | `table_expression_columns` | Expand object.m or object.m.x/y/z to explicit scoped columns labelled Ms_times_measure. |
| `crates/fullmag-runner/src/scalar_metrics.rs` | `weighted_average_magnetization_components` | Compute the finite positive-weight mean; retain zero magnetization in the denominator and return zero for no positive measure. |
| `crates/fullmag-engine/src/fdm/cpu/fields/observables.rs` | `observe_vectors_ws_at_time` | Assemble the FDM CPU energy sum and torque residual maxima, with free-spin treatment for frozen spins. |
| `crates/fullmag-runner/src/autosave_zarr.rs` | `begin_stage` | Create stage-owned table matrix and fields with quantities metadata; continuous is references only. |
| `crates/fullmag-runner/src/autosave_zarr.rs` | `initialize_array` | Write current Zarr v2 sample-by-width float64 metadata without compression. |
| `crates/fullmag-runner/src/autosave_zarr.rs` | `append_continuous_index` | Append continuous/index.jsonl only for continuous layout. |
| `crates/fullmag-runner/src/autosave_hdf5.rs` | `finish_stage` | Write buffered stage table and field matrices, table_quantities_json and optional continuous index. |
| `crates/fullmag-runner/src/autosave_storage.rs` | `ContinuousIndexEntry` | Declare sample and stage indexes, kind, coordinate and payload reference; no stage_kind or stage_step fields. |
| `crates/fullmag-runner/src/autosave_storage.rs` | `StageSampleCoordinate` | Distinguish physical time from accepted-step coordinates. |
| `crates/fullmag-runner/src/scalar_metrics.rs` | `weighted_average_magnetization_uses_fem_volume_weights` | Assert the weighted reducer on a nonuniform synthetic measure, not FEM execution. |
| `crates/fullmag-runner/src/scalar_metrics.rs` | `weighted_average_magnetization_keeps_zero_magnetization_with_positive_weight` | Assert positive-weight zero vectors remain in the reducer denominator. |
