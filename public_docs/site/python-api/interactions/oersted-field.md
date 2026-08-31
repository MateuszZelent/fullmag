---
title: Oersted field Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Oersted field

(oersted-api-problem-statement)=
## Problem statement

The source must name a current-transport solution; an unlinked Oersted field is rejected.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-interactions-oersted-field-governing-equations)=
## Governing equations

```{math}
:label: eq-oersted_field

q_{\mathrm{IR}} = \mathrm{oersted_field}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object oersted_field. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-interactions-oersted-field-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-interactions-oersted-field-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-interactions-oersted-field-python-api)=
## Python API

### Constructor or function

fm.OerstedField(source, model="from_current_solution", id=None)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```source``` | ```str``` | ```required``` | ```1``` | non-empty current transport source | current solution identifier | FEM/FDM CPU/GPU: IR; solved transport runtime required | ```source``` |
| ```model``` | ```str``` | ```from_current_solution``` | ```1``` | current source model | field reconstruction model | FEM/FDM CPU/GPU: IR; solved transport runtime required | ```model``` |
| ```id``` | ```str or None``` | ```None``` | ```1``` | non-empty when supplied; otherwise derived | stable interaction identifier | FEM/FDM CPU/GPU: IR; resolver-specific | ```id``` |

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
value = fm.OerstedField(source="ohmic")
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-interactions-oersted-field-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed oersted_field record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-interactions-oersted-field-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-interactions-oersted-field-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-interactions-oersted-field-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/energy.py symbol class OerstedField. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-interactions-oersted-field-validation)=
## Validation

Focused repository tests covering this contract include: test_oersted_field_from_current_solution_serializes_to_ir, test_oersted_field_requires_current_transport_source. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-interactions-oersted-field-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-interactions-oersted-field-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., Thermal Fluctuations of a Single-Domain Particle, Phys. Rev. 130 (1963), DOI: https://doi.org/10.1103/PhysRev.130.1677

(python-api-interactions-oersted-field-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/energy.py | class OerstedField | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/energy.py::class OerstedField
- Source-map: interactions/oersted-field.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
