---
title: "Finite-difference meshing"
description: "Entry point for Fullmag FDM Cartesian-grid documentation."
summary: "Fullmag FDM meshing is owned by the Study execution plan and produces a structured lattice plus canonical magnetic-support masks, region metadata, and grid fingerprints."
status: implemented
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-11-26
reviewed_revision: 752450f8d259ab97c76c36fe666d5474b02abe9a
source_of_truth: "FDM execution plan, structured grid descriptors, mask resources, interactive FDM grid sizing, and demag capability resolution"
---

(public-docs-numerical-methods-meshing-fdm-index)=
# Finite-difference meshing

Fullmag FDM meshing is owned by the Study execution plan and produces a structured Cartesian lattice together with canonical magnetic-support masks, region metadata, and a grid fingerprint.

::::{admonition} Implementation status
:class: important

Single-grid FDM (with D2Z/R2C half-spectrum cuFFT, exact workspace preflight, and face-coefficient exchange supporting cellwise $M_s$ and $\alpha$), centered multi-magnet `multilayer_convolution` (including XY-periodic FP64 CUDA PG-BB), and interactive Control Room FDM grid sizing (`MeshRootSpec.tsx`, `FdmMeshWorkflowCard.tsx`) are implemented.
::::

## Scope and purpose

Use the pages in this branch to configure and validate Cartesian cells, cut-cell boundary correction, multi-magnet grids, and periodic grids. The detailed common formulation, `ProblemIR` contract, and exhaustive parameter table live on [FDM Cartesian grids](../fdm-grids.md); CUDA acceleration details live on {ref}`numerical-methods-performance-fdm-core`.

## Scientific and numerical model

### Scientific invariants

An FDM grid stores magnetization on a Cartesian lattice with cell dimensions $\Delta x$, $\Delta y$, and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-fdm-index
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and DMI stencils, and the accuracy and memory footprint of FFT demagnetization. It must resolve the smallest magnetic length scale, the smallest geometric feature, and the required boundary accuracy. The magnetostatic exchange length

```{math}
:label: eq-meshing-fdm-exchange-length-fdm-index
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0 M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness is a thickness-averaged discretization and cannot resolve nonuniform through-thickness modes.

FDM topology is implicit in `(origin, spacing, shape)` and the active-cell/region arrays. A valid realization requires all resources to share one grid fingerprint; an array with matching length but a different origin or shape is incompatible.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Basic single-body model | [FDM Cartesian grids](../fdm-grids.md) | Canonical grid authoring, masks, and `ProblemIR` contract |
| Curved/cut geometry | [Boundary correction](boundary-correction.md) | Cut-cell occupancy treatment at curved boundaries |
| Several magnetic bodies | [Multi-magnet grids](multi-magnet-grids.md) | Per-magnet native grids and common convolution planning |
| Infinite/repeated lattice | [Periodic grids](periodic-grids.md) | Periodic topology, truncated-image demag, and workspace preflight |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `study.objects.mesh.defaults(cell_size=...)` | $\mathrm{m}$ | required unless every body sets `body.mesh(cell_size=...)` | three finite positive components | canonical default Cartesian cell dimensions for geometry, exchange, and demag |
| `body.mesh(cell_size=...)` / `per_magnet` | $\mathrm{m}$ | `{}` | three finite positive components per body | object-specific native cell dimensions |
| `study.universe.mesh(cell_size=...)` / `demag.common_cell_size` | $\mathrm{m}$ | unset | three finite positive components; exclusive with explicit common counts | common convolution lattice spacing for multi-magnet models |
| `demag.strategy` | $1$ | `auto` | `auto`, `single_grid`, `multilayer_convolution` | selects one shared FFT lattice or the multi-grid convolution plan |
| `demag.mode` | $1$ | `auto` | `auto`, `two_d_stack`, `three_d` | constrains multi-grid convolution geometry |
| `demag.common_cells` | $1$ | unset | three positive integers; exclusive with `common_cells_xy` | forces the common 3-D convolution lattice shape |
| `demag.common_cells_xy` | $1$ | unset | two positive integers; exclusive with `common_cells` | forces the common in-plane lattice for a 2-D stack |
| `demag.fft_backend` | $1$ | `auto` | `auto`, `rustfft`, `fftw`, `mkl`, `cufft` | requested FFT backend (`rustfft` CPU, `cufft` CUDA) |
| `boundary_correction` | $1$ | `none` | `none`, `volume`, `full` | selects cut-cell occupancy correction at geometry boundaries |
| `boundary_phi_floor` | $1$ | backend default | strictly in `(0, 1)` | lower occupancy clamp used by corrected boundary operators |
| `boundary_delta_min` | $\mathrm{m}$ | `0` | non-negative | minimum distance regularization in boundary correction |

## Python API

**Complete stage-first Python example**

```python
# %% Study, universe, and canonical FDM cell sizing
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
study.objects.mesh.defaults(cell_size=(5 * nm, 5 * nm, 5 * nm))

# %% Magnetic film, material parameters, and initial state
film = study.geometry(
    fm.Box(size=(100 * nm, 300 * nm, 10 * nm), name="film"),
    name="film",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 1.0e-4, 0.0)

# %% Interactions, solver defaults, and relaxation stage
study.exchange()
study.demag()
study.b_ext(0.0, 0.0, 1.0e-3)
study.solver(dt=1.0e-13)
study.stages.add_relax(
    stage_id="equilibrium",
    algorithm="llg_overdamped",
    dt=1.0e-13,
    tolA=1.0e-4,
    max_steps=5_000,
).tableautosave(
    every_steps=25,
    quantities=["step", "t", "mx", "my", "mz", "e_ex", "e_demag", "e_total"],
)
```

## Control Room workflow

1. Select **Study** in **Explorer** and set **Backend = FDM** in the Study Inspector.
2. Select the **Mesh** root (`MeshRootSpec.tsx` / `FdmMeshWorkflowCard.tsx`) for interactive FDM grid sizing:
   - switch between **Cell size** ($\Delta x, \Delta y, \Delta z$) and **Cell count** ($N_x, N_y, N_z$) authoring;
   - select **Single 3D** or **Multilayer Z-slices** for multi-body studies;
   - review the live exchange-length ($\ell_{\mathrm{ex}}$) resolution guard and one-click quick-fix;
   - snap padded FFT dimensions to 7-smooth sizes for optimal cuFFT/RustFFT throughput;
   - click **Save & Build Grid** to materialize the structured lattice and canonical support mask.
3. For advanced demagnetization overrides (`strategy`, `mode`, `common_cells`, `common_cells_xy`, `explain`), review the Study Inspector FDM controls (`StudyGlobalAuthoringModel.ts`).
4. Select an individual magnetic body's **Mesh** node to inspect its grid-scoped origin, spacing, shape, active/inactive support mask, region IDs, and grid fingerprint (`fdmMeshInspectorModel.ts`).

## Verification, quality and provenance

After building or planning an FDM grid, verify the realized structured-grid resources:

- `(origin, spacing, shape)` and the grid fingerprint match the current geometry and authoring revision;
- every magnetic body has nonzero active support cells in the canonical binary mask (or fractional occupancy $\phi_{ijk}$ when boundary correction is active) and unambiguous region IDs;
- cell spacing resolves $\ell_{\mathrm{ex}}$, DMI pitch, and the smallest active geometric feature (including enough $N_z$ cells whenever through-thickness variation is physically relevant);
- FFT demagnetization padding, periodic image counts, and exact cuFFT/CPU workspace preflight pass within device/host memory budgets with no silent fallback;
- a three-level grid-refinement study verifies convergence of the scientific observable.

## Mesh-convergence protocol

A production result should include at least three grid levels. Refine cell spacing while holding geometry, material parameters, solver tolerances, initial state, and output sampling fixed. Let $Q_h$ denote the observable at characteristic cell size $h$, and report

```{math}
:label: eq-meshing-relative-change-fdm-index
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented normalization floor $Q_{\mathrm{scale}}$ for observables that can cross zero. For dynamics compare resonance frequency, linewidth, and mode profile; for relaxation compare total energy and magnetization texture; for periodic truncated-image demagnetization converge image counts independently from cell size.

## Diagnostics and failure semantics

A structured grid descriptor is incomplete without its canonical binary support mask and grid fingerprint. Legacy or ambiguous masks fail closed rather than inventing active/inactive classifications. Multi-body models requesting `strategy="single_grid"` are rejected in favor of `multilayer_convolution`.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python FDM schemas | [`packages/fullmag-py/src/fullmag/model/discretization.py`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/packages/fullmag-py/src/fullmag/model/discretization.py) | `FDM, FDMGrid, FDMDemag` |
| Interactive FDM grid root inspector | [`apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/inspectors/mesh/MeshRootSpec.tsx#L51) | `MeshRootInspectorSpecPanel` |
| Interactive FDM workflow card | [`apps/control-room/src/modules/inspector/panels/mesh-details/FdmMeshWorkflowCard.tsx`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/mesh-details/FdmMeshWorkflowCard.tsx#L402) | `FdmMeshWorkflowCard` |
| FDM object inspector model | [`apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/fdmMeshInspectorModel.ts#L146) | `resolveFdmObjectMeshInspectorModel` |
| Study authoring model | [`apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/apps/control-room/src/modules/inspector/panels/StudyGlobalAuthoringModel.ts) | `StudyFdmDraft` |
| FDM runner | [`crates/fullmag-runner/src/fdm/mod.rs`](https://github.com/MateuszZelent/fullmag/blob/752450f8d259ab97c76c36fe666d5474b02abe9a/crates/fullmag-runner/src/fdm/mod.rs) | `FDM execution` |

Implementation map reviewed against commit `752450f8d259ab97c76c36fe666d5474b02abe9a` on 2026-11-26.

## Related documentation

- {ref}`numerical-methods-performance-fdm-core`

## References

- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- A. J. Newell, W. Williams and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *Journal of Geophysical Research* **98** (1993), 9551–9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *Journal of Applied Physics* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
- W. F. Brown Jr., *Micromagnetics*, Interscience Publishers, New York (1963).

## Documentation tree

```{toctree}
:maxdepth: 2

../fdm-grids
boundary-correction
multi-magnet-grids
periodic-grids
```
