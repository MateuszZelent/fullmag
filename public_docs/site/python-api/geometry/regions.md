---
title: Regions
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Geometry regions

(public-docs-python-api-geometry-regions)=
(python-api-geometry-regions-problem-statement)=
## Problem statement

Regions are owner-scoped typed records; registration and realization remain separate operations.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-geometry-regions-governing-equations)=
## Governing equations

```{math}
:label: eq-object_region

q_{\mathrm{IR}} = \mathrm{object_region}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object object_region. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-geometry-regions-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-geometry-regions-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-geometry-regions-python-api)=
## Python API

### Constructor or function

fm.Region(name, geometry) and fm.ObjectRegion(...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```Region.name``` | ```str``` | ```required``` | ```1``` | non-empty | region name | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```Region.geometry``` | ```Geometry``` | ```required``` | ```1``` | typed geometry | region shape | FEM/FDM CPU/GPU: IR; resolver-specific | ```shape``` |
| ```ObjectRegion.owner_object``` | ```str or object``` | ```required``` | ```1``` | owner-scoped | owning object | FEM/FDM CPU/GPU: IR; resolver-specific | ```owner``` |
| ```ObjectRegion.name``` | ```str``` | ```required``` | ```1``` | non-empty | region name | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```ObjectRegion.region_id``` | ```str or None``` | ```None``` | ```1``` | stable when supplied | region identifier | FEM/FDM CPU/GPU: IR; resolver-specific | ```region_id``` |
| ```ObjectRegion.frame``` | ```str``` | ```object``` | ```1``` | supported frame | coordinate frame | FEM/FDM CPU/GPU: IR; resolver-specific | ```frame``` |
| ```ObjectRegion.enabled``` | ```bool``` | ```True``` | ```1``` | boolean | activation flag | FEM/FDM CPU/GPU: IR; resolver-specific | ```enabled``` |
| ```ObjectRegion.priority``` | ```int``` | ```0``` | ```1``` | integer | overlap precedence | FEM/FDM CPU/GPU: IR; resolver-specific | ```priority``` |
| ```ObjectRegion.realization_policy``` | ```str``` | ```inherit``` | ```1``` | supported policy | mesh/realization inheritance | FEM/FDM CPU/GPU: IR; resolver-specific | ```realization_policy``` |

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
value = fm.Region("film", fm.Box(size=(100e-9, 20e-9, 5e-9)))
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-geometry-regions-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed object_region record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-geometry-regions-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-geometry-regions-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-geometry-regions-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/structure.py symbol class ObjectRegion. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-geometry-regions-validation)=
## Validation

Focused repository tests covering this contract include: test_region_registries_are_owner_scoped_and_study_read_only, test_region_shape_translation_adds_to_existing_center. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-geometry-regions-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-geometry-regions-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, Gmsh: a three-dimensional finite element mesh generator, Int. J. Numer. Meth. Eng. 79 (2009), DOI: https://doi.org/10.1002/nme.2579

(python-api-geometry-regions-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/structure.py | class ObjectRegion | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/structure.py::class ObjectRegion
- Source-map: geometry/regions.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
