---
title: Interfacial DMI Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
source_of_truth: docs/physics/0404-interfacial-dmi.md
---

(public-docs-python-api-interactions-interfacial-dmi)=
# Interfacial DMI Python API

This page documents the complete public authoring and lowering contract for interfacial DMI.
The physical equations and FDM/FEM realizations are in
{doc}`../../physics/interactions/dmi/interfacial`.

FullMag has two input routes:

1. `fullmag.InterfacialDMI(D=..., interface_normal=...)` writes an explicit
   `energy_terms` entry;
2. `fullmag.Material(Dind=..., Dind_field=...)` provides material-owned scalar or spatial
   coefficients, used by the FEM planner when an explicit scalar term is absent.

These routes must not be supplied as two contributions that are silently summed. The planner
resolves one coefficient for the selected execution.

(interfacial-dmi-api-problem-statement)=
## Physical problem

For $m_n=\mathbf m\cdot\hat{\mathbf n}$, the authored term represents

```{math}
:label: eq-python-interfacial-dmi-density
w_{\mathrm i}=D\left[m_n\nabla\cdot\mathbf m-\mathbf m\cdot\nabla m_n\right].
```

(interfacial-dmi-api-governing-equations)=
## Governing equations

The effective field used by the resolved backend is

```{math}
:label: eq-python-interfacial-dmi-field
\mathbf H_{\mathrm i}
=\frac{2D}{\mu_0M_s}\left[\nabla m_n-(\nabla\cdot\mathbf m)\hat{\mathbf n}\right].
```

(interfacial-dmi-api-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Definition | SI unit |
|---|---|---:|
| $D$ | interfacial DMI coefficient | $\mathrm{J\,m^{-2}}$ |
| $\hat{\mathbf n}$ | normalized interface normal | $1$ |
| $m_n$ | $\mathbf m\cdot\hat{\mathbf n}$ | $1$ |
| $\mathbf m$ | reduced magnetization | $1$ |
| $M_s$ | saturation magnetization | $\mathrm{A\,m^{-1}}$ |
| $\mu_0$ | vacuum permeability | $\mathrm{N\,A^{-2}}$ |
| $\mathbf H_{\mathrm i}$ | interfacial DMI effective field | $\mathrm{A\,m^{-1}}$ |
| $w_{\mathrm i}$ | interfacial DMI energy density | $\mathrm{J\,m^{-3}}$ |

(interfacial-dmi-api-assumptions-and-validity)=
## Assumptions and validity

- `D` is finite and expressed directly in SI $\mathrm{J\,m^{-2}}$.
- `interface_normal` is a length-three finite vector. FEM normalizes a non-zero vector; FDM
  accepts only a vector equivalent to $(0,0,1)$ and rejects other orientations.
- Omitting `interface_normal` resolves to the FEM default $(0,0,1)$ and is the only executable
  FDM orientation.
- `Dind_field` is a FEM material field whose cardinality and finite values are validated against
  the resolved mesh. It is not a general Python-side interpolation mechanism.
- Python construction and `to_ir()` serialization do not prove backend execution or GPU
  qualification.

(interfacial-dmi-api-python-api)=
## Complete constructors and parameters

### `InterfacialDMI`

```python
# %% Explicit iDMI term
import fullmag as fm

term = fm.InterfacialDMI(
    D=2.5e-3,
    interface_normal=(0.0, 0.0, 1.0),
)
print(term.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `InterfacialDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite | scalar interfacial DMI coefficient and chirality sign | FDM/FEM CPU/GPU | `energy_terms[].D` for `kind=interfacial_dmi` |
| `InterfacialDMI.interface_normal` | `Sequence[float] \| None` | `None` | $1$ | length 3; finite; FEM non-zero; FDM normalized `+z` only | interface symmetry axis | FDM `+z`; FEM any non-zero normalized axis | `energy_terms[].interface_normal` when supplied |

### `Material` interfacial fields

```python
# %% Material-owned FEM coefficient
import fullmag as fm

material = fm.Material(
    name="dmi-film",
    Ms=800.0e3,
    A=13.0e-12,
    alpha=0.01,
    Dind=2.5e-3,
)
print(material.to_ir())
```

| Python parameter | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
|---|---|---|---|---|---|---|---|
| `Material.Dind` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied; FEM planner resolves active value | material-owned scalar iDMI coefficient | FEM CPU/GPU; not a native FDM scalar route | `materials[].interfacial_dmi` |
| `Material.Dind_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | FEM node cardinality and finite values validated downstream | spatial nodal iDMI coefficient; element values are averaged in native FEM residual | FEM CPU/GPU | `materials[].dind_field` |

`Dind` is a scalar material fallback, not an additional energy term. For an explicit FDM run,
author `InterfacialDMI(D=...)`; the current FDM planner does not resolve `Material.Dind` or
`Dind_field` into its scalar DMI slot.

### Object-level `ProblemIR` fragments

The stage builder does not currently expose a DMI registration method. This block is therefore a
fragment inspection only; it is not the public simulation workflow and does not launch a solver.
Use the stage boundary and capability statement on the physics owner page for the current
executable surface.

```python
# %% Interfacial-DMI object fragment; no solver is launched here.
import json
import fullmag as fm

term = fm.InterfacialDMI(D=2.5e-3, interface_normal=(0.0, 0.0, 1.0))
print(json.dumps(term.to_ir(), indent=2))
```

(interfacial-dmi-api-problem-ir)=
## ProblemIR lowering

The explicit constructor lowers without changing its sign or units:

```json
{
  "energy_terms": [
    {
      "kind": "interfacial_dmi",
      "D": 0.0025
    }
  ]
}
```

If the normal is authored, it is serialized as a three-component list. If omitted, the Python
key remains absent and the backend planner records the resolved FEM default or FDM canonical
orientation. A canonical material fragment is:

```json
{
  "interfacial_dmi": 0.0025,
  "dind_field": null
}
```

The lowering map is therefore:

| Python source | Canonical IR | Normalization/resolution |
|---|---|---|
| `InterfacialDMI.D` | `energy_terms[].D` | finite scalar preserved in SI units |
| `InterfacialDMI.interface_normal` | `energy_terms[].interface_normal` | omitted in Python; FEM defaults and normalizes, FDM checks canonical `+z` |
| `Material.Dind` | `materials[].interfacial_dmi` | scalar FEM fallback when no explicit term supplies it |
| `Material.Dind_field` | `materials[].dind_field` | FEM resolved nodal field; cardinality and values checked against mesh |

(interfacial-dmi-api-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

Requested intent is the original explicit term or material fields. Resolved execution is the
planner result containing the selected solver/device/precision, normalized FEM normal, scalar or
spatial coefficient route, boundary policy, and output decisions. Script export must preserve
which input route the user chose.

Validation errors include non-finite coefficients, vectors of the wrong length, zero FEM normals,
non-`+z` FDM normals, duplicate explicit iDMI terms, invalid `Dind_field` cardinality or values,
and incompatible material/backend combinations. Unsupported combinations are explicit planner
errors; the runtime must not silently rotate the FDM stencil or fall back from GPU to CPU.

(interfacial-dmi-api-discrete-realization)=
## Discrete realization selected after lowering

The Python layer does not choose finite-difference neighbors, FEM quadrature, lumped mass,
precision, or device residency. FDM consumes one scalar explicit coefficient in the current
planner. FEM consumes either the explicit scalar term or the material fallback and can promote
`Dind_field` to the native material field. The physical equation is shared; the discrete field
and energy ownership is backend-specific.

| Lane | Resolved behavior |
|---|---|
| FDM CPU | centered differences, active-neighbor clamping, `+z`, double-precision reference |
| FDM GPU | fused FP64/FP32 CUDA field path and scalar reduction, `+z` |
| FEM CPU | general-normal weak residual, quadrature energy, lumped-mass projected field |
| FEM GPU | device tetrahedral residual, device field buffers, final energy reduction |

## Outputs

| Output | Kind | SI unit | Requires |
|---|---|---|---|
| `H_dmi` | vector field | $\mathrm{A\,m^{-1}}$ | active DMI field materialization; may combine bulk and interfacial terms |
| `H_DMI` | vector field | $\mathrm{A\,m^{-1}}$ | FEM interfacial field path |
| `E_dmi` | scalar | $\mathrm{J}$ | active iDMI scalar energy path |
| `eden_dmi` | spatial scalar | $\mathrm{J\,m^{-3}}$ | local energy-density materialization |

(interfacial-dmi-api-implementation-mapping)=
## Implementation mapping

`InterfacialDMI.__init__` stores a finite scalar and validates the optional vector shape.
`Material.__post_init__` validates finite `Dind`; FEM planning resolves the default/normalized
normal and material field. FDM planning owns the strict `+z` legality rule. CPU and GPU source
identities are listed in the adjacent source map and in the physical page.

(interfacial-dmi-api-validation)=
## Validation plan

Test constructor serialization, default omission, malformed vectors, non-finite values, FEM zero
normal rejection, FDM tilted-normal rejection, explicit duplicate-term rejection, and material
field cardinality/value errors. Then compare the analytic field and energy sign under $D\to-D$,
FDM reference values, FEM weak-residual action, and qualified GPU execution at matched precision.

(interfacial-dmi-api-limitations)=
## Limitations

The public API does not yet expose an arbitrary FDM interface orientation, spatial normal field,
tensor DMI, curved-surface correction, or explicit non-natural DMI boundary operator. `Dind_field`
is currently a FEM material realization, not a general cross-backend field abstraction.

(interfacial-dmi-api-scientific-bibliography)=
## Scientific bibliography

- Rohart, S. and Thiaville, A., *Physical Review B* **88**, 184422 (2013), DOI:
  `10.1103/PhysRevB.88.184422`.
- FullMag canonical physical note: `docs/physics/0404-interfacial-dmi.md`.
- FullMag implementation notes: `docs/physics/0440-fdm-interfacial-dmi.md` and
  `docs/physics/0450-fem-interfacial-dmi-mfem-gpu.md`.

(interfacial-dmi-api-source-code-index)=
## Source-code index

| Repository path | Stable symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class InterfacialDMI` | public constructor and term IR |
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | `Dind` and `Dind_field` serialization |
| `packages/fullmag-py/src/fullmag/_validation.py` | `as_vector3` | vector shape/finiteness validation |
| `crates/fullmag-plan/src/fdm.rs` | `plan_fdm` | FDM scalar resolution and legality |
| `crates/fullmag-plan/src/fem.rs` | `plan_fem` | FEM normal and material-field resolution |
| `backends/fem/core/fem_material_fields.cpp` | `validate_material_fields` | FEM field length/value checks |
