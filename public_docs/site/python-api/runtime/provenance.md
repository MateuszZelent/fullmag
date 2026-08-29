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
| Record | Meaning |
|---|---|
| requested backend/mode/precision | What the script asked for |
| resolved backend/mode/precision | What the planner selected after capability checks |
| `Result.status` | `completed`, `planned`, or `not-executable` |
| `Result.output_dir` | Directory of the produced artifacts |

### Complete stage-first context

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
| Parameters without a named UI field | `Model Explorer -> Runtime` | `TODO` | Python-only until implemented |

TODO: frontend support for runtime-selection and artifact-publication parameters.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/RuntimeExplorerInspectorPanels.tsx (RuntimeExplorerInspectorPanels)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Requested selection | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Requested descriptors | Ownership test |
| Resolved result | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Result` | Resolved status | Ownership test |
