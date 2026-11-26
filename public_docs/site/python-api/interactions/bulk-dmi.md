---
title: Bulk DMI Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Bulk DMI

(public-docs-python-api-interactions-bulk-dmi)=
(python-api-interactions-bulk-dmi-problem-statement)=
## Problem statement

`fm.BulkDMI` records the signed bulk Dzyaloshinskii–Moriya interaction constant $D$ for canonical `ProblemIR` lowering, while stage-first study scripts configure per-magnet bulk DMI directly through `MagnetHandle.Dbulk` (alias `dbulk`) or `fm.Material(..., Dbulk=...)`.

This page covers the Python authoring contract: construction validates the signed bulk DMI constant in Python, while `to_ir()` emits the canonical `ProblemIR` record before mesh discretization.

(python-api-interactions-bulk-dmi-governing-equations)=
## Governing equations

Bulk Dzyaloshinskii–Moriya interaction contributes the chiral energy density $w_{\mathrm{Dbulk}} = D\,\mathbf{m}\cdot(\nabla\times\mathbf{m})$ over the magnetic domain $\Omega_m$ with signed constant $D$. The continuum formulation, sign convention, and discrete operators are documented in {doc}`../../physics/interactions/dmi/bulk` and {doc}`../../physics/interactions/dmi/index`.

(python-api-interactions-bulk-dmi-symbols-and-si-units)=
## Symbols and SI units

`fm.BulkDMI.D` and `MagnetHandle.Dbulk` are authored in joules per square metre ($\mathrm{J\,m^{-2}}$). Vector magnetization $\mathbf{m}$ is dimensionless unit length ($1$), and spatial gradients use inverse metres ($\mathrm{m^{-1}}$).

(python-api-interactions-bulk-dmi-assumptions-and-validity)=
## Assumptions and validity

`D` must be a finite real scalar validated via `require_finite(self.D, "D")`; positive, negative, and zero values are preserved with their sign intact. Non-finite or non-numeric constants fail closed during construction.

(python-api-interactions-bulk-dmi-python-api)=
## Python API

### Constructor and stage-first handle attributes

- `fm.BulkDMI(D)`
- Direct per-magnet property on `MagnetHandle` (returned by `study.geometry(...)`): `film.Dbulk` (lowercase alias `film.dbulk`), which activates bulk DMI on the object's `fm.Material` record. Setting `film.Dbulk = None` clears active bulk DMI on that magnet.

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.BulkDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite scalar via `require_finite`; sign preserved | bulk DMI constant | FEM/FDM CPU/GPU: IR and chiral exchange/DMI kernels | `D` |
| `MagnetHandle.Dbulk` | `float \| None` | `None` | $\mathrm{J\,m^{-2}}$ | finite scalar when set; `None` deactivates material bulk DMI | per-magnet bulk DMI constant in stage-first scripts | FEM/FDM CPU/GPU: lowers onto `materials[].dmi_bulk` | `materials[].dmi_bulk` |

### Stage-first example

```python
# %% Stage-first bulk DMI authoring on a chiral helimagnet
import fullmag as fm

study = fm.study("bulk_dmi_bloch_skyrmion")
study.engine("fem")
study.device("cpu", precision="double")
study.objects.mesh.defaults(maximum_element_size=4.0e-9)

film = study.geometry(fm.Box(size=(80.0e-9, 80.0e-9, 10.0e-9)), name="fegem")
film.Ms = 384.0e3
film.Aex = 8.78e-12
film.alpha = 0.2
film.Dbulk = 1.58e-3
film.m = fm.texture.bloch_skyrmion(radius=18.0e-9, wall_width=5.0e-9)

study.exchange()
study.demag(model="airbox", variant="robin")
study.b_ext(0.0, 0.0, 0.2)
study.stages.add_relax(stage_id="relax_bloch_skyrmion", dt=5.0e-13, max_steps=100)

# %% Canonical BulkDMI energy-term IR inspection
term = fm.BulkDMI(D=1.58e-3)
canonical_ir = term.to_ir()
```

(python-api-interactions-bulk-dmi-problem-ir)=
## ProblemIR

`term.to_ir()` emits `{"kind": "bulk_dmi", "D": ...}`, preserving the signed `D` value in $\mathrm{J\,m^{-2}}$. Assigning `film.Dbulk` serializes the bulk DMI coefficient onto the object's `materials[]` record and activates bulk DMI for that magnet.

(python-api-interactions-bulk-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the exact signed `D` constant in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-finite or missing inputs at Python construction, while `unsupported combinations` fail closed if a selected solver path or boundary mode lacks bulk-DMI support.

(python-api-interactions-bulk-dmi-discrete-realization)=
## Discrete realization

The Python contract supplies the signed bulk-DMI constant and canonical `ProblemIR` only; chiral finite-difference stencils, FEM weak-form boundary terms, and unified preassembled CSR GPU DMI kernels (PR `#577`) are implemented by the solver backends. See {ref}`numerical-methods-performance-fem-gpu-kernels` and {ref}`numerical-methods-performance-fdm-core`.

| Solver | Device | Bulk DMI realization | Performance reference |
|---|---|---|---|
| `FDM` | `CPU` | Chiral finite-difference bulk-DMI stencil + open boundary condition | {ref}`numerical-methods-performance-fdm-core` |
| `FDM` | `GPU` | CUDA chiral finite-difference bulk-DMI kernel | {ref}`numerical-methods-performance-fdm-core` |
| `FEM` | `CPU` | Nodal/weak-form CSR assembly with chiral boundary variation | {doc}`../../physics/interactions/dmi/bulk` |
| `FEM` | `GPU` | Unified preassembled CSR GPU DMI kernel (PR `#577`) | {ref}`numerical-methods-performance-fem-gpu-kernels` |

(python-api-interactions-bulk-dmi-implementation-mapping)=
## Implementation mapping

- Typed energy term: `packages/fullmag-py/src/fullmag/model/energy.py` (`class BulkDMI`).
- Per-magnet handle property (`Dbulk` / `dbulk`): `packages/fullmag-py/src/fullmag/world.py` (`class MagnetHandle`).

(python-api-interactions-bulk-dmi-validation)=
## Validation

Focused repository unit tests covering signed DMI IR lowering and unit warnings include `test_dmi_terms_preserve_signed_constants_in_ir` and `test_bulk_dmi_warning_uses_joules_per_square_metre`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-bulk-dmi-limitations)=
## Limitations and Control Room

Control Room has no standalone form route for `fm.BulkDMI`; bulk DMI coefficients (`Dbulk`) are edited via owning object/region material panels (`apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx`) when exposed, or authored in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-bulk-dmi-scientific-bibliography)=
## Scientific bibliography

- I. Dzyaloshinsky, “A thermodynamic theory of “weak” ferromagnetism of antiferromagnetics,” *Journal of Physics and Chemistry of Solids* **4**(4), 241–255 (1958), [doi:10.1016/0022-3697(58)90076-3](https://doi.org/10.1016/0022-3697(58)90076-3).
- T. Moriya, “Anisotropic Superexchange Interaction and Weak Ferromagnetism,” *Physical Review* **120**(1), 91–98 (1960), [doi:10.1103/PhysRev.120.91](https://doi.org/10.1103/PhysRev.120.91).
- A. N. Bogdanov and U. Rößler, “Chiral Symmetry Breaking in Magnetic Thin Films and Multilayers,” *Physical Review Letters* **87**(3), 037203 (2001), [doi:10.1103/PhysRevLett.87.037203](https://doi.org/10.1103/PhysRevLett.87.037203) | [Open-access TUD repository](https://doi.org/10.17877/de290r-6428).

(python-api-interactions-bulk-dmi-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L186) | `class BulkDMI` | public constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L570) | `class MagnetHandle` | per-magnet `Dbulk` / `dbulk` authoring facade |
