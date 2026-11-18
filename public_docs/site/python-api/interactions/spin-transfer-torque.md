---
title: Spin-Transfer Torque Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Spin-transfer torque

(stt-api-problem-statement)=
## Problem statement

The STT classes retain legacy object-level authoring and canonical module contracts; mutually exclusive current definitions fail closed.

This page covers the Python authoring contract: construction validates mutually exclusive current definitions, polarization vectors, and formula-specific constants in Python, while `to_ir_module()` emits the canonical `ProblemIR` module record.

(python-api-interactions-spin-transfer-torque-governing-equations)=
## Governing equations

Slonczewski and interface CPP spin-transfer torques describe damping-like and field-like angular momentum transfer from a spin-polarized current orthogonal or transverse to a fixed polarizer $\hat{\mathbf{p}}$, while Zhang–Li torque models adiabatic $(\mathbf{u}\cdot\nabla)\mathbf{m}$ and non-adiabatic $-\beta\,\mathbf{m}\times(\mathbf{u}\cdot\nabla)\mathbf{m}$ spin drift in smoothly varying magnetization textures. Continuum equations and formula versions are documented in {doc}`../../physics/interactions/spin-transfer-torque/index`.

(python-api-interactions-spin-transfer-torque-symbols-and-si-units)=
## Symbols and SI units

Prescribed current density (`current_density`) is authored in amperes per square metre ($\mathrm{A\,m^{-2}}$) and `free_layer_thickness_m` ($t_F$) in SI metres ($\mathrm{m}$). `current_source`, `spin_polarization` ($\hat{\mathbf{p}}$), `degree` ($P$), `lambda_asymmetry` ($\Lambda$), `epsilon_prime` ($\epsilon'$), `beta` ($\beta$), and `lande_g` ($g$) are dimensionless ($1$).

(python-api-interactions-spin-transfer-torque-assumptions-and-validity)=
## Assumptions and validity

`current_density` and `current_source` are mutually exclusive; `spin_polarization` must be a finite non-zero three-vector normalized to unit length; `free_layer_thickness_m` must be strictly positive in canonical thin-layer mode; and `lande_g` must be strictly positive in canonical Zhang–Li mode. Contradictory current sources or out-of-domain scalars fail closed.

(python-api-interactions-spin-transfer-torque-python-api)=
## Python API

### Constructor or function

`fm.SlonczewskiSTT(...)`, `fm.ZhangLiSTT(...)`, `fm.InterfaceCppSTT(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `current_density` | `tuple[float, float, float] or None` | `None` | $\mathrm{A\,m^{-2}}$ | finite vector; exclusive with current_source | direct current density vector | FEM/FDM CPU/GPU: IR; resolver-specific | `current_density` |
| `current_source` | `str or None` | `None` | $1$ | exclusive with current_density | named current source | FEM/FDM CPU/GPU: IR; resolver-specific | `current_source` |
| `spin_polarization` | `tuple[float,float,float]` | `(0,0,1)` | $1$ | finite non-zero; normalized | polarization direction | FEM/FDM CPU/GPU: IR; resolver-specific | `spin_polarization` |
| `degree` | `float` | `0.4` | $1$ | finite | polarization degree | FEM/FDM CPU/GPU: IR; resolver-specific | `degree` |
| `lambda_asymmetry` | `float` | `1.0` | $1$ | finite | Slonczewski asymmetry | FEM/FDM CPU/GPU: IR; resolver-specific | `lambda_asymmetry` |
| `epsilon_prime` | `float` | `0.0` | $1$ | finite | field-like efficiency | FEM/FDM CPU/GPU: IR; resolver-specific | `epsilon_prime` |
| `free_layer_thickness_m` | `float or None` | `None` | $\mathrm{m}$ | positive in canonical thin-layer mode | free-layer thickness | FEM/FDM CPU/GPU: IR; resolver-specific | `free_layer_thickness_m` |
| `beta` | `float` | `0.0` | $1$ | finite for ZhangLiSTT | nonadiabaticity parameter | FEM/FDM CPU/GPU: IR; resolver-specific | `beta` |
| `lande_g` | `float or None` | `None` | $1$ | positive in ZhangLi canonical mode | Landé factor | FEM/FDM CPU/GPU: IR; resolver-specific | `lande_g` |

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
value = fm.SlonczewskiSTT(current_density=(0.0, 0.0, 1.0e10), spin_polarization=(0.0, 0.0, 1.0))
canonical_ir = value.to_ir_module()
```

In a complete simulation script, register the lowered `SlonczewskiSTT`, `ZhangLiSTT`, or `InterfaceCppSTT` module on the study alongside its current density or current-transport source.

(python-api-interactions-spin-transfer-torque-problem-ir)=
## ProblemIR

`value.to_ir_module()` emits a typed spin-transfer-torque record with `"kind": "slonczewski"`, `"zhang_li"`, or `"interface_cpp_stt"`, plus formula versioning and the qualified fields listed above.

(python-api-interactions-spin-transfer-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves formula version, target scope, polarization parameters, and current definitions independently of `resolved execution`. `Validation errors` reject conflicting `current_density` and `current_source` inputs or zero polarization axes, while `unsupported combinations` fail closed at planning.

(python-api-interactions-spin-transfer-torque-discrete-realization)=
## Discrete realization

The Python contract supplies canonical spin-transfer module data in `ProblemIR` only; evaluating localized thin-layer fluxes, weak-gradient Zhang–Li operators, and LLG Gilbert prefactors is implemented by the solver backends.

(python-api-interactions-spin-transfer-torque-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/spin_torque.py` (`class SlonczewskiSTT`, `class ZhangLiSTT`, and `class InterfaceCppSTT`). Constructor parameters, validation branches, defaults, and `to_ir_module()` keys come directly from that module.

(python-api-interactions-spin-transfer-torque-validation)=
## Validation

Focused repository unit tests covering STT authoring and lowering include `test_slonczewski_canonical_defaults_and_legacy_fields`, `test_zhang_li_canonical_contract_and_alias_validation`, and `test_interface_cpp_stt_serializes_to_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-spin-transfer-torque-limitations)=
## Limitations and Control Room

Slonczewski ($\lambda$ asymmetry, $\epsilon'$, polarization, free-layer thickness, fixed-layer orientation) and Zhang–Li ($\beta$ non-adiabaticity) spin-transfer torques are editable in Control Room through `SpinAuthoringInspector` (`SpinTorqueInspectorPanel`), bound to prescribed current densities or an upstream `current_transport` record. Custom spatially resolved polarizer arrays or interface models without named UI controls stay `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `slonczewski` & `zhang_li` parameters and current binding | `Model Explorer -> Physics -> Spin Torque` (`SpinAuthoringInspector`, `SpinTorqueInspectorPanel`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| Spin interface parameters & FEM orientation verification | `SpinInterfaceInspectorPanel` | `partial` | `verifySpinInterfaceMeshOrientation` & scene transaction |
| Parameters without a named UI field | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin-Transfer and Spin-Orbit Torque inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-spin-transfer-torque-scientific-bibliography)=
## Scientific bibliography

- J. C. Slonczewski, “Current-driven excitation of magnetic multilayers,” *Journal of Magnetism and Magnetic Materials* **159**(1-2), L1–L7 (1996), [doi:10.1016/0304-8853(96)00062-5](https://doi.org/10.1016/0304-8853(96)00062-5).
- L. Berger, “Emission of spin waves by a magnetic multilayer traversed by a current,” *Physical Review B* **54**(13), 9353–9358 (1996), [doi:10.1103/PhysRevB.54.9353](https://doi.org/10.1103/PhysRevB.54.9353).
- S. Zhang and Z. Li, “Roles of Nonequilibrium Conduction Electrons on the Magnetization Dynamics of Ferromagnets,” *Physical Review Letters* **93**(12), 127204 (2004), [doi:10.1103/PhysRevLett.93.127204](https://doi.org/10.1103/PhysRevLett.93.127204) | [arXiv:cond-mat/0407174](https://arxiv.org/abs/cond-mat/0407174).

(python-api-interactions-spin-transfer-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class SlonczewskiSTT` | public constructor and IR lowering |
