---
title: Current Transport
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-current-transport)=
# Current Transport

(python-api-current-and-excitations-current-transport-problem-statement)=
<!-- (problem-statement)= -->
## Contract
`CurrentTransport` is the charge-current module that drives spin torque and device-level
workflows.

(python-api-current-and-excitations-current-transport-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Transport equations belong to {doc}`../../physics/interactions/drift-diffusion-spin-torque/index`.

(python-api-current-and-excitations-current-transport-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Current density is in $\mathrm{A\,m^{-2}}$; conductivity in $\mathrm{S\,m^{-1}}$.

(python-api-current-and-excitations-current-transport-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
The model identifier validates against the supported set; prescribed density requires a
current-density vector.

(python-api-current-and-excitations-current-transport-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `CurrentTransport.name` | `str` | `required` | $1$ | Non-empty | Module identity | module name |
| `CurrentTransport.model` | `str` | `"prescribed_density"` | $1$ | `prescribed_density`, `ohmic_poisson`, alias `magnetoresistive_poisson` | Transport model | model |
| `CurrentTransport.current_density` | `tuple[float,float,float] \| None` | `None` | $\mathrm{A\,m^{-2}}$ | Required for prescribed density | Prescribed current density | current density |
| `CurrentTransport.conductivity_s_per_m` | `float \| None` | `None` | $\mathrm{S\,m^{-1}}$ | — | Conductivity | conductivity |
| `CurrentTransport.coupling` | `str` | `"one_way"` | $1$ | `one_way` or `bidirectional` | Coupling policy | coupling |

### Complete stage-first example

```python
# %% Prescribed current density module
import fullmag as fm

nm = 1.0e-9

study = fm.study("current_transport_api_example")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")

nm = 1.0e-9

study.objects.mesh.defaults(cell_size=(2 * nm, 2 * nm, 5 * nm))
film = study.geometry(fm.Box(100 * nm, 20 * nm, 5 * nm), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.init.UniformMagnetization((1.0, 0.0, 0.0))
study.exchange()

study.current_transport(
    name="drive",
    model="prescribed_density",
    current_density=(1.0e12, 0.0, 0.0),
)
study.stages.add_run(stage_id="run", until=1.0e-12)
```

(python-api-current-and-excitations-current-transport-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The module lowers into the `current_modules` request with model, current density, domain,
materials, boundaries, gauge, and solver policy.

(python-api-current-and-excitations-current-transport-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Prescribed density without a current-density vector fails immediately; unsupported
bidirectional/reciprocal combinations are rejected by the planner.

(python-api-current-and-excitations-current-transport-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
`prescribed_density` executes on the public FDM path; `ohmic_poisson` /
`magnetoresistive_poisson` remain an authoring/reference contract whose backend qualification is
explicit.

(python-api-current-and-excitations-current-transport-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/current_transport.py` (`class CurrentTransport`).

(python-api-current-and-excitations-current-transport-validation)=
<!-- (validation)= -->
## Validation
Ownership and transport contract tests compare this inventory with live signatures.

(python-api-current-and-excitations-current-transport-limitations)=
<!-- (limitations)= -->
## Limitations
Bidirectional reciprocal transport is qualified only on the documented reference slices; lane
support is planner-resolved.

(python-api-current-and-excitations-current-transport-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Transport physics belongs to the drift-diffusion page.

(python-api-current-and-excitations-current-transport-source-code-index)=
<!-- (source-code-index)= -->
## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Current module | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | Module lowering | Ownership test |
