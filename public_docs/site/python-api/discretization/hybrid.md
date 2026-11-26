---
title: Hybrid
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-discretization-hybrid)=
# Hybrid

(python-api-discretization-hybrid-problem-statement)=
## Contract
Hybrid discretization pairs FDM and FEM domains in one problem via `DiscretizationHints`.

(python-api-discretization-hybrid-governing-equations)=
## Governing equations
No physical equation is introduced; hybrid is a discretization-selection policy.

(python-api-discretization-hybrid-symbols-and-si-units)=
## Symbols and SI units
All fields are policy identifiers.

(python-api-discretization-hybrid-assumptions-and-validity)=
## Assumptions and validity
The hybrid demag selector must be non-empty; hybrid backend and mode must be selected together.

(python-api-discretization-hybrid-python-api)=
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `Hybrid.demag` | `str` | `required` | $1$ | Non-empty | Hybrid demag strategy | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `demag` |
| `DiscretizationHints.fdm` | `FDM \| None` | `None` | $1$ | `FDM` instance or `None` | FDM-lane discretization hints | FDM CPU/GPU; FEM lanes are not applicable | `discretization_hints.fdm` |
| `DiscretizationHints.fem` | `FEM \| None` | `None` | $1$ | `FEM` instance or `None` | FEM-lane discretization hints | FEM CPU/GPU; FDM lanes are not applicable | `discretization_hints.fem` |
| `DiscretizationHints.hybrid` | `Hybrid \| None` | `None` | $1$ | `Hybrid` instance or `None` | Mixed-lane discretization hints | FEM/FDM CPU/GPU; planner and runtime capability checks remain authoritative | `discretization_hints.hybrid` |

### Complete stage-first context

Hybrid problems select both backend families; the planner enforces the hybrid mode coupling.

```python
# %% Hybrid discretization hints
import fullmag as fm

study = fm.study("hybrid_discretization_api_example")
study.engine("hybrid")
study.device("auto", precision="double")
study.mode("hybrid")

nm = 1.0e-9
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

hints = fm.DiscretizationHints(hybrid=fm.Hybrid(demag="open"))
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-discretization-hybrid-problem-ir)=
## ProblemIR
`DiscretizationHints.to_ir()` emits `fdm`, `fem`, and `hybrid` blocks; only the selected lanes are
non-null.

(python-api-discretization-hybrid-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the value authored by Python and preserved in `ProblemIR`; resolved execution is the planner or realization result. Validation errors identify the violated domain rule, and unsupported combinations are rejected explicitly rather than silently substituted.

Empty hybrid demag and hybrid/non-hybrid mismatch fail immediately.

(python-api-discretization-hybrid-discrete-realization)=
## Discrete realization
The planner resolves the FDM/FEM boundary and reports the derived discretization provenance.

(python-api-discretization-hybrid-implementation-mapping)=
## Implementation mapping
Implemented in `packages/fullmag-py/src/fullmag/model/discretization.py` (`Hybrid`,
`DiscretizationHints`).

(python-api-discretization-hybrid-validation)=
## Validation
Contract tests compare this inventory with live `Hybrid` and `DiscretizationHints` signatures.

(python-api-discretization-hybrid-limitations)=
## Limitations
Hybrid execution support is planner-resolved; the policy does not by itself prove executability.

(python-api-discretization-hybrid-scientific-bibliography)=
## Scientific bibliography
No physical model is introduced.

## Control Room support

Status: Advertised global/object mesh controls are partial; compatibility-only fields remain Python-only.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Study or Objects -> <object> -> Mesh` | `partial` | Apply mesh policy or Build Mesh; mesh resources become stale |
| Parameters without a dedicated UI field | `Model Explorer -> Study or Objects -> <object> -> Mesh` | `Python-only` | Authored in Python scripts |

Discretization parameters not represented in the mesh panels are configured in Python scripts.
See the [Control Room capability register](/frontend/capability-register) for UI coverage details.
Frontend component: `apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx` (`MeshRootInspectorSpecPanel`).

(python-api-discretization-hybrid-source-code-index)=
## Source-code index

| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Hybrid discretization policy validation and lowering. | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L551) | [`class Hybrid`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L551) | Hybrid discretization policy validation and lowering. | Signature and IR lowering tests |
| Composite discretization-hint ownership and lowering. | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L566) | [`class DiscretizationHints`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py#L566) | Composite discretization-hint ownership and lowering. | Signature and IR lowering tests |
