---
title: Bulk DMI Python API
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Bulk DMI

(public-docs-python-api-interactions-bulk-dmi)=
(python-api-interactions-bulk-dmi-problem-statement)=
## Problem statement

The signed bulk DMI constant is passed through unchanged.

This page covers the Python authoring contract: construction validates the signed bulk DMI constant in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh discretization.

(python-api-interactions-bulk-dmi-governing-equations)=
## Governing equations

Bulk Dzyaloshinskii–Moriya interaction contributes the chiral energy density $w_{\mathrm{Dbulk}} = D\,\mathbf{m}\cdot(\nabla\times\mathbf{m})$ over the magnetic domain $\Omega_m$ with signed constant $D$. The continuum formulation, sign convention, and discrete operators are documented in {doc}`../../physics/interactions/dmi/bulk` and {doc}`../../physics/interactions/dmi/index`.

(python-api-interactions-bulk-dmi-symbols-and-si-units)=
## Symbols and SI units

`fm.BulkDMI.D` is authored in joules per square metre ($\mathrm{J\,m^{-2}}$). Vector magnetization $\mathbf{m}$ is dimensionless unit length ($1$), and spatial gradients use inverse metres ($\mathrm{m^{-1}}$).

(python-api-interactions-bulk-dmi-assumptions-and-validity)=
## Assumptions and validity

`D` must be a finite real scalar; positive, negative, and zero values are preserved with their sign intact. Non-finite or non-numeric constants fail closed during construction.

(python-api-interactions-bulk-dmi-python-api)=
## Python API

### Constructor or function

`fm.BulkDMI(D)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.BulkDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite; sign preserved | bulk DMI constant | FEM/FDM CPU/GPU: IR; resolved support required | `D` |

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
value = fm.BulkDMI(D=1.0e-3)
canonical_ir = value.to_ir()
```

In a complete simulation script, set bulk DMI on the owning material or attach the interaction term through the study energy/material API.

(python-api-interactions-bulk-dmi-problem-ir)=
## ProblemIR

`value.to_ir()` emits `{"kind": "bulk_dmi", "D": ...}`, preserving the signed `D` value in $\mathrm{J\,m^{-2}}$.

(python-api-interactions-bulk-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the exact signed `D` constant in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-finite or missing inputs, while `unsupported combinations` fail closed if a selected solver path or boundary mode lacks bulk-DMI support.

(python-api-interactions-bulk-dmi-discrete-realization)=
## Discrete realization

The Python contract supplies the signed bulk-DMI constant and canonical `ProblemIR` only; chiral finite-difference stencils, FEM weak-form boundary terms, and CPU/GPU kernels are implemented by the solver backends.

(python-api-interactions-bulk-dmi-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/model/energy.py` (`class BulkDMI`). Constructor parameters, validation branches, and `to_ir()` keys come directly from that module.

(python-api-interactions-bulk-dmi-validation)=
## Validation

Focused repository unit tests covering signed DMI IR lowering include `test_dmi_terms_preserve_signed_constants_in_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-bulk-dmi-limitations)=
## Limitations and Control Room

Control Room has no standalone form route for `fm.BulkDMI`; bulk DMI coefficients are edited via owning object/region material panels (`Dbulk`) when exposed or authored in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-bulk-dmi-scientific-bibliography)=
## Scientific bibliography

- I. Dzyaloshinsky, “A thermodynamic theory of “weak” ferromagnetism of antiferromagnetics,” *Journal of Physics and Chemistry of Solids* **4**(4), 241–255 (1958), [doi:10.1016/0022-3697(58)90076-3](https://doi.org/10.1016/0022-3697(58)90076-3).
- T. Moriya, “Anisotropic Superexchange Interaction and Weak Ferromagnetism,” *Physical Review* **120**(1), 91–98 (1960), [doi:10.1103/PhysRev.120.91](https://doi.org/10.1103/PhysRev.120.91).
- A. N. Bogdanov and U. Rößler, “Chiral Symmetry Breaking in Magnetic Thin Films and Multilayers,” *Physical Review Letters* **87**(3), 037203 (2001), [doi:10.1103/PhysRevLett.87.037203](https://doi.org/10.1103/PhysRevLett.87.037203) | [Open-access TUD repository](https://doi.org/10.17877/de290r-6428).

(python-api-interactions-bulk-dmi-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/model/energy.py` | `class BulkDMI` | public constructor and IR lowering |
