---
title: Results
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-results)=
# Results

(python-api-runtime-results-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`Result` is the lightweight direct-execution outcome: status, the backend/mode/precision selected
on `Simulation`, step statistics, optional final magnetization, and output directory. It is not the
session-scoped v2 run resource and does not expose separate requested/resolved identities.

(python-api-runtime-results-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is owned here; step energy and torque quantities are defined by the
interaction pages.

(python-api-runtime-results-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Energy scalars are in joules; measure-like maxima `max_h_eff`, `max_h_demag` in $\mathrm{A\,m^{-1}}$;
`max_torque_T` in tesla; `max_dm_dt` in $\mathrm{s^{-1}}$; times in seconds.

(python-api-runtime-results-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
`last()` requires step data. `series()` returns an empty list when there are no steps. Unknown
quantities raise immediately.

(python-api-runtime-results-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Meaning | Origin |
|---|---|---|---|---|
| `Result.status` | `str` | `required` | Common values are `completed`, `planned`, and `not-executable` | lightweight runtime result |
| `Result.backend` | `BackendTarget` | `required` | Backend selection copied from `Simulation` | `Simulation.backend` |
| `Result.mode` | `ExecutionMode` | `required` | Mode selection copied from `Simulation` | `Simulation.mode` |
| `Result.precision` | `ExecutionPrecision` | `required` | Precision selection copied from `Simulation` | `Simulation.precision` |
| `Result.notes` | `Sequence[str]` | empty | Planner/runtime explanation strings | lightweight runtime result |
| `Result.steps` | `Sequence[StepStats]` | empty | Per-step statistics | native runner payload |
| `Result.final_magnetization` | `list[list[float]] \| None` | `None` | Final vector samples | native runner payload |
| `Result.output_dir` | `str \| None` | `None` | Local artifact-directory reference | `Simulation.run(output_dir=...)` |

### Read access

`series(quantity, region=...)` and `last(quantity, region=...)` return scalar series/points by
name and accept an optional region selector that resolves per-object scalars.
`scalar_descriptors()` returns the known scalar inventory with id, label, and unit.

### Complete stage-first context

Reading a result follows the same stage-first study that produced it; this page does not construct
a standalone `Result`.

```python
# %% Stage-first study that produces a Result for inspection
import fullmag as fm

nm = 1.0e-9

study = fm.study("results_api_example")
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
study.stages.add_run(stage_id="run", until=1.0e-12)

# After execution, the resolved run exposes the result readers:
# result.series("e_total"), result.last("max_torque_T"), result.scalar_descriptors()
```

(python-api-runtime-results-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`Result` is runtime output, not lowering input; it has no `ProblemIR` destination. Its backend,
mode, and precision fields echo the `Simulation` selection, not a separately resolved record.

(python-api-runtime-results-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
An unknown scalar quantity or a missing region raises immediately. `save_state()` on a result
without `final_magnetization` raises an explanatory error.

(python-api-runtime-results-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Step statistics originate from the native runner payload and are mapped field-by-field.

(python-api-runtime-results-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Result`, `StepStats`,
`ScalarQuantityDescriptor`).

(python-api-runtime-results-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-runtime-results-limitations)=
<!-- (limitations)= -->
## Limitations
A `planned` or missing-native-core `not-executable` result carries no step data; consumers must
branch on `status`. For canonical session requested/resolved provenance, use
`/v2/sessions/current/simulation/runs/current` rather than this class.

(python-api-runtime-results-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Quantity definitions belong to the interaction and outputs pages.

(python-api-runtime-results-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Result and step stats | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Result`, `StepStats` | Executed outcome mapping | Ownership test |
| Scalar access | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `Result.series`, `Result.last` | Series/point read | Ownership test |
