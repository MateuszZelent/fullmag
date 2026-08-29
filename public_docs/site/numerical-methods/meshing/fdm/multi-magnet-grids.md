---
title: "FDM multi-magnet grids"
description: "Per-magnet structured grids and common convolution planning for several magnetic bodies."
summary: "Fullmag can discretize several magnetic bodies on per-magnet Cartesian supports while coupling them magnetostatically through a common multilayer convolution plan."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FDM per-magnet grid schema, multilayer reference planner, runner validation and Control Room Study authoring"
---

(public-docs-numerical-methods-meshing-fdm-multi-magnet-grids)=
# FDM multi-magnet grids

**Last changes: 12:31 24.08.2026**

Fullmag can discretize several magnetic bodies on per-magnet Cartesian supports while coupling them magnetostatically through a common multilayer convolution plan.

::::{admonition} Implementation status
:class: important

The production authoring rule is explicit: models with more than one magnetic body cannot select `single_grid`; use `multilayer_convolution`. Exchange remains body-local unless an explicit inter-body coupling is authored.
::::

## Scope and purpose

Use this route for multilayers, separated nanomagnets, free/reference stacks and arrays whose
bodies require distinct support masks or vertical offsets. The meshing problem has two levels:
each magnet owns a structured support, while demagnetization requires a common convolution
geometry that can transfer fields between those supports.

## Scientific and numerical model

### Scientific invariants

An FDM grid stores the magnetization on a Cartesian lattice with cell dimensions
$\Delta x$, $\Delta y$ and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-fdm-multi-magnet-grids
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and the
accuracy/cost of FFT demagnetization. It must therefore resolve the smallest magnetic length scale,
the smallest geometric feature and the desired boundary accuracy. The exchange-length expression

```{math}
:label: eq-meshing-fdm-exchange-length-fdm-multi-magnet-grids
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness
is a thickness-averaged discretization; it cannot represent a nonuniform mode across the thickness.

For magnets $a$ and $b$, the demagnetizing field on grid $a$ contains self and cross terms,

```{math}
:label: eq-fdm-multimagnet-demag-fdm-multi-magnet-grids
\mathbf H_a = \sum_b \mathcal N_{ab}\ast \mathbf M_b.
```

The cross-kernel $\mathcal N_{ab}$ depends on cell dimensions, relative origins and stack
separation. These geometric quantities must therefore be part of the kernel fingerprint. In a
`two_d_stack` plan the grids share a compatible in-plane convolution lattice while retaining
layer-specific vertical positions. `three_d` removes that stack assumption but can require more
memory.

By default, exchange stencils do not bridge disjoint magnet objects. Magnetostatic coupling is
long-ranged and remains present through the cross kernels.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Aligned thin-film stack | `multilayer_convolution`, `two_d_stack` | Shared in-plane lattice with explicit layer offsets |
| General 3-D arrangement | `multilayer_convolution`, `three_d` | General common 3-D convolution plan |
| Every body uses same cell size | `default_cell` plus optional overrides | Simplifies common-lattice construction |
| One body requires finer cells | `per_magnet` plus convergence test | Permitted only when the resolved convolution transfer is compatible |

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
study = fm.study("fdm_two_magnet_stack")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.fdm(
    default_cell=(2 * nm, 2 * nm, 1 * nm),
    demag=fm.FDMDemag(
        strategy="multilayer_convolution",
        mode="two_d_stack",
        explain=True,
    ),
)

free = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 2 * nm), name="free_geom"), name="free"
)
reference = study.geometry(
    fm.Box(size=(80 * nm, 40 * nm, 2 * nm), name="reference_geom").translate(
        (0.0, 0.0, 5 * nm)
    ),
    name="reference",
)
for magnet, direction in ((free, (1.0, 0.0, 0.0)), (reference, (0.0, 1.0, 0.0))):
    magnet.Ms = 800.0e3
    magnet.Aex = 13.0e-12
    magnet.alpha = 0.05
    magnet.m = fm.texture.uniform(*direction)

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

## Verification

Inspect every per-magnet origin, spacing, shape, active mask and region ID, followed by the common
convolution grid and cross-kernel provenance. Validate a two-body case against a single finely
discretized reference or an analytic far-field limit. Translate one body by an integer cell and
confirm that the reported relative origin changes consistently. For stacks, refine both in-plane
cells and vertical layer resolution.

## Mesh-convergence protocol

A production result should include at least three discretizations. Refine only the parameter under
study while holding geometry, material parameters, solver tolerances, initial state and output
sampling fixed. Let $Q_h$ denote the observable for characteristic size $h$. Report

```{math}
:label: eq-meshing-relative-change-fdm-multi-magnet-grids
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- `single_grid` with more than one magnet is rejected by the current authoring model.
- Unknown names in `per_magnet` are errors; keys must be canonical magnet names.
- Incompatible in-plane spacing/origin under `two_d_stack` must fail or produce an explicit
  resolved resampling policy—never an implicit array reshape.
- `common_cells` and `common_cells_xy` are mutually exclusive.
- A missing cross-kernel or mismatched grid fingerprint is a blocking magnetostatic error.
- Body-local exchange is intentional; do not interpret the absence of inter-body exchange as a
  meshing defect.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python multi-grid contract | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/discretization.py) | `FDM.per_magnet, FDMDemag` |
| Reference multilayer construction | [`crates/fullmag-runner/src/fdm/cpu/multilayer_reference/construction.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-runner/src/fdm/cpu/multilayer_reference/construction.rs) | `multilayer plan construction` |
| CPU multilayer reference | [`crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-runner/src/fdm/cpu/multilayer_reference.rs) | `multilayer execution` |
| CUDA multilayer construction | [`crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-runner/src/fdm/gpu/cuda/native/construction.rs) | `device plan construction` |
| Control Room validation | [`apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts) | `FDM_SINGLE_GRID_MULTI_BODY_REASON` |
| Canonical example | [`examples/fdm_multibody_two_layer_stack.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/examples/fdm_multibody_two_layer_stack.py) | `two-body stack` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [FDM Cartesian grids](../fdm-grids.md)
- [Periodic grids](periodic-grids.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

- A. J. Newell, W. Williams and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *J. Geophys. Res.* **98** (1993), 9551–9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *J. Appl. Phys.* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

