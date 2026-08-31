---
title: Spin-Orbit Torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Spin-orbit torque

(sot-api-problem-statement)=
## Problem statement

The prescribed SOT contract is canonical v1 and requires a typed target and drive.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-interactions-spin-orbit-torque-governing-equations)=
## Governing equations

```{math}
:label: eq-spin_orbit_torque

q_{\mathrm{IR}} = \mathrm{spin_orbit_torque}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object spin_orbit_torque. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-interactions-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-interactions-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-interactions-spin-orbit-torque-python-api)=
## Python API

### Constructor or function

fm.PrescribedSpinOrbitTorque(name, target, drive, ..., free_layer_thickness_m)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```name``` | ```str``` | ```required``` | ```1``` | non-empty | torque module identifier | FEM/FDM CPU/GPU: IR; resolver-specific | ```name``` |
| ```target``` | ```RegionRef``` | ```required``` | ```1``` | typed region reference | free-layer target | FEM/FDM CPU/GPU: IR; resolver-specific | ```target``` |
| ```drive``` | ```SignedScalarDrive or VectorCurrentDrive``` | ```required``` | ```A/m^2 or source``` | typed drive | FEM/FDM CPU/GPU: IR; resolver-specific | drive | ```see_constructor_to_ir``` |
| ```xi_dl``` | ```float``` | ```required``` | ```1``` | finite | damping-like efficiency | FEM/FDM CPU/GPU: IR; resolver-specific | ```xi_dl``` |
| ```xi_fl``` | ```float``` | ```0.0``` | ```1``` | finite | field-like efficiency | FEM/FDM CPU/GPU: IR; resolver-specific | ```xi_fl``` |
| ```free_layer_thickness_m``` | ```float``` | ```required``` | ```m``` | positive | free-layer thickness | FEM/FDM CPU/GPU: IR; resolver-specific | ```free_layer_thickness_m``` |

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
value = fm.PrescribedSpinOrbitTorque(name="sot", target=fm.RegionRef("film"), drive=fm.SignedScalarDrive(1.0e10, (0.0, 0.0, 1.0)), xi_dl=0.1, free_layer_thickness_m=5.0e-9)
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-interactions-spin-orbit-torque-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed spin_orbit_torque record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-interactions-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-interactions-spin-orbit-torque-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-interactions-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/spin_torque.py symbol class PrescribedSpinOrbitTorque. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-interactions-spin-orbit-torque-validation)=
## Validation

Focused repository tests covering this contract include: test_prescribed_sot_canonical_defaults_and_v1_wire_shape, test_prescribed_sot_rejects_invalid_target_and_drive_boundaries, test_prescribed_sot_rejects_legacy_migration_payload. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-interactions-spin-orbit-torque-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-interactions-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

- A. Manchon et al., Current-induced spin-orbit torques, Rev. Mod. Phys. 91 (2019), DOI: https://doi.org/10.1103/RevModPhys.91.035004

(python-api-interactions-spin-orbit-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/spin_torque.py | class PrescribedSpinOrbitTorque | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/spin_torque.py::class PrescribedSpinOrbitTorque
- Source-map: interactions/spin-orbit-torque.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
