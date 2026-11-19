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
## Contract
Validation is the fail-closed set of authoring, lowering, capability, and backend-legality checks
between the Python surface and execution.

(python-api-problem-validation-governing-equations)=
## Governing equations
This page introduces no governing equation.

(python-api-problem-validation-symbols-and-si-units)=
## Symbols and SI units
Parameter units follow their owning pages; validation checks dimensionless status flags ($1$),
domain bounds, and finiteness rather than performing unit conversion.

(python-api-problem-validation-assumptions-and-validity)=
## Assumptions and validity
Mathematical validation cannot replace capability resolution; a structurally valid problem may
still be rejected when its requested lane cannot execute it.

(python-api-problem-validation-python-api)=
## Python API
| Check stage | Rejects |
|---|---|
| Constructor validation | Malformed, non-finite, or out-of-domain parameter values |
| Lowering validation | Inconsistent runtime policies and FEM/FDM-specific authoring mistakes |
| Planner capability checks | Unsupported combinations without a silent fallback |
| Backend legality | Unavailable outputs, devices, or precisions |

### Complete stage-first context

```python
# %% Validation/provenance stage-first probe
import fullmag as fm

study = fm.study("api_contract_probe")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
body = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_run(stage_id="probe", until=1.0e-12)
```


Validation runs through the same study scenario as every other page; a rejected combination is
reported by the planner rather than rewritten.

(python-api-problem-validation-problem-ir)=
## ProblemIR
Lowering preserves the validated authored request; the planner resolves requested execution and
records capability decisions.

(python-api-problem-validation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Each rejection carries the failing constraint; nothing is silently converted to another
interaction, backend, device, or precision.

(python-api-problem-validation-discrete-realization)=
## Discrete realization
Validation spans the Python constructors, `Problem.to_ir`, and the planner capability contract.

(python-api-problem-validation-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/problem.py` (`class Problem`) plus
`packages/fullmag-py/src/fullmag/_validation.py` for shared checks.

(python-api-problem-validation-validation)=
## Validation
Validation behavior itself is covered by rejection-focused tests.

(python-api-problem-validation-limitations)=
## Limitations
Validation does not replace executed-device qualification; source presence and skipped tests are
not parity proof.

(python-api-problem-validation-scientific-bibliography)=
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

(python-api-problem-validation-source-code-index)=
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Problem validation | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L2601) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/5e99782acbb7fb3f65d0cad872e102bf67733103/packages/fullmag-py/src/fullmag/model/problem.py#L2601) | Authoring/lowering validation | Validation tests |
| Shared checks | `packages/fullmag-py/src/fullmag/_validation.py` | `require_non_empty`, `require_positive` | Reusable domain checks | Unit tests |
