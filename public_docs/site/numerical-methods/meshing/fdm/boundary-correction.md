---
title: "FDM boundary correction"
description: "Cut-cell occupancy and boundary-operator correction for curved or oblique magnetic boundaries on Cartesian grids."
summary: "Boundary correction reduces staircase error by carrying sub-cell geometry information into FDM exchange and demagnetization operators; it does not remove the need for cell-size convergence."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FDM boundary-correction policy, occupancy assets, CPU/GPU operator implementations and Study authoring model"
---

(public-docs-numerical-methods-meshing-fdm-boundary-correction)=
# FDM boundary correction

**Last changes: 12:31 24.08.2026**

Boundary correction reduces staircase error by carrying sub-cell geometry information into FDM exchange and demagnetization operators; it does not remove the need for cell-size convergence.

::::{admonition} Implementation status
:class: important

The public policy exposes `none`, `volume` and `full`. `volume` applies volume-fraction weighting; `full` requests the extended boundary treatment and sparse demag correction. Device/operator qualification remains capability-dependent.
::::

## Scope and purpose

Use boundary correction when a curved, oblique or perforated magnetic boundary is poorly
represented by a binary Cartesian mask. Typical examples are disks, ellipses, antidots, holes,
notches and slanted edges. The correction is local to the FDM representation and is not an FEM
surface remeshing method.

## Scientific and numerical model

### Scientific invariants

An FDM grid stores the magnetization on a Cartesian lattice with cell dimensions
$\Delta x$, $\Delta y$ and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-fdm-boundary-correction
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and the
accuracy/cost of FFT demagnetization. It must therefore resolve the smallest magnetic length scale,
the smallest geometric feature and the desired boundary accuracy. The exchange-length expression

```{math}
:label: eq-meshing-fdm-exchange-length-fdm-boundary-correction
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness
is a thickness-averaged discretization; it cannot represent a nonuniform mode across the thickness.

Let $\phi_i\in[0,1]$ be the magnetic volume fraction of cell $i$. A binary mask uses only
$\phi_i\in\{0,1\}$. The volume-corrected route preserves fractional occupancy in material
weighting and field packing. Schematically,

```{math}
:label: eq-fdm-boundary-volume-weighting-fdm-boundary-correction
E_h\approx\sum_i \phi_i V_{\mathrm{cell}}\,w_i,
```

where $w_i$ is the discrete energy density. The full route additionally modifies boundary
exchange stencils and applies the source-visible sparse demagnetization correction. Because very
small occupancies can amplify coefficients, `boundary_phi_floor` regularizes the minimum active
fraction used by the corrected operators.

Occupancy correction changes the discrete operator and energy quadrature; it is not a cosmetic
post-processing mask. Results from different correction modes must therefore be compared as
different discretizations.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Axis-aligned box with well-resolved dimensions | `none` | Binary cells are usually sufficient and cheapest |
| Curved/oblique boundary; robust first correction | `volume` | Carries sub-cell volume fraction into supported operators |
| Boundary-sensitive benchmark with qualified lane | `full` | Requests corrected exchange boundary stencil and sparse demag correction |
| Feature smaller than one cell | refine geometry first | Correction cannot recover unresolved topology reliably |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `boundary_correction` | 1 | `none` | `none`, `volume`, `full` | selects the boundary-discretization family |
| `boundary_phi_floor` / `phi_floor` | 1 | backend default | strictly between 0 and 1 | regularizes very small nonzero occupancy fractions |
| `boundary_delta_min` / `delta_min` | m | `0` | non-negative finite | minimum geometric distance/width used by corrected boundary coefficients |
| cell size | m | required | positive vector | controls the sampling from which occupancy is computed |
| geometry transform | m/rad | identity | finite transform | must be included in the occupancy fingerprint and regenerated after edits |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("fdm_boundary_correction")
study.engine("fdm")
study.device("cpu", precision="double")
study.cell(5 * nm, 5 * nm, 10 * nm)

# Select: "none", "volume", or "full".
study.boundary_correction("volume")

film_with_hole = fm.Box(600 * nm, 600 * nm, 10 * nm) - fm.Cylinder(
    radius=75 * nm,
    height=10 * nm,
)
magnet = study.geometry(film_with_hole, name="permalloy_with_hole")
magnet.Ms = 800.0e3
magnet.Aex = 13.0e-12
magnet.alpha = 0.5
magnet.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.stages.add_relax(stage_id="equilibrium", dt=1.0e-13, max_steps=10_000)
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

In the FDM section of the Study Inspector, set **Boundary correction** to **none**, **volume**, or
**full**. Advanced scalar controls are stored as `boundary_phi_floor` and
`boundary_delta_min`. After applying the study, inspect the canonical support/occupancy resources;
do not infer fractional occupancy from the rendered surface alone.

## Verification and convergence

Run a matrix over cell size and correction mode. Compare volume, exchange energy, demag energy,
equilibrium texture and the target observable with an analytic result or a well-converged FEM/FDM
reference. For a curved body, also translate the geometry by fractions of one cell; a corrected
result should reduce, not necessarily eliminate, phase sensitivity. Record the occupancy checksum
and corrected-operator capability in provenance.

## Mesh-convergence protocol

A production result should include at least three discretizations. Refine only the parameter under
study while holding geometry, material parameters, solver tolerances, initial state and output
sampling fixed. Let $Q_h$ denote the observable for characteristic size $h$. Report

```{math}
:label: eq-meshing-relative-change-fdm-boundary-correction
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Reject `phi_floor <= 0` or `phi_floor >= 1`; reject negative `delta_min`.
- Regenerate occupancy whenever geometry, transform, cell size or grid origin changes.
- A boundary mode can be authored yet unavailable for the active CPU/GPU operator set; the
  planner must report this before runtime and must not silently execute `none`.
- A large discrepancy between geometric volume and $\sum_i\phi_iV_{cell}$ indicates an occupancy
  or coordinate-frame error.
- `full` is not automatically more accurate on a coarse grid; compare against refinement.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python FDM schema | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `FDM boundary_correction fields` |
| Flat authoring facade | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/world.py) | `boundary_correction` |
| Native FDM context contract | [`backends/fdm/include/context.hpp`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/backends/fdm/include/context.hpp) | `boundary-correction state` |
| FDM C API lowering | [`backends/fdm/api/c_api.cpp`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/backends/fdm/api/c_api.cpp) | `boundary-correction configuration` |
| CUDA context realization | [`backends/fdm/gpu/cuda/runtime/context.cu`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/backends/fdm/gpu/cuda/runtime/context.cu) | `boundary-correction runtime state` |
| Control Room FDM authoring | [`apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts) | `boundaryCorrection, boundaryPhiFloor, boundaryDeltaMin` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [FDM Cartesian grids](../fdm-grids.html)
- [Demagnetization](../../../physics/interactions/demagnetization/index.html)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

- A. J. Newell, W. Williams and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *J. Geophys. Res.* **98** (1993), 9551–9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *J. Appl. Phys.* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
