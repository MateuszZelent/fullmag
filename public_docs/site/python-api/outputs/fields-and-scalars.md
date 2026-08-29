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
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-outputs-fields-and-scalars-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-outputs-fields-and-scalars-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-outputs-fields-and-scalars-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-outputs-fields-and-scalars-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `SaveField.field` | `str` | `required` | $1$ | Canonical field ID. For example, `H_ex` requires `Exchange()`. | Canonical field ID. For example, `H_ex` requires `Exchange()`. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].field` |
| `SaveField.every` | `positive float or "auto"` | `required` | $\mathrm{s}$ | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].every` |
| `SaveScalar.scalar` | `str` | `required` | $1$ | Canonical scalar ID. For example, `E_ex` requires `Exchange()`. | Canonical scalar ID. For example, `E_ex` requires `Exchange()`. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].scalar` |
| `SaveScalar.every` | `positive float or "auto"` | `required` | $\mathrm{s}$ | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. | Finite positive sampling period in seconds, or `"auto"`; step-count sampling is not accepted here. | FEM/FDM CPU/GPU; planner checks combinations | `study.sampling.outputs[].every` |


### Complete output stage scenario

Output requests are attached to the ordered stage, after the physical model and solver policy
have been declared.

```python
# %% Field and scalar output from a complete study
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
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9).autosave(
    fm.StageAutosave(
        table=fm.TableAutosave(
            t_sampl=1.0e-12,
            quantities=["step", "e_ex", "e_total", "max_torque_T"],
        ),
        fields=[fm.FieldAutosave("H_ex", every=1.0e-12)],
    )
)
```

(python-api-outputs-fields-and-scalars-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-outputs-fields-and-scalars-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-outputs-fields-and-scalars-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-outputs-fields-and-scalars-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/outputs.py` and `class SaveField`.

(python-api-outputs-fields-and-scalars-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-outputs-fields-and-scalars-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-outputs-fields-and-scalars-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-outputs-fields-and-scalars-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Table/field autosave and result inspection are partial; unsupported output formats remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Autosave` | `partial` | Submit autosave draft; output resources are revised after execution |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Autosave` | `TODO` | Python-only until implemented |

frontend support is not implemented for output parameters not rendered by the autosave/result inspectors.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/stages/AutosaveStageInspector.tsx (AutosaveStageInspector)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| SaveField constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveField` | Canonical Python API behavior | Ownership test and source-map validator |

| SaveScalar constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/outputs.py` | `class SaveScalar` | Canonical scalar-output API behavior | Ownership test and source-map validator |
