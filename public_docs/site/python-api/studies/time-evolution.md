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

(python-api-studies-time-evolution-frozen-spins)=
## Frozen-spin constraints

`TimeEvolution.constraints` transports `FrozenSpins` to study execution with stage-aware intent:

- `stage_ids` / `activation` control when the freeze starts and stops.
- `reference` controls whether frozen vectors come from capture-at-activation, initial state, or an
  explicit field asset.
- `membership` controls whether frozen cells stay fixed or are sampled at activation.

Execution should fail closed on unsupported combinations; no planner may silently rewrite a requested
constraint into a permissive equivalent.

## Standard entry: time-evolution frozen-spins and autosave (source-first)

### Wprowadzenie

`TimeEvolution` carries `constraints` (typed `FrozenSpins`) and optional `table_autosave` exactly as
request-time intent. Study-level intent is passed to planner/runtime conversion without lossy lowering.

### Bezpośredni dowód z kodu

- `TimeEvolution.__init__` (`packages/fullmag-py/src/fullmag/model/study.py`) przyjmuje:
  `dynamics`, `outputs`, `constraints=()`, `table_autosave=None`.
- `TimeEvolution.table_autosave(...)` buduje nową instancję `TimeEvolution` z
  `TableAutosave(...)`.
- `TimeEvolution.tableadd(...)` dopina dodatkowe wyrażenie tylko wtedy, gdy tabela już istnieje.

### Implementacja w Pythonie (bezpośrednio)

```python
import fullmag as fm

study = fm.study("te_source")
study.engine("fem")
study.device("cpu", precision="double")
study.universe(mode="manual", size=(800e-9, 400e-9, 300e-9))
study.universe.mesh(maximum_element_size=100e-9)
film = study.geometry(fm.Box(300e-9, 100e-9, 5e-9), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.solver(integrator="rk45", fix_dt=1e-15)
study.stages.add_run(stage_id="run", until=1e-12)

te = fm.TimeEvolution(
    dynamics=fm.LLG(integrator="rk45", fixed_timestep=1e-15),
    outputs=(),
    constraints=(),
    table_autosave=None,
)
```

```python
# Canonical method call to add autosave:
import fullmag as fm

study = fm.study("te_autosave_source")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
film = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.solver(integrator="rk45", fix_dt=1e-15)
study.stages.add_run(stage_id="run", until=1e-12)
te = fm.TimeEvolution(
    dynamics=fm.LLG(),
    outputs=(),
    constraints=(),
    table_autosave=None,
)
te = te.table_autosave(
    t_sampl=1e-12,
    quantities=("e_total",),
    extra_quantities=("mx", "my", "mz"),
    table_id="primary",
)
```

### Funkcje i argumenty (z kodu źródłowego)

| Funkcja | Argumenty |
|---|---|
| `TimeEvolution.__init__(self, dynamics, outputs, constraints=(), table_autosave=None)` | Konstruktor klasy study-stage. `constraints` i `table_autosave` są częścią kontraktu. |
| `TimeEvolution.table_autosave(*, t_sampl, quantities=None, extra_quantities=(), table_id="default")` | Definiuje próbkowanie do tabeli; zwraca nowy obiekt `TimeEvolution`. |
| `TimeEvolution.tableadd(expression)` / `table_add` | Dopina ekspresję do istniejącej tabeli; błędy przy braku uprzedniej konfiguracji. |
| `ProblemIR.study.sampling` | Przeniesienie pola `sampling` (`outputs`, `table_autosave`) do wykonania runtime. |

### Referencje do kodu

- `packages/fullmag-py/src/fullmag/model/study.py:613` (`class TimeEvolution`)
- `packages/fullmag-py/src/fullmag/model/study.py:619` (`TimeEvolution.__init__`)
- `packages/fullmag-py/src/fullmag/model/study.py:649` (`TimeEvolution.table_autosave`)
- `packages/fullmag-py/src/fullmag/model/study.py:689` (`tableadd`)
- `packages/fullmag-py/src/fullmag/model/problem.py` (integracja z `ProblemIR`)

### Bibliografia

- Abert, C. “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).

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

Requested intent preserves dynamics, outputs, constraints, and autosave policy. Resolved execution
adds the selected integrator implementation, target masks, output materialization, solver, device,
and precision without replacing requested intent. Validation errors reject unknown selection or
object references, malformed constraints, and invalid output quantities. Unsupported combinations
fail closed and do not silently fall back to another lane.

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

## Control Room crosswalk

Status: Stage authoring and inspection are partial; the stage editor exposes only its advertised fields.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> Add stage -> <stage kind>` | `partial` | Submit stage draft; stage and downstream result resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Stages -> Add stage -> <stage kind>` | `not implemented` | Python-only until implemented |

frontend support is not implemented for study parameters not rendered by the stage editor.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx (StudyStageDraftEditor)`.

## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| constructor and lowering | `packages/fullmag-py/src/fullmag/model/study.py` | `class TimeEvolution` | dynamics, sampling, constraints | signature/source-map tests |
