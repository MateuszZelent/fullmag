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

This page covers the Python authoring contract: construction validates the module name, typed target region, drive object, spin-orbit torque efficiencies, and free-layer thickness in Python, while `to_ir_module()` emits the canonical `prescribed_sot.v1` `ProblemIR` module record.

(python-api-interactions-spin-orbit-torque-governing-equations)=
## Governing equations

Prescribed spin–orbit torque applies damping-like ($\xi_{\mathrm{DL}}$) and field-like ($\xi_{\mathrm{FL}}$) torques proportional to an injected charge current density $\mathbf{J}_c$ over a free layer of thickness $t_F$: $\mathbf{T}_{\mathrm{SOT}} \propto \frac{\hbar}{2 e M_s t_F}\big[\xi_{\mathrm{DL}}\,\mathbf{m}\times(\mathbf{m}\times\boldsymbol{\sigma}) + \xi_{\mathrm{FL}}\,\mathbf{m}\times\boldsymbol{\sigma}\big]$. Full continuum definitions and formula versioning are documented in {doc}`../../physics/interactions/spin-orbit-torque/index`.

(python-api-interactions-spin-orbit-torque-symbols-and-si-units)=
## Symbols and SI units

`free_layer_thickness_m` ($t_F$) is authored in SI metres ($\mathrm{m}$). Prescribed current-density drives carry amplitudes in amperes per square metre ($\mathrm{A\,m^{-2}}$) or source-linked descriptors ($1$); `name`, `target`, and efficiencies (`xi_dl`, `xi_fl`) are dimensionless ($1$).

(python-api-interactions-spin-orbit-torque-assumptions-and-validity)=
## Assumptions and validity

`name` must be non-empty, `target` must be a typed `RegionRef`, `drive` must be a typed scalar or vector current drive, `xi_dl` and `xi_fl` must be finite, and `free_layer_thickness_m` must be strictly positive. Legacy or unversioned migration payloads fail closed at construction or lowering.

(python-api-interactions-spin-orbit-torque-python-api)=
## Python API

### Constructor or function

`fm.PrescribedSpinOrbitTorque(name, target, drive, ..., free_layer_thickness_m)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `name` | `str` | `required` | $1$ | non-empty | torque module identifier | FEM/FDM CPU/GPU: IR; resolver-specific | `name` |
| `target` | `RegionRef` | `required` | $1$ | typed region reference | free-layer target | FEM/FDM CPU/GPU: IR; resolver-specific | `target` |
| `drive` | `SignedScalarDrive or VectorCurrentDrive` | `required` | $\mathrm{A\,m^{-2}}$ or $1$ | typed drive | prescribed current or vector drive | FEM/FDM CPU/GPU: IR; resolver-specific | `drive` |
| `xi_dl` | `float` | `required` | $1$ | finite | damping-like efficiency | FEM/FDM CPU/GPU: IR; resolver-specific | `xi_dl` |
| `xi_fl` | `float` | `0.0` | $1$ | finite | field-like efficiency | FEM/FDM CPU/GPU: IR; resolver-specific | `xi_fl` |
| `free_layer_thickness_m` | `float` | `required` | $\mathrm{m}$ | positive | free-layer thickness | FEM/FDM CPU/GPU: IR; resolver-specific | `free_layer_thickness_m` |

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
value = fm.PrescribedSpinOrbitTorque(name="sot", target=fm.RegionRef("film"), drive=fm.SignedScalarDrive(1.0e10, (0.0, 0.0, 1.0)), xi_dl=0.1, free_layer_thickness_m=5.0e-9)
canonical_ir = value.to_ir_module()
```

In a complete simulation script, attach the lowered SOT module to the study spin-torque registry alongside its target region and drive source.

(python-api-interactions-spin-orbit-torque-problem-ir)=
## ProblemIR

`value.to_ir_module()` emits a typed `"kind": "prescribed_sot"` module record (`"schema_version": "prescribed_sot.v1"`, `"formula_version": "prescribed_sot.fullmag.v1"`) containing `"id"`, nested `"target"`, `"drive"`, `"xi_dl"`, `"xi_fl"`, and `"free_layer_thickness_m"`.

(python-api-interactions-spin-orbit-torque-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves target references, drive records, efficiencies, and thickness in `ProblemIR` independently of `resolved execution`. `Validation errors` reject untyped targets/drives, non-positive `free_layer_thickness_m`, or legacy payloads, while `unsupported combinations` fail closed at planning.

(python-api-interactions-spin-orbit-torque-discrete-realization)=
## Discrete realization

The Python contract supplies typed module inputs in `ProblemIR` only; evaluating SOT source terms and LLG torque contributions on FEM meshes or FDM grids is implemented by the solver backends.

(python-api-interactions-spin-orbit-torque-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/spin_torque.py` (`class PrescribedSpinOrbitTorque`). Constructor validation, defaults, and `to_ir_module()` keys come directly from that module.

(python-api-interactions-spin-orbit-torque-validation)=
## Validation

Focused repository unit tests covering `PrescribedSpinOrbitTorque` authoring and wire schema include `test_prescribed_sot_canonical_defaults_and_v1_wire_shape`, `test_prescribed_sot_rejects_invalid_target_and_drive_boundaries`, and `test_prescribed_sot_rejects_legacy_migration_payload`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-spin-orbit-torque-limitations)=
## Limitations and Control Room

Prescribed spin–orbit torques (`prescribed_sot`: $\xi_{\text{DL}}$, $\xi_{\text{FL}}$, stack normal, bound to prescribed current density or an upstream `current_transport` source) are edited in Control Room through `SpinAuthoringInspector` (`SpinTorqueInspectorPanel`) under `spin-torque` selection, subject to active-lane capability gating (`useActiveLaneCapabilities`). Spatially varying scripted torque coefficients without inspector widgets remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| `prescribed_sot` efficiencies ($\xi_{\text{DL}}$, $\xi_{\text{FL}}$), normal, & current source binding | `Model Explorer -> Physics -> Spin Torque` (`SpinAuthoringInspector`, `SpinTorqueInspectorPanel`) | `partial` | `runAuthoringMutationWithHistory` on `scene_revision` |
| Spatial torque coefficient maps without a named UI field | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-spin-transport-sot-stt.png
:alt: Control Room Spin Torque (SOT/STT) and Spin Transport inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/inspectors/physics-antennas-and-transport`.

(python-api-interactions-spin-orbit-torque-scientific-bibliography)=
## Scientific bibliography

- A. Manchon, J. Zelezný, I. M. Miron, T. Jungwirth, J. Sinova, A. Thiaville, K. Garello, and P. Gambardella, “Current-induced spin-orbit torques in ferromagnetic and antiferromagnetic systems,” *Reviews of Modern Physics* **91**(3), 035004 (2019), [doi:10.1103/RevModPhys.91.035004](https://doi.org/10.1103/RevModPhys.91.035004) | [arXiv:1801.09636](https://arxiv.org/abs/1801.09636).
- L. Liu, O. J. Lee, T. J. Gudmundsen, D. C. Ralph, and R. A. Buhrman, “Current-Induced Switching of Perpendicularly Magnetized Magnetic Layers Using Spin Torque from the Spin Hall Effect,” *Physical Review Letters* **109**(9), 096602 (2012), [doi:10.1103/PhysRevLett.109.096602](https://doi.org/10.1103/PhysRevLett.109.096602) | [arXiv:1110.6846](https://arxiv.org/abs/1110.6846).
- J. Sinova, S. O. Valenzuela, J. Wunderlich, C. H. Back, and T. Jungwirth, “Spin Hall effects,” *Reviews of Modern Physics* **87**(4), 1213–1260 (2015), [doi:10.1103/RevModPhys.87.1213](https://doi.org/10.1103/RevModPhys.87.1213) | [arXiv:1411.3249](https://arxiv.org/abs/1411.3249).

(python-api-interactions-spin-orbit-torque-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/spin_torque.py` | `class PrescribedSpinOrbitTorque` | public constructor and IR lowering |
