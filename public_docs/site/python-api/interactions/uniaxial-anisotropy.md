---
title: Uniaxial anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0402-uniaxial-anisotropy.md
---

(public-docs-python-api-interactions-uniaxial-anisotropy)=
# Uniaxial anisotropy Python API

This page owns the Python constructor, material parameters, compatibility migration, validation,
canonical IR, outputs, and copyable examples. The physical equations and backend realizations are
in {doc}`../../physics/interactions/anisotropy/uniaxial`.

The public model has two authoring forms:

1. canonical material-owned fields `Material(Ku1=..., Ku2=..., anisU=...)`; and
2. compatibility `UniaxialAnisotropy(...)`, which is migrated into one material before lowering.

They are not two independent physical terms in the resulting ProblemIR.

(uniaxial-api-problem-statement)=
## Physical problem

For normalized easy axis $mathbf u$ and $q=\mathbf m\cdot\mathbf u$, FullMag uses

```{math}
:label: eq-python-uniaxial-density
w_{\mathrm u}=-K_{u1}q^2-K_{u2}q^4.
```

(uniaxial-api-governing-equations)=
## Governing equations

```{math}
:label: eq-python-uniaxial-field
\mathbf H_{\mathrm u}
=
\frac{2K_{u1}q+4K_{u2}q^3}{\mu_0M_s}\,\mathbf u.
```

(uniaxial-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf u$ | normalized easy-axis direction | $1$ |
| $q$ | projection $\mathbf m\cdot\mathbf u$ | $1$ |
| $K_{u1}$ | first-order uniaxial constant | $\mathrm{J\,m^{-3}}$ |
| $K_{u2}$ | second-order uniaxial constant | $\mathrm{J\,m^{-3}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf H_{\mathrm u}$ | uniaxial anisotropy effective field | $\mathrm{A\,m^{-1}}$ |
| $w_{\mathrm u}$ | uniaxial anisotropy energy density | $\mathrm{J\,m^{-3}}$ |

(uniaxial-api-assumptions-and-validity)=
## Assumptions and validity

- Constants are SI values in J/m^3 and are passed directly without CGS conversion.
- `axis` and `anisU` are directions. The public validator checks length and finiteness; native
  realization normalizes the active direction and rejects a zero direction.
- `Material.Ms` is positive and finite. The compatibility object does not own `Ms`.
- Spatial coefficient arrays are backend-specific resolved fields, not arbitrary Python lists that
  bypass mesh cardinality validation.
- Accepted Python construction does not prove resolved execution, backend support, or GPU
  qualification.

(uniaxial-api-python-api)=
## Complete constructors and parameters

### `UniaxialAnisotropy`


| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `UniaxialAnisotropy.ku1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | finite | first-order uniaxial constant | FDM/FEM CPU/GPU after migration | `materials[].uniaxial_anisotropy` |
| `UniaxialAnisotropy.ku2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | finite | second-order uniaxial constant | FDM/FEM CPU/GPU after migration | `materials[].uniaxial_anisotropy_k2` |
| `UniaxialAnisotropy.axis` | `Sequence[float]` | `(0,0,1)` | $1$ | length 3; finite; non-zero when active | easy-axis direction | FDM/FEM CPU/GPU after migration | `materials[].anisotropy_axis` |

### `Material` fields

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Ku1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical first-order material value | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy` |
| `Material.Ku2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | canonical second-order material value | FDM/FEM CPU/GPU | `materials[].uniaxial_anisotropy_k2` |
| `Material.anisU` | `tuple[float,float,float] \| None` | `None` | $1$ | length 3; finite; non-zero when active | canonical easy-axis direction | FDM/FEM CPU/GPU | `materials[].anisotropy_axis` |
| `Material.Ku_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality validated downstream | spatial Ku1 override | FEM and supported allocating FDM reference paths | `materials[].ku_field` |
| `Material.Ku2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite; cardinality validated downstream | spatial Ku2 override | FEM and supported allocating FDM reference paths | `materials[].ku2_field` |

`Ku_field` and `Ku2_field` override the corresponding scalar value where the resolved backend
material path supports them. They do not create a new anisotropy order or alter the axis.

### Copyable canonical stage scenario

The canonical material-owned anisotropy is assigned to the study-owned magnetic body. The stage
graph, rather than a standalone `Material(...)` constructor, is the executable public example.

```python
# %% Uniaxial anisotropy in a complete stage-first study
import fullmag as fm

nm = 1.0e-9
study = fm.study("uniaxial_anisotropy_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
study.exchange()
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.Ku1 = 5.0e5
film.Ku2 = 0.05e6
film.anisU = (0.0, 0.0, 1.0)
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.solver(integrator="rk45", fix_dt=1.0e-15, gamma=2.211e5)
study.stages.add_run(stage_id="run", until=1.0e-9)
```

The spatial list is only a valid executable input when the selected mesh/material resolution has
exactly the required cardinality. For general authoring, omit it and let the planner derive
resolved material fields from regions.

### Compatibility migration fragment


### Outputs

| Output | Kind | SI unit | Requires |
|---|---|---|---|
| `H_ani` | vector field | $\mathrm{A\,m^{-1}}$ | Active uniaxial coefficients and field materialization. |
| `E_ani` | scalar | $\mathrm{J}$ | Active anisotropy and scalar energy materialization. |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Active anisotropy and spatial-energy materialization. |

(uniaxial-api-problem-ir)=
## ProblemIR lowering

The compatibility object is removed from the final energy-term list and merged into the one
material target. The canonical fragment is:

```json
{
  "uniaxial_anisotropy": 500000.0,
  "uniaxial_anisotropy_k2": 0.0,
  "anisotropy_axis": [0.0, 0.0, 1.0]
}
```

The migration is fail-closed. If a material already contains a different value for `Ku1`, `Ku2`,
or `anisU`, `Problem.to_ir()` raises a conflict error. If multiple materials are targeted by the
legacy object, migration raises instead of guessing an owner.

```{math}
:label: eq-python-uniaxial-ir-fields
\mathrm{IR}_{\mathrm u}
=
\{K_{u1},K_{u2},\mathbf u,\text{optional }K_{u1}(i),\text{optional }K_{u2}(i)\}.
```

(uniaxial-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the original Python object or material fields. Resolved execution is the
material-owned IR plus normalized axis, resolved spatial arrays, selected solver/device/precision,
and output decisions. Script export must preserve material-owned fields and must not recreate a
legacy term when the canonical material form is sufficient.

Validation errors include wrong vector length, non-finite values, active zero axis, conflicting
legacy/material values, multiple material targets, invalid spatial-field cardinality, and
unsupported combinations. Unsupported combinations are planner results, not silent fallbacks.

(uniaxial-api-discrete-realization)=
## Discrete realization selected after lowering

The Python layer does not choose cell stencils, FEM quadrature, precision, or device memory. FDM
uses cell-local values and volumes. FEM uses nodal values and lumped or element-quadrature mass.
CPU and GPU remain separate execution realizations even though the resolved physical polynomial is
the same.

(uniaxial-api-implementation-mapping)=
## Implementation mapping

`UniaxialAnisotropy.__init__` stores the three public fields after numeric conversion and vector
validation. `Material.__post_init__` validates material-owned values. The migration helper merges
legacy terms into one material and removes those terms from the energy list. `plan_fdm` and
`plan_fem` resolve the canonical material representation for their lanes.

(uniaxial-api-validation)=
## Validation plan

Test constructor defaults and rejection, exact compatibility IR, canonical material IR, conflict
errors, multi-material errors, script export, and output request legality. Then compare analytic
axis-parallel/perpendicular cases and cross-lane field/energy values. Python acceptance is not
backend qualification.

(uniaxial-api-limitations)=
## Limitations

The public API exposes one material-level axis. Internal FEM axis fields and backend-specific
material promotion are not additional public constructor parameters. The compatibility object is
retained for migration and should not be used to represent multiple material targets.

(uniaxial-api-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag internal source of truth: `docs/physics/0402-uniaxial-anisotropy.md`.
- FullMag Python implementation: `packages/fullmag-py/src/fullmag/model/energy.py` and `structure.py`.

(uniaxial-api-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class UniaxialAnisotropy` | Compatibility constructor and term serialization. |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical anisotropy fields and validation. |
| `packages/fullmag-py/src/fullmag/_validation.py` | `as_vector3` | Vector shape and finite-value validation. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `_migrate_legacy_anisotropy_energy_terms` | Conflict-checked migration to material IR. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM planning of material anisotropy. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM planning and axis/material validation. |
