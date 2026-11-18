---
title: Autosave
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-autosave)=
# Autosave

(python-api-outputs-autosave-problem-statement)=
## Contract
This page records the table, field, and stage autosave policies that schedule persistent output
during a stage.

(python-api-outputs-autosave-governing-equations)=
## Governing equations
No physical equation is introduced; autosave is transport and persistence policy.

(python-api-outputs-autosave-symbols-and-si-units)=
## Symbols and SI units
Sampling periods are in seconds ($\mathrm{s}$) or dimensionless step counts ($1$); quantities carry the units defined by their
observables.

(python-api-outputs-autosave-assumptions-and-validity)=
## Assumptions and validity
Exactly one of the time or step cadence must be set; formats and layouts are validated immediately.

(python-api-outputs-autosave-python-api)=
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `TableAutosave.t_sampl` | `SamplingPeriod \| None` | `None` | $\mathrm{s}$ | Exactly one of `t_sampl` and `every_steps`; normalized by the source helper | Time-based scalar-table cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `table_autosave.sample_period_s` or `sample_period_policy` |
| `TableAutosave.every_steps` | `int \| None` | `None` | $1$ | Exactly one of `t_sampl` and `every_steps`; positive integer | Step-based scalar-table cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `table_autosave.every_steps` |
| `TableAutosave.quantities` | `Sequence[str] \| None` | default set | $1$ | Supported quantity ids | Table columns | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `table_autosave.quantities` |
| `TableAutosave.extra_quantities` | `Sequence[str]` | `()` | $1$ | Supported quantity ids; normalized and de-duplicated | Additional scalar-table columns | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `table_autosave.quantities` |
| `TableAutosave.expressions` | `Sequence[str]` | `()` | $1$ | Expressions are normalized by the source helper | Additional scalar-table expressions | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `table_autosave.expressions` |
| `TableAutosave.table_id` | `str` | `"default"` | $1$ | Non-empty | Table identity | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `table_autosave.table_id` |
| `FieldAutosave.quantity` | `str` | `required` | $1$ | Known field id | Field cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `field_autosave.quantity` |
| `FieldAutosave.every` | `SamplingPeriod \| None` | `None` | $\mathrm{s}$ | Exactly one of `every` and `every_steps`; normalized by the source helper | Time-based field cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `field_autosave.every_seconds` or `sample_period_policy` |
| `FieldAutosave.every_steps` | `int \| None` | `None` | $1$ | Exactly one of `every` and `every_steps`; positive integer | Step-based field cadence | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `field_autosave.every_steps` |
| `StageAutosave.target` | `str` | `"main"` | $1$ | `[A-Za-z0-9][A-Za-z0-9._-]*` | Save target | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `stage_autosave.target` |
| `StageAutosave.table` | `TableAutosave \| None` | `None` | $1$ | `TableAutosave` or `None`; at least one table/field policy is required | Scalar-table autosave policy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `stage_autosave.table` |
| `StageAutosave.fields` | `Sequence[FieldAutosave]` | `()` | $1$ | Every item must be `FieldAutosave`; at least one table/field policy is required | Field autosave policies | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `stage_autosave.fields` |
| `StageAutosave.format` | `str` | `"zarr"` | $1$ | `zarr`, `hdf5`, or `txt` | Persistence format | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `stage_autosave.format` |
| `StageAutosave.layout` | `str` | `"continuous"` | $1$ | `continuous` or `separate` | Layout policy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `stage_autosave.layout` |

### Complete stage-first example

```python
# %% Relax stage with table and field autosave
import fullmag as fm

nm = 1.0e-9

study = fm.study("autosave_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 1.0
film.m = fm.init.UniformMagnetization((1.0, 0.1, 0.0))
study.exchange()

study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            every_steps=10,
            quantities=["step", "mx", "my", "mz", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("m", every_steps=100)],
    )
)
```

(python-api-outputs-autosave-problem-ir)=
## ProblemIR
`StageAutosave.to_ir()` emits `kind`, `target`, `layout`, `format`, `table`, and `fields`; a time
policy lower to `sample_period_s`/`every_seconds` and `"auto"` lower to a Sinc-based
`sample_period_policy`.

(python-api-outputs-autosave-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Ambiguous (both/neither) cadence, unsupported formats, duplicate field quantities, and `txt` with
field outputs fail immediately.

(python-api-outputs-autosave-discrete-realization)=
## Discrete realization
Cadence is consumed by the runtime sampler; persistence formats map to JSON/Zarr/HDF5 writers.

(python-api-outputs-autosave-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/study.py` (`TableAutosave`, `FieldAutosave`,
`StageAutosave`).

(python-api-outputs-autosave-validation)=
## Validation
Ownership and cadence tests exercise the policy normalizations.

(python-api-outputs-autosave-limitations)=
## Limitations
Autosave is authoring policy; actual artifact production requires an executed lane.

(python-api-outputs-autosave-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Table/field autosave and result inspection are `partial`; unlisted output formats and advanced autosave fields remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Autosave` | `partial` | Submit autosave draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `Python-only` | Authored in Python |

Output parameters outside `AutosaveStageInspector` remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx` (`AutosaveStageInspector`).

(python-api-outputs-autosave-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Table cadence and quantity selection | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L337) | [`class TableAutosave`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L337) | Table cadence and quantity selection | Ownership and cadence tests |
| Field cadence and field selection | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L410) | [`class FieldAutosave`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L410) | Field cadence and field selection | Ownership and cadence tests |
| Stage output format, layout, and target | [`packages/fullmag-py/src/fullmag/model/study.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L453) | [`class StageAutosave`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/study.py#L453) | Stage output format, layout, and target | Ownership and cadence tests |
