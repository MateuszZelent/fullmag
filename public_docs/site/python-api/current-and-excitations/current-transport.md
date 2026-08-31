---
title: Current Transport
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Current transport

(public-docs-python-api-current-and-excitations-current-transport)=
(python-api-current-and-excitations-current-transport-problem-statement)=
## Problem statement

The constructor rejects ambiguous definitions and keeps prescribed and solved transport distinct.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-current-and-excitations-current-transport-governing-equations)=
## Governing equations

```{math}
:label: eq-current_transport

q_{\mathrm{IR}} = \mathrm{current_transport}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object current_transport. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-current-and-excitations-current-transport-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-current-and-excitations-current-transport-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-current-and-excitations-current-transport-python-api)=
## Python API

### Constructor or function

fm.CurrentTransport(...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```name``` | ```str``` | ```required``` | ```1``` | non-empty | module identifier | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```model``` | ```str``` | ```prescribed_density``` | ```1``` | prescribed_density, ohmic_poisson, or magnetoresistive_poisson | transport equation family | FEM/FDM CPU/GPU: IR; resolved module | ```model``` |
| ```current_density``` | ```tuple[float,float,float] or None``` | ```None``` | ```A/m^2``` | required by prescribed; forbidden by ohmic | prescribed density | FEM/FDM CPU/GPU: IR; resolved module | ```current_density``` |
| ```solve_region``` | ```str or None``` | ```None``` | ```1``` | non-empty when supplied | solution region | FEM/FDM CPU/GPU: IR; resolved module | ```solve_region``` |
| ```conductivity_s_per_m``` | ```float or field``` | ```None``` | ```S/m``` | positive when supplied | conductivity | FEM/FDM CPU/GPU: IR; resolved module | ```conductivity``` |
| ```coupling``` | ```str``` | ```one_way``` | ```1``` | one_way or bidirectional; bidirectional requires ohmic | coupling direction | FEM/FDM CPU/GPU: IR; resolved module | ```coupling``` |
| ```domain/materials/boundaries/gauge/solver``` | ```typed values``` | ```empty/None``` | ```various``` | complete for ohmic_poisson | Poisson charge contract | FEM/FDM CPU/GPU: IR; resolved module | ```transport``` |

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
value = fm.CurrentTransport(name="ohmic", model="prescribed_density", current_density=(1.0e10, 0.0, 0.0))
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-current-and-excitations-current-transport-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed current_transport record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-current-and-excitations-current-transport-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-current-and-excitations-current-transport-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-current-and-excitations-current-transport-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/current_transport.py symbol class CurrentTransport. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-current-and-excitations-current-transport-validation)=
## Validation

Focused repository tests covering this contract include: test_ohmic_poisson_serializes_complete_charge_contract, test_ohmic_poisson_rejects_ambiguous_legacy_definition, test_bidirectional_contract_round_trips_through_script_and_scene. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-current-and-excitations-current-transport-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-current-and-excitations-current-transport-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, Theory of the perpendicular magnetoresistance, Phys. Rev. B 48 (1993), DOI: https://doi.org/10.1103/PhysRevB.48.7099
- S. Takahashi and S. Maekawa, Spin current, Phys. Rev. B 67 (2003), DOI: https://doi.org/10.1103/PhysRevB.67.052409

(python-api-current-and-excitations-current-transport-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/current_transport.py | class CurrentTransport | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/current_transport.py::class CurrentTransport
- Source-map: current-and-excitations/current-transport.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
