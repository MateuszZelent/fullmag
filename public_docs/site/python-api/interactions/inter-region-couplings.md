---
title: Inter-region couplings Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Inter-region couplings

(public-docs-python-api-interactions-inter-region-couplings)=
(python-api-interactions-inter-region-couplings-problem-statement)=
## Problem statement

CouplingRegistry keeps cross-region endpoint identity and capability policy explicit.

This page documents the public Python authoring boundary, not an undocumented runtime promise. Construction creates typed authoring data, while to_ir() is the object-level lowering boundary consumed by the study/script pipeline.

(python-api-interactions-inter-region-couplings-governing-equations)=
## Governing equations

```{math}
:label: eq-coupling_registry

q_{\mathrm{IR}} = \mathrm{coupling_registry}(\text{qualified inputs})
```

The physical term or constraint is represented by the canonical IR object coupling_registry. The exact discrete operator, quadrature, mesh treatment, and solver selection are backend responsibilities; this page does not replace their qualification evidence.

(python-api-interactions-inter-region-couplings-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
|---|---|---|
| q | canonical typed authoring quantity | \mathrm{1} |

All dimensional inputs are documented in SI units. Vector quantities use Cartesian components in the repository coordinate convention. Dimensionless parameters are explicitly marked 1; a default of None means that the constructor selects or omits the field according to the contract.

(python-api-interactions-inter-region-couplings-assumptions-and-validity)=
## Assumptions and validity

Inputs are finite and typed. Positive lengths, densities, conductivities, temperatures, and material constants are rejected when the source constructor requires positivity. Unsupported combinations fail closed in the constructor or lowering boundary rather than being silently converted.

(python-api-interactions-inter-region-couplings-python-api)=
## Python API

### Constructor or function

fm.CouplingRegistry().exchange/rkky/interlayer_exchange(...)

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| ```source/target``` | ```str or endpoint``` | ```required``` | ```1``` | typed, non-empty endpoints | coupling endpoints | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | ```source/target``` |
| ```mode``` | ```str``` | ```harmonic_mean``` | ```1``` | source validation modes | cross-interface averaging mode | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | ```mode``` |
| ```scale``` | ```float or None``` | ```None``` | ```1``` | finite when supplied | exchange scale | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | ```scale``` |
| ```J1/J2``` | ```float``` | ```J1 required; J2 None``` | ```J/m^2``` | finite when supplied | RKKY/interlayer constants | FEM/FDM CPU/GPU: IR; capability policy resolves runtime | ```J1/J2``` |
| ```coupling_id``` | ```str or None``` | ```None``` | ```1``` | non-empty when supplied | stable coupling ID | FEM/FDM CPU/GPU: IR; resolver-specific | ```coupling_id``` |
| ```enabled``` | ```bool``` | ```True``` | ```1``` | boolean | activation flag | FEM/FDM CPU/GPU: IR; resolver-specific | ```enabled``` |
| ```capability_policy``` | ```str``` | ```require_runtime``` | ```1``` | supported policy | runtime capability policy | FEM/FDM CPU/GPU: IR; resolver-specific | ```capability_policy``` |

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
value = fm.CouplingRegistry(); value.exchange("film.a", "film.b", mode="harmonic_mean")
canonical_ir = value.to_ir()
```

The example intentionally exposes the object-level boundary. In a full stage, attach canonical_ir through the corresponding study/module registration method; no implicit runtime route is inferred from this page.

(python-api-interactions-inter-region-couplings-problem-ir)=
## ProblemIR

value.to_ir() is the canonical serialization boundary. It emits a typed coupling_registry record with the fields listed above; nested geometry, targets, profiles, or material references remain nested typed records rather than opaque Python objects. The IR is the requested intent. Backend resolution must preserve the record or reject an unsupported combination.

(python-api-interactions-inter-region-couplings-round-trip-and-failure-semantics)=
## Round-trip and failure semantics
The requested intent is preserved before resolved execution. Validation errors identify invalid inputs, while unsupported combinations are rejected.


A supported record is expected to round-trip through the repository script/scene representation without changing qualified values, units, or identifiers. Invalid types, missing required fields, non-finite values, contradictory options, and unsupported backend combinations are rejected with an explicit validation error. This page makes no claim that every backend accepts every legal authoring object.

(python-api-interactions-inter-region-couplings-discrete-realization)=
## Discrete realization

The FEM/FDM realization selects its own mesh, stencil or element operator, boundary treatment, and CPU/GPU execution lane. The Python contract supplies the physical inputs and canonical IR only; numerical equivalence requires the backend-specific validation named below.

(python-api-interactions-inter-region-couplings-implementation-mapping)=
## Implementation mapping

The authoritative implementation is packages/fullmag-py/src/fullmag/model/couplings.py symbol class CouplingRegistry. The public constructor signature, validation branches, defaults, and to_ir() field names are derived from that source, not from a historical example.

(python-api-interactions-inter-region-couplings-validation)=
## Validation

Focused repository tests covering this contract include: test_class_api_exchange_coupling_lowers_to_ir, test_coupling_registry_round_trips_all_families. These tests are evidence for authoring/IR behavior; live runtime, device performance, and Control Room browser behavior require separate qualification.

(python-api-interactions-inter-region-couplings-limitations)=
## Limitations and Control Room

Control Room route: no dedicated route is claimed for this low-level authoring object. It is observable only through a session/problem/field view when the owning module exposes it; a dedicated object editor or route is not currently exposed. No unsupported UI or runtime capability is implied.

(python-api-interactions-inter-region-couplings-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown, Jr., Thermal Fluctuations of a Single-Domain Particle, Phys. Rev. 130 (1963), DOI: https://doi.org/10.1103/PhysRev.130.1677

(python-api-interactions-inter-region-couplings-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| packages/fullmag-py/src/fullmag/model/couplings.py | class CouplingRegistry | public constructor and IR lowering |

- Implementation: packages/fullmag-py/src/fullmag/model/couplings.py::class CouplingRegistry
- Source-map: interactions/inter-region-couplings.source-map.json
- Contract status: current constructor and to_ir() boundary documented against revision ab3c8802a691a535063102c12f9a79bb0043b367.
