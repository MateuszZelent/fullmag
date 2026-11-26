---
title: Round Trip
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-round-trip)=
# Round Trip

(python-api-problem-round-trip-problem-statement)=
## Contract
Round trip covers authoring-to-IR lowering (`Problem.to_ir(...)`) and runtime descriptor
normalization (`RuntimeSelection.resolved(...)`, `RuntimeSelection.to_runtime_metadata()`) that keep
the Python authoring surface, canonical `ProblemIR`, and Control Room script exports consistent.

(python-api-problem-round-trip-governing-equations)=
## Governing equations
This page introduces no governing equation.

(python-api-problem-round-trip-symbols-and-si-units)=
## Symbols and SI units
Units carried by parameters follow their owning pages; exact lowering is unit-preserving. Lowering
options and runtime override descriptors are dimensionless ($1$).

(python-api-problem-round-trip-assumptions-and-validity)=
## Assumptions and validity
Lowering resolves runtime selection overrides and converts authored parameters to canonical SI
quantities without mutating requested intent. Validation failures occur at authoring or lowering
time, and unsupported lane combinations fail closed at planning.

(python-api-problem-round-trip-python-api)=
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Problem.to_ir.requested_backend` | `BackendTarget \| None` | `None` | $1$ | Optional override; normalized by `Problem.to_ir`. | Requested solver-family intent. | FEM/FDM CPU/GPU authoring; planner resolves capability. | `backend_policy.requested_backend` |
| `Problem.to_ir.execution_mode` | `ExecutionMode \| None` | `None` | $1$ | Optional override; normalized by `Problem.to_ir`. | Requested execution-mode intent. | FEM/FDM CPU/GPU authoring; planner resolves capability. | `validation_profile.execution_mode` |
| `Problem.to_ir.execution_precision` | `ExecutionPrecision \| None` | `None` | $1$ | Optional override; normalized by `Problem.to_ir`. | Requested precision intent. | FEM/FDM CPU/GPU authoring; planner resolves capability. | `backend_policy.execution_precision` |
| `Problem.to_ir.script_source` | `str \| None` | `None` | $1$ | Optional source script text; hashed into `source_hash` when supplied. | Source script recorded for provenance and round-trip sync. | FEM/FDM CPU/GPU authoring. | `problem_meta.script_source`, `problem_meta.source_hash` |
| `Problem.to_ir.source_root` | `str \| Path \| None` | `None` | $1$ | Optional filesystem root used to resolve relative geometry asset paths. | Base directory for imported CAD/mesh asset resolution. | FEM/FDM CPU/GPU authoring. | `geometry_assets` |
| `Problem.to_ir.entrypoint_kind` | `str` | `"direct"` | $1$ | Non-empty entrypoint label (e.g. `"direct"`, `"script"`). | Identifies how the problem was loaded into lowering. | FEM/FDM CPU/GPU authoring. | `problem_meta.entrypoint_kind` |
| `Problem.to_ir.asset_cache` | `dict[str, dict[str, Any] \| None] \| None` | `None` | $1$ | Optional mapping reused across repeated lowering calls. | Deterministic cache for materialized geometry assets. | FEM/FDM CPU/GPU authoring. | `geometry_assets` |
| `Problem.to_ir.include_geometry_assets` | `bool` | `True` | $1$ | Boolean flag; `False` skips geometry asset generation. | Controls whether mesh/CAD geometry assets are embedded in the lowered payload. | FEM/FDM CPU/GPU authoring. | `geometry_assets` |
| `Problem.to_ir.study_pipeline` | `dict[str, object] \| None` | `None` | $1$ | Optional multi-stage pipeline payload emitted by the stage-first loader. | Attaches ordered multi-stage workflow metadata to `ProblemIR`. | FEM/FDM CPU/GPU authoring. | `study.pipeline` |
| `Problem.to_ir.runtime_device_override` | `str \| None` | `None` | $1$ | Optional device override (`"cpu"`, `"gpu"`, `"cuda"`) validated against runtime rules. | Overrides the lowered runtime device descriptor without mutating `Problem.runtime`. | FEM/FDM CPU/GPU authoring; planner resolves capability. | `problem_meta.runtime_metadata.runtime_selection.device` |
| `RuntimeSelection.resolved.backend` | `BackendTarget \| str \| None` | `None` | $1$ | Optional override coerced through `BackendTarget`. | Override solver backend target on a copy of `RuntimeSelection`. | FEM/FDM CPU/GPU; capability checks remain authoritative. | `backend_policy.requested_backend` |
| `RuntimeSelection.resolved.mode` | `ExecutionMode \| str \| None` | `None` | $1$ | Optional override coerced through `ExecutionMode`. | Override execution mode on a copy of `RuntimeSelection`. | FEM/FDM CPU/GPU; capability checks remain authoritative. | `validation_profile.execution_mode` |
| `RuntimeSelection.resolved.precision` | `ExecutionPrecision \| str \| None` | `None` | $1$ | Optional override coerced through `ExecutionPrecision`; checked against `fdm_precision_policy`. | Override floating-point precision on a copy of `RuntimeSelection`. | FEM/FDM CPU/GPU; capability checks remain authoritative. | `backend_policy.execution_precision` |

### Key helper methods

| Python | Meaning |
|---|---|
| `Problem.to_ir(*, requested_backend=None, execution_mode=None, execution_precision=None, script_source=None, source_root=None, entrypoint_kind="direct", asset_cache=None, include_geometry_assets=True, study_pipeline=None, runtime_device_override=None)` | Canonical lowering with explicit runtime intent, asset control, and script-source provenance |
| `RuntimeSelection.resolved(*, backend=None, mode=None, precision=None)` | Return a validated `RuntimeSelection` copy with explicit overrides applied |
| `RuntimeSelection.to_runtime_metadata()` | Serialize the runtime selection (including `fdm_precision_policy` and `parallel_execution`) into provenance metadata |

### Complete stage-first context

Round trip starts from the study scenario; the builder lowers it to `Problem` and then to `ProblemIR`.

```python
# %% Stage-first study and runtime-selection round-trip check
import fullmag as fm

nm = 1.0e-9

study = fm.study("round_trip_api_example")
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
study.stages.add_run(stage_id="run", until=1.0e-9)

# Inspect RuntimeSelection normalization and metadata serialization:
selection = fm.RuntimeSelection().engine("fdm").cpu().precision("double")
resolved_sel = selection.resolved(mode="strict")
meta = resolved_sel.to_runtime_metadata()
assert meta["backend"] == "fdm"
assert meta["execution_precision"] == "double"
```

(python-api-problem-round-trip-problem-ir)=
## ProblemIR
`Problem.to_ir()` builds the canonical request with resolved runtime metadata, optional cached
`geometry_assets`, materials, regions, `study_pipeline`, and `model_builder` / `script_sync`
manifests while preserving deterministic `source_hash` provenance whenever `script_source` is
provided.

(python-api-problem-round-trip-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Requested and resolved descriptors remain distinct. An FDM selection with FEM-only policy such as
`pbc.demag="periodic_airbox_k0"` or an inconsistent `fdm_precision_policy` vs `execution_precision`
fails lowering immediately rather than being silently converted.

(python-api-problem-round-trip-discrete-realization)=
## Discrete realization

| Solver | Device | Lowering & round-trip behavior | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Shared `Problem.to_ir()` lowering and `script_sync` manifest | Planner/runtime execution qualification is separate |
| FDM | GPU | Shared `Problem.to_ir()` lowering; `runtime_device_override` preserves requested GPU intent | CUDA capability checked by planner; no silent CPU fallback |
| FEM | CPU | Shared `Problem.to_ir()` lowering with optional embedded `geometry_assets` | Mesh build and native FEM solve qualified separately |
| FEM | GPU | Shared `Problem.to_ir()` lowering; preserves FEM GPU solver/preconditioner intent | Executed-device qualification remains separate |

(python-api-problem-round-trip-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/problem.py` (`Problem.to_ir`,
`RuntimeSelection.resolved`, `RuntimeSelection.to_runtime_metadata`).

(python-api-problem-round-trip-validation)=
## Validation
Authoring and graph round-trip tests exercise the same lowering as the public export.

(python-api-problem-round-trip-limitations)=
## Limitations
Exact serialized output shape may evolve with `IR_VERSION`; consumers must read the version field
instead of assuming a frozen layout. Internal kwargs (`_copy_cached_geometry_assets`,
`_accepted_preparation`) are reserved for the repository loader and are not part of the public
script contract.

(python-api-problem-round-trip-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Control Room authors a study in the workspace and lowers it to `ProblemIR`; direct `Problem`/`ProblemIR` editing remains Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `No standalone Control Room route` | `Python-only` | Authored in Python |
| Parameters without a named UI field | `No standalone Control Room route` | `Python-only` | Authored in Python |

Standalone `Problem` and `ProblemIR` authoring remains Python-only.
See [Control Room capability register](/frontend/capability-register) for the UI support matrix.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx` (`StudyInspectorPanel`).

(python-api-problem-round-trip-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Canonical problem lowering entrypoint | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | Canonical lowering and `Problem.to_ir` | Round-trip tests |
| Requested runtime descriptor normalization | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | [`class RuntimeSelection`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L1907) | Requested-vs-resolved runtime descriptors (`RuntimeSelection.resolved`) | Ownership and API contract tests |
