---
title: Zeeman Python API
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Zeeman field

(public-docs-python-api-interactions-zeeman)=
(python-api-interactions-zeeman-problem-statement)=
## Problem statement

External static magnetic flux density is authored either as a uniform vector (`study.b_ext(...)` / `fm.Zeeman(B)`) or as an explicit cell-wise induction map (`fm.StaticFieldMap(id=..., field_B_T=...)`), both in SI tesla.

This page covers the Python authoring contract for uniform and static spatially mapped external fields, including construction checks and canonical `ProblemIR` serialization before field evaluation.

(python-api-interactions-zeeman-governing-equations)=
## Governing equations

The Zeeman interaction couples magnetization $\mathbf{M} = M_s\mathbf{m}$ to an applied external magnetic flux density $\mathbf{B}(\mathbf{x})$ with volumetric energy density $w_Z = -\mathbf{M}\cdot\mathbf{B}$ and effective field $\mathbf{H}_Z = \mathbf{B}/\mu_0$. Continuum definitions and energy sign conventions are documented in {doc}`../../physics/interactions/zeeman/index`.

(python-api-interactions-zeeman-symbols-and-si-units)=
## Symbols and SI units

`fm.Zeeman.B`, `study.b_ext` components/magnitude, and `fm.StaticFieldMap.field_B_T` entries are authored as Cartesian magnetic flux density in SI tesla ($\mathrm{T}$). Spherical angles `theta` and `phi` in `study.b_ext(...)` use degrees ($\mathrm{deg}$). `fm.StaticFieldMap.id` is a dimensionless identifier ($1$). The corresponding magnetic effective field $\mathbf{B}/\mu_0$ has units of $\mathrm{A\,m^{-1}}$.

(python-api-interactions-zeeman-assumptions-and-validity)=
## Assumptions and validity

- `fm.Zeeman(B)` passes `B` to `fullmag._validation.as_vector3`, which checks only that `B` has length 3 and converts each component via `float(...)`. It does **not** reject `NaN` or `Inf` at Python construction; finiteness is enforced at planner and backend lowering.
- `fm.StaticFieldMap(*, id, field_B_T)` validates in Python that `id` is a non-empty string and that `field_B_T` is a non-empty sequence of three-component vectors whose components are all finite (`require_finite`).
- `study.b_ext(magnitude, by=None, bz=None, *, theta=None, phi=None)` accepts either Cartesian `(bx, by, bz)` or spherical `(magnitude, theta=..., phi=...)` in degrees, raising `TypeError` when the two calling conventions are mixed or incomplete.

(python-api-interactions-zeeman-python-api)=
## Python API

### Constructors and study facade

- `study.b_ext(bx, by, bz)` or `study.b_ext(magnitude, theta=..., phi=...)` (also available as flat `fm.b_ext(...)`)
- `fm.Zeeman(B)`
- `fm.StaticFieldMap(*, id, field_B_T)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `fm.Zeeman.B` | `Sequence[float]` | `required` | $\mathrm{T}$ | length-3 sequence via `as_vector3`; planner/backend checks finiteness | uniform applied magnetic induction | FEM/FDM CPU/GPU: IR and local Zeeman kernels | `B` |
| `fm.StaticFieldMap.id` | `str` | `required` | $1$ | non-empty string via `require_non_empty` | static field map identifier | FEM/FDM CPU/GPU: IR; planner validates cell/node cardinality | `id` |
| `fm.StaticFieldMap.field_B_T` | `Sequence[Sequence[float]]` | `required` | $\mathrm{T}$ | non-empty sequence of finite length-3 vectors | per-cell static external induction map | FEM/FDM CPU/GPU: IR; planner validates cell/node cardinality | `field_B_T` |
| `study.b_ext` | `(bx, by, bz)` or `(magnitude, theta, phi)` | `required` | $\mathrm{T}$ ($\mathrm{deg}$ for angles) | Cartesian or spherical mode; cannot mix | study-scoped uniform external bias field | FEM/FDM CPU/GPU: lowers to `zeeman` energy term | `energy_terms[].B` |

### Stage-first example

```python
# %% Stage-first uniform external field via study.b_ext
import fullmag as fm

study = fm.study("zeeman_bias_relaxation")
study.engine("fdm")
study.device("cpu", precision="double")
study.objects.mesh.defaults(cell_size=(5.0e-9, 5.0e-9, 5.0e-9))

film = study.geometry(fm.Box(size=(100.0e-9, 20.0e-9, 5.0e-9)), name="film")
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
# Cartesian bias field B = (0, 0, 10 mT) — or use study.b_ext(10e-3, theta=90.0, phi=0.0)
study.b_ext(0.0, 0.0, 10.0e-3)
study.stages.add_relax(stage_id="relax_bias", dt=5.0e-13, max_steps=100)

# %% Typed Zeeman and StaticFieldMap IR inspection
uniform_term = fm.Zeeman(B=(0.0, 0.0, 10.0e-3))
uniform_ir = uniform_term.to_ir()

static_map = fm.StaticFieldMap(
    id="stray_bias_map",
    field_B_T=((0.0, 0.0, 5.0e-3), (0.0, 0.0, 10.0e-3)),
)
map_ir = static_map.to_ir()
```

For time-varying or spatially windowed magnetic fields, use `fm.RegionalFieldDrive` or `study.add_simpleantenna.arbitrary_mask(...)` documented in {doc}`../current-and-excitations/regional-field-drive`.

(python-api-interactions-zeeman-problem-ir)=
## ProblemIR

- `fm.Zeeman(B).to_ir()` emits `{"kind": "zeeman", "B": [Bx, By, Bz]}` preserving all three Cartesian components in tesla.
- `fm.StaticFieldMap(id=..., field_B_T=...).to_ir()` emits `{"kind": "static_field_map", "id": ..., "field_B_T": [[Bx, By, Bz], ...]}`.
- `study.b_ext(...)` lowers into a canonical `zeeman` energy term on the compiled `ProblemIR`.

(python-api-interactions-zeeman-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves the exact Cartesian induction vector or static field map in `ProblemIR` independently of `resolved execution`. `Validation errors` reject malformed three-vectors in `fm.Zeeman`, empty/non-finite entries in `fm.StaticFieldMap`, and mixed Cartesian/spherical arguments in `study.b_ext`, while non-finite `Zeeman.B` components or mismatched `StaticFieldMap` cardinalities fail closed at planner validation. `Unsupported combinations` fail closed if a stage or backend path cannot consume the requested field map.

(python-api-interactions-zeeman-discrete-realization)=
## Discrete realization

The Python contract supplies external magnetic flux density $\mathbf{B}$ in `ProblemIR` only; converting $\mathbf{B}/\mu_0$ across active cells/nodes and integrating Zeeman energy are handled by the solver backends. See {ref}`numerical-methods-performance-fdm-core` and {ref}`numerical-methods-performance-fem-gpu-kernels` for fused local effective-field execution details.

| Solver | Device | Uniform `zeeman` (`study.b_ext` / `fm.Zeeman`) | `static_field_map` (`fm.StaticFieldMap`) |
|---|---|---|---|
| `FDM` | `CPU` | Supported | IR authored; planner checks cell count and runtime support |
| `FDM` | `GPU` | Supported | IR authored; planner checks cell count and runtime support |
| `FEM` | `CPU` | Supported | IR authored; planner checks node/element support |
| `FEM` | `GPU` | Supported | IR authored; planner checks node/element support |

(python-api-interactions-zeeman-implementation-mapping)=
## Implementation mapping

- Uniform and mapped field classes: `packages/fullmag-py/src/fullmag/model/energy.py` (`class Zeeman`, `class StaticFieldMap`).
- Vector length conversion: `packages/fullmag-py/src/fullmag/_validation.py` (`as_vector3`).
- Stage-first external field helper: `packages/fullmag-py/src/fullmag/world.py` (`b_ext` and `StudyBuilder.b_ext`).

(python-api-interactions-zeeman-validation)=
## Validation

Focused repository unit tests covering `Zeeman` vector serialization include `test_zeeman_serializes_vector_to_ir`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-interactions-zeeman-limitations)=
## Limitations and Control Room

Control Room edits study/stage external bias fields via `apps/control-room/src/modules/inspector/inspectors/objects/physics/ObjectPhysicsSpec.tsx` and `apps/control-room/src/modules/inspector/inspectors/objects/physics/PhysicsModuleSpec.tsx`; low-level `fm.StaticFieldMap` arrays are authored in Python scripts. See {doc}`/frontend/capability-register`.

(python-api-interactions-zeeman-scientific-bibliography)=
## Scientific bibliography

- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers (Wiley), New York (1963).
- E. C. Stoner and E. P. Wohlfarth, “A mechanism of magnetic hysteresis in heterogeneous alloys,” *Philosophical Transactions of the Royal Society of London. Series A, Mathematical and Physical Sciences* **240**(826), 599–642 (1948), [doi:10.1098/rsta.1948.0007](https://doi.org/10.1098/rsta.1948.0007).
- A. Baker, M. Beg, G. Ashton, M. Albert, D. Chernyshenko, W. Wang, S. Zhang, M.-A. Bisotti, M. Franchin, C. L. Hu, R. Stamps, T. Hesjedal, and H. Fangohr, “Proposal of a micromagnetic standard problem for ferromagnetic resonance simulations,” *Journal of Magnetism and Magnetic Materials* **421**, 428–439 (2017), [doi:10.1016/j.jmmm.2016.08.009](https://doi.org/10.1016/j.jmmm.2016.08.009) | [arXiv:1603.05419](https://arxiv.org/abs/1603.05419).

(python-api-interactions-zeeman-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L197) | `class Zeeman` | uniform induction constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/model/energy.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/energy.py#L208) | `class StaticFieldMap` | cell-wise static external induction map constructor and IR lowering |
| [`packages/fullmag-py/src/fullmag/_validation.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/_validation.py#L294) | `as_vector3` | length-3 tuple conversion used by `Zeeman` |
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L6439) | `class StudyBuilder` | stage-first `study.b_ext(...)` Cartesian and spherical bias-field facade |
