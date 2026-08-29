---
title: Field Refresh
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-dynamics-field-refresh)=
# Field Refresh

(python-api-dynamics-field-refresh-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the cadence control for expensive field/operator refreshes during dynamics.

(python-api-dynamics-field-refresh-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is introduced; refresh cadence is a numerical-efficiency policy.

(python-api-dynamics-field-refresh-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
`demag_interval_s` is in seconds of simulation time.

(python-api-dynamics-field-refresh-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The demagnetization refresh interval must be positive when set.

(python-api-dynamics-field-refresh-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `FieldRefreshPolicy.demag_interval_s` | `float \| None` | `None` | Positive | Demag refresh cadence | `field_refresh.demag_interval_s` |
| `LLG.field_refresh` | `FieldRefreshPolicy \| None` | `None` | Valid policy | Attach refresh cadence to dynamics | `dynamics.field_refresh` |

The stage-first builder spells the same cadence as `study.solver(..., demag_interval_s=...)`;
`FieldRefreshPolicy` is the underlying model object lowered into the LLG dynamics record.

### Complete stage-first example

```python
# %% Attach a demag refresh cadence to fixed-step dynamics
import fullmag as fm

nm = 1.0e-9

study = fm.study("field_refresh_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.solver(
    integrator="heun",
    fix_dt=5.0e-13,
    gamma=2.211e5,
    demag_interval_s=1.0e-11,
)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-dynamics-field-refresh-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`FieldRefreshPolicy.to_ir()` emits `{"demag_interval_s": ...}` when set, attached as
`dynamics.field_refresh`.

(python-api-dynamics-field-refresh-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Non-positive intervals fail immediately. Unavailable caveats still require executed evidence from
the selected backend.

(python-api-dynamics-field-refresh-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The cadence is consumed by demag-assembly schedules in the selected backend lane.

(python-api-dynamics-field-refresh-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/dynamics.py` (`class FieldRefreshPolicy`).

(python-api-dynamics-field-refresh-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-dynamics-field-refresh-limitations)=
<!-- (limitations)= -->
## Limitations
Cadence control is an efficiency hint; solver correctness must not depend on refresh frequency.

(python-api-dynamics-field-refresh-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-dynamics-field-refresh-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Common solver/stage fields are partial; backend-specific options without editor fields remain TODO.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Solver` | `partial` | Apply stage draft; solver request and result resources become stale |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Solver` | `TODO` | Python-only until implemented |

TODO: frontend support for dynamics parameters not rendered by the stage editor.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx (StudyStageDraftEditor)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Refresh policy | `packages/fullmag-py/src/fullmag/model/dynamics.py` | `class FieldRefreshPolicy` | Cadence lowering | Ownership test |
