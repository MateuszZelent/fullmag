---
title: Validation
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-problem-validation)=
# Validation

(python-api-problem-validation-problem-statement)=
## Contract
Validation is the fail-closed set of authoring, lowering, capability, and backend-legality checks
between the Python surface and execution. Structured authoring errors raise `TypedValidationError`
(a `ValueError` subclass carrying a machine-readable `code`, JSON-pointer-like `pointer`, and
offending `value`) or domain-specific exceptions such as `IncompletePhysicsError`.

(python-api-problem-validation-governing-equations)=
## Governing equations
This page introduces no governing equation.

(python-api-problem-validation-symbols-and-si-units)=
## Symbols and SI units
Parameter units follow their owning pages; validation checks dimensionless status flags ($1$),
domain bounds, and finiteness rather than performing implicit unit conversion.

(python-api-problem-validation-assumptions-and-validity)=
## Assumptions and validity
Mathematical validation cannot replace capability resolution; a structurally valid problem may
still be rejected when its requested lane cannot execute it.

(python-api-problem-validation-python-api)=
## Python API

### Validation stages

| Check stage | Rejects |
|---|---|
| Constructor validation | Malformed, non-finite, or out-of-domain parameter values (`ValueError` / `TypedValidationError`) |
| Lowering validation | Missing required physics (`IncompletePhysicsError`), inconsistent runtime policies, and FEM/FDM-specific authoring mistakes |
| Planner capability checks | Unsupported combinations without a silent fallback |
| Backend legality | Unavailable outputs, devices, or precisions |

### Structured validation types and shared helpers

| Symbol | Source | Contract |
| --- | --- | --- |
| `TypedValidationError(*, code, pointer, message, value=None)` | `packages/fullmag-py/src/fullmag/_validation.py` | Subclass of `ValueError` storing `code: str`, `pointer: str`, and `value: Any`; formats as `"{code} at {pointer}: {message}"` |
| `IncompletePhysicsError` | `packages/fullmag-py/src/fullmag/model/problem.py` | Raised when a problem omits required magnets or active energy/material anisotropy terms |
| `require_non_empty`, `require_positive`, `require_non_negative`, `require_finite`, `require_positive_int` | `packages/fullmag-py/src/fullmag/_validation.py` | Fail-closed scalar and string validators rejecting booleans, NaNs, infinities, and out-of-range values |
| `parse_finite_float`, `parse_integer`, `parse_bool`, `parse_vector3`, `as_vector3` | `packages/fullmag-py/src/fullmag/_validation.py` | Typed parsers emitting `TypedValidationError` (for `parse_*`) or `ValueError` (for `as_vector3`) on malformed authoring inputs |
| `ensure_unique_names`, `normalize_sampling_period`, `infer_geometry_format` | `packages/fullmag-py/src/fullmag/_validation.py` | Shared identity-uniqueness, output-cadence, and asset-format normalizers |

### Complete stage-first validation example

```python
# %% Stage-first authoring plus fail-closed validation checks
import fullmag as fm
from fullmag._validation import TypedValidationError, parse_finite_float

study = fm.study("api_contract_probe")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 2e-9))
body = study.geometry(fm.Box(40e-9, 20e-9, 4e-9), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_run(stage_id="probe", until=1.0e-12)

# Structured pointer-preserving validation failure:
try:
    parse_finite_float(float("nan"), pointer="/materials/0/Ms")
except TypedValidationError as exc:
    assert exc.code == "numeric_nonfinite"
    assert exc.pointer == "/materials/0/Ms"

# Fail-closed domain rejection on invalid physical constants:
try:
    fm.Material(name="invalid", Ms=-1.0, A=13.0e-12, alpha=0.02)
except ValueError as exc:
    assert "Ms" in str(exc)
```

Validation runs through the same study scenario as every other page; a rejected combination is
reported explicitly by the constructor, lowerer, or planner rather than silently rewritten.

(python-api-problem-validation-problem-ir)=
## ProblemIR
Lowering preserves the validated authored request; the planner resolves requested execution and
records capability decisions.

(python-api-problem-validation-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule (and for `TypedValidationError`, the exact field `pointer` and `code`), and unsupported combinations are rejected explicitly rather than silently substituted.

Each rejection carries the failing constraint; nothing is silently converted to another
interaction, backend, device, or precision.

(python-api-problem-validation-discrete-realization)=
## Discrete realization

| Solver | Device | Validation boundary | Qualification note |
| --- | --- | --- | --- |
| FDM | CPU | Python construction + `Problem.to_ir()` + Rust planner grid/interaction capability checks | Passing validation is necessary but not sufficient for convergence |
| FDM | GPU | Python construction + Rust planner CUDA capability gate (no silent CPU fallback in `strict` mode) | Device execution requires separate GPU runtime qualification |
| FEM | CPU | Python construction + Rust planner mesh/BC/operator legality checks | Conforming mesh quality verified separately |
| FEM | GPU | Python construction + Rust planner CUDA/cuDSS capability gate | Source presence and validation pass do not replace GPU parity runs |

(python-api-problem-validation-implementation-mapping)=
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/problem.py` (`class Problem`) and
`packages/fullmag-py/src/fullmag/_validation.py` (`class TypedValidationError` and shared checks).

(python-api-problem-validation-validation)=
## Validation
Validation behavior itself is covered by rejection-focused unit and planner-capability tests.

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
| Problem validation | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | [`class Problem`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L2733) | Authoring/lowering validation | Validation tests |
| Typed validation errors | [`packages/fullmag-py/src/fullmag/_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L13) | [`class TypedValidationError`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L13) | Pointer-carrying validation exceptions and shared domain checks | Unit tests |
