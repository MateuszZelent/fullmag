---
title: Time Evolution
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-studies-time-evolution)=
# Time Evolution

(python-api-studies-time-evolution-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-studies-time-evolution-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-studies-time-evolution-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-studies-time-evolution-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-studies-time-evolution-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `TimeEvolution.dynamics` | `LLG` | `required` | $1$ | Time-domain equation and integrator settings. | Time-domain equation and integrator settings. | FEM/FDM CPU/GPU; planner checks combinations | `study.dynamics` |
| `TimeEvolution.outputs` | `sequence` | `required` | $1$ | Sampling requests. An empty sequence is valid. | Sampling requests. An empty sequence is valid. | FEM/FDM CPU/GPU; planner checks combinations | `study.outputs` |
| `TimeEvolution.table_autosave` | `TableAutosave \| None` | `None` | $1$ | Optional tabular autosave policy. | Optional tabular autosave policy. | FEM/FDM CPU/GPU; planner checks combinations | `study.table_autosave` |


### Complete stage-first example

Time evolution is authored as solver policy plus an ordered physical-time stage. It is not
constructed as a standalone `TimeEvolution(...)` object in a user script.

```python
# %% Time-evolution study with adaptive RK45
import fullmag as fm

nm = 1.0e-9
study = fm.study("time_evolution_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.exchange()
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(
    integrator="rk45",
    adaptive_timestep=fm.AdaptiveTimestep(
        atol=1.0e-6,
        rtol=1.0e-3,
        dt_min=1.0e-15,
        dt_max=1.0e-12,
    ),
    gamma=2.211e5,
)
study.tableautosave(
    1.0e-12,
    quantities=["step", "t", "dt", "e_ex", "e_total", "max_torque_T"],
)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-studies-time-evolution-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-studies-time-evolution-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-studies-time-evolution-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-studies-time-evolution-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/study.py` and `class TimeEvolution`.

(python-api-studies-time-evolution-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-studies-time-evolution-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-studies-time-evolution-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-studies-time-evolution-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class TimeEvolution` | Canonical Python API behavior | Ownership test and source-map validator |
