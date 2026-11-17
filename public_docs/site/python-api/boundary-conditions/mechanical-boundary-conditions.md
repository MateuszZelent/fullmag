---
title: Mechanical Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Mechanical boundary conditions and loads

(public-docs-python-api-boundary-conditions-mechanical-boundary-conditions)=
(python-api-boundary-conditions-mechanical-boundary-conditions-problem-statement)=
## Problem statement

Mechanical authoring makes boundary kind and required payload explicit.

Construction validates typed authoring data in Python; calling `to_ir()` lowers each object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-boundary-conditions-mechanical-boundary-conditions-governing-equations)=
## Governing equations

`MechanicalBoundaryCondition` specifies boundary displacement ($\mathbf{u}(\mathbf{x}) = \bar{\mathbf{u}}$ on a Dirichlet surface) or surface traction ($\boldsymbol{\sigma}\mathbf{n} = \bar{\mathbf{t}}$ on a Neumann surface) for continuum elastostatics and magnetoelasticity. `MechanicalLoad` specifies volumetric body force ($\mathbf{f}$), prescribed strain, or prescribed stress in six-component engineering-Voigt order: $\boldsymbol{\varepsilon}^{\mathrm{eng}} = (\varepsilon_{11}, \varepsilon_{22}, \varepsilon_{33}, \gamma_{23}, \gamma_{13}, \gamma_{12})$ with $\gamma_{ij} = 2\varepsilon_{ij}$. See {doc}`../../physics/interactions/magnetoelastic/index` and {doc}`../../physics/foundations/boundary-conditions` for the governing formulations and the currently executable prescribed-strain subset.

(python-api-boundary-conditions-mechanical-boundary-conditions-symbols-and-si-units)=
## Symbols and SI units

Displacements $\mathbf{u}$ use SI metres ($\mathrm{m}$); surface tractions $\bar{\mathbf{t}}$ and stresses $\boldsymbol{\sigma}$ use pascals ($\mathrm{Pa} = \mathrm{N\,m^{-2}}$); volumetric body forces $\mathbf{f}$ use $\mathrm{N\,m^{-3}}$; strains $\varepsilon_{ij}, \gamma_{ij}$, boundary selectors, and kind identifiers are dimensionless ($1$).

(python-api-boundary-conditions-mechanical-boundary-conditions-assumptions-and-validity)=
## Assumptions and validity

All numeric entries must be finite and typed, and strains or stresses supplied to `MechanicalLoad` must contain six Voigt components. Contradictory kind/payload combinations fail during construction or lowering rather than being silently converted.

(python-api-boundary-conditions-mechanical-boundary-conditions-python-api)=
## Python API

### Constructor or function

`fm.MechanicalBoundaryCondition(...)` and `fm.MechanicalLoad(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `MechanicalBoundaryCondition.kind` | `Literal[str]` | `required` | $1$ | `prescribed_displacement` or `prescribed_traction` | boundary data family | FEM CPU/GPU: IR; FDM not currently resolved | `kind` |
| `MechanicalBoundaryCondition.surface` | `str` | `required` | $1$ | non-empty | surface selector | FEM CPU/GPU: IR; FDM not currently resolved | `surface` |
| `MechanicalBoundaryCondition.u` | `tuple[float,float,float]` | `None` | $\mathrm{m}$ | required for displacement; finite | displacement vector | FEM CPU/GPU: IR; FDM not currently resolved | `u` |
| `MechanicalBoundaryCondition.t` | `tuple[float,float,float]` | `None` | $\mathrm{Pa}$ | required for traction; finite | traction vector | FEM CPU/GPU: IR; FDM not currently resolved | `t` |
| `MechanicalLoad.kind` | `Literal[str]` | `required` | $1$ | `body_force`, `prescribed_strain`, or `prescribed_stress` | volume load family | FEM CPU/GPU: IR; FDM not currently resolved | `kind` |
| `MechanicalLoad.f/strain/stress` | `tuple[float,...]` | `None` | $\mathrm{N\,m^{-3}}$, $1$, or $\mathrm{Pa}$ | payload required by kind; strain/stress six Voigt values | body force, strain, or stress | FEM CPU/GPU: IR; FDM not currently resolved | `payload` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)
# Author the documented object after the stage exists.
value = fm.MechanicalBoundaryCondition("prescribed_displacement", "clamp", u=(0.0, 0.0, 0.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, attach `canonical_ir` through the corresponding study or module registration interface.

(python-api-boundary-conditions-mechanical-boundary-conditions-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary keyed by `"kind"`: `MechanicalBoundaryCondition` produces `"prescribed_displacement"` (with `"surface"` and `"u"`) or `"prescribed_traction"` (with `"surface"` and `"t"`), while `MechanicalLoad` produces `"body_force"`, `"prescribed_strain"`, or `"prescribed_stress"` with its corresponding payload field. The IR stores requested intent independently of backend resolution.

(python-api-boundary-conditions-mechanical-boundary-conditions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required payloads, non-finite vectors, and malformed Voigt lengths before planning, while `unsupported combinations` fail closed at the planner or backend boundary without silent conversion.

(python-api-boundary-conditions-mechanical-boundary-conditions-discrete-realization)=
## Discrete realization

The Python authoring contract supplies boundary/load inputs and canonical `ProblemIR` only; discrete element operators, quadrature, and solver support are owned by the FEM/FDM backend lanes documented in {doc}`../../physics/interactions/magnetoelastic/index`. Currently, executable FEM magnetoelastic runs support the prescribed-strain subset, whereas displacement/traction BCs and stress/body-force loads fail closed when an unimplemented mechanics solve is requested.

(python-api-boundary-conditions-mechanical-boundary-conditions-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/mechanics.py` (`class MechanicalBoundaryCondition` and `class MechanicalLoad`). Constructor signatures, validation branches, defaults, and `to_ir()` field names follow that module directly.

(python-api-boundary-conditions-mechanical-boundary-conditions-validation)=
## Validation

Focused repository unit tests covering authoring and IR lowering include `test_mechanical_boundary_condition_validation` and `test_mechanical_load_validation`. Runtime execution and device performance require separate backend qualification.

(python-api-boundary-conditions-mechanical-boundary-conditions-limitations)=
## Limitations and Control Room

Control Room has no dedicated editor route for `MechanicalBoundaryCondition` or `MechanicalLoad`; configure them in Python scripts and inspect active session effects where exposed by the owning module. See {doc}`/frontend/capability-register`.

(python-api-boundary-conditions-mechanical-boundary-conditions-scientific-bibliography)=
## Scientific bibliography

- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Butterworth-Heinemann (1986), [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).

(python-api-boundary-conditions-mechanical-boundary-conditions-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/mechanics.py` | `class MechanicalBoundaryCondition` | public constructor and IR lowering |
