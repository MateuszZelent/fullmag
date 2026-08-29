---
title: Prescribed Current
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
---

(public-docs-python-api-current-and-excitations-prescribed-current)=
# Prescribed Current

(python-api-current-and-excitations-prescribed-current-problem-statement)=
<!-- (problem-statement)= -->
## Contract
Prescribed current is the uniform prescribed-current-density lane of `CurrentTransport`.

(python-api-current-and-excitations-prescribed-current-governing-equations)=
<!-- (governing-equations)= -->
## Governing equations
Current-to-torque conversion belongs to the spin-transfer/spin-orbit torque pages.

(python-api-current-and-excitations-prescribed-current-symbols-and-si-units)=
<!-- (symbols-and-si-units)= -->
## Symbols and SI units
Current density is in $\mathrm{A\,m^{-2}}$; solve-region and identity are names.

(python-api-current-and-excitations-prescribed-current-assumptions-and-validity)=
<!-- (assumptions-and-validity)= -->
## Assumptions and validity
A finite length-3 current-density vector is required for this model.

(python-api-current-and-excitations-prescribed-current-python-api)=
<!-- (python-api)= -->
## Python API
| Python | Type | Default | SI unit | Validation | Meaning | ProblemIR |
|---|---|---|---|---|---|---|
| `CurrentTransport(model="prescribed_density").current_density` | `tuple[float,float,float]` | required | $\mathrm{A\,m^{-2}}$ | Finite length-3 | Prescribed density | current density |
| `CurrentTransport.solve_region` | `str \| None` | `None` | $1$ | Non-empty when set | Solve region | domain |

### Complete stage-first example

```python
# %% Prescribed uniform current density
import fullmag as fm

nm = 1.0e-9

study = fm.study("prescribed_current_api_example")
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

(python-api-current-and-excitations-prescribed-current-problem-ir)=
<!-- (problem-ir)= -->
## ProblemIR
The module lowers to a `current_modules` entry with `model="prescribed_density"` and the resolved
density vector.

(python-api-current-and-excitations-prescribed-current-round-trip-and-failure-semantics)=
<!-- (round-trip-and-failure-semantics)= -->
## Round-trip and failure semantics
Missing or malformed density fails immediately.

(python-api-current-and-excitations-prescribed-current-discrete-realization)=
<!-- (discrete-realization)= -->
## Discrete realization
The public FDM path applies the density to the active cells of the solve region.

(python-api-current-and-excitations-prescribed-current-implementation-mapping)=
<!-- (implementation-mapping)= -->
## Implementation mapping
Anchor: `packages/fullmag-py/src/fullmag/model/current_transport.py` (`CurrentTransport` with
`model="prescribed_density"`).

(python-api-current-and-excitations-prescribed-current-validation)=
<!-- (validation)= -->
## Validation
Ownership and transport tests compare this inventory with live signatures.

(python-api-current-and-excitations-prescribed-current-limitations)=
<!-- (limitations)= -->
## Limitations
This is the uniform prescribed lane only; solved Ohmic Poisson is a separate model.

(python-api-current-and-excitations-prescribed-current-scientific-bibliography)=
<!-- (scientific-bibliography)= -->
## Scientific bibliography
Torque coupling belongs to the spin-torque pages.

(python-api-current-and-excitations-prescribed-current-source-code-index)=
<!-- (source-code-index)= -->

## Control Room crosswalk

Status: Field-drive and transport panels cover a partial subset of the excitation API.

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Parameters documented on this page | `Model Explorer -> Stages -> Add field drive / Transport` | `partial` | Submit drive/transport draft; affected stage and field resources are invalidated |
| Parameters without a named UI field | `Model Explorer -> Stages -> Add field drive / Transport` | `TODO` | Python-only until implemented |

TODO: frontend support for excitation parameters without a named drive/transport field.
See [Control Room capability register](/frontend/capability-register) for the support matrix and TODO policy.
Frontend source owner: `apps/control-room/src/modules/inspector/panels/TransportAuthoringInspector.tsx (TransportAuthoringInspector)`.

## Source-code index
| Claim | Path | Stable symbol | Responsibility | Evidence |
|---|---|---|---|---|
| Prescribed density | `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | Prescribed-current lowering | Ownership test |
