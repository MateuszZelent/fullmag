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
<!-- (problem-statement)= -->
## Contract
This page records the table, field, and stage autosave policies that schedule persistent output
during a stage.

(python-api-outputs-autosave-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; autosave is transport and persistence policy.

(python-api-outputs-autosave-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Sampling periods are in seconds or in steps; quantities carry the units defined by their
observables.

(python-api-outputs-autosave-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Exactly one of the time or step cadence must be set; formats and layouts are validated immediately.

(python-api-outputs-autosave-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `TableAutosave.t_sampl` / `every_steps` | `SamplingPeriod \| int` | exactly one required | Time or positive step cadence | Scalar table cadence | `table_autosave` |
| `TableAutosave.quantities` | `Sequence[str] \| None` | default set | Supported quantity ids | Table columns | `table_autosave.quantities` |
| `TableAutosave.extra_quantities` | `Sequence[str]` | `()` | Supported ids | Appended columns | merged quantities |
| `TableAutosave.table_id` | `str` | `"default"` | Non-empty | Table identity | `table_autosave.table_id` |
| `FieldAutosave.quantity` | `str` | `required` | Known field id | Field cadence | `field_autosave.quantity` |
| `FieldAutosave.every` / `every_steps` | `SamplingPeriod \| int` | exactly one required | Time or positive step cadence | Field cadence | field cadence |
| `StageAutosave.target` | `str` | `"main"` | `[A-Za-z0-9][A-Za-z0-9._-]*` | Save target | `stage_autosave.target` |
| `StageAutosave.format` | `str` | `"zarr"` | `zarr`, `hdf5`, or `txt` | Persistence format | `stage_autosave.format` |
| `StageAutosave.layout` | `str` | `"continuous"` | `continuous` or `separate` | Layout policy | `stage_autosave.layout` |

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
<!-- (problem-ir)= -->
## ProblemIR
`StageAutosave.to_ir()` emits `kind`, `target`, `layout`, `format`, `table`, and `fields`; a time
policy lower to `sample_period_s`/`every_seconds` and `"auto"` lower to a Sinc-based
`sample_period_policy`.

(python-api-outputs-autosave-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Ambiguous (both/neither) cadence, unsupported formats, duplicate field quantities, and `txt` with
field outputs fail immediately.

(python-api-outputs-autosave-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Cadence is consumed by the runtime sampler; persistence formats map to JSON/Zarr/HDF5 writers.

(python-api-outputs-autosave-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/study.py` (`TableAutosave`, `FieldAutosave`,
`StageAutosave`).

(python-api-outputs-autosave-validation)=
<!-- (validation)= -->
## Validation
Ownership and cadence tests exercise the policy normalizations.

(python-api-outputs-autosave-limitations)=
<!-- (limitations)= -->
## Limitations
Autosave is authoring policy; actual artifact production requires an executed lane.

(python-api-outputs-autosave-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-outputs-autosave-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Autosave policies | `packages/fullmag-py/src/fullmag/model/study.py` | `TableAutosave`, `FieldAutosave`, `StageAutosave` | Cadence/format lowering | Ownership and cadence tests |
