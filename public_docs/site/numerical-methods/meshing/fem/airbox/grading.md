---
title: "Airbox mesh grading"
description: "Universe-scoped FEM airbox element-size controls."
summary: "Airbox controls are authored independently of magnetic-object controls and are normalized into universe metadata."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-31
reviewed_revision: 969efa0941905825ac569d525f4bdaefc059e2af
source_of_truth: "StudyUniverseHandle.mesh and StudyUniverseConfig"
---

(public-docs-numerical-methods-meshing-fem-airbox-grading)=
# Airbox mesh grading

(airbox-grading-problem-statement)=
## Physical problem

`study.universe.mesh(...)` is the requested resolution of the FEM auxiliary airbox. It is not the magnetic-body mesh and it does not establish an observable error bound.

(airbox-grading-governing-equations)=
## Governing equations

```{math}
:label: eq-airbox-grading-bounds
0<h_{\min}\leq h_{\max}.
```

```{math}
:label: eq-airbox-grading-growth
0 < g \leq 2.5.
```

(airbox-grading-symbols-and-si-units)=
## Symbols and SI units

| Symbol | Meaning | SI unit |
| --- | --- | --- |
| $h_{\min}$ | requested airbox minimum element size | $\mathrm{m}$ |
| $h_{\max}$ | requested airbox maximum element size | $\mathrm{m}$ |
| $g$ | requested airbox growth-rate control | $1$ |

(airbox-grading-assumptions-and-validity)=
## Assumptions and validity

Controls are input constraints, not a quality or convergence certificate. The public validator
accepts a finite growth rate only when $0<g\leq2.5$; despite the error text naming the practical
range `1.0-2.5`, the code does not reject values in $(0,1)$. `asset_pipeline` lowers authored
`airbox_grading="auto"` to the realized `AirboxOptions.grading_mode="geometric"`. Gmsh
narrow-region fields restrict body-surface/body-volume refinement so outer airbox faces are not
treated as magnetic narrow-region walls.

| Solver lane | Status | Limit |
| --- | --- | --- |
| FEM CPU | source-backed | No completed numerical convergence claimed. |
| FEM GPU | capability-gated | No GPU runtime qualification claimed. |
| FDM CPU | not applicable | `cell_size` cannot be combined with these FEM controls. |
| FDM GPU | not applicable | `cell_size` cannot be combined with these FEM controls. |

(airbox-grading-python-api)=
## Python API

```python
# %%
import fullmag as fm
nm = 1e-9
study = fm.study("airbox_grading")
study.engine("fem")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(mode="manual", size=(600 * nm, 400 * nm, 200 * nm))

# %%
study.universe.mesh(maximum_element_size=80 * nm, minimum_element_size=10 * nm, maximum_element_growth_rate=1.3, grading="geometric")
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
| `study.universe.mesh.cell_size` | `Sequence[float] \| None` | `None` | $\mathrm{m}$ | `None`, a positive scalar, or a positive length-3 vector; same-call FEM controls conflict, prior FDM state blocks later FEM controls, but a later `cell_size` does not inspect prior FEM controls | common FDM cell size | FDM authoring state only; runtime lane requires separate qualification; FEM not applicable | `_state._common_fdm_cell_size` |
| `study.universe.mesh.hmax` | `float \| None` | `None` | $\mathrm{m}$ | positive; ignored when canonical maximum is supplied | compatibility alias for airbox maximum | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `study.universe.airbox_hmax` |
| `study.universe.mesh.hmin` | `float \| None` | `None` | $\mathrm{m}$ | positive; ignored when canonical minimum is supplied | compatibility alias for airbox minimum | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `study.universe.airbox_hmin` |
| `study.universe.mesh.maximum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive; canonical value wins over `hmax` | far-airbox size | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `study.universe.airbox_hmax` |
| `study.universe.mesh.minimum_element_size` | `float \| None` | `None` | $\mathrm{m}$ | positive and not greater than resolved maximum; canonical value wins over `hmin` | near-airbox size | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `study.universe.airbox_hmin` |
| `study.universe.mesh.growth_rate` | `float \| None` | `None` | $1$ | Finite and `0 < value <= 2.5` | compatibility growth alias | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `study.universe.airbox_growth_rate` |
| `study.universe.mesh.maximum_element_growth_rate` | `float \| None` | `None` | $1$ | Finite and `0 < value <= 2.5`; ignored when `growth_rate` is supplied | growth control | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `study.universe.airbox_growth_rate` |
| `study.universe.mesh.grading` | `str \| None` | `None` | $1$ | `auto`, `geometric`, or `linear`; `auto` resolves to `geometric`; `None` and `"auto"` both resolve to `"geometric"` | grading vocabulary | FEM authoring/lowering is source-backed; runtime lane requires separate qualification | `AirboxOptions.grading_mode` |

### Realized defaults and asymmetric `cell_size` state

The Python signature exposes authored defaults of `None`. Asset-pipeline realization is more specific: an absent growth control resolves to `grading_ratio=1.3`, and both absent `grading` and authored `grading="auto"` resolve to `grading="geometric"`. Every supplied growth value must be finite and satisfy

\[
0 < \mathrm{growth\_rate} \leq 2.5.
\]

The source permits values below `1.0`; the narrower interval sometimes described as practical guidance is not a validation bound.

| Call/state ordering | Actual validation or mutation |
| --- | --- |
| One `mesh(...)` call supplies `cell_size` together with any FEM size, growth, or grading control. | Rejected before either route is applied. |
| FDM `cell_size` is already stored, then a later `mesh(...)` call supplies FEM controls. | Rejected because the prior FDM state blocks the FEM route. |
| FEM controls are already stored, then a later `mesh(cell_size=...)` call is made. | Accepted by the current code: it writes `_common_fdm_cell_size` and returns without checking or clearing the prior FEM controls. |

The third case can leave contradictory authored state. This is a source-backed limitation, not a supported mixed FEM/FDM configuration and not evidence that either runtime consumes both routes coherently.

(airbox-grading-problem-ir)=
## ProblemIR

The facade resolves each canonical name over its alias, validates values, and
`StudyUniverseConfig.to_ir` stores `airbox_hmax`, `airbox_hmin`,
`airbox_growth_rate`, and `airbox_grading`. `cell_size` takes the separate FDM branch and writes
`_state._common_fdm_cell_size`. The asset pipeline maps `auto` grading to `geometric` and passes
the resolved values to `AirboxOptions`; these remain requested/effective controls, not measured
edge lengths.

(airbox-grading-round-trip-and-failure-semantics)=
## Round-trip and failure semantics

**Requested intent** is the full eight-parameter call. **Resolved execution** separates the FDM
`cell_size` branch from normalized FEM controls, then records effective `AirboxOptions`, Gmsh
field plan, and elements. **Validation errors** include non-positive sizes, non-finite growth,
growth above `2.5`, `hmin > hmax`, invalid grading, and the documented same-call and prior-state
conflict branches for `cell_size` and FEM controls.
**Unsupported combinations** include retaining a prior common FDM `cell_size` while configuring
FEM universe controls or treating growth as a guaranteed layer sequence.

(airbox-grading-discrete-realization)=
## Discrete realization

Gmsh receives mesh options after shared-domain assembly. The narrow-region field confines body refinement to component surfaces/volumes; inspect the realized field plan, size statistics, and operation status.

(airbox-grading-implementation-mapping)=
## Implementation mapping

| Responsibility | Repository path | Stable symbol |
| --- | --- | --- |
| public mesh controls | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` |
| normalized controls | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` |
| generic validation | `packages/fullmag-py/src/fullmag/world.py` | `def _validate_mesh_control_values` |
| auto grading realization | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _study_universe_airbox_options` |
| Gmsh options | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `def _apply_mesh_options` |
| body-only field restriction | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `def _add_narrow_region_field` |

(airbox-grading-validation)=
## Validation

Test rejection first, then record requested controls, realized field plan, size distribution, quality, and solver iterations. Refine one control at a time. No runtime receipt is provided.

(airbox-grading-limitations)=
## Limitations

Current code bounds `g` and resolves the grading vocabulary, but has no universal formula from
`g` to every realized element and no universal physics error estimator or runtime qualification.

(airbox-grading-scientific-bibliography)=
## Scientific bibliography

- C. Geuzaine and J.-F. Remacle, *International Journal for Numerical Methods in Engineering* **79** (2009), [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).

(airbox-grading-source-code-index)=
## Source-code index

| Claim | Repository path | Stable symbol | Evidence |
| --- | --- | --- | --- |
| API and aliases | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseHandle` | source-backed |
| constraints and IR | `packages/fullmag-py/src/fullmag/world.py` | `class StudyUniverseConfig` | source-backed |
| input validation | `packages/fullmag-py/src/fullmag/world.py` | `def _validate_mesh_control_values` | source-backed |
| `auto` to `geometric` realization | `packages/fullmag-py/src/fullmag/meshing/asset_pipeline.py` | `def _study_universe_airbox_options` | source-backed |
| Gmsh application | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `def _apply_mesh_options` | source-backed |
| airbox-safe refinement | `packages/fullmag-py/src/fullmag/meshing/_gmsh_fields.py` | `def _add_narrow_region_field` | source-backed |
