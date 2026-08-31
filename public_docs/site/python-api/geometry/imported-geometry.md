---
title: Imported Geometry
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Imported geometry

(public-docs-python-api-geometry-imported-geometry)=
(python-api-geometry-imported-geometry-problem-statement)=
## Problem statement

Imported geometry records the source and volume policy; conversion is a later resolver step.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-geometry-imported-geometry-governing-equations)=
## Governing equations

```{math}
:label: eq-imported_geometry

q_{\mathrm{IR}} = \mathrm{imported_geometry}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object imported_geometry. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-geometry-imported-geometry-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-geometry-imported-geometry-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-geometry-imported-geometry-python-api)=
## Python API

### Constructor or function

fm.ImportedGeometry(source, scale=1.0, units=None, name=None, volume="full")

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```source``` | ```str or PathLike``` | ```required``` | ```1``` | non-empty | source asset path or identifier | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | ```source``` |
| ```scale``` | ```float or tuple[float,float,float]``` | ```1.0``` | ```1 or dimensionless vector``` | positive scalar/vector | import scale | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | ```scale``` |
| ```units``` | ```str or None``` | ```None``` | ```1``` | recognized unit when supplied | source units | FEM CPU/GPU: IR; FDM CPU/GPU: resolver-specific | ```units``` |
| ```name``` | ```str or None``` | ```None``` | ```1``` | non-empty when supplied | stable name | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```volume``` | ```str``` | ```full``` | ```1``` | current supported value full | surface/volume import policy | FEM/FDM CPU/GPU: IR; resolver-specific | ```volume``` |

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
value = fm.ImportedGeometry("mesh.step", scale=1.0e-9, units="nm", volume="full")
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-geometry-imported-geometry-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed imported_geometry record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-geometry-imported-geometry-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-geometry-imported-geometry-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-geometry-imported-geometry-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/geometry.py symbol class ImportedGeometry. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-geometry-imported-geometry-validation)=
## Validation

Focused repository tests covering this contract include: test_script_rewrite_preserves_imported_geometry_surface_volume. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-geometry-imported-geometry-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-geometry-imported-geometry-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, Gmsh: a three-dimensional finite element mesh generator, Int. J. Numer. Meth. Eng. 79 (2009), DOI: https://doi.org/10.1002/nme.2579

(python-api-geometry-imported-geometry-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/geometry.py | class ImportedGeometry | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/geometry.py::class ImportedGeometry
- Source-map: geometry/imported-geometry.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
