---
title: Results
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-results)=
# Results

(python-api-runtime-results-problem-statement)=
## Contract
`Result` is the immutable executed (or planned) run outcome returned by `Simulation.plan()` and
`Simulation.run(...)`: status, resolved backend/mode/precision, diagnostic `notes`, step
statistics (`steps`), optional `final_magnetization`, and resolved `output_dir`.

(python-api-runtime-results-governing-equations)=
## Governing equations
No physical equation is owned here; step energy and torque quantities are defined by the
interaction pages.

(python-api-runtime-results-symbols-and-si-units)=
## Symbols and SI units
Energy scalars are in joules ($\mathrm{J}$); field maxima `max_h_eff`, `max_h_demag` in
$\mathrm{A\,m^{-1}}$; `max_torque_T` in tesla ($\mathrm{T}$); `max_dm_dt` in $\mathrm{s^{-1}}$;
times in seconds ($\mathrm{s}$). Status strings, notes, descriptors, and reduced magnetization
samples are dimensionless ($1$).

(python-api-runtime-results-assumptions-and-validity)=
## Assumptions and validity
`last()` and `series()` require non-empty `steps`; unknown scalar quantities or missing region
names raise immediately. `save_state(...)` requires `final_magnetization is not None`.

(python-api-runtime-results-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Result.status` | `str` | `required` | $1$ | `completed`, `planned`, or `not-executable` | Resolved run execution status | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | run status |
| `Result.backend` | `BackendTarget` | `required` | $1$ | Resolved `BackendTarget` enum | Backend selected for the run | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `backend_policy.requested_backend` |
| `Result.mode` | `ExecutionMode` | `required` | $1$ | Resolved `ExecutionMode` enum | Execution policy applied to the run | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `validation_profile.execution_mode` |
| `Result.precision` | `ExecutionPrecision` | `required` | $1$ | Resolved `ExecutionPrecision` enum | Floating-point precision applied to the run | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `backend_policy.execution_precision` |
| `Result.notes` | `Sequence[str]` | `()` | $1$ | Ordered diagnostic strings | Planning, capability, or non-executable diagnostic notes | FEM/FDM CPU/GPU runtime record | runtime notes |
| `Result.steps` | `Sequence[StepStats]` | `()` | $1$ | Per-step scalar statistics | Recorded time-step observables and energies | FEM/FDM CPU/GPU runtime output | steps array |
| `Result.final_magnetization` | `list[list[float]] \| None` | `None` | $1$ | Final reduced magnetization vectors `(N, 3)` | Final unit magnetization samples | FEM/FDM CPU/GPU runtime output | final magnetization |
| `Result.output_dir` | `str \| None` | `None` | $1$ | Resolved artifact directory path | Directory holding persisted run artifacts | FEM/FDM CPU/GPU runtime output | `resolved_output_storage.output_dir` |

### Read access and state persistence methods

| Method | Signature | Behavior |
| --- | --- | --- |
| `Result.series` | `(quantity: str, region: str \| None = None) -> list[float]` | Return full time series for a scalar quantity, optionally scoped to a region |
| `Result.last` | `(quantity: str, region: str \| None = None) -> float` | Return the final step value for a scalar quantity |
| `Result.scalar_descriptor` | `(quantity: str) -> ScalarQuantityDescriptor` | Look up metadata (canonical `id`, human `label`, SI `unit`) for one scalar quantity |
| `Result.scalar_descriptors` | `() -> tuple[ScalarQuantityDescriptor, ...]` | Return the full tuple of known scalar quantity descriptors |
| `Result.save_state` | `(path: str \| Path, *, format: str = "auto", dataset: str = "values") -> Path` | Persist `final_magnetization` to `json`, `zarr`, `h5`, `ovf`, `npz`, or `npy` (raises if `final_magnetization` is `None`) |

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

# After execution, the resolved Result exposes readers, descriptors, notes, and state export:
# result.notes
# result.scalar_descriptor("e_total")
# result.scalar_descriptors()
# result.series("e_total"), result.last("max_torque_T")
# result.save_state("final_m.zarr", format="zarr", dataset="values")
```

(python-api-runtime-results-problem-ir)=
## ProblemIR
`Result` is runtime output, not lowering input; it has no `ProblemIR` destination. Its `backend`,
`mode`, `precision`, `notes`, and `output_dir` fields reflect the resolved execution record.

(python-api-runtime-results-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

An unknown scalar quantity or a missing region raises immediately. `save_state(...)` on a result
without `final_magnetization` raises an explanatory error.

(python-api-runtime-results-discrete-realization)=
## Discrete realization

| Solver | Device | `Result` payload | Qualification note |
| --- | --- | --- | --- |
| FDM | CPU | Full `StepStats`, `final_magnetization`, `notes`, and `output_dir` from `run_problem_json` | Reference CPU observables covered by regression suites |
| FDM | GPU | Same `Result` schema populated from host-copied GPU run payloads | Device parity validated separately |
| FEM | CPU | Same `Result` schema with FEM nodal `final_magnetization` and energy/torque series | FEM observable convergence validated separately |
| FEM | GPU | Same `Result` schema populated from host-copied GPU FEM payloads | Executed-device qualification validated separately |

(python-api-runtime-results-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Result`, `class StepStats`,
`ScalarQuantityDescriptor`).

(python-api-runtime-results-validation)=
## Validation
Ownership and runtime tests compare this inventory with live `Result` fields and verify
`series`, `last`, `scalar_descriptor`, `scalar_descriptors`, and `save_state`.

(python-api-runtime-results-limitations)=
## Limitations
A `planned` or `not-executable` result carries no step data and explains the condition in `notes`;
consumers must branch on `status`.

(python-api-runtime-results-scientific-bibliography)=
## Scientific bibliography
Quantity definitions belong to the interaction and outputs pages.

## Control Room support

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `Python-only` | Authored in Python |

Result inspection parameters outside the workspace runtime panel remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` (`RuntimeExplorerInspectorPanels`).

(python-api-runtime-results-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Result and step stats | [`packages/fullmag-py/src/fullmag/runtime/simulation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L77) | [`class Result`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L77), `StepStats` | Executed outcome mapping, `notes`, descriptors, and `save_state` | Ownership and API contract tests |
| Scalar access | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `Result.series`, `Result.last`, `Result.scalar_descriptor`, `Result.scalar_descriptors` | Series/point/metadata read access | Ownership test |
