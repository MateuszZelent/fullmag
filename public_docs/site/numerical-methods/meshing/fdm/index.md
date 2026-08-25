---
title: "Finite-difference meshing"
description: "Entry point for Fullmag FDM Cartesian-grid documentation."
summary: "Fullmag FDM meshing is owned by the Study execution plan and produces a structured lattice plus canonical magnetic-support masks and region metadata."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FDM execution plan, structured grid descriptors, mask resources and demag capability resolution"
---

(public-docs-numerical-methods-meshing-fdm-index)=
# Finite-difference meshing

**Last changes: 12:31 24.08.2026**

Fullmag FDM meshing is owned by the Study execution plan and produces a structured lattice plus canonical magnetic-support masks and region metadata.

::::{admonition} Implementation status
:class: important

FDM grid authoring, single-grid execution and multi-grid convolution are implemented with capability-dependent restrictions. Object-level FDM mesh panels are read-only by design.
::::

## Scope and purpose

Use the pages in this branch to configure and validate Cartesian cells, cut-cell boundary
correction, multiple magnets and periodic grids. The detailed common formulation and parameter
table are on the parent **FDM Cartesian grids** page.

## Scientific and numerical model

### Scientific invariants

An FDM grid stores the magnetization on a Cartesian lattice with cell dimensions
$\Delta x$, $\Delta y$ and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-fdm-index
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and the
accuracy/cost of FFT demagnetization. It must therefore resolve the smallest magnetic length scale,
the smallest geometric feature and the desired boundary accuracy. The exchange-length expression

```{math}
:label: eq-meshing-fdm-exchange-length-fdm-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness
is a thickness-averaged discretization; it cannot represent a nonuniform mode across the thickness.

The FDM topology is implicit in `(origin, spacing, shape)` and the active-cell/region arrays. A
valid result therefore requires all of these resources to share one grid fingerprint. An array
with the correct length but a different origin or shape is not compatible.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Basic single-body model | FDM Cartesian grids | Start with the common grid contract |
| Curved/cut geometry | Boundary correction | Control occupancy treatment at the staircase boundary |
| Several magnetic bodies | Multi-magnet grids | Resolve per-magnet and common convolution grids |
| Infinite/repeated lattice | Periodic grids | Configure mesh periodicity and demag images separately |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `default_cell` / `study.cell(dx,dy,dz)` | m | required unless all magnets override it | three positive finite components | Cartesian cell dimensions used by geometry, exchange and demag |
| `per_magnet` | m | `{}` | mapping keyed by canonical magnet name | object-specific cell dimensions; must be compatible with the chosen demag strategy |
| `demag.strategy` | 1 | `auto` | `auto`, `single_grid`, `multilayer_convolution` | selects one shared FFT lattice or the multi-grid convolution plan |
| `demag.mode` | 1 | `auto` | `auto`, `two_d_stack`, `three_d` | constrains multi-grid convolution geometry |
| `demag.common_cells` | cells | unset | three positive integers; exclusive with `common_cells_xy` | forces the common 3-D convolution lattice shape |
| `demag.common_cells_xy` | cells | unset | two positive integers; exclusive with `common_cells` | forces the common in-plane lattice for a 2-D stack |
| `demag.common_cell_size` | m | unset | three positive finite components | overrides the common convolution cell size when supported |
| `demag.explain` | 1 | `True` | Boolean | requests a resolved plan/provenance explanation |
| `boundary_correction` | 1 | `none` | `none`, `volume`, `full` | selects cut-cell occupancy correction at geometry boundaries |
| `boundary_phi_floor` | 1 | `backend default` | strictly between 0 and 1 | lower occupancy clamp used by corrected boundary operators |
| `boundary_delta_min` | m | `0` | non-negative | minimum distance/width regularization in boundary correction |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_grid_reference")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(160 * nm, 320 * nm, 10 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
# 32 x 64 x 2 cells in the universe; all dimensions are SI metres.
study.cell(5 * nm, 5 * nm, 5 * nm)

film = study.geometry(
    fm.Box(size=(100 * nm, 300 * nm, 10 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)

study.exchange()
study.demag()
study.b_ext(0.0, 0.0, 1.0e-3)
study.solver(fix_dt=1.0e-13, g=2.115)
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    dt=1.0e-13,
    tolA=1.0e-4,
    max_steps=5_000,
).tableautosave(
    every_steps=25,
    quantities=["step", "t", "mx", "my", "mz", "E_ex", "E_demag", "E_total"],
)
```

## Control Room workflow

1. Select **Study** in **Explorer** and set **Backend = FDM** in the Study Inspector.
2. Enter **FDM default cell** as `dx, dy, dz` in metres, or provide **FDM per-magnet grids** as a JSON
   object keyed by canonical magnet name.
3. Select **FDM demag**: `auto`, `single_grid`, or `multilayer_convolution`. For more than one magnet,
   the current authoring model rejects `single_grid` and requires `multilayer_convolution`.
4. Select **FDM demag mode** (`auto`, `two_d_stack`, `three_d`). Optional **Common convolution cells**
   (`Nx, Ny, Nz`) and **Common convolution cells XY** (`Nx, Ny`) are mutually exclusive.
5. Keep **Explain FDM demag plan** enabled while developing a model. Review the resolved strategy,
   common lattice and any incompatibility before execution.
6. Select an object's mesh route to inspect the realized structured-grid origin, spacing, shape,
   active/inactive support cells, region metadata and grid fingerprint. This object view is read-only;
   FDM grid authoring is owned by the Study execution plan.

## Verification, quality and provenance

After every build, inspect the **realized** resource rather than assuming that the authored request
was applied. The production check is:

- geometry and mesh revisions match the current model;
- requested and realized discretization/topology/order are recorded;
- node, element and boundary-facet counts are nonzero for every required region;
- region and boundary markers cover the complete topology;
- inverted and degenerate element counts are zero;
- interface diagnostics report no orphan, coincident, nonmanifold or unmatched facets;
- local size distributions are consistent with the intended edge/interface/core grading;
- any fallback or degradation has an explicit reason and an actual method;
- a mesh-refinement sequence demonstrates convergence of the scientific observable.

`MeshQualityReport` exposes signed inverse condition number (SICN), gamma/radius quality, volume
statistics and optional per-element arrays. The source constants `gamma_min=0.08` and
`SICN p05=0.1` are implementation gates for named report paths; they are not universal physical
acceptance thresholds for every element family or study.

## Mesh-convergence protocol

A production result should include at least three discretizations. Refine only the parameter under
study while holding geometry, material parameters, solver tolerances, initial state and output
sampling fixed. Let $Q_h$ denote the observable for characteristic size $h$. Report

```{math}
:label: eq-meshing-relative-change-fdm-index
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

A structured grid descriptor is insufficient without the canonical binary support mask. Legacy or ambiguous masks must be reported as such; the UI must not invent active/inactive classification.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python FDM schemas | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `FDM, FDMGrid, FDMDemag` |
| FDM object inspector model | [`apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts) | `resolveFdmObjectMeshInspectorModel` |
| Study authoring model | [`apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts) | `StudyFdmDraft` |
| FDM runner | [`crates/fullmag-runner/src/fdm/mod.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-runner/src/fdm/mod.rs) | `FDM execution` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

- A. J. Newell, W. Williams and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *J. Geophys. Res.* **98** (1993), 9551–9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *J. Appl. Phys.* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).

## Documentation tree

```{toctree}
:maxdepth: 2

../fdm-grids
boundary-correction
multi-magnet-grids
periodic-grids
```
