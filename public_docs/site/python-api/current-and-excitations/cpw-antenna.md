---
title: CPW Antenna
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# CPW antenna

(public-docs-python-api-current-and-excitations-cpw-antenna)=
(python-api-current-and-excitations-cpw-antenna-problem-statement)=
## Problem statement

The CPW dimensions are validated at authoring time and retained as explicit IR geometry inputs.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-current-and-excitations-cpw-antenna-governing-equations)=
## Governing equations

```{math}
:label: eq-cpw_antenna

q_{\mathrm{IR}} = \mathrm{cpw_antenna}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object cpw_antenna. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-current-and-excitations-cpw-antenna-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-current-and-excitations-cpw-antenna-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-current-and-excitations-cpw-antenna-python-api)=
## Python API

### Constructor or function

fm.CPWAntenna(...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```signal_width/gap/ground_width``` | ```float``` | ```required``` | ```m``` | positive | CPW transverse dimensions | FEM/FDM CPU/GPU: IR; preview/resolver-specific | ```dimensions``` |
| ```thickness``` | ```float``` | ```required``` | ```m``` | positive | conductor thickness | FEM/FDM CPU/GPU: IR; preview/resolver-specific | ```thickness``` |
| ```height_above_magnet``` | ```float``` | ```required``` | ```m``` | non-negative | height over magnet | FEM/FDM CPU/GPU: IR; preview/resolver-specific | ```height_above_magnet``` |
| ```preview_length``` | ```float``` | ```required``` | ```m``` | positive | preview length | FEM/FDM CPU/GPU: IR; preview/resolver-specific | ```preview_length``` |
| ```center_x/center_y``` | ```float``` | ```0.0``` | ```m``` | finite | in-plane position | FEM/FDM CPU/GPU: IR; preview/resolver-specific | ```center``` |
| ```current_distribution``` | ```str``` | ```uniform``` | ```1``` | only uniform currently accepted | current distribution | FEM/FDM CPU/GPU: IR; resolver-specific | ```current_distribution``` |

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
value = fm.CPWAntenna(signal_width=2.0e-6, gap=1.0e-6, ground_width=5.0e-6, thickness=1.0e-7, height_above_magnet=1.0e-7, preview_length=20.0e-6)
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-current-and-excitations-cpw-antenna-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed cpw_antenna record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-current-and-excitations-cpw-antenna-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-current-and-excitations-cpw-antenna-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-current-and-excitations-cpw-antenna-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/antenna.py symbol class CPWAntenna. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-current-and-excitations-cpw-antenna-validation)=
## Validation

Focused repository tests covering this contract include: test_flat_antenna_object_prescribed_zeeman_mask_round_trip, test_flat_antenna_object_exports_scene_document_object. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-current-and-excitations-cpw-antenna-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-current-and-excitations-cpw-antenna-scientific-bibliography)=
## Scientific bibliography

- D. M. Pozar, Microwave Engineering, 5th ed., DOI: https://doi.org/10.1007/978-3-030-88467-0

(python-api-current-and-excitations-cpw-antenna-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/antenna.py | class CPWAntenna | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/antenna.py::class CPWAntenna
- Source-map: current-and-excitations/cpw-antenna.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
