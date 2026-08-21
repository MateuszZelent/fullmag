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
## Contract

`TimeEvolution` owns one LLG dynamics policy, output sampling, optional frozen-spin constraints,
and an optional table-autosave policy. The stage-first builder normally constructs this contract
from `study.solver(...)`, output declarations, constraints, and `study.stages.add_run(...)`.

(python-api-studies-time-evolution-governing-equations)=
## Governing equations

The LLG equation belongs to the dynamics reference. This class orders its integration and sampling
contract and does not introduce a second equation or torque conversion.

(python-api-studies-time-evolution-symbols-and-si-units)=
## Symbols and SI units

Dynamics and output quantities retain their documented SI units. `constraints` and output IDs are
semantic data; sampling periods are in seconds when time-based.

(python-api-studies-time-evolution-assumptions-and-validity)=
## Assumptions and validity

An empty output sequence is legal. Constraints must be typed `FrozenSpins` definitions and retain
selection, activation, reference, and failure policies. The selected planner/runtime remains the
source of truth for whether a constraint and output combination is executable.

(python-api-studies-time-evolution-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `TimeEvolution.dynamics` | `LLG` | required | mixed | typed dynamics policy | time-domain equation and integrator | planner-dependent | `study.dynamics` |
| `TimeEvolution.outputs` | `Sequence[TimeOutputSpec]` | required | mixed | typed outputs; empty sequence legal | requested field/scalar/snapshot sampling | planner-dependent | `study.sampling.outputs` |
| `TimeEvolution.constraints` | `Sequence[FrozenSpins]` | `()` | $1$ | typed frozen-spin constraints; references resolved at problem/planner boundary | stage-applicable magnetization constraints | capability-gated by target and lane | canonical magnetization constraints associated with the study |
| `TimeEvolution.table_autosave` | `TableAutosave \| None` | `None` | mixed | typed autosave policy | optional scalar-table sampling | planner/runtime-dependent | `study.sampling.table_autosave` |

```python
# %% Time-evolution study
import fullmag as fm

study = fm.study("time_evolution_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
film = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
film.Ms = 8.0e5
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.solver(integrator="rk45", fix_dt=1e-15)
study.stages.add_run(stage_id="run", until=1e-12)
```

(python-api-studies-time-evolution-problem-ir)=
## ProblemIR

The time-evolution record preserves dynamics and sampling. Constraint definitions remain typed
problem/study intent and must not be lost when stages are rewritten or exported.

(python-api-studies-time-evolution-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested dynamics, outputs, constraints, and autosave policy are preserved. Unknown selection or
object references, unsupported constraints, invalid output quantities, or unavailable execution
lanes fail closed.

(python-api-studies-time-evolution-discrete-realization)=
## Discrete realization

Each backend integrates the same requested study through its own LLG, output, and constraint
materialization. CPU/GPU trajectory identity is not implied.

(python-api-studies-time-evolution-implementation-mapping)=
## Implementation mapping

`packages/fullmag-py/src/fullmag/model/study.py`, `class TimeEvolution`, owns construction and
study-level lowering; problem/planner layers own constraint reference resolution.

(python-api-studies-time-evolution-validation)=
## Validation

Tests compare the inventory with `inspect.signature(TimeEvolution)` and validate the source map.
Runtime tests must additionally exercise active/inactive stage constraints and checkpoint replay.

(python-api-studies-time-evolution-limitations)=
## Limitations

Representability does not prove every integrator, output, constraint, solver, device, and precision
combination executable.

(python-api-studies-time-evolution-scientific-bibliography)=
## Scientific bibliography

Physical references belong to LLG, thermal-noise, torque, and constraint pages.

(python-api-studies-time-evolution-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| constructor and lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class TimeEvolution` | dynamics, sampling, constraints | signature/source-map tests |
