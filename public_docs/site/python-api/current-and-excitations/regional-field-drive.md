---
title: Regional Field Drive
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Regional field drive

(public-docs-python-api-current-and-excitations-regional-field-drive)=
(python-api-current-and-excitations-regional-field-drive-problem-statement)=
## Problem statement

This is the typed, region-aware field-drive contract; target and waveform remain explicit.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-current-and-excitations-regional-field-drive-governing-equations)=
## Governing equations

```{math}
:label: eq-regional_field_drive

q_{\mathrm{IR}} = \mathrm{regional_field_drive}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object regional_field_drive. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-current-and-excitations-regional-field-drive-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-current-and-excitations-regional-field-drive-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-current-and-excitations-regional-field-drive-python-api)=
## Python API

### Constructor or function

fm.RegionalFieldDrive(...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```id``` | ```str``` | ```required``` | ```1``` | non-empty | stable drive ID | FEM/FDM CPU/GPU: IR; resolver-specific | ```id``` |
| ```name``` | ```str``` | ```required``` | ```1``` | non-empty | display name | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```target``` | ```FieldTarget``` | ```required``` | ```1``` | typed global/object/region target | spatial target | FEM/FDM CPU/GPU: IR; resolved field drive | ```target``` |
| ```amplitude_B_T``` | ```float``` | ```required``` | ```T``` | finite and non-negative | field amplitude | FEM/FDM CPU/GPU: IR; resolved field drive | ```amplitude``` |
| ```direction``` | ```tuple[float,float,float]``` | ```required``` | ```1``` | finite non-zero; normalized | field direction | FEM/FDM CPU/GPU: IR; resolved field drive | ```direction``` |
| ```spatial_profile``` | ```FieldProfile``` | ```required``` | ```1``` | typed profile | spatial envelope | FEM/FDM CPU/GPU: IR; resolved field drive | ```profile``` |
| ```waveform``` | ```Waveform``` | ```required``` | ```1``` | typed waveform with to_ir | time envelope | FEM/FDM CPU/GPU: IR; resolved field drive | ```waveform``` |
| ```time_origin``` | ```str``` | ```stage_local``` | ```1``` | stage_local or absolute | time origin | FEM/FDM CPU/GPU: IR; resolved field drive | ```time_origin``` |
| ```activation``` | ```Activation or None``` | ```None``` | ```1``` | typed activation when supplied | activation window | FEM/FDM CPU/GPU: IR; resolved field drive | ```activation``` |
| ```enabled``` | ```bool``` | ```True``` | ```1``` | boolean | activation flag | FEM/FDM CPU/GPU: IR; resolved field drive | ```enabled``` |

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
value = fm.RegionalFieldDrive(id="rf", name="rf", target=fm.FieldTarget.global_domain(), amplitude_B_T=1.0e-3, direction=(0.0, 0.0, 1.0), spatial_profile=fm.UniformFieldProfile(), waveform=fm.Constant())
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-current-and-excitations-regional-field-drive-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed regional_field_drive record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-current-and-excitations-regional-field-drive-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-current-and-excitations-regional-field-drive-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-current-and-excitations-regional-field-drive-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/antenna.py symbol class RegionalFieldDrive. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-current-and-excitations-regional-field-drive-validation)=
## Validation

Focused repository tests covering this contract include: test_global_uniform_sinc_drive_has_canonical_wire_shape, test_invalid_inputs_fail_closed. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-current-and-excitations-regional-field-drive-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-current-and-excitations-regional-field-drive-scientific-bibliography)=
## Scientific bibliography

- D. M. Pozar, Microwave Engineering, 5th ed., DOI: https://doi.org/10.1007/978-3-030-88467-0

(python-api-current-and-excitations-regional-field-drive-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/antenna.py | class RegionalFieldDrive | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/antenna.py::class RegionalFieldDrive
- Source-map: current-and-excitations/regional-field-drive.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
