---
title: Runtime Selection
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-runtime-selection)=
# Runtime Selection

(python-api-runtime-runtime-selection-problem-statement)=
## Contract
Runtime selection declares the requested backend, device, precision, FDM precision policy,
independent-work admission policy (`parallel_execution`), and execution mode before stages are
authored, and also supports per-stage device transitions (`study.stages.change_device`), isolated
authoring contexts (`ExecutionContext` / `fm.execution_context`), and session/provenance helpers
(`fm.parallel_execution`, `fm.wait_for_solve`, `fm.runtime_metadata`, `fm.interactive`). Requested
selection is always preserved separately from resolved execution.

(python-api-runtime-runtime-selection-governing-equations)=
## Governing equations
This page introduces no physical equation; it owns the runtime descriptor and its lowering.

(python-api-runtime-runtime-selection-symbols-and-si-units)=
## Symbols and SI units
All fields are dimensionless policy identifiers, boolean flags, or counts ($1$); no physical units
are owned here.

(python-api-runtime-runtime-selection-assumptions-and-validity)=
## Assumptions and validity
Selection values are validated fail-closed immediately:

- `fdm_precision_policy` conflict rule: if `fdm_precision_policy` is set on `RuntimeSelection`, its
  implied precision (`FdmPrecisionPolicy.FULL_DOUBLE` -> `double`,
  `FdmPrecisionPolicy.SINGLE_STORAGE_FP64_REDUCTION` -> `single`) MUST match `execution_precision`;
  otherwise `ValueError("fdm_precision_policy conflicts with execution_precision")` is raised.
  Calling `RuntimeSelection.precision_policy(policy)` updates both fields atomically.
- `parallel_execution` fail-closed lane rule: `ParallelExecutionPolicy(mode="adaptive")` requires
  `backend_target="fem"` and `device_target="cpu"` (for independent eigen `k`-sweep execution).
  Requesting `"adaptive"` on FDM, GPU/CUDA, or `"auto"` fails closed at construction/lowering with
  `ValueError`.
- `gpu_count` must be `0` or `1` (`> 1` is rejected as unimplemented), and setting `gpu_count != 0`
  or `device_index is not None` requires `device_target` in `{"cuda", "gpu"}`.
- `cpu_threads` must be `>= 1` when set.

(python-api-runtime-runtime-selection-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `RuntimeSelection.backend_target` | `BackendTarget` | `BackendTarget.AUTO` | $1$ | `auto`, `fdm`, `fem`, or `hybrid` | Requested solver backend family | Planner-resolved across FEM/FDM CPU/GPU | `backend_policy.requested_backend` |
| `RuntimeSelection.device_target` | `DeviceTarget` | `DeviceTarget.AUTO` | $1$ | `auto`, `cpu`, `cuda`, or `gpu` | Requested execution device target | Planner-resolved across CPU/GPU | `problem_meta.runtime_metadata.runtime_selection.device` |
| `RuntimeSelection.gpu_count` | `int` | `0` | $1$ | `0` or `1`; `> 1` rejected as unimplemented; non-zero requires `cuda`/`gpu` | Requested GPU device count | CUDA/GPU lanes | `problem_meta.runtime_metadata.runtime_selection.gpu_count` |
| `RuntimeSelection.device_index` | `int \| None` | `None` | $1$ | Non-negative integer; requires `cuda`/`gpu` | Explicit CUDA device ordinal | CUDA/GPU lanes | `problem_meta.runtime_metadata.runtime_selection.device_index` |
| `RuntimeSelection.cpu_threads` | `int \| None` | `None` | $1$ | Integer `>= 1` when set | Requested CPU thread count for the Rayon pool | CPU lanes | `problem_meta.runtime_metadata.runtime_selection.cpu_threads` |
| `RuntimeSelection.execution_mode` | `ExecutionMode` | `ExecutionMode.STRICT` | $1$ | `strict`, `extended`, or `hybrid` | Execution capability policy | Planner-resolved across FEM/FDM CPU/GPU | `validation_profile.execution_mode` |
| `RuntimeSelection.execution_precision` | `ExecutionPrecision` | `ExecutionPrecision.DOUBLE` | $1$ | `single` or `double` | Requested floating-point precision | Planner-resolved across FEM/FDM CPU/GPU | `backend_policy.execution_precision` |
| `RuntimeSelection.fdm_precision_policy` | `FdmPrecisionPolicy \| None` | `None` | $1$ | `full_double` or `single_storage_fp64_reduction`; must match `execution_precision` | Explicit FDM storage/reduction precision policy | FDM CPU/GPU; planner validates compatibility | `problem_meta.runtime_metadata.runtime_selection.fdm_precision_policy` |
| `RuntimeSelection.parallel_execution` | `ParallelExecutionPolicy` | `ParallelExecutionPolicy()` (`mode="serial"`) | $1$ | `serial` or `adaptive`; `adaptive` fails closed unless `fem` + `cpu` | Independent-work admission policy | Serial: all lanes; adaptive: FEM CPU only | `problem_meta.runtime_metadata.runtime_selection.parallel_execution` |
| `StudyStages.change_device.device` | `str` | `required` | $1$ | Device spec (`"cpu"`, `"gpu"`, `"cuda"`, `"cuda:0"`) | Switch execution device for subsequent stages in a multi-stage study | Multi-stage CPU/GPU workflows | `study.pipeline.stages[].device` |

### Study builder, context, and module-level runtime helpers

| Helper | Signature | Role |
| --- | --- | --- |
| `study.engine`, `study.device`, `study.mode`, `study.threads` | `study.engine(backend)`, `study.device(spec, precision=None)`, `study.mode(execution_mode)`, `study.threads(cpu_threads)` | Fluent study-level setters mutating `RuntimeSelection` before stage compilation |
| `study.parallel_execution` / `fm.parallel_execution` | `(policy=None, **kwargs) -> StudyBuilder \| ParallelExecutionPolicy` | Configure `ParallelExecutionPolicy` (e.g. `mode="adaptive"`, `max_workers=4`, `threads_per_worker=2`) on the active study or world |
| `study.stages.change_device` | `(device: str) -> StudyStagesBuilder` | Record an explicit device transition between ordered study stages (e.g. CPU setup/relax -> GPU dynamics) |
| `fm.ExecutionContext` / `fm.execution_context()` | `with fm.execution_context() as ctx:` | Context manager binding a fresh isolated mutable world and capture state for thread/task isolation (used by `fm.sweep`) |
| `fm.runtime_metadata` | `(key: str, value: object) -> None` | Attach custom user/provenance metadata entries to `problem_meta.runtime_metadata` |
| `fm.wait_for_solve` | `(enabled: bool = True) -> None` | Control whether script-driven live/runtime solve commands block until completion |
| `fm.interactive` | `(enabled: bool = True) -> None` | Mark whether an interactive session is requested in `problem_meta.runtime_metadata.interactive_session_requested` |

### Complete stage-first example

```python
# %% Runtime selection, adaptive FEM CPU admission, and isolated execution context
import fullmag as fm

nm = 1.0e-9

with fm.execution_context():
    study = fm.study("runtime_selection_api_example")
    study.engine("fem")
    study.device("cpu", precision="double")
    study.mode("strict")
    study.threads(4)
    study.parallel_execution(
        mode="adaptive",
        max_cpu_percent=85.0,
        max_workers=2,
        threads_per_worker=2,
    )
    fm.runtime_metadata("campaign", "dispersion_sweep_01")
    fm.wait_for_solve(True)
    fm.interactive(False)

    study.objects.mesh.defaults(maximum_element_size=5 * nm)
    film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
    film.Ms = 800.0e3
    film.Aex = 13.0e-12
    film.alpha = 0.02
    film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
    study.exchange()
    study.stages.add_relax(stage_id="relax_cpu", dt=5.0e-13, max_steps=100)
    study.stages.change_device("gpu")
    study.stages.add_run(stage_id="run_gpu", until=1.0e-9)
```

(python-api-runtime-runtime-selection-problem-ir)=
## ProblemIR
The runtime descriptor lowers into `backend_policy` (`requested_backend`, `execution_precision`),
`validation_profile.execution_mode`, and `problem_meta.runtime_metadata.runtime_selection`
(`backend`, `device`, `gpu_count`, `device_index`, `cpu_threads`, `execution_mode`,
`execution_precision`, optional `fdm_precision_policy`, and `parallel_execution`).

(python-api-runtime-runtime-selection-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Requested intent is preserved verbatim. Resolved execution is the planner's capability result and
must be recorded separately in provenance. Conflicting `fdm_precision_policy` vs
`execution_precision`, `parallel_execution.mode="adaptive"` outside `fem` + `cpu`, or invalid
device/thread values fail immediately; unsatisfiable lanes fail capability checks without silent
fallback.

(python-api-runtime-runtime-selection-discrete-realization)=
## Discrete realization

| Solver | Device | Runtime selection support | Fail-closed boundaries |
| --- | --- | --- | --- |
| FDM | CPU | `engine("fdm")`, `device("cpu")`, `threads(...)`, `fdm_precision_policy`, serial admission | `parallel_execution.mode="adaptive"` rejected |
| FDM | GPU | `engine("fdm")`, `device("gpu" \| "cuda[:i]")`, `fdm_precision_policy`, `change_device("gpu")` | `gpu_count > 1` and `mode="adaptive"` rejected |
| FEM | CPU | `engine("fem")`, `device("cpu")`, `threads(...)`, `parallel_execution(mode="adaptive" \| "serial")` | `adaptive` admission applies only to independent eigen `k`-sweeps |
| FEM | GPU | `engine("fem")`, `device("gpu" \| "cuda[:i]")`, `change_device("gpu")` | `gpu_count > 1` and `mode="adaptive"` rejected |

(python-api-runtime-runtime-selection-implementation-mapping)=
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`class RuntimeSelection`,
`class ParallelExecutionPolicy`) and `packages/fullmag-py/src/fullmag/world.py`
(`class ExecutionContext`, `execution_context`, `StudyStagesBuilder.change_device`,
`parallel_execution`, `wait_for_solve`, `runtime_metadata`, `interactive`).

(python-api-runtime-runtime-selection-validation)=
## Validation
Ownership and runtime-policy tests cover `RuntimeSelection` validation, `fdm_precision_policy`
conflict checks, `parallel_execution` FEM+CPU gating, `ExecutionContext` isolation, and
`change_device` stage lowering.

(python-api-runtime-runtime-selection-limitations)=
## Limitations
Multi-GPU (`gpu_count > 1`) is rejected as unimplemented. GPU source presence and compilation do
not replace executed-device qualification.

(python-api-runtime-runtime-selection-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `Python-only` | Authored in Python |

Runtime-selection parameters outside the workspace runtime panel remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` (`RuntimeExplorerInspectorPanels`).

(python-api-runtime-runtime-selection-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Runtime descriptor | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | [`class RuntimeSelection`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | Canonical runtime selection, validation, and resolution | Ownership and API contract tests |
| Isolated authoring context | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2991) | [`class ExecutionContext`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2991), `execution_context` | Scoped world and capture isolation | Context isolation tests |
| Per-stage device transitions | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5341) | [`change_device`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5341) | Multi-stage CPU/GPU device switching (`StudyStagesBuilder.change_device`) | Multi-stage lowering tests |
| Runtime helper functions | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7764) | [`parallel_execution`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L7764), `wait_for_solve`, `runtime_metadata`, `interactive` | Module-level runtime and provenance controls | Live/batch hook tests |
