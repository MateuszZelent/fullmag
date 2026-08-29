---
title: "FDM periodic grids"
description: "Periodic Cartesian topology and finite-image demagnetization for FDM unit-cell models."
summary: "Periodic FDM requires a grid that tiles exactly along selected axes and an independently declared demagnetization boundary policy; periodic indexing alone does not create a periodic Green function."
status: partial
doc_kind: reference
audience: user
owner: fullmag-public-docs
last_updated: 2026-08-24
reviewed_revision: 5db00ccf0113b9756fec2d46feb36ade762b12c2
source_of_truth: "FdmPbc Python contract, FDM periodic kernel construction, runner capability matrix and periodic provenance"
---

(public-docs-numerical-methods-meshing-fdm-periodic-grids)=
# FDM periodic grids

**Last changes: 12:31 24.08.2026**

Periodic FDM requires a grid that tiles exactly along selected axes and an independently declared demagnetization boundary policy; periodic indexing alone does not create a periodic Green function.

::::{admonition} Implementation status
:class: important

Periodic axes and finite translated-image demagnetization are source-backed. `truncated_images` is a controlled approximation whose image counts require convergence; it is not an exact infinite Ewald sum.
::::

## Scope and purpose

Use periodic grids for representative unit cells, nanowire/nanofilm repetition and periodic
texture calculations. This page concerns the FDM lattice. FEM periodic node pairing and periodic
airbox closure are separate contracts.

## Scientific and numerical model

### Scientific invariants

An FDM grid stores the magnetization on a Cartesian lattice with cell dimensions
$\Delta x$, $\Delta y$ and $\Delta z$. Cell centers are

```{math}
:label: eq-meshing-fdm-cell-centres-fdm-periodic-grids
\mathbf r_{ijk}=\mathbf r_0+
\left(i+\tfrac12,j+\tfrac12,k+\tfrac12\right)
\odot(\Delta x,\Delta y,\Delta z).
```

The cell size simultaneously controls geometry voxelization, finite-difference exchange and the
accuracy/cost of FFT demagnetization. It must therefore resolve the smallest magnetic length scale,
the smallest geometric feature and the desired boundary accuracy. The exchange-length expression

```{math}
:label: eq-meshing-fdm-exchange-length-fdm-periodic-grids
\ell_{\mathrm{ex}}=\sqrt{\frac{2A}{\mu_0M_s^2}}
```

is a useful initial guide, but final values require a grid-refinement study. A one-cell film thickness
is a thickness-averaged discretization; it cannot represent a nonuniform mode across the thickness.

A periodic axis maps index $i=N_x$ to $i=0$ for supported local stencils. For demagnetization,
Fullmag's finite-image route replaces the open kernel with

```{math}
:label: eq-fdm-periodic-image-sum-fdm-periodic-grids
\mathbf H_d(\mathbf r_i)=
\sum_{\boldsymbol\ell\in\mathcal I}
\sum_j \mathbf N(
\mathbf r_i-\mathbf r_j-oldsymbol\ell\odot\mathbf L)
\mathbf M_j,
```

where $\mathbf L$ is the unit-cell size and
$\mathcal I=[-n_x,n_x]\times[-n_y,n_y]\times[-n_z,n_z]$. Increasing image counts changes the
discrete operator. Convergence in `images` must be demonstrated separately from convergence in
cell size.

The unit-cell length along a periodic axis must equal an integer number of cells and all periodic
fields/regions must agree at the seam according to the interaction's boundary semantics.

## Selection guide

| Use case | Recommended choice | Reason |
| --- | --- | --- |
| Periodic local interactions, open demag | periodic axes + `demag="open"` | Useful only when open magnetostatics is physically intended |
| Finite periodic demag approximation | `demag="truncated_images"` | Adds translated Newell-kernel images |
| Exact/infinite periodic Green function required | not established by this route | Use a separately qualified periodic solver; do not over-interpret finite images |

## Parameters

| Python / IR key | Unit | Default | Validation | Numerical effect |
| --- | --- | --- | --- | --- |
| `x`, `y`, `z` / `FdmPbc.axes` | 1 | all false | three Boolean axis flags | periodic topology for local FDM operators |
| `demag` | 1 | `open` | `open`, `truncated_images`, `periodic_airbox_k0` | selects demag boundary policy; `periodic_airbox_k0` is FEM-only |
| `images` / `image_counts` | 1 | unset | three non-negative integers; only with `truncated_images` | finite image range in each direction |
| unit-cell size | m | universe size | integer multiple of spacing on periodic axes | translation period of the lattice and demag images |
| cell origin | m | resolved | consistent across periodic seam | fixes phase/translation alignment of geometry and fields |

## Python API

**Complete Python example**

```python
import fullmag as fm

nm = 1.0e-9
study = fm.study("periodic_fdm_grid")
study.engine("fdm")
study.device("cpu", precision="double")
study.mode("strict")
study.universe(
    mode="manual",
    size=(100 * nm, 40 * nm, 5 * nm),
    center=(0.0, 0.0, 0.0),
    padding=(0.0, 0.0, 0.0),
)
study.cell(2 * nm, 2 * nm, 5 * nm)
study.pbc(
    x=True,
    y=True,
    z=False,
    demag="truncated_images",
    images=(4, 4, 0),
)

film = study.geometry(
    fm.Box(size=(100 * nm, 40 * nm, 5 * nm), name="unit_cell"),
    name="unit_cell",
)
film.Ms = 800.0e3
film.Aex = 13.0e-12
film.alpha = 0.02
film.m = fm.texture.uniform(1.0, 0.0, 0.0)

study.exchange()
study.demag()
study.solver(fix_dt=1.0e-13, g=2.115)
study.stages.add_relax(
    stage_id="periodic_equilibrium",
    algorithm="llg_overdamped",
    dt=1.0e-13,
    tolA=1.0e-4,
    max_steps=10_000,
)
```

## Control Room workflow

1. Set **Backend = FDM** and author the default/per-magnet cell dimensions.
2. In the Study periodic-boundary section, enable the periodic axes and select the demag policy.
3. For **truncated images**, enter non-negative image counts for all three axes. Use zero on open
   axes unless a deliberately asymmetric finite environment is being studied.
4. Apply the Study and inspect the resolved unit-cell size, cell counts, axis order, image policy,
   precision and kernel fingerprint.
5. Repeat the result with larger image counts and finer cells. Store both convergence sweeps.

## Verification

Verify exact lattice tiling, seam continuity of local fields, axis-order preservation and kernel
regeneration after every spacing/image edit. Sweep image counts until field and energy changes
meet the study tolerance. Compare CPU and GPU only at identical precision, cell topology, image
counts and normalization.

## Mesh-convergence protocol

A production result should include at least three discretizations. Refine only the parameter under
study while holding geometry, material parameters, solver tolerances, initial state and output
sampling fixed. Let $Q_h$ denote the observable for characteristic size $h$. Report

```{math}
:label: eq-meshing-relative-change-fdm-periodic-grids
\varepsilon_h=\frac{|Q_h-Q_{h/\rho}|}{\max(|Q_{h/\rho}|,Q_{\mathrm{scale}})},
\qquad \rho>1,
```

with a documented scale for observables that can cross zero. For dynamics, compare resonance
frequency, linewidth and mode profile; for relaxation, compare total energy and texture; for demag,
compare field/energy and verify that moving the outer boundary does not change the result beyond the
chosen tolerance.

## Diagnostics and failure semantics

- Image counts without `truncated_images` are invalid.
- `periodic_airbox_k0` on an FDM lane is a planner error and must not fall back to open demag.
- A noninteger cell count over a periodic length is a topology error.
- Periodic geometry touching one seam but not its paired seam creates a discontinuous support.
- Finite energy does not prove image convergence; report the image-count sweep.

## Where this is implemented

| Responsibility | Repository source | Stable owner / symbol |
| --- | --- | --- |
| Python periodic policy | [`packages/fullmag-py/src/fullmag/model/problem.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/model/problem.py) | `FdmPbc` |
| Stage-first facade | [`packages/fullmag-py/src/fullmag/world.py`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/packages/fullmag-py/src/fullmag/world.py) | `StudyBuilder.pbc` |
| CPU periodic spectra | [`crates/fullmag-engine/src/fdm/cpu/fft.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-engine/src/fdm/cpu/fft.rs) | `compute_periodic_newell_kernel_spectra` |
| FDM shared execution types | [`crates/fullmag-engine/src/fdm/shared/types.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-engine/src/fdm/shared/types.rs) | `periodic policy types` |
| Runner periodic lowering | [`crates/fullmag-runner/src/fdm/mod.rs`](https://github.com/MateuszZelent/fullmag/blob/5db00ccf0113b9756fec2d46feb36ade762b12c2/crates/fullmag-runner/src/fdm/mod.rs) | `FDM PBC execution plan` |

Implementation map reviewed against commit `5db00ccf0113b9756fec2d46feb36ade762b12c2` on 2026-08-24.

## Related documentation

- [Periodic demagnetization](../../demag-solvers/periodic-demag.md)
- [FDM Cartesian grids](../fdm-grids.md)

## References

- C. Geuzaine and J.-F. Remacle, “Gmsh: a three-dimensional finite element mesh generator with built-in pre- and post-processing facilities,” *International Journal for Numerical Methods in Engineering* **79** (2009), 1309–1331, [doi:10.1002/nme.2579](https://doi.org/10.1002/nme.2579).
- C. Abert, “Micromagnetics and spintronics: models and numerical methods,” *European Physical Journal B* **92**, 120 (2019), [doi:10.1140/epjb/e2019-90599-6](https://doi.org/10.1140/epjb/e2019-90599-6).
- Gmsh reference manual, mesh algorithms, size fields, extrusion and physical groups: [gmsh.info/doc/texinfo](https://gmsh.info/doc/texinfo/).

- A. J. Newell, W. Williams and D. J. Dunlop, “A generalization of the demagnetizing tensor for nonuniform magnetization,” *J. Geophys. Res.* **98** (1993), 9551–9555, [doi:10.1029/93JB00694](https://doi.org/10.1029/93JB00694).
- A. Aharoni, “Demagnetizing factors for rectangular ferromagnetic prisms,” *J. Appl. Phys.* **83** (1998), 3432–3434, [doi:10.1063/1.367113](https://doi.org/10.1063/1.367113).
## Source-code index

- Python contract source: `packages/fullmag-py/src/fullmag/model/discretization.py` and `packages/fullmag-py/src/fullmag/world.py`, where applicable. Runtime realization is owned by the relevant `backends/fdm` or `backends/fem` implementation; the page must not claim a symbol not named in its implementation mapping.

