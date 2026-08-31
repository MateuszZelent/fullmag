---
title: "Airbox geometry and enclosure"
description: "Study-universe airbox geometry, lowering, and realization."
summary: "The FEM airbox is an authored auxiliary domain; the generated shared-domain mesh is its resolved realization."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "StudyUniverseConfig and StudyUniverseHandle"
---

(public-docs-numerical-methods-meshing-fem-airbox-geometry)=
# Airbox geometry and enclosure

(airbox-geometry-problem-statement)=
## Physical problem

The FEM airbox is the finite auxiliary domain around magnetic bodies. `study.universe(...)` authors it; it neither creates a mesh nor selects a demagnetization boundary condition. `mode="manual"` requires `size`; `mode="auto"` retains automatic-universe intent.

(airbox-geometry-governing-equations)=
## Governing equations

For manual rectangular input, the authored bounds are:

```{math}
:label: eq-airbox-geometry-bounds
\Omega_a=\{\mathbf{x}:|x_i-c_i|\leq L_i/2,\ i\in\{x,y,z\}\}.
```

For `mode="auto"` with positive per-axis padding, `asset_pipeline._study_universe_airbox_options`
resolves the aggregate object bounds exactly as

```{math}
:label: eq-airbox-auto-size
L_i^{\mathrm{auto}}=x_{i,\max}^{\mathrm{obj}}-x_{i,\min}^{\mathrm{obj}}+2p_i.
```

```{math}
:label: eq-airbox-auto-center
c_i^{\mathrm{auto}}=\frac{x_{i,\min}^{\mathrm{obj}}+x_{i,\max}^{\mathrm{obj}}}{2}.
```

(airbox-geometry-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $\Omega_a$ | authored auxiliary airbox domain | $\mathrm{m^3}$ |
| $\mathbf{x}$ | spatial coordinate | $\mathrm{m}$ |
| $c_i$ | center component | $\mathrm{m}$ |
| $L_i$ | size component | $\mathrm{m}$ |
| $p_i$ | authored non-negative padding component | $\mathrm{m}$ |
| $x_{i,\min}^{\mathrm{obj}}$ | minimum aggregate object bound | $\mathrm{m}$ |
| $x_{i,\max}^{\mathrm{obj}}$ | maximum aggregate object bound | $\mathrm{m}$ |

(airbox-geometry-assumptions-and-validity)=
## Assumptions and validity

`padding` is validated and serialized. With no declared `size`, the asset pipeline uses the two
auto equations above when at least one padding component is positive; otherwise it returns no
airbox options. A declared `size` is authoritative in either `manual` or `auto` mode and is checked
against aggregate geometry bounds with a scale-aware tolerance. `AirboxOptions(shape="sphere")`
exists below this API; component-aware and concatenated-STL paths can report a `bbox` degradation.
Mesh and outer-distance convergence remain separate scientific work.

| Solver lane | Status | Limit |
| --- | --- | --- |
| FEM CPU | source-backed | No runtime result is claimed. |
| FEM GPU | capability-gated | No GPU runtime qualification is claimed. |
| FDM CPU | not applicable | This is a FEM shared-domain mesh API. |
| FDM GPU | not applicable | This is a FEM shared-domain mesh API. |

(airbox-geometry-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("manual_airbox")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")

# %%
study.universe(mode="manual", size=(600 * nm, 400 * nm, 200 * nm), center=(0.0, 0.0, 0.0), padding=(0.0, 0.0, 0.0))
study.universe.mesh(maximum_element_size=80 * nm, minimum_element_size=10 * nm)
body = study.geometry(fm.Box(size=(200 * nm, 100 * nm, 10 * nm), name="film"), name="film")
body.mesh(maximum_element_size=8 * nm, minimum_element_size=4 * nm, order=1)
body.Ms = 800e3
body.Aex = 13e-12
body.m = fm.texture.uniform(1.0, 0.0, 0.0)

# %%
study.exchange()
study.demag(model="airbox", variant="robin")
study.build_domain_mesh()
study.stages.add_relax(stage_id="equilibrium", algorithm="llg_overdamped", max_steps=1000)
```

| Python | Type | Default | SI unit | Validation | Meaning | Backend support | ProblemIR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `study.universe.mode` | `str \| None` | `None` | $1$ | `auto` or `manual`; manual requires size | universe mode | FEM authoring/lowering is source-backed; runtime lane requires separate qualification; FDM not applicable | `study.universe.mode` |
| `study.universe.size` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | three strictly positive components when present | outer dimensions | FEM authoring/lowering is source-backed; runtime lane requires separate qualification; FDM not applicable | `study.universe.size` |
| `study.universe.center` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | three finite components | outer-domain center | FEM authoring/lowering is source-backed; runtime lane requires separate qualification; FDM not applicable | `study.universe.center` |
| `study.universe.padding` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | three non-negative components | authored padding | FEM authoring/lowering is source-backed; runtime lane requires separate qualification; FDM not applicable | `study.universe.padding` |

(airbox-geometry-problem-ir)=
## ProblemIR

`StudyUniverseConfig.to_ir` writes `mode`, `size`, `center`, `padding`, `airbox_hmax`,
`airbox_hmin`, `airbox_growth_rate`, and `airbox_grading`. The table rows map one-to-one to
the first four keys. `_study_universe_airbox_options` lowers explicit bounds or computes auto
bounds and returns `AirboxOptions(size=..., center=...)`; this resolved mesher input remains
distinct from observed mesh coordinates.

(airbox-geometry-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is `StudyUniverseConfig`. **Resolved execution** first includes the explicit
or auto `AirboxOptions` produced by `asset_pipeline`, then the shared-domain mesh/report after
`study.build_domain_mesh()`. **Validation errors** include invalid mode, non-positive size,
negative padding, manual mode without size, and explicit bounds that do not contain all geometry.
**Unsupported combinations** include treating the FEM airbox as an FDM grid or assuming a
requested sphere is always realized.

(airbox-geometry-discrete-realization)=
## Discrete realization

`_study_universe_airbox_options` owns conversion of authored universe metadata into
`AirboxOptions`. `_rectangular_airbox_bounds_from_options` then resolves rectangular min/max
bounds from center and size. `build_domain_mesh` materializes the shared-domain FEM mesh.

(airbox-geometry-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
| --- | --- | --- |
| validation and serialization | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` |
| public authoring facade | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` |
| universe update lowering | `packages/fullmag-py/src/fullmag/world.py` | `def _configure_study_universe` |
| mesh request | `packages/fullmag-py/src/fullmag/world.py` | `def build_domain_mesh` |
| explicit/auto bounds and grading lowering | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _study_universe_airbox_options` |
| rectangular realized bounds | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _rectangular_airbox_bounds_from_options` |
| shape status | `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` | `def _airbox_shape_status` |

(airbox-geometry-validation)=
## Validation

Reject invalid authoring inputs, then inspect realized bounds, air elements, markers, boundary facets, and operation statuses. Vary outer distance independently from mesh controls for physics convergence. Runtime and device evidence are not supplied here.

(airbox-geometry-limitations)=
## Limitations

The padding expansion and bbox center are source-backed, but they do not provide an open-boundary
error estimate, Robin coefficient, mesh-convergence receipt, or GPU qualification.

(airbox-geometry-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, *International Journal for Numerical Methods in Engineering* **79** (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(airbox-geometry-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Evidence |
| --- | --- | --- | --- |
| geometry and IR fields | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` | source-backed |
| `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | Public `StudyUniverseHandle.mesh` owns authored FEM/FDM mesh controls and the asymmetric `cell_size` routing. |
| `packages/fullmag-py/src/fullmag/world.py` | `_configure_study_universe` | Public `universe.airbox(...)` configuration owns authored `AirboxOptions` before asset-pipeline realization. |
| materialization | `packages/fullmag-py/src/fullmag/world.py` | `def build_domain_mesh` | source-backed |
| auto and explicit bounds lowering | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _study_universe_airbox_options` | source-backed |
| realized rectangular bounds | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _rectangular_airbox_bounds_from_options` | source-backed |
| sphere degradation | `packages/fullmag-py/src/fullmag/meshing/_gmsh_generators.py` | `def _airbox_shape_status` | source-backed |


## Scope and purpose

This page defines the public contract for FEM airbox geometry. It is an authoring and implementation reference: the Python example, the serialized ProblemIR description, the implementation mapping, and the adjacent source map are the source-backed contract. A capability marked partial or not evaluated is not presented as a production guarantee.

## Scientific and numerical model

The mesh or grid is a discrete approximation of the continuous domain. For a Cartesian partition, each spacing satisfies `Delta_i = L_i / N_i`; for a geometry-dependent FEM mesh, the requested local target is bounded by the active bulk, interface, boundary, and topology constraints. In compact form, `h_target(x) = min(h_bulk(x), h_interface(x), h_boundary(x))`. Length quantities use SI metres (`m`); counts, orders, and topology labels are dimensionless.

The equations and assumptions in the earlier physical-problem and governing-equations sections state the model-specific specialization. This section does not introduce a conversion from FEM to FDM, a hidden topology conversion, or a silent CPU fallback.

## Parameters

The exact callable and argument names are the ones shown in the `## Python API` section above. For this page the parameter family is geometry extents, padding, and mesh target. Use the documented defaults, validation rules, and ProblemIR lowering exactly as shown; do not replace a canonical argument with an unlisted alias. Numerical lengths must be supplied in metres, and invalid positive-length, count, order, periodicity, or topology constraints must fail closed rather than being silently repaired.

## Control Room workflow

In Control Room, select the engine and mesh workflow, enter the same values as the Python authoring example, inspect the planned mesh or grid report, and only then submit the run. The UI is a projection of the public contract: a missing control is not evidence that the backend accepts the option, and a visible control is not evidence that a production lane is enabled. When the page or capability register marks a field partial or not evaluated, keep the workflow explicitly bounded to the implemented path.

## Diagnostics and failure semantics

A valid request must preserve the declared geometry, units, element or cell topology, and backend lane. Reject non-finite or non-positive lengths, invalid counts and orders, incompatible periodic or shared-boundary data, and unsupported topology combinations at the owning validation layer. Reports should retain requested and resolved values, source identity, and any capability gate. No diagnostic may hide a failed mesh realization by substituting another discretization.

## Where this is implemented

The existing implementation-mapping and source-code-index sections identify the exact public authoring, ProblemIR, planner, realization, and runtime owners for this topic. The adjacent `.source-map.json` file is the machine-readable source of truth for those paths, symbols, responsibilities, backend matrix, and reviewed revision. Claims in this page must be updated together with that map when an owner moves.