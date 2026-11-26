---
title: Mechanical Boundary Conditions
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Mechanical boundary conditions and loads

(public-docs-python-api-boundary-conditions-mechanical-boundary-conditions)=
(python-api-boundary-conditions-mechanical-boundary-conditions-problem-statement)=
## Problem statement

`fm.MechanicalBoundaryCondition` and `fm.MechanicalLoad` keep boundary condition kind, surface selector, and required mechanical payloads explicit for continuum elastostatics and magnetoelasticity, paired with the mechanical dynamics mode descriptors (`fm.PrescribedStrain`, `fm.QuasistaticElasticity`, and `fm.Elastodynamics`).

Construction validates typed authoring data in Python; calling `to_ir()` lowers each object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-boundary-conditions-mechanical-boundary-conditions-governing-equations)=
## Governing equations

`fm.MechanicalBoundaryCondition` specifies homogeneous or inhomogeneous boundary constraints on a named surface: traction-free ($\boldsymbol{\sigma}\mathbf{n} = \mathbf{0}$), clamped ($\mathbf{u} = \mathbf{0}$), prescribed Dirichlet displacement ($\mathbf{u}(\mathbf{x}) = \bar{\mathbf{u}}$), or prescribed Neumann surface traction ($\boldsymbol{\sigma}\mathbf{n} = \bar{\mathbf{t}}$). `fm.MechanicalLoad` specifies volumetric body force ($\mathbf{f}$), prescribed strain, or prescribed stress in six-component engineering-Voigt order: $\boldsymbol{\varepsilon}^{\mathrm{eng}} = (\varepsilon_{11}, \varepsilon_{22}, \varepsilon_{33}, \gamma_{23}, \gamma_{13}, \gamma_{12})$ with $\gamma_{ij} = 2\varepsilon_{ij}$. See {doc}`../../physics/interactions/magnetoelastic/index`, {doc}`../../physics/foundations/boundary-conditions`, and {doc}`../interactions/magnetoelastic` for the governing formulations and currently executable prescribed-strain subset.

(python-api-boundary-conditions-mechanical-boundary-conditions-symbols-and-si-units)=
## Symbols and SI units

- Displacements $\mathbf{u}$ (`u`) use SI metres ($\mathrm{m}$); surface tractions $\bar{\mathbf{t}}$ (`t`) and stresses $\boldsymbol{\sigma}$ (`stress`) use pascals ($\mathrm{Pa} = \mathrm{N\,m^{-2}}$).
- Volumetric body forces $\mathbf{f}$ (`f`) use $\mathrm{N\,m^{-3}}$; mechanical integration step `mechanical_dt` uses $\mathrm{s}$.
- Engineering-Voigt strains $\varepsilon_{ij}, \gamma_{ij}$ (`strain`), surface selectors (`surface`), `kind` identifiers, and Picard solver tolerances are dimensionless ($1$).

(python-api-boundary-conditions-mechanical-boundary-conditions-assumptions-and-validity)=
## Assumptions and validity

- `fm.MechanicalBoundaryCondition.kind` must be one of `"traction_free"`, `"clamped"`, `"prescribed_displacement"`, or `"prescribed_traction"`; `surface` must be non-empty.
- `"prescribed_displacement"` requires a 3-component `u` vector; `"prescribed_traction"` requires a 3-component `t` vector (`as_vector3` validates length 3 and converts entries to `float`).
- `fm.MechanicalLoad.kind` must be one of `"body_force"`, `"prescribed_strain"`, or `"prescribed_stress"`. `"body_force"` requires `f`, `"prescribed_strain"` requires 6-component Voigt `strain`, and `"prescribed_stress"` requires 6-component Voigt `stress`.
- Contradictory kind/payload combinations or wrong Voigt lengths fail closed at construction; unimplemented coupled mechanics solves fail closed at planning.

(python-api-boundary-conditions-mechanical-boundary-conditions-python-api)=
## Python API

### Constructor or function

`fm.MechanicalBoundaryCondition(kind, surface, u=None, t=None)` and `fm.MechanicalLoad(kind, f=None, strain=None, stress=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `MechanicalBoundaryCondition.kind` | `str` | `required` | $1$ | `"traction_free"`, `"clamped"`, `"prescribed_displacement"`, or `"prescribed_traction"` | boundary condition family | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `kind` |
| `MechanicalBoundaryCondition.surface` | `str` | `required` | $1$ | non-empty string | named boundary surface selector | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `surface` |
| `MechanicalBoundaryCondition.u` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | 3-component vector; required when `kind="prescribed_displacement"` | prescribed displacement vector | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `u` |
| `MechanicalBoundaryCondition.t` | `Sequence[float] \| None` | `None` | $\mathrm{Pa}$ | 3-component vector; required when `kind="prescribed_traction"` | prescribed surface traction vector | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `t` |
| `MechanicalLoad.kind` | `str` | `required` | $1$ | `"body_force"`, `"prescribed_strain"`, or `"prescribed_stress"` | volume load or prescribed deformation family | FEM/FDM CPU/GPU: IR; prescribed-strain subset executable where qualified | `kind` |
| `MechanicalLoad.f` | `Sequence[float] \| None` | `None` | $\mathrm{N\,m^{-3}}$ | required when `kind="body_force"` | volumetric body force density | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `f` |
| `MechanicalLoad.strain` | `Sequence[float] \| None` | `None` | $1$ | required when `kind="prescribed_strain"`; length 6 (Voigt) | prescribed engineering-Voigt strain tensor | FEM/FDM CPU/GPU: IR; prescribed-strain subset executable where qualified | `strain` |
| `MechanicalLoad.stress` | `Sequence[float] \| None` | `None` | $\mathrm{Pa}$ | required when `kind="prescribed_stress"`; length 6 (Voigt) | prescribed Voigt stress tensor | FEM/FDM CPU/GPU: IR; coupled mechanics runtime required | `stress` |

### Companion mechanical dynamics modes

Mechanical boundary conditions and loads are paired with one of three mechanical dynamics modes defined in `packages/fullmag-py/src/fullmag/model/dynamics.py` (see also {doc}`../interactions/magnetoelastic`):

| Type | Signature & defaults | Validation & ProblemIR `kind` |
|---|---|---|
| `fm.PrescribedStrain` | `fm.PrescribedStrain()` | no mechanical solve; reads strain/stress from `fm.MechanicalLoad` (`kind="prescribed_strain"`) |
| `fm.QuasistaticElasticity` | `fm.QuasistaticElasticity(max_picard_iterations=3, picard_tolerance=1e-6)` | `max_picard_iterations >= 1`, `picard_tolerance > 0`; solves $\nabla\cdot\boldsymbol{\sigma}=0$ per step (`kind="quasistatic_elasticity"`) |
| `fm.Elastodynamics` | `fm.Elastodynamics(mechanical_dt=None)` | `mechanical_dt > 0` ($\mathrm{s}$) when supplied; coupled $\mathbf{m}$–$\mathbf{u}$–$\mathbf{v}$ system (`kind="elastodynamics"`) |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("mechanical-bc-example")
study.objects.mesh.defaults(maximum_element_size=5e-9)
film = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.stages.add_relax(stage_id="mech-relax", dt=5e-13, max_steps=1)

# %%
bc_clamped = fm.MechanicalBoundaryCondition("clamped", "bottom_face")
bc_free = fm.MechanicalBoundaryCondition("traction_free", "top_face")
bc_disp = fm.MechanicalBoundaryCondition(
    "prescribed_displacement",
    "clamp",
    u=(0.0, 0.0, 0.0),
)
strain_load = fm.MechanicalLoad(
    "prescribed_strain",
    strain=(1.0e-4, 0.0, 0.0, 0.0, 0.0, 0.0),
)
mode = fm.PrescribedStrain()
canonical_ir = {
    "bc_clamped": bc_clamped.to_ir(),
    "bc_free": bc_free.to_ir(),
    "bc_disp": bc_disp.to_ir(),
    "load": strain_load.to_ir(),
    "mode": mode.to_ir(),
}
```

(python-api-boundary-conditions-mechanical-boundary-conditions-problem-ir)=
## ProblemIR

`fm.MechanicalBoundaryCondition.to_ir()` emits `{"kind": ..., "surface": ...}` plus `"u"` (for `"prescribed_displacement"`) or `"t"` (for `"prescribed_traction"`). `fm.MechanicalLoad.to_ir()` emits `{"kind": ...}` plus `"f"`, `"strain"`, or `"stress"`. The IR stores requested intent independently of backend resolution.

(python-api-boundary-conditions-mechanical-boundary-conditions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid `kind` values, blank surface names, missing required payloads, malformed 3-vector lengths, and non-6-component Voigt vectors before planning. `Unsupported combinations` (such as displacement/traction BCs or elastodynamics on backends lacking a mechanical PDE solver) fail closed at the planner or backend boundary without silent conversion.

(python-api-boundary-conditions-mechanical-boundary-conditions-discrete-realization)=
## Discrete realization

The Python authoring contract supplies boundary/load inputs and canonical `ProblemIR`; discrete element operators, quadrature, and solver support execute across the four lanes as follows:

| Backend lane | Authoring & IR | Runtime status & discretization notes |
|---|---|---|
| FEM CPU | Supported | Prescribed-strain magnetoelastic subset executable where qualified; displacement/traction BCs and coupled quasistatic/elastodynamic solves fail closed where unimplemented. |
| FEM GPU | Supported | IR lowering supported; unsupported coupled mechanics solves fail closed at planning. |
| FDM CPU | Supported | IR lowering supported; prescribed-strain effective fields where enabled, with displacement/traction BCs failing closed. |
| FDM GPU | Supported | IR lowering supported; unsupported coupled mechanics solves fail closed at planning. |

(python-api-boundary-conditions-mechanical-boundary-conditions-implementation-mapping)=
## Implementation mapping

The authoritative Python implementations are `packages/fullmag-py/src/fullmag/model/mechanics.py` (`class MechanicalBoundaryCondition`, `class MechanicalLoad`) and `packages/fullmag-py/src/fullmag/model/dynamics.py` (`class PrescribedStrain`, `class QuasistaticElasticity`, `class Elastodynamics`).

(python-api-boundary-conditions-mechanical-boundary-conditions-validation)=
## Validation

Focused repository unit tests covering authoring and IR lowering include `test_mechanical_boundary_condition_validation` and `test_mechanical_load_validation`. Runtime execution and device performance require separate backend qualification.

(python-api-boundary-conditions-mechanical-boundary-conditions-limitations)=
## Limitations and Control Room

Control Room has no dedicated editor route for `fm.MechanicalBoundaryCondition` or `fm.MechanicalLoad`; configure them in Python scripts and inspect active session effects where exposed by the owning module. See {doc}`/frontend/capability-register`.

(python-api-boundary-conditions-mechanical-boundary-conditions-scientific-bibliography)=
## Scientific bibliography

- L. D. Landau and E. M. Lifshitz, *Theory of Elasticity*, 3rd ed., Butterworth-Heinemann (1986), [doi:10.1016/C2013-0-03754-0](https://doi.org/10.1016/C2013-0-03754-0).

(python-api-boundary-conditions-mechanical-boundary-conditions-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L134) | `class MechanicalBoundaryCondition` | mechanical surface boundary condition constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/mechanics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/mechanics.py#L191) | `class MechanicalLoad` | volumetric body-force, prescribed-strain, and prescribed-stress load constructor |
| [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L208) | `class PrescribedStrain` | prescribed-strain mechanical dynamics regime |
| [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L220) | `class QuasistaticElasticity` | quasistatic bidirectional Picard elasticity regime |
| [`packages/fullmag-py/src/fullmag/model/dynamics.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/dynamics.py#L251) | `class Elastodynamics` | full coupled elastodynamics regime |
