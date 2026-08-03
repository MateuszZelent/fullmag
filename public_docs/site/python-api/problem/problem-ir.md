---
title: Problem IR
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-problem-ir)=
# Problem IR

(python-api-problem-problem-ir-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the current public Python authoring contract and canonical lowering; it does not redefine solver physics.

(python-api-problem-problem-ir-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
This API page introduces no independent governing equation. Physical equations belong to interaction and solver-lane pages.

(python-api-problem-problem-ir-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Every owned input has its SI unit below; $1$ denotes dimensionless data.

(python-api-problem-problem-ir-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Constructor checks run immediately. Lowering and planning additionally check mesh cardinality, capability, and backend legality.

(python-api-problem-problem-ir-python-api)=
<!-- (python-api)= -->
## Python API
No constructor parameters are owned by this conceptual page.

### Authoring-to-IR inspection

```python
# %% Inspect the canonical IR produced by a loaded Problem
import fullmag as fm

loaded = fm.load_problem_from_script("examples/mumax_standard_problem_5_fdm.py")
problem_ir = loaded.stages[0].problem.to_ir()
assert problem_ir["magnets"]
```


(python-api-problem-problem-ir-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The final column gives the serialized destination owned by the current lowering implementation.

(python-api-problem-problem-ir-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Requested intent is preserved in Python and IR. Resolved execution is selected by the planner. Validation errors reject malformed values; unsupported combinations fail capability checks without silent fallback.

(python-api-problem-problem-ir-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
This page owns authoring and lowering only; numerical realization belongs to solver-lane documentation.

(python-api-problem-problem-ir-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
The adjacent map anchors claims to `packages/fullmag-py/src/fullmag/model/problem.py` and `class Problem`.

(python-api-problem-problem-ir-validation)=
<!-- (validation)= -->
## Validation
Tests compare this inventory with live signatures and validate its source map.

(python-api-problem-problem-ir-limitations)=
<!-- (limitations)= -->
## Limitations
Representability does not prove every backend combination executable; planner capabilities are authoritative.

(python-api-problem-problem-ir-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
No physical model is introduced. Primary references belong to consuming interaction pages.

(python-api-problem-problem-ir-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Canonical Python API behavior | Ownership test and source-map validator |
