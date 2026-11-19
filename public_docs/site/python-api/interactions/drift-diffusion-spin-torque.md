---
title: Drift-diffusion spin torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Drift-diffusion spin torque

(public-docs-python-api-interactions-drift-diffusion-spin-torque)=
(python-api-interactions-drift-diffusion-spin-torque-problem-statement)=
## Problem statement

The module links charge current, spin materials, interfaces, and execution intent.

This page covers the Python authoring contract: construction validates region assignments, transport materials, interfaces, and regime constraints in Python, while `to_ir()` emits the canonical `spin_transport.v1` `ProblemIR` record before solver execution.

(python-api-interactions-drift-diffusion-spin-torque-governing-equations)=
## Governing equations

Self-consistent spin drift-diffusion couples charge current continuity $\nabla\cdot\mathbf{J}_c = 0$ with spin-accumulation balance $\nabla\cdot\mathbf{J}_s = -\mathbf{S}(\mathbf{m}, \boldsymbol{\mu}_s)$ across multilayer domains and spin-mixing interfaces, producing local exchange torque $\mathbf{T}_{\mathrm{SDD}} \propto \mathbf{m}\times\boldsymbol{\mu}_s$. Constitutive relations, interface conditions, and transient closures are documented in {doc}`../../physics/interactions/drift-diffusion-spin-torque/index`.

(python-api-interactions-drift-diffusion-spin-torque-symbols-and-si-units)=
## Symbols and SI units

The top-level module fields (`id`, `current_source_id`, `domain`, `materials`, `interfaces/boundaries`, `solver`, `requested_execution`, and `mode`) are dimensionless identifiers or typed collections ($1$). Nested `SpinTransportMaterial` entries carry conductivity $\sigma$ in $\mathrm{S\,m^{-1}}$, spin-diffusion length $\lambda_{\mathrm{sf}}$ in $\mathrm{m}$, and dimensionless polarization/Hall ratios ($1$).

(python-api-interactions-drift-diffusion-spin-torque-assumptions-and-validity)=
## Assumptions and validity

`id`, `current_source_id`, `domain`, and `materials` must be non-empty typed objects, and `mode` must be `"steady"` or `"transient"` (requiring physical capacitance metadata in `"transient"` mode). Missing constitutive closure or uncoupled charge sources fail closed at construction or planning.

(python-api-interactions-drift-diffusion-spin-torque-python-api)=
## Python API

### Constructor or function

`fm.SpinDriftDiffusion(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `id` | `str` | `required` | $1$ | non-empty | module identifier | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `id` |
| `current_source_id` | `str` | `required` | $1$ | non-empty | charge-current source link | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `current_source_id` |
| `domain` | `typed collection` | `required` | $1$ | non-empty | spin transport domain | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `domain` |
| `materials` | `typed collection` | `required` | $1$ | non-empty | spin transport materials | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `materials` |
| `interfaces/boundaries` | `typed collections` | `empty` | $1$ | typed entries | interface and boundary contracts | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `interfaces/boundaries` |
| `solver` | `object or None` | `None` | $1$ | typed solver when supplied | solver request | FEM/FDM CPU/GPU: IR; resolver-specific | `solver` |
| `requested_execution` | `object or None` | `None` | $1$ | typed execution request | requested device/precision | FEM/FDM CPU/GPU: IR; resolver-specific | `requested_execution` |
| `mode` | `str` | `steady` | $1$ | steady or transient; transient requires physical capacitance | time regime | FEM/FDM CPU/GPU: IR; resolved spin runtime required | `mode` |

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
film_region = fm.RegionRef("film")
spin_material = fm.SpinTransportMaterial(
    sigma_s_Spm=1.0e6,
    polarization_p=0.5,
    theta_sh=0.1,
    lambda_sf_m=5.0e-9,
)
value = fm.SpinDriftDiffusion(
    id="m1",
    current_source_id="j",
    domain=(film_region,),
    materials=(fm.SpinTransportMaterialAssignment(film_region, spin_material),),
    mode="steady",
)
canonical_ir = value.to_ir()
```

In a complete simulation script, attach the spin drift-diffusion module to the study alongside its referenced charge-current transport module.

(python-api-interactions-drift-diffusion-spin-torque-problem-ir)=
## ProblemIR

`value.to_ir()` emits a `"schema_version": "spin_transport.v1"` dictionary containing `"id"`, `"current_source_id"`, `"domain"`, `"mode"`, `"materials"`, `"interfaces"`, `"boundaries"`, `"solver"`, `"requested_execution"`, and `"constitutive_version"`.

(python-api-interactions-drift-diffusion-spin-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves region assignments, constitutive materials, interface conditions, and `requested_execution` independently of `resolved execution`. `Validation errors` reject missing current links or transient configurations lacking capacitance, while `unsupported combinations` fail closed when a backend lacks a coupled drift-diffusion runtime.

(python-api-interactions-drift-diffusion-spin-torque-discrete-realization)=
## Discrete realization

The Python contract supplies the constitutive module graph in `ProblemIR` only; coupled FEM/FDM elliptic spin-accumulation solves, interface flux assembly, and LLG torque coupling are implemented by the solver backends.

(python-api-interactions-drift-diffusion-spin-torque-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/spin_transport.py` (`class SpinDriftDiffusion`). Constructor arguments, constitutive validation, defaults, and `to_ir()` keys come directly from that module.

(python-api-interactions-drift-diffusion-spin-torque-validation)=
## Validation

Focused repository unit tests covering `SpinDriftDiffusion` authoring and interface lowering include `test_m1_module_serializes_canonical_typed_contract`, `test_spin_drift_diffusion_transient_requires_physical_capacitance`, and `test_spin_drift_diffusion_interface_round_trip`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-drift-diffusion-spin-torque-limitations)=
## Limitations and Control Room

Self-consistent spin drift-diffusion (`spin_transport`) and transparent/mixing spin interfaces are editable in Control Room via `TransportAuthoringInspector` (`spin-transport` selection route) and `SpinInterfaceInspectorPanel` (`spin-interface`, including FEM shared `tet4` interface facet normal verification), subject to lane readiness (`transport-authoring-validation.v1`). Transient capacitance or spatial material closures absent from those forms stay `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `spin_transport` & `SpinInterface` parameters + transport validation | `TransportAuthoringInspector` & `SpinInterfaceInspectorPanel` | `partial` | `runAuthoringMutationWithHistory` & `transport-authoring-validation.v1` |
| Parameters without a named UI field | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin Transport and Spin Interface inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-drift-diffusion-spin-torque-scientific-bibliography)=
## Scientific bibliography

- T. Valet and A. Fert, “Theory of the perpendicular magnetoresistance in magnetic multilayers,” *Physical Review B* **48**(10), 7099–7113 (1993), [doi:10.1103/PhysRevB.48.7099](https://doi.org/10.1103/PhysRevB.48.7099).
- S. Takahashi and S. Maekawa, “Spin injection and detection in magnetic nanostructures,” *Physical Review B* **67**(5), 052409 (2003), [doi:10.1103/PhysRevB.67.052409](https://doi.org/10.1103/PhysRevB.67.052409).
- C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, G. Hrkac, D. Praetorius, and D. Suess, “A three-dimensional spin-diffusion model for micromagnetics,” *Scientific Reports* **5**(1), 14855 (2015), [doi:10.1038/srep14855](https://doi.org/10.1038/srep14855) | [Open-access Nature PDF](https://www.nature.com/articles/srep14855.pdf).
- C. Abert, M. Ruggeri, F. Bruckner, C. Vogler, A. Manchon, D. Praetorius, and D. Suess, “A self-consistent spin-diffusion model for micromagnetics,” *Scientific Reports* **6**(1), 16 (2016), [doi:10.1038/s41598-016-0019-y](https://doi.org/10.1038/s41598-016-0019-y) | [Open-access Nature PDF](https://www.nature.com/articles/s41598-016-0019-y.pdf).

(python-api-interactions-drift-diffusion-spin-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/spin_transport.py` | `class SpinDriftDiffusion` | public constructor and IR lowering |
