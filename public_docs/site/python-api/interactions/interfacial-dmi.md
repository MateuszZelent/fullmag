---
title: Interfacial DMI Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Interfacial DMI

(public-docs-python-api-interactions-interfacial-dmi)=
(python-api-interactions-interfacial-dmi-problem-statement)=
## Problem statement

The optional normal makes the interface orientation explicit in the IR.

This page covers the Python authoring contract: construction validates the signed interfacial DMI constant and optional interface normal in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh discretization.

(python-api-interactions-interfacial-dmi-governing-equations)=
## Governing equations

Interfacial Dzyaloshinskii–Moriya interaction with symmetry-breaking axis $\hat{\mathbf{n}}$ (defaulting to $\hat{\mathbf{z}}$ when `interface_normal=None` on compatible paths) contributes energy density $w_{\mathrm{Dind}} = D\,\big[(\mathbf{m}\cdot\hat{\mathbf{n}})(\nabla\cdot\mathbf{m}) - (\mathbf{m}\cdot\nabla)(\mathbf{m}\cdot\hat{\mathbf{n}})\big]$. The full continuum equations and rotated-normal forms are documented in {doc}`../../physics/interactions/dmi/interfacial` and {doc}`../../physics/interactions/dmi/index`.

(python-api-interactions-interfacial-dmi-symbols-and-si-units)=
## Symbols and SI units

`fm.InterfacialDMI.D` uses joules per square metre ($\mathrm{J\,m^{-2}}$). The unit symmetry axis `interface_normal` is a dimensionless three-component vector ($1$).

(python-api-interactions-interfacial-dmi-assumptions-and-validity)=
## Assumptions and validity

`D` must be a finite scalar with sign preserved; when supplied, `interface_normal` must be a finite non-zero three-vector and is normalized to unit length. Zero vectors, malformed sequence lengths, or non-finite values fail closed at construction.

(python-api-interactions-interfacial-dmi-python-api)=
## Python API

### Constructor or function

`fm.InterfacialDMI(D, interface_normal=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.InterfacialDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite; sign preserved | interfacial DMI constant | FEM/FDM CPU/GPU: IR; resolved support required | `D` |
| `fm.InterfacialDMI.interface_normal` | `tuple[float,float,float] or None` | `None` | $1$ | finite non-zero when supplied; normalized | interface normal | FEM/FDM CPU/GPU: IR; resolved support required | `interface_normal` |

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
value = fm.InterfacialDMI(D=1.0e-3, interface_normal=(0.0, 0.0, 1.0))
canonical_ir = value.to_ir()
```

In a complete simulation script, configure interfacial DMI on the owning material or attach `fm.InterfacialDMI(...)` via the study interaction API.

(python-api-interactions-interfacial-dmi-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "interfacial_dmi", "D": ..., "interface_normal": ...}` with normalized interface normal coordinates when supplied.

(python-api-interactions-interfacial-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves signed `D` and explicit `interface_normal` independently of `resolved execution`. `Validation errors` reject zero-norm normals or non-finite constants, while `unsupported combinations` (such as arbitrary off-axis normals on FDM paths without rotated-DMI support) fail closed at planning.

(python-api-interactions-interfacial-dmi-discrete-realization)=
## Discrete realization

The Python contract supplies `D` and unit `interface_normal` in `ProblemIR` only; chiral finite-difference stencils, FEM boundary terms, and rotated normal transforms are implemented by the solver backends.

(python-api-interactions-interfacial-dmi-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class InterfacialDMI`). Constructor checks, normal standardization, defaults, and `to_ir()` keys come directly from that module.

(python-api-interactions-interfacial-dmi-validation)=
## Validation

Focused repository unit tests covering interfacial DMI IR lowering include `test_interfacial_dmi_interface_normal_serializes_to_ir` and `test_dmi_terms_preserve_signed_constants_in_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-interfacial-dmi-limitations)=
## Limitations and Control Room

Control Room has no standalone form route for `fm.InterfacialDMI`; interfacial DMI constants (`Dind`) are authored via object/region material panels when exposed or directly in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-interfacial-dmi-scientific-bibliography)=
## Scientific bibliography

- S. Rohart and A. Thiaville, “Skyrmion confinement in ultrathin film nanostructures in the presence of Dzyaloshinskii-Moriya interaction,” *Physical Review B* **88**(18), 184422 (2013), [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422) | [arXiv:1310.0666](https://arxiv.org/abs/1310.0666).
- A. Fert, V. Cros, and J. Sampaio, “Skyrmions on the track,” *Nature Nanotechnology* **8**(3), 152–156 (2013), [doi:10.1038/nnano.2013.29](https://doi.org/10.1038/nnano.2013.29).

(python-api-interactions-interfacial-dmi-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class InterfacialDMI` | public constructor and IR lowering |
