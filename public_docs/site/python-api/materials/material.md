---
title: Material
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Magnetic material

(public-docs-python-api-materials-material)=
(python-api-materials-material-problem-statement)=
## Problem statement

Material is the typed source of magnetic coefficients.

This page covers the Python authoring contract: construction validates required positive magnetic constants, optional anisotropy/DMI coefficients, and typed spatial field overrides in Python, while `to_ir()` emits the canonical `ProblemIR` material record.

(python-api-materials-material-governing-equations)=
## Governing equations

`Material` supplies the constitutive coefficients entering the continuum micromagnetic free energy and Landau–Lifshitz–Gilbert equation: saturation magnetization $M_s$, isotropic exchange stiffness $A$, Gilbert damping $\alpha$, uniaxial anisotropy ($K_{u1}, K_{u2}, \mathbf{u}$), cubic anisotropy ($K_{c1}, K_{c2}, K_{c3}, \mathbf{c}_1, \mathbf{c}_2$), and interfacial/bulk Dzyaloshinskii–Moriya constants ($D_{\mathrm{ind}}, D_{\mathrm{bulk}}$), either as uniform scalars or spatial fields. Continuum conventions and unit rules are documented in {doc}`../../physics/geometry-and-materials`, {doc}`../../physics/foundations/conventions-and-units`, and {doc}`spatial-parameter-fields`.

(python-api-materials-material-symbols-and-si-units)=
## Symbols and SI units

Scalar parameters and corresponding spatial field overrides use SI units: saturation magnetization (`Ms`, `Ms_field`) in $\mathrm{A\,m^{-1}}$, exchange stiffness (`A`, `A_field`) in $\mathrm{J\,m^{-1}}$, anisotropy constants (`Ku1`, `Ku2`, `Kc1`, `Kc2`, `Kc3`, and `*_field`) in $\mathrm{J\,m^{-3}}$, and DMI constants (`Dind`, `Dbulk`, `*_field`) in $\mathrm{J\,m^{-2}}$. Material identifiers (`name`), Gilbert damping (`alpha`, `alpha_field`), and normalized crystal axes (`anisU`, `anisC1`, `anisC2`) are dimensionless ($1$).

(python-api-materials-material-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `Ms` and `A` must be strictly positive (or typed non-negative spatial fields with valid positive support), `alpha` must be finite and non-negative, and optional anisotropy/DMI constants must be finite when supplied. Non-positive required constants, malformed vector axes, or invalid field overrides fail closed at construction.

(python-api-materials-material-python-api)=
## Python API

### Constructor or function

`fm.Material(name, Ms, A, alpha, ...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | material identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `Ms` | `float or field` | `required` | $\mathrm{A\,m^{-1}}$ | positive or typed field | saturation magnetization | FEM/FDM CPU/GPU: IR; resolver-specific | `Ms` |
| `A` | `float or field` | `required` | $\mathrm{J\,m^{-1}}$ | positive or typed field | exchange stiffness | FEM/FDM CPU/GPU: IR; resolver-specific | `A` |
| `alpha` | `float or field` | `required` | $1$ | finite and non-negative | Gilbert damping | FEM/FDM CPU/GPU: IR; resolver-specific | `alpha` |
| `Ku1/Ku2/Kc1/Kc2/Kc3` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | anisotropy constants | FEM/FDM CPU/GPU: IR; resolver-specific | `anisotropy` |
| `Dind/Dbulk` | `float or field or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | DMI constants | FEM/FDM CPU/GPU: IR; resolver-specific | `dmi` |

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
value = fm.Material(name="film", Ms=8.0e5, A=1.0e-11, alpha=0.01)
canonical_ir = value.to_ir()
```

In a complete simulation script, pass `fm.Material(...)` via `study.material(...)` / region overrides or set magnetic properties directly on study objects (`body.Ms`, `body.Aex`, `body.alpha`).

(complete-qualified-material-signature)=
### Complete qualified Material signature

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Material.name` | `str` | `required` | $1$ | non-empty | material identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `Material.Ms` | `float or field` | `required` | $\mathrm{A\,m^{-1}}$ | positive or typed field | saturation magnetization | FEM/FDM CPU/GPU: IR; resolver-specific | `Ms` |
| `Material.A` | `float or field` | `required` | $\mathrm{J\,m^{-1}}$ | positive or typed field | exchange stiffness | FEM/FDM CPU/GPU: IR; resolver-specific | `A` |
| `Material.alpha` | `float or field` | `required` | $1$ | finite and non-negative | Gilbert damping | FEM/FDM CPU/GPU: IR; resolver-specific | `alpha` |
| `Material.Ku1` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | first uniaxial constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Ku1` |
| `Material.Ku2` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | second uniaxial constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Ku2` |
| `Material.anisU` | `tuple or None` | `None` | $1$ | typed when supplied | uniaxial axes | FEM/FDM CPU/GPU: IR; resolver-specific | `anisU` |
| `Material.Kc1` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | first cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Kc1` |
| `Material.Kc2` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | second cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Kc2` |
| `Material.Kc3` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | third cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Kc3` |
| `Material.anisC1` | `tuple or None` | `None` | $1$ | typed when supplied | first cubic axis | FEM/FDM CPU/GPU: IR; resolver-specific | `anisC1` |
| `Material.anisC2` | `tuple or None` | `None` | $1$ | typed when supplied | second cubic axis | FEM/FDM CPU/GPU: IR; resolver-specific | `anisC2` |
| `Material.Dind` | `float or field or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | interfacial DMI constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Dind` |
| `Material.Dbulk` | `float or field or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | bulk DMI constant | FEM/FDM CPU/GPU: IR; resolver-specific | `Dbulk` |
| `Material.Ms_field` | `field or None` | `None` | $\mathrm{A\,m^{-1}}$ | typed when supplied | spatial saturation magnetization field | FEM/FDM CPU/GPU: IR; resolver-specific | `Ms_field` |
| `Material.A_field` | `field or None` | `None` | $\mathrm{J\,m^{-1}}$ | typed when supplied | spatial exchange field | FEM/FDM CPU/GPU: IR; resolver-specific | `A_field` |
| `Material.alpha_field` | `field or None` | `None` | $1$ | typed when supplied | spatial damping field | FEM/FDM CPU/GPU: IR; resolver-specific | `alpha_field` |
| `Material.Ku_field` | `field or None` | `None` | $\mathrm{J\,m^{-3}}$ | typed when supplied | spatial Ku1 field | FEM/FDM CPU/GPU: IR; resolver-specific | `Ku_field` |
| `Material.Ku2_field` | `field or None` | `None` | $\mathrm{J\,m^{-3}}$ | typed when supplied | spatial Ku2 field | FEM/FDM CPU/GPU: IR; resolver-specific | `Ku2_field` |
| `Material.Kc1_field` | `field or None` | `None` | $\mathrm{J\,m^{-3}}$ | typed when supplied | spatial Kc1 field | FEM/FDM CPU/GPU: IR; resolver-specific | `Kc1_field` |
| `Material.Kc2_field` | `field or None` | `None` | $\mathrm{J\,m^{-3}}$ | typed when supplied | spatial Kc2 field | FEM/FDM CPU/GPU: IR; resolver-specific | `Kc2_field` |
| `Material.Kc3_field` | `field or None` | `None` | $\mathrm{J\,m^{-3}}$ | typed when supplied | spatial Kc3 field | FEM/FDM CPU/GPU: IR; resolver-specific | `Kc3_field` |
| `Material.Dind_field` | `field or None` | `None` | $\mathrm{J\,m^{-2}}$ | typed when supplied | spatial interfacial DMI field | FEM/FDM CPU/GPU: IR; resolver-specific | `Dind_field` |
| `Material.Dbulk_field` | `field or None` | `None` | $\mathrm{J\,m^{-2}}$ | typed when supplied | spatial bulk DMI field | FEM/FDM CPU/GPU: IR; resolver-specific | `Dbulk_field` |

(python-api-materials-material-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed material dictionary containing `"name"`, `"saturation_magnetisation"`, `"exchange_stiffness"`, `"damping"`, optional uniaxial/cubic anisotropy keys (`"uniaxial_anisotropy"`, `"uniaxial_anisotropy_k2"`, `"anisotropy_axis"`, `"cubic_anisotropy_kc1"`, `"cubic_anisotropy_kc2"`, `"cubic_anisotropy_kc3"`, `"cubic_anisotropy_axis1"`, `"cubic_anisotropy_axis2"`), `"interfacial_dmi"`, `"bulk_dmi"`, and nested `*_field` maps for spatial overrides.

(python-api-materials-material-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves scalar constants, crystal axes, and spatial field records in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-positive `Ms`/`A`, negative `alpha`, or invalid field overrides, while `unsupported combinations` fail closed when a backend path lacks support for spatial fields or specific DMI/anisotropy combinations.

(python-api-materials-material-discrete-realization)=
## Discrete realization

The Python contract supplies constitutive material values and spatial descriptors in `ProblemIR` only; evaluating cellwise/nodal parameter sampling, interface harmonic means, and effective-field assembly belongs to the solver backends.

(python-api-materials-material-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/structure.py` (`class Material`). Signature validation, spatial override normalization, defaults, and `to_ir()` keys come directly from that module.

(python-api-materials-material-validation)=
## Validation

Focused repository unit tests covering `Material` authoring and spatial override serialization include `test_material_constructor_and_field_overrides_round_trip` and `test_material_rejects_invalid_required_parameters`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-materials-material-limitations)=
## Limitations and Control Room

- **Supported scalar material editing in Control Room:** `Model Explorer -> Objects -> <object> -> Material` renders `ObjectMaterialPanel` and `ObjectAbsorbingBoundaryPanel` for supported scalar magnetic constants and absorbing-layer parameters, while `ObjectRegionsPanel` and `ObjectRegionMagneticParametersPanel` override scalar magnetic parameters per labeled region.
- **Python-only surfaces:** Spatial parameter fields, elastic/magnetoelastic tensors, nonlinear/non-scalar couplings, and parameters without a named UI field remain `Python-only`; see {doc}`/frontend/inspectors/objects-and-materials` and {doc}`/frontend/capability-register`.

```{image} /_static/images/ui/inspector-material-and-regions.png
:alt: Control Room Object Regions inspector showing Pinning Annulus and Skyrmion Core regions on obj_yig_film for scoped material overrides
:width: 92%
```

(python-api-materials-material-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *The European Physical Journal B* **92**(6), 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6) | [Open-access Springer PDF](https://link.springer.com/content/pdf/10.1140/epjb/e2019-90599-6.pdf).

(python-api-materials-material-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/structure.py` | `class Material` | public constructor and IR lowering |
