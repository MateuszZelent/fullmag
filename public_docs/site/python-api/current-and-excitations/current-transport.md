---
title: Current Transport
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Current transport

(public-docs-python-api-current-and-excitations-current-transport)=
(python-api-current-and-excitations-current-transport-problem-statement)=
## Problem statement

The constructor rejects ambiguous definitions and keeps prescribed and solved transport distinct.

Construction validates typed charge-transport inputs in Python; calling `to_ir()` lowers the object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-current-and-excitations-current-transport-governing-equations)=
## Governing equations

`CurrentTransport` either records a prescribed uniform current density $\mathbf{J}_c$ (`model="prescribed_density"`) or configures steady charge conservation $\nabla\cdot\mathbf{J}_c = 0$ with Ohmic/magnetoresistive constitutive relation $\mathbf{J}_c = -\sigma\nabla V$ (`model="ohmic_poisson"` / `"magnetoresistive_poisson"`). In `bidirectional` coupling mode, charge transport couples reciprocally with spin accumulation and magnetization dynamics as formulated in {doc}`../../physics/interactions/drift-diffusion-spin-torque/index` and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-current-transport-symbols-and-si-units)=
## Symbols and SI units

Current density $\mathbf{J}_c$ uses $\mathrm{A\,m^{-2}}$; electrical conductivity $\sigma$ (`conductivity_s_per_m`) uses $\mathrm{S\,m^{-1}}$; electric potential $V$ uses $\mathrm{V}$; module names, region selectors, model selectors, and coupling flags are dimensionless ($1$).

(python-api-current-and-excitations-current-transport-assumptions-and-validity)=
## Assumptions and validity

All numeric inputs must be finite and typed, and electrical conductivities must be strictly positive when supplied. Prescribed current densities are forbidden under `ohmic_poisson`, `bidirectional` coupling requires an Ohmic solve, and contradictory transport definitions fail closed at construction or lowering.

(python-api-current-and-excitations-current-transport-python-api)=
## Python API

### Constructor or function

`fm.CurrentTransport(*, name, model="prescribed_density", current_density=None, solve_region=None, conductivity_s_per_m=None, coupling="one_way", ...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | module identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `model` | `str` | `prescribed_density` | $1$ | `prescribed_density`, `ohmic_poisson`, or `magnetoresistive_poisson` | transport equation family | FEM/FDM CPU/GPU: IR; resolved module | `model` |
| `current_density` | `tuple[float,float,float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | required by prescribed; forbidden by ohmic | prescribed density | FEM/FDM CPU/GPU: IR; resolved module | `current_density` |
| `solve_region` | `str or None` | `None` | $1$ | non-empty when supplied | solution region | FEM/FDM CPU/GPU: IR; resolved module | `solve_region` |
| `conductivity_s_per_m` | `float or field` | `None` | $\mathrm{S\,m^{-1}}$ | positive when supplied | conductivity | FEM/FDM CPU/GPU: IR; resolved module | `conductivity` |
| `coupling` | `str` | `one_way` | $1$ | `one_way` or `bidirectional`; bidirectional requires ohmic | coupling direction | FEM/FDM CPU/GPU: IR; resolved module | `coupling` |
| `domain/materials/boundaries/gauge/solver` | `typed values` | `empty/None` | $\mathrm{S\,m^{-1}}$, $\mathrm{A\,m^{-2}}$, or $1$ | complete for `ohmic_poisson` | Poisson charge contract | FEM/FDM CPU/GPU: IR; resolved module | `transport` |

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
value = fm.CurrentTransport(name="ohmic", model="prescribed_density", current_density=(1.0e10, 0.0, 0.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, attach `canonical_ir` through the corresponding study transport registration API.

(python-api-current-and-excitations-current-transport-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "current_transport"`, `"name"`, `"model"`, `"coupling"`, and the corresponding prescribed or Poisson charge-transport subfields (`"current_density"`, `"solve_region"`, `"conductivity_s_per_m"`, `"domain"`, `"materials"`, `"boundaries"`, `"gauge"`, `"solver"`).

(python-api-current-and-excitations-current-transport-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing required fields, non-finite vectors, non-positive conductivities, and inconsistent `model`/`coupling` options, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-current-transport-discrete-realization)=
## Discrete realization

The Python contract supplies transport configuration and canonical `ProblemIR` only; discrete finite-volume/finite-element charge-Poisson and coupled spin-diffusion solves are owned by the backend lanes documented in {doc}`../../physics/interactions/drift-diffusion-spin-torque/index` and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-current-transport-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/current_transport.py` (`class CurrentTransport`). Constructor parameters, validation branches, defaults, and `to_ir()` keys come directly from that class.

(python-api-current-and-excitations-current-transport-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_ohmic_poisson_serializes_complete_charge_contract`, `test_ohmic_poisson_rejects_ambiguous_legacy_definition`, and `test_bidirectional_contract_round_trips_through_script_and_scene`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-current-transport-limitations)=
## Limitations and Control Room

Steady and time-modulated electrical current transport records (`current_transport`) are edited in Control Room through `TransportAuthoringInspector` (`current-transport` selection route), which supports closure selection, structured current-source cuts, active-lane capability gating, and readiness validation via `transport-authoring-validation.v1`. Spatial conductivity profiles or closures without exposed UI widgets remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Current transport parameters, contacts, & validation checks | `Model Explorer -> Current Transport -> <transport>` (`TransportAuthoringInspector`) | `partial` | `runAuthoringMutationWithHistory` and `transport-authoring-validation.v1` request |
| Parameters without a named UI field | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room TransportAuthoringInspector and SpinAuthoringInspector showing current transport, spin transport, and torque bindings
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-current-transport-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, “Theory of the perpendicular magnetoresistance in magnetic multilayers,” *Physical Review B* **48**(10), 7099–7113 (1993), [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
- S. Takahashi and S. Maekawa, “Spin injection and detection in magnetic nanostructures,” *Physical Review B* **67**(5), 052409 (2003), [doi:10.1103/PhysRevB.67.052409](https://doi.org/10.1103/PhysRevB.67.052409).
- C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, A. Manchon, D. Praetorius, and D. Suess, “A self-consistent spin-diffusion model for micromagnetics,” *Scientific Reports* **6**(1), 16 (2016), [doi:10.1038/s41598-016-0019-y](https://doi.org/10.1038/s41598-016-0019-y) | [arXiv:1512.05519](https://arxiv.org/abs/1512.05519).

(python-api-current-and-excitations-current-transport-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | public constructor and IR lowering |
