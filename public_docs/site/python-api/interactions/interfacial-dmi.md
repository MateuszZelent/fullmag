---
title: Interfacial DMI Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Interfacial DMI

(public-docs-python-api-interactions-interfacial-dmi)=
(python-api-interactions-interfacial-dmi-problem-statement)=
## Problem statement

`fm.InterfacialDMI` authors standard interfacial Dzyaloshinskii–Moriya interaction with an optional explicit interface normal, and `fm.RotatedInterfacialDMI` authors rotated-frame interfacial DMI (attached via `study.terms.add(...)` with optional `object_ids` scoping and dedicated `E_rotated_dmi` / `H_rotated_dmi` observables).

In stage-first study scripts, per-magnet interfacial DMI is also authored directly via `MagnetHandle` properties `film.Dind` (alias `film.dind`) and `film.dmi_interface_normal`, or on `fm.Material`.

(python-api-interactions-interfacial-dmi-governing-equations)=
## Governing equations

Interfacial Dzyaloshinskii–Moriya interaction with symmetry-breaking unit normal $\hat{\mathbf{n}}$ (defaulting to $\hat{\mathbf{z}}$ when `interface_normal=None`) contributes energy density $w_{\mathrm{Dind}} = D\,\big[(\mathbf{m}\cdot\hat{\mathbf{n}})(\nabla\cdot\mathbf{m}) - (\mathbf{m}\cdot\nabla)(\mathbf{m}\cdot\hat{\mathbf{n}})\big]$. Rotated interfacial DMI applies the rotated chiral energy density (`E_rotated_dmi`, effective field `H_rotated_dmi`) over the selected `object_ids` or global magnetic domain. Full continuum equations and rotated-normal forms are documented in {doc}`../../physics/interactions/dmi/interfacial` and {doc}`../../physics/interactions/dmi/index`.

(python-api-interactions-interfacial-dmi-symbols-and-si-units)=
## Symbols and SI units

`fm.InterfacialDMI.D` and `fm.RotatedInterfacialDMI.D` (and `MagnetHandle.Dind`) use joules per square metre ($\mathrm{J\,m^{-2}}$). `interface_normal` is a dimensionless three-component vector ($1$), and `object_ids` is a sequence of dimensionless object identifiers ($1$).

(python-api-interactions-interfacial-dmi-assumptions-and-validity)=
## Assumptions and validity

- `fm.InterfacialDMI(D, interface_normal=None)` validates `D` in Python via `require_finite(D, "D")` (sign preserved). When supplied, `interface_normal` is converted by `fullmag._validation.as_vector3`, which checks **only** that the sequence has length 3 and converts components via `float(...)`. Python construction does **not** reject non-finite or zero-norm `interface_normal` vectors and does **not** normalize `interface_normal`; finiteness, non-zero norm, and unit-vector normalization are enforced at planner and backend lowering.
- `fm.RotatedInterfacialDMI(D, object_ids=None)` validates `D` via `require_finite(D, "D")`. When `object_ids` is provided, Python construction rejects bare strings/bytes, non-string elements, empty sequences, blank IDs, and duplicate IDs. `study.terms.add(...)` allows at most one `RotatedInterfacialDMI` term per study.

(python-api-interactions-interfacial-dmi-python-api)=
## Python API

### Constructors and stage-first facades

- `fm.InterfacialDMI(D, interface_normal=None)`
- `fm.RotatedInterfacialDMI(D, object_ids=None)` (registered on a study via `study.terms.add(...)`)
- Per-magnet handle properties on `MagnetHandle`: `film.Dind` (alias `film.dind`) and `film.dmi_interface_normal`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.InterfacialDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite scalar via `require_finite`; sign preserved | interfacial DMI constant | FEM/FDM CPU/GPU: IR and chiral exchange/DMI kernels | `D` |
| `fm.InterfacialDMI.interface_normal` | `Sequence[float] \| None` | `None` | $1$ | length-3 sequence via `as_vector3` when supplied; planner/backend validates finiteness, non-zero norm, and normalizes | interface normal | FEM/FDM CPU/GPU: IR; off-axis support is backend-specific | `interface_normal` |
| `fm.RotatedInterfacialDMI.D` | `float` | `required` | $\mathrm{J\,m^{-2}}$ | finite scalar via `require_finite`; sign preserved | rotated interfacial DMI constant | FEM/FDM CPU/GPU: IR; observables `E_rotated_dmi`, `H_rotated_dmi` | `D` |
| `fm.RotatedInterfacialDMI.object_ids` | `Sequence[str] \| None` | `None` | $1$ | non-empty sequence of unique non-empty strings when supplied | target magnetic object IDs for rotated DMI | FEM/FDM CPU/GPU: IR; planner resolves object scope | `object_ids` |

### Stage-first example

```python
# %% Stage-first interfacial and rotated interfacial DMI
import fullmag as fm

study = fm.study("interfacial_dmi_skyrmion_disk")
study.engine("fem")
study.device("cpu", precision="double")
study.objects.mesh.defaults(maximum_element_size=4.0e-9)

film = study.geometry(fm.Box(size=(80.0e-9, 80.0e-9, 2.0e-9)), name="film")
film.Ms = 580.0e3
film.Aex = 15.0e-12
film.alpha = 0.3
film.Ku1 = 8.0e5
film.anisU = (0.0, 0.0, 1.0)
film.Dind = 3.0e-3
film.dmi_interface_normal = (0.0, 0.0, 1.0)
film.m = fm.texture.neel_skyrmion(radius=15.0e-9, wall_width=5.0e-9)

study.exchange()
study.demag(model="airbox", variant="robin")
# Register an explicit rotated interfacial DMI term scoped to the film object
rotated_dmi = study.terms.add(fm.RotatedInterfacialDMI(D=0.5e-3, object_ids=("film",)))
study.stages.add_relax(stage_id="relax_skyrmion", dt=5.0e-13, max_steps=100)

# %% Canonical IR inspection
idmi_ir = fm.InterfacialDMI(D=3.0e-3, interface_normal=(0.0, 0.0, 1.0)).to_ir()
rdmi_ir = rotated_dmi.to_ir()
```

(python-api-interactions-interfacial-dmi-problem-ir)=
## ProblemIR

- `fm.InterfacialDMI(D, interface_normal=...).to_ir()` emits `{"kind": "interfacial_dmi", "D": ...}` and includes `"interface_normal": [nx, ny, nz]` when supplied (preserving authored floats until planner normalization).
- `fm.RotatedInterfacialDMI(D, object_ids=...).to_ir()` emits `{"kind": "rotated_interfacial_dmi", "D": ...}` and includes `"object_ids": [...]` when supplied. Its scalar energy and field observables are `"E_rotated_dmi"` and `"H_rotated_dmi"`.

(python-api-interactions-interfacial-dmi-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves signed `D`, authored `interface_normal`, and `object_ids` independently of `resolved execution`. `Validation errors` reject non-finite `D`, non-length-3 `interface_normal` sequences, invalid/duplicate `object_ids`, or duplicate `RotatedInterfacialDMI` registrations in Python, while non-finite or zero-norm `interface_normal` vectors fail closed at planner/backend lowering. `Unsupported combinations` (such as arbitrary off-axis normals on backends lacking rotated-DMI support) fail closed at planning.

(python-api-interactions-interfacial-dmi-discrete-realization)=
## Discrete realization

The Python contract supplies `D`, authored `interface_normal`, and `object_ids` in `ProblemIR` only; chiral finite-difference stencils, FEM weak-form boundary terms, and unified preassembled CSR GPU DMI kernels (PR `#577`, accelerating both tetrahedral and `pure_prism_p2` meshes) are owned by the solver backends. See {ref}`numerical-methods-performance-fem-gpu-kernels` and {ref}`numerical-methods-performance-fdm-core`.

| Solver | Device | `InterfacialDMI` | `RotatedInterfacialDMI` (`E_rotated_dmi`, `H_rotated_dmi`) | Performance reference |
|---|---|---|---|---|
| `FDM` | `CPU` | Supported (chiral FD stencil + open BC) | Supported on qualified FDM paths | {ref}`numerical-methods-performance-fdm-core` |
| `FDM` | `GPU` | Supported (CUDA chiral FD kernel) | Supported on qualified FDM GPU paths | {ref}`numerical-methods-performance-fdm-core` |
| `FEM` | `CPU` | Supported (nodal/weak-form CSR assembly) | Supported on FEM CPU weak-form assembly | {doc}`../../physics/interactions/dmi/interfacial` |
| `FEM` | `GPU` | Supported (unified preassembled CSR GPU DMI, PR `#577`) | Supported via unified CSR GPU DMI | {ref}`numerical-methods-performance-fem-gpu-kernels` |

(python-api-interactions-interfacial-dmi-implementation-mapping)=
## Implementation mapping

- Interfacial and rotated DMI classes: `packages/fullmag-py/src/fullmag/model/energy.py` (`class InterfacialDMI`, `class RotatedInterfacialDMI`).
- Vector length conversion: `packages/fullmag-py/src/fullmag/_validation.py` (`as_vector3`).
- Stage-first study registration and magnet handle: `packages/fullmag-py/src/fullmag/world.py` (`class StudyEnergyTermRegistry`, `class MagnetHandle`).

(python-api-interactions-interfacial-dmi-validation)=
## Validation

Focused repository unit tests covering interfacial DMI IR lowering include `test_interfacial_dmi_interface_normal_serializes_to_ir` and `test_dmi_terms_preserve_signed_constants_in_ir`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-interfacial-dmi-limitations)=
## Limitations and Control Room

Control Room has no standalone form route for `fm.InterfacialDMI` or `fm.RotatedInterfacialDMI`; interfacial DMI constants (`Dind`) are authored via owning object/region material panels (`apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx`) when exposed, and `RotatedInterfacialDMI` terms are authored in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-interfacial-dmi-scientific-bibliography)=
## Scientific bibliography

- S. Rohart and A. Thiaville, “Skyrmion confinement in ultrathin film nanostructures in the presence of Dzyaloshinskii-Moriya interaction,” *Physical Review B* **88**(18), 184422 (2013), [doi:10.1103/PhysRevB.88.184422](https://doi.org/10.1103/PhysRevB.88.184422) | [arXiv:1310.0666](https://arxiv.org/abs/1310.0666).
- A. Fert, V. Cros, and J. Sampaio, “Skyrmions on the track,” *Nature Nanotechnology* **8**(3), 152–156 (2013), [doi:10.1038/nnano.2013.29](https://doi.org/10.1038/nnano.2013.29).

(python-api-interactions-interfacial-dmi-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L127) | `class InterfacialDMI` | interfacial DMI constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L149) | `class RotatedInterfacialDMI` | rotated interfacial DMI constructor, `object_ids` validation, and IR lowering |
| [`packages/fullmag-py/src/fullmag/_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L294) | `as_vector3` | length-3 tuple conversion without normalization or finiteness rejection |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6322) | `class StudyEnergyTermRegistry` | `study.terms.add(...)` registration for `RotatedInterfacialDMI` |
