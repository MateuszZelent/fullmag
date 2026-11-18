---
title: Prescribed Current
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Prescribed current

(public-docs-python-api-current-and-excitations-prescribed-current)=
(python-api-current-and-excitations-prescribed-current-problem-statement)=
## Problem statement

A prescribed-density module records current intent directly; it is not a silent replacement for a solved ohmic problem.

Construction validates typed current parameters in Python; calling `to_ir()` lowers the object into its canonical `ProblemIR` record for study capture and planner validation.

(python-api-current-and-excitations-prescribed-current-governing-equations)=
## Governing equations

With `model="prescribed_density"`, `CurrentTransport` defines a spatially uniform charge current density $\mathbf{J}_c = (J_x, J_y, J_z)$ directly without solving the charge conservation PDE $\nabla\cdot(\sigma\nabla V)=0$. Downstream modules consume $\mathbf{J}_c$ for spin-transfer torque, spin-orbit torque, or Oersted field evaluation as documented in {doc}`../../physics/interactions/spin-transfer-torque/index`, {doc}`../../physics/interactions/spin-orbit-torque/index`, and {doc}`../../physics/interactions/oersted-field/index`.

(python-api-current-and-excitations-prescribed-current-symbols-and-si-units)=
## Symbols and SI units

Prescribed charge current density $\mathbf{J}_c$ is authored as a three-component Cartesian vector in $\mathrm{A\,m^{-2}}$; module identifiers (`name`), `model`, and `coupling` selectors are dimensionless ($1$).

(python-api-current-and-excitations-prescribed-current-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `current_density` must be a finite three-component vector when `model="prescribed_density"`, and contradictory options (such as `bidirectional` coupling without an ohmic solve) fail closed during construction or lowering.

(python-api-current-and-excitations-prescribed-current-python-api)=
## Python API

### Constructor or function

`fm.CurrentTransport(name=..., model="prescribed_density", current_density=...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | transport module ID | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `model` | `str` | `prescribed_density` | $1$ | supported model name | current closure | FEM/FDM CPU/GPU: IR; resolved module | `model` |
| `current_density` | `tuple[float,float,float]` | `None` | $\mathrm{A\,m^{-2}}$ | required for `prescribed_density`; finite | prescribed current density | FEM/FDM CPU/GPU: IR; resolved module | `current_density` |
| `coupling` | `str` | `one_way` | $1$ | `one_way` or `bidirectional` | coupling direction | FEM/FDM CPU/GPU: IR; resolved module | `coupling` |

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
value = fm.CurrentTransport(name="j", model="prescribed_density", current_density=(1.0e10, 0.0, 0.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, attach `canonical_ir` through the study current-transport registration interface or pass `current_source` by `name` to downstream spin-torque or Oersted modules.

(python-api-current-and-excitations-prescribed-current-problem-ir)=
## ProblemIR

`value.to_ir()` emits a typed dictionary with `"kind": "current_transport"`, `"name"`, `"model": "prescribed_density"`, `"current_density"`, and `"coupling"`.

(python-api-current-and-excitations-prescribed-current-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` is preserved in `ProblemIR` independently of `resolved execution`. `Validation errors` reject invalid types, missing current-density vectors, non-finite components, and incompatible `coupling` settings, while `unsupported combinations` fail closed at the planner or backend boundary.

(python-api-current-and-excitations-prescribed-current-discrete-realization)=
## Discrete realization

The Python contract supplies the uniform current density and canonical `ProblemIR` only; discrete evaluation of downstream torque or magnetic field terms is owned by the FEM/FDM backend lanes documented in {doc}`../../physics/interactions/spin-transfer-torque/index` and {doc}`../../physics/interactions/spin-orbit-torque/index`.

(python-api-current-and-excitations-prescribed-current-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/current_transport.py` (`class CurrentTransport`). Constructor parameters, validation branches, defaults, and `to_ir()` keys follow that class directly.

(python-api-current-and-excitations-prescribed-current-validation)=
## Validation

Focused repository unit tests covering authoring and IR serialization include `test_prescribed_density_serializes_to_ir` and `test_oersted_field_from_current_solution_serializes_to_ir`. Live solver execution and device parity require separate backend qualification.

(python-api-current-and-excitations-prescribed-current-limitations)=
## Limitations and Control Room

Prescribed current densities and upstream current-transport bindings for spin-torque (`SpinAuthoringInspector`: `zhang_li`, `slonczewski`, `prescribed_sot`) and Oersted calculations are configurable in Control Room via `TransportAuthoringInspector` and `SpinAuthoringInspector`. Spatially varying scripted current-density arrays without an exposed UI control remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Interaction |
|---|---|---|---|
| Prescribed current density vector / waveform & downstream torque binding | `TransportAuthoringInspector` & `SpinAuthoringInspector` | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| Arbitrary array or callable prescribed current profiles | Python DSL | `Python-only` | Authored directly in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Transport and Spin Torque inspectors configuring prescribed current sources and SOT/STT parameters
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-current-and-excitations-prescribed-current-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, “Theory of the perpendicular magnetoresistance in magnetic multilayers,” *Physical Review B* **48**(10), 7099–7113 (1993), [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
- S. Takahashi and S. Maekawa, “Spin injection and detection in magnetic nanostructures,” *Physical Review B* **67**(5), 052409 (2003), [doi:10.1103/PhysRevB.67.052409](https://doi.org/10.1103/PhysRevB.67.052409).

(python-api-current-and-excitations-prescribed-current-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/current_transport.py` | `class CurrentTransport` | public constructor and IR lowering |
