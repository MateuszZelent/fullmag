---
title: Provenance
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-provenance)=
# Provenance

(python-api-runtime-provenance-problem-statement)=
## Contract
Provenance keeps requested intent separate from resolved execution. Lowering captures the full
requested `RuntimeSelection` (backend, device, GPU count, device ordinal, CPU threads, execution
mode, floating-point precision, FDM precision policy, and parallel-execution admission) inside
`problem_meta.runtime_metadata.runtime_selection`, while the runtime returns the actual resolved
`Result` (`status`, `backend`, `mode`, `precision`, `notes`, and `output_dir`).

(python-api-runtime-provenance-governing-equations)=
## Governing equations
No physical equation is owned here.

(python-api-runtime-provenance-symbols-and-si-units)=
## Symbols and SI units
All provenance fields are dimensionless policy identifiers, counts, ordinals, or diagnostic strings
($1$), except `parallel_execution.memory_reserve_bytes` in bytes ($\mathrm{B}$).

(python-api-runtime-provenance-assumptions-and-validity)=
## Assumptions and validity
Requested and resolved values are normalized but never conflated; a `planned` or `not-executable`
result is distinct from a `completed` one and records explanatory diagnostics in `Result.notes`.

(python-api-runtime-provenance-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `RuntimeSelection.backend_target` | `BackendTarget` | `auto` | $1$ | Enum value (`auto`, `fdm`, `fem`, `hybrid`) | Requested backend family | FEM/FDM CPU/GPU; planner resolves capability | `backend_policy.requested_backend` |
| `RuntimeSelection.device_target` | `DeviceTarget` | `auto` | $1$ | Enum value (`auto`, `cpu`, `cuda`, `gpu`) | Requested device target | FEM/FDM CPU/GPU; planner resolves capability | `problem_meta.runtime_metadata.runtime_selection.device` |
| `RuntimeSelection.gpu_count` | `int` | `0` | $1$ | `0` or `1`; requires `cuda`/`gpu` when non-zero | Requested GPU count | CUDA/GPU lanes | `problem_meta.runtime_metadata.runtime_selection.gpu_count` |
| `RuntimeSelection.device_index` | `int \| None` | `None` | $1$ | Non-negative ordinal; requires `cuda`/`gpu` | Requested GPU ordinal | CUDA/GPU lanes | `problem_meta.runtime_metadata.runtime_selection.device_index` |
| `RuntimeSelection.cpu_threads` | `int \| None` | `None` | $1$ | Integer `>= 1` when set | Requested CPU Rayon thread count | CPU lanes | `problem_meta.runtime_metadata.runtime_selection.cpu_threads` |
| `RuntimeSelection.execution_mode` | `ExecutionMode` | `strict` | $1$ | Enum value (`strict`, `extended`, `hybrid`) | Requested execution mode | FEM/FDM CPU/GPU; planner resolves capability | `validation_profile.execution_mode` |
| `RuntimeSelection.execution_precision` | `ExecutionPrecision` | `double` | $1$ | Enum value (`single`, `double`) | Requested floating-point precision | FEM/FDM CPU/GPU; planner resolves capability | `backend_policy.execution_precision` |
| `RuntimeSelection.fdm_precision_policy` | `FdmPrecisionPolicy \| None` | `None` | $1$ | `full_double` or `single_storage_fp64_reduction`; must match `execution_precision` | Requested FDM storage/reduction precision policy | FDM CPU/GPU | `problem_meta.runtime_metadata.runtime_selection.fdm_precision_policy` |
| `RuntimeSelection.parallel_execution` | `ParallelExecutionPolicy` | `ParallelExecutionPolicy()` | $1$ | `serial` or `adaptive` (`adaptive` requires `fem` + `cpu`) | Requested independent-work admission policy | Serial: all lanes; adaptive: FEM CPU only | `problem_meta.runtime_metadata.runtime_selection.parallel_execution` |
| `Result.status` | `str` | required | $1$ | One of `completed`, `planned`, or `not-executable` | Resolved execution outcome | FEM/FDM CPU/GPU runtime record | `runtime.status` |
| `Result.notes` | `Sequence[str]` | `()` | $1$ | Diagnostic strings emitted by planner/runner | Human-readable provenance and capability notes | FEM/FDM CPU/GPU runtime record | `runtime.notes` |

### Complete stage-first context

```python
# %% Provenance stage-first probe and runtime metadata serialization
import fullmag as fm

study = fm.study("api_contract_probe")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.threads(4)
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
body = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_run(stage_id="probe", until=1.0e-12)

# Inspect exact serialized provenance payload for a RuntimeSelection:
selection = (
    fm.RuntimeSelection()
    .engine("fdm")
    .cpu()
    .threads(4)
    .precision_policy(fm.FdmPrecisionPolicy.FULL_DOUBLE)
)
provenance_block = selection.to_runtime_metadata()
assert (
    provenance_block["fdm_precision_policy"]["realization_id"]
    == "fullmag.fdm.cuda.precision.full_double.v1"
)
assert provenance_block["parallel_execution"]["mode"] == "serial"
```

Provenance is attached to the study the script authored; the resolved record is read from the
executed `Result` (see {doc}`../runtime/results`).

(python-api-runtime-provenance-problem-ir)=
## ProblemIR

Calling `RuntimeSelection.to_runtime_metadata()` produces the canonical `runtime_selection` block
embedded at `problem_meta.runtime_metadata.runtime_selection`:

```json
{
  "backend": "fdm",
  "device": "cpu",
  "gpu_count": 0,
  "device_index": null,
  "cpu_threads": 4,
  "execution_mode": "strict",
  "execution_precision": "double",
  "fdm_precision_policy": {
    "storage": "double",
    "compute": "double",
    "fft": "double",
    "reduction": "double",
    "realization_id": "fullmag.fdm.cuda.precision.full_double.v1"
  },
  "parallel_execution": {
    "mode": "serial",
    "max_cpu_percent": 90.0,
    "max_memory_percent": 80.0,
    "memory_reserve_bytes": 1073741824,
    "max_workers": null,
    "threads_per_worker": 1
  }
}
```

When `device_index` is set on a CUDA selection, `to_runtime_metadata()` additionally emits
`legacy_cuda_binding` so explicit GPU ordinals remain observable across round-trips.

(python-api-runtime-provenance-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

A capability failure must state the unsatisfied combination; it never silently substitutes another
backend, device, precision, or physics term.

(python-api-runtime-provenance-discrete-realization)=
## Discrete realization

| Solver | Device | Provenance guarantees | Qualification note |
| --- | --- | --- | --- |
| FDM | CPU | Records `backend`, `device`, `cpu_threads`, `fdm_precision_policy`, `parallel_execution`, and `Result.notes` | Planner capability & runtime status stay separated |
| FDM | GPU | Records `device`, `gpu_count`, `device_index`, `fdm_precision_policy`, and `legacy_cuda_binding` | Provenance alone does not prove GPU parity without executed tests |
| FEM | CPU | Records `backend`, `device`, `cpu_threads`, and `parallel_execution` (`serial` or `adaptive`) | Adaptive eigen worker count resolved at runtime |
| FEM | GPU | Records `device`, `gpu_count`, `device_index`, and resolved `Result.notes` | Provenance alone does not prove GPU parity without executed tests |

(python-api-runtime-provenance-implementation-mapping)=
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`class RuntimeSelection`) and
`packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Result`).

(python-api-runtime-provenance-validation)=
## Validation
Capability and round-trip tests require requested/resolved separation, `fdm_precision_policy`,
`parallel_execution`, and `Result.notes` to remain observable.

(python-api-runtime-provenance-limitations)=
## Limitations
Provenance records requested intent and planner/runner resolution; it does not by itself prove that
a GPU lane executed on current hardware without dedicated runtime qualification tests.

(python-api-runtime-provenance-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `Python-only` | Authored in Python |

Runtime-selection and provenance parameters outside the workspace runtime panel remain Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx` (`RuntimeExplorerInspectorPanels`).

(python-api-runtime-provenance-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Requested selection | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | [`class RuntimeSelection`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | Requested descriptors and provenance metadata | Ownership and API contract tests |
| Resolved result | [`packages/fullmag-py/src/fullmag/runtime/simulation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L77) | [`class Result`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/runtime/simulation.py#L77) | Resolved execution result, `status`, and `notes` | Ownership and API contract tests |
