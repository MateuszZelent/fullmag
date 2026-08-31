---
title: Mechanical Boundary Conditions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Mechanical boundary conditions and loads

(public-docs-python-api-boundary-conditions-mechanical-boundary-conditions)=
(problem-statement)=
## Problem statement

Mechanical authoring makes boundary kind and required payload explicit.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(governing-equations)=
## Governing equations

```{math}
:label: eq-mechanical_boundary

q_{\mathrm{IR}} = \mathrm{mechanical_boundary}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object mechanical_boundary. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

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

fm.MechanicalBoundaryCondition(...) and fm.MechanicalLoad(...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```MechanicalBoundaryCondition.kind``` | ```Literal[str]``` | ```required``` | ```1``` | prescribed_displacement or prescribed_traction | boundary data family | FEM CPU/GPU: IR; FDM not currently resolved | ```kind``` |
| ```MechanicalBoundaryCondition.surface``` | ```str``` | ```required``` | ```1``` | non-empty | surface selector | FEM CPU/GPU: IR; FDM not currently resolved | ```surface``` |
| ```MechanicalBoundaryCondition.u``` | ```tuple[float,float,float]``` | ```None``` | ```m``` | required for displacement; finite | displacement vector | FEM CPU/GPU: IR; FDM not currently resolved | ```u``` |
| ```MechanicalBoundaryCondition.t``` | ```tuple[float,float,float]``` | ```None``` | ```Pa``` | required for traction; finite | traction vector | FEM CPU/GPU: IR; FDM not currently resolved | ```t``` |
| ```MechanicalLoad.kind``` | ```Literal[str]``` | ```required``` | ```1``` | body_force, prescribed_strain, or prescribed_stress | volume load family | FEM CPU/GPU: IR; FDM not currently resolved | ```kind``` |
| ```MechanicalLoad.f/strain/stress``` | ```tuple[float,...]``` | ```None``` | ```N/m^3, 1, or Pa``` | payload required by kind; strain/stress six Voigt values | body force, strain, or stress | FEM CPU/GPU: IR; FDM not currently resolved | ```payload``` |

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
value = fm.MechanicalBoundaryCondition("prescribed_displacement", "clamp", u=(0.0, 0.0, 0.0))
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed mechanical_boundary record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/mechanics.py symbol class MechanicalBoundaryCondition. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(validation)=
## Validation

Focused repository tests covering this contract include: test_mechanical_boundary_condition_validation, test_mechanical_load_validation. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(scientific-bibliography)=
## Scientific bibliography

- L. D. Landau and E. M. Lifshitz, Theory of Elasticity, 3rd ed., DOI: https://doi.org/10.1016/C2013-0-03754-0

(source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/mechanics.py | class MechanicalBoundaryCondition | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/mechanics.py::class MechanicalBoundaryCondition
- Source-map: boundary-conditions/mechanical-boundary-conditions.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
