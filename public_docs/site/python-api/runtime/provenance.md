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
Fullmag has two distinct result surfaces. The lightweight Python `Result` records one
backend/mode/precision tuple copied from `Simulation` plus status, notes, steps, and `output_dir`;
it does not contain separate requested and resolved fields. The session-scoped v2 current-run
resource is the authoritative surface that keeps requested intent separate from resolved
execution.

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
Requested and resolved values are separate in the v2 current-run resource. Do not infer that split
from the lightweight Python `Result`, whose single tuple is the `Simulation` selection. A
`planned` lightweight result is distinct from a `completed` one.

(python-api-runtime-provenance-python-api)=
<!-- (python-api)= -->
## Python API
| Surface | Record | Meaning |
|---|---|---|
| Python `Result` | `backend`, `mode`, `precision` | Selection carried by `Simulation`; not a requested/resolved pair |
| Python `Result` | `status`, `notes`, `output_dir` | Lightweight run outcome and local artifact-directory reference |
| `GET /v2/sessions/current/simulation/runs/current` | `requested_backend/device/precision/mode` | Requested execution identity |
| Same v2 resource | `resolved_backend/device/precision/mode` plus runtime family/engine/worker/fallback | Resolved execution identity and fallback provenance |

### Complete stage-first context

For lightweight direct execution, inspect {doc}`../runtime/results` with the limitation above. For
the control-room/session runtime, read the v2 current-run resource; HTTP v2 is authoritative and
realtime events only invalidate cached resources.

(python-api-runtime-provenance-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Lowering preserves requested backend and precision in `backend_policy`, execution mode in
`validation_profile`, and the full requested runtime descriptor in
`problem_meta.runtime_metadata.runtime_selection`. Resolved execution is session/runtime output,
not a field injected into ProblemIR by `Simulation.to_ir()`.

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
Anchors: `packages/fullmag-py/src/fullmag/model/problem.py` (`RuntimeSelection`),
`packages/fullmag-py/src/fullmag/runtime/simulation.py` (`class Result`), and
`crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs` (`CurrentRunResource` handler).

(python-api-runtime-provenance-validation)=
<!-- (validation)= -->
## Validation
Python tests cover `Simulation` lowering and lightweight results. Router tests cover the v2
current-run requested/resolved fields.

(python-api-runtime-provenance-limitations)=
<!-- (limitations)= -->
## Limitations
The lightweight Python `Result` is not sufficient evidence of resolved execution. The v2
current-run resource records resolution, but a resolved identity alone still does not prove that a
GPU kernel executed; runtime diagnostics and qualified artifacts provide that evidence.

(python-api-runtime-provenance-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-runtime-provenance-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Requested selection | `packages/fullmag-py/src/fullmag/model/problem.py` | `class RuntimeSelection` | Requested descriptors | Ownership test |
| Lightweight result | `packages/fullmag-py/src/fullmag/runtime/simulation.py` | `class Result` | Single selected tuple and local outcome | Python tests |
| Session requested/resolved record | `crates/fullmag-api/src/router_v2/handlers/simulation/runtime.rs` | `get_current_run` | Canonical v2 run provenance | Router tests |
