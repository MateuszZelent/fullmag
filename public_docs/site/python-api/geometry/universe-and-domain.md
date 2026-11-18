---
title: Universe and Domain
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: ab3c8802a691a535063102c12f9a79bb0043b367
---

# Universe and domain

(public-docs-python-api-geometry-universe-and-domain)=
(python-api-geometry-universe-and-domain-problem-statement)=
## Problem statement

The universe carries domain policy; mesh generation and backend realization happen after authoring.

This page covers the Python authoring contract: domain periodicity and exterior mesh policy validate in Python and lower to `ProblemIR` before shared-domain or structured grid generation.

(python-api-geometry-universe-and-domain-governing-equations)=
## Governing equations

The computational domain $\Omega \subset \mathbb{R}^3$ specifies open or periodic boundary axes $\hat{\mathbf{e}}_i$ ($i \in \{x,y,z\}$), periodic magnetostatic kernel summation or image counts, and exterior airbox / grid sizing bounds $h_{\min} \le h_{\max}$. Physical domain and exterior closure semantics are documented in {doc}`../../physics/geometry-and-materials`, {doc}`../meshing/fem/airbox/index`, and {doc}`../boundary-conditions/periodic-boundary-conditions`.

(python-api-geometry-universe-and-domain-symbols-and-si-units)=
## Symbols and SI units

Mesh spacing parameters (`mesh.cell_size`, `mesh.hmin`, `mesh.hmax`) use SI metres ($\mathrm{m}$). Boolean periodicity flags (`pbc.x/y/z`), `pbc.demag`, `pbc.images`, and geometric grading ratios (`mesh.growth_rate`) are dimensionless ($1$).

(python-api-geometry-universe-and-domain-assumptions-and-validity)=
## Assumptions and validity

`cell_size`, `hmin`, `hmax`, and `growth_rate` must be positive finite values when supplied, with `hmin <= hmax`, and `pbc.images` must be a positive integer when provided. Unsupported combinations—such as periodic airbox demagnetization paired with an incompatible FDM policy—fail closed at lowering or resolution.

(python-api-geometry-universe-and-domain-python-api)=
## Python API

### Constructor or function

`fm.pbc(...)` and `StudyUniverseHandle.mesh(...)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `pbc.x/y/z` | `bool` | `False` | $1$ | boolean | periodic axis flags | FEM/FDM CPU/GPU: IR; resolver-specific | `periodic axes` |
| `pbc.demag` | `str` | `open` | $1$ | supported demag mode | open-domain demag choice | FEM/FDM CPU/GPU: IR; resolver-specific | `demag` |
| `pbc.images` | `int or None` | `None` | $1$ | positive when supplied | periodic image count | FEM/FDM CPU/GPU: IR; resolver-specific | `images` |
| `mesh.cell_size` | `tuple[float,float,float] or None` | `None` | $\mathrm{m}$ | positive components | structured cell size | FDM CPU/GPU: IR; FEM resolver-specific | `cell_size` |
| `mesh.hmax/hmin` | `float or None` | `None` | $\mathrm{m}$ | positive when supplied; hmin <= hmax | unstructured size bounds | FEM CPU/GPU: IR; FDM resolver-specific | `hmax/hmin` |
| `mesh.growth_rate` | `float or None` | `None` | $1$ | positive when supplied | mesh grading growth | FEM/FDM CPU/GPU: IR; resolver-specific | `growth_rate` |

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
# `pbc` mutates the active study defaults and returns None. Construct the
# typed value separately when the canonical ProblemIR is needed.
fm.pbc(x=True, y=False, z=False, demag="open")
value = fm.FdmPbc(axes=(True, False, False), demag="open")
canonical_ir = value.to_ir()
```

In a complete simulation script, `fm.pbc(...)` and `study.universe.mesh(...)` update the active study domain policy directly before stage compilation.

(python-api-geometry-universe-and-domain-problem-ir)=
## ProblemIR

`FdmPbc.to_ir()` emits `{"axes": [...], "demag": ...}` (with optional periodic image settings), while `StudyUniverseHandle.mesh(...)` lowers exterior bounds, padding, and airbox mesh grading parameters into study/mesh workflow fields in `ProblemIR`.

(python-api-geometry-universe-and-domain-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves periodic axes, demag mode, image counts, and exterior mesh sizing in `ProblemIR` independently of `resolved execution`. `Validation errors` reject non-positive mesh bounds (`hmin > hmax`) or invalid demag modes, while `unsupported combinations` fail closed at backend resolution.

(python-api-geometry-universe-and-domain-discrete-realization)=
## Discrete realization

The Python contract supplies domain periodicity and sizing policy only; periodic lattice summation, airbox FEM conformal meshing, and solver-specific boundary closures are executed by the meshing and demagnetization backends.

(python-api-geometry-universe-and-domain-implementation-mapping)=
## Implementation mapping

The authoritative implementation is `packages/fullmag-py/src/fullmag/world.py` (`class StudyUniverseHandle`). Constructor options, validation branches, defaults, and lowered `ProblemIR` keys come directly from that module.

(python-api-geometry-universe-and-domain-validation)=
## Validation

Focused repository tests covering domain periodicity and exterior shared-domain meshing include `test_study_pbc_serializes_problem_ir_and_default_fem_pairs` and `test_fem_backend_emits_shared_domain_mesh_asset_for_manual_universe`. Live solver runtime and Control Room browser behavior require separate qualification.

(python-api-geometry-universe-and-domain-limitations)=
## Limitations and Control Room

Exterior domain / Airbox geometry bounds, padding, and FEM airbox mesh sizing are configured in Control Room via the Universe / **Airbox Mesh Parameters** inspector (`Model Explorer -> Universe / Airbox`), with geometry-only inspection on FDM sessions and full exterior mesh sizing controls on FEM sessions (see {doc}`/frontend/meshing/airbox-mesh`). Advanced multi-box or custom airbox grading strategies without matching inspector fields remain `Python-only`.

### Control Room support

| Python/API surface | Control Room path | Status | Transaction |
|---|---|---|---|
| Domain bounds, padding mode, & airbox mesh sizing | `Model Explorer -> Universe / Airbox` (**Airbox Mesh Parameters**) | `partial` (FEM editable; FDM geometry subset) | Scene / domain mesh invalidation on commit |
| Unsupported custom exterior rules | Python DSL | `Python-only` | Author in Python |

```{image} /_static/images/ui/inspector-fem-mesh-and-airbox.png
:alt: Control Room FEM Mesh and Airbox Parameters inspector panel
:align: center
:width: 100%
```

See {doc}`/frontend/capability-register` and {doc}`/frontend/meshing/airbox-mesh`.

(python-api-geometry-universe-and-domain-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, “Gmsh: A 3-D finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79**(11), 1309–1331 (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579) | [Open-access HAL PDF](https://hal.science/hal-03406365v1/file/Geuzaine2009.pdf).

(python-api-geometry-universe-and-domain-source-code-index)=
## Source code index

| Source path | Symbol | Responsibility |
|---|---|---|
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | public constructor and IR lowering |
