---
title: Fields And Scalars
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-fields-and-scalars)=
# Fields And Scalars

(python-api-outputs-fields-and-scalars-problem-statement)=
## Contract
This page records the current public Python authoring contract and canonical lowering for `fm.SaveField` and `fm.SaveScalar`; it does not redefine solver physics.

(python-api-outputs-fields-and-scalars-governing-equations)=
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-outputs-fields-and-scalars-symbols-and-si-units)=
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-outputs-fields-and-scalars-assumptions-and-validity)=
## Assumptions and validity
Constructor checks run immediately against the canonical known field and scalar registries. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-outputs-fields-and-scalars-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `SaveField.field` | `str` | `required` | $1$ | Canonical field ID (31 registered fields; e.g., `H_ex` requires `Exchange()`). | Canonical field ID persisted at the requested cadence. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].name` (`kind: "field"` or `"field_auto"`) |
| `SaveField.every` | `float \| Literal["auto"]` | `required` | $\mathrm{s}$ | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. | Physical sampling interval or Sinc-cutoff automatic cadence. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].every_seconds` or `sample_period_policy` |
| `SaveScalar.scalar` | `str` | `required` | $1$ | Canonical scalar ID (24 registered scalars; e.g., `E_ex` requires `Exchange()`). | Canonical scalar ID persisted at the requested cadence. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].name` (`kind: "scalar"` or `"scalar_auto"`) |
| `SaveScalar.every` | `float \| Literal["auto"]` | `required` | $\mathrm{s}$ | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. | Physical sampling interval or Sinc-cutoff automatic cadence. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].every_seconds` or `sample_period_policy` |

### Complete output stage scenario

Output requests are attached to the ordered stage, after the physical model and solver policy have been declared.

```python
# %% Field and scalar output from a complete stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("output_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.exchange()

film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(dt_min=1.0e-15),
    gamma=2.211e5,
)
study.stages.add_run(stage_id="run", until=1.0e-9).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=1.0e-12,
            quantities=["step", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("H_ex", every=1.0e-12)],
    )
)

field_req = fm.SaveField("H_ex", every=1.0e-12)
scalar_req = fm.SaveScalar("E_ex", every=1.0e-12)
assert field_req.to_ir() == {"kind": "field", "name": "H_ex", "every_seconds": 1.0e-12}
assert scalar_req.to_ir() == {"kind": "scalar", "name": "E_ex", "every_seconds": 1.0e-12}
```

(python-api-outputs-fields-and-scalars-problem-ir)=
## ProblemIR
`SaveField.to_ir()` emits `{"kind": "field", "name": ..., "every_seconds": ...}` for numeric periods or `{"kind": "field_auto", "name": ..., "sample_period_policy": {"kind": "auto_sinc_cutoff", "nyquist_guard_factor": 1.3}}` for `"auto"`. `SaveScalar.to_ir()` follows the same structure with `"scalar"` / `"scalar_auto"`.

(python-api-outputs-fields-and-scalars-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
Requested intent is preserved in Python and `ProblemIR`. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-outputs-fields-and-scalars-discrete-realization)=
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-outputs-fields-and-scalars-implementation-mapping)=
## Implementation mapping

| Solver | Device | Status | Notes |
| --- | --- | --- | --- |
| FEM | CPU | `documented` | Persists scheduled field and scalar outputs at accepted step boundaries. |
| FEM | GPU | `documented` | Persists device-reduced scalars and scheduled field snapshots; see {ref}`numerical-methods-performance-fem-gpu-kernels`. |
| FDM | CPU | `documented` | Persists Cartesian fields and global/reduced scalars. |
| FDM | GPU | `documented` | Persists CUDA field and scalar outputs (with deferred accepted-endpoint spin reconstruction per {ref}`numerical-methods-performance-fdm-transport`). |

(python-api-outputs-fields-and-scalars-validation)=
## Validation
Tests compare this parameter inventory with live Python signatures.

(python-api-outputs-fields-and-scalars-limitations)=
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-outputs-fields-and-scalars-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

## Control Room support

Status: Table/field autosave and result inspection are `partial`; unlisted output formats and advanced parameters remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
| --- | --- | --- | --- |
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Autosave` (`FieldAutosaveStageSpec`) | `partial` | Submit autosave draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `Python-only` | Authored in Python |

Output parameters outside `FieldAutosaveStageSpec` remain Python-only.
See {doc}`/frontend/capability-register` for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/inspectors/study/stages/FieldAutosaveStageSpec.tsx`.

(python-api-outputs-fields-and-scalars-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
| --- | --- | --- | --- | --- |
| `SaveField` constructor, validation, lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L79) | [`class SaveField`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L79) | Canonical Python API behavior | Ownership and API contract tests |
| `SaveScalar` constructor, validation, lowering | [`packages/fullmag-py/src/fullmag/model/outputs.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L100) | [`class SaveScalar`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/outputs.py#L100) | Canonical scalar-output API behavior | Ownership and API contract tests |
