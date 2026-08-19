---
title: Cubic anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0403-cubic-anisotropy.md
---

(public-docs-python-api-interactions-cubic-anisotropy)=
# Cubic anisotropy Python API

This page owns the public cubic-anisotropy constructors, material fields, compatibility migration,
validation, canonical IR, outputs, and copyable examples. The equations and backend lanes are in
{doc}`../../physics/interactions/anisotropy/cubic`.

The canonical authoring form is material-owned `Kc1`, `Kc2`, `Kc3`, `anisC1`, and `anisC2`. The
`CubicAnisotropy` object remains a compatibility form and is migrated to one material target.

(cubic-api-problem-statement)=
## Physical problem

For crystal direction cosines $\alpha_a=\mathbf m\cdot\mathbf c_a$, define

```{math}
:label: eq-python-cubic-density
w_{\mathrm c}=K_{c1}\Sigma+K_{c2}\alpha_1^2\alpha_2^2\alpha_3^2+K_{c3}\Sigma^2.
```

(cubic-api-governing-equations)=
## Governing equations

```{math}
:label: eq-python-cubic-frame
\mathbf c_3=\mathbf c_1\times\mathbf c_2,
\qquad
\Sigma=\alpha_1^2\alpha_2^2+\alpha_2^2\alpha_3^2+\alpha_3^2\alpha_1^2.
```

(cubic-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $\mathbf c_1$ | first crystal axis | $1$ |
| $\mathbf c_2$ | second crystal axis | $1$ |
| $\mathbf c_3$ | derived third crystal axis | $1$ |
| $\alpha_a$ | direction cosine | $1$ |
| $\Sigma$ | first cubic invariant | $1$ |
| $K_{c1}$ | first cubic constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c2}$ | second cubic constant | $\mathrm{J\,m^{-3}}$ |
| $K_{c3}$ | third cubic constant | $\mathrm{J\,m^{-3}}$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $w_{\mathrm c}$ | cubic anisotropy energy density | $\mathrm{J\,m^{-3}}$ |

(cubic-api-assumptions-and-validity)=
## Assumptions and validity

- Constants are passed in J/m^3; no CGS conversion occurs.
- The physical crystal frame must be orthonormal. Python performs shape/finiteness validation;
  FEM planning performs strict unit/orthogonality validation.
- `CubicAnisotropy` migration requires one material target and rejects conflicting material data.
- Python acceptance is requested intent, not proof of backend/device qualification.

(cubic-api-python-api)=
## Complete constructors and parameters

### `CubicAnisotropy`


| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `CubicAnisotropy.kc1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | `finite` | `first cubic constant` | `FDM/FEM CPU/GPU after migration` | `materials[].cubic_anisotropy_kc1` |
| `CubicAnisotropy.kc2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | `finite` | `second cubic constant` | `FDM/FEM CPU/GPU after migration` | `materials[].cubic_anisotropy_kc2` |
| `CubicAnisotropy.kc3` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | `finite` | `third cubic constant` | `FDM/FEM CPU/GPU after migration` | `materials[].cubic_anisotropy_kc3` |
| `CubicAnisotropy.axis1` | `Sequence[float]` | `(1,0,0)` | $1$ | `length 3; finite` | `first crystal axis` | `FDM/FEM CPU/GPU after migration` | `materials[].cubic_anisotropy_axis1` |
| `CubicAnisotropy.axis2` | `Sequence[float]` | `(0,1,0)` | $1$ | `length 3; finite` | `second crystal axis` | `FDM/FEM CPU/GPU after migration` | `materials[].cubic_anisotropy_axis2` |

### `Material` fields

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Kc1` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | `finite when supplied` | `canonical first cubic value` | `FDM/FEM CPU/GPU` | `materials[].cubic_anisotropy_kc1` |
| `Material.Kc2` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | `finite when supplied` | `canonical second cubic value` | `FDM/FEM CPU/GPU` | `materials[].cubic_anisotropy_kc2` |
| `Material.Kc3` | `float \| None` | `None` | $\mathrm{J\,m^{-3}}$ | `finite when supplied` | `canonical third cubic value` | `FDM/FEM CPU/GPU` | `materials[].cubic_anisotropy_kc3` |
| `Material.anisC1` | `tuple[float,float,float] \| None` | `None` | $1$ | `length 3; finite` | `first crystal axis` | `FDM/FEM CPU/GPU` | `materials[].cubic_anisotropy_axis1` |
| `Material.anisC2` | `tuple[float,float,float] \| None` | `None` | $1$ | `length 3; finite` | `second crystal axis` | `FDM/FEM CPU/GPU` | `materials[].cubic_anisotropy_axis2` |
| `Material.Kc1_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | `finite; cardinality downstream` | `spatial Kc1 override` | `FEM and supported allocating FDM reference paths` | `materials[].kc1_field` |
| `Material.Kc2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | `finite; cardinality downstream` | `spatial Kc2 override` | `FEM and supported allocating FDM reference paths` | `materials[].kc2_field` |
| `Material.Kc3_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | `finite; cardinality downstream` | `spatial Kc3 override` | `FEM and supported allocating FDM reference paths` | `materials[].kc3_field` |

### Canonical material example

(cubic-api-example)=
````python
# %% Cubic anisotropy registration
import fullmag as fm

nm = 1e-9

# Stage-first authoring using explicit term + material property
study = fm.study("cubic_anisotropy_example")
study.discretization("fem")
study.device("cpu")

study.universe(bounds=((0, 0, 0), (100 * nm, 100 * nm, 10 * nm)))

# Register material with cubic anisotropy via material property
mat = fm.Material(
    name="cobalt",
    Ms=1.4e6,
    A=2.0e-11,
    alpha=0.02,
    Kc1=2e5,
    Kc2=1e4,
    anisC1=(1, 0, 0),
    anisC2=(0, 1, 0),
)
study.material(mat)

# Register geometry
film = fm.Box(size=(100 * nm, 100 * nm, 10 * nm), material="cobalt")
study.geometry(film)

# Explicit CubicAnisotropy term (equivalent to material properties above)
study.terms.add(fm.CubicAnisotropy(kc1=2e5, kc2=1e4, axis1=(1, 0, 0), axis2=(0, 1, 0)))

study.stages.add_relax(stage_id="relax", tolA=795.7747154594767)
````

### Outputs

| Output | Kind | SI unit | Requires |
|---|---|---|---|
| `H_ani_cubic` | vector field | $\mathrm{A\,m^{-1}}$ | Active cubic coefficients and field materialization. |
| `E_ani` | scalar | $\mathrm{J}$ | Active anisotropy and scalar energy materialization. |
| `eden_ani` | spatial scalar field | $\mathrm{J\,m^{-3}}$ | Active anisotropy and spatial-energy materialization. |

(cubic-api-problem-ir)=
## ProblemIR lowering

The compatibility object is migrated to a material fragment and removed from the canonical energy
list:

```json
{
  "cubic_anisotropy_kc1": 200000.0,
  "cubic_anisotropy_kc2": 10000.0,
  "cubic_anisotropy_kc3": 0.0,
  "cubic_anisotropy_axis1": [1.0, 0.0, 0.0],
  "cubic_anisotropy_axis2": [0.0, 1.0, 0.0]
}
```

```{math}
:label: eq-python-cubic-ir-fields
\mathrm{IR}_{\mathrm c}
=
\{K_{c1},K_{c2},K_{c3},\mathbf c_1,\mathbf c_2\}.
```

(cubic-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent remains visible in the source model; resolved execution records material fields,
validated crystal frame, solver/device/precision, and output decisions. Wrong vector shape,
non-finite values, material conflicts, multiple migration targets, invalid FEM axes, and illegal
outputs are validation errors. Unsupported combinations are planner errors, not silent fallbacks.

(cubic-api-discrete-realization)=
## Discrete realization selected after lowering

The Python layer does not select FDM cells, FEM quadrature, device buffers, or precision. Those are
resolved after lowering and are separately documented in the physical owner page.

(cubic-api-implementation-mapping)=
## Implementation mapping

`CubicAnisotropy` validates and serializes compatibility values. The Problem migration helper
merges them into `Material`; planners resolve material fields and crystal-axis legality. Stable
symbols are listed below and checked by the adjacent source map.

(cubic-api-validation)=
## Validation plan

Test defaults, exact serialization, axis shape/finiteness, migration, conflicts, multi-material
failure, script export, and output legality. Use high-symmetry crystal directions and finite
differences of energy to verify the native field. Python acceptance alone is not GPU qualification.

(cubic-api-limitations)=
## Limitations

The public API exposes two axes and derives the third. It has no public arbitrary third-axis field,
per-node crystal frame, solver tolerance, or device selector. Spatial Kc fields remain subject to
backend cardinality and material-location constraints.

(cubic-api-scientific-bibliography)=
## Scientific bibliography

- Brown, W. F., *Micromagnetics*, Wiley, 1963.
- FullMag internal source of truth: `docs/physics/0403-cubic-anisotropy.md`.
- FullMag Python implementation: `packages/fullmag-py/src/fullmag/model/energy.py` and `structure.py`.

(cubic-api-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class CubicAnisotropy` | Compatibility constructor and serialization. |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | Canonical cubic material fields. |
| `packages/fullmag-py/src/fullmag/_validation.py` | `as_vector3` | Axis shape/finiteness validation. |
| `packages/fullmag-py/src/fullmag/model/problem.py` | `_migrate_legacy_anisotropy_energy_terms` | Material migration and conflict semantics. |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM material planning. |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM material planning and crystal-frame validation. |
