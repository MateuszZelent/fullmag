---
title: Problem IR
status: implemented
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

Public examples do not construct `fm.Problem(...)` directly. Lowering is inspected through the
individual object-level `to_ir()` fragments that the builder composes; the complete problem-level
lowering remains the canonical `Problem.to_ir()` contract.

```python
# %% Complete stage-first study plus object-level lowering fragments
import fullmag as fm

nm = 1.0e-9

study = fm.study("ir_inspection_study")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 50 * nm, 10 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_run(stage_id="run", until=1.0e-12)

# Object-level lowering fragments used by the canonical ProblemIR build:
geometry_ir = fm.Box(100 * nm, 50 * nm, 10 * nm).to_ir()
state_ir = fm.init.UniformMagnetization((1.0, 0.0, 0.0)).to_ir()
assert geometry_ir["kind"] == "box"
assert state_ir["kind"] == "uniform"
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

## Control Room crosswalk

Status: The Control Room authors a study and lowers it to ProblemIR; direct Problem/IR editing is not exposed.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `No standalone Control Room route` | `TODO` | No supported frontend transaction |
| Parameters without a named UI field | `No standalone Control Room route` | `TODO` | Python-only until implemented |

TODO: frontend support for standalone Problem/ProblemIR authoring.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyInspectorPanel.tsx (StudyInspectorPanel)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Constructor, validation, lowering | `packages/fullmag-py/src/fullmag/model/problem.py` | `class Problem` | Canonical Python API behavior | Ownership test and source-map validator |
