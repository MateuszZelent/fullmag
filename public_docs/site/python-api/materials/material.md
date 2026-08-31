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

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-materials-material-governing-equations)=
## Governing equations

```{math}
:label: eq-material

q_{\mathrm{IR}} = \mathrm{material}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object material. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-materials-material-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-materials-material-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-materials-material-python-api)=
## Python API

### Constructor or function

fm.Material(name, Ms, A, alpha, ...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```name``` | ```str``` | ```required``` | ```1``` | non-empty | material identifier | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```Ms``` | ```float or field``` | ```required``` | ```A/m``` | positive or typed field | saturation magnetization | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ms``` |
| ```A``` | ```float or field``` | ```required``` | ```J/m``` | positive or typed field | exchange stiffness | FEM/FDM CPU/GPU: IR; resolver-specific | ```A``` |
| ```alpha``` | ```float or field``` | ```required``` | ```1``` | finite and non-negative | Gilbert damping | FEM/FDM CPU/GPU: IR; resolver-specific | ```alpha``` |
| ```Ku1/Ku2/Kc1/Kc2/Kc3``` | ```float or field or None``` | ```None``` | ```J/m^3``` | finite when supplied | anisotropy constants | FEM/FDM CPU/GPU: IR; resolver-specific | ```anisotropy``` |
| ```Dind/Dbulk``` | ```float or field or None``` | ```None``` | ```J/m^2``` | finite when supplied | DMI constants | FEM/FDM CPU/GPU: IR; resolver-specific | ```dmi``` |

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

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.


(complete-qualified-material-signature)=
### Complete qualified Material signature

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```Material.name``` | ```str``` | ```required``` | ```1``` | non-empty | material identifier | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```Material.Ms``` | ```float or field``` | ```required``` | ```A/m``` | positive or typed field | saturation magnetization | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ms``` |
| ```Material.A``` | ```float or field``` | ```required``` | ```J/m``` | positive or typed field | exchange stiffness | FEM/FDM CPU/GPU: IR; resolver-specific | ```A``` |
| ```Material.alpha``` | ```float or field``` | ```required``` | ```1``` | finite and non-negative | Gilbert damping | FEM/FDM CPU/GPU: IR; resolver-specific | ```alpha``` |
| ```Material.Ku1``` | ```float or field or None``` | ```None``` | ```J/m^3``` | finite when supplied | first uniaxial constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ku1``` |
| ```Material.Ku2``` | ```float or field or None``` | ```None``` | ```J/m^3``` | finite when supplied | second uniaxial constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ku2``` |
| ```Material.anisU``` | ```tuple or None``` | ```None``` | ```1``` | typed when supplied | uniaxial axes | FEM/FDM CPU/GPU: IR; resolver-specific | ```anisU``` |
| ```Material.Kc1``` | ```float or field or None``` | ```None``` | ```J/m^3``` | finite when supplied | first cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Kc1``` |
| ```Material.Kc2``` | ```float or field or None``` | ```None``` | ```J/m^3``` | finite when supplied | second cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Kc2``` |
| ```Material.Kc3``` | ```float or field or None``` | ```None``` | ```J/m^3``` | finite when supplied | third cubic constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Kc3``` |
| ```Material.anisC1``` | ```tuple or None``` | ```None``` | ```1``` | typed when supplied | first cubic axis | FEM/FDM CPU/GPU: IR; resolver-specific | ```anisC1``` |
| ```Material.anisC2``` | ```tuple or None``` | ```None``` | ```1``` | typed when supplied | second cubic axis | FEM/FDM CPU/GPU: IR; resolver-specific | ```anisC2``` |
| ```Material.Dind``` | ```float or field or None``` | ```None``` | ```J/m^2``` | finite when supplied | interfacial DMI constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Dind``` |
| ```Material.Dbulk``` | ```float or field or None``` | ```None``` | ```J/m^2``` | finite when supplied | bulk DMI constant | FEM/FDM CPU/GPU: IR; resolver-specific | ```Dbulk``` |
| ```Material.Ms_field``` | ```field or None``` | ```None``` | ```A/m``` | typed when supplied | spatial saturation magnetization field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ms_field``` |
| ```Material.A_field``` | ```field or None``` | ```None``` | ```J/m``` | typed when supplied | spatial exchange field | FEM/FDM CPU/GPU: IR; resolver-specific | ```A_field``` |
| ```Material.alpha_field``` | ```field or None``` | ```None``` | ```1``` | typed when supplied | spatial damping field | FEM/FDM CPU/GPU: IR; resolver-specific | ```alpha_field``` |
| ```Material.Ku_field``` | ```field or None``` | ```None``` | ```J/m^3``` | typed when supplied | spatial Ku1 field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ku_field``` |
| ```Material.Ku2_field``` | ```field or None``` | ```None``` | ```J/m^3``` | typed when supplied | spatial Ku2 field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Ku2_field``` |
| ```Material.Kc1_field``` | ```field or None``` | ```None``` | ```J/m^3``` | typed when supplied | spatial Kc1 field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Kc1_field``` |
| ```Material.Kc2_field``` | ```field or None``` | ```None``` | ```J/m^3``` | typed when supplied | spatial Kc2 field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Kc2_field``` |
| ```Material.Kc3_field``` | ```field or None``` | ```None``` | ```J/m^3``` | typed when supplied | spatial Kc3 field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Kc3_field``` |
| ```Material.Dind_field``` | ```field or None``` | ```None``` | ```J/m^2``` | typed when supplied | spatial interfacial DMI field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Dind_field``` |
| ```Material.Dbulk_field``` | ```field or None``` | ```None``` | ```J/m^2``` | typed when supplied | spatial bulk DMI field | FEM/FDM CPU/GPU: IR; resolver-specific | ```Dbulk_field``` |

(python-api-materials-material-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed material record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-materials-material-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-materials-material-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-materials-material-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/structure.py symbol class Material. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-materials-material-validation)=
## Validation

Focused repository tests covering this contract include: test_material_constructor_and_field_overrides_round_trip, test_material_rejects_invalid_required_parameters. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-materials-material-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-materials-material-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., Thermal Fluctuations of a Single-Domain Particle, Phys. Rev. 130 (1963), DOI: https://doi.org/10.1103/PhysRev.130.1677

(python-api-materials-material-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/structure.py | class Material | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/structure.py::class Material
- Source-map: materials/material.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
