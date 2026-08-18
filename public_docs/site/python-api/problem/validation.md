---
title: Validation
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-validation)=
# Validation

(python-api-problem-validation-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Validation is the fail-closed set of authoring, lowering, capability, and backend-legality checks
between the Python surface and execution.

(python-api-problem-validation-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This page introduces no governing equation.

(python-api-problem-validation-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Parameter units follow their owning pages; validation checks domain and finite-ness, not unit
conversion.

(python-api-problem-validation-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Mathematical validation cannot replace capability resolution; a structurally valid problem may
still be rejected when its requested lane cannot execute it.

(python-api-problem-validation-python-api)=
<!-- (python-api)= -->
## Python API
| Check stage | Rejects |
|---|---|
| Constructor validation | Malformed, non-finite, or out-of-domain parameter values |
| Lowering validation | Inconsistent runtime policies and FEM/FDM-specific authoring mistakes |
| Planner capability checks | Unsupported combinations without a silent fallback |
| Backend legality | Unavailable outputs, devices, or precisions |

### Complete stage-first context

Validation runs through the same study scenario as every other page; a rejected combination is
reported by the planner rather than rewritten.

(python-api-problem-validation-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
Lowering preserves the validated authored request; the planner resolves requested execution and
records capability decisions.

(python-api-problem-validation-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Each rejection carries the failing constraint; nothing is silently converted to another
interaction, backend, device, or precision.

(python-api-problem-validation-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Validation spans the Python constructors, `Problem.to_ir`, and the planner capability contract.

(python-api-problem-validation-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/problem.py` (`class Problem`) plus
`packages/fullmag-py/src/fullmag/_validation.py` for shared checks.

(python-api-problem-validation-validation)=
<!-- (validation)= -->
## Validation
Validation behavior itself is covered by rejection-focused tests.

(python-api-problem-validation-limitations)=
<!-- (limitations)= -->
## Limitations
Validation does not replace executed-device qualification; source presence and skipped tests are
not parity proof.

(python-api-problem-validation-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced.

(python-api-problem-validation-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Problem validation | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Authoring/lowering validation | Validation tests |
| Shared checks | `packages/fullmag-py/src/fullmag/_validation.py` | `require_non_empty`, `require_positive` | Reusable domain checks | Unit tests |
