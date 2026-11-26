---
title: Material
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Magnetic material

(public-docs-python-api-materials-material)=
(python-api-materials-material-problem-statement)=
## Problem statement

`Material` is the typed source of magnetic constitutive coefficients.

This page covers the Python authoring contract: construction validates required positive magnetic
constants, optional uniaxial/cubic anisotropy and DMI coefficients, and mesh-aligned spatial
compatibility arrays in Python, while `to_ir()` emits the canonical `ProblemIR` material record
with lowercase field keys (`saturation_magnetisation`, `exchange_stiffness`, `damping`, `ms_field`,
`a_field`, `alpha_field`, `ku_field`, `ku2_field`, `kc1_field`, `kc2_field`, `kc3_field`,
`dind_field`, `dbulk_field`).

(python-api-materials-material-governing-equations)=
## Governing equations

`Material` supplies the constitutive coefficients entering the continuum micromagnetic free energy
and Landau–Lifshitz–Gilbert equation: saturation magnetization $M_s$, isotropic exchange stiffness
$A$, Gilbert damping $\alpha$, uniaxial anisotropy ($K_{u1}, K_{u2}, \mathbf{u}$), cubic anisotropy
($K_{c1}, K_{c2}, K_{c3}, \mathbf{c}_1, \mathbf{c}_2$), and interfacial/bulk Dzyaloshinskii–Moriya
constants ($D_{\mathrm{ind}}, D_{\mathrm{bulk}}$), either as uniform scalars or spatial fields.
Continuum conventions and unit rules are documented in {doc}`../../physics/geometry-and-materials`,
{doc}`../../physics/foundations/conventions-and-units`, and {doc}`spatial-parameter-fields`.

(python-api-materials-material-symbols-and-si-units)=
## Symbols and SI units

Scalar parameters and corresponding spatial field overrides use SI units: saturation magnetization
(`Ms`, `Ms_field`) in $\mathrm{A\,m^{-1}}$, exchange stiffness (`A`, `A_field`) in
$\mathrm{J\,m^{-1}}$, anisotropy constants (`Ku1`, `Ku2`, `Kc1`, `Kc2`, `Kc3`, and `*_field`) in
$\mathrm{J\,m^{-3}}$, and DMI constants (`Dind`, `Dbulk`, `*_field`) in $\mathrm{J\,m^{-2}}$.
Material identifiers (`name`), Gilbert damping (`alpha`, `alpha_field`), and normalized crystal
axes (`anisU`, `anisC1`, `anisC2`) are dimensionless ($1$).

(python-api-materials-material-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `Ms` and `A` must be strictly positive (or typed non-negative spatial
fields with valid positive support), `alpha` must be finite and non-negative, and optional
anisotropy/DMI constants must be finite when supplied. Non-positive required constants, malformed
vector axes, or invalid field overrides fail closed at construction.

(python-api-materials-material-python-api)=
## Python API

### Constructor and `MagnetHandle` direct properties

- Canonical class constructor: `fm.Material(name, Ms, A, alpha, ...)`
- Fluent `MagnetHandle` direct properties (on `film = study.geometry(...)`):
  `film.Ms`, `film.Aex`, `film.alpha` (accepts scalar, `fm.fields.*` spatial fields such as
  `alpha_field`, or `film.alpha.absorbing_boundary(...)`), `film.Ku1`, `film.Ku2`, `film.anisU`,
  `film.Kc1`, `film.Kc2`, `film.Kc3`, `film.anisC1`, `film.anisC2`, `film.Dind` / `film.dind`,
  `film.Dbulk` / `film.dbulk`, `film.dmi_interface_normal`, plus `film.set_material_field(...)` for
  typed object- or region-scoped `MaterialParameterField` overrides.

### Stage-first example

```python
# %% Stage-first authoring with MagnetHandle properties and canonical Material.to_ir()
import fullmag as fm

study = fm.study("material_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.objects.mesh.defaults(cell_size=(2e-9, 2e-9, 5e-9))

body = study.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.Ku1 = 5.0e4
body.Ku2 = 1.0e3
body.anisU = (0.0, 0.0, 1.0)
body.Kc1 = 2.0e3
body.Kc2 = 5.0e2
body.Kc3 = 1.0e2
body.anisC1 = (1.0, 0.0, 0.0)
body.anisC2 = (0.0, 1.0, 0.0)
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)

# Verify lowercase ProblemIR keys on Material.to_ir():
mat = fm.Material(
    name="film",
    Ms=8.0e5,
    A=1.3e-11,
    alpha=0.02,
    alpha_field=[0.02],
)
canonical_ir = mat.to_ir()
assert canonical_ir["saturation_magnetisation"] == 8.0e5
assert canonical_ir["alpha_field"] == [0.02]
assert "ms_field" in canonical_ir and "dind_field" in canonical_ir
```

(complete-qualified-material-signature)=
### Complete qualified Material signature

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `Material.name` | `str` | `required` | $1$ | non-empty | material identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `Material.Ms` | `float or field` | `required` | $\mathrm{A\,m^{-1}}$ | positive or typed field | saturation magnetization | FEM/FDM CPU/GPU: IR; resolver-specific | `saturation_magnetisation` |
| `Material.A` | `float or field` | `required` | $\mathrm{J\,m^{-1}}$ | positive or typed field | exchange stiffness | FEM/FDM CPU/GPU: IR; resolver-specific | `exchange_stiffness` |
| `Material.alpha` | `float or field` | `required` | $1$ | finite and non-negative | Gilbert damping | FEM/FDM CPU/GPU: IR; resolver-specific | `damping` |
| `Material.Ku1` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | first uniaxial constant | FEM/FDM CPU/GPU: IR; resolver-specific | `uniaxial_anisotropy` |
| `Material.Ku2` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | second uniaxial constant | FEM/FDM CPU/GPU: IR; resolver-specific | `uniaxial_anisotropy_k2` |
| `Material.anisU` | `tuple or None` | `None` | $1$ | typed when supplied | uniaxial axes | FEM/FDM CPU/GPU: IR; resolver-specific | `anisotropy_axis` |
| `Material.Kc1` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | first cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | `cubic_anisotropy_kc1` |
| `Material.Kc2` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | second cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | `cubic_anisotropy_kc2` |
| `Material.Kc3` | `float or field or None` | `None` | $\mathrm{J\,m^{-3}}$ | finite when supplied | third cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | `cubic_anisotropy_kc3` |
| `Material.anisC1` | `tuple or None` | `None` | $1$ | typed when supplied | first cubic axis | FEM/FDM CPU/GPU: IR; resolver-specific | `cubic_anisotropy_axis1` |
| `Material.anisC2` | `tuple or None` | `None` | $1$ | typed when supplied | second cubic axis | FEM/FDM CPU/GPU: IR; resolver-specific | `cubic_anisotropy_axis2` |
| `Material.Dind` | `float or field or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | interfacial DMI constant | FEM/FDM CPU/GPU: IR; resolver-specific | `interfacial_dmi` |
| `Material.Dbulk` | `float or field or None` | `None` | $\mathrm{J\,m^{-2}}$ | finite when supplied | bulk DMI constant | FEM/FDM CPU/GPU: IR; resolver-specific | `bulk_dmi` |
| `Material.Ms_field` | `list[float] \| None` | `None` | $\mathrm{A\,m^{-1}}$ | finite numeric sequence when supplied | spatial saturation magnetization field | FEM/FDM CPU/GPU: IR; resolver-specific | `ms_field` |
| `Material.A_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-1}}$ | finite numeric sequence when supplied | spatial exchange field | FEM/FDM CPU/GPU: IR; resolver-specific | `a_field` |
| `Material.alpha_field` | `list[float] \| None` | `None` | $1$ | finite non-negative sequence when supplied | spatial damping field | FEM/FDM CPU/GPU: IR; resolver-specific | `alpha_field` |
| `Material.Ku_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite numeric sequence when supplied | spatial Ku1 field | FEM/FDM CPU/GPU: IR; resolver-specific | `ku_field` |
| `Material.Ku2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite numeric sequence when supplied | spatial Ku2 field | FEM/FDM CPU/GPU: IR; resolver-specific | `ku2_field` |
| `Material.Kc1_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite numeric sequence when supplied | spatial Kc1 field | FEM/FDM CPU/GPU: IR; resolver-specific | `kc1_field` |
| `Material.Kc2_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite numeric sequence when supplied | spatial Kc2 field | FEM/FDM CPU/GPU: IR; resolver-specific | `kc2_field` |
| `Material.Kc3_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-3}}$ | finite numeric sequence when supplied | spatial Kc3 field | FEM/FDM CPU/GPU: IR; resolver-specific | `kc3_field` |
| `Material.Dind_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite numeric sequence when supplied | spatial interfacial DMI field | FEM/FDM CPU/GPU: IR; resolver-specific | `dind_field` |
| `Material.Dbulk_field` | `list[float] \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite numeric sequence when supplied | spatial bulk DMI field | FEM/FDM CPU/GPU: IR; resolver-specific | `dbulk_field` |

(python-api-materials-material-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed material dictionary with strictly lowercase keys: `"name"`,
`"saturation_magnetisation"`, `"exchange_stiffness"`, `"damping"`, `"uniaxial_anisotropy"`,
`"uniaxial_anisotropy_k2"`, `"anisotropy_axis"`, `"cubic_anisotropy_kc1"`,
`"cubic_anisotropy_kc2"`, `"cubic_anisotropy_kc3"`, `"cubic_anisotropy_axis1"`,
`"cubic_anisotropy_axis2"`, `"interfacial_dmi"`, `"bulk_dmi"`, and lowercase array keys
`"ms_field"`, `"a_field"`, `"alpha_field"`, `"ku_field"`, `"ku2_field"`, `"kc1_field"`,
`"kc2_field"`, `"kc3_field"`, `"dind_field"`, and `"dbulk_field"`.

(python-api-materials-material-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves scalar constants, crystal axes, and spatial field records in `ProblemIR`
independently of `resolved execution`. `Validation errors` reject non-positive `Ms`/`A`, negative
`alpha`, or invalid field overrides, while `unsupported combinations` fail closed when a backend
path lacks support for spatial fields or specific DMI/anisotropy combinations.

(python-api-materials-material-discrete-realization)=
## Discrete realization

| Solver | Device | Material coefficient realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Uniform scalars and cellwise `*_field` / spatial parameter arrays on active cells | Interface harmonic exchange mean and per-interaction tests apply |
| FDM | GPU | Uniform scalars and single-grid cellwise arrays uploaded to CUDA (multilayer spatial fields gated) | Executed-device GPU parity validated separately |
| FEM | CPU | Per-element/per-node constitutive material assembly on magnetic subdomains | Mesh and quadrature convergence validated per interaction |
| FEM | GPU | Host-assembled constitutive parameters uploaded to CUDA FEM kernels | Executed-device GPU parity validated separately |

(python-api-materials-material-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/structure.py`
(`class Material`), with fluent study handle setters on `MagnetHandle` in
`packages/fullmag-py/src/fullmag/world.py` / `packages/fullmag-py/src/fullmag/live/_hooks.py`.

(python-api-materials-material-validation)=
## Validation

Focused repository unit tests covering `Material` authoring and spatial override serialization
include `test_material_constructor_and_field_overrides_round_trip`,
`test_material_rejects_invalid_required_parameters`, and `test_public_python_api_documentation.py`.

(python-api-materials-material-limitations)=
## Limitations and Control Room

- **Supported scalar material editing in Control Room:** `Model Explorer -> Objects -> <object> -> Material`
  renders `ObjectMaterialSpec`
  (`apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx`) and
  absorbing-boundary controls for supported scalar magnetic constants and ABL layers, while
  `RegionsRootSpec` / `RegionMagneticParametersSpec`
  (`apps/control-room/src/modules/inspector/inspectors/objects/regions/RegionMagneticParametersSpec.tsx`)
  override scalar magnetic parameters per labeled region.
- **Python-only surfaces:** Mesh-aligned compatibility `*_field` arrays, analytical spatial
  parameter fields, elastic/magnetoelastic tensors, and parameters without a named UI field remain
  `Python-only`; see {doc}`/frontend/inspectors/objects-and-materials` and
  {doc}`/frontend/capability-register`.

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
| [`packages/fullmag-py/src/fullmag/model/structure.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | [`class Material`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/structure.py#L16) | public constructor, validation, and lowercase IR lowering |
