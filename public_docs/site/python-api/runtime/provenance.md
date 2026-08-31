---
title: Provenance
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-runtime-provenance)=
# Provenance

(python-api-runtime-provenance-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Provenance keeps requested intent separate from resolved execution. A result records the requested
backend/mode/precision together with the actual run status and artifact directory.

(python-api-runtime-provenance-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
No physical equation is owned here.

(python-api-runtime-provenance-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
All fields are identifiers or status strings.

(python-api-runtime-provenance-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Requested and resolved values are normalized but never conflated; a `planned` result is distinct
from a `completed` one.

(python-api-runtime-provenance-python-api)=
<!-- (python-api)= -->
## Python API

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `RuntimeSelection.backend_target` | `BackendTarget` | `auto` | $1$ | Enum value; normalized by runtime selection. | Requested backend family. | FEM/FDM CPU/GPU; planner resolves capability. | `backend_policy.requested_backend` |
| `RuntimeSelection.execution_mode` | `ExecutionMode` | `strict` | $1$ | Enum value; normalized by runtime selection. | Requested execution mode. | FEM/FDM CPU/GPU; planner resolves capability. | `backend_policy.execution_mode` |
| `Result.status` | `str` | required | $1$ | One of `completed`, `planned`, or `not-executable`. | Resolved execution outcome. | FEM/FDM CPU/GPU runtime record. | `runtime.status` |
| Record | Meaning |
|---|---|
| requested backend/mode/precision | What the script asked for |
| resolved backend/mode/precision | What the planner selected after capability checks |
| `Result.status` | `completed`, `planned`, or `not-executable` |
| `Result.output_dir` | Directory of the produced artifacts |

### Complete stage-first context

```python
# %% Validation/provenance stage-first probe
import fullmag as fm

study = fm.study("api_contract_probe")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.stages.add_run(stage_id="probe", until=1.0e-12)
```


Provenance is attached to the study the script authored; the resolved record is read from the
executed `Result` (see {doc}`../runtime/results`).

(python-api-runtime-provenance-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Lowering preserves the requested descriptors (`requested_backend`, `execution_mode`,
`execution_precision`); resolved execution is runtime output.

(python-api-runtime-provenance-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in ProblemIR; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

A capability failure must state the unsatisfied combination; it never silently substitutes another
backend, device, precision, or physics term.

(python-api-runtime-provenance-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Planner resolution and runner status are the authoritative provenance sources.

(python-api-runtime-provenance-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`RuntimeSelection`) and
`packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Result`).

(python-api-runtime-provenance-validation)=
<!-- (validation)= -->
## Validation
Capability and round-trip tests require requested/resolved separation to remain observable.

(python-api-runtime-provenance-limitations)=
<!-- (limitations)= -->
## Limitations
Provenance records resolution; it does not by itself prove that a GPU lane executed on a current
device.

(python-api-runtime-provenance-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-provenance-source-code-index)=
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
| Requested selection | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Requested descriptors | Ownership test |
| Resolved result | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Result` | Resolved status | Ownership test |

### Source-map coverage

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Requested runtime descriptors and provenance metadata. | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Requested runtime descriptors and provenance metadata. | Source-map validator and focused API tests |
| Resolved execution result and status. | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Result` | Resolved execution result and status. | Source-map validator and focused API tests |
