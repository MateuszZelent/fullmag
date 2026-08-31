---
title: Cubic anisotropy Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Cubic anisotropy

(public-docs-python-api-interactions-cubic-anisotropy)=
(problem-statement)=
## Problem statement

Cubic anisotropy stores its two authored axes and signed finite constants.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(governing-equations)=
## Governing equations

```{math}
:label: eq-cubic_anisotropy

q_{\mathrm{IR}} = \mathrm{cubic_anisotropy}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object cubic_anisotropy. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api)=
## Python API

### Constructor or function

fm.CubicAnisotropy(kc1, kc2=0.0, kc3=0.0, axis1=(1,0,0), axis2=(0,1,0))

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```fm.CubicAnisotropy.kc1/kc2/kc3``` | ```float``` | ```kc1 required; others 0.0``` | ```J/m^3``` | finite | cubic anisotropy constants | FEM/FDM CPU/GPU: IR; resolved support required | ```kc1/kc2/kc3``` |
| ```fm.CubicAnisotropy.axis1``` | ```tuple[float,float,float]``` | ```(1,0,0)``` | ```1``` | finite non-zero; normalized | first cubic axis | FEM/FDM CPU/GPU: IR; resolved support required | ```axis1``` |
| ```fm.CubicAnisotropy.axis2``` | ```tuple[float,float,float]``` | ```(0,1,0)``` | ```1``` | finite non-zero; normalized | second cubic axis | FEM/FDM CPU/GPU: IR; resolved support required | ```axis2``` |

### Stage-first example

```python
# %%
import fullmag as fm

study = fm.study("public-api-example")
study.mesh(hmax=5e-9)
body = fm.geometry(fm.Box(size=(100e-9, 20e-9, 5e-9)), name="film")
study.add(body)
study.stages.add_relax(stage_id="api-example", max_steps=1)
# Author the documented object after the stage exists.
value = fm.CubicAnisotropy(kc1=1.0e4, axis1=(1.0, 0.0, 0.0), axis2=(0.0, 1.0, 0.0))
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed cubic_anisotropy record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/energy.py symbol class CubicAnisotropy. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(validation)=
## Validation

Focused repository tests covering this contract include: test_anisotropy_terms_serialize_canonical_ir. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., Thermal Fluctuations of a Single-Domain Particle, Phys. Rev. 130 (1963), DOI: https://doi.org/10.1103/PhysRev.130.1677

(source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/energy.py | class CubicAnisotropy | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/energy.py::class CubicAnisotropy
- Source-map: interactions/cubic-anisotropy.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
