---
title: Cubic anisotropy Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Cubic anisotropy

(public-docs-python-api-interactions-cubic-anisotropy)=
(python-api-interactions-cubic-anisotropy-problem-statement)=
## Problem statement

`fm.CubicAnisotropy` stores signed first-, second-, and third-order cubic anisotropy constants (`kc1`, `kc2`, `kc3`) and two crystal axes (`axis1`, `axis2`) for canonical `ProblemIR` lowering.

In stage-first study scripts, per-magnet cubic anisotropy is authored directly on a `MagnetHandle` (`film.Kc1`, `film.Kc2`, `film.Kc3`, `film.anisC1`, `film.anisC2`) or on `fm.Material`, while `fm.CubicAnisotropy(...)` exposes the standalone energy-term record.

(python-api-interactions-cubic-anisotropy-governing-equations)=
## Governing equations

Cubic magnetocrystalline anisotropy projects reduced magnetization $\mathbf{m}$ onto orthonormal crystal axes $\mathbf{c}_1$, $\mathbf{c}_2$, and $\mathbf{c}_3 = \mathbf{c}_1\times\mathbf{c}_2$ via direction cosines $\alpha_a = \mathbf{m}\cdot\mathbf{c}_a$ with constants $K_{c1}, K_{c2}, K_{c3}$. The full energy density and effective field equations are documented in {doc}`../../physics/interactions/anisotropy/cubic` and {doc}`../../physics/interactions/anisotropy/index`.

(python-api-interactions-cubic-anisotropy-symbols-and-si-units)=
## Symbols and SI units

Anisotropy energy-density constants (`kc1`, `kc2`, `kc3`, and `MagnetHandle` attributes `Kc1`, `Kc2`, `Kc3`) use joules per cubic metre ($\mathrm{J\,m^{-3}}$). Crystal axes (`axis1`, `axis2`, and `MagnetHandle` attributes `anisC1`, `anisC2`) are dimensionless three-component Cartesian vectors ($1$).

(python-api-interactions-cubic-anisotropy-assumptions-and-validity)=
## Assumptions and validity

At Python construction, `fm.CubicAnisotropy` converts `kc1`, `kc2`, and `kc3` via `float(...)` and checks only that `axis1` and `axis2` each have length 3 via `fullmag._validation.as_vector3` (converting components with `float(...)`). Python construction does **not** reject non-finite numbers or zero-norm vectors, does **not** normalize `axis1` or `axis2`, and does **not** verify mutual orthogonality. Finiteness, non-zero norm, unit-vector normalization, and orthogonality (`axis1` perpendicular to `axis2`) are enforced at planner and backend lowering, where invalid inputs fail closed.

(python-api-interactions-cubic-anisotropy-python-api)=
## Python API

### Constructor and stage-first handle attributes

- `fm.CubicAnisotropy(kc1, kc2=0.0, kc3=0.0, axis1=(1.0, 0.0, 0.0), axis2=(0.0, 1.0, 0.0))`
- Direct per-magnet properties on `MagnetHandle` (returned by `study.geometry(...)`): `film.Kc1`, `film.Kc2`, `film.Kc3`, `film.anisC1`, and `film.anisC2` (which lower onto the object's `fm.Material` record).

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.CubicAnisotropy.kc1` | `float` | `required` | $\mathrm{J\,m^{-3}}$ | converted via `float`; planner/backend checks finiteness | first-order cubic anisotropy constant | FEM/FDM CPU/GPU: IR and local field/energy kernels | `kc1` |
| `fm.CubicAnisotropy.kc2` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | converted via `float`; planner/backend checks finiteness | second-order cubic anisotropy constant | FEM/FDM CPU/GPU: IR and local field/energy kernels | `kc2` |
| `fm.CubicAnisotropy.kc3` | `float` | `0.0` | $\mathrm{J\,m^{-3}}$ | converted via `float`; planner/backend checks finiteness | third-order cubic anisotropy constant | FEM/FDM CPU/GPU: IR and local field/energy kernels | `kc3` |
| `fm.CubicAnisotropy.axis1` | `Sequence[float]` | `(1.0, 0.0, 0.0)` | $1$ | length-3 sequence via `as_vector3`; planner/backend validates finiteness, non-zero norm, and normalizes | first crystal axis | FEM/FDM CPU/GPU: IR and local field/energy kernels | `axis1` |
| `fm.CubicAnisotropy.axis2` | `Sequence[float]` | `(0.0, 1.0, 0.0)` | $1$ | length-3 sequence via `as_vector3`; planner/backend validates finiteness, non-zero norm, orthogonality, and normalizes | second crystal axis | FEM/FDM CPU/GPU: IR and local field/energy kernels | `axis2` |

### Stage-first example

```python
# %% Stage-first cubic anisotropy authoring
import fullmag as fm

study = fm.study("cubic_fe_nanodisk")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(4.0e-9, 4.0e-9, 5.0e-9))

fe_film = study.geometry(fm.Box(size=(80.0e-9, 80.0e-9, 5.0e-9)), name="fe_film")
fe_film.Ms = 1.7e6
fe_film.Aex = 21.0e-12
fe_film.alpha = 0.02
fe_film.Kc1 = 4.8e4
fe_film.Kc2 = 1.0e4
fe_film.Kc3 = 0.0
fe_film.anisC1 = (1.0, 0.0, 0.0)
fe_film.anisC2 = (0.0, 1.0, 0.0)
fe_film.m = fm.texture.uniform(0.8, 0.6, 0.0)

study.exchange()
study.demag()
study.stages.add_relax(stage_id="relax_cubic", dt=5.0e-13, max_steps=100)

# %% Typed energy-term record inspection
term = fm.CubicAnisotropy(
    kc1=4.8e4,
    kc2=1.0e4,
    kc3=0.0,
    axis1=(1.0, 0.0, 0.0),
    axis2=(0.0, 1.0, 0.0),
)
canonical_ir = term.to_ir()
```

(python-api-interactions-cubic-anisotropy-problem-ir)=
## ProblemIR

`term.to_ir()` emits `{"kind": "cubic_anisotropy", "kc1": ..., "kc2": ..., "kc3": ..., "axis1": [...], "axis2": [...]}`, preserving the authored float constants and axis components until planner/backend normalization. Per-magnet handle assignments (`film.Kc1`, `film.Kc2`, `film.Kc3`, `film.anisC1`, `film.anisC2`) serialize onto the object's `materials[]` record.

(python-api-interactions-cubic-anisotropy-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves signed `kc1`/`kc2`/`kc3` constants and authored `axis1`/`axis2` vectors independently of `resolved execution`. `Validation errors` reject axis sequences whose length is not 3 at Python construction (`ValueError` from `as_vector3`), while non-finite constants, zero-norm axes, or collinear crystal axes fail closed at planner/backend validation. `Unsupported combinations` (such as non-orthogonal crystal axes on strict FEM paths) fail closed at planning.

(python-api-interactions-cubic-anisotropy-discrete-realization)=
## Discrete realization

The Python contract supplies physical constants and authored crystal directions in `ProblemIR` only; cell-local FDM and nodal/quadrature FEM evaluations of $\mathbf{H}_{\mathrm{cubic}}$ and energy reductions are implemented by the solver backends. See {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels` for local-kernel fusion and FP64 GPU parity details.

| Solver | Device | Authoring / IR | Local field & energy evaluation |
|---|---|---|---|
| `FDM` | `CPU` | Supported | Supported (cell-local SoA loop) |
| `FDM` | `GPU` | Supported | Supported (fused local effective-field CUDA kernel) |
| `FEM` | `CPU` | Supported | Supported (nodal/quadrature weak-form assembly) |
| `FEM` | `GPU` | Supported | Supported (fused GPU effective-field kernel with FP64 parity) |

(python-api-interactions-cubic-anisotropy-implementation-mapping)=
## Implementation mapping

- Typed interaction class: `packages/fullmag-py/src/fullmag/model/energy.py` (`class CubicAnisotropy`).
- Vector length check: `packages/fullmag-py/src/fullmag/_validation.py` (`as_vector3`).
- Stage-first handle attributes (`Kc1`, `Kc2`, `Kc3`, `anisC1`, `anisC2`): `packages/fullmag-py/src/fullmag/world.py` (`class MagnetHandle`).

(python-api-interactions-cubic-anisotropy-validation)=
## Validation

Focused repository unit tests covering anisotropy IR lowering include `test_anisotropy_terms_serialize_canonical_ir`. Live solver runtime parity and Control Room browser behavior require separate qualification.

(python-api-interactions-cubic-anisotropy-limitations)=
## Limitations and Control Room

Control Room has no standalone route for `fm.CubicAnisotropy`; cubic constants and crystal axes (`Kc1`, `Kc2`, `Kc3`, `anisC1`, `anisC2`) are authored on owning object/region material panels via `apps/control-room/src/modules/inspector/inspectors/objects/material/ObjectMaterialSpec.tsx` when exposed, or directly in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-cubic-anisotropy-scientific-bibliography)=
## Scientific bibliography

- C. Kittel, “Physical Theory of Ferromagnetic Domains,” *Reviews of Modern Physics* **21**(4), 541–583 (1949), [doi:10.1103/RevModPhys.21.541](https://doi.org/10.1103/RevModPhys.21.541).
- J. B. Collings, R. Rama-Eiroa, R. M. Otxoa, R. F. L. Evans, and R. W. Chantrell, “Generalized form of the magnetic anisotropy field in micromagnetic and atomistic spin models,” *Physical Review B* **107**(6), 064413 (2023), [doi:10.1103/PhysRevB.107.064413](https://doi.org/10.1103/PhysRevB.107.064413) | [arXiv:2210.10916](https://arxiv.org/abs/2210.10916).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).

(python-api-interactions-cubic-anisotropy-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L555) | `class CubicAnisotropy` | public constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L294) | `as_vector3` | length-3 tuple conversion without normalization or finiteness rejection |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L570) | `class MagnetHandle` | per-magnet `Kc1`, `Kc2`, `Kc3`, `anisC1`, and `anisC2` authoring facade |
