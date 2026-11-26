---
title: Backend Policy
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-backend-policy)=
# Backend Policy

(python-api-runtime-backend-policy-problem-statement)=
## Contract
Backend policy defines the typed enums and structured resource/profile models governing solver
family, device target, execution mode, floating-point precision, FDM mixed-precision policy
(`FdmPrecisionPolicy`), independent-work admission (`ParallelExecutionPolicy`), layered execution
profiles (`ExecutionProfile`, `ExecutionOverrides`, `ExecutionRequestLayer`), and hardware resource
requests (`ComputeResources`, `ComputeTarget`, `CpuResources`, `GpuResources`, `MemoryReservation`,
`DistributedResources`, and `*ResourceOverrides`).

For solver-level performance implications, mixed-precision tradeoffs, and GPU acceleration
benchmarks, see {ref}`numerical-methods-performance`.

(python-api-runtime-backend-policy-governing-equations)=
## Governing equations
No physical equation is owned here.

(python-api-runtime-backend-policy-symbols-and-si-units)=
## Symbols and SI units
Policy enums, worker counts, thread counts, percentages, and identifiers are dimensionless ($1$).
Memory reserve and reservation fields (`memory_reserve_bytes`, `reservation_bytes`,
`vram_per_device_bytes`) are integer byte counts ($\mathrm{B}$).

(python-api-runtime-backend-policy-assumptions-and-validity)=
## Assumptions and validity
Enum coercion is case-insensitive and fail-closed. Hybrid backend and hybrid mode must be selected
together; any other pairing is rejected. `FdmPrecisionPolicy` must agree with `ExecutionPrecision`
(`full_double` requires `double`; `single_storage_fp64_reduction` requires `single`).
`ParallelExecutionPolicy(mode="adaptive")` fails closed unless `backend_target="fem"` and
`device_target="cpu"`.

(python-api-runtime-backend-policy-python-api)=
## Python API

### Policy enums and admission models

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `BackendTarget` | `str` enum | `"auto"` | $1$ | `auto`, `fdm`, `fem`, `hybrid` | Solver backend family | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `backend_policy.requested_backend` |
| `DeviceTarget` | `str` enum | `"auto"` | $1$ | `auto`, `cpu`, `cuda`, `gpu` | Execution device target | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `problem_meta.runtime_metadata.runtime_selection.device` |
| `ExecutionMode` | `str` enum | `"strict"` | $1$ | `strict`, `extended`, `hybrid` | Execution capability policy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `validation_profile.execution_mode` |
| `ExecutionPrecision` | `str` enum | `"double"` | $1$ | `single`, `double` | Floating-point precision | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `backend_policy.execution_precision` |
| `FdmPrecisionPolicy` | `str` enum | `None` (unspecified) | $1$ | `full_double` (`double`) or `single_storage_fp64_reduction` (`single`); must match `execution_precision` | Explicit FDM storage/reduction precision contract | FDM CPU/GPU; planner validates compatibility | `problem_meta.runtime_metadata.runtime_selection.fdm_precision_policy` |
| `ParallelExecutionPolicy.mode` | `str` | `"serial"` | $1$ | `"serial"` or `"adaptive"`; `"adaptive"` requires `fem` + `cpu` | Independent-work admission mode (e.g. eigen `k`-sweeps) | Serial: all lanes; adaptive: FEM CPU only | `problem_meta.runtime_metadata.runtime_selection.parallel_execution.mode` |
| `ParallelExecutionPolicy.max_cpu_percent` | `float` | `90.0` | $1$ | Finite real in `(0, 100]` | Soft CPU utilization ceiling inside container allocation | FEM CPU adaptive admission | `problem_meta.runtime_metadata.runtime_selection.parallel_execution.max_cpu_percent` |
| `ParallelExecutionPolicy.max_memory_percent` | `float` | `80.0` | $1$ | Finite real in `(0, 100]` | Soft memory utilization ceiling inside container allocation | FEM CPU adaptive admission | `problem_meta.runtime_metadata.runtime_selection.parallel_execution.max_memory_percent` |
| `ParallelExecutionPolicy.memory_reserve_bytes` | `int` | `1073741824` | $\mathrm{B}$ | Integer in `[0, 2^64 - 1]` | Reserved headroom bytes kept free for runtime overhead | FEM CPU adaptive admission | `problem_meta.runtime_metadata.runtime_selection.parallel_execution.memory_reserve_bytes` |
| `ParallelExecutionPolicy.max_workers` | `int \| None` | `None` | $1$ | `None` or integer `>= 1` | Hard cap on concurrent independent workers | FEM CPU adaptive admission | `problem_meta.runtime_metadata.runtime_selection.parallel_execution.max_workers` |
| `ParallelExecutionPolicy.threads_per_worker` | `int` | `1` | $1$ | Integer `>= 1` | Threads assigned to each admitted worker | FEM CPU adaptive admission | `problem_meta.runtime_metadata.runtime_selection.parallel_execution.threads_per_worker` |

### Execution profiles and compute resource models

Layered execution profiles (`packages/fullmag-py/src/fullmag/model/execution_profile.py`) and
compute resource requests (`packages/fullmag-py/src/fullmag/model/compute_resources.py`) separate
reusable execution defaults from per-study, per-step, and CLI overrides:

| Symbol | Signature / fields | Role |
| --- | --- | --- |
| `fm.ExecutionProfile` | `(profile_id, version, defaults=ExecutionOverrides(), description="")` | Named, versioned execution profile providing default backend/device/precision/mode and resource overrides |
| `fm.ExecutionOverrides` | `(backend=UNSET, device=UNSET, precision=UNSET, mode=UNSET, resources=ComputeResourceOverrides())` | Partial override layer using explicit unset sentinels so omitted fields inherit cleanly |
| `fm.ExecutionRequestLayer` | `(kind: Literal['script','study','step','submit','cli','legacy_env'], location: str, request=ExecutionOverrides())` | Provenance-tracked override layer recording where each execution request originated |
| `fm.ComputeResources` | `(target=ComputeTarget(), cpu=CpuResources(), gpu=None, ram=MemoryReservation(), scratch=MemoryReservation(), parallelism=None, placement='balanced')` | Concrete hardware resource reservation and placement descriptor (`balanced`, `throughput`, `pinned`) |
| `fm.ComputeTarget` | `(kind: Literal['local','node','pool'] = 'local', id: str \| None = None)` | Execution host, node, or pool selector |
| `fm.CpuResources` | `(threads='auto', core_policy=None, affinity='auto', numa_node=None, native_threads='auto', blas_threads='auto')` | CPU threading, core policy (`physical_first`/`logical`), affinity (`auto`/`compact`/`spread`/`numa`), and BLAS thread controls |
| `fm.GpuResources` | `(selector='any_compatible', device_uuids=(), devices_per_task=1, vram_per_device_bytes=None)` | GPU device selection (`any_compatible`, `allow_list`, `required`), count, and VRAM reservation |
| `fm.MemoryReservation` | `(reservation_bytes: int \| None = None)` | Byte reservation for RAM or private scratch storage |
| `fm.DistributedResources` | `(ranks: int, threads_per_rank: int, ranks_per_node: int, gpus_per_rank: int = 0)` | Multi-rank distributed topology descriptor |
| `fm.ComputeResourceOverrides`, `fm.CpuResourceOverrides`, `MemoryResourceOverrides` | Field-wise `UNSET`-aware override mirrors of `ComputeResources`, `CpuResources`, and `MemoryReservation` | Partial resource overrides composed inside `ExecutionOverrides.resources` |

### Mode semantics

- `strict` — the requested combination must be exactly executable or planning fails.
- `extended` — permits documented transitional or compatibility lanes as resolved by the planner.
- `hybrid` — spans backend families and therefore requires `backend_target=hybrid`.

### Complete stage-first example

```python
# %% Backend policy, FDM precision policy, and execution profile authoring
import fullmag as fm

nm = 1.0e-9

study = fm.study("backend_policy_api_example")
study.engine("fdm")
study.device("cuda:0", precision="single")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-9)

# Inspect precision policy and reusable execution profile objects:
selection = fm.RuntimeSelection().engine("fdm").cuda().precision_policy(
    fm.FdmPrecisionPolicy.SINGLE_STORAGE_FP64_REDUCTION
)
assert selection.execution_precision is fm.ExecutionPrecision.SINGLE

profile = fm.ExecutionProfile(
    profile_id="workstation_gpu",
    version="1.0",
    defaults=fm.ExecutionOverrides(
        backend="fdm",
        device="gpu",
        precision="single",
        mode="strict",
        resources=fm.ComputeResourceOverrides(
            gpu=fm.GpuResources(selector="any_compatible", devices_per_task=1),
        ),
    ),
)
assert profile.profile_id == "workstation_gpu"
```

(python-api-runtime-backend-policy-problem-ir)=
## ProblemIR
Policy enum values serialize as their lowercase strings inside `backend_policy`,
`validation_profile`, and `problem_meta.runtime_metadata.runtime_selection`. When set,
`fdm_precision_policy` serializes to `"full_double"` or `"single_storage_fp64_reduction"`, and
`parallel_execution` serializes its six admission fields into `runtime_selection.parallel_execution`.

(python-api-runtime-backend-policy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Requested policy is preserved verbatim. Resolution is reported independently. Invalid identifiers,
hybrid/non-hybrid mismatches, `fdm_precision_policy` / `execution_precision` conflicts, and
`parallel_execution.mode="adaptive"` outside FEM CPU fail immediately.

(python-api-runtime-backend-policy-discrete-realization)=
## Discrete realization

| Solver | Device | Policy surface | Qualification note |
| --- | --- | --- | --- |
| FDM | CPU | `BackendTarget.FDM`, `ExecutionPrecision.{DOUBLE,SINGLE}`, `FdmPrecisionPolicy`, serial admission | Precision and parity covered by FDM reference suites |
| FDM | GPU | `BackendTarget.FDM`, `DeviceTarget.{GPU,CUDA}`, `FdmPrecisionPolicy.SINGLE_STORAGE_FP64_REDUCTION` / `FULL_DOUBLE` | See {ref}`numerical-methods-performance` for mixed-precision CUDA speedups and parity |
| FEM | CPU | `BackendTarget.FEM`, `ExecutionPrecision.DOUBLE`, `ParallelExecutionPolicy(mode="adaptive")` for independent eigen `k`-sweeps | Adaptive eigen `k`-sweep admission is FEM CPU only |
| FEM | GPU | `BackendTarget.FEM`, `DeviceTarget.{GPU,CUDA}`, `GpuResources`, serial admission | GPU cuDSS and preconditioned solver policies live on discretization pages |

(python-api-runtime-backend-policy-implementation-mapping)=
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`BackendTarget`, `DeviceTarget`,
`ExecutionMode`, `ExecutionPrecision`, `FdmPrecisionPolicy`, `ParallelExecutionPolicy`),
`packages/fullmag-py/src/fullmag/model/execution_profile.py` (`ExecutionProfile`,
`ExecutionOverrides`, `ExecutionRequestLayer`, `ComputeResourceOverrides`, `CpuResourceOverrides`),
and `packages/fullmag-py/src/fullmag/model/compute_resources.py` (`ComputeResources`,
`ComputeTarget`, `CpuResources`, `GpuResources`, `MemoryReservation`, `DistributedResources`).

(python-api-runtime-backend-policy-validation)=
## Validation
Ownership, enum-coercion, conflict-rejection, and execution-profile layering tests cover this
vocabulary.

(python-api-runtime-backend-policy-limitations)=
## Limitations
Identifier support does not prove lane executability; planner capability resolution is
authoritative.

(python-api-runtime-backend-policy-scientific-bibliography)=
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

(python-api-runtime-backend-policy-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Backend-family policy vocabulary | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1705) | [`class BackendTarget`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1705), `DeviceTarget`, `ExecutionMode`, `ExecutionPrecision` | Canonical policy enums and vocabulary | Ownership and API contract tests |
| FDM precision policy | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1717) | [`class FdmPrecisionPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1717) | Mixed-precision storage/reduction contract for FDM | Precision policy tests |
| Parallel admission policy | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1746) | [`class ParallelExecutionPolicy`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1746) | Independent-work admission and FEM CPU gating | Parallel policy tests |
| Runtime policy state and lowering | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | [`class RuntimeSelection`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | Runtime selection state and lowering | Ownership and API contract tests |
| Execution profiles and override layers | [`packages/fullmag-py/src/fullmag/model/execution_profile.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/execution_profile.py#L358) | [`class ExecutionProfile`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/execution_profile.py#L358), `ExecutionOverrides`, `ExecutionRequestLayer` | Layered execution defaults and provenance | Execution profile tests |
| Compute resource descriptors | [`packages/fullmag-py/src/fullmag/model/compute_resources.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/compute_resources.py#L297) | [`class ComputeResources`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/compute_resources.py#L297), `CpuResources`, `GpuResources`, `DistributedResources` | Hardware resource reservations and placement | Compute resource tests |
