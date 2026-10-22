# Table Autosave Observables

- Status: canonical
- Owners: Fullmag core
- Last updated: 2026-07-31
- Related ADRs: `docs/adr/0011-resource-first-api.md`, `docs/adr/0013-frontend-v2-module-kernel.md`
- Related specs: `docs/specs/resource-first-control-room-api-v2.md`, `docs/specs/frontend-v2/16-charts-analysis-module.md`

(problem-statement)=
## 1. Problem Statement

Source-map review: `ee8456befc2a4cf6276376190ac9280ef223b0d3`.
The adjacent source map records source inspection only. All four runtime lanes
remain **NOT VERIFIED** by this Phase 0 documentation task. Sections below
state the intended observable contract unless they explicitly identify current
source behavior. Validation lists are required checks, not execution evidence.

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

These equations define the observable meaning, not a new solver. The catalog
`CATALOG` declares reduced dimensionless magnetization
(`crates/fullmag-quantities/src/catalog.rs:30-45`). The FDM CPU demag source
constructs physical $\mathbf{M}=M_s\mathbf{m}$ with
`scale(magnetization[source], self.ms_at(source))`
(`crates/fullmag-engine/src/fdm/cpu/fields/demag.rs:37-49`,
`demag_field_from_vectors_ws_with_output_mask`). `ms_at` selects cell or
material saturation magnetization
(`crates/fullmag-engine/src/fdm/shared/problem.rs:804-809`). This establishes
the reduced/physical convention in source, not runtime qualification.
The source map links the moment average to the weighted reducer, and energy
and torque to the FDM CPU observable assembly
(`crates/fullmag-engine/src/fdm/cpu/fields/observables.rs:105-123`,
`observe_vectors_ws_at_time`). That assembly includes further enabled
energy terms (the ellipsis) and uses the free-spin torque maximum when spins
are frozen. The torque proxy is not the full LLG right-hand side. This is not
proof that all lanes implement the same reduction or torque convention.

Time-evolution sampling is triggered by simulation time:

```{math}
:label: eq-table-time-cadence
t_{\mathrm{current}}+\epsilon\ge t_{\mathrm{next}}
```

When adaptive stepping crosses several requested sample times in one solver
step, the first implementation records the current solver state once and marks
the sample policy as coalesced. It does not invent interpolated physics values.

Relaxation uses an explicit accepted-step cadence:

```{math}
:label: eq-table-step-cadence
s=0\quad\lor\quad s\bmod n=0\quad\lor\quad s=s_{\mathrm{final}}
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
| $t_{\mathrm{current}}$ | current solver time | $\mathrm{s}$ |
| $\epsilon$ | sampling comparison tolerance | $\mathrm{s}$ |
| $t_{\mathrm{next}}$ | next requested sample time | $\mathrm{s}$ |
| $s$ | accepted step index | $1$ |
| $n$ | accepted steps per sample | $1$ |
| $s_{\mathrm{final}}$ | final accepted step index | $1$ |

In `TableStore::append_if_due`, $\epsilon$ is the sample period times
$10^{-9}$ (`crates/fullmag-runner/src/table_autosave.rs:166-188`). The weighted
reducer excludes non-finite vectors and non-positive or non-finite weights;
it returns zero when no positive measure remains
(`crates/fullmag-runner/src/scalar_metrics.rs:37-67`,
`weighted_average_magnetization_components`).
Neither behavior qualifies a backend runtime.

| Symbol or column | Meaning | SI unit |
|---|---|---|
| `step` | solver step index | $1$ |
| `t` | physical simulation time, only for time evolution | $\mathrm{s}$ |
| `pseudo_time_s` | algorithmic relaxation clock, never physical time | $\mathrm{s}$ |
| `dt` | solver timestep | $\mathrm{s}$ |
| `mx`, `my`, `mz` | global magnetic-moment averaged normalized magnetization components over all active ferromagnets; zero-valued active samples remain in the denominator | $1$ |
| `e_total` | total magnetic energy | $\mathrm{J}$ |
| `e_ex`, `e_demag`, `e_ext`, `e_ani`, `e_dmi` | energy contributions | $\mathrm{J}$ |
| `max_torque` | canonical max torque display alias | $\mathrm{A\,m^{-1}}$ |
| `max_torque_T` | max torque in tesla-equivalent display units | $\mathrm{T}$ |
| `max_dm_dt` | maximum magnetization-rate norm | $\mathrm{s^{-1}}$ |
| `max_h_eff`, `max_h_demag` | maximum field magnitudes | $\mathrm{A\,m^{-1}}$ |

`pseudo_time_s` names relaxation telemetry, not a currently accepted
`TableAutosave` column: neither the Python supported-quantity set nor
`table_column_meta` accepts it at the inspected revision
(`packages/fullmag-py/src/fullmag/model/study.py:296-321`,
`SUPPORTED_TABLE_AUTOSAVE_QUANTITIES`;
`crates/fullmag-runner/src/table_autosave.rs:277-395`, `table_column_meta`).

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

| Solver | Device | Source-review status | Runtime qualification in this task |
|---|---|---|---|
| FDM | CPU | Shared table schema; CPU observable assembly inspected | NOT VERIFIED |
| FDM | GPU | Shared table contract; quantity support remains lane-dependent | NOT VERIFIED |
| FEM | CPU | Shared table contract; lumped moment measure is required | NOT VERIFIED |
| FEM | GPU | Shared table contract; device reduction needs runtime evidence | NOT VERIFIED |

This matrix documents the contract, not blanket quantity support or parity.
See [output capabilities](../specs/capability-matrix-v0.md) for source-based
quantity restrictions. Hybrid execution remains a future contract.

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

The following fragment shows the existing public DSL. It needs an already
configured `study`; it is not a standalone simulation or executed evidence.
For the complete stage-first setup, see
`tests/standard_problems/mumag/sp4/fem/scenarios/relax_projected_gradient_bb.py`.

```python
# %% Table and stage policy fragments
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

(round-trip-and-failure-semantics)=
### 4.3 Planner and Capability-Matrix Impact

Requested intent stays in the authored cadence and target policy.
Resolved execution selects a backend and resolves automatic sampling before constructing
`TableAutosaveConfig`; unresolved automatic sampling returns an error. Writer
manifests carry optional provenance, not a runtime qualification certificate.
Python aliases normalize before serialization; explicit defaults and deduplicated
quantity order survive `to_ir()`. Validation errors include conflicting cadences,
non-positive step counts, empty quantities, duplicate field quantities, and TXT
fields. Unsupported combinations must fail; acceptance by a Python constructor
alone does not establish planner or runtime support. The serialized fragments
below describe autosave objects only, not a complete `ProblemIR` snapshot.

The parameter reference covers autosave constructors, not the separate study,
geometry, or stage-builder API. All listed backend support means shared
authoring only; quantity and writer support still require backend validation.

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

Nested `StageAutosave.table` uses the same table keys under
`sampling.stage_autosave.table`, instead of `sampling.table_autosave`.
`'auto'` lowers to `{"kind": "auto_sinc_cutoff", "nyquist_guard_factor": 1.3}`;
it is not an explicit period. A minimal object-only lowering example is:

```python
# %% Inspect a policy without running a solver
import fullmag as fm

policy = fm.TableAutosave(every_steps=10, quantities=["step", "mx"])
assert policy.to_ir() == {
    "kind": "table_autosave",
    "table_id": "default",
    "quantities": ["step", "mx"],
    "every_steps": 10,
}
```

The object-only block was executed with
`PYTHONPATH=packages/fullmag-py/src /home/kelv/working_env/bin/python -B -`;
the `TableAutosave.to_ir()` assertion passed. Both Python blocks parsed as
Python. The first remains an unexecuted configured-study fragment, not a
standalone example. This checks policy lowering only, not a complete
`ProblemIR` snapshot or solver execution.

Planners validate that time cadence is used for physical time evolution and
that accepted-step cadence is used for relaxation. Each requested quantity
must be supported by the resolved backend. Unsupported columns fail clearly;
they are not silently omitted.

Stages joining one continuous target must agree on format and compatible table
and field schemas. Mesh identity, value type, component count, quantity
identity, and chunking must remain compatible. Strict execution rejects a
conflict before opening the target and never silently forks it.

(implementation-mapping)=
### 4.4 Storage formats and stage layout

| Format | Scalar tables | Spatial fields | Default |
|---|---:|---:|---:|
| Zarr | yes | yes | yes |
| HDF5 | yes | yes | no |
| TXT | yes | no | no |

TXT field autosave is invalid at every public boundary. The error must retain
the user's field configuration for correction; UI authoring must not silently
delete it.

**Current implementation at base `9902410b016dbe934669122ef00a7825bbd2d5b0`
(source inspection, not runtime qualification):** Zarr uses one 2-D table
array per stage, not one array per quantity:

```text
<target>.zarr/stages/stage_<index:04>_<stage-id>/table
<target>.zarr/stages/stage_<index:04>_<stage-id>/fields/<quantity>
```

`ZarrAutosaveWriter::begin_stage` writes the table column order to
`table/.zattrs.quantities` (`crates/fullmag-runner/src/autosave_zarr.rs:81-135`).
`initialize_array` writes `[sample, width]` arrays with `<f8` values and no
compression (`crates/fullmag-runner/src/autosave_zarr.rs:222-240`). HDF5 also
uses one `table` matrix per stage, with `table_quantities_json` for column
order, and separate field matrices (`Hdf5AutosaveWriter::finish_stage`,
`crates/fullmag-runner/src/autosave_hdf5.rs:89-131`).

For Zarr `layout="continuous"`, `append_continuous_index` appends references
to stage-owned payloads in `continuous/index.jsonl`; it writes no index for
`layout="separate"` (`crates/fullmag-runner/src/autosave_zarr.rs:319-337`).
The current index fields are `target_sample_index`, `stage_id`, `stage_index`,
`stage_sample_index`, `sample_kind`, `coordinate`, and `payload_ref`
(`ContinuousIndexEntry`, `crates/fullmag-runner/src/autosave_storage.rs:82-91`).
`StageSampleCoordinate` distinguishes `PhysicalTime { time_s }` from
`AcceptedStep { accepted_step }`
(`crates/fullmag-runner/src/autosave_storage.rs:6-11`). This index does not
contain the previously proposed `stage_kind` or `stage_step` fields.
Relaxation pseudotime must never be merged with physical Run time.

**Future v1 contract:** [Canonical Zarr output store](../specs/output-store-zarr-v1.md)
supersedes this Zarr storage layout for time-domain fields and tables after
implementation and reader migration. It specifies one root field array per
quantity and a `table/` group with one array per column. It is not implemented
at the cited base. This supersession does not change the observable equations,
SI units, accepted-state sampling semantics, or the separate HDF5 contract.

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
completed samples and record an incomplete marker and stop reason.

(validation)=
## 6. Validation Strategy

The following checks are requirements. The source index identifies selected
existing regression definitions; none was compiled or run in this task.

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

- The v1 Zarr layout remains planned. The adjacent map does not assert its implementation.
- Python lowering, backend numerical agreement, GPU/device behavior, browser
  transport, and rendered MathJax remain unqualified by this source-only review.

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

- A. Vansteenkiste et al., *The design and verification of MuMax3*, AIP Advances
  4, 107133 (2014), https://doi.org/10.1063/1.4899186. This is background on
  micromagnetic observables, not Fullmag implementation evidence.

- `external_solvers/amumax/src/engine/zarr_table.go`
- `external_solvers/amumax/frontend/src/lib/table-plot/table-plot.ts`
- Apache ECharts dynamic data guide
- Apache ECharts dataset guide

(source-code-index)=
## 10. Source-Code Index

Every code entry below was inspected at
`ee8456befc2a4cf6276376190ac9280ef223b0d3`. Resolve its immutable local source
with `git show ee8456befc2a4cf6276376190ac9280ef223b0d3:<path>` and locate
the listed declaration. All source-map entries identify code or test
sources at that revision; none uses a document-only evidence anchor.
Publication links and rendered-page proof are outside this Phase 0 task.

`source` means inspected source only; `test source` means an inspected,
unexecuted regression definition. The equation mappings, parameter mappings,
and four-lane qualification limits are also in the adjacent handwritten map.

| Claim / equation | Path | Symbol | Responsibility / lane | Evidence |
|---|---|---|---|---|
| Reduced magnetization convention | `crates/fullmag-quantities/src/catalog.rs:30` | `CATALOG` | reduced dimensionless magnetization metadata | source |
| Physical magnetization convention | `crates/fullmag-engine/src/fdm/cpu/fields/demag.rs:37` | `demag_field_from_vectors_ws_with_output_mask` | FDM CPU demag sources use physical M = Ms times m | source |
| Saturation magnetization selection | `crates/fullmag-engine/src/fdm/shared/problem.rs:804` | `ms_at` | cell field or material fallback | source |
| Table API and lowering | `packages/fullmag-py/src/fullmag/model/study.py:337` | `class TableAutosave` | shared authoring validation and serialization | source |
| Field API and lowering | `packages/fullmag-py/src/fullmag/model/study.py:410` | `class FieldAutosave` | shared field policy validation and serialization | source |
| Stage API and lowering | `packages/fullmag-py/src/fullmag/model/study.py:453` | `class StageAutosave` | target, format and nested policy validation | source |
| Time-period domain | `packages/fullmag-py/src/fullmag/_validation.py:243` | `normalize_sampling_period` | positive finite period or auto | source |
| Automatic period IR | `packages/fullmag-py/src/fullmag/_validation.py:236` | `auto_sinc_sampling_policy_ir` | automatic cutoff policy with guard factor 1.3 | source |
| Quantity aliases | `packages/fullmag-py/src/fullmag/model/study.py:581` | `_require_supported_table_quantity` | supported scalar ids and alias normalization | source |
| Expression input | `packages/fullmag-py/src/fullmag/model/study.py:589` | `_normalize_table_expression` | nonempty whitespace-free text | source |
| Field quantity domain | `packages/fullmag-py/src/fullmag/model/outputs.py:79` | `class SaveField` | supported field identifiers | source |
| Sampling owner | `crates/fullmag-ir/src/study.rs:999` | `SamplingIR` | shared table and stage policy fields | source |
| Table IR | `crates/fullmag-ir/src/study.rs:1023` | `TableAutosaveIR` | cadence, columns, expressions and table identity | source |
| Stage IR and validation | `crates/fullmag-ir/src/study.rs:1119` | `StageAutosaveIR` | shared nested policy and study-kind validation | source |
| Runtime table config | `crates/fullmag-runner/src/table_autosave.rs:64` | `from_ir` | shared table setup; unresolved auto fails | source |
| Time and step cadence equations | `crates/fullmag-runner/src/table_autosave.rs:166` | `append_if_due` | shared row selection and coalescing | source; cadence test sources below |
| Terminal step equation | `crates/fullmag-runner/src/table_autosave.rs:202` | `append_final_if_needed` | shared final row without duplication | source; step test source below |
| Units and aliases | `crates/fullmag-runner/src/table_autosave.rs:277` | `table_column_meta` | shared current column metadata | source |
| Energy, torque and components | `crates/fullmag-runner/src/table_autosave.rs:447` | `table_column_value` | forward StepStats, no new physics | source |
| Object scope | `crates/fullmag-runner/src/table_autosave.rs:412` | `table_expression_columns` | shared object.m expansion and weighting label | source |
| Moment-average equation | `crates/fullmag-runner/src/scalar_metrics.rs:37` | `weighted_average_magnetization_components` | weighted reducer; caller owns physical measure | source; weighted test sources below |
| Energy and torque equations | `crates/fullmag-engine/src/fdm/cpu/fields/observables.rs:15` | `observe_vectors_ws_at_time` | FDM CPU energy sum and free-spin torque maximum | source; runtime unqualified |
| Current Zarr layout | `crates/fullmag-runner/src/autosave_zarr.rs:80` | `begin_stage` | stage-owned matrix and column metadata | source |
| Current Zarr dtype | `crates/fullmag-runner/src/autosave_zarr.rs:222` | `initialize_array` | sample-by-width float64, no compression | source |
| Current continuous index | `crates/fullmag-runner/src/autosave_zarr.rs:319` | `append_continuous_index` | references for continuous layout only | source |
| Current HDF5 layout | `crates/fullmag-runner/src/autosave_hdf5.rs:89` | `finish_stage` | buffered stage table and field matrices | source; no writer execution |
| Index fields | `crates/fullmag-runner/src/autosave_storage.rs:82` | `ContinuousIndexEntry` | stage/sample ids, coordinate and payload reference | source |
| Coordinate distinction | `crates/fullmag-runner/src/autosave_storage.rs:8` | `StageSampleCoordinate` | physical time or accepted step, never merged clocks | source |
| Time cadence regression | `crates/fullmag-runner/src/table_autosave.rs:631` | `table_store_appends_on_simulation_time_cadence` | synthetic row scheduling and overshoot | test source |
| Step cadence regression | `crates/fullmag-runner/src/table_autosave.rs:670` | `table_store_appends_initial_periodic_and_final_accepted_steps` | rows 0, 10, 20, 23; no final duplicate | test source |
| Weighted reduction regression | `crates/fullmag-runner/src/scalar_metrics.rs:246` | `weighted_average_magnetization_uses_fem_volume_weights` | synthetic nonuniform weights, not FEM runtime | test source |
| Zero-vector reduction regression | `crates/fullmag-runner/src/scalar_metrics.rs:269` | `weighted_average_magnetization_keeps_zero_magnetization_with_positive_weight` | zero vectors retain positive measure | test source |
