---
title: Universe and Domain
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
---

# Universe and domain

(public-docs-python-api-geometry-universe-and-domain)=
(python-api-geometry-universe-and-domain-problem-statement)=
## Problem statement

The universe carries domain bounds, airbox padding/grading (`StudyUniverseConfig`,
`StudyUniverseHandle.mesh`), and periodic boundary policy (`fm.pbc`, `FdmPbc`); mesh generation and
backend realization happen after authoring.

This page covers the Python authoring contract: domain periodicity, demagnetization closure modes,
and exterior mesh policy validate in Python and lower to `ProblemIR` before shared-domain or
structured grid generation.

(python-api-geometry-universe-and-domain-governing-equations)=
## Governing equations

The computational domain $\Omega \subset \mathbb{R}^3$ specifies open or periodic boundary axes
$\hat{\mathbf{e}}_i$ ($i \in \{x,y,z\}$), periodic magnetostatic kernel summation or airbox closure
(`open`, `truncated_images` with per-axis `image_counts`, or `periodic_airbox_k0`), and exterior
airbox / grid sizing bounds $h_{\min} \le h_{\max}$ with grading and curvature controls. Physical
domain and exterior closure semantics are documented in {doc}`../../physics/geometry-and-materials`,
{doc}`../meshing/fem/airbox/index`, and {doc}`../boundary-conditions/periodic-boundary-conditions`.

(python-api-geometry-universe-and-domain-symbols-and-si-units)=
## Symbols and SI units

Spatial bounds and mesh spacing parameters (`StudyUniverseConfig.size`, `center`, `padding`,
`airbox_hmin`, `airbox_hmax`, `StudyUniverseHandle.mesh.cell_size`, `hmin`, `hmax`,
`minimum_element_size`, `maximum_element_size`) use SI metres ($\mathrm{m}$). Boolean periodicity
flags (`pbc.x`, `pbc.y`, `pbc.z`), `FdmPbc.demag`, `FdmPbc.image_counts`, grading/curvature
factors, and `StudyUniverseConfig.mode` are dimensionless ($1$).

(python-api-geometry-universe-and-domain-assumptions-and-validity)=
## Assumptions and validity

- `cell_size`, `hmin`, `hmax`, `growth_rate`, `maximum_element_growth_rate`, `curvature_factor`,
  and `narrow_region_resolution` must be positive finite values when supplied, with `hmin <= hmax`.
- `FdmPbc.demag` accepts `"open"`, `"truncated_images"`, or `"periodic_airbox_k0"`:
  - `"periodic_airbox_k0"` requires `axes == (True, True, False)` (periodic $x,y$, open $z$).
  - `FdmPbc.image_counts` (3 non-negative integers) is accepted ONLY when `demag == "truncated_images"`.
- Unsupported combinations—such as `demag="periodic_airbox_k0"` paired with an FDM backend—fail
  closed at lowering or resolution.

(python-api-geometry-universe-and-domain-python-api)=
## Python API

### Constructors and handles

- `fm.StudyUniverseConfig(mode="auto", size=None, center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0), airbox_hmax=None, airbox_hmin=None, airbox_growth_rate=None, airbox_grading=None, airbox_curvature_factor=None, airbox_narrow_region_resolution=None)`
- `fm.FdmPbc(axes, demag="open", image_counts=None)` and module helper `fm.pbc(x=False, y=False, z=False, *, demag="open", images=None)`
- `study.universe.mesh(*, cell_size=None, hmax=None, hmin=None, maximum_element_size=None, minimum_element_size=None, growth_rate=None, maximum_element_growth_rate=None, grading=None, curvature_factor=None, narrow_region_resolution=None)`

### Parameters

| Python name | Type | Default | SI unit | Validation | Meaning | FEM/FDM CPU/GPU support | ProblemIR destination |
|---|---|---|---|---|---|---|---|
| `pbc.x` | `bool` | `False` | $1$ | boolean | periodic boundary flag along $x$ | FEM/FDM CPU/GPU: IR; resolver-specific | `backend_policy.pbc.axes[0]` |
| `pbc.y` | `bool` | `False` | $1$ | boolean | periodic boundary flag along $y$ | FEM/FDM CPU/GPU: IR; resolver-specific | `backend_policy.pbc.axes[1]` |
| `pbc.z` | `bool` | `False` | $1$ | boolean | periodic boundary flag along $z$ | FEM/FDM CPU/GPU: IR; resolver-specific | `backend_policy.pbc.axes[2]` |
| `FdmPbc.demag` | `Literal["open", "truncated_images", "periodic_airbox_k0"]` | `"open"` | $1$ | `"open"`, `"truncated_images"`, or `"periodic_airbox_k0"` (requires `x,y` periodic, `z` open) | periodic magnetostatic closure mode | FEM/FDM CPU/GPU: IR; planner validates backend match | `backend_policy.pbc.demag` |
| `FdmPbc.image_counts` | `tuple[int, int, int] \| None` | `None` | $1$ | three non-negative integers; requires `demag="truncated_images"` | per-axis MuMax-style periodic image counts (`images=` kwarg on `fm.pbc`) | FDM CPU/GPU: IR; planner-validated | `backend_policy.pbc.image_counts` |
| `StudyUniverseConfig.mode` | `str` | `"auto"` | $1$ | `"auto"` or `"manual"` | automatic bounding box vs explicit exterior domain | FEM/FDM CPU/GPU: IR | `problem_meta.runtime_metadata.domain_frame.declared_universe.mode` |
| `StudyUniverseConfig.size` | `tuple[float, float, float] \| None` | `None` | $\mathrm{m}$ | three positive finite lengths when supplied | explicit exterior domain extents | FEM/FDM CPU/GPU: IR | `problem_meta.runtime_metadata.domain_frame.declared_universe.size` |
| `StudyUniverseConfig.center` | `tuple[float, float, float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | three finite coordinates | exterior domain center | FEM/FDM CPU/GPU: IR | `problem_meta.runtime_metadata.domain_frame.declared_universe.center` |
| `StudyUniverseConfig.padding` | `tuple[float, float, float]` | `(0.0, 0.0, 0.0)` | $\mathrm{m}$ | three non-negative lengths | exterior padding added around magnetic objects | FEM/FDM CPU/GPU: IR | `problem_meta.runtime_metadata.domain_frame.declared_universe.padding` |
| `StudyUniverseHandle.mesh.cell_size` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | three positive finite components | structured FDM grid cell size | FDM CPU/GPU: IR | `backend_policy.discretization_hints.fdm.cell` |
| `StudyUniverseHandle.mesh.hmax` | `float \| None` | `None` | $\mathrm{m}$ | positive finite; `hmin <= hmax` (alias `maximum_element_size`) | maximum exterior/airbox FEM element size | FEM CPU/GPU: IR | `airbox_hmax` |
| `StudyUniverseHandle.mesh.hmin` | `float \| None` | `None` | $\mathrm{m}$ | positive finite; `hmin <= hmax` (alias `minimum_element_size`) | minimum exterior/airbox FEM element size | FEM CPU/GPU: IR | `airbox_hmin` |
| `StudyUniverseHandle.mesh.maximum_element_growth_rate` | `float \| None` | `None` | $1$ | positive finite (alias `growth_rate`) | maximum FEM element size growth rate | FEM CPU/GPU: IR | `airbox_growth_rate` |
| `StudyUniverseHandle.mesh.grading` | `str \| None` | `None` | $1$ | `"auto"`, `"geometric"`, or `"linear"` | exterior FEM airbox mesh grading policy | FEM CPU/GPU: IR | `airbox_grading` |
| `StudyUniverseHandle.mesh.curvature_factor` | `float \| None` | `None` | $1$ | positive finite | FEM curved-surface resolution factor | FEM CPU/GPU: IR | `airbox_curvature_factor` |
| `StudyUniverseHandle.mesh.narrow_region_resolution` | `float \| None` | `None` | $1$ | positive finite | FEM thin-gap / narrow-region refinement factor | FEM CPU/GPU: IR | `airbox_narrow_region_resolution` |

### Stage-first example

```python
# %% Stage-first FEM airbox grading and FdmPbc periodicity example
import fullmag as fm

nm = 1.0e-9

study = fm.study("universe_domain_api_example")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(200 * nm, 200 * nm, 120 * nm),
    center=(0.0, 0.0, 0.0),
)
study.universe.mesh(
    hmin=4 * nm,
    hmax=40 * nm,
    maximum_element_growth_rate=1.35,
    grading="geometric",
    curvature_factor=0.6,
    narrow_region_resolution=1.0,
)
body = study.geometry(fm.Box(size=(100 * nm, 40 * nm, 5 * nm)), name="film")
body.Ms = 800.0e3
body.Aex = 13.0e-12
body.alpha = 0.02
body.m = fm.texture.uniform(1.0, 0.0, 0.0)
study.exchange()
study.stages.add_relax(stage_id="api-example", dt=5e-13, max_steps=1)

# Verify FdmPbc modes and StudyUniverseConfig:
pbc_images = fm.FdmPbc(axes=(True, True, False), demag="truncated_images", image_counts=(4, 4, 0))
pbc_k0 = fm.FdmPbc(axes=(True, True, False), demag="periodic_airbox_k0")
cfg = fm.StudyUniverseConfig(mode="auto", padding=(50 * nm, 50 * nm, 50 * nm), airbox_hmax=40 * nm)
assert pbc_images.to_ir()["image_counts"] == [4, 4, 0]
assert pbc_k0.to_ir()["demag"] == "periodic_airbox_k0"
assert cfg.mode == "auto"
```

(python-api-geometry-universe-and-domain-problem-ir)=
## ProblemIR

`FdmPbc.to_ir()` emits `{"axes": ["periodic" | "open", ...], "demag": ...}` (plus `"image_counts"`
when `demag="truncated_images"`), while `study.universe(...)` and `study.universe.mesh(...)` lower
bounds, padding, and airbox mesh grading/curvature controls into `domain_frame.declared_universe`
and FEM airbox mesh workflow fields in `ProblemIR`.

(python-api-geometry-universe-and-domain-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

`requested intent` preserves periodic axes, demag mode, image counts, universe bounds, and exterior
mesh sizing/grading in `ProblemIR` independently of `resolved execution`. `Validation errors` reject
non-positive mesh bounds (`hmin > hmax`), invalid `FdmPbc.demag` values, `image_counts` without
`truncated_images`, or `periodic_airbox_k0` without `(True, True, False)` axes, while
`unsupported combinations` fail closed at backend resolution.

(python-api-geometry-universe-and-domain-discrete-realization)=
## Discrete realization

| Solver | Device | Universe & PBC realization | Qualification boundary |
| --- | --- | --- | --- |
| FDM | CPU | Structured grid over universe/object bounds; `open` or `truncated_images` periodic demag | Periodic kernel accuracy verified per image count |
| FDM | GPU | CUDA FFT demag with `open` or `truncated_images` PBC | GPU parity validated separately |
| FEM | CPU | Conformal Gmsh airbox mesh using `StudyUniverseConfig` and `universe.mesh(...)` grading; `open` or `periodic_airbox_k0` | See {doc}`../meshing/fem/airbox/index` |
| FEM | GPU | Consumes host-built conformal airbox mesh and periodic constraints on CUDA/cuDSS | Executed-device GPU qualification remains separate |

(python-api-geometry-universe-and-domain-implementation-mapping)=
## Implementation mapping

Authoritative implementations live in `packages/fullmag-py/src/fullmag/world.py`
(`class StudyUniverseConfig`, `class StudyUniverseHandle`, `StudyUniverseHandle.mesh`) and
`packages/fullmag-py/src/fullmag/model/problem.py` (`class FdmPbc`).

(python-api-geometry-universe-and-domain-validation)=
## Validation

Focused repository tests covering domain periodicity and exterior shared-domain meshing include
`test_study_pbc_serializes_problem_ir_and_default_fem_pairs` and
`test_fem_backend_emits_shared_domain_mesh_asset_for_manual_universe`. Live solver runtime and
Control Room browser behavior require separate qualification.

(python-api-geometry-universe-and-domain-limitations)=
## Limitations and Control Room

Exterior domain / Airbox geometry bounds, padding, and FEM airbox mesh sizing are configured in
Control Room via the Universe / **Airbox Mesh Parameters** inspector (`Model Explorer -> Universe / Airbox`),
with geometry-only inspection on FDM sessions and full exterior mesh sizing controls on FEM sessions
(see {doc}`/frontend/meshing/airbox-mesh`). Advanced multi-box or custom airbox grading strategies
without matching inspector fields remain `Python-only`.

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
| [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2591) | [`class StudyUniverseConfig`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L2591), [`class StudyUniverseHandle`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/world.py#L5693) | universe configuration and exterior mesh handle |
| [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) | [`class FdmPbc`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/problem.py#L220) | periodic axis, demag mode, and image-count validation and IR lowering |
