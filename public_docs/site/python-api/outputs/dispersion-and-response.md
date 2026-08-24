---
title: Dispersion and Response
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-outputs-dispersion-and-response)=
# Dispersion and Response

(python-api-outputs-dispersion-and-response-problem-statement)=
<!-- (problem-statement)= -->
## Contract
This page records the dispersion-curve and frequency-response observables attached to eigenmode
and frequency-response studies.

(python-api-outputs-dispersion-and-response-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Response and dispersion definitions belong to {doc}`../../numerical-methods/frequency-domain/index`
and {doc}`../../numerical-methods/eigensolvers/index`.

(python-api-outputs-dispersion-and-response-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Eigenfrequency values are in hertz; response observables carry the units of their definition.

(python-api-outputs-dispersion-and-response-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
Response observable identifiers and dispersion names are validated immediately.

(python-api-outputs-dispersion-and-response-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|
| `SaveDispersion.name` | `str` | `"dispersion"` | Non-empty | Curve name | `dispersion_curve.name` |
| `SaveDispersion.include_branch_table` | `bool` | `True` | Stored as supplied; no runtime type check in this constructor | Include branch table | `dispersion_curve.include_branch_table` |
| `SaveResponse.observable` | `str` | `required` | One of the supported response observables | Response output | `frequency_response_output.observable` |

Supported response observables include `susceptibility_tensor`, `m_complex`, `u_complex`,
`strain_complex`, `stress_complex`, `absorbed_power_density`, `response_amplitude`,
`response_phase`, and `mode_hybridization_index`.

### Complete stage-first example

```python
# %% Frequency response with a susceptibility observable
import fullmag as fm

nm = 1.0e-9

study = fm.study("dispersion_response_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()
study.stages.add_relax(stage_id="relax", algorithm="projected_gradient_bb", max_steps=1000, tolT=1e-8)
study.save_response("susceptibility_tensor")
study.stages.add_frequency_response(
    frequencies_hz=[1.0e9, 2.0e9],
    excitation_field_au_per_m=(0.0, 1.0, 0.0),
    equilibrium_source="relax",
)
```

(python-api-outputs-dispersion-and-response-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
`SaveDispersion.to_ir()` emits `dispersion_curve`; `SaveResponse.to_ir()` emits
`frequency_response_output`. Both are carried in the study's `sampling.outputs`.

(python-api-outputs-dispersion-and-response-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Unknown response observables fail immediately; dispersion names are preserved without
interpretation.

(python-api-outputs-dispersion-and-response-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
Response materialization follows the frequency-domain solvers; dispersion follows the eigensolver.
The current planner routes both eigenmode and frequency-response studies through FEM and rejects
the FDM backend for these study kinds.

(python-api-outputs-dispersion-and-response-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/outputs.py` (`SaveDispersion`, `SaveResponse`).

(python-api-outputs-dispersion-and-response-validation)=
<!-- (validation)= -->
## Validation
Ownership tests compare this inventory with live signatures.

(python-api-outputs-dispersion-and-response-limitations)=
<!-- (limitations)= -->
## Limitations
Requesting an output does not guarantee the solver materializes it; planner and solver capability
resolution are authoritative.

(python-api-outputs-dispersion-and-response-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Definitions belong to the frequency-domain and eigensolver pages.

(python-api-outputs-dispersion-and-response-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Dispersion/response outputs | `packages/fullmag-py/src/fullmag/model/outputs.py` | `SaveDispersion`, `SaveResponse` | Output lowering | Ownership test |
