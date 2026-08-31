---
title: Runtime Selection
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-runtime-selection)=
# Runtime Selection

(python-api-runtime-runtime-selection-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Runtime selection declares the requested backend, device, precision, and execution policy before
stages are authored. Requested selection is preserved separately from resolved execution.

(python-api-runtime-runtime-selection-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This page introduces no physical equation; it owns the runtime descriptor and its lowering.

(python-api-runtime-runtime-selection-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All fields are identifiers or counts; no physical units are owned here.

(python-api-runtime-runtime-selection-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Selection values are validated immediately. The planner resolves the final backend/device lane and
fails capability checks when the request cannot be satisfied.

(python-api-runtime-runtime-selection-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| --- | --- | --- | $1$ | --- | --- | --- | --- |
| `study.engine(backend)` | `str` | `"auto"` | $1$ | One of `auto`, `fdm`, `fem`, `hybrid` | Requested backend target | planner-resolved | `runtime.backend_target` |
| `study.device(spec, precision=...)` | `str` | `"auto"` | $1$ | `cpu`, `cuda[:i]`, `gpu`, or a known device id | Requested device target and optional precision | planner-resolved | `runtime.device_target`, `runtime.execution_precision` |
| `study.mode(execution_mode)` | `str` | `"strict"` | $1$ | `strict`, `extended`, or `hybrid` | Execution policy | planner-resolved | `runtime.execution_mode` |
| `study.threads(cpu_threads)` | `int` | not set | $1$ | `>= 1` | Requested CPU thread count | CPU lanes | `runtime.cpu_threads` |
| `RuntimeSelection.gpu_count` | `int` | `0` | $1$ | `0` or `1`; `> 1` rejected as unimplemented | Requested GPU count | CUDA lanes | `runtime.gpu_count` |
| `RuntimeSelection.device_index` | `int \| None` | `None` | $1$ | Requires `cuda`/`gpu` | Device ordinal | CUDA lanes | `runtime.device_index` |

### Complete stage-first example

```python
# %% Runtime selection before authoring
import fullmag as fm

nm = 1.0e-9

study = fm.study("runtime_selection_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.threads(4)

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-9)
```

(python-api-runtime-runtime-selection-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The runtime descriptor lowers into the `runtime` block carrying `backend_target`,
`device_target`, `gpu_count`, `device_index`, `cpu_threads`, `execution_mode`, and
`execution_precision`.

(python-api-runtime-runtime-selection-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Requested intent is preserved verbatim. Resolved execution is the planner's capability result and
must be recorded separately in provenance. Invalid values fail immediately; unsatisfiable lanes
fail capability checks without silent fallback.

(python-api-runtime-runtime-selection-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only.

(python-api-runtime-runtime-selection-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`class RuntimeSelection`) and the
module-level selection functions in `packages/fullmag-py/src/fullmag/world.py`.

(python-api-runtime-runtime-selection-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures and validate the adjacent source map.

(python-api-runtime-runtime-selection-limitations)=
<!-- (limitations)= -->
## Limitations
Multi-GPU (`gpu_count > 1`) is rejected as unimplemented. GPU source presence and compilation do
not replace executed-device qualification.

(python-api-runtime-runtime-selection-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-runtime-selection-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Runtime and provenance data are inspection-only; they are not standalone authoring controls.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Runtime` | `inspection-only` | No runtime-authoring transaction |
| Parameters without a named UI field | `Model Explorer -> Runtime` | `not implemented` | Python-only until implemented |

not implemented: frontend support for runtime-selection and artifact-publication parameters.
See [Control Room capability register](/frontend/capability-register) for the support matrix and not implemented policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx (RuntimeExplorerInspectorPanels)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Runtime descriptor | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Canonical runtime selection | Ownership test |
| Selection helpers | `packages/fullmag-py/src/fullmag/world.py` | `engine`, `device`, `mode`, `threads` | Study-builder selection surface | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Runtime selection state, validation, and resolution. | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Runtime selection state, validation, and resolution. | Source-map validator and focused API tests |
