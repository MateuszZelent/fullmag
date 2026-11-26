---
title: Simulation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-simulation)=
# Simulation

(python-api-runtime-simulation-problem-statement)=
## Contract
`Simulation` wraps a canonical `Problem` with an explicit backend target, execution mode, and
floating-point precision, and exposes `to_ir(...)`, `plan()`, and `run(...)` entrypoints.

(python-api-runtime-simulation-governing-equations)=
## Governing equations
This page introduces no physical equation; it owns the execution lifecycle.

(python-api-runtime-simulation-symbols-and-si-units)=
## Symbols and SI units
The stop time `until` is in seconds ($\mathrm{s}$). All backend, mode, precision, storage, and
entrypoint identifiers are dimensionless ($1$).

(python-api-runtime-simulation-assumptions-and-validity)=
## Assumptions and validity
`backend` must coerce to `BackendTarget` (`auto`, `fdm`, `fem`, or `hybrid`), `mode` to
`ExecutionMode` (`strict`, `extended`, or `hybrid`), and `precision` to `ExecutionPrecision`
(`single` or `double`). Hybrid backend and hybrid mode must be paired together: setting
`backend="hybrid"` without `mode="hybrid"` (or vice versa) raises `ValueError` immediately.
`run(until=...)` requires a positive stop time to execute; omitting `until` returns a `planned`
result without launching a solver.

(python-api-runtime-simulation-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Simulation.problem` | `Problem` | `required` | $1$ | Canonical `Problem` instance | Problem to lower, plan, or execute | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | problem body |
| `Simulation.backend` | `BackendTarget \| str \| None` | problem runtime | $1$ | `BackendTarget`: `auto`, `fdm`, `fem`, or `hybrid` | Requested solver backend family | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `backend_policy.requested_backend` |
| `Simulation.mode` | `ExecutionMode \| str \| None` | problem runtime | $1$ | `ExecutionMode`: `strict`, `extended`, or `hybrid` | Requested execution policy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `validation_profile.execution_mode` |
| `Simulation.precision` | `ExecutionPrecision \| str \| None` | problem runtime | $1$ | `ExecutionPrecision`: `single` or `double` | Requested floating-point precision | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `backend_policy.execution_precision` |
| `Simulation.to_ir.script_source` | `str \| None` | `None` | $1$ | Optional source text hashed for provenance | Source script embedded in lowered metadata | FEM/FDM CPU/GPU authoring | `problem_meta.script_source` |
| `Simulation.to_ir.entrypoint_kind` | `str` | `"direct"` | $1$ | Non-empty entrypoint identifier | Origin tag forwarded to `Problem.to_ir` | FEM/FDM CPU/GPU authoring | `problem_meta.entrypoint_kind` |
| `Simulation.run.until` | `float \| None` | `None` | $\mathrm{s}$ | Positive finite stop time for execution; `None` returns `status="planned"` | Simulation stop time | Executable native runner subset | runner stop time |
| `Simulation.run.output_dir` | `str \| None` | `None` | $1$ | Optional explicit output directory path | Overrides `study.storage.output_dir` or script-derived default | FEM/FDM CPU/GPU runtime | `resolved_output_storage.output_dir` |
| `Simulation.run.temp_dir` | `str \| None` | `None` | $1$ | Optional parent directory for private run scratch (never removed itself) | Scratch parent directory override | FEM/FDM CPU/GPU runtime | `output_storage.temp_dir` |
| `Simulation.run.data_format` | `str \| None` | `None` | $1$ | Optional `"zarr"` or `"hdf5"` override | Persisted field/table archive format override | FEM/FDM CPU/GPU runtime | `output_storage.data_format` |
| `Simulation.run.cleanup` | `str \| None` | `None` | $1$ | Optional private-scratch cleanup policy (`"on_success"`, `"always"`, `"never"`) | Controls removal of private scratch after a run | FEM/FDM CPU/GPU runtime | `output_storage.cleanup` |
| `Simulation.run.existing_output` | `str \| None` | `None` | $1$ | Optional collision policy (`"timestamp"`, `"overwrite"`, `"fail"`) | Behavior when the output directory already exists | FEM/FDM CPU/GPU runtime | `output_storage.existing_output` |

### Complete stage-first example

```python
# %% Stage-first authoring that lowers to the canonical Problem / Simulation boundary
import fullmag as fm

nm = 1.0e-9

study = fm.study("simulation_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.storage(
    output_dir="out/simulation_api_example",
    data_format="zarr",
    cleanup="on_success",
    existing_output="timestamp",
)

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-9)
```

The normal public path authors a stage-first study rather than constructing `Simulation` directly;
the loader lowers the study to `Problem`, and `Simulation` executes or plans it through the native
runner boundary.

(python-api-runtime-simulation-problem-ir)=
## ProblemIR
`Simulation.to_ir(script_source=..., entrypoint_kind=...)` delegates to `Problem.to_ir(...)`,
injecting `requested_backend=self.backend`, `execution_mode=self.mode`, and
`execution_precision=self.precision` along with the provenance arguments.

(python-api-runtime-simulation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

`run(until=None)` and `plan()` return a `Result` with `status="planned"` and do not execute. A
missing native core (`fullmag-py-core`) returns `status="not-executable"` with an explanatory note
rather than fabricating results.

(python-api-runtime-simulation-discrete-realization)=
## Discrete realization

| Solver | Device | `Simulation` lifecycle | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Lowers via `to_ir()` and dispatches through `run_problem_json` when `fullmag-py-core` is installed | Reference CPU subset qualified independently |
| FDM | GPU | Preserves requested GPU/CUDA intent through `to_ir()` to the native planner/runner | Fails closed when CUDA capability or hardware is unavailable |
| FEM | CPU | Preserves FEM intent through `to_ir()` and multi-stage runner boundary | Meshing and native FEM solve qualification remain separate |
| FEM | GPU | Preserves FEM GPU intent through `to_ir()` to the native planner/runner | Executed-device GPU qualification remains separate |

(python-api-runtime-simulation-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Simulation`).

(python-api-runtime-simulation-validation)=
## Validation
Ownership and runtime contract tests verify `Simulation.__post_init__`, `Simulation.to_ir`,
`Simulation.plan`, and `Simulation.run` against live signatures and storage overrides.

(python-api-runtime-simulation-limitations)=
## Limitations
The executable direct `Simulation.run(...)` subset is narrower than the full multi-stage CLI
authoring surface; unsupported combinations return an honest `not-executable` or planner error
instead of a silent fallback.

(python-api-runtime-simulation-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `Python-only` | Authored in Python |

Runtime-selection and execution-control parameters outside the workspace runtime panel remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` (`RuntimeExplorerInspectorPanels`).

(python-api-runtime-simulation-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Execution lifecycle | [`packages/fullmag-py/src/fullmag/runtime/simulation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L122) | [`class Simulation`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L122) | Plan, IR export, and execution lifecycle | Ownership and API contract tests |
