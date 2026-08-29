---
title: Mechanical Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-boundary-conditions-mechanical-boundary-conditions)=
# Mechanical Boundary Conditions

(python-api-boundary-conditions-mechanical-boundary-conditions-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Mechanical boundary conditions prescribe displacement or traction on surfaces for
magnetoelastic bodies.

(python-api-boundary-conditions-mechanical-boundary-conditions-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Mechanics equations belong to {doc}`../../physics/interactions/magnetoelastic/index`.

(python-api-boundary-conditions-mechanical-boundary-conditions-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Prescribed displacement is in metres; prescribed traction is in pascals.

(python-api-boundary-conditions-mechanical-boundary-conditions-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Keyword-required vectors are validated; the surface name must be non-empty.

(python-api-boundary-conditions-mechanical-boundary-conditions-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `MechanicalBoundaryCondition.kind` | `str` | `required` | $1$ | `traction_free`, `clamped`, `prescribed_displacement`, `prescribed_traction` | BC type | `kind` |
| `MechanicalBoundaryCondition.surface` | `str` | `required` | $1$ | Non-empty | Boundary surface | `surface` |
| `MechanicalBoundaryCondition.u` | `tuple \| None` | `None` | $\mathrm{m}$ | Required for displacement | Displacement vector | `u` |
| `MechanicalBoundaryCondition.t` | `tuple \| None` | `None` | $\mathrm{Pa}$ | Required for traction | Traction vector | `t` |

### Complete stage-first context

Mechanical boundary conditions are mechanical models attached to elastic bodies; the stage-first
study declares them through the problem model.

```python
# %% Clamped mechanical boundary condition
import fullmag as fm

study = fm.study("mechanical_bc_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

nm = 1.0e-9

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

bc = fm.MechanicalBoundaryCondition(kind="clamped", surface="bottom")
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-boundary-conditions-mechanical-boundary-conditions-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`MechanicalBoundaryCondition.to_ir()` emits `kind`, `surface`, and optional `u`/`t`.

(python-api-boundary-conditions-mechanical-boundary-conditions-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Unknown kinds and missing required vectors fail immediately.

(python-api-boundary-conditions-mechanical-boundary-conditions-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Mechanical BCs are applied by the mechanics solver assembly on the named surfaces.

(python-api-boundary-conditions-mechanical-boundary-conditions-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/mechanics.py`
(`class MechanicalBoundaryCondition`).

(python-api-boundary-conditions-mechanical-boundary-conditions-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-boundary-conditions-mechanical-boundary-conditions-limitations)=
<!-- (limitations)= -->
## Limitations
The model object is public; wiring into the stage builder may lag the model surface.

(python-api-boundary-conditions-mechanical-boundary-conditions-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Mechanics references belong to the magnetoelastic page.

(python-api-boundary-conditions-mechanical-boundary-conditions-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: No complete authoring route is established for this API surface.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> <stage> -> Boundary` | `TODO` | No supported frontend transaction |
| Parameters without a named UI field | `Model Explorer -> Stages -> <stage> -> Boundary` | `TODO` | Python-only until implemented |

TODO: frontend support for this boundary-condition API and its parameters.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/StudyStageDraftEditor.tsx (StudyStageDraftEditor)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Mechanical BC | `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MechanicalBoundaryCondition` | BC lowering | Ownership test |
