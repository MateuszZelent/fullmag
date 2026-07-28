# Stage-local autosave storage and continuous views

**Status:** approved design
**Date:** 2026-07-28

## 1. Goal

Every `Relax` and `Run` stage may own its autosave configuration. The same
contract must be authorable from the Python DSL and the Control Room. Autosave
configuration must not leak into a following stage.

Users choose whether a sequence is presented as one continuous result or as
separate results per stage. Fullmag preserves explicit stage boundaries in
both modes. The default storage format is Zarr.

## 2. User-facing model

Each `Relax` and `Run` stage exposes an `Autosave` section with:

- enabled/disabled state;
- output target name, default `main`;
- layout: `continuous` or `separate`;
- format: `zarr`, `hdf5`, or `txt`, default `zarr`;
- table autosave cadence and selected scalar quantities;
- zero or more field autosave entries, each with a quantity and cadence;
- the resolved output name shown before execution.

Relaxation table and field cadence counts accepted solver steps. Run cadence
uses physical simulation time. Rejected relaxation attempts never produce
autosave samples.

`txt` supports scalar tables only. Selecting field autosave with `txt` is a
validation error in Python, UI authoring, ProblemIR validation, and runtime
planning. Zarr and HDF5 support both tables and full field snapshots.

## 3. Target and layout semantics

A target is a stable user-defined result identity such as `main`, `reversal`,
or `thermal-sweep`. Stages with the same target, format, and `continuous`
layout contribute to one output container.

`continuous` means one output container and one logical sequence. It does not
erase stage boundaries or combine incompatible clocks. Each sample retains:

- `sample_index`, monotonically increasing within the target;
- `stage_index`;
- `stage_id`;
- `stage_kind`;
- `stage_sample_index`;
- `stage_step`;
- `time_kind`, either `physical_time` or `relaxation_step`;
- `time_s` when physical time exists;
- `accepted_step` when relaxation-step time exists.

`separate` means one container or text table per stage. The default resolved
name is `<target>-<stage-index>-<stage-id>.<extension>`. Sanitization and name
collision handling are deterministic and recorded in provenance.

Two stages may join a continuous target only when format, table schema, field
quantity identity, value type, mesh identity, component count, and chunking
are compatible. Incompatible contributions fail validation before execution;
the runtime must not silently fork or overwrite the target.

## 4. Physical storage

### 4.1 Zarr

The canonical Zarr layout is:

```text
<target>.zarr/
  .zgroup
  .zattrs
  manifest/
  stages/
    <stage-index>-<stage-id>/
      metadata/
      table/<quantity>/
      fields/<quantity>/
  continuous/
    manifest/
    table-index/
    field-index/<quantity>/
```

The numerical arrays are stored exactly once under `stages/*`. The
`continuous` hierarchy contains only bounded manifests and indexes describing
the ordered logical concatenation. Readers expose it as a continuous table or
field series without copying numerical payloads.

Field arrays follow the aMuMax-oriented time-first organization, adapted to
the backend domain adapter. Every field series records sample times or
accepted-step coordinates, units, components, mesh identity, stage ownership,
and chunking. Zarr compression is enabled by default.

### 4.2 HDF5

HDF5 mirrors the Zarr hierarchy under `/stages` and `/continuous`. Numerical
datasets live only under `/stages`. `/continuous` stores index datasets and
metadata; readers resolve these indexes rather than duplicating field data.
The file records the same schema version and provenance as Zarr.

### 4.3 TXT

TXT contains tabular scalar data only.

- `continuous` produces `<target>.txt`, including the stage and clock columns
  defined above.
- `separate` produces one `<target>-<stage-index>-<stage-id>.txt` per stage.
- units and quantity identifiers are written in a stable header.
- field autosave is illegal for TXT.

## 5. Canonical Python API

Autosave is attached to the owning stage builder. The public policy classes
are `fm.StageAutosave` and `fm.FieldAutosave`. `fm.TableAutosave` remains the
canonical table policy. The stage builder accepts either an explicit
`StageAutosave` through `.autosave(policy)` or the equivalent keyword form.
Canonical syntax is:

```python
study.stages.add_relax(
    stage_id="relax-1",
    algorithm="projected_gradient_bb",
    max_steps=50_000,
    tol=7.957747154594767,
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

Run-stage autosave uses time cadence:

```python
study.stages.add_run(stage_id="reversal", duration=1e-9).autosave(fm.StageAutosave(
    target="main",
    layout="continuous",
    format="zarr",
    table=fm.TableAutosave(t_sampl=5e-12),
    fields=[fm.FieldAutosave("m", every=100e-12)],
))
```

`FieldAutosave` requires exactly one of `every` or `every_steps`.
`StageAutosave` defaults to `target="main"`, `layout="continuous"`, and
`format="zarr"`. Its `table` is optional and its `fields` default to an empty
tuple, but at least one of them must be configured. Canonical script export
must emit the fluent stage-local form and preserve all choices.

Legacy persistent `study.stages.autosave(...)` and
`study.stages.tableautosave(...)` remain readable during migration, but new UI
authoring never emits them for Relax or Run stages.

## 6. ProblemIR and authoring document

Each Relax or Run stage owns an optional autosave policy containing:

- target;
- layout;
- format;
- optional table policy;
- field policies;
- format-specific options are not exposed in this first version; Zarr and
  HDF5 use runtime-owned production defaults for chunking and compression.

ProblemIR describes output intent, not filesystem paths or backend buffers.
Validation rejects:

- empty or unsafe target identifiers;
- non-positive cadence;
- time cadence on accepted-step relaxation and accepted-step cadence on Run;
- fields with TXT;
- empty enabled policies;
- duplicate field quantity entries within a stage;
- incompatible contributions to one continuous target;
- collision with another declared output artifact.

UI-authored scene transactions and Python lowering must serialize the same
typed policy. Importing and exporting a canonical script must be lossless.

## 7. Runtime behavior

At stage entry the runner activates only that stage's policy. At stage exit it
flushes the table, drains the bounded artifact queue, commits stage metadata,
and restores the prior disabled state. A following stage has no autosave unless
it declares one.

For a continuous target, the writer opens or creates the target, validates the
existing schema, creates the new `stages/<stage>` group, appends logical index
metadata, and commits the stage atomically. A failed stage retains completed
samples and marks its stage group incomplete with the stop/failure reason.

The solver callback only enqueues bounded snapshot work. Encoding, compression,
and filesystem I/O remain outside the solver callback and outside GPU control
fences. Queue backpressure and dropped/blocked policy are explicit diagnostics;
no silent loss is permitted.

## 8. Control Room design

Selecting a `Relax` or `Run` node shows an `Autosave` tab or inspector section.
It uses the existing inspector draft transaction model and shared form
primitives.

The section contains:

1. master enable switch;
2. target name;
3. segmented layout choice: Continuous / Separate per stage;
4. format selector: Zarr / HDF5 / TXT;
5. table subsection with cadence and quantity selection;
6. field snapshot list with add/remove, quantity, and cadence;
7. read-only resolved output preview and compatibility diagnostics.

Changing format to TXT while fields exist produces an inline blocking error
and disables Apply; it must not silently discard field configuration. Joining
an incompatible continuous target shows the exact conflicting stage and
property.

The UI submits a canonical authoring transaction through the existing typed
API facade. React components do not call `fetch`, construct endpoint paths, or
own server resources. No new WebSocket payload is required.

## 9. API and resource behavior

The existing scene/study authoring resource carries the stage-local policy.
The authoring API gains typed schemas for the stage-local autosave policy and
its table and field entries. It does not add a screen-shaped autosave endpoint.

Runtime artifacts expose target, format, layout, stage membership, completeness,
schema version, and downloadable resource identity through the canonical
artifact resource family. HTTP v2 remains authoritative. Realtime events only
invalidate the affected artifact/stage resources.

## 10. Compatibility and migration

- Existing Zarr result bundles remain readable.
- Existing persistent autosave actions retain their current behavior when
  imported and are marked as legacy in the Inspector.
- New stage-local output schema uses an explicit version.
- The reader must not infer a continuous stage index for legacy data lacking
  one; it exposes the legacy bundle as a single unsegmented sequence.
- HDF5 support must be capability-gated if the managed runtime lacks the
  required writer dependency. Strict execution fails closed rather than
  falling back to Zarr.

## 11. Verification

Required proof includes:

- Python construction, validation, lowering, and canonical script round-trip;
- ProblemIR serde, normalization, and cross-stage compatibility tests;
- authoring transaction round-trip for Relax and Run;
- UI tests for defaults, TXT/field rejection, continuous/separate selection,
  target conflicts, and imported legacy read-only behavior;
- writer tests proving stage-local ownership and no state leakage;
- Zarr and HDF5 layout/readback tests;
- TXT continuous and separate table tests;
- continuous indexes reconstruct the same ordered samples as direct per-stage
  reads without duplicate field payloads;
- interrupted-stage recovery and provenance tests;
- bounded writer queue and solver-callback timing regression gates;
- managed FEM GPU runtime startup with a real Relax/Run sequence.

## 12. Non-goals

- TXT storage of spatial fields;
- physically merging relaxation pseudotime with Run physical time;
- duplicating numerical arrays to create the continuous view;
- direct browser filesystem writes;
- backend-specific autosave semantics;
- silent format fallback or automatic target forking.
