---
title: Uniaxial anisotropy Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Uniaxial anisotropy

(public-docs-python-api-interactions-uniaxial-anisotropy)=
(python-api-interactions-uniaxial-anisotropy-problem-statement)=
## Problem statement

`fm.UniaxialAnisotropy` records signed first- and second-order uniaxial anisotropy constants (`ku1`, `ku2`) together with a three-component easy-axis direction (`axis`) for canonical `ProblemIR` lowering.

In stage-first study scripts, per-magnet uniaxial anisotropy is commonly authored directly on a `MagnetHandle` (`film.Ku1`, `film.Ku2`, `film.anisU`) or on `fm.Material`, while `fm.UniaxialAnisotropy(...)` exposes the typed energy-term contract directly.

(python-api-interactions-uniaxial-anisotropy-governing-equations)=
## Governing equations

Uniaxial magnetocrystalline anisotropy along the normalized easy axis $\hat{\mathbf{u}}$ uses projection $q = \mathbf{m}\cdot\hat{\mathbf{u}}$ with Fullmag's energy density convention $w_u = -K_{u1} q^2 - K_{u2} q^4$ (yielding the same effective field as $K_{u1}(1 - q^2) + K_{u2}(1 - q^4)$ while shifting absolute energy by a constant). Full continuum definitions are documented in {doc}`../../physics/interactions/anisotropy/uniaxial` and {doc}`../../physics/interactions/anisotropy/index`.

(python-api-interactions-uniaxial-anisotropy-symbols-and-si-units)=
## Symbols and SI units

Anisotropy energy-density constants (`ku1`, `ku2`, and `MagnetHandle` aliases `Ku1`, `Ku2`) use joules per cubic metre ($\mathrm{J\,m^{-3}}$). The easy-axis three-vector (`axis`, or `anisU` on `MagnetHandle`) is dimensionless ($1$).

(python-api-interactions-uniaxial-anisotropy-assumptions-and-validity)=
## Assumptions and validity

At Python construction, `fm.UniaxialAnisotropy` converts `ku1` and `ku2` via `float(...)` and checks only that `axis` has length 3 via `fullmag._validation.as_vector3` (converting each component with `float(...)`). Python construction does **not** reject non-finite numbers or zero-norm vectors and does **not** normalize `axis`. Finiteness, non-zero norm, and unit-vector normalization of `axis` are enforced during planner and backend lowering, where invalid inputs fail closed.

(python-api-interactions-uniaxial-anisotropy-python-api)=
## Python API

### Constructor and stage-first handle attributes

- `fm.UniaxialAnisotropy(ku1, ku2=0.0, axis=(0.0, 0.0, 1.0))`
- Direct per-magnet properties on `MagnetHandle` (returned by `study.geometry(...)`): `film.Ku1`, `film.Ku2`, and `film.anisU` (which lower onto the object's `fm.Material` record).

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.UniaxialAnisotropy.ku1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | converted via `float`; planner/backend checks finiteness | first-order uniaxial anisotropy constant | FEM/FDM CPU/GPU: IR and local field/energy kernels | `ku1` |
| `fm.UniaxialAnisotropy.ku2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | converted via `float`; planner/backend checks finiteness | second-order uniaxial anisotropy constant | FEM/FDM CPU/GPU: IR and local field/energy kernels | `ku2` |
| `fm.UniaxialAnisotropy.axis` | `Sequence[float]` | `(0.0, 0.0, 1.0)` | $1$ | length-3 sequence via `as_vector3`; planner/backend validates finiteness, non-zero norm, and normalizes | easy-axis direction | FEM/FDM CPU/GPU: IR and local field/energy kernels | `axis` |

### Stage-first example

```python
# %% Stage-first uniaxial anisotropy authoring
import fullmag as fm

study = fm.study("uniaxial_pma_film")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(4.0e-9, 4.0e-9, 2.0e-9))

film = study.geometry(fm.Box(size=(80.0e-9, 80.0e-9, 2.0e-9)), name="film")
film.Ms = 1.0e6
film.Aex = 15.0e-12
film.alpha = 0.05
film.Ku1 = 8.0e5
film.Ku2 = 0.0
film.anisU = (0.0, 0.0, 1.0)
film.m = fm.texture.uniform(0.1, 0.0, 0.995)

study.exchange()
study.demag()
study.stages.add_relax(stage_id="relax_pma", dt=5.0e-13, max_steps=100)

# %% Typed energy-term record inspection
term = fm.UniaxialAnisotropy(ku1=8.0e5, ku2=0.0, axis=(0.0, 0.0, 1.0))
canonical_ir = term.to_ir()
```

(python-api-interactions-uniaxial-anisotropy-problem-ir)=
## ProblemIR

`term.to_ir()` emits `{"kind": "uniaxial_anisotropy", "ku1": ..., "ku2": ..., "axis": [ux, uy, uz]}` preserving the authored float components until planner/backend normalization. Per-magnet handle assignments (`film.Ku1`, `film.Ku2`, `film.anisU`) serialize onto the object's `materials[]` record.

(python-api-interactions-uniaxial-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves signed `ku1`/`ku2` constants and authored `axis` components in `ProblemIR` independently of `resolved execution`. `Validation errors` reject sequences whose length is not 3 at Python construction (`ValueError` from `as_vector3`), while non-finite constants or zero-norm axes fail closed at planner/backend validation. `Unsupported combinations` fail closed if a requested spatially varying or backend-specific material mode conflicts with the resolved lane.

(python-api-interactions-uniaxial-anisotropy-discrete-realization)=
## Discrete realization

The Python contract supplies physical constants and authored direction components in `ProblemIR` only; cell-local FDM and nodal/quadrature FEM evaluations of $\mathbf{H}_{\mathrm{uni}}$ and energy reductions are implemented by the solver backends. See {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels` for local-kernel fusion and GPU performance details.

| Solver | Device | Authoring / IR | Local field & energy evaluation |
|---|---|---|---|
| `FDM` | `CPU` | Supported | Supported (cell-local SoA loop) |
| `FDM` | `GPU` | Supported | Supported (fused local effective-field CUDA kernel) |
| `FEM` | `CPU` | Supported | Supported (nodal/quadrature weak-form assembly) |
| `FEM` | `GPU` | Supported | Supported (fused GPU effective-field kernel) |

(python-api-interactions-uniaxial-anisotropy-implementation-mapping)=
## Implementation mapping

- Typed interaction class: `packages/fullmag-py/src/fullmag/model/energy.py` (`class UniaxialAnisotropy`).
- Vector length check: `packages/fullmag-py/src/fullmag/_validation.py` (`as_vector3`).
- Stage-first handle attributes (`Ku1`, `Ku2`, `anisU`): `packages/fullmag-py/src/fullmag/world.py` (`class MagnetHandle`).

(python-api-interactions-uniaxial-anisotropy-validation)=
## Validation

Focused repository unit tests covering uniaxial anisotropy IR lowering include `test_anisotropy_terms_serialize_canonical_ir`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-uniaxial-anisotropy-limitations)=
## Limitations and Control Room

Control Room has no standalone form route for `fm.UniaxialAnisotropy`; uniaxial anisotropy constants and easy axes (`Ku1`, `Ku2`, `anisU`) are authored on owning object/region material panels via `apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx` when exposed, or directly in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-uniaxial-anisotropy-scientific-bibliography)=
## Scientific bibliography

- E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948), [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
- J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023), [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-uniaxial-anisotropy-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L511) | `class UniaxialAnisotropy` | public constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L294) | `as_vector3` | length-3 tuple conversion without normalization or finiteness rejection |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L570) | `class MagnetHandle` | per-magnet `Ku1`, `Ku2`, and `anisU` authoring facade |
